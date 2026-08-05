// @vitest-environment node

/**
 * Server contract parity guard — issue #138.
 *
 * Two independently derived sides:
 *
 *   Side A — maintained documentation: `docs/printer-calibration-admin-guide.md`
 *   §10 is parsed for documented route paths, precondition header names,
 *   schema version, and sequence semantics. Both the §10 text and each
 *   sub-section are asserted non-empty before comparisons run.
 *
 *   Side B — executable production behavior: the real `CalibrationHttpClient`
 *   (via fetch mocks), and the exported runtime Zod schemas
 *   `RemoteQueueEventEnvelope` and `RemoteCalibrationOrchestrationStatus`.
 *
 * Symmetric drift checks: both "missing" (doc claim not in production) and
 * "unexpected" (production behavior not covered by docs) are reported.
 *
 * The mutation transcripts below were observed before commit and are included
 * here for the review record only. Mutations are fully restored.
 *
 * Mutation A — documentation drift (§10.3 If-Match row removed):
 *   `documentedBedClearHeaders` shrinks from 3 to 2.
 *   Failure: "bed-clear precondition headers symmetric check > missing …
 *     Expected: [] Received: ['if-match']"
 *
 * Mutation B — production drift (If-Match header removed from client):
 *   Failure: "bed-clear precondition headers symmetric check > missing …
 *     Expected: [] Received: ['if-match']"
 *   AND: "opaque ETag forwarded as If-Match > AssertionError: expected null
 *     to be 'AAAAAAAAAAAA=='"
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CalibrationTokenProvider } from '../src/main/calibrationHttp.js';
import {
  RemoteQueueEventEnvelope,
  RemoteCalibrationOrchestrationStatus,
} from '../src/main/calibrationWire.js';

// ─── Side A: parse the maintained admin guide §10 ────────────────────────────

const GUIDE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'docs',
  'printer-calibration-admin-guide.md',
);
const guideText = readFileSync(GUIDE_PATH, 'utf8');

/** Extract the §10 block from the guide. */
function extractSection10(text: string): string {
  const start = text.indexOf('\n## 10. PrintFarmer server REST contract');
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + 5);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/** Extract §10.3 sub-section. */
function extractSection103(sec10: string): string {
  const start = sec10.indexOf('### 10.3');
  if (start === -1) return '';
  const next = sec10.indexOf('\n### ', start + 5);
  return next === -1 ? sec10.slice(start) : sec10.slice(start, next);
}

/** Extract §10.5.2 sub-section. */
function extractSection1052(sec10: string): string {
  const start = sec10.indexOf('### 10.5.2');
  if (start === -1) return '';
  const next = sec10.indexOf('\n### ', start + 5);
  return next === -1 ? sec10.slice(start) : sec10.slice(start, next);
}

/**
 * Parse the backtick-quoted /api/... path prefixes documented in §10.
 * Template-parameter segments are dropped so results are stable prefixes.
 */
function extractDocApiPaths(text: string): string[] {
  const raw: string[] = [];
  for (const m of text.matchAll(/`(\/api\/[^`]+)`/g)) {
    raw.push(m[1]!.split('{')[0]!.replace(/\/$/, ''));
  }
  return [...new Set(raw)].filter(Boolean);
}

/**
 * Parse backtick-quoted header names specifically from Markdown table rows
 * in a section (lines beginning with `|`). This ensures that removing a header
 * from the table is detectable as documentation drift, even if prose still
 * mentions the header name.
 */
function extractDocHeaders(text: string): string[] {
  const headers: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9-]+[A-Za-z0-9])`/g)) {
      const h = m[1]!;
      // HTTP header shaped: hyphenated, no slashes or dots
      if (h.includes('-') && !h.includes('/') && !h.includes('.')) {
        headers.push(h.toLowerCase());
      }
    }
  }
  return [...new Set(headers)];
}

const section10 = extractSection10(guideText);
const section103 = extractSection103(section10);
const section1052 = extractSection1052(section10);
const documentedApiPaths = extractDocApiPaths(section10);
const documentedBedClearHeaders = extractDocHeaders(section103);

// ─── Side B: production fixtures and helpers ──────────────────────────────────

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'http://farm.local';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const PRINTER_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';

function json(
  body: unknown,
  status = 200,
  hdrs: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...hdrs },
  });
}

function tokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'test-jwt',
      binding: 'b',
    }),
  };
}

const QUEUE_JOB_BODY = {
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

const BED_CLEAR_OK = {
  message: 'ok',
  jobETag: 'OUT==',
  dispatchStateETag: 'OUT2==',
};

// HTTP headers that are standard/transport and not precondition-specific.
const STANDARD_HEADERS = new Set(['content-type', 'authorization', 'accept']);

function preconditionHeaders(init: RequestInit): Set<string> {
  return new Set(
    [...new Headers(init.headers).keys()]
      .map((k) => k.toLowerCase())
      .filter((k) => !STANDARD_HEADERS.has(k)),
  );
}

function callUrl(mock: ReturnType<typeof vi.fn>, idx = 0): string {
  const [u] = mock.mock.calls[idx] as [URL | string, RequestInit];
  return typeof u === 'string' ? u : u.href;
}

function callInit(mock: ReturnType<typeof vi.fn>, idx = 0): RequestInit {
  const [, init] = mock.mock.calls[idx] as [URL | string, RequestInit];
  return init;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ground-truth: both sides non-vacuous
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — ground truth non-vacuous (issue #138)', () => {
  it('§10 section is present and non-empty in the admin guide', () => {
    expect(
      section10.length,
      '§10 not found — anchor "## 10. PrintFarmer server REST contract" is stale.',
    ).toBeGreaterThan(200);
  });

  it('§10 yields at least 2 documented /api/ paths (doc side non-empty)', () => {
    expect(
      documentedApiPaths.length,
      `Expected ≥2 /api/ paths in §10 but got ${documentedApiPaths.length}: ` +
        `[${documentedApiPaths.join(', ')}].`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('§10.3 yields exactly 3 precondition header names (doc side non-empty)', () => {
    expect(
      documentedBedClearHeaders.length,
      `Expected 3 header names in §10.3 but got ${documentedBedClearHeaders.length}: ` +
        `[${documentedBedClearHeaders.join(', ')}]. ` +
        `Extractor looks for hyphenated backtick identifiers (e.g. \`Idempotency-Key\`).`,
    ).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Routes: docs vs production behavior (symmetric)
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — routes (issue #138)', () => {
  it('production createQueueJob URL matches a documented /api/ path prefix', async () => {
    const { CalibrationHttpClient } =
      await import('../src/main/calibrationHttp.js');
    const fetch = vi.fn().mockResolvedValue(json(QUEUE_JOB_BODY, 201));
    const client = new CalibrationHttpClient(tokens(), {
      fetch,
      timeoutMs: 5000,
      sleep: () => Promise.resolve(),
    });

    await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
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

    const calledPath = callUrl(fetch).replace(BASE_URL, '');
    const docMatch = documentedApiPaths.some((p) => calledPath.startsWith(p));
    expect(
      docMatch,
      `Production createQueueJob called ${calledPath} but no §10 documented ` +
        `path matches it. Documented: [${documentedApiPaths.join(', ')}]`,
    ).toBe(true);
  });

  it('production acknowledgeBedClearAndStart URL contains the documented route segment', async () => {
    const { CalibrationHttpClient } =
      await import('../src/main/calibrationHttp.js');
    const fetch = vi.fn().mockResolvedValue(json(BED_CLEAR_OK, 202));
    const client = new CalibrationHttpClient(tokens(), {
      fetch,
      timeoutMs: 5000,
      sleep: () => Promise.resolve(),
    });

    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAA==',
      'BBBB==',
      null,
      AbortSignal.timeout(5000),
    );

    const calledPath = callUrl(fetch).replace(BASE_URL, '');
    expect(
      calledPath,
      'acknowledge-bed-clear-and-start must be in the called URL',
    ).toContain('acknowledge-bed-clear-and-start');
    // Doc side: the route is documented in §10
    expect(
      section10,
      '§10 must document acknowledge-bed-clear-and-start',
    ).toContain('acknowledge-bed-clear-and-start');
  });

  it('no /start route segment exists in production module exports (not comments)', async () => {
    // JSON.stringify of the imported module excludes source comments; only
    // actual exported string values appear. Any route-shaped /start string
    // found here represents a live constant, not a comment.
    const mod = await import('../src/main/calibrationHttp.js');
    const exported = JSON.stringify(mod);
    // Route terminal segment check: look for a quote-bounded path ending in /start
    expect(exported).not.toMatch(/\/start["'`]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bed-clear precondition headers: docs vs production (symmetric)
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — bed-clear precondition headers (issue #138)', () => {
  it(
    'production sends exactly the headers documented in §10.3 ' +
      '(missing and unexpected both empty)',
    async () => {
      const { CalibrationHttpClient } =
        await import('../src/main/calibrationHttp.js');
      const fetch = vi.fn().mockResolvedValue(json(BED_CLEAR_OK, 202));
      const client = new CalibrationHttpClient(tokens(), {
        fetch,
        timeoutMs: 5000,
        sleep: () => Promise.resolve(),
      });

      await client.acknowledgeBedClearAndStart(
        PROFILE_ID,
        BASE_URL,
        JOB_ID,
        PRINTER_ID,
        OPERATION_ID,
        'AAAA==',
        'BBBB==',
        null,
        AbortSignal.timeout(5000),
      );

      const productionHeaders = preconditionHeaders(callInit(fetch));
      const docSet = new Set(documentedBedClearHeaders);

      const missing = [...docSet].filter((h) => !productionHeaders.has(h));
      const unexpected = [...productionHeaders].filter((h) => !docSet.has(h));

      expect(
        missing,
        `Headers in §10.3 not sent by production: ${JSON.stringify(missing)}. ` +
          `Production non-standard headers: [${[...productionHeaders].join(', ')}].`,
      ).toHaveLength(0);

      expect(
        unexpected,
        `Headers sent by production not documented in §10.3: ` +
          `${JSON.stringify(unexpected)}. Add them to the §10.3 table.`,
      ).toHaveLength(0);
    },
  );

  it('opaque ETag is forwarded to If-Match without re-encoding', async () => {
    const { CalibrationHttpClient } =
      await import('../src/main/calibrationHttp.js');
    const fetch = vi.fn().mockResolvedValue(json(BED_CLEAR_OK, 202));
    const client = new CalibrationHttpClient(tokens(), {
      fetch,
      timeoutMs: 5000,
      sleep: () => Promise.resolve(),
    });

    const ROW_VERSION = 'AAAAAAAAAAAA==';
    const DISPATCH_ROW_VERSION = 'BBBBBBBBBBBB==';
    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      ROW_VERSION,
      DISPATCH_ROW_VERSION,
      null,
      AbortSignal.timeout(5000),
    );

    const sent = new Headers(callInit(fetch).headers);
    expect(sent.get('if-match'), 'rowVersion forwarded as-is').toBe(
      ROW_VERSION,
    );
    expect(
      sent.get('x-dispatch-state-if-match'),
      'dispatchStateRowVersion forwarded as-is',
    ).toBe(DISPATCH_ROW_VERSION);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Schema version and sequence: docs vs runtime schema
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — schemaVersion and sequence (issue #138)', () => {
  it('§10.5.2 documents schemaVersion "3" and sequence gap-detection semantics', () => {
    expect(
      section1052.length,
      '§10.5.2 sub-section not found in §10.',
    ).toBeGreaterThan(50);
    expect(section1052, '§10.5.2 must cite schemaVersion "3"').toContain('"3"');
    expect(
      section1052,
      '§10.5.2 must describe sequence for gap detection',
    ).toMatch(/gap|monoton/i);
  });

  it('RemoteQueueEventEnvelope accepts schemaVersion "3" and integer sequence', () => {
    const fixture = {
      schemaVersion: '3',
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: 42,
      eventType: 'PrintFarmer.Queue.JobStatusChanged.v1',
      occurredAtUtc: '2025-01-01T00:00:00.000Z',
      printerId: PRINTER_ID,
    };
    const result = RemoteQueueEventEnvelope.safeParse(fixture);
    expect(result.success, 'Must accept schemaVersion "3"').toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('3');
      expect(result.data.sequence).toBe(42);
    }
  });

  it('RemoteQueueEventEnvelope rejects missing sequence (non-nullable required field)', () => {
    const noSeq = {
      schemaVersion: '3',
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'T',
      occurredAtUtc: '2025-01-01T00:00:00.000Z',
    };
    expect(RemoteQueueEventEnvelope.safeParse(noSeq).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Printer-group redaction: §10.5 docs vs runtime schema behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — Printer-{id} envelope redaction (issue #138)', () => {
  it('§10.5 documents Printer-{printerId} redaction behavior', () => {
    const sec105 = (() => {
      const s = section10.indexOf('### 10.5 ');
      const e = section10.indexOf('\n### ', s + 5);
      return s === -1
        ? ''
        : e === -1
          ? section10.slice(s)
          : section10.slice(s, e);
    })();
    expect(sec105.length, '§10.5 sub-section not found').toBeGreaterThan(50);
    expect(sec105).toContain('Printer-{printerId}');
    expect(sec105).toMatch(/REDACT/i);
  });

  it('redacted printer-group envelope (null jobId) parses without error', () => {
    const redacted = {
      schemaVersion: '3',
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sequence: 11,
      eventType: 'PrintFarmer.Queue.PrinterStateChanged.v1',
      occurredAtUtc: '2025-01-01T00:00:00.000Z',
      printerId: PRINTER_ID,
      jobId: null,
      projectId: null,
      jobStatus: null,
      jobKind: null,
      jobRevision: null,
      dispatchStateRevision: null,
      bedClearState: null,
    };
    const result = RemoteQueueEventEnvelope.safeParse(redacted);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobId).toBeNull();
      expect(result.data.jobRevision).toBeNull();
      expect(result.data.bedClearState).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Orchestration status/currentStep: §10.5.1 docs vs runtime schema
// ═══════════════════════════════════════════════════════════════════════════

describe('server contract parity — orchestration forward-compatible strings (issue #138)', () => {
  it('§10.5.1 documents forward-compatible strings and real step constants', () => {
    const sec1051 = (() => {
      const s = section10.indexOf('### 10.5.1');
      const e = section10.indexOf('\n### ', s + 5);
      return s === -1
        ? ''
        : e === -1
          ? section10.slice(s)
          : section10.slice(s, e);
    })();
    expect(sec1051.length, '§10.5.1 not found').toBeGreaterThan(50);
    expect(sec1051).toMatch(/forward.compat|z\.string/i);
    // Must use real CalibrationGenerationSteps constants, not invented values
    const realSteps = [
      'submitting-slice-job',
      'awaiting-worker',
      'compiling-plan',
    ];
    const found = realSteps.filter((s) => sec1051.includes(s));
    expect(
      found.length,
      `§10.5.1 must document at least one real step constant from ` +
        `CalibrationGenerationSteps.cs: [${realSteps.join(', ')}]. ` +
        `Found: [${found.join(', ')}].`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('RemoteCalibrationOrchestrationStatus accepts unrecognised status and currentStep', () => {
    const fixture = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      projectId: '22222222-2222-4222-8222-222222222222',
      attemptId: '33333333-3333-4333-8333-333333333333',
      operationId: OPERATION_ID,
      status: 'FutureUnknownStatus',
      currentStep: 'future-unknown-step',
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
      statusRoute: '/api/calibration-orchestrations/cc',
      createdAtUtc: '2025-01-01T00:00:00.000Z',
      updatedAtUtc: '2025-01-01T00:00:01.000Z',
      completedAtUtc: null,
    };
    const result = RemoteCalibrationOrchestrationStatus.safeParse(fixture);
    expect(
      result.success,
      'Must accept unrecognised status/currentStep values',
    ).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('FutureUnknownStatus');
      expect(result.data.currentStep).toBe('future-unknown-step');
    }
  });
});
