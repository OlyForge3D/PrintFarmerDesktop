/**
 * Issue #326 — an unrecognised bed-clear 409 must not be indistinguishable from
 * a diagnosed one.
 *
 * Before this change `mapBedClearErrorCode409`'s `default` arm returned
 * `'idempotencyPayloadChanged'` — byte-identical to the value returned for the
 * explicitly recognised `idempotency_payload_mismatch`. No consumer could tell
 * *"the server told us the payload changed"* from *"the server told us
 * something we have never seen"*, and two runbooks written in #160 assign that
 * code a definite cause.
 *
 * The load-bearing structure here is the **positive control**. An assertion
 * that an unrecognised code is *not* `'idempotencyPayloadChanged'` passes
 * trivially if the call path never produces that value at all — if the fixture
 * is malformed, if the 409 branch is never reached, if the request throws
 * earlier. So every test that asserts a difference also asserts, from the same
 * code path and the same helper, that the recognised code *does* produce the
 * diagnosed value. Absence is only meaningful beside a demonstrated presence.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import { safeErrorCode } from '../src/main/calibrationLog.js';

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const PRINTER_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const BINDING = 'binding-abc123';

function stableTokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'test-jwt',
      binding: BINDING,
    }),
  };
}

function makeClient(fetchMock: typeof globalThis.fetch) {
  return new CalibrationHttpClient(stableTokens(), {
    fetch: fetchMock,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
    now: () => Date.now(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
}

/**
 * Drive a real bed-clear request whose response carries `status` and the given
 * server error code, and return the thrown transport error.
 *
 * A fresh `Response` is built per call rather than reusing one object, so that
 * if the client ever retried this path the body would still be readable and the
 * test would report the mapping rather than a spurious stream error.
 */
async function bedClearError(
  errorCode: string | null,
  status = 409,
): Promise<CalibrationHttpError> {
  const body = errorCode === null ? {} : { error: errorCode };
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = makeClient(fetchMock);
  try {
    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAAAAAAAAAA==',
      'BBBBBBBBBBBB==',
      null,
      AbortSignal.timeout(5000),
    );
  } catch (error) {
    if (error instanceof CalibrationHttpError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    `expected HTTP ${status} to reject with CalibrationHttpError, but the call resolved`,
  );
}

describe('#326 — unrecognised bed-clear 409 is distinguishable from a diagnosed one', () => {
  it('POSITIVE CONTROL: the recognised code does produce idempotencyPayloadChanged', async () => {
    const diagnosed = await bedClearError('idempotency_payload_mismatch');

    // Without this the "is not idempotencyPayloadChanged" assertions below
    // would pass on a call path that never produces the value at all.
    expect(diagnosed.code).toBe('idempotencyPayloadChanged');
    expect(diagnosed.status).toBe(409);
  });

  it('an unrecognised code does not borrow the diagnosed code', async () => {
    const unknown = await bedClearError('bed_not_actually_clear');

    expect(unknown.code).toBe('unclassifiedConflict');
    expect(unknown.code).not.toBe('idempotencyPayloadChanged');
  });

  it('the two outcomes differ, compared directly rather than against a literal', async () => {
    const diagnosed = await bedClearError('idempotency_payload_mismatch');
    const unknown = await bedClearError('bed_not_actually_clear');

    // Comparing the two observations to each other, so this fails if BOTH
    // arms are changed to agree on any value, not only on the old one.
    expect(unknown.code).not.toBe(diagnosed.code);
  });

  it('a 409 with no error field in the body is unclassified, not diagnosed', async () => {
    const empty = await bedClearError(null);

    expect(empty.code).toBe('unclassifiedConflict');
    expect(empty.code).not.toBe('idempotencyPayloadChanged');
  });

  it('the distinction survives to the renderer, where the operator reads it', async () => {
    const diagnosed = (
      await bedClearError('idempotency_payload_mismatch')
    ).toApiError(null);
    const unknown = (await bedClearError('bed_not_actually_clear')).toApiError(
      null,
    );

    expect(diagnosed.code).toBe('idempotencyPayloadChanged');
    expect(unknown.code).toBe('serverError');
    expect(unknown.code).not.toBe(diagnosed.code);

    // An unclassified conflict must not be advertised as retryable: we do not
    // know what it was, so we cannot claim repeating it is safe.
    expect(unknown.retryable).toBe(false);
  });

  it('the raw server code survives in the message, so the cause is recoverable', async () => {
    const unknown = await bedClearError('bed_not_actually_clear');

    // The mapper deliberately discards detail it cannot classify; the message
    // is where that detail remains available to an operator and to the logs.
    expect(unknown.message).toContain('bed_not_actually_clear');
  });

  it('unclassifiedConflict is a real log-vocabulary member, not coerced away', () => {
    // safeErrorCode replaces any non-member with 'unknownErrorCode'. If the
    // vocabulary had not been extended, the honest code would be erased at the
    // logging boundary and the runbooks could never name it.
    expect(safeErrorCode('unclassifiedConflict')).toBe('unclassifiedConflict');
    // Negative control: the coercion is genuinely active on this path.
    expect(safeErrorCode('not_a_vocabulary_member')).toBe('unknownErrorCode');
  });
});

describe('#326 — the four diagnosed 409 codes are unchanged', () => {
  const DIAGNOSED: ReadonlyArray<readonly [string, string]> = [
    ['wrong_job', 'wrongJob'],
    ['printer_busy', 'printerBusy'],
    ['job_not_dispatchable', 'jobNotDispatchable'],
    ['idempotency_payload_mismatch', 'idempotencyPayloadChanged'],
  ];

  it('every named case still maps to its own distinct code', async () => {
    const observed: string[] = [];
    for (const [serverCode, expected] of DIAGNOSED) {
      const error = await bedClearError(serverCode);
      expect(error.code).toBe(expected);
      observed.push(error.code);
    }

    // Non-emptiness and distinctness: a loop that ran zero times, or a mapper
    // that collapsed every arm onto one value, would otherwise pass silently.
    expect(observed).toHaveLength(DIAGNOSED.length);
    expect(new Set(observed).size).toBe(DIAGNOSED.length);
  });

  it('the 422 sibling is untouched by this change', async () => {
    const named = await bedClearError('filament_check_failed', 422);
    const unknown = await bedClearError('no_such_422_code', 422);

    expect(named.code).toBe('filamentCheckFailed');
    expect(unknown.code).toBe('invalidData');
    expect(unknown.code).not.toBe(named.code);
  });
});

/*
 * Mutations run against this file (#326), with measured results. Recorded
 * because a test that has never been shown to fail is not evidence — and
 * because one of the four contradicted what I predicted when writing it.
 *
 * M-1  default arm restored to 'idempotencyPayloadChanged' (the defect itself)
 *      -> KILLED, 4 failing:
 *           - an unrecognised code does not borrow the diagnosed code
 *           - the two outcomes differ, compared directly
 *           - a 409 with no error field in the body
 *           - the distinction survives to the renderer
 *
 * M-2  default arm changed to 'wrongJob' — a DIFFERENT diagnosed code
 *      -> KILLED, 3 failing: the two literal-asserting tests and the renderer
 *         test. The direct-comparison test PASSES, because 'wrongJob' and
 *         'idempotencyPayloadChanged' do differ.
 *
 *      CORRECTION. I first wrote that the direct-comparison test fires here,
 *      and it does not. The test I built to be the strongest — comparing two
 *      observations rather than a literal, so that it survives any renaming —
 *      is the WEAKEST against substitution. It detects only the two arms
 *      collapsing onto one value; it cannot detect the default arm being
 *      swapped for a third wrong code, because that still differs. The
 *      literal-asserting tests are what catch M-2.
 *
 *      Neither style dominates: comparison catches "both arms moved together",
 *      literals catch "one arm moved elsewhere". Keeping both is not
 *      redundancy, and dropping the literals as "brittle" would have left this
 *      mutation alive.
 *
 * M-3  'unclassifiedConflict' removed from CALIBRATION_LOG_ERROR_CODES
 *      -> KILLED twice, independently: `tsc` fails first at
 *         calibrationLog.ts's AssertCovered, naming the missing member; and
 *         the vocabulary-membership test fails under vitest, which does not
 *         typecheck. Either gate alone would have caught it.
 *
 * M-4  'unclassifiedConflict' mapped to 'idempotencyPayloadChanged' in the
 *      toApiError codeMap
 *      -> KILLED, 1 failing: the renderer test. This is the mutation that
 *         matters most, because the main process being honest is worthless if
 *         the IPC boundary re-collides the two on the way to the operator.
 *
 * CONTROL  the harness applied a no-op replacement of the same anchor
 *      -> GREEN, exit 0. The write/revert cycle does not by itself break the
 *         suite, so the four verdicts above are attributable to the mutations
 *         and not to the harness.
 */
