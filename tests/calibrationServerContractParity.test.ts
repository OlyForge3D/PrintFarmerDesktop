// @vitest-environment node

/**
 * Server contract parity guard — issue #138.
 *
 * Side A — docs: `docs/printer-calibration-admin-guide.md` §10 sections
 * parsed for route templates, bed-clear header names, and attestations.
 *
 * Side B — production seams consumed by the desktop runtime:
 *   • CALIBRATION_QUEUE_ROUTE_TEMPLATES: single source that ROUTES derives
 *     from; mutating a template changes the executable HTTP call path.
 *   • BED_CLEAR_PRECONDITION_HEADER_NAMES: used by acknowledgeBedClearAndStart
 *     to build its request headers; fetch mocks verify values.
 *   • isJobScopedEnvelope: used by CalibrationQueueDispatchPanel to skip
 *     printer-group envelopes; tested for null-jobId exclusion.
 *   • detectQueueChangeFeedGap: replaces the former inline IPC loop;
 *     tested for cursor-gap, internal-gap, and contiguous cases.
 *
 * Schema version "3" is cited from source docs (both commits); the schema uses
 * z.string() for forward compatibility — no separate production constant.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CALIBRATION_QUEUE_ROUTE_TEMPLATES,
  BED_CLEAR_PRECONDITION_HEADER_NAMES,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  isJobScopedEnvelope,
  type CalibrationQueueEventEnvelope,
} from '../src/shared/ipc.js';
import { RemoteCalibrationOrchestrationStatus } from '../src/main/calibrationWire.js';
import { detectQueueChangeFeedGap } from '../src/main/ipc.js';

// ─── Side A: parse §10 from the maintained admin guide ───────────────────────

const GUIDE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'docs',
  'printer-calibration-admin-guide.md',
);
const guide = readFileSync(GUIDE_PATH, 'utf8');

function section(heading: string): string {
  const start = guide.indexOf(`\n${heading}`);
  if (start === -1) return '';
  const next = guide.indexOf('\n## ', start + 5);
  return next === -1 ? guide.slice(start) : guide.slice(start, next);
}
function subsection(within: string, heading: string): string {
  const start = within.indexOf(`\n${heading}`);
  if (start === -1) return '';
  const next = within.indexOf('\n### ', start + 5);
  return next === -1 ? within.slice(start) : within.slice(start, next);
}

const sec10 = section('## 10. PrintFarmer server REST contract');
const sec101 = subsection(sec10, '### 10.1');
const sec103 = subsection(sec10, '### 10.3');

/** Route templates from §10.1 table rows. */
function docRoutes(text: string): string[] {
  const acc: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`(\/api\/[^`]+)`/g)) acc.push(m[1]!);
  }
  return [...new Set(acc)];
}

/** Precondition header names from §10.3 table rows (hyphenated identifiers). */
function docHeaders(text: string): string[] {
  const acc: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9-]+[A-Za-z0-9])`/g)) {
      const h = m[1]!;
      if (h.includes('-') && !h.includes('/') && !h.includes('.'))
        acc.push(h.toLowerCase());
    }
  }
  return [...new Set(acc)];
}

const documentedRoutes = docRoutes(sec101);
const documentedHeaders = docHeaders(sec103);

// ─── Shared helpers ───────────────────────────────────────────────────────────

const BASE = 'http://farm.local';
const PROFILE = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const PRINTER = '55555555-5555-4555-8555-555555555555';
const OP = '66666666-6666-4666-8666-666666666666';

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function tokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE,
      token: 'tok',
      binding: 'b',
    }),
  };
}
function client(fetch: typeof globalThis.fetch) {
  return new CalibrationHttpClient(tokens(), {
    fetch,
    timeoutMs: 5000,
    sleep: () => Promise.resolve(),
  });
}
function callUrl(mock: ReturnType<typeof vi.fn>): string {
  const [u] = mock.mock.calls[0] as [URL | string, RequestInit];
  return (typeof u === 'string' ? u : u.href).replace(BASE, '');
}
function callInit(mock: ReturnType<typeof vi.fn>): RequestInit {
  const [, init] = mock.mock.calls[0] as [URL | string, RequestInit];
  return init;
}
function normalize(url: string): string {
  return url
    .split(encodeURIComponent(PROJECT))
    .join('{projectId}')
    .split(encodeURIComponent(ATTEMPT))
    .join('{attemptId}')
    .split(encodeURIComponent(JOB))
    .join('{jobId}');
}

const QUEUE_JOB = {
  id: JOB,
  rowVersion: 'AA==',
  dispatchStateRowVersion: 'BB==',
  revision: 1,
  dispatchStateRevision: 1,
  dispatchResult: null,
  jobKind: 'FilamentCalibration',
  calibrationProjectId: null,
  calibrationAttemptId: null,
  pinnedPrinterConfigRevision: null,
  gcodeFileId: null,
  gcodeFileName: '',
  assignedPrinterId: PRINTER,
  assignedPrinterName: '',
  status: 'Queued',
  bedClearState: 'None',
  priority: 0,
  queuePosition: 0,
  copies: 1,
  completedCopies: 0,
  remainingCopies: 1,
  isIdempotentReplay: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const ORCH = {
  id: '77777777-7777-4777-8777-777777777777',
  projectId: PROJECT,
  attemptId: ATTEMPT,
  operationId: OP,
  status: 'Running',
  currentStep: 'submitting-slice-job',
  revision: 1,
  retryCount: 0,
  nextRetryAtUtc: null,
  stepStartedAtUtc: null,
  lastErrorCode: null,
  problems: [],
  model3DId: null,
  sliceJobId: null,
  workerId: null,
  sourceArtifactId: null,
  finalArtifactId: null,
  gcodeFileId: null,
  specificationSha256: null,
  planManifestSha256: null,
  gcodeSha256: null,
  manifestSha256: null,
  generatorVersion: null,
  slicerContainerDigest: null,
  slicerBinarySha256: null,
  statusRoute: '/api/calibration-orchestrations/77',
  createdAtUtc: '2025-01-01T00:00:00.000Z',
  updatedAtUtc: '2025-01-01T00:00:01.000Z',
  completedAtUtc: null,
};
const BED_OK = { message: 'ok', jobETag: 'C==', dispatchStateETag: 'D==' };

// ═══════════════════════════════════════════════════════════════════════════
// 1. Non-vacuous: both sides non-empty
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — non-vacuous (issue #138)', () => {
  it('§10.1 yields ≥4 documented route templates', () => {
    expect(sec10.length, '§10 not found').toBeGreaterThan(200);
    expect(
      documentedRoutes.length,
      `§10.1 has ${documentedRoutes.length} templates: [${documentedRoutes.join(', ')}]`,
    ).toBeGreaterThanOrEqual(4);
  });
  it('production CALIBRATION_QUEUE_ROUTE_TEMPLATES has exactly 4 entries', () => {
    expect(Object.keys(CALIBRATION_QUEUE_ROUTE_TEMPLATES).length).toBe(4);
  });
  it('§10.3 yields exactly 3 header names; production constant matches', () => {
    expect(
      documentedHeaders.length,
      `§10.3 has ${documentedHeaders.length}: [${documentedHeaders.join(', ')}]`,
    ).toBe(3);
    expect(BED_CLEAR_PRECONDITION_HEADER_NAMES.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Route templates: docs vs production (symmetric exact match, dead routes)
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — route templates (issue #138)', () => {
  const prodSet = new Set<string>(
    Object.values(CALIBRATION_QUEUE_ROUTE_TEMPLATES),
  );
  const docSet = new Set(documentedRoutes);

  it('production templates and §10.1 documented routes match exactly', () => {
    const missing = [...prodSet].filter((t) => !docSet.has(t));
    const unexpected = [...docSet].filter((t) => !prodSet.has(t));
    expect(
      missing,
      `production not in docs: ${JSON.stringify(missing)}`,
    ).toHaveLength(0);
    expect(
      unexpected,
      `docs not in production: ${JSON.stringify(unexpected)}`,
    ).toHaveLength(0);
  });

  it('dead project-scoped routes are absent from templates', () => {
    expect(prodSet.has('/api/calibration-projects/{id}/queue')).toBe(false);
    expect(prodSet.has('/api/calibration-projects/{id}/generation')).toBe(
      false,
    );
    // Broader: no template ends with /queue or /generation terminal segment
    const vals = [...prodSet];
    expect(vals.every((t) => !t.endsWith('/queue'))).toBe(true);
    expect(vals.every((t) => !/\/generation$/.test(t))).toBe(true);
  });

  it('/start is absent from production templates (no /start route in contract)', () => {
    const vals = Object.values(CALIBRATION_QUEUE_ROUTE_TEMPLATES) as string[];
    expect(vals.some((t) => t.includes('/start'))).toBe(false);
    expect(vals.length).toBeGreaterThan(0); // non-vacuous
  });

  it('createQueueJob calls exact documented template', async () => {
    const f = vi.fn().mockResolvedValue(ok(QUEUE_JOB, 201));
    await client(f).createQueueJob(
      PROFILE,
      BASE,
      {
        gcodeFileId: JOB,
        assignedPrinterId: PRINTER,
        operationId: OP,
        pinnedPrinterConfigRevision: null,
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
      AbortSignal.timeout(5000),
    );
    expect(callUrl(f)).toBe(CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueue);
  });

  it('getQueueJob calls exact documented template', async () => {
    const f = vi.fn().mockResolvedValue(ok(QUEUE_JOB));
    await client(f).getQueueJob(PROFILE, BASE, JOB, AbortSignal.timeout(5000));
    expect(normalize(callUrl(f))).toBe(
      CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueueJob,
    );
  });

  it('startGeneration calls exact documented per-attempt template (both projectId and attemptId)', async () => {
    const f = vi.fn().mockResolvedValue(ok(ORCH));
    await client(f).startGeneration(
      PROFILE,
      BASE,
      PROJECT,
      ATTEMPT,
      'temperature',
      '1.0',
      undefined,
      OP,
      null,
      AbortSignal.timeout(5000),
    );
    const normalized = normalize(callUrl(f));
    expect(normalized).toBe(CALIBRATION_QUEUE_ROUTE_TEMPLATES.generateJob);
    // Confirm both IDs are required and present
    expect(normalized).toContain('{projectId}');
    expect(normalized).toContain('{attemptId}');
  });

  it('acknowledgeBedClearAndStart calls exact documented template', async () => {
    const f = vi.fn().mockResolvedValue(ok(BED_OK, 202));
    await client(f).acknowledgeBedClearAndStart(
      PROFILE,
      BASE,
      JOB,
      PRINTER,
      OP,
      'A==',
      'B==',
      null,
      AbortSignal.timeout(5000),
    );
    expect(normalize(callUrl(f))).toBe(
      CALIBRATION_QUEUE_ROUTE_TEMPLATES.acknowledgeBedClear,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Bed-clear headers: docs vs production constant + request behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — bed-clear precondition headers (issue #138)', () => {
  it('§10.3 headers and BED_CLEAR_PRECONDITION_HEADER_NAMES match exactly', () => {
    const docSet = new Set(documentedHeaders);
    const prodSet = new Set<string>(BED_CLEAR_PRECONDITION_HEADER_NAMES);
    const missing = [...prodSet].filter((h) => !docSet.has(h));
    const unexpected = [...docSet].filter((h) => !prodSet.has(h));
    expect(
      missing,
      `production not in §10.3: ${JSON.stringify(missing)}`,
    ).toHaveLength(0);
    expect(
      unexpected,
      `§10.3 not in production: ${JSON.stringify(unexpected)}`,
    ).toHaveLength(0);
  });

  it('unrelated transport headers are not preconditions (control)', () => {
    const s = new Set<string>(BED_CLEAR_PRECONDITION_HEADER_NAMES);
    expect(s.has('traceparent')).toBe(false);
    expect(s.has('x-correlation-id')).toBe(false);
  });

  it('acknowledgeBedClearAndStart sends all precondition headers (fetch mock)', async () => {
    const f = vi.fn().mockResolvedValue(ok(BED_OK, 202));
    await client(f).acknowledgeBedClearAndStart(
      PROFILE,
      BASE,
      JOB,
      PRINTER,
      OP,
      'AAAA==',
      'BBBB==',
      null,
      AbortSignal.timeout(5000),
    );
    const sent = new Headers(callInit(f).headers);
    for (const h of BED_CLEAR_PRECONDITION_HEADER_NAMES) {
      expect(sent.has(h), `missing header: ${h}`).toBe(true);
    }
  });

  it('opaque ETag tokens are forwarded byte-identical to If-Match and X-Dispatch-State-If-Match', async () => {
    const f = vi.fn().mockResolvedValue(ok(BED_OK, 202));
    await client(f).acknowledgeBedClearAndStart(
      PROFILE,
      BASE,
      JOB,
      PRINTER,
      OP,
      'AAAAAAAAAAAA==',
      'BBBBBBBBBBBB==',
      null,
      AbortSignal.timeout(5000),
    );
    const sent = new Headers(callInit(f).headers);
    expect(sent.get('if-match')).toBe('AAAAAAAAAAAA==');
    expect(sent.get('x-dispatch-state-if-match')).toBe('BBBBBBBBBBBB==');
  });

  it('§10.3 body fallback: idempotencyKey is sent in request body (server Idempotency-Key fallback)', async () => {
    // Server reads: Request.Headers["Idempotency-Key"] ?? request.IdempotencyKey
    // PFD always sends both; the body provides the documented fallback.
    const f = vi.fn().mockResolvedValue(ok(BED_OK, 202));
    await client(f).acknowledgeBedClearAndStart(
      PROFILE,
      BASE,
      JOB,
      PRINTER,
      OP,
      'A==',
      'B==',
      null,
      AbortSignal.timeout(5000),
    );
    const body = JSON.parse(callInit(f).body as string) as {
      idempotencyKey?: string;
    };
    expect(body.idempotencyKey).toBe(OP);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Printer-group envelope filter (isJobScopedEnvelope — production seam)
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — printer-group envelope filter (issue #138)', () => {
  it('§10.5 documents Printer-{id} group redaction', () => {
    const sec105 = subsection(sec10, '### 10.5 ');
    expect(sec105).toContain('Printer-{printerId}');
    expect(sec105).toMatch(/REDACT/i);
  });

  it('isJobScopedEnvelope returns false for null jobId (redacted printer envelope)', () => {
    const evt = { jobId: null } as unknown as CalibrationQueueEventEnvelope;
    expect(isJobScopedEnvelope(evt, JOB)).toBe(false);
  });

  it('isJobScopedEnvelope returns false for a different-job envelope', () => {
    const otherJob = '99999999-9999-4999-8999-999999999999';
    expect(isJobScopedEnvelope({ jobId: otherJob }, JOB)).toBe(false);
  });

  it('isJobScopedEnvelope returns true only for an exact-match jobId', () => {
    expect(isJobScopedEnvelope({ jobId: JOB }, JOB)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Sequence gap detection (detectQueueChangeFeedGap — production seam)
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — sequence gap detection (issue #138)', () => {
  it('contiguous page starting immediately after cursor: no gap', () => {
    expect(
      detectQueueChangeFeedGap([{ sequence: 11 }, { sequence: 12 }], 10),
    ).toBe(false);
  });
  it('cursor gap: first event does not follow afterSequence + 1', () => {
    expect(detectQueueChangeFeedGap([{ sequence: 13 }], 10)).toBe(true);
  });
  it('internal gap: non-contiguous sequences within page', () => {
    expect(
      detectQueueChangeFeedGap([{ sequence: 11 }, { sequence: 13 }], 10),
    ).toBe(true);
  });
  it('empty page: no gap', () => {
    expect(detectQueueChangeFeedGap([], 42)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Schema version: source-cited doc vs z.string() forward-compat behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('parity — schema version and forward compatibility (issue #138)', () => {
  it('§10.5.2 documents schemaVersion "3" from authoritative source', () => {
    const sec1052 = subsection(sec10, '### 10.5.2');
    expect(sec1052.length, '§10.5.2 not found').toBeGreaterThan(50);
    // "3" is QueueEventSchemaVersions.Current at both 167a3b13 and 9c1d7e4b
    expect(sec1052).toContain('"3"');
  });

  it('RemoteCalibrationOrchestrationStatus accepts real current-step values and future ones', () => {
    // status is CalibrationOrchestrationStatus.ToString() — current values:
    // Pending, Running, WaitingToRetry, Completed, Failed, Cancelled
    const withRunning = { ...ORCH };
    expect(
      RemoteCalibrationOrchestrationStatus.safeParse(withRunning).success,
    ).toBe(true);
    // Forward compatibility: unrecognised values must not throw
    const future = {
      ...ORCH,
      status: 'FutureStatus',
      currentStep: 'future-step',
    };
    const result = RemoteCalibrationOrchestrationStatus.safeParse(future);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('FutureStatus');
      expect(result.data.currentStep).toBe('future-step');
    }
  });
});
