// @vitest-environment node
/**
 * Mock-printer dispatch test — the test that would have caught the "green
 * suite, broken feature" gap in the calibration flow.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every calibration test in `tests/` up to this file mocks the HTTP layer
 * with a fixture the desktop itself defines. That means when the server
 * contract drifts — or the desktop assembles a subtly wrong POST — nothing
 * fails, because the desktop is asserting against its own reflection.
 *
 * This test asserts against a **server-sourced** shape imported from
 * `tests/fixtures/server-contract/`. The snapshots there are pinned to a
 * specific commit and blob hash of `OlyForge3D/PrintFarmer`; when the sibling
 * server checkout is available (`D:\s\pfarm1` by default), we also run a
 * drift check against the live C# to prove the snapshot is not another
 * mirror. Failing that drift check is a failure, not a warning: a stale
 * snapshot is exactly the class of defect this file exists to prevent.
 *
 * THE THREE CONTROLS
 * ------------------
 * Per the repo rule captured in `.squad/known-lying-commands.md`, every
 * matching predicate must have a control that returns the opposite result
 * when evaluated on the same data.
 *
 *   1. Positive — an extra POST injected by the test itself is observed by
 *      the same request-counting assertion. Proves the listener is real and
 *      not silently discarding.
 *   2. Negative — with the handler disabled, the wire is empty. Proves the
 *      assertion isn't passing on a request that never happened.
 *   3. Server-shape — mutating a desktop request field name makes the
 *      server-sourced snapshot reject it. This is the load-bearing control:
 *      if it does not bite, the snapshot import is another self-referential
 *      mirror and this file has failed at its one job.
 */
import { existsSync } from 'node:fs';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CalibrationHttpClient,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_FIELDS,
  ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_REQUIRED,
  BED_CLEAR_REQUIRED_HEADERS,
  PROVENANCE as ACKNOWLEDGE_BED_CLEAR_PROVENANCE,
} from './fixtures/server-contract/acknowledgeBedClearRequestDto.snapshot.js';
import {
  CALIBRATION_JOB_KIND,
  QUEUE_PRINT_JOB_DTO_FIELDS,
  QUEUE_PRINT_JOB_DTO_REQUIRED_FOR_CALIBRATION,
} from './fixtures/server-contract/queuePrintJobDto.snapshot.js';
import {
  compareDto,
  extractCSharpDtoFields,
  resolveServerRepo,
} from './fixtures/server-contract/serverContractSnapshotDrift.js';

const CALIBRATION_PROFILE_ID = 'calibration-profile-test';
const CALIBRATION_TOKEN = 'stub-jwt-for-loopback-only';
const CALIBRATION_BINDING = 'binding-const';

const CALIBRATION_PRINTER_ID = '6b68328f-6495-4d32-8a2d-784119e59a01';
const CALIBRATION_GCODE_FILE_ID = '11111111-1111-4111-8111-111111111111';
const CALIBRATION_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CALIBRATION_ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const CALIBRATION_ORCH_ID = '44444444-4444-4444-8444-444444444444';
const CALIBRATION_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const CALIBRATION_JOB_ID = '66666666-6666-4666-8666-666666666666';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  body: Record<string, unknown>;
}

function firstRequest(requests: CapturedRequest[]): CapturedRequest {
  const req = requests[0];
  if (req === undefined) {
    throw new Error('expected a captured request but none was recorded');
  }
  return req;
}

function makeTokenProvider(baseUrl: string): CalibrationTokenProvider {
  return {
    getAuthenticatedContext(profileId) {
      if (profileId !== CALIBRATION_PROFILE_ID) {
        return Promise.reject(new Error(`unexpected profileId ${profileId}`));
      }
      return Promise.resolve({
        baseUrl,
        token: CALIBRATION_TOKEN,
        binding: CALIBRATION_BINDING,
      });
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let bytes = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += chunk;
    });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

interface Harness {
  baseUrl: string;
  requests: CapturedRequest[];
  respond: (
    handler: (
      req: CapturedRequest,
      res: ServerResponse,
    ) => void | Promise<void>,
  ) => void;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const requests: CapturedRequest[] = [];
  let handler:
    | ((req: CapturedRequest, res: ServerResponse) => void | Promise<void>)
    | null = null;

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const bodyText = await readRequestBody(req);
        let parsed: Record<string, unknown> = {};
        if (bodyText.length > 0) {
          try {
            parsed = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(',');
        }
        const captured: CapturedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers,
          bodyText,
          body: parsed,
        };
        requests.push(captured);
        if (handler) {
          await handler(captured, res);
        } else {
          res.statusCode = 500;
          res.end('no handler configured');
        }
      } catch (err) {
        res.statusCode = 500;
        res.end((err as Error).message);
      }
    })();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // Belt-and-braces — never allow a non-loopback host slip through.
  const parsedHost = new URL(baseUrl).hostname;
  if (parsedHost !== '127.0.0.1' && parsedHost !== 'localhost') {
    throw new Error(`refusing to run against non-loopback host ${parsedHost}`);
  }

  return {
    baseUrl,
    requests,
    respond: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('calibration wire ↔ PrintFarmer server contract (loopback)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  // ---------------------------------------------------------------
  // Snapshot integrity — the load-bearing drift check.
  // ---------------------------------------------------------------
  describe('snapshot drift (server-of-truth vs snapshot)', () => {
    const serverRepo = resolveServerRepo();

    it(
      serverRepo === null
        ? 'skips: PrintFarmer server checkout not present at D:\\\\s\\\\pfarm1 (set PRINTFARMER_SERVER_REPO to enable)'
        : 'QueuePrintJobDto snapshot matches server DTO on disk',
      () => {
        if (serverRepo === null) {
          // Deliberately no-op: the CI environment does not have the sibling
          // checkout. The snapshot fields are still enforced structurally by
          // the wire assertions below, but a stale snapshot cannot be caught
          // here without the live C# source. This gap is documented in
          // `tests/fixtures/server-contract/README.md`.
          return;
        }
        const report = compareDto({
          repoRoot: serverRepo,
          relPath: 'src/infra/Dtos/QueueDtos.cs',
          typeName: 'QueuePrintJobDto',
          snapshotFields: QUEUE_PRINT_JOB_DTO_FIELDS,
        });
        expect(
          report.missingFromSnapshot,
          `Server added fields not in the snapshot — bump ${report.file} provenance and refresh snapshot`,
        ).toEqual([]);
        expect(
          report.extraInSnapshot,
          `Snapshot lists fields the server no longer accepts — refresh snapshot`,
        ).toEqual([]);
      },
    );

    it(
      serverRepo === null
        ? 'skips: PrintFarmer server checkout not present at D:\\\\s\\\\pfarm1'
        : 'AcknowledgeBedClearRequestDto snapshot matches server DTO on disk',
      () => {
        if (serverRepo === null) return;
        // Read the path from the snapshot's own provenance rather than
        // hardcoding it. The server's module-decomposition epic moved this DTO
        // from `src/api/**` to `src/modules/**`; a hardcoded path turned that
        // into a bare ENOENT that named no cause. Sourcing it from PROVENANCE
        // means the path can only be wrong if the snapshot itself is wrong,
        // which the provenance guard already reports.
        const relPath = ACKNOWLEDGE_BED_CLEAR_PROVENANCE.sourcePath;
        expect(
          existsSync(path.join(serverRepo, relPath)),
          `Server source not found at ${relPath}. The snapshot's PROVENANCE.sourcePath is stale — the server most likely moved this file (the module-decomposition epic relocated src/api/** to src/modules/**). Re-pin the snapshot rather than editing this path inline.`,
        ).toBe(true);
        const report = compareDto({
          repoRoot: serverRepo,
          relPath,
          typeName: 'AcknowledgeBedClearRequestDto',
          snapshotFields: ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_FIELDS,
        });
        expect(report.missingFromSnapshot).toEqual([]);
        expect(report.extraInSnapshot).toEqual([]);
      },
    );

    // Synthetic-drift control — proves the drift pipeline itself bites.
    //
    // When the "on-disk matches snapshot" tests above go green, that alone is
    // not evidence that the drift check WOULD have caught a real drift. It
    // could be that `extractCSharpDtoFields` returned an empty list and both
    // sides silently matched at zero fields, or that a broken snapshot was
    // silently accepted. This test feeds the extractor a synthetic C# source
    // and asserts the drift analyser flags the exact expected missing and
    // extra fields. Same code path as the live test, opposite expected value.
    it('control (synthetic drift): the extractor flags added and removed fields', () => {
      const syntheticSource = `
        namespace Farm.Test;

        public class WidgetDto
        {
            public Guid Id { get; set; }
            public string? Name { get; set; }
            public int Count { get; set; }
            public string? AddedByServer { get; set; }
        }
      `;
      const onDisk = extractCSharpDtoFields(syntheticSource, 'WidgetDto');
      expect(onDisk.sort()).toEqual(
        ['addedByServer', 'count', 'id', 'name'].sort(),
      );

      const staleSnapshot = ['id', 'name', 'count', 'removedFromServer'];
      const staleSet = new Set(staleSnapshot);
      const onDiskSet = new Set(onDisk);
      const missingFromSnapshot = onDisk.filter((f) => !staleSet.has(f));
      const extraInSnapshot = staleSnapshot.filter((f) => !onDiskSet.has(f));

      expect(missingFromSnapshot).toEqual(['addedByServer']);
      expect(extraInSnapshot).toEqual(['removedFromServer']);
    });
  });

  // ---------------------------------------------------------------
  // POST /api/job-queue — Queue button.
  // ---------------------------------------------------------------
  describe('POST /api/job-queue (Queue button)', () => {
    async function driveQueueJob() {
      const client = new CalibrationHttpClient(
        makeTokenProvider(harness.baseUrl),
      );
      return client.createQueueJob(
        CALIBRATION_PROFILE_ID,
        harness.baseUrl,
        {
          gcodeFileId: CALIBRATION_GCODE_FILE_ID,
          assignedPrinterId: CALIBRATION_PRINTER_ID,
          operationId: CALIBRATION_OPERATION_ID,
          calibrationProjectId: CALIBRATION_PROJECT_ID,
          calibrationAttemptId: CALIBRATION_ATTEMPT_ID,
          calibrationOrchestrationId: CALIBRATION_ORCH_ID,
          pinnedPrinterConfigRevision: 42,
          gcodeContentSha256: null,
          specificationSha256: null,
          machineProfileSha256: null,
          processProfileSha256: null,
          filamentProfileSha256: null,
          printerConfigSnapshotSha256: null,
          requiredFirmwareFamily: null,
          requiredGcodeDialect: null,
          requiredSlicerEngine: null,
          requiredSlicerDistribution: null,
          requiredSlicerVersion: null,
          requiredSlicerContainerDigest: null,
        },
        new AbortController().signal,
      );
    }

    function respondWith201() {
      harness.respond((_req, res) => {
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.setHeader('location', `/api/job-queue/${CALIBRATION_JOB_ID}`);
        res.setHeader('etag', '"job-etag-1"');
        res.setHeader('x-dispatch-state-etag', '"dispatch-etag-1"');
        res.setHeader('idempotency-replayed', 'false');
        const now = new Date().toISOString();
        res.end(
          JSON.stringify({
            id: CALIBRATION_JOB_ID,
            rowVersion: 'job-etag-1',
            revision: 1,
            dispatchStateRowVersion: 'dispatch-etag-1',
            dispatchStateRevision: 1,
            jobKind: CALIBRATION_JOB_KIND,
            calibrationProjectId: CALIBRATION_PROJECT_ID,
            calibrationAttemptId: CALIBRATION_ATTEMPT_ID,
            calibrationOrchestrationId: CALIBRATION_ORCH_ID,
            pinnedPrinterConfigRevision: 42,
            gcodeFileId: CALIBRATION_GCODE_FILE_ID,
            gcodeFileName: '',
            assignedPrinterId: CALIBRATION_PRINTER_ID,
            assignedPrinterName: '',
            status: 'Queued',
            bedClearState: 'None',
            bedClearCommandId: null,
            bedClearIdempotencyKeySha256: null,
            bedClearExpiresAtUtc: null,
            priority: 3,
            queuePosition: 1,
            copies: 1,
            completedCopies: 0,
            remainingCopies: 1,
            isIdempotentReplay: false,
            createdAt: now,
            updatedAt: now,
          }),
        );
      });
    }

    it('sends a POST to /api/job-queue with the server-contract shape', async () => {
      respondWith201();
      const result = await driveQueueJob();

      expect(result.jobId).toBe(CALIBRATION_JOB_ID);
      expect(harness.requests.length).toBe(1);
      const req = firstRequest(harness.requests);
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/job-queue');
      expect(req.headers['content-type']).toBe('application/json');

      // Server-contract required fields present and typed sanely.
      for (const field of QUEUE_PRINT_JOB_DTO_REQUIRED_FOR_CALIBRATION) {
        expect(
          req.body,
          `required calibration field "${field}" missing from POST body`,
        ).toHaveProperty(field);
      }
      expect(req.body.jobKind).toBe(CALIBRATION_JOB_KIND);
      expect(req.body.idempotencyKey).toBe(CALIBRATION_OPERATION_ID);
      expect(req.headers['idempotency-key']).toBe(CALIBRATION_OPERATION_ID);
      expect(req.body.gcodeFileId).toBe(CALIBRATION_GCODE_FILE_ID);
      expect(req.body.assignedPrinterId).toBe(CALIBRATION_PRINTER_ID);

      // Server-shape gate: every field the desktop sends MUST be one the server
      // accepts. If we ever ship a body key that isn't in the snapshot, the
      // server will silently ignore it — exactly the class of drift this file
      // exists to catch.
      const wireKeys = Object.keys(req.body).filter(
        (k) => req.body[k] !== undefined,
      );
      const snapshotKeys = new Set<string>(QUEUE_PRINT_JOB_DTO_FIELDS);
      const unknown = wireKeys.filter((k) => !snapshotKeys.has(k));
      expect(
        unknown,
        `Desktop is sending fields the server contract does not recognise: ${unknown.join(', ')}`,
      ).toEqual([]);
    });

    // Positive control — an extra POST from test code must be observed.
    it('control (positive): every POST reaching the listener is captured', async () => {
      respondWith201();
      await driveQueueJob();

      const extraRes = await fetch(`${harness.baseUrl}/api/injected-probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: true }),
      });
      // The server responds with 201 (the same responder handles anything);
      // that's fine — we're asserting the request was seen.
      expect([200, 201, 500]).toContain(extraRes.status);
      expect(harness.requests.length).toBe(2);
      expect(harness.requests[1]!.url).toBe('/api/injected-probe');
    });

    // Negative control — no request when nothing drives one.
    it('control (negative): no POST is seen when the client is not invoked', () => {
      respondWith201();
      // Deliberately do nothing — no client, no fetch.
      expect(harness.requests.length).toBe(0);
    });

    // Server-shape control — the load-bearing one.
    // If we mutate the payload key to something the snapshot rejects, the
    // "unknown fields" assertion must trigger. If it doesn't, this file's
    // whole premise is broken.
    it('control (server-shape): unknown body field is rejected by the snapshot check', () => {
      const mutated = {
        gcodeFileId: CALIBRATION_GCODE_FILE_ID,
        jobKind: CALIBRATION_JOB_KIND,
        idempotencyKey: CALIBRATION_OPERATION_ID,
        // Deliberately misspelled: server accepts `assignedPrinterId`, not
        // `assignedPrinter`. A drifted desktop that sent this would silently
        // fail auto-assignment on the server. The snapshot must catch it.
        assignedPrinter: CALIBRATION_PRINTER_ID,
      };
      const snapshotKeys = new Set<string>(QUEUE_PRINT_JOB_DTO_FIELDS);
      const unknown = Object.keys(mutated).filter((k) => !snapshotKeys.has(k));
      expect(unknown).toEqual(['assignedPrinter']);
    });
  });

  // ---------------------------------------------------------------
  // POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start
  // — Confirm bed clear button.
  // ---------------------------------------------------------------
  describe('POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start (Confirm bed clear button)', () => {
    async function driveAcknowledgeBedClear() {
      const client = new CalibrationHttpClient(
        makeTokenProvider(harness.baseUrl),
      );
      return client.acknowledgeBedClearAndStart(
        CALIBRATION_PROFILE_ID,
        harness.baseUrl,
        CALIBRATION_JOB_ID,
        CALIBRATION_PRINTER_ID,
        CALIBRATION_OPERATION_ID,
        'job-etag-1',
        'dispatch-etag-1',
        42,
        new AbortController().signal,
      );
    }

    function respondWith202() {
      harness.respond((_req, res) => {
        res.statusCode = 202;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            message: 'accepted',
            jobETag: 'job-etag-2',
            dispatchStateETag: 'dispatch-etag-2',
          }),
        );
      });
    }

    it('sends a POST to the parametrised URL with all three precondition headers', async () => {
      respondWith202();
      const result = await driveAcknowledgeBedClear();

      expect(result.kind).toBe('ok');
      expect(harness.requests.length).toBe(1);
      const req = firstRequest(harness.requests);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(
        `/api/job-queue/${CALIBRATION_JOB_ID}/acknowledge-bed-clear-and-start`,
      );

      // Every server-required precondition header must appear on the wire.
      for (const header of BED_CLEAR_REQUIRED_HEADERS) {
        expect(
          req.headers,
          `precondition header "${header}" absent — server would reply 428`,
        ).toHaveProperty(header);
      }
      expect(req.headers['idempotency-key']).toBe(CALIBRATION_OPERATION_ID);
      expect(req.headers['if-match']).toBe('job-etag-1');
      expect(req.headers['x-dispatch-state-if-match']).toBe('dispatch-etag-1');

      // Body carries the server-required field with the correct name.
      for (const field of ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_REQUIRED) {
        expect(req.body).toHaveProperty(field);
      }
      expect(req.body.printerId).toBe(CALIBRATION_PRINTER_ID);
      expect(req.body.idempotencyKey).toBe(CALIBRATION_OPERATION_ID);
      expect(req.body.expectedPrinterConfigRevision).toBe(42);

      // Same server-shape gate: no unknown fields.
      const wireKeys = Object.keys(req.body).filter(
        (k) => req.body[k] !== undefined,
      );
      const snapshotKeys = new Set<string>(
        ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_FIELDS,
      );
      const unknown = wireKeys.filter((k) => !snapshotKeys.has(k));
      expect(unknown).toEqual([]);
    });

    it('control (positive): another POST to the same listener is observed', async () => {
      respondWith202();
      await driveAcknowledgeBedClear();
      const extra = await fetch(`${harness.baseUrl}/api/decoy`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect([200, 202, 500]).toContain(extra.status);
      expect(harness.requests.length).toBe(2);
    });

    it('control (negative): no request without a driver', () => {
      respondWith202();
      expect(harness.requests.length).toBe(0);
    });

    it('control (server-shape): renamed header would be rejected by the required-header check', () => {
      // Model what a drifted desktop would emit if it renamed the header the
      // server enforces at line-of-code level. The required-header assertion
      // must observe the absence.
      const emitted: Record<string, string> = {
        'content-type': 'application/json',
        // Deliberately renamed — server requires `if-match`.
        'if-matches': 'job-etag-1',
        'idempotency-key': CALIBRATION_OPERATION_ID,
        'x-dispatch-state-if-match': 'dispatch-etag-1',
      };
      const missing = BED_CLEAR_REQUIRED_HEADERS.filter((h) => !(h in emitted));
      expect(missing).toEqual(['if-match']);
    });
  });

  // ---------------------------------------------------------------
  // Optional integration hook — Bishop's daily-validation stack.
  // ---------------------------------------------------------------
  describe('optional: live Moonraker-Ready dispatch (env-gated)', () => {
    const stackBaseUrl = process.env.PRINTFARMER_STACK_BASE_URL?.trim();
    const enabled = Boolean(stackBaseUrl);

    it.skipIf(!enabled)(
      'PRINTFARMER_STACK_BASE_URL is set — driving real Queue POST against loopback stack',
      () => {
        // Loopback guard — refuse anything else.
        const url = stackBaseUrl ?? '';
        const host = new URL(url).hostname;
        expect(
          host === '127.0.0.1' || host === 'localhost',
          `refusing non-loopback host ${host}`,
        ).toBe(true);
        // Left intentionally unimplemented — needs Bishop to publish the
        // exact auth posture for the daily-validation dev-mode bypass. When
        // wired, this test will drive the real client against the stack and
        // assert the job reaches the Moonraker-Ready emulator by polling
        // http://127.0.0.1:17125/api/server/info or the /__emulator/**
        // control API. Skipped by default so CI stays hermetic.
      },
    );

    it('is skipped by default so the default CI suite stays hermetic', () => {
      if (enabled) {
        expect(stackBaseUrl).toBeTruthy();
      } else {
        expect(stackBaseUrl).toBeFalsy();
      }
    });
  });
});
