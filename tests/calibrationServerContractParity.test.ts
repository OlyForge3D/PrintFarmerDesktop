// @vitest-environment node

/**
 * Server contract parity guard — issue #138.
 *
 * Side A: `docs/printer-calibration-admin-guide.md` §10 is the maintained
 * documentation surface.
 *
 * Side B: exported production constants and behavior:
 *   - `CALIBRATION_QUEUE_ROUTE_TEMPLATES` (calibrationHttp.ts) — consumed by
 *     the HTTP client; tested via fetch mocks to verify exact URL match.
 *   - `BED_CLEAR_PRECONDITION_HEADER_NAMES` (calibrationHttp.ts) — used to
 *     build headers in `acknowledgeBedClearAndStart`; tested via fetch mock.
 *   - `QUEUE_EVENT_SCHEMA_VERSION_CURRENT`, `PRINTER_GROUP_REDACTED_FIELDS`
 *     (calibrationWire.ts) — compared against §10.5/10.5.2 doc text.
 *   - `detectQueueChangeFeedGap` (ipc.ts) — exercised for contiguous,
 *     cursor-gap, and internal-gap scenarios.
 *
 * Both sides are asserted non-empty. Missing and unexpected values are
 * reported symmetrically. No test-local policy tables duplicate the
 * production constants.
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
  QUEUE_EVENT_SCHEMA_VERSION_CURRENT,
  PRINTER_GROUP_REDACTED_FIELDS,
  RemoteCalibrationOrchestrationStatus,
} from '../src/main/calibrationWire.js';
import { detectQueueChangeFeedGap } from '../src/main/ipc.js';

// ─── Side A: parse the maintained admin guide §10 ────────────────────────────

const GUIDE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'docs',
  'printer-calibration-admin-guide.md',
);
const guideText = readFileSync(GUIDE_PATH, 'utf8');

function extractSection(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + 5);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

function extractSubSection(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  if (start === -1) return '';
  const next = text.indexOf('\n### ', start + 5);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/** Route templates from §10.1 table rows (lines starting with `|`). */
function extractDocRouteTemplates(text: string): string[] {
  const results: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`(\/api\/[^`]+)`/g)) {
      results.push(m[1]!);
    }
  }
  return [...new Set(results)];
}

/** Header names from §10.3 table rows only (hyphenated, no slashes). */
function extractDocBedClearHeaders(text: string): string[] {
  const results: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9-]+[A-Za-z0-9])`/g)) {
      const h = m[1]!;
      if (h.includes('-') && !h.includes('/') && !h.includes('.')) {
        results.push(h.toLowerCase());
      }
    }
  }
  return [...new Set(results)];
}

/** Field names from §10.5 nulled-field list (before "forces eventType"). */
function extractDocRedactedFields(text: string): string[] {
  // Only extract from the "nulls X, Y, Z" segment, not the "forces eventType" clause
  const nullsIdx = text.indexOf('which nulls');
  const forcesIdx = text.indexOf('forces `eventType`');
  if (nullsIdx === -1) return [];
  const nullsSegment =
    forcesIdx === -1 ? text.slice(nullsIdx) : text.slice(nullsIdx, forcesIdx);
  const results: string[] = [];
  for (const m of nullsSegment.matchAll(/`([a-z][A-Za-z]+)`/g)) {
    const id = m[1]!;
    if (id.length > 2 && /[A-Z]/.test(id)) results.push(id);
  }
  return [...new Set(results)];
}

const sec10 = extractSection(
  guideText,
  '## 10. PrintFarmer server REST contract',
);
const sec101 = extractSubSection(sec10, '### 10.1');
const sec103 = extractSubSection(sec10, '### 10.3');
const sec105 = extractSubSection(sec10, '### 10.5 ');
const sec1052 = extractSubSection(sec10, '### 10.5.2');

const docRouteTemplates = extractDocRouteTemplates(sec101);
const docBedClearHeaders = extractDocBedClearHeaders(sec103);
const docRedactedFields = extractDocRedactedFields(sec105);

// ─── Shared helpers ───────────────────────────────────────────────────────────

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'http://farm.local';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const PRINTER_ID = '55555555-5555-4555-8555-555555555555';
const OP_ID = '66666666-6666-4666-8666-666666666666';

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockTokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'tok',
      binding: 'b',
    }),
  };
}

function makeClient(fetch: typeof globalThis.fetch) {
  return new CalibrationHttpClient(mockTokens(), {
    fetch,
    timeoutMs: 5000,
    sleep: () => Promise.resolve(),
  });
}

/** Replace concrete IDs with {param} placeholders for exact template matching. */
function normalizeUrl(url: string): string {
  return url
    .replace(BASE_URL, '')
    .split(encodeURIComponent(PROJECT_ID))
    .join('{projectId}')
    .split(encodeURIComponent(ATTEMPT_ID))
    .join('{attemptId}')
    .split(encodeURIComponent(JOB_ID))
    .join('{jobId}');
}

const QUEUE_JOB = {
  id: JOB_ID,
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
  assignedPrinterId: PRINTER_ID,
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
  projectId: PROJECT_ID,
  attemptId: ATTEMPT_ID,
  operationId: OP_ID,
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. Both sides non-vacuous
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — non-vacuous (issue #138)', () => {
  it('§10 exists and §10.1 table has at least 4 route templates', () => {
    expect(sec10.length, '§10 not found').toBeGreaterThan(200);
    expect(
      docRouteTemplates.length,
      `§10.1 table has ${docRouteTemplates.length} routes: [${docRouteTemplates.join(', ')}].`,
    ).toBeGreaterThanOrEqual(4);
  });

  it('production CALIBRATION_QUEUE_ROUTE_TEMPLATES has exactly 4 entries', () => {
    const keys = Object.keys(CALIBRATION_QUEUE_ROUTE_TEMPLATES);
    expect(keys.length, 'production route templates must have 4 entries').toBe(
      4,
    );
  });

  it('§10.3 table has exactly 3 precondition headers; production constant matches', () => {
    expect(
      docBedClearHeaders.length,
      `§10.3 has ${docBedClearHeaders.length} headers`,
    ).toBe(3);
    expect(BED_CLEAR_PRECONDITION_HEADER_NAMES.length).toBe(3);
  });

  it('§10.5 documents at least 10 redacted fields; production constant non-empty', () => {
    expect(
      docRedactedFields.length,
      `§10.5 yields ${docRedactedFields.length} camelCase field names`,
    ).toBeGreaterThanOrEqual(10);
    expect(PRINTER_GROUP_REDACTED_FIELDS.length).toBeGreaterThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Route templates: doc vs production (symmetric, exact, dead-route check)
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — route templates (issue #138)', () => {
  const prodTemplates = new Set<string>(
    Object.values(CALIBRATION_QUEUE_ROUTE_TEMPLATES),
  );

  it('production route templates and §10.1 documented routes match exactly', () => {
    const docSet = new Set(docRouteTemplates);
    const missing = [...prodTemplates].filter((t) => !docSet.has(t));
    const unexpected = [...docSet].filter((t) => !prodTemplates.has(t));
    expect(
      missing,
      `Production routes not documented in §10.1: ${JSON.stringify(missing)}`,
    ).toHaveLength(0);
    expect(
      unexpected,
      `§10.1 routes not in production: ${JSON.stringify(unexpected)}`,
    ).toHaveLength(0);
  });

  it('dead project-scoped queue/generation routes are absent from production', () => {
    const dead = [
      '/api/calibration-projects/{id}/queue',
      '/api/calibration-projects/{id}/generation',
    ];
    for (const d of dead) {
      expect(prodTemplates.has(d), `Dead route ${d} found in production`).toBe(
        false,
      );
    }
  });

  it('production /start route is absent (no /start route in exported templates)', () => {
    // BED_CLEAR_PRECONDITION_HEADER_NAMES and CALIBRATION_QUEUE_ROUTE_TEMPLATES
    // are exported constants that the HTTP client uses. Neither contains /start.
    const allRouteValues = Object.values(
      CALIBRATION_QUEUE_ROUTE_TEMPLATES,
    ) as string[];
    const hasStart = allRouteValues.some((r) => r.includes('/start'));
    expect(
      hasStart,
      'A /start route was found in CALIBRATION_QUEUE_ROUTE_TEMPLATES',
    ).toBe(false);
    // Non-vacuous: we must have at least one route in the list to prove absence is meaningful
    expect(allRouteValues.length).toBeGreaterThan(0);
  });

  it('createQueueJob calls the exact documented /api/job-queue URL', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(QUEUE_JOB, 201));
    const client = makeClient(fetch);
    await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OP_ID,
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
    const [u] = fetch.mock.calls[0] as [URL | string];
    const called = (typeof u === 'string' ? u : u.href).replace(BASE_URL, '');
    expect(called).toBe(CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueue);
  });

  it('getQueueJob calls the exact documented /api/job-queue/{jobId} URL', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(QUEUE_JOB));
    const client = makeClient(fetch);
    await client.getQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    const [u] = fetch.mock.calls[0] as [URL | string];
    const normalized = normalizeUrl(typeof u === 'string' ? u : u.href);
    expect(normalized).toBe(CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueueJob);
  });

  it('startGeneration calls the exact documented per-attempt URL with both projectId and attemptId', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(ORCH));
    const client = makeClient(fetch);
    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      'temperature',
      '1.0',
      undefined,
      OP_ID,
      null,
      AbortSignal.timeout(5000),
    );
    const [u] = fetch.mock.calls[0] as [URL | string];
    const normalized = normalizeUrl(typeof u === 'string' ? u : u.href);
    expect(normalized).toBe(CALIBRATION_QUEUE_ROUTE_TEMPLATES.generateJob);
  });

  it('acknowledgeBedClearAndStart calls the exact documented acknowledge URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ok({ message: 'ok', jobETag: 'C==', dispatchStateETag: 'D==' }, 202),
      );
    const client = makeClient(fetch);
    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OP_ID,
      'A==',
      'B==',
      null,
      AbortSignal.timeout(5000),
    );
    const [u] = fetch.mock.calls[0] as [URL | string];
    const normalized = normalizeUrl(typeof u === 'string' ? u : u.href);
    expect(normalized).toBe(
      CALIBRATION_QUEUE_ROUTE_TEMPLATES.acknowledgeBedClear,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Bed-clear headers: production constant vs §10.3 (symmetric, with control)
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — bed-clear precondition headers (issue #138)', () => {
  it('§10.3 documented headers and production BED_CLEAR_PRECONDITION_HEADER_NAMES match exactly', () => {
    const docSet = new Set(docBedClearHeaders);
    const prodSet = new Set<string>(BED_CLEAR_PRECONDITION_HEADER_NAMES);
    const missing = [...prodSet].filter((h) => !docSet.has(h));
    const unexpected = [...docSet].filter((h) => !prodSet.has(h));
    expect(
      missing,
      `Production headers missing from §10.3: ${JSON.stringify(missing)}`,
    ).toHaveLength(0);
    expect(
      unexpected,
      `§10.3 headers not in production: ${JSON.stringify(unexpected)}`,
    ).toHaveLength(0);
  });

  it('unrelated transport headers are not in the precondition set (control)', () => {
    // Comparison uses BED_CLEAR_PRECONDITION_HEADER_NAMES, not all request headers.
    // A future traceparent, x-correlation-id, etc. cannot enter the precondition check.
    const prodSet = new Set<string>(BED_CLEAR_PRECONDITION_HEADER_NAMES);
    expect(prodSet.has('traceparent')).toBe(false);
    expect(prodSet.has('x-correlation-id')).toBe(false);
    expect(prodSet.has('x-request-id')).toBe(false);
  });

  it('acknowledgeBedClearAndStart sends every production precondition header (fetch mock)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ok({ message: 'ok', jobETag: 'C==', dispatchStateETag: 'D==' }, 202),
      );
    const client = makeClient(fetch);
    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OP_ID,
      'AAAA==',
      'BBBB==',
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetch.mock.calls[0] as [URL | string, RequestInit];
    const sent = new Headers(init.headers);
    for (const h of BED_CLEAR_PRECONDITION_HEADER_NAMES) {
      expect(sent.has(h), `missing precondition header: ${h}`).toBe(true);
    }
  });

  it('opaque ETag values are forwarded byte-identical to If-Match and X-Dispatch-State-If-Match', async () => {
    const ROW = 'AAAAAAAAAAAA==';
    const DSP = 'BBBBBBBBBBBB==';
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ok({ message: 'ok', jobETag: 'C==', dispatchStateETag: 'D==' }, 202),
      );
    const client = makeClient(fetch);
    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OP_ID,
      ROW,
      DSP,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetch.mock.calls[0] as [URL | string, RequestInit];
    const sent = new Headers(init.headers);
    expect(sent.get('if-match')).toBe(ROW);
    expect(sent.get('x-dispatch-state-if-match')).toBe(DSP);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sequence gap detection: contiguous / cursor-gap / internal-gap
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — sequence gap detection (issue #138)', () => {
  it('detects no gap for a contiguous page starting immediately after cursor', () => {
    const events = [{ sequence: 11 }, { sequence: 12 }, { sequence: 13 }];
    expect(detectQueueChangeFeedGap(events, 10)).toBe(false);
  });

  it('detects cursor gap: first event does not immediately follow afterSequence', () => {
    const events = [{ sequence: 13 }, { sequence: 14 }];
    expect(detectQueueChangeFeedGap(events, 10)).toBe(true);
  });

  it('detects internal gap: non-contiguous sequence within page', () => {
    const events = [{ sequence: 11 }, { sequence: 12 }, { sequence: 15 }];
    expect(detectQueueChangeFeedGap(events, 10)).toBe(true);
  });

  it('handles empty event list without error (no gap)', () => {
    expect(detectQueueChangeFeedGap([], 42)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Schema version and redacted fields: doc vs production constants
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — schema version and redacted fields (issue #138)', () => {
  it('§10.5.2 mentions schema version "3" and production constant matches', () => {
    expect(sec1052.length, '§10.5.2 not found').toBeGreaterThan(50);
    expect(sec1052).toContain(`"${QUEUE_EVENT_SCHEMA_VERSION_CURRENT}"`);
  });

  it('§10.5 documented redacted-field set and PRINTER_GROUP_REDACTED_FIELDS match symmetrically', () => {
    const prodSet = new Set<string>(PRINTER_GROUP_REDACTED_FIELDS);
    const docSet = new Set(docRedactedFields);
    const missing = [...prodSet].filter((f) => !docSet.has(f));
    const unexpected = [...docSet].filter((f) => !prodSet.has(f));
    expect(
      missing,
      `Production redacted fields not in §10.5 prose: ${JSON.stringify(missing)}`,
    ).toHaveLength(0);
    expect(
      unexpected,
      `§10.5 prose fields not in production PRINTER_GROUP_REDACTED_FIELDS: ${JSON.stringify(unexpected)}`,
    ).toHaveLength(0);
  });

  it('orchestration schema accepts real step constants and unknown future values', () => {
    const base = { ...ORCH };
    expect(RemoteCalibrationOrchestrationStatus.safeParse(base).success).toBe(
      true,
    );
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
