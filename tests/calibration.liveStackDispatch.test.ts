/**
 * calibration.liveStackDispatch.test.ts — env-gated end-to-end integration
 * test against the daily-validation stack Bishop stands up locally.
 *
 * SKIPPED BY DEFAULT. CI stays hermetic and docker-free. To enable:
 *
 *   $env:PRINTFARMER_STACK_BASE_URL = "http://localhost:18080"  # nginx
 *   $env:PRINTFARMER_STACK_TOKEN    = "$(wsl -d Ubuntu-24.04 -e bash -lc 'cat /tmp/printfarmer-round2/.token')"
 *   npx vitest run tests/calibration.liveStackDispatch.test.ts
 *
 * ACCEPTANCE MODEL — WHAT COUNTS AS "REACHED THE MOCK PRINTER"
 * ------------------------------------------------------------
 * A 202 from PrintFarmer proves ACCEPTANCE, not ARRIVAL. Those are different
 * claims. This harness treats the Moonraker emulator's own reported state as
 * the acceptance signal:
 *
 *   http://localhost:17125/__emulator/printer
 *     .printState transitions "standby" → "printing"
 *     .filename    matches the seeded artifact name pattern
 *   http://localhost:17125/server/files/list?root=gcodes
 *     includes the artifact of the expected size
 *
 * Bishop drove this sequence end-to-end on 2026-08-21 and the emulator
 * reported `printState:"printing"` and the seeded G-code on its virtual SD.
 * That is what this harness reproduces.
 *
 * A harness that stops at the 202 has the same self-referential defect
 * as an assertion against the desktop's own claim rather than against the
 * destination the claim is about. The emulator poll is deliberate.
 *
 * PREREQUISITE — SEED
 * -------------------
 * Bishop's five SQL seed scripts live in `D:\s\pfarm1\.stack-round2\`:
 *   fix-b-bypass-seed.sql            (spool/project/snapshot/attempt/orchestration/gcode-file)
 *   fix-b-bypass-seed.followup.sql   (repoint gcode-file → orchestration)
 *   fix-b-bypass-material.sql        (load PLA on printer + toolhead)
 *   fix-b-bypass-realbytes.sql       (crafted 4096-byte G-code + SHA-256)
 *   fix-b-bypass-toolhead.sql        (project.SelectedToolheadId + Index)
 *
 * They must all be applied AND a 4096-byte G-code file `docker cp`-ed to
 * `printfarmer-round2-api-1:/app/gcode/promoted-calibration-bishop-round4.gcode`
 * BEFORE the harness runs.
 *
 * If you set `PRINTFARMER_STACK_SEED_CMD`, the harness spawns it before
 * Stage 1 so a single vitest invocation is a true end-to-end run. Otherwise
 * the harness assumes the seed is already in place.
 *
 * NAMED PRECONDITIONS — WHAT EACH REFUSAL MEANS
 * ---------------------------------------------
 * Each of Bishop's five refusals is a real dispatch gate. On failure the
 * harness names the missing seed step next to the server-supplied reason
 * code, so a diagnostic run tells a developer which SQL script to reapply.
 * See `EXPECTED_REFUSAL_HINTS` below.
 */

// @vitest-environment node

import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// ---- env plumbing ---------------------------------------------------------

const rawBase = process.env.PRINTFARMER_STACK_BASE_URL?.trim();
const enabled = Boolean(rawBase);
const bearerToken = process.env.PRINTFARMER_STACK_TOKEN?.trim() || null;
const emulatorUrlRaw =
  process.env.PRINTFARMER_STACK_EMULATOR_URL?.trim() ||
  'http://localhost:17125';
const targetPrinterId =
  process.env.PRINTFARMER_STACK_TARGET_PRINTER_ID?.trim() ||
  '6b68328f-6495-4d32-8a2d-784119e59a01';
const seededGcodeFileId =
  process.env.PRINTFARMER_STACK_GCODE_FILE_ID?.trim() ||
  'fea70000-0000-0004-0000-000000000013';
const seededOrchestrationId =
  process.env.PRINTFARMER_STACK_CALIBRATION_ORCHESTRATION_ID?.trim() ||
  'd974ea73-9b93-4765-9456-ee68f4e1c546';
const seededProjectId =
  process.env.PRINTFARMER_STACK_CALIBRATION_PROJECT_ID?.trim() ||
  '0ea3edc3-24b3-45ee-9ca5-f4a97691d5e5';
const seededAttemptId =
  process.env.PRINTFARMER_STACK_CALIBRATION_ATTEMPT_ID?.trim() ||
  'a1b4a93a-99ca-403e-a3f4-ad5b77856997';
const expectedConfigRevision = Number(
  process.env.PRINTFARMER_STACK_EXPECTED_CONFIG_REVISION?.trim() || '2',
);
const expectedFilenamePattern =
  process.env.PRINTFARMER_STACK_EXPECTED_FILENAME_PATTERN?.trim() ||
  'promoted-calibration';
const seedCmd = process.env.PRINTFARMER_STACK_SEED_CMD?.trim() || null;

// ---- Bishop's five refusals, named as preconditions ----------------------
// Each entry names (a) the wire code the server returns, (b) the SQL script
// / setup step that resolves it, (c) the source-of-truth file & line for the
// gate that produced the refusal. If the server changes any of these, the
// stage report still tells a developer the last-known-good remedy verbatim.

interface RefusalHint {
  readonly serverCode: readonly string[];
  readonly seedStep: string;
  readonly serverGate: string;
}

const EXPECTED_REFUSAL_HINTS: readonly RefusalHint[] = [
  {
    serverCode: ['calibration_resource_not_found'],
    seedStep:
      'Orchestration row missing. Apply fix-b-bypass-seed.followup.sql to repoint GcodeFiles.CalibrationOrchestrationId at the pre-existing d974ea73-… row.',
    serverGate:
      'JobQueueService.AddJobToQueueAsync :341-411 → GcodeFile lookup by CalibrationOrchestrationId',
  },
  {
    serverCode: ['filament_material_unknown', 'filament_check_failed'],
    seedStep:
      'Loaded material missing. Apply fix-b-bypass-material.sql (UPDATE Printers/Toolheads SET CurrentMaterial="PLA").',
    serverGate: 'DispatchSafetyGates.EvaluateFilament :238-297',
  },
  {
    serverCode: [
      'gcode_bytes_unavailable',
      'gcode_file_missing',
      'gcode_hash_mismatch',
      'gcode_byte_hash_mismatch',
      'calibration_job_incompatible',
    ],
    seedStep:
      'G-code bytes missing or SHA-256 mismatch. Apply fix-b-bypass-realbytes.sql AND `docker cp` a 4096-byte file to printfarmer-round2-api-1:/app/gcode/promoted-calibration-bishop-round4.gcode. Its content SHA-256 must match GcodeFiles.ContentSha256 = 2dc22354… (the value the SQL stores).',
    serverGate:
      'StoredGcodeIntegrityVerifier.VerifyAsync :46-118 (reads /app/gcode/{FilePath}{FileName}, SHA-256s, compares)',
  },
  {
    serverCode: ['calibration_record_mismatch', 'calibration_record_invalid'],
    seedStep:
      'Project.SelectedToolheadId/Index null-vs-canonicalized mismatch. Apply fix-b-bypass-toolhead.sql (SET SelectedToolheadId="fea70000-…001", SelectedToolheadIndex=0).',
    serverGate:
      'DispatchClaimService.EnsureCalibrationRecordsMatch :1621-1673 (52-field ack-time re-verification)',
  },
];

function findRefusalHint(reasonCode: string | null): RefusalHint | null {
  if (reasonCode === null) return null;
  for (const hint of EXPECTED_REFUSAL_HINTS) {
    if (hint.serverCode.includes(reasonCode)) return hint;
  }
  return null;
}

// ---- loopback guard -------------------------------------------------------

function assertLoopback(url: string): URL {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!loopbackHosts.has(host)) {
    throw new Error(
      `URL "${url}" is not loopback — refusing to send calibration requests to a non-loopback host.`,
    );
  }
  return parsed;
}

// ---- HTTP helpers ---------------------------------------------------------

interface StageResult {
  stage: string;
  status: number | null;
  reason: string | null;
  detail: unknown;
  headers: Record<string, string>;
}

function extractReasonCode(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const direct = record.code;
  if (typeof direct === 'string') return direct;
  const extensions = record.extensions;
  if (extensions === null || typeof extensions !== 'object') return null;
  const extCode = (extensions as Record<string, unknown>).code;
  if (typeof extCode === 'string') return extCode;
  return null;
}

function withAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (bearerToken !== null) {
    headers.set('Authorization', `Bearer ${bearerToken}`);
  }
  return { ...init, headers };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<StageResult> {
  try {
    const res = await fetch(url, withAuth(init));
    const status = res.status;
    let body: unknown = null;
    try {
      body = (await res.json()) as unknown;
    } catch {
      body = await res.text().catch(() => null);
    }
    const reason = extractReasonCode(body);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { stage: '', status, reason, detail: body, headers };
  } catch (err) {
    return {
      stage: '',
      status: null,
      reason: 'network_error',
      detail: err instanceof Error ? err.message : String(err),
      headers: {},
    };
  }
}

function formatFailure(
  stage: string,
  result: StageResult,
  extra?: Record<string, unknown>,
): string {
  const hint = findRefusalHint(result.reason);
  const parts: string[] = [
    `stopped at stage=${stage}`,
    `status=${result.status ?? 'no-response'}`,
    `reason=${result.reason ?? 'n/a'}`,
  ];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  if (hint) {
    parts.push(`SEED-STEP-HINT: ${hint.seedStep}`);
    parts.push(`SERVER-GATE: ${hint.serverGate}`);
  }
  parts.push(`detail=${JSON.stringify(result.detail).slice(0, 400)}`);
  return parts.join(' ');
}

// ---- Bishop's UUID namespace + expected filename shape --------------------
// `pf-{contentHashPrefix}-promoted-calibration-bishop-round4.gcode` is what
// the API assembles when it copies the artifact to the emulator's virtual
// SD (see StoredGcodeIntegrityVerifier + emulator's /server/files/upload).
// The pattern check is intentionally loose (contains-check on
// `expectedFilenamePattern`) so a hash prefix change in the seed doesn't
// break the harness.

interface EmulatorSnapshot {
  status: number | null;
  printState: string | null;
  filename: string | null;
  virtualSdActive: boolean | null;
  raw: unknown;
}

async function pollEmulatorPrinter(
  emulatorBaseUrl: string,
): Promise<EmulatorSnapshot> {
  const res = await fetchJson(`${emulatorBaseUrl}/__emulator/printer`);
  const body = res.detail as Record<string, unknown> | null;
  return {
    status: res.status,
    printState:
      typeof body?.['printState'] === 'string' ? body['printState'] : null,
    filename: typeof body?.['filename'] === 'string' ? body['filename'] : null,
    virtualSdActive: null,
    raw: body,
  };
}

async function pollEmulatorMoonraker(
  emulatorBaseUrl: string,
): Promise<EmulatorSnapshot> {
  const res = await fetchJson(
    `${emulatorBaseUrl}/printer/objects/query?print_stats&virtual_sdcard`,
  );
  const body = res.detail as Record<string, unknown> | null;
  const status = ((body?.['result'] as Record<string, unknown> | undefined)?.[
    'status'
  ] ?? {}) as Record<string, unknown>;
  const printStats = (status['print_stats'] ?? {}) as Record<string, unknown>;
  const vsd = (status['virtual_sdcard'] ?? {}) as Record<string, unknown>;
  return {
    status: res.status,
    printState:
      typeof printStats['state'] === 'string' ? printStats['state'] : null,
    filename:
      typeof printStats['filename'] === 'string'
        ? printStats['filename']
        : typeof vsd['file_path'] === 'string'
          ? vsd['file_path']
          : null,
    virtualSdActive:
      typeof vsd['is_active'] === 'boolean' ? vsd['is_active'] : null,
    raw: body,
  };
}

async function pollEmulatorFiles(
  emulatorBaseUrl: string,
): Promise<{ status: number | null; names: readonly string[]; raw: unknown }> {
  const res = await fetchJson(
    `${emulatorBaseUrl}/server/files/list?root=gcodes`,
  );
  const body = res.detail;
  const names: string[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (entry !== null && typeof entry === 'object') {
        const p = (entry as Record<string, unknown>)['path'];
        if (typeof p === 'string') names.push(p);
      }
    }
  }
  return { status: res.status, names, raw: body };
}

// ---- describe blocks ------------------------------------------------------

describe.skipIf(!enabled)(
  'live daily-validation stack — calibration end-to-end (SKIPPED by default; set PRINTFARMER_STACK_BASE_URL to enable)',
  () => {
    // Compute the base URLs lazily so this describe body can be collected
    // even when the env is not set. `describe.skipIf` gates execution but
    // not collection — a top-level throw here would fail the whole file.
    const baseUrl = enabled
      ? assertLoopback(rawBase as string)
          .toString()
          .replace(/\/$/, '')
      : '';
    const emulatorUrl = enabled
      ? assertLoopback(emulatorUrlRaw).toString().replace(/\/$/, '')
      : '';

    /**
     * Bishop's exact working sequence, replayed:
     *
     *   0. optional seed
     *   1. GET  /api/calibration/capabilities        (peek all flags)
     *   2. GET  /api/printers/calibration-candidates  (eligibility)
     *   3. GET  /api/printers/{id}/calibration-context?slicerType=OrcaSlicer
     *   3a. GET emulator BEFORE snapshot            (record initial state)
     *   4. POST /api/job-queue                      (Queue button)
     *   4a. GET /api/job-queue/{jobId}              (harvest BOTH ETags)
     *   5. POST /acknowledge-bed-clear-and-start    (Confirm bed clear)
     *   6. POLL emulator until printState=printing OR timeout
     *   7. GET emulator /server/files/list, assert filename appears
     *
     * On any refusal at Stages 4/5 we look up the wire code in
     * EXPECTED_REFUSAL_HINTS and print the SQL seed step and the source
     * gate. A developer running this in the fix loop sees exactly which
     * script to reapply.
     */
    it("drives Bishop's exact working sequence and asserts the emulator reports printState=printing", async () => {
      // Stage 0: optional seed.
      if (seedCmd !== null) {
        try {
          const out = execSync(seedCmd, {
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: 60_000,
          });
          console.log(
            `[calibration.liveStackDispatch] SEED cmd ran ok. stdout=${out.slice(0, 400)}`,
          );
        } catch (err) {
          expect.fail(
            `stopped at stage=seed — PRINTFARMER_STACK_SEED_CMD failed. err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const auth = bearerToken === null ? 'anonymous' : 'bearer';

      // Stage 1: capabilities negotiation. Peek all interesting flags for
      // the failure message so a fix-loop can see what's true and what's
      // false at a glance.
      const caps = await fetchJson(`${baseUrl}/api/calibration/capabilities`);
      if (caps.status !== 200) {
        expect.fail(formatFailure('capabilities', caps, { auth }));
        throw new Error('unreachable — expect.fail throws');
      }
      const capsBody = caps.detail as Record<string, unknown> | null;
      expect(capsBody).toBeTruthy();

      const flagPeek = {
        calibrationContextEnabled: capsBody?.['calibrationContextEnabled'],
        calibrationPersistenceEnabled:
          capsBody?.['calibrationPersistenceEnabled'],
        calibrationSyncEnabled: capsBody?.['calibrationSyncEnabled'],
        calibrationEventsEnabled: capsBody?.['calibrationEventsEnabled'],
        calibrationGenerationEnabled:
          capsBody?.['calibrationGenerationEnabled'],
        calibrationQueueEnabled: capsBody?.['calibrationQueueEnabled'],
        calibrationJobBoundBedClearEnabled:
          capsBody?.['calibrationJobBoundBedClearEnabled'],
        unavailableReasons: capsBody?.['unavailableReasons'],
      };

      // Stage 2: calibration-candidates lookup.
      const candidates = await fetchJson(
        `${baseUrl}/api/printers/calibration-candidates`,
      );
      if (candidates.status !== 200) {
        const authHint =
          candidates.status === 401 && bearerToken === null
            ? ' — set $env:PRINTFARMER_STACK_TOKEN to the /tmp/printfarmer-round2/.token contents'
            : '';
        expect.fail(
          formatFailure('candidates', candidates, {
            auth,
            flags: flagPeek,
          }) + authHint,
        );
        throw new Error('unreachable — expect.fail throws');
      }
      const list = Array.isArray(candidates.detail)
        ? (candidates.detail as ReadonlyArray<Record<string, unknown>>)
        : null;
      const target = list?.find((p) => p['id'] === targetPrinterId);
      if (!target) {
        const idList = list
          ? list
              .map((p) => p['id'])
              .filter((v): v is string => typeof v === 'string')
          : null;
        expect.fail(
          `stopped at stage=candidates-lookup — target printer ${targetPrinterId} not returned. Available: ${JSON.stringify(idList ?? candidates.detail)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }
      if (target['eligible'] !== true) {
        const reasons: unknown = target['rejectionReasons'];
        expect.fail(
          `stopped at stage=candidate-eligibility — target ${targetPrinterId} eligible=false. rejectionReasons=${JSON.stringify(reasons).slice(0, 400)} flags=${JSON.stringify(flagPeek)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Stage 3: calibration-context.
      const context = await fetchJson(
        `${baseUrl}/api/printers/${targetPrinterId}/calibration-context?slicerType=OrcaSlicer`,
      );
      if (context.status !== 200) {
        expect.fail(formatFailure('context', context, { flags: flagPeek }));
        throw new Error('unreachable — expect.fail throws');
      }
      const contextBody = context.detail as Record<string, unknown> | null;

      // Stage 3a: emulator BEFORE snapshot. If it's already reporting
      // "printing" from a previous run, tell the developer plainly — the
      // acceptance signal we're about to assert is meaningless if the
      // emulator was already in that state.
      const emuBefore = await pollEmulatorPrinter(emulatorUrl);
      if (emuBefore.status !== 200) {
        expect.fail(
          `stopped at stage=emulator-preflight — emulator at ${emulatorUrl}/__emulator/printer returned status=${emuBefore.status}. Is the daily-validation stack up? Check moonraker-ready container.`,
        );
        throw new Error('unreachable — expect.fail throws');
      }
      const printStateBefore = emuBefore.printState;
      const filenameBefore = emuBefore.filename;
      if (printStateBefore === 'printing') {
        console.log(
          `[calibration.liveStackDispatch] WARN: emulator already reports printState=printing (filename=${filenameBefore ?? 'null'}) before this test's dispatch. Reset via POST ${emulatorUrl}/__emulator/reset (or restart moonraker-ready) if you want a clean handoff signal. This run's Stage 5 will likely 409 with printer_busy — that IS the correct refusal.`,
        );
      }

      // Stage 4: job-queue POST (Queue button). Bishop's tested wire body.
      // `jobKind: 1` = FilamentCalibration (see JobKind enum). Bishop's
      // driver uses the numeric enum; the API also accepts the string
      // form, but 1 is what he proved works.
      const idempotencyKey = `hicks-round5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const jobBody: Record<string, unknown> = {
        gcodeFileId: seededGcodeFileId,
        jobKind: 1,
        assignedPrinterId: targetPrinterId,
        priority: 1,
        copies: 1,
        idempotencyKey,
        calibrationOrchestrationId: seededOrchestrationId,
        calibrationProjectId: seededProjectId,
        calibrationAttemptId: seededAttemptId,
      };

      const queue = await fetchJson(`${baseUrl}/api/job-queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(jobBody),
      });
      if (queue.status !== 201 && queue.status !== 200) {
        expect.fail(
          formatFailure('queue-create', queue, {
            flags: flagPeek,
            contextSnapshotId: contextBody?.['snapshotId'],
          }),
        );
        throw new Error('unreachable — expect.fail throws');
      }
      const queueBody = queue.detail as Record<string, unknown> | null;
      const jobIdRaw = queueBody?.['id'] ?? queueBody?.['jobId'];
      const jobId = typeof jobIdRaw === 'string' ? jobIdRaw : null;
      if (jobId === null) {
        expect.fail(
          `stopped at stage=queue-create-jobid — server returned 2xx but body has no id/jobId field. body=${JSON.stringify(queueBody).slice(0, 400)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Stage 4a: GET the job to harvest BOTH ETags. Bishop's Python
      // driver does this because the POST response does not consistently
      // carry both — /acknowledge-bed-clear-and-start requires `If-Match`
      // AND `X-Dispatch-State-If-Match` and 428s without either. Round 4
      // of this test sourced ETags from the POST response and hit
      // ack-preconditions on every run; the fix is to GET first, which
      // is what the working sequence does.
      const jobGet = await fetchJson(`${baseUrl}/api/job-queue/${jobId}`);
      if (jobGet.status !== 200) {
        expect.fail(
          formatFailure('job-get', jobGet, {
            jobId,
            flags: flagPeek,
          }),
        );
        throw new Error('unreachable — expect.fail throws');
      }
      const jobEtag = jobGet.headers['etag'] ?? null;
      const dispatchStateEtag = jobGet.headers['x-dispatch-state-etag'] ?? null;
      if (jobEtag === null || dispatchStateEtag === null) {
        expect.fail(
          `stopped at stage=ack-preconditions — GET job response missing precondition ETag(s). If-Match(etag)=${jobEtag ?? 'MISSING'} X-Dispatch-State-If-Match=${dispatchStateEtag ?? 'MISSING'} response-headers=${JSON.stringify(jobGet.headers)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Stage 5: acknowledge-bed-clear-and-start. Bishop's payload:
      //   { printerId, idempotencyKey, expectedPrinterConfigRevision }
      // Three precondition headers: Idempotency-Key, If-Match,
      // X-Dispatch-State-If-Match. The GET's ETag values are already
      // quoted; forward them verbatim.
      const ackIdempotencyKey = `hicks-round5-ack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const ackBody = {
        printerId: targetPrinterId,
        idempotencyKey: ackIdempotencyKey,
        expectedPrinterConfigRevision: expectedConfigRevision,
      };
      const ack = await fetchJson(
        `${baseUrl}/api/job-queue/${jobId}/acknowledge-bed-clear-and-start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': ackIdempotencyKey,
            'If-Match': jobEtag,
            'X-Dispatch-State-If-Match': dispatchStateEtag,
          },
          body: JSON.stringify(ackBody),
        },
      );
      if (ack.status !== 200 && ack.status !== 202 && ack.status !== 204) {
        expect.fail(
          formatFailure('ack-dispatch', ack, {
            jobId,
            flags: flagPeek,
          }),
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Stage 6: poll the emulator. Up to 10 iterations at 1-second
      // intervals — total 10s bound. Bishop observed "printing" within
      // ~6-8s on a healthy run. If we're already printing on the first
      // poll AND we weren't before, that's fine.
      const pollDeadline = Date.now() + 12_000;
      let emuAfter: EmulatorSnapshot | null = null;
      const transitions: string[] = [];
      while (Date.now() < pollDeadline) {
        const snap = await pollEmulatorPrinter(emulatorUrl);
        emuAfter = snap;
        if (snap.printState !== null) {
          const last = transitions[transitions.length - 1];
          if (snap.printState !== last) {
            transitions.push(snap.printState);
          }
        }
        if (snap.printState === 'printing') break;
        await new Promise((r) => setTimeout(r, 1_000));
      }

      if (emuAfter === null || emuAfter.printState !== 'printing') {
        expect.fail(
          `stopped at stage=emulator-print-state — after 202 accepted, emulator did not report printState=printing within 12s. transitions=${JSON.stringify(transitions)} lastSnapshot=${JSON.stringify(emuAfter).slice(0, 400)} beforePrintState=${printStateBefore ?? 'unknown'} beforeFilename=${filenameBefore ?? 'unknown'}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Filename check — must contain the expected pattern (loose match
      // because the actual name includes a `pf-{hashPrefix}-` prefix).
      if (
        emuAfter.filename === null ||
        !emuAfter.filename.includes(expectedFilenamePattern)
      ) {
        expect.fail(
          `stopped at stage=emulator-filename — printState is printing but filename ${JSON.stringify(emuAfter.filename)} does not include pattern ${JSON.stringify(expectedFilenamePattern)}. lastSnapshot=${JSON.stringify(emuAfter).slice(0, 400)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Cross-check via Moonraker's own protocol.
      const moon = await pollEmulatorMoonraker(emulatorUrl);
      if (moon.printState !== 'printing') {
        expect.fail(
          `stopped at stage=moonraker-print-state — /__emulator says printing but /printer/objects/query says state=${moon.printState}. moon=${JSON.stringify(moon).slice(0, 400)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // Stage 7: virtual SD file present.
      const files = await pollEmulatorFiles(emulatorUrl);
      if (files.status !== 200) {
        expect.fail(
          `stopped at stage=emulator-files — /server/files/list status=${files.status}. Expected 200 with the seeded artifact present.`,
        );
        throw new Error('unreachable — expect.fail throws');
      }
      const matchingFile = files.names.find((n) =>
        n.includes(expectedFilenamePattern),
      );
      if (matchingFile === undefined) {
        expect.fail(
          `stopped at stage=emulator-files-lookup — no file matching ${JSON.stringify(expectedFilenamePattern)} on emulator virtual SD. files=${JSON.stringify(files.names)}`,
        );
        throw new Error('unreachable — expect.fail throws');
      }

      // All stages passed — the emulator itself reports it started
      // printing our seeded artifact. Both sides of the handoff
      // confirmed, matching Bishop's Round-4 evidence set.
      expect(emuAfter.printState).toBe('printing');
      expect(moon.printState).toBe('printing');
      expect(matchingFile).toContain(expectedFilenamePattern);
    }, 120_000);

    it('loopback guards — resolved base + emulator URLs both parsed as loopback', () => {
      const parsedBase = new URL(baseUrl);
      const parsedEmu = new URL(emulatorUrl);
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(
        parsedBase.hostname.toLowerCase(),
      );
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(
        parsedEmu.hostname.toLowerCase(),
      );
    });
  },
);

describe('live-stack test file — always-visible controls', () => {
  it('loopback guard rejects a public host', () => {
    expect(() => assertLoopback('https://printfarm.example.com/')).toThrow(
      /not loopback/,
    );
  });

  it('loopback guard accepts 127.0.0.1', () => {
    expect(() => assertLoopback('http://127.0.0.1:15245/')).not.toThrow();
  });

  it('loopback guard accepts localhost', () => {
    expect(() => assertLoopback('http://localhost:18080/')).not.toThrow();
  });

  it('withAuth is a no-op when no bearer token is configured', () => {
    if (bearerToken === null) {
      const init = withAuth({ method: 'GET' });
      const headers = new Headers(init.headers);
      expect(headers.has('Authorization')).toBe(false);
    } else {
      expect(bearerToken.length).toBeGreaterThan(0);
    }
  });

  it('refusal-hint table names all five of Bishop Round-4 refusals', () => {
    // The hint table must cover each named refusal. If a future round
    // discovers a sixth refusal, this test forces us to name it here.
    const codes = EXPECTED_REFUSAL_HINTS.flatMap((h) => [...h.serverCode]);
    expect(codes).toContain('calibration_resource_not_found');
    expect(codes).toContain('filament_material_unknown');
    expect(codes).toContain('gcode_bytes_unavailable');
    expect(codes).toContain('calibration_record_mismatch');
    // filament_check_failed is the aggregate 422 the server sends after
    // any filament sub-gate refuses; the hint table must cover it too.
    expect(codes).toContain('filament_check_failed');
  });

  it('findRefusalHint returns null for a code not in the table (no phantom matches)', () => {
    // Control against a soft-match bug where every unrecognised code
    // gets one hint anyway. A future edit that adds a catch-all hint
    // would silently pass every "generic 422" as "run fix-b-bypass-*".
    expect(findRefusalHint('a_completely_made_up_wire_code')).toBeNull();
  });

  it('findRefusalHint routes filament_material_unknown to the material seed', () => {
    // Positive control: the mapping actually works for one known code.
    const hint = findRefusalHint('filament_material_unknown');
    expect(hint).not.toBeNull();
    expect(hint?.seedStep).toContain('fix-b-bypass-material.sql');
  });

  it('formatFailure includes the seed hint when the wire code is known', () => {
    const fake: StageResult = {
      stage: 'queue-create',
      status: 422,
      reason: 'calibration_record_mismatch',
      detail: { title: 'Calibration record mismatch' },
      headers: {},
    };
    const msg = formatFailure('queue-create', fake);
    expect(msg).toContain('SEED-STEP-HINT');
    expect(msg).toContain('fix-b-bypass-toolhead.sql');
    expect(msg).toContain('SERVER-GATE');
    expect(msg).toContain('DispatchClaimService.EnsureCalibrationRecordsMatch');
  });

  it('formatFailure omits the seed hint when the wire code is unknown', () => {
    const fake: StageResult = {
      stage: 'queue-create',
      status: 500,
      reason: 'internal_server_error',
      detail: null,
      headers: {},
    };
    const msg = formatFailure('queue-create', fake);
    expect(msg).not.toContain('SEED-STEP-HINT');
  });

  it('reports whether the env-gated describe block would run', () => {
    if (enabled) {
      const authState = bearerToken === null ? 'anonymous' : 'bearer-token';
      const seedState = seedCmd === null ? 'no-seed-cmd' : 'seed-cmd-set';
      console.log(
        `[calibration.liveStackDispatch] PRINTFARMER_STACK_BASE_URL=${rawBase} emulator=${emulatorUrlRaw} auth=${authState} seed=${seedState} gcode=${seededGcodeFileId} — integration block ENABLED.`,
      );
    } else {
      console.log(
        '[calibration.liveStackDispatch] PRINTFARMER_STACK_BASE_URL not set — integration block SKIPPED (this is the default).',
      );
    }
    expect(typeof enabled).toBe('boolean');
  });
});
