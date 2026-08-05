/**
 * Issue #508 — an unrecognised bed-clear 422 must not be indistinguishable from
 * a diagnosed validation failure.
 *
 * Before this change `mapBedClearErrorCode422`'s `default` arm returned
 * `'invalidData'`. Unlike the 409 sibling's old fallback, that value is not
 * merely shared with one named case — it is a diagnosed code produced from ten
 * call sites across three files in the main process, and the log vocabulary
 * gives it the definite reading *"The server rejected the request as invalid."*
 * So *"the server validated this payload and refused it"* and *"the server said
 * something this build has never seen"* arrived at every consumer as the same
 * value.
 *
 * The load-bearing structure here is the **positive control**. An assertion
 * that an unrecognised code is *not* `'invalidData'` passes trivially if the
 * call path never produces that value at all — if the fixture is malformed, if
 * the 422 branch is never reached, if the request throws earlier. So every test
 * that asserts a difference also asserts, from the same code path and the same
 * helper, that a recognised code *does* produce its diagnosed value. Absence is
 * only meaningful beside a demonstrated presence.
 *
 * Mutations run against this file, each reverted afterwards:
 *
 * M-1  `default: return 'invalidData'` restored in `mapBedClearErrorCode422`.
 *      RED — 5 failures, naming the leaked value:
 *      "expected 'invalidData' to be 'unclassifiedValidationFailure'".
 *
 * M-2  `'unclassifiedValidationFailure'` removed from
 *      `CALIBRATION_LOG_ERROR_CODES`. RED — the vocabulary test fails with
 *      "expected 'unknownErrorCode' to be 'unclassifiedValidationFailure'",
 *      demonstrating the code would be erased at the logging boundary and no
 *      runbook could name it.
 *
 * M-3  `bedClearError` stubbed to return a fabricated error rather than driving
 *      a request. RED — the positive control fails first, which is the whole
 *      reason it is there.
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
 * Drive a real bed-clear request whose response carries a 422 and the given
 * server error code, and return the thrown transport error.
 *
 * A fresh `Response` is built per call rather than reusing one object, so that
 * if the client ever retried this path the body would still be readable and the
 * test would report the mapping rather than a spurious stream error.
 */
async function bedClearError(
  errorCode: string | null,
): Promise<CalibrationHttpError> {
  const body = errorCode === null ? {} : { error: errorCode };
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Response(JSON.stringify(body), {
        status: 422,
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
    'expected HTTP 422 to reject with CalibrationHttpError, but the call resolved',
  );
}

describe('#508 — unrecognised bed-clear 422 is distinguishable from a diagnosed one', () => {
  it('POSITIVE CONTROL: a recognised 422 code does produce its diagnosed value', async () => {
    const diagnosed = await bedClearError('filament_check_failed');

    // Without this the "is not invalidData" assertions below would pass on a
    // call path that never reached the 422 mapper at all.
    expect(diagnosed.code).toBe('filamentCheckFailed');
    expect(diagnosed.status).toBe(422);
  });

  it('an unrecognised code does not borrow a diagnosed code', async () => {
    const unknown = await bedClearError('bed_probe_out_of_range');

    expect(unknown.code).toBe('unclassifiedValidationFailure');
    expect(unknown.code).not.toBe('invalidData');
  });

  it('the two outcomes differ, compared directly rather than against a literal', async () => {
    const diagnosed = await bedClearError('calibration_job_incompatible');
    const unknown = await bedClearError('bed_probe_out_of_range');

    // Comparing the two observations to each other, so this fails if BOTH arms
    // are changed to agree on any value, not only on the old one.
    expect(diagnosed.code).toBe('calibrationJobIncompatible');
    expect(unknown.code).not.toBe(diagnosed.code);
  });

  it('a 422 with no error field in the body is unclassified, not diagnosed', async () => {
    const empty = await bedClearError(null);

    expect(empty.code).toBe('unclassifiedValidationFailure');
    expect(empty.code).not.toBe('invalidData');
  });

  it('the distinction survives to the renderer, where the operator reads it', async () => {
    const diagnosed = (await bedClearError('filament_check_failed')).toApiError(
      null,
    );
    const unknown = (await bedClearError('bed_probe_out_of_range')).toApiError(
      null,
    );

    expect(diagnosed.code).toBe('filamentCheckFailed');
    // 'serverError' is a rendering fallback, not a classification: the shared
    // IPC enum has no unclassified member and widening it is owned by #219.
    expect(unknown.code).toBe('serverError');
    expect(unknown.code).not.toBe(diagnosed.code);

    // An unclassified rejection must not be advertised as retryable: we do not
    // know what it was, so we cannot claim repeating it is safe.
    expect(unknown.retryable).toBe(false);
  });

  it('the raw server code survives in the message, so the cause is recoverable', async () => {
    const unknown = await bedClearError('bed_probe_out_of_range');

    // The mapper deliberately discards detail it cannot classify; the message
    // is where that detail remains available to an operator and to the logs.
    expect(unknown.message).toContain('bed_probe_out_of_range');
  });

  it('unclassifiedValidationFailure is a real log-vocabulary member, not coerced away', () => {
    // safeErrorCode replaces any non-member with 'unknownErrorCode'. If the
    // vocabulary had not been extended, the honest code would be erased at the
    // logging boundary and the runbooks could never name it.
    expect(safeErrorCode('unclassifiedValidationFailure')).toBe(
      'unclassifiedValidationFailure',
    );
    // Negative control: the coercion is genuinely active on this path.
    expect(safeErrorCode('not_a_vocabulary_member')).toBe('unknownErrorCode');
  });

  it('the two unclassified codes are distinct, so 409 and 422 stay separable', async () => {
    const unknown422 = await bedClearError('bed_probe_out_of_range');

    // The whole point of #326 and #508 is that a consumer can tell *which*
    // refusal it saw. Collapsing both to one shared "unclassified" value would
    // satisfy every assertion above and destroy that.
    expect(unknown422.code).not.toBe('unclassifiedConflict');
  });
});

describe('#508 — the two diagnosed 422 codes are unchanged', () => {
  const DIAGNOSED: ReadonlyArray<readonly [string, string]> = [
    ['calibration_job_incompatible', 'calibrationJobIncompatible'],
    ['filament_check_failed', 'filamentCheckFailed'],
  ];

  for (const [serverCode, expected] of DIAGNOSED) {
    it(`${serverCode} still maps to ${expected}`, async () => {
      const error = await bedClearError(serverCode);

      expect(error.code).toBe(expected);
      expect(error.code).not.toBe('unclassifiedValidationFailure');
    });
  }
});
