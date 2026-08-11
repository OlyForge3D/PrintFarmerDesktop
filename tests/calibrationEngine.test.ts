/**
 * CalibrationSyncEngine tests (issue #52).
 *
 * Tests:
 * - Ordered outbox push in stable sequence order.
 * - Exact replay accepted as success (idempotent re-send).
 * - Typed conflict recording stops push for that project.
 * - Cursor-based pull to completion (multipage).
 * - Tombstones applied without REST fetch.
 * - REST authority after reconnect (SignalR gap).
 * - Prerequisite checks for generation/queue/print-start.
 * - Cancellation during sync.
 * - Capability validation failure (unsupported firmware/slicer).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationSyncEngine,
  type CalibrationPendingOperation,
  type CalibrationSidecar,
  type CalibrationCursorState,
  type CalibrationProfileService,
} from '../src/main/calibrationEngine.js';
import type { CalibrationHttpClient } from '../src/main/calibrationHttp.js';
import { CalibrationHttpError } from '../src/main/calibrationHttp.js';
import type { CalibrationConflict } from '@shared/ipc';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const BASE_URL = 'http://farm.local';
const BINDING = 'binding-abc';

// --- Fake collaborators ---

function fakeCapabilities() {
  return {
    apiVersion: '1.0',
    schemaVersion: '1.0',
    apiContractVersion: '1.0',
    grantedScopes: ['calibration:read', 'calibration:update'],
    supportedFirmwareFamilies: ['Klipper'],
    supportedGcodeDialects: ['Klipper'],
    supportedSlicerEngines: [
      {
        type: 'OrcaSlicer',
        version: '2.3.1',
        distribution: 'upstream',
        supported: true,
      },
    ],
    flags: {
      calibrationApiEnabled: true,
      calibrationChangeFeedEnabled: true,
      calibrationOfflineDraftEnabled: true,
      calibrationPhotoUploadEnabled: true,
      calibrationGenerationEnabled: true,
    },
  };
}

function makeOp(
  sequence: number,
  overrides: Partial<CalibrationPendingOperation> = {},
): CalibrationPendingOperation {
  return {
    operationId: `op-${sequence}`,
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    kind: 'saveProjectDraft',
    sequence,
    baseRevision: null,
    idempotencyKey: `hash-${sequence}`,
    entityType: 'CalibrationProject',
    entityId: PROJECT_ID,
    operationKind: 'Update',
    payload: { displayName: `Draft ${sequence}` },
    dependsOn: [],
    ...overrides,
  };
}

function fakeSidecar(
  overrides: Partial<CalibrationSidecar> = {},
): CalibrationSidecar {
  return {
    listCalibrationPendingOperations: vi.fn().mockResolvedValue([]),
    settleCalibrationOperation: vi.fn().mockResolvedValue(undefined),
    replayCalibrationOperation: vi.fn().mockResolvedValue(undefined),
    recordCalibrationConflict: vi.fn().mockResolvedValue(undefined),
    getCalibrationCursorState: vi.fn().mockResolvedValue({
      cursor: null,
      serverRevision: 0,
      checkpointGeneration: 0,
    } satisfies CalibrationCursorState),
    commitCalibrationCursor: vi.fn().mockResolvedValue(undefined),
    applyCalibrationSnapshot: vi.fn().mockResolvedValue(undefined),
    listCalibrationConflicts: vi.fn().mockResolvedValue([]),
    countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
    isPrinterContextFresh: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function fakeProfileService(
  overrides: Partial<CalibrationProfileService> = {},
): CalibrationProfileService {
  return {
    list: vi.fn().mockResolvedValue({
      profiles: [{ id: PROFILE_ID, baseUrl: BASE_URL }],
      selectedProfileId: PROFILE_ID,
    }),
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      binding: BINDING,
    }),
    ...overrides,
  };
}

function fakeHttp(
  overrides: Partial<Record<keyof CalibrationHttpClient, unknown>> = {},
): CalibrationHttpClient {
  return {
    getCapabilities: vi.fn().mockResolvedValue(fakeCapabilities()),
    getChanges: vi.fn().mockResolvedValue({
      changes: [],
      nextCursor: null,
      hasMore: false,
      serverRevision: 0,
    }),
    apply: vi
      .fn()
      .mockResolvedValue({ kind: 'success', value: { serverRevision: 1 } }),
    getProject: vi.fn().mockResolvedValue(null),
    getProjectSteps: vi.fn().mockResolvedValue([]),
    getAttempt: vi.fn().mockResolvedValue(null),
    getPhoto: vi.fn().mockResolvedValue(null),
    getPrinters: vi.fn().mockResolvedValue([]),
    getPrinterContext: vi.fn().mockResolvedValue(null),
    uploadPhoto: vi.fn().mockResolvedValue(undefined),
    startGeneration: vi.fn().mockResolvedValue({ generationJobId: 'job-123' }),
    acknowledgeBedClear: vi.fn().mockResolvedValue(undefined),
    startPrint: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    ...overrides,
  } as unknown as CalibrationHttpClient;
}

function createEngine(
  http: CalibrationHttpClient,
  sidecar: CalibrationSidecar,
  profileService: CalibrationProfileService = fakeProfileService(),
) {
  return new CalibrationSyncEngine(http, sidecar, profileService);
}

// ==========================================================================
// Ordered outbox push
// ==========================================================================

describe('CalibrationSyncEngine outbox push', () => {
  it.each([
    { label: 'new', operationKind: 'Create' as const, baseRevision: null },
    { label: 'existing', operationKind: 'Update' as const, baseRevision: 8 },
  ])(
    'syncs only the latest coalesced $label-project autosave',
    async ({ operationKind, baseRevision }) => {
      // SQLite preserves all three rows but exposes only operation 3 as pending.
      const latest = makeOp(3, {
        operationKind,
        baseRevision,
        payload: { displayName: 'Draft 3', autosaveRevision: 3 },
      });
      const sidecar = fakeSidecar({
        listCalibrationPendingOperations: vi
          .fn()
          .mockResolvedValueOnce([latest])
          .mockResolvedValueOnce([]),
      });
      let remoteCreates = 0;
      const apply = vi.fn().mockImplementation(
        (
          _profileId: string,
          _baseUrl: string,
          request: {
            operations: Array<{
              operationKind: 'Create' | 'Update';
              payload: unknown;
            }>;
          },
        ) => {
          if (request.operations[0]!.operationKind === 'Create') {
            remoteCreates += 1;
          }
          return Promise.resolve({
            kind: 'success',
            value: { serverRevision: 9, appliedOperationIds: ['op-3'] },
          });
        },
      );
      const engine = createEngine(fakeHttp({ apply }), sidecar);

      const { status } = await engine.syncNow(
        PROFILE_ID,
        PROJECT_ID,
        AbortSignal.timeout(5_000),
      );

      expect(status.pushedOperations).toBe(1);
      expect(apply).toHaveBeenCalledTimes(1);
      const applyRequest = apply.mock.calls[0]![2] as {
        operations: Array<{ payload: unknown }>;
      };
      expect(applyRequest.operations[0]!.payload).toEqual({
        displayName: 'Draft 3',
        autosaveRevision: 3,
      });
      expect(remoteCreates).toBe(operationKind === 'Create' ? 1 : 0);
    },
  );

  it('pushes operations in stable sequence order', async () => {
    const ops = [makeOp(1), makeOp(2), makeOp(3)];
    const listOps = vi
      .fn()
      .mockResolvedValueOnce(ops)
      .mockResolvedValueOnce([]);
    const settle = vi.fn().mockResolvedValue(undefined);

    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: listOps,
      settleCalibrationOperation: settle,
    });
    const applyMock = vi
      .fn()
      .mockResolvedValue({ kind: 'success', value: { serverRevision: 10 } });
    const http = fakeHttp({ apply: applyMock });

    const engine = createEngine(http, sidecar);
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('succeeded');
    expect(status.pushedOperations).toBe(3);

    // Operations sent in sequence order
    const operationIds = applyMock.mock.calls.map((call: unknown[]) => {
      const req = call[2] as { operations: Array<{ operationId: string }> };
      return req.operations[0]?.operationId;
    });
    expect(operationIds).toEqual(['op-1', 'op-2', 'op-3']);
  });

  it('accepts exact replay as success (idempotent re-send)', async () => {
    // 409 with the same operationId = exact replay — treated as success
    const ops = [makeOp(1)];
    const listOps = vi
      .fn()
      .mockResolvedValueOnce(ops)
      .mockResolvedValueOnce([]);
    const settle = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: listOps,
      settleCalibrationOperation: settle,
    });

    // Replay: server returns success (exact replay is treated as success by the HTTP layer)
    const applyMock = vi.fn().mockResolvedValue({
      kind: 'success',
      value: { serverRevision: 5, appliedOperationIds: ['op-1'] },
    });
    const http = fakeHttp({ apply: applyMock });

    const engine = createEngine(http, sidecar);
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.pushedOperations).toBe(1);
    expect(settle).toHaveBeenCalledWith(PROFILE_ID, 'op-1', 5);
  });

  it('records conflict and stops pushing on conflict response', async () => {
    const ops = [makeOp(1), makeOp(2)];
    const listOps = vi
      .fn()
      .mockResolvedValueOnce(ops)
      .mockResolvedValueOnce([]);
    const recordConflict = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: listOps,
      recordCalibrationConflict: recordConflict,
      listCalibrationConflicts: vi
        .fn()
        .mockResolvedValue([{ conflictId: 'c1' } as CalibrationConflict]),
    });

    const applyMock = vi.fn().mockResolvedValue({
      kind: 'conflict',
      value: {
        conflictedOperationId: 'op-1',
        entityType: 'CalibrationProject',
        entityId: PROJECT_ID,
        serverRevision: 3,
        reason: 'Concurrent modification.',
      },
    });
    const http = fakeHttp({ apply: applyMock });

    const engine = createEngine(http, sidecar);
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('partialConflict');
    expect(status.conflictCount).toBe(1);
    // Only one apply attempted (stopped after conflict)
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(recordConflict).toHaveBeenCalledWith(
      PROFILE_ID,
      'op-1',
      expect.objectContaining({ reason: 'Concurrent modification.' }),
    );
  });
});

// ==========================================================================
// Cursor-based pull to completion (multipage)
// ==========================================================================

describe('CalibrationSyncEngine pull phase', () => {
  it('pulls multiple pages until hasMore is false', async () => {
    const getChanges = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [
          {
            revision: 1,
            entityType: 'CalibrationProject',
            entityId: PROJECT_ID,
            operation: 'Updated',
            projectId: PROJECT_ID,
            actorUserId: 'user-1',
            timestamp: '2026-07-26T06:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-page-2',
        hasMore: true,
        serverRevision: 1,
      })
      .mockResolvedValueOnce({
        changes: [
          {
            revision: 2,
            entityType: 'CalibrationAttempt',
            entityId: 'attempt-1',
            operation: 'Created',
            projectId: PROJECT_ID,
            actorUserId: 'user-1',
            timestamp: '2026-07-26T06:00:01.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
        serverRevision: 2,
      });

    const commitCursor = vi.fn().mockResolvedValue(undefined);
    const applySnapshot = vi.fn().mockResolvedValue(undefined);
    const getCursor = vi.fn().mockResolvedValue({
      cursor: null,
      serverRevision: 0,
      checkpointGeneration: 0,
    });

    const sidecar = fakeSidecar({
      getCalibrationCursorState: getCursor,
      commitCalibrationCursor: commitCursor,
      applyCalibrationSnapshot: applySnapshot,
    });
    const http = fakeHttp({ getChanges });

    const engine = createEngine(http, sidecar);
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('succeeded');
    expect(status.pulledChanges).toBe(2);
    // Cursor committed after each page
    expect(commitCursor).toHaveBeenCalledTimes(2);
    // First commit with page-1 cursor
    expect(commitCursor).toHaveBeenNthCalledWith(
      1,
      PROFILE_ID,
      PROJECT_ID,
      'cursor-page-2',
      1,
      1,
    );
  });

  it('applies tombstones without REST fetch for Deleted operations', async () => {
    const getChanges = vi.fn().mockResolvedValueOnce({
      changes: [
        {
          revision: 5,
          entityType: 'CalibrationPhoto',
          entityId: 'photo-1',
          operation: 'Deleted',
          projectId: PROJECT_ID,
          actorUserId: 'user-1',
          timestamp: '2026-07-26T06:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
      serverRevision: 5,
    });
    const getPhoto = vi.fn();
    const applySnapshot = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({ applyCalibrationSnapshot: applySnapshot });
    const http = fakeHttp({ getChanges, getPhoto });

    const engine = createEngine(http, sidecar);
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // Tombstone applied without calling getPhoto
    expect(getPhoto).not.toHaveBeenCalled();
    expect(applySnapshot).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationPhoto',
      'photo-1',
      null,
      true,
      5,
    );
  });

  it('applies tombstone when REST returns 404 for a created entity', async () => {
    const getChanges = vi.fn().mockResolvedValueOnce({
      changes: [
        {
          revision: 3,
          entityType: 'CalibrationProject',
          entityId: PROJECT_ID,
          operation: 'Updated',
          projectId: PROJECT_ID,
          actorUserId: 'user-1',
          timestamp: '2026-07-26T06:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
      serverRevision: 3,
    });
    const getProject = vi.fn().mockResolvedValue(null); // 404 → null
    const applySnapshot = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({ applyCalibrationSnapshot: applySnapshot });
    const http = fakeHttp({ getChanges, getProject });

    const engine = createEngine(http, sidecar);
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // Entity not found → tombstone
    expect(applySnapshot).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationProject',
      PROJECT_ID,
      null,
      true,
      3,
    );
  });

  it('commits cursor atomically after each page', async () => {
    const getChanges = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [],
        nextCursor: 'cursor-1',
        hasMore: true,
        serverRevision: 1,
      })
      .mockResolvedValueOnce({
        changes: [],
        nextCursor: 'cursor-2',
        hasMore: false,
        serverRevision: 2,
      });
    const commitCursor = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({ commitCalibrationCursor: commitCursor });
    const http = fakeHttp({ getChanges });

    const engine = createEngine(http, sidecar);
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    expect(commitCursor).toHaveBeenCalledTimes(2);
    expect(commitCursor.mock.calls[0]?.[2]).toBe('cursor-1');
    expect(commitCursor.mock.calls[1]?.[2]).toBe('cursor-2');
  });
});

// ==========================================================================
// REST authority after reconnect / SignalR gap
// ==========================================================================

describe('CalibrationSyncEngine REST authority (SignalR hint vs REST)', () => {
  it('hydrates via REST regardless of whether a SignalR event was received', async () => {
    // The engine always uses REST as the authoritative source after reconnect.
    // Even if a SignalR hint says "project updated", the engine fetches REST.
    const getChanges = vi.fn().mockResolvedValueOnce({
      changes: [
        {
          revision: 7,
          entityType: 'CalibrationProject',
          entityId: PROJECT_ID,
          operation: 'Updated',
          projectId: PROJECT_ID,
          actorUserId: 'user-1',
          timestamp: '2026-07-26T06:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
      serverRevision: 7,
    });
    const projectSnapshot = {
      id: PROJECT_ID,
      displayName: 'Updated by Server',
      revision: 7,
    };
    const getProject = vi.fn().mockResolvedValue(projectSnapshot);
    const applySnapshot = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({ applyCalibrationSnapshot: applySnapshot });
    const http = fakeHttp({ getChanges, getProject });

    const engine = createEngine(http, sidecar);
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // REST was called for the authoritative aggregate
    expect(getProject).toHaveBeenCalledWith(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      expect.any(AbortSignal),
    );
    // REST snapshot was applied
    expect(applySnapshot).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationProject',
      PROJECT_ID,
      projectSnapshot,
      false,
      7,
    );
  });
});

// ==========================================================================
// Prerequisite checks for online actions
// ==========================================================================

describe('CalibrationSyncEngine online action prerequisite checks', () => {
  it('blocks online actions when pending operations exist', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(3),
    });
    const engine = createEngine(fakeHttp(), sidecar);

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(reason).toContain('3 outbox operation(s)');
  });

  it('blocks online actions when printer context is stale', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
      isPrinterContextFresh: vi.fn().mockResolvedValue(false),
    });
    const engine = createEngine(fakeHttp(), sidecar);

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(reason).toContain('stale');
  });

  it('blocks online actions when unresolved conflicts exist', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
      isPrinterContextFresh: vi.fn().mockResolvedValue(true),
      listCalibrationConflicts: vi
        .fn()
        .mockResolvedValue([
          { conflictId: 'c1' } as CalibrationConflict,
          { conflictId: 'c2' } as CalibrationConflict,
        ]),
    });
    const engine = createEngine(fakeHttp(), sidecar);

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(reason).toContain('2 unresolved conflict(s)');
  });

  it('returns null (allowed) when all prerequisites are met', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
      isPrinterContextFresh: vi.fn().mockResolvedValue(true),
      listCalibrationConflicts: vi.fn().mockResolvedValue([]),
    });
    const engine = createEngine(fakeHttp(), sidecar);

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(reason).toBeNull();
  });
});

// ==========================================================================
// Capability validation failure
// ==========================================================================

describe('CalibrationSyncEngine capability validation', () => {
  it('fails sync when capabilities endpoint is not found', async () => {
    const http = fakeHttp({
      getCapabilities: vi
        .fn()
        .mockRejectedValue(
          new CalibrationHttpError('notFound', 'Capabilities not found.', 404),
        ),
    });
    const sidecar = fakeSidecar();
    const engine = createEngine(http, sidecar);

    const { status } = await engine.syncNow(
      PROFILE_ID,
      null,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('Calibration API is not available');
  });

  it('fails sync when firmware requirement is not Klipper', async () => {
    const caps = {
      ...fakeCapabilities(),
      supportedFirmwareFamilies: ['Marlin'],
      supportedGcodeDialects: ['Marlin'],
    };
    const http = fakeHttp({ getCapabilities: vi.fn().mockResolvedValue(caps) });
    const engine = createEngine(http, fakeSidecar());

    const { status } = await engine.syncNow(
      PROFILE_ID,
      null,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('Klipper');
  });

  it('fails sync when upstream slicer is not OrcaSlicer', async () => {
    const caps = {
      ...fakeCapabilities(),
      supportedSlicerEngines: [
        {
          type: 'PrusaSlicer',
          version: '2.8.0',
          distribution: 'upstream',
          supported: true,
        },
      ],
    };
    const http = fakeHttp({ getCapabilities: vi.fn().mockResolvedValue(caps) });
    const engine = createEngine(http, fakeSidecar());

    const { status } = await engine.syncNow(
      PROFILE_ID,
      null,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('OrcaSlicer');
  });

  it('fails sync when a required capability flag is false', async () => {
    const caps = {
      ...fakeCapabilities(),
      flags: { ...fakeCapabilities().flags, calibrationApiEnabled: false },
    };
    const http = fakeHttp({ getCapabilities: vi.fn().mockResolvedValue(caps) });
    const engine = createEngine(http, fakeSidecar());

    const { status } = await engine.syncNow(
      PROFILE_ID,
      null,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('calibrationApiEnabled');
  });

  it('fails when no profile service authentication context is available', async () => {
    const profileService: CalibrationProfileService = {
      list: vi.fn().mockResolvedValue({
        profiles: [{ id: PROFILE_ID, baseUrl: BASE_URL }],
        selectedProfileId: PROFILE_ID,
      }),
      // getAuthenticatedContext intentionally omitted
    };
    const engine = createEngine(fakeHttp(), fakeSidecar(), profileService);

    const { status } = await engine.syncNow(
      PROFILE_ID,
      null,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
  });
});

// ==========================================================================
// Cancellation during sync
// ==========================================================================

describe('CalibrationSyncEngine cancellation', () => {
  it('returns failed phase when signal is aborted before sync starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const getCapabilities = vi.fn().mockResolvedValue(fakeCapabilities());
    const http = fakeHttp({ getCapabilities });
    const engine = createEngine(http, fakeSidecar());

    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      controller.signal,
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('ancel');
  });

  it('throws when engine is disposed', async () => {
    const engine = createEngine(fakeHttp(), fakeSidecar());
    engine.dispose();

    await expect(
      engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});
