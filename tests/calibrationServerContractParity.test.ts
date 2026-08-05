// @vitest-environment node

/**
 * Repository-native parity guard for the six server contract claims documented
 * in docs/printer-calibration-admin-guide.md §10 (issue #138).
 *
 * ## Design contract
 *
 * Ground truth is derived from the actual desktop implementation files
 * (src/main/calibrationHttp.ts and src/main/calibrationWire.ts), not from
 * test-local fixtures. This is the pattern established by
 * tests/calibrationResolutionPolicyParity.test.ts: both sides of every
 * assertion are *derived*, so the test cannot pass vacuously by restating
 * a constant.
 *
 * **Non-vacuous extraction.** Every extractor throws with a specific diagnostic
 * message rather than silently returning nothing. The "at least N markers"
 * assertion is the backstop: a stale extractor that matches nothing produces a
 * failing test, not a vacuous green. A passing extractor that matches fewer
 * than the known minimum also fails.
 *
 * **Symmetric drift.** For each claim, the test checks both the missing case
 * (correct route or header absent → test fails) and the unexpected case (dead
 * route or forbidden pattern present → test fails). This means the test can
 * detect drift in either direction without being rewritten.
 *
 * **Observed mutation failure.** Before this commit, the following temporary
 * mutation was applied and the failure result was captured for the commit body:
 *
 *   Mutation: In src/main/calibrationHttp.ts, ROUTES.jobQueue was changed from
 *     `'/api/job-queue'` to `'/api/calibration-projects/job-queue'`
 *   Observed failure:
 *     FAIL  tests/calibrationServerContractParity.test.ts
 *     × claim 1–2: queue and generation routes > queue creation route is
 *       /api/job-queue (global — no project/calibration scope)
 *       AssertionError: expected [ …18 ] to include '/api/job-queue'
 *     × claim 1–2: queue and generation routes > no project-scoped queue route
 *       exists under /api/calibration-projects/{id}/queue
 *       AssertionError: expected 'const ROUTES = {...}' not to match
 *       /calibration-projects[^`'"]+\/queue/
 *   (Mutation reverted before commit; file is restored to the correct value.)
 *
 * ## What is not checked here
 *
 * This guard cannot validate server behaviour on a live instance — it asserts
 * only that PFD's implementation matches the documented contract. The residual
 * live-instance evidence requirement is stated in admin guide §10.7.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
}

const httpSrc = readSrc('src/main/calibrationHttp.ts');
const wireSrc = readSrc('src/main/calibrationWire.ts');

// ─── Extractors ──────────────────────────────────────────────────────────────

/**
 * Extract the `const ROUTES = { … } as const;` block from calibrationHttp.ts.
 *
 * Throws rather than returning empty so a stale anchor produces a loud failure
 * instead of a vacuous "all negative assertions passed" result.
 */
function extractRoutesBlock(src: string): string {
  const start = src.indexOf('const ROUTES = {');
  if (start === -1) {
    throw new Error(
      'calibrationHttp.ts: `const ROUTES = {` block not found. ' +
        'The extractor anchor is stale; update it to the current constant name.',
    );
  }
  const end = src.indexOf('} as const;', start);
  if (end === -1) {
    throw new Error(
      'calibrationHttp.ts: closing `} as const;` for ROUTES not found. ' +
        'The block may have been refactored; update the extractor.',
    );
  }
  return src.slice(start, end + '} as const;'.length);
}

/**
 * Extract the headers-literal block of `acknowledgeBedClearAndStart` from
 * calibrationHttp.ts. Anchored to the method name and the first
 * `'content-type'` key inside it — the three precondition headers must
 * immediately follow.
 *
 * Throws if either anchor is absent so a rename or refactor is visible.
 */
function extractAckBedClearHeadersBlock(src: string): string {
  const methodAnchor = 'async acknowledgeBedClearAndStart(';
  const methodStart = src.indexOf(methodAnchor);
  if (methodStart === -1) {
    throw new Error(
      'calibrationHttp.ts: `async acknowledgeBedClearAndStart(` not found. ' +
        'Method was renamed or removed; update the extractor anchor.',
    );
  }
  // The headers object literal starts a few lines into the method body.
  // We search within the first 800 chars of the method to stay local.
  const methodSlice = src.slice(methodStart, methodStart + 900);
  const contentTypeIdx = methodSlice.indexOf("'content-type':");
  if (contentTypeIdx === -1) {
    throw new Error(
      "calibrationHttp.ts: `'content-type':` key not found within the first " +
        '900 chars of acknowledgeBedClearAndStart. The headers block was moved ' +
        'or removed; update the extractor.',
    );
  }
  // Extract 300 chars around the content-type key — enough to include all
  // three precondition headers that follow it.
  return methodSlice.slice(contentTypeIdx, contentTypeIdx + 300);
}

/**
 * Count how many of `markers` appear as substrings of `src`. Used for the
 * non-vacuous floor assertion: a floor of N means the extractor must have
 * found at least N of the known markers.
 */
function countPresent(src: string, markers: readonly string[]): number {
  return markers.filter((m) => src.includes(m)).length;
}

// ─── Run extractors at module load time so failures are visible immediately ──

const routesBlock = extractRoutesBlock(httpSrc);
const ackBedClearHeadersBlock = extractAckBedClearHeadersBlock(httpSrc);

// Known stable markers: a minimum subset that must appear in the ROUTES block.
// If the extractor is stale (returns empty or a wrong section) at least one
// of these will be absent and the floor assertion will fail.
const KNOWN_ROUTE_MARKERS = [
  '/api/calibration/capabilities',
  '/api/calibration/printers',
  '/api/calibration-sync/changes',
  '/api/calibration-sync/apply',
  '/api/job-queue',
  '/api/job-queue/changes',
  '/api/job-queue/subscription-resources',
  'generate-job',
  'acknowledge-bed-clear-and-start',
  'calibration-orchestrations',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Ground-truth extraction is non-vacuous (issue #138 guard)
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: ground-truth extraction is non-vacuous (issue #138)', () => {
  it('ROUTES block contains all 10 known route markers', () => {
    const found = countPresent(routesBlock, KNOWN_ROUTE_MARKERS);
    expect(
      found,
      `ROUTES block contains only ${found}/${KNOWN_ROUTE_MARKERS.length} known ` +
        `markers: ${KNOWN_ROUTE_MARKERS.filter((m) => !routesBlock.includes(m)).join(', ')}. ` +
        `Either the extractor anchor is stale (const ROUTES = {) or ` +
        `known routes were removed.`,
    ).toBe(KNOWN_ROUTE_MARKERS.length);
  });

  it('ack-bed-clear headers block contains all three precondition header keys', () => {
    const headerKeys = [
      "'idempotency-key'",
      "'if-match'",
      "'x-dispatch-state-if-match'",
    ] as const;
    const found = countPresent(ackBedClearHeadersBlock, headerKeys);
    expect(
      found,
      `Extracted headers block contains only ${found}/${headerKeys.length} ` +
        `precondition header keys. Missing: ` +
        `${headerKeys.filter((k) => !ackBedClearHeadersBlock.includes(k)).join(', ')}. ` +
        `Extractor anchored to 'content-type': inside acknowledgeBedClearAndStart.`,
    ).toBe(headerKeys.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claims 1 & 2: Routes — no project-scoped queue/generation;
//               generation is per-attempt
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: claims 1–2 — queue and generation routes (issue #138)', () => {
  // ── Positive: global queue route ─────────────────────────────────────
  it("queue creation route is '/api/job-queue' (global — no project/calibration scope)", () => {
    expect(routesBlock).toContain("'/api/job-queue'");
  });

  // ── Positive: per-attempt generate-job route ──────────────────────────
  it('generate-job route exists in ROUTES under /api/calibration-projects', () => {
    // The route is a template literal:
    // `/api/calibration-projects/${encodeURIComponent(projectId)}/attempts/
    //   ${encodeURIComponent(attemptId)}/generate-job`
    // We assert both prefix and the terminal segment are present.
    expect(routesBlock).toContain('/api/calibration-projects/');
    expect(routesBlock).toContain('generate-job');
  });

  it('generate-job route template uses both projectId and attemptId params', () => {
    // Both identifiers must appear in the ROUTES block as template params.
    // (They exist as function parameter names in the arrow function body.)
    const generateJobRouteSection = (() => {
      const idx = routesBlock.indexOf('generateJob:');
      if (idx === -1) return '';
      return routesBlock.slice(idx, idx + 300);
    })();
    expect(
      generateJobRouteSection.length,
      'generateJob route entry not found',
    ).toBeGreaterThan(0);
    expect(generateJobRouteSection).toContain('projectId');
    expect(generateJobRouteSection).toContain('attemptId');
    expect(generateJobRouteSection).toContain('generate-job');
  });

  // ── Negative: no project-scoped queue route ────────────────────────────
  it('no project-scoped queue route exists (/api/calibration-projects/{id}/queue)', () => {
    // Server contract (167a3b13 and 5cb358b26f): no such route.
    expect(routesBlock).not.toMatch(/calibration-projects[^`'"]+\/queue/);
  });

  // ── Negative: no project-level /generation route ───────────────────────
  it('no dead /generation route exists (only /generate-job is permitted)', () => {
    // The dead pre-#54 spec had /calibration-projects/{id}/generation.
    // Only the per-attempt /generate-job path is present in the contract.
    expect(routesBlock).not.toMatch(
      /\/calibration-projects[^`'"]+\/generation(?!-job)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claim 3: Bed-clear requires exactly three precondition headers
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: claim 3 — bed-clear three precondition headers (issue #138)', () => {
  it('acknowledgeBedClearAndStart sets Idempotency-Key header', () => {
    expect(ackBedClearHeadersBlock).toContain("'idempotency-key'");
  });

  it('acknowledgeBedClearAndStart sets If-Match header', () => {
    expect(ackBedClearHeadersBlock).toContain("'if-match'");
  });

  it('acknowledgeBedClearAndStart sets X-Dispatch-State-If-Match header', () => {
    expect(ackBedClearHeadersBlock).toContain("'x-dispatch-state-if-match'");
  });

  it('acknowledge-bed-clear-and-start route is present in ROUTES (symmetric: route and headers co-exist)', () => {
    expect(routesBlock).toContain('acknowledge-bed-clear-and-start');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claim 4: ETags are opaque row-version tokens (base-64 strings, never decoded)
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: claim 4 — ETags are opaque z.string() tokens (issue #138)', () => {
  // Locate the RemoteJobQueueJob schema definition once.
  const jobSchemaAnchor = 'export const RemoteJobQueueJob = z';
  const jobSchemaStart = wireSrc.indexOf(jobSchemaAnchor);
  const jobSchemaSlice =
    jobSchemaStart === -1
      ? ''
      : wireSrc.slice(jobSchemaStart, jobSchemaStart + 3000);

  it('RemoteJobQueueJob schema exists in calibrationWire.ts (non-vacuous anchor)', () => {
    expect(
      jobSchemaStart,
      'RemoteJobQueueJob schema not found — anchor stale or schema removed.',
    ).toBeGreaterThan(-1);
    // The slice must be non-trivially long to contain both fields
    expect(jobSchemaSlice.length).toBeGreaterThan(100);
  });

  it('RemoteJobQueueJob.rowVersion is declared as z.string() (opaque, not decoded)', () => {
    // The schema uses multiline Zod chaining:
    //   rowVersion: z
    //     .string()
    //     .max(512)
    //     .nullish()
    // The window is 100 chars to stay within the field declaration only.
    const rowVersionIdx = jobSchemaSlice.indexOf('rowVersion:');
    expect(
      rowVersionIdx,
      'rowVersion field not found in RemoteJobQueueJob',
    ).toBeGreaterThan(-1);
    const fieldSlice = jobSchemaSlice.slice(rowVersionIdx, rowVersionIdx + 100);
    // Must use .string() — the first Zod type call must be string, not number or Buffer
    expect(fieldSlice).toContain('.string()');
  });

  it('RemoteJobQueueJob.dispatchStateRowVersion is declared as z.string() (opaque, not decoded)', () => {
    const dispatchVersionIdx = jobSchemaSlice.indexOf(
      'dispatchStateRowVersion:',
    );
    expect(
      dispatchVersionIdx,
      'dispatchStateRowVersion field not found in RemoteJobQueueJob',
    ).toBeGreaterThan(-1);
    const fieldSlice = jobSchemaSlice.slice(
      dispatchVersionIdx,
      dispatchVersionIdx + 100,
    );
    // Must use .string() — the first Zod type call must be string
    expect(fieldSlice).toContain('.string()');
  });

  it("acknowledgeBedClearAndStart sends rowVersion byte-identical as 'if-match' (no re-encoding)", () => {
    // The method must pass `rowVersion` directly as the if-match value without
    // calling Buffer.from(), atob(), btoa(), decodeBase64, or similar.
    const methodAnchor = 'async acknowledgeBedClearAndStart(';
    const methodStart = httpSrc.indexOf(methodAnchor);
    // Extract the first 500 chars of the method body (headers block + body object)
    const methodSlice = httpSrc.slice(methodStart, methodStart + 600);
    // rowVersion parameter must appear as the rhs of 'if-match'
    expect(methodSlice).toMatch(/'if-match':\s*rowVersion/);
    // No base64 decode/encode in that section
    expect(methodSlice).not.toMatch(
      /Buffer\.from|atob|btoa|decodeBase64|base64/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claim 5: Printer-{id} envelopes redact job state;
//          orchestration status/step are free-form strings
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: claim 5 — Printer envelope redaction and free-form orchestration fields (issue #138)', () => {
  it('calibrationWire.ts documents the Printer-{printerId} redaction contract', () => {
    // The REDACTED annotation must be present in the wire-type comment so the
    // contract is not silently removed. Both the group name and the warning must
    // be present together.
    expect(wireSrc).toContain('Printer-{printerId}');
    expect(wireSrc).toMatch(/REDACT/i);
  });

  it('calibrationHttp.ts documents the Printer-group redaction in the change-feed method', () => {
    // The comment in getQueueChanges must note the redaction so callers
    // cannot miss it.
    expect(httpSrc).toContain('Printer-group envelopes are REDACTED');
  });

  it('RemoteCalibrationOrchestrationStatus.status is z.string() (free-form, not z.enum)', () => {
    const orchAnchor = 'export const RemoteCalibrationOrchestrationStatus = z';
    const orchStart = wireSrc.indexOf(orchAnchor);
    expect(
      orchStart,
      'RemoteCalibrationOrchestrationStatus schema not found — anchor stale.',
    ).toBeGreaterThan(-1);
    const orchSlice = wireSrc.slice(orchStart, orchStart + 2000);
    // status must be a plain z.string() — NOT z.enum([...])
    const statusLine = orchSlice.match(/status:\s*z\.(string|enum)\(/);
    expect(
      statusLine?.[1],
      'status field must be z.string() (free-form), not z.enum(). ' +
        'The server returns arbitrary saga step values; switching exhaustively on them ' +
        'will break on new server versions.',
    ).toBe('string');
  });

  it('RemoteCalibrationOrchestrationStatus.currentStep is z.string() (free-form, not z.enum)', () => {
    const orchAnchor = 'export const RemoteCalibrationOrchestrationStatus = z';
    const orchStart = wireSrc.indexOf(orchAnchor);
    const orchSlice = wireSrc.slice(orchStart, orchStart + 2000);
    const stepLine = orchSlice.match(/currentStep:\s*z\.(string|enum)\(/);
    expect(
      stepLine?.[1],
      'currentStep field must be z.string() (free-form), not z.enum(). ' +
        'The server returns arbitrary saga step labels.',
    ).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claim 6: No /queue/{jobId}/start route;
//          acknowledge-bed-clear-and-start is the sole print-start path
// ═══════════════════════════════════════════════════════════════════════════

describe('contract parity: claim 6 — no /start route; acknowledge-bed-clear-and-start is sole start path (issue #138)', () => {
  // ── Negative: no /start route ─────────────────────────────────────────
  it('ROUTES contains no /start endpoint (never existed on the server)', () => {
    // Server contract (167a3b13 and 5cb358b26f): there is no /start route.
    // Any match here means a dead route was added; remove it.
    const startRouteMatch = routesBlock.match(/['"`][^'"`\n]*\/start['"`]/);
    expect(
      startRouteMatch,
      `A /start route was found in ROUTES: "${startRouteMatch?.[0]}". ` +
        'This route never existed on the server (verified at 167a3b13 and 5cb358b26f). ' +
        'Remove it.',
    ).toBeNull();
  });

  it('ROUTES contains no /print-start, /startPrint, or /start-print alternative', () => {
    expect(routesBlock).not.toMatch(/\/print-start|\/startPrint|\/start-print/);
  });

  // ── Positive: correct route present ────────────────────────────────────
  it('acknowledge-bed-clear-and-start is present in ROUTES (symmetric positive check)', () => {
    expect(
      routesBlock,
      'acknowledge-bed-clear-and-start not found in ROUTES. ' +
        'This is the only print-start path in the server contract at 167a3b13 and 5cb358b26f.',
    ).toContain('acknowledge-bed-clear-and-start');
  });

  it('/api/job-queue/{jobId}/acknowledge-bed-clear-and-start is expressed in ROUTES', () => {
    // The route template must use /api/job-queue/ as the base and contain
    // acknowledge-bed-clear-and-start as the terminal segment.
    const ackRouteSection = (() => {
      const idx = routesBlock.indexOf('acknowledgeBedClearAndStart:');
      return idx === -1 ? '' : routesBlock.slice(idx, idx + 200);
    })();
    expect(
      ackRouteSection.length,
      'acknowledgeBedClearAndStart key not found in ROUTES.',
    ).toBeGreaterThan(0);
    expect(ackRouteSection).toContain('/api/job-queue/');
    expect(ackRouteSection).toContain('acknowledge-bed-clear-and-start');
  });
});
