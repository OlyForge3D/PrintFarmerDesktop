// @vitest-environment node

/**
 * Structured calibration log records (issue #159).
 *
 * Covers the record vocabulary, the safe-message catalog, the secondary
 * identifier guard, error classification, and the sink.
 *
 * Every "a secret is absent" claim here is paired with a control showing the
 * same input *does* surface through a naive emitter. Absence on its own is
 * indistinguishable from the value never having been present.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  CALIBRATION_LOG_FIELDS,
  CALIBRATION_LOG_ERROR_CODES,
  UNSAFE_IDENTIFIER_PLACEHOLDER,
  buildCalibrationLogRecord,
  calibrationLogMessage,
  captureCalibrationLogs,
  describeCalibrationFailure,
  emitCalibrationLog,
  resetCalibrationLogSink,
  safeIdentifier,
} from '../src/main/calibrationLog.js';
import { CalibrationHttpError } from '../src/main/calibrationHttp.js';
import { CalibrationEngineError } from '../src/main/calibrationEngine.js';

/** A structurally real JWT: three base64url segments, decodable header. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvciIsImV4cCI6MjF9.c2lnbmF0dXJlLXZhbHVlLWhlcmU';
const ABSOLUTE_WINDOWS_PATH =
  'C:\\Users\\operator\\AppData\\Roaming\\PrintFarmer\\calibration-photos\\v1\\a.jpg';
const ABSOLUTE_POSIX_PATH =
  '/Users/operator/Library/Application Support/PrintFarmer/calibration-photos/v1/a.jpg';

/** What a logger that did not redact would produce for the same input. */
function naiveEmit(value: unknown): string {
  return JSON.stringify(value);
}

afterEach(() => {
  resetCalibrationLogSink();
});

describe('record construction', () => {
  it('emits only allowlisted fields', () => {
    const record = buildCalibrationLogRecord({
      level: 'info',
      component: 'calibration.http',
      event: 'generation.requested',
      correlationId: 'corr-1',
      operationId: 'op-1',
      profileId: 'profile-1',
    });
    for (const key of Object.keys(record)) {
      expect(CALIBRATION_LOG_FIELDS).toContain(key);
    }
  });

  it('carries a parseable UTC timestamp, level, component and event', () => {
    const record = buildCalibrationLogRecord(
      {
        level: 'error',
        component: 'calibration.sync',
        event: 'sync.failed',
        errorCode: 'revisionConflict',
      },
      () => new Date('2026-08-03T22:01:42.281Z'),
    );
    expect(record.timestamp).toBe('2026-08-03T22:01:42.281Z');
    expect(record.level).toBe('error');
    expect(record.component).toBe('calibration.sync');
    expect(record.event).toBe('sync.failed');
  });

  it('drops an identifier that is undefined rather than emitting an empty key', () => {
    const record = buildCalibrationLogRecord({
      level: 'info',
      component: 'calibration.http',
      event: 'queue.stateRead',
    });
    expect('dispatchId' in record).toBe(false);
  });

  it('normalises a non-integer or negative duration', () => {
    const record = buildCalibrationLogRecord({
      level: 'info',
      component: 'calibration.http',
      event: 'queue.stateRead',
      durationMs: -12.9,
      httpStatus: 404,
    });
    expect(record.durationMs).toBe(0);
    expect(record.httpStatus).toBe(404);
  });

  it('discards a non-finite duration instead of emitting NaN', () => {
    const record = buildCalibrationLogRecord({
      level: 'info',
      component: 'calibration.http',
      event: 'queue.stateRead',
      durationMs: Number.NaN,
    });
    expect('durationMs' in record).toBe(false);
  });
});

describe('safe message catalog', () => {
  it('has a message for every error code in the vocabulary', () => {
    for (const code of CALIBRATION_LOG_ERROR_CODES) {
      const message = calibrationLogMessage('some.event', code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe('some.event');
    }
  });

  it('prefers the error code message over the event message', () => {
    expect(calibrationLogMessage('sync.completed')).toBe(
      'Calibration synchronization completed.',
    );
    expect(calibrationLogMessage('sync.completed', 'printerBusy')).toBe(
      'The printer is busy with another job.',
    );
  });

  it('cannot be given free text: input has no message key', () => {
    // A caller trying to smuggle a backend body in would have to add a key the
    // input type does not have; the cast is what such a caller would need to
    // write, and at runtime the value is simply not read.
    const smuggled = { message: `server said ${JWT}` } as unknown as Record<
      string,
      never
    >;
    const record = buildCalibrationLogRecord({
      level: 'error',
      component: 'calibration.http',
      ...smuggled,
      event: 'generation.requested',
      errorCode: 'server',
    });
    expect(record.message).toBe('The server reported an internal error.');
    expect(naiveEmit(record)).not.toContain(JWT);
  });
});

describe('secondary identifier guard', () => {
  it('passes an ordinary UUID through unchanged', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(safeIdentifier(uuid)).toBe(uuid);
  });

  it('passes an opaque base64 ETag through unchanged', () => {
    expect(safeIdentifier('AAAAAAAAAAAA==')).toBe('AAAAAAAAAAAA==');
  });

  it.each([
    ['a JWT', JWT],
    ['a Windows absolute path', ABSOLUTE_WINDOWS_PATH],
    ['a POSIX absolute path', ABSOLUTE_POSIX_PATH],
    ['an over-long value', 'a'.repeat(129)],
    ['an empty value', ''],
  ])('replaces %s', (_label, value) => {
    // The claim: the value does not survive.
    expect(safeIdentifier(value)).toBe(UNSAFE_IDENTIFIER_PLACEHOLDER);
  });

  it('replaces a JWT passed into a legitimate identifier field, where a naive emitter would not', () => {
    const record = buildCalibrationLogRecord({
      level: 'error',
      component: 'calibration.http',
      event: 'generation.requested',
      operationId: JWT,
    });
    // The claim.
    expect(naiveEmit(record)).not.toContain(JWT);
    expect(record.operationId).toBe(UNSAFE_IDENTIFIER_PLACEHOLDER);
    // The control: the same input through an emitter without the guard does
    // surface it, so the absence above is the guard's doing, not an accident of
    // the fixture.
    expect(naiveEmit({ operationId: JWT })).toContain(JWT);
  });

  it('replaces an absolute path passed into a legitimate identifier field, where a naive emitter would not', () => {
    const record = buildCalibrationLogRecord({
      level: 'error',
      component: 'calibration.photo',
      event: 'photo.staleTemporaryCleanupFailed',
      projectId: ABSOLUTE_POSIX_PATH,
    });
    expect(naiveEmit(record)).not.toContain('operator');
    expect(record.projectId).toBe(UNSAFE_IDENTIFIER_PLACEHOLDER);
    expect(naiveEmit({ projectId: ABSOLUTE_POSIX_PATH })).toContain('operator');
  });
});

describe('error classification', () => {
  it('reads the typed code and status from a CalibrationHttpError', () => {
    const error = new CalibrationHttpError(
      'revisionConflict',
      // A backend ProblemDetails detail, which is exactly what `statusError`
      // puts here in production.
      `token ${JWT} was rejected`,
      412,
    );
    expect(describeCalibrationFailure(error)).toEqual({
      errorCode: 'revisionConflict',
      httpStatus: 412,
    });
  });

  it('reads the typed code from a CalibrationEngineError', () => {
    expect(
      describeCalibrationFailure(
        new CalibrationEngineError('CAPABILITIES_MISMATCH', 'nope'),
      ),
    ).toEqual({ errorCode: 'CAPABILITIES_MISMATCH' });
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['an unknown code', Object.assign(new Error('x'), { code: 'ENOENT' })],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('classifies %s as unexpected', (_label, thrown) => {
    expect(describeCalibrationFailure(thrown).errorCode).toBe('unexpected');
  });

  it('keeps the backend detail out of the classification result', () => {
    const error = new CalibrationHttpError('server', `leak ${JWT}`, 500);
    const record = buildCalibrationLogRecord({
      level: 'error',
      component: 'calibration.http',
      event: 'generation.requested',
      ...describeCalibrationFailure(error),
    });
    // The claim.
    expect(naiveEmit(record)).not.toContain(JWT);
    // The control: the error genuinely carries the secret, so a logger that
    // reached for `message` — as the ad-hoc `console.error(tag, error)` calls
    // did — would have emitted it.
    expect(error.message).toContain(JWT);
    expect(naiveEmit({ message: error.message })).toContain(JWT);
  });
});

describe('sink', () => {
  it('routes emitted records to the capture sink and restores the previous one', () => {
    const capture = captureCalibrationLogs();
    emitCalibrationLog({
      level: 'info',
      component: 'calibration.engine',
      event: 'sync.completed',
      correlationId: 'corr-9',
      outcome: 'ok',
    });
    capture.stop();
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]?.correlationId).toBe('corr-9');
    // After `stop` the capture must no longer receive records, or a later test
    // could assert against another test's output.
    const second = captureCalibrationLogs();
    emitCalibrationLog({
      level: 'info',
      component: 'calibration.engine',
      event: 'sync.completed',
    });
    second.stop();
    expect(second.records).toHaveLength(1);
    expect(capture.records).toHaveLength(1);
  });
});
