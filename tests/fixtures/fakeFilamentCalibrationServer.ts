/**
 * `FakeFilamentCalibrationServer` — an in-memory PrintFarmer that implements
 * the five HTTP endpoints the filament-calibration workflow needs, wire-shape-
 * exact against `OlyForge3D/PrintFarmer` **PR #1952** (merged
 * `beeea96a3b8c9c8388c4739b0d21937dff13d66e`, 2026-08-24) and the pre-existing
 * `SlicePrintBridgeController` + `ProfilesController` routes it left in place.
 *
 * Every DTO shape in this file is a transcription of a real server type, with
 * the source file:line cited inline. Fixtures that agree with our own mapping
 * are exactly the failure mode the assignment forbids
 * (`.squad/decisions/inbox/hicks-filament-calibration-acceptance.md`); this
 * server refuses the same inputs the real one refuses, and preserves the same
 * invariants (source profiles are read-only, `IsCalibrationSlice(job)` on a
 * calibration-mode slice remains false so send-to-printer keeps working, an
 * unknown method fails fast with `unsupported_calibration_method`).
 *
 * Verified contract sources:
 *
 * - Slice submission and calibration mode
 *     `src/slicer/Farm.Slicer.Module.Api/Controllers/Slicing/SliceJobController.cs`
 *     (PR #1952 `beeea96a3b8c9c8388c4739b0d21937dff13d66e`): the `Calibration`
 *     block on `SubmitSliceJobRequest`, the `unsupported_calibration_method`
 *     validation error, and the mutual-exclusivity rejection
 *     `calibration_mode_conflicts_with_saga_ids`. Both are `ProblemDetails`
 *     responses with `errorCode` in the extension bag.
 *
 * - Calibration method wire names
 *     `src/slicer/Farm.Slicer.Module/Models/CalibrationMethod.cs`. The
 *     currently-supported set is exactly `flow_rate_pass_1`, `flow_rate_pass_2`,
 *     `temperature_tower`; PA Pattern and PA Line are explicitly out.
 *
 * - DTOs
 *     `src/slicer/Farm.Slicer.Module/Contracts/SliceJobDtos.cs` for the request
 *     and status shapes, `src/slicer/Farm.Slicer.Module/Dtos/CloneProfilesDtos.cs`
 *     for the clone/update-custom-profile shapes.
 *
 * - Send-to-printer
 *     `src/api/Controllers/Requests/SendToPrinterRequest.cs` and
 *     `src/api/Controllers/Responses/SendToPrinterResponse.cs`. The bridge
 *     controller (`SlicePrintBridgeController.cs`) refuses to run when the
 *     job carries any of the three saga IDs — an untagged calibration-mode
 *     slice passes.
 *
 * The server is `fetch`-shaped so it slots into `CalibrationHttpClientOptions.
 * fetch`. It exposes only read-only inspection helpers, so tests can only
 * observe outcomes — assertions on internal call shapes belong in a different
 * kind of test and are precisely what the owner's brief forbids.
 *
 * Deliberately **not** an isomorphism of the desktop's mapping: any writer that
 * makes both sides tolerant of the same drift retains the same bug on both
 * sides. Where the wire is stricter than the desktop, this server is stricter,
 * so a lax desktop cannot pass.
 */

import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Wire types (verbatim shapes; do not narrow to what the desktop uses today)
// ---------------------------------------------------------------------------

/**
 * The wire values of `CalibrationMethod` (`CalibrationMethod.cs`). Anything
 * outside this set is rejected with 422 `unsupported_calibration_method`.
 * PA Pattern / PA Line are deliberately absent (issue #1938).
 */
export const SUPPORTED_CALIBRATION_METHODS = [
  'flow_rate_pass_1',
  'flow_rate_pass_2',
  'temperature_tower',
] as const;
export type SupportedCalibrationMethod =
  (typeof SUPPORTED_CALIBRATION_METHODS)[number];

/** ProfileType wire value (`CloneSingleProfileRequestDto.ProfileType`). */
export type ProfileType = 'machine' | 'filament' | 'process';

/**
 * A record in this fake server's profile store. `rawJson` is the operator-
 * facing content — the calibration workflow patches `filament_flow_ratio` or
 * `nozzle_temperature` here. `contentSha256` is a byte-level digest tests use
 * to prove system profiles are never mutated.
 */
export interface FakeProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly profileType: ProfileType;
  readonly isSystem: boolean;
  /** Deep-cloned before returning; never a shared reference. */
  readonly rawJson: Record<string, unknown>;
  /** SHA-256 of the canonicalised JSON. */
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

/**
 * The verbatim body a slice submission carries. Kept as `Record<string,
 * unknown>` deliberately: the "no saga identifiers" test needs to detect the
 * PRESENCE of a key with a null value, which a narrowly-typed field would
 * silently smooth out.
 */
export interface FakeSubmitSliceRequestRaw {
  readonly rawJson: string;
  readonly parsed: Record<string, unknown>;
}

export interface FakeSliceJob {
  readonly jobId: string;
  readonly userId: string;
  readonly printerId: string | null;
  readonly slicerEngine: string | number;
  readonly slicerProfileJson: string | null;
  readonly calibrationMethod: SupportedCalibrationMethod;
  readonly calibrationParamsJson: string | null;
  /** The three saga fields — absent means the desktop omitted the keys. */
  readonly calibrationProjectIdPresent: boolean;
  readonly calibrationAttemptIdPresent: boolean;
  readonly calibrationOrchestrationIdPresent: boolean;
  readonly idempotencyKey: string | null;
  readonly rawRequest: FakeSubmitSliceRequestRaw;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed';
  failureReason: string | null;
  failureHint: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Number of `GET /api/slice/{jobId}` requests seen so far. */
  pollAttempts: number;
}

export interface FakePrintSubmission {
  readonly jobId: string;
  readonly printerId: string;
  readonly startPrint: boolean;
  readonly submittedAt: string;
  /** The verbatim JSON body. `startPrint` control tests read this. */
  readonly rawRequest: FakeSubmitSliceRequestRaw;
}

// ---------------------------------------------------------------------------
// Canonicalisation and content addressing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON encoding used both for content addressing and for cloning
 * a profile. Any two profiles whose canonicalised JSON encodings differ have
 * different sha256s — that is what the clone-isolation assertion reads.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}
function contentSha256(rawJson: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(rawJson)).digest('hex');
}

// ---------------------------------------------------------------------------
// Problem details helper (`ProblemDetails` with an `errorCode` extension)
// ---------------------------------------------------------------------------

interface ProblemDetailsPayload {
  status: number;
  errorCode: string;
  title: string;
  detail: string;
  supportedMethods?: readonly string[];
}
function problem(init: ProblemDetailsPayload): {
  status: number;
  body: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {
    type: `about:blank#${init.errorCode}`,
    title: init.title,
    status: init.status,
    detail: init.detail,
    // `errorCode` is the extension field the desktop's
    // `CalibrationHttpClient.mapProblemDetails` reads (`calibrationHttp.ts`
    // near the `serverErrorCode` field).
    errorCode: init.errorCode,
  };
  if (init.supportedMethods) {
    body['supportedMethods'] = [...init.supportedMethods];
  }
  return { status: init.status, body };
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface ParsedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly bodyText: string;
  readonly bodyJson: Record<string, unknown> | null;
  readonly headers: Headers;
}

async function parseRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<ParsedRequest> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const bodyText = await request.text();
  let bodyJson: Record<string, unknown> | null = null;
  if (bodyText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed !== null && typeof parsed === 'object') {
        bodyJson = parsed as Record<string, unknown>;
      }
    } catch {
      bodyJson = null;
    }
  }
  return {
    method: request.method.toUpperCase(),
    pathname: url.pathname,
    bodyText,
    bodyJson,
    headers: new Headers(request.headers),
  };
}

// ---------------------------------------------------------------------------
// The server itself
// ---------------------------------------------------------------------------

export interface FakeFilamentCalibrationServerOptions {
  /**
   * When set, the server keeps `Queued` jobs at `Queued` for this many polls
   * before advancing to `Processing` → `Completed`. Zero means the very first
   * poll returns `Completed`. Tests that exercise the terminal-failure path
   * call {@link failNextJob} instead of relying on this.
   */
  readonly pollsBeforeCompletion?: number;
}

/**
 * A malicious-behaviour toggle used by discrimination controls. NONE of these
 * modes are the server's real production behaviour — they exist so a test can
 * demonstrate that its assertions catch the exact drift the ownership brief
 * warned about.
 */
export type DiscriminationMode =
  | 'faithful'
  /**
   * The clone endpoint returns the SOURCE profile id (instead of a fresh
   * custom-profile id). A driver that then PUTs correction values would
   * write onto the system row directly. Used to prove the clone-isolation
   * test catches the exact bug the assignment names.
   */
  | 'clone-returns-source-id'
  /**
   * The PUT/custom endpoint silently forwards the write onto the source
   * profile, byte-for-byte. This is the pathological "same reference"
   * shape a shallow clone would produce.
   */
  | 'update-mutates-source';

export class FakeFilamentCalibrationServer {
  private readonly profiles = new Map<string, FakeProfileRecord>();
  /** Original (untouched) content sha256 of every profile at insert time. */
  private readonly initialContentSha = new Map<string, string>();
  private readonly sliceJobs = new Map<string, FakeSliceJob>();
  private readonly printSubmissionsList: FakePrintSubmission[] = [];
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly pollsBeforeCompletion: number;
  private discriminationMode: DiscriminationMode = 'faithful';
  private cloneReturnsSourceIdOnce = false;
  private failNext = false;
  private failNextReason: {
    failureReason: string;
    failureHint: string;
    errorMessage: string;
  } | null = null;
  private nowFn: () => Date = () => new Date();

  constructor(options: FakeFilamentCalibrationServerOptions = {}) {
    this.pollsBeforeCompletion = options.pollsBeforeCompletion ?? 0;
  }

  // ---- Test-authored setup -----------------------------------------------

  setNow(fn: () => Date): void {
    this.nowFn = fn;
  }

  setDiscriminationMode(mode: DiscriminationMode): void {
    this.discriminationMode = mode;
  }

  /** Fail the next slice submission's job when it is polled. */
  failNextJob(reason: {
    failureReason: string;
    failureHint: string;
    errorMessage: string;
  }): void {
    this.failNext = true;
    this.failNextReason = reason;
  }

  addSystemProfile(
    name: string,
    profileType: ProfileType,
    rawJson: Record<string, unknown>,
  ): FakeProfileRecord {
    const id = randomUUID();
    // Deep-clone so any external caller mutation is invisible here.
    const rawClone = JSON.parse(JSON.stringify(rawJson)) as Record<
      string,
      unknown
    >;
    const record: FakeProfileRecord = {
      id,
      name,
      profileType,
      isSystem: true,
      rawJson: rawClone,
      contentSha256: contentSha256(rawClone),
      createdAt: this.nowFn().toISOString(),
      updatedAt: null,
    };
    this.profiles.set(id, record);
    this.initialContentSha.set(id, record.contentSha256);
    return record;
  }

  // ---- Read-only observation helpers -------------------------------------

  profileById(id: string): FakeProfileRecord | undefined {
    const record = this.profiles.get(id);
    return record === undefined
      ? undefined
      : {
          ...record,
          rawJson: JSON.parse(JSON.stringify(record.rawJson)) as Record<
            string,
            unknown
          >,
        };
  }
  initialShaOf(id: string): string | undefined {
    return this.initialContentSha.get(id);
  }
  allProfiles(): readonly FakeProfileRecord[] {
    return Array.from(this.profiles.values(), (record) => ({
      ...record,
      rawJson: JSON.parse(JSON.stringify(record.rawJson)) as Record<
        string,
        unknown
      >,
    }));
  }
  sliceJobsList(): readonly FakeSliceJob[] {
    return Array.from(this.sliceJobs.values());
  }
  printSubmissions(): readonly FakePrintSubmission[] {
    return [...this.printSubmissionsList];
  }
  idempotencyRegistrations(): number {
    return this.idempotencyIndex.size;
  }

  // ---- fetch() entry point -----------------------------------------------

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = await parseRequest(input, init);
    return this.route(req);
  };

  private route(req: ParsedRequest): Response {
    if (
      req.method === 'POST' &&
      req.pathname === '/api/slicer/profiles/clone'
    ) {
      return this.handleClone(req);
    }
    if (
      req.method === 'PUT' &&
      /^\/api\/slicer\/profiles\/custom\/[^/]+$/.test(req.pathname)
    ) {
      const id = req.pathname.split('/').pop() as string;
      return this.handleUpdateCustom(id, req);
    }
    if (req.method === 'POST' && req.pathname === '/api/slice') {
      return this.handleSubmitSlice(req);
    }
    if (req.method === 'GET' && /^\/api\/slice\/[^/]+$/.test(req.pathname)) {
      const jobId = req.pathname.split('/').pop() as string;
      return this.handleGetSlice(jobId);
    }
    if (
      req.method === 'POST' &&
      /^\/api\/slice\/[^/]+\/send-to-printer$/.test(req.pathname)
    ) {
      const parts = req.pathname.split('/');
      const jobId = parts[parts.length - 2] as string;
      return this.handleSendToPrinter(jobId, req);
    }
    // Any other route: 404. The desktop's HTTP client maps 404 without a
    // ProblemDetails body to `notFound`, which is what a stray call should
    // look like — a test that inadvertently invokes the wrong route sees a
    // clear failure rather than a plausible-looking success.
    return jsonResponse(404, { detail: 'not found' });
  }

  // ---- POST /api/slicer/profiles/clone -----------------------------------

  private handleClone(req: ParsedRequest): Response {
    if (req.bodyJson === null) {
      return jsonResponse(400, { detail: 'Request body is required' });
    }
    const sourceProfileId = req.bodyJson['sourceProfileId'];
    const profileType = req.bodyJson['profileType'];
    const name = req.bodyJson['name'];
    if (
      typeof sourceProfileId !== 'string' ||
      typeof profileType !== 'string'
    ) {
      return jsonResponse(400, {
        detail: 'sourceProfileId and profileType are required',
      });
    }
    const source = this.profiles.get(sourceProfileId);
    if (source === undefined) {
      return jsonResponse(404, { detail: 'source profile not found' });
    }

    // Discrimination: return the source id instead of a fresh id, and do
    // NOT create a new record. A downstream `updateCustomProfile` call
    // would then write onto the source. This is exactly the bug the
    // clone-isolation control has to catch.
    if (
      this.discriminationMode === 'clone-returns-source-id' ||
      this.cloneReturnsSourceIdOnce
    ) {
      this.cloneReturnsSourceIdOnce = false;
      // Match the shape the correct path returns.
      return jsonResponse(
        201,
        {
          id: source.id,
          name:
            typeof name === 'string' && name.length > 0 ? name : source.name,
          profileType: source.profileType,
          isSystem: false,
        },
        { location: `/api/slicer/profiles/${source.id}` },
      );
    }

    // Correct path: create a fresh record with a new UUID, deep-cloned
    // content, and `isSystem=false`. `PrinterModelId` / `CompatiblePrinters`
    // overrides are accepted but not asserted on today — the assignment
    // scopes the acceptance suite to observable calibration outcomes, and
    // adding assertions for fields the calibration workflow does not read
    // would create the cargo-cult shape the brief warned about.
    const newId = randomUUID();
    const rawClone = JSON.parse(JSON.stringify(source.rawJson)) as Record<
      string,
      unknown
    >;
    const record: FakeProfileRecord = {
      id: newId,
      name:
        typeof name === 'string' && name.length > 0
          ? name
          : `${source.name} (Custom)`,
      profileType: source.profileType,
      isSystem: false,
      rawJson: rawClone,
      contentSha256: contentSha256(rawClone),
      createdAt: this.nowFn().toISOString(),
      updatedAt: null,
    };
    this.profiles.set(newId, record);
    this.initialContentSha.set(newId, record.contentSha256);

    return jsonResponse(
      201,
      {
        id: newId,
        name: record.name,
        profileType: record.profileType,
        isSystem: false,
      },
      { location: `/api/slicer/profiles/${newId}` },
    );
  }

  /**
   * Fire the source-id-return bug on the NEXT clone request only. Used by
   * targeted controls that need one bad clone in an otherwise faithful flow.
   */
  primeCloneReturnsSourceIdOnce(): void {
    this.cloneReturnsSourceIdOnce = true;
  }

  // ---- PUT /api/slicer/profiles/custom/{id} ------------------------------

  private handleUpdateCustom(id: string, req: ParsedRequest): Response {
    if (req.bodyJson === null) {
      return jsonResponse(400, { detail: 'Request body is required' });
    }
    const record = this.profiles.get(id);
    if (record === undefined) {
      return jsonResponse(404, { detail: 'custom profile not found' });
    }
    if (
      record.isSystem &&
      this.discriminationMode !== 'update-mutates-source'
    ) {
      // The real server refuses to update a system profile via the custom
      // endpoint — it is a 403 (`Forbid()` in `ProfilesController.
      // UpdateCustomProfileAsync`). A safe desktop never even attempts
      // this call against a system id, but the test suite is worth the
      // extra second of latency to prove the safety property from BOTH
      // sides.
      return jsonResponse(
        problem({
          status: 403,
          errorCode: 'forbidden',
          title: 'Forbidden',
          detail: 'Cannot update a system profile through the custom endpoint.',
        }).status,
        problem({
          status: 403,
          errorCode: 'forbidden',
          title: 'Forbidden',
          detail: 'Cannot update a system profile through the custom endpoint.',
        }).body,
      );
    }

    // Optional fields per `UpdateCustomProfileRequestDto`.
    let updatedRawJson = record.rawJson;
    const rawJsonField = req.bodyJson['rawJson'];
    if (typeof rawJsonField === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawJsonField);
        if (parsed !== null && typeof parsed === 'object') {
          updatedRawJson = parsed as Record<string, unknown>;
        }
      } catch {
        return jsonResponse(400, { detail: 'rawJson is not valid JSON' });
      }
    }
    const nameField = req.bodyJson['name'];
    const updatedName =
      typeof nameField === 'string' && nameField.length > 0
        ? nameField
        : record.name;

    const now = this.nowFn().toISOString();
    const updated: FakeProfileRecord = {
      ...record,
      name: updatedName,
      rawJson: updatedRawJson,
      contentSha256: contentSha256(updatedRawJson),
      updatedAt: now,
    };
    this.profiles.set(id, updated);

    return jsonResponse(200, {
      id: updated.id,
      name: updated.name,
      profileType: updated.profileType,
      isSystem: updated.isSystem,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      description: null,
      rawJson: JSON.stringify(updated.rawJson),
      printerModelId: null,
      compatiblePrinters: null,
    });
  }

  // ---- POST /api/slice ---------------------------------------------------

  private handleSubmitSlice(req: ParsedRequest): Response {
    if (req.bodyJson === null) {
      return jsonResponse(400, { detail: 'Request body is required' });
    }

    const idempotencyKey = req.headers.get('idempotency-key');
    if (idempotencyKey !== null) {
      const existing = this.idempotencyIndex.get(idempotencyKey);
      if (existing !== undefined) {
        const priorJob = this.sliceJobs.get(existing) as FakeSliceJob;
        // Server-side idempotent replay: same job id, same status.
        return jsonResponse(200, {
          jobId: priorJob.jobId,
          status: priorJob.status,
          queuedAt: priorJob.createdAt,
          queuePosition: null,
        });
      }
    }

    const calibration = req.bodyJson['calibration'];
    if (calibration === undefined || calibration === null) {
      // A calibration-mode slice must carry the `calibration` block. An
      // ordinary slice would be routed elsewhere in production; this fake
      // server only exists for calibration mode.
      return jsonResponse(400, {
        detail: 'calibration block is required for this fake server',
      });
    }
    if (typeof calibration !== 'object') {
      return jsonResponse(400, { detail: 'calibration must be an object' });
    }
    const methodRaw = (calibration as Record<string, unknown>)['method'];
    if (typeof methodRaw !== 'string') {
      return jsonResponse(
        problem({
          status: 422,
          errorCode: 'unsupported_calibration_method',
          title: 'Unsupported calibration method',
          detail: 'Calibration.method is required.',
          supportedMethods: SUPPORTED_CALIBRATION_METHODS,
        }).status,
        problem({
          status: 422,
          errorCode: 'unsupported_calibration_method',
          title: 'Unsupported calibration method',
          detail: 'Calibration.method is required.',
          supportedMethods: SUPPORTED_CALIBRATION_METHODS,
        }).body,
      );
    }
    if (
      !SUPPORTED_CALIBRATION_METHODS.includes(
        methodRaw as SupportedCalibrationMethod,
      )
    ) {
      return jsonResponse(
        problem({
          status: 422,
          errorCode: 'unsupported_calibration_method',
          title: 'Unsupported calibration method',
          detail:
            `Unsupported calibration method '${methodRaw}'. Supported ` +
            `methods: ${SUPPORTED_CALIBRATION_METHODS.join(', ')}.`,
          supportedMethods: SUPPORTED_CALIBRATION_METHODS,
        }).status,
        problem({
          status: 422,
          errorCode: 'unsupported_calibration_method',
          title: 'Unsupported calibration method',
          detail:
            `Unsupported calibration method '${methodRaw}'. Supported ` +
            `methods: ${SUPPORTED_CALIBRATION_METHODS.join(', ')}.`,
          supportedMethods: SUPPORTED_CALIBRATION_METHODS,
        }).body,
      );
    }

    // Presence check (not value check): a non-null saga field on a
    // calibration-mode request must be rejected, matching upstream's
    // `is not null` guard.
    const projectId = req.bodyJson['calibrationProjectId'];
    const attemptId = req.bodyJson['calibrationAttemptId'];
    const orchestrationId = req.bodyJson['calibrationOrchestrationId'];
    if (projectId != null || attemptId != null || orchestrationId != null) {
      return jsonResponse(
        problem({
          status: 422,
          errorCode: 'calibration_mode_conflicts_with_saga_ids',
          title: 'Calibration and saga IDs conflict',
          detail:
            'A calibration-mode request (calibration.method) cannot also ' +
            'specify calibrationProjectId, calibrationAttemptId, or ' +
            'calibrationOrchestrationId; those belong to the separate ' +
            'printer/toolhead calibration-projects saga.',
        }).status,
        problem({
          status: 422,
          errorCode: 'calibration_mode_conflicts_with_saga_ids',
          title: 'Calibration and saga IDs conflict',
          detail:
            'A calibration-mode request (calibration.method) cannot also ' +
            'specify calibrationProjectId, calibrationAttemptId, or ' +
            'calibrationOrchestrationId; those belong to the separate ' +
            'printer/toolhead calibration-projects saga.',
        }).body,
      );
    }

    const jobId = randomUUID();
    const now = this.nowFn().toISOString();
    const params = (calibration as Record<string, unknown>)['params'];
    const paramsJson =
      params !== undefined && params !== null ? JSON.stringify(params) : null;
    const job: FakeSliceJob = {
      jobId,
      userId: (req.bodyJson['userId'] as string) ?? '',
      printerId: (req.bodyJson['printerId'] as string) ?? null,
      slicerEngine:
        (req.bodyJson['slicerEngine'] as string | number) ?? 'OrcaSlicer',
      slicerProfileJson: (req.bodyJson['slicerProfileJson'] as string) ?? null,
      calibrationMethod: methodRaw as SupportedCalibrationMethod,
      calibrationParamsJson: paramsJson,
      calibrationProjectIdPresent: Object.prototype.hasOwnProperty.call(
        req.bodyJson,
        'calibrationProjectId',
      ),
      calibrationAttemptIdPresent: Object.prototype.hasOwnProperty.call(
        req.bodyJson,
        'calibrationAttemptId',
      ),
      calibrationOrchestrationIdPresent: Object.prototype.hasOwnProperty.call(
        req.bodyJson,
        'calibrationOrchestrationId',
      ),
      idempotencyKey,
      rawRequest: { rawJson: req.bodyText, parsed: req.bodyJson },
      status: 'Queued',
      failureReason: null,
      failureHint: null,
      errorMessage: null,
      createdAt: now,
      completedAt: null,
      pollAttempts: 0,
    };
    this.sliceJobs.set(jobId, job);
    if (idempotencyKey !== null) {
      this.idempotencyIndex.set(idempotencyKey, jobId);
    }

    return jsonResponse(202, {
      jobId,
      status: 'Queued',
      queuedAt: now,
      queuePosition: 0,
    });
  }

  // ---- GET /api/slice/{jobId} --------------------------------------------

  private handleGetSlice(jobId: string): Response {
    const job = this.sliceJobs.get(jobId);
    if (job === undefined) {
      return jsonResponse(404, { detail: 'slice job not found' });
    }
    job.pollAttempts += 1;
    if (job.status === 'Queued' || job.status === 'Processing') {
      if (this.failNext) {
        this.failNext = false;
        const reason = this.failNextReason as {
          failureReason: string;
          failureHint: string;
          errorMessage: string;
        };
        this.failNextReason = null;
        job.status = 'Failed';
        job.completedAt = this.nowFn().toISOString();
        job.failureReason = reason.failureReason;
        job.failureHint = reason.failureHint;
        job.errorMessage = reason.errorMessage;
      } else if (job.pollAttempts > this.pollsBeforeCompletion) {
        job.status = 'Completed';
        job.completedAt = this.nowFn().toISOString();
      } else {
        job.status = 'Processing';
      }
    }
    return jsonResponse(200, {
      id: job.jobId,
      status: job.status,
      progressPercent: job.status === 'Completed' ? 100 : 50,
      progressMessage: null,
      queuedAt: job.createdAt,
      startedAt: job.createdAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage,
      errorDetail: null,
      layoutDegradation: null,
      failureReason: job.failureReason,
      failureHint: job.failureHint,
      estimatedPrintTimeSeconds: job.status === 'Completed' ? 900 : null,
      filamentUsedGrams: job.status === 'Completed' ? 4.2 : null,
      workerId: null,
      modelFileName:
        job.calibrationMethod === 'temperature_tower'
          ? 'temperature_tower.drc'
          : job.calibrationMethod === 'flow_rate_pass_1'
            ? 'flowrate-test-pass1.3mf'
            : 'flowrate-test-pass2.3mf',
      slicerEngine: 'OrcaSlicer',
      artifactsRoute: `/api/slice/${job.jobId}/artifacts`,
    });
  }

  // ---- POST /api/slice/{jobId}/send-to-printer ---------------------------

  private handleSendToPrinter(jobId: string, req: ParsedRequest): Response {
    const job = this.sliceJobs.get(jobId);
    if (job === undefined) {
      return jsonResponse(404, { detail: 'slice job not found' });
    }
    if (job.status !== 'Completed') {
      return jsonResponse(400, {
        detail: 'slice job is not in Completed status',
      });
    }
    if (req.bodyJson === null) {
      return jsonResponse(400, { detail: 'Request body is required' });
    }
    const printerId = req.bodyJson['printerId'];
    if (typeof printerId !== 'string') {
      return jsonResponse(400, { detail: 'printerId is required' });
    }
    const startPrintRaw = req.bodyJson['startPrint'];
    // The desktop is expected to send an explicit boolean. The real DTO
    // (`SendToPrinterRequest`) defaults `StartPrint` to `false` when the
    // field is absent — the "operator-driven" test asserts the value that
    // reaches the wire, not the server's fallback.
    const startPrint = startPrintRaw === true;
    const submittedAt = this.nowFn().toISOString();
    const submission: FakePrintSubmission = {
      jobId,
      printerId,
      startPrint,
      submittedAt,
      rawRequest: { rawJson: req.bodyText, parsed: req.bodyJson },
    };
    this.printSubmissionsList.push(submission);

    return jsonResponse(200, {
      jobId,
      printerId,
      fileName: 'calibration.gcode',
      printStarted: startPrint,
      message: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ---------------------------------------------------------------------------
// Realistic base filament profile (used by every acceptance test)
// ---------------------------------------------------------------------------

/**
 * A minimal OrcaSlicer filament profile shape the calibration workflow
 * touches. Field encodings match the OrcaSlicer convention that the desktop
 * already handles in `orcaProfileGenerator.ts`:
 *
 *   - `filament_flow_ratio` is an array-of-string-numbers.
 *   - `nozzle_temperature` is an array-of-string-numbers with the first-layer
 *     temperature in slot 0.
 *
 * Every other field is realistic filler — enough that a byte-level sha256 of
 * a mutated profile differs from the initial, but not so much that a
 * whitespace change to one field would falsely trip the clone-isolation
 * assertion. The canonical JSON encoder handles ordering.
 */
export function sampleBaseFilamentProfile(): Record<string, unknown> {
  return {
    type: 'filament',
    name: 'Generic PLA @ K1 Max 0.4',
    from: 'system',
    inherits: '',
    compatible_printers: ['K1 Max 0.4'],
    compatible_printers_condition: '',
    filament_type: ['PLA'],
    filament_vendor: ['Generic'],
    filament_flow_ratio: ['0.98'],
    filament_max_volumetric_speed: ['12'],
    nozzle_temperature: ['215', '210'],
    nozzle_temperature_initial_layer: ['215'],
    filament_retraction_length: ['0.8'],
    filament_retraction_speed: ['30'],
  };
}
