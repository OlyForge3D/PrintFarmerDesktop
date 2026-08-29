/**
 * Calibration integration tests (issue #52) — iteration 2.
 *
 * Tests the full calibration runtime stack:
 * - ServerProfileCalibrationTokenProvider adapter (profile service → HTTP auth)
 * - SidecarCalibrationAdapter (sidecar client → CalibrationSidecar interface)
 * - CalibrationHttpClient integration (token refresh, identity fencing, error mapping)
 * - CalibrationSyncEngine integration (push/pull/conflict/cursor semantics)
 * - IPC handler wiring (handler → engine → HTTP → sidecar)
 *
 * Acceptance criteria covered:
 * #3  HTTP client uses ServerProfileService.getAuthenticatedContext()
 * #6  Sync validates, pushes, pulls, commits
 * #12 Automated coverage: refresh/fencing/timeouts/cancellation/body limits/
 *     error mapping, outbox lease/retry/replay/idempotency, cursor/tombstone/
 *     gap handling, two-device divergent offline resolution convergence E2E,
 *     photo staging/retry/hash/conflict retention, renderer generic privilege denial
 */

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import {
  ServerProfileCalibrationTokenProvider,
  SidecarCalibrationAdapter,
} from '../src/main/calibrationService.js';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  CalibrationSyncEngine,
  type CalibrationSidecar,
  type CalibrationProfileService,
  type CalibrationPendingOperation,
  type CalibrationCursorState,
} from '../src/main/calibrationEngine.js';
import {
  ipcSchemas,
  IpcChannel,
  CalibrationConflict,
  CalibrationSyncStatus,
} from '@shared/ipc';
import type { CalibrationConflict as CalibrationConflictType } from '@shared/ipc';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const STEP_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OP_ID = '55555555-5555-4555-8555-555555555555';
const BINDING = 'binding-abc123-def456';
const BASE_URL = 'http://farm.local';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.test-token';
const NOW = '2026-07-26T06:00:00.000Z';

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

function fakeCursor(
  overrides: Partial<CalibrationCursorState> = {},
): CalibrationCursorState {
  return {
    cursor: null,
    serverRevision: 0,
    checkpointGeneration: 0,
    ...overrides,
  };
}

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
      calibrationArtifactPromotionEnabled: true,
    },
  };
}

function emptyChangesPage(cursor: string | null = null) {
  return { changes: [], nextCursor: cursor, hasMore: false, serverRevision: 0 };
}

// ---------------------------------------------------------------------------
// Fake collaborators
// ---------------------------------------------------------------------------

function fakeSidecar(
  overrides: Partial<CalibrationSidecar> = {},
): CalibrationSidecar {
  return {
    listCalibrationPendingOperations: vi.fn().mockResolvedValue([]),
    settleCalibrationOperation: vi.fn().mockResolvedValue(undefined),
    replayCalibrationOperation: vi.fn().mockResolvedValue(undefined),
    recordCalibrationConflict: vi.fn().mockResolvedValue(undefined),
    getCalibrationCursorState: vi.fn().mockResolvedValue(fakeCursor()),
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

function fakeTokenProvider(
  overrides: Partial<CalibrationTokenProvider> = {},
): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: TOKEN,
      binding: BINDING,
    }),
    ...overrides,
  };
}

function fakeHttp(
  overrides: Partial<Record<keyof CalibrationHttpClient, any>> = {},
): CalibrationHttpClient {
  return {
    getCapabilities: vi.fn().mockResolvedValue(fakeCapabilities()),
    getChanges: vi.fn().mockResolvedValue(emptyChangesPage()),
    apply: vi
      .fn()
      .mockResolvedValue({ kind: 'success', value: { serverRevision: 1 } }),
    getProject: vi.fn().mockResolvedValue(null),
    getAttempt: vi.fn().mockResolvedValue(null),
    getPhoto: vi.fn().mockResolvedValue(null),
    getPrinters: vi.fn().mockResolvedValue([]),
    getPrinterContext: vi.fn().mockResolvedValue(null),
    uploadPhoto: vi.fn().mockResolvedValue(undefined),
    acknowledgeBedClear: vi.fn().mockResolvedValue(undefined),
    startPrint: vi.fn().mockResolvedValue({ jobId: 'print-123' }),
    ...overrides,
  } as unknown as CalibrationHttpClient;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ==========================================================================
// ServerProfileCalibrationTokenProvider adapter
// ==========================================================================

describe('ServerProfileCalibrationTokenProvider', () => {
  it('maps getAuthenticatedContext to profile service (normal path)', async () => {
    const mockProfiles = {
      getAuthenticatedContext: vi.fn().mockResolvedValue({
        profile: { baseUrl: BASE_URL, id: PROFILE_ID },
        token: TOKEN,
        serverBinding: BINDING,
        revision: 'rev-1',
        generation: 1,
        endpoint: () => new URL(BASE_URL),
      }),
    } as any;

    const provider = new ServerProfileCalibrationTokenProvider(mockProfiles);
    const ctx = await provider.getAuthenticatedContext(PROFILE_ID);

    expect(ctx.baseUrl).toBe(BASE_URL);
    expect(ctx.token).toBe(TOKEN);
    expect(ctx.binding).toBe(BINDING);
    expect(mockProfiles.getAuthenticatedContext).toHaveBeenCalledWith(
      PROFILE_ID,
    );
  });

  it('uses force-refresh path (getAuthenticatedServerContext) on forceRefresh=true', async () => {
    const mockProfiles = {
      getAuthenticatedContext: vi.fn(),
      getAuthenticatedServerContext: vi.fn().mockResolvedValue({
        baseUrl: BASE_URL,
        token: TOKEN + '-refreshed',
        binding: BINDING,
        profileId: PROFILE_ID,
        profileRevision: 'rev-2',
        authGeneration: 2,
        capabilities: null,
      }),
    } as any;

    const provider = new ServerProfileCalibrationTokenProvider(mockProfiles);
    const ctx = await provider.getAuthenticatedContext(
      PROFILE_ID,
      undefined,
      true,
    );

    expect(ctx.token).toBe(TOKEN + '-refreshed');
    expect(mockProfiles.getAuthenticatedServerContext).toHaveBeenCalledWith(
      PROFILE_ID,
      undefined,
      true,
    );
    expect(mockProfiles.getAuthenticatedContext).not.toHaveBeenCalled();
  });

  it('throws when baseUrl changed from expected (identity fence)', async () => {
    const mockProfiles = {
      getAuthenticatedContext: vi.fn().mockResolvedValue({
        profile: { baseUrl: 'http://new-server.local', id: PROFILE_ID },
        token: TOKEN,
        serverBinding: BINDING,
        revision: 'rev-1',
        generation: 1,
        endpoint: () => new URL('http://new-server.local'),
      }),
    } as any;

    const provider = new ServerProfileCalibrationTokenProvider(mockProfiles);
    await expect(
      provider.getAuthenticatedContext(PROFILE_ID, BASE_URL),
    ).rejects.toThrow();
  });
});

// ==========================================================================
// SidecarCalibrationAdapter
// ==========================================================================

describe('SidecarCalibrationAdapter', () => {
  it('listCalibrationPendingOperations parses raw sidecar output', async () => {
    const raw = [
      {
        operationId: OP_ID,
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        kind: 'saveProjectDraft',
        sequence: 1,
        baseRevision: null,
        idempotencyKey: 'hash-abc',
        entityType: 'CalibrationProject',
        entityId: PROJECT_ID,
        operationKind: 'Update',
        payload: { displayName: 'Test' },
        dependsOn: [],
      },
    ];
    const sidecarClient = {
      listCalibrationPendingOps: vi.fn().mockResolvedValue(raw),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const ops = await adapter.listCalibrationPendingOperations(
      PROFILE_ID,
      PROJECT_ID,
      50,
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]!.operationId).toBe(OP_ID);
    expect(ops[0]!.operationKind).toBe('Update');
    expect(sidecarClient.listCalibrationPendingOps).toHaveBeenCalledWith(
      PROFILE_ID,
      PROJECT_ID,
      50,
    );
  });

  it('settleCalibrationOperation delegates to sidecar', async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const sidecarClient = { settleCalibrationOp: settle } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    await adapter.settleCalibrationOperation(PROFILE_ID, OP_ID, 42);

    expect(settle).toHaveBeenCalledWith(PROFILE_ID, OP_ID, 42);
  });

  it('replayCalibrationOperation delegates to sidecar', async () => {
    const replay = vi.fn().mockResolvedValue(undefined);
    const sidecarClient = { replayCalibrationOp: replay } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    await adapter.replayCalibrationOperation(PROFILE_ID, OP_ID);

    expect(replay).toHaveBeenCalledWith(PROFILE_ID, OP_ID);
  });

  it('recordCalibrationConflict delegates entity type, reason, revision, and conflict kind', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const sidecarClient = { recordCalibrationConflict: record } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    await adapter.recordCalibrationConflict(PROFILE_ID, OP_ID, {
      entityType: 'CalibrationProject',
      entityId: PROJECT_ID,
      reason: 'Concurrent edit',
      serverRevision: 7,
      conflictKind: 'projectMetadata',
    });

    expect(record).toHaveBeenCalledWith(
      PROFILE_ID,
      OP_ID,
      'CalibrationProject',
      PROJECT_ID,
      'Concurrent edit',
      7,
      'projectMetadata',
    );
  });

  it('recordCalibrationConflict passes undefined conflict kind through for unclassified entity types', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const sidecarClient = { recordCalibrationConflict: record } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    await adapter.recordCalibrationConflict(PROFILE_ID, OP_ID, {
      entityType: 'CalibrationPhoto',
      entityId: PROJECT_ID,
      reason: 'Concurrent edit',
      serverRevision: 7,
      conflictKind: null,
    });

    expect(record).toHaveBeenCalledWith(
      PROFILE_ID,
      OP_ID,
      'CalibrationPhoto',
      PROJECT_ID,
      'Concurrent edit',
      7,
      undefined,
    );
  });

  it('getCalibrationCursorState parses cursor/revision/generation', async () => {
    const getCursor = vi.fn().mockResolvedValue({
      cursor: 'opaque-cursor-abc',
      serverRevision: 5,
      checkpointGeneration: 3,
    });
    const sidecarClient = { getCalibrationCursorState: getCursor } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const state = await adapter.getCalibrationCursorState(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(state.cursor).toBe('opaque-cursor-abc');
    expect(state.serverRevision).toBe(5);
    expect(state.checkpointGeneration).toBe(3);
  });

  it('commitCalibrationCursor passes all fields', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const sidecarClient = { commitCalibrationCursor: commit } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    await adapter.commitCalibrationCursor(
      PROFILE_ID,
      PROJECT_ID,
      'cursor-2',
      10,
      4,
    );

    expect(commit).toHaveBeenCalledWith(
      PROFILE_ID,
      PROJECT_ID,
      'cursor-2',
      10,
      4,
    );
  });

  it('listCalibrationConflicts reads the ratified kind from conflictKind, not entityType', async () => {
    const raw = [
      {
        conflictId: '66666666-6666-4666-8666-666666666666',
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        entityType: 'CalibrationStep',
        conflictKind: 'stepDraft',
        entityId: STEP_ID,
        operationId: OP_ID,
        serverRevision: 3,
        createdAt: NOW,
        // What the store (Rust) actually permits for stepDraft, per
        // `CalibrationConflictKind::available_resolutions` -- carried on the
        // wire, not recomputed here (issue #304).
        availableResolutions: [
          'acceptServer',
          'keepLocalAsNewRevision',
          'manualFieldMerge',
        ],
      },
    ];
    const sidecarClient = {
      listCalibrationConflicts: vi.fn().mockResolvedValue(raw),
      // Presence (of any shape) is what the adapter gates advertising on --
      // see `supportsConflictResolution`/`conflictResolutionsFor`.
      resolveCalibrationConflict: vi.fn(),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe('stepDraft');
    expect(conflicts[0]!.entityId).toBe(STEP_ID);
    // Not toContain('acceptServer'): that passed against a hard-coded literal in
    // the adapter, so it held whatever the conflict was and whether or not any
    // resolution could run.
    //
    // The set is now exactly what the wire payload carried, because the
    // adapter no longer holds an opinion about per-kind policy at all -- it
    // only gates on transport capability. Asserting the exact set (rather
    // than "non-empty") is what keeps this from passing against an adapter
    // that offers everything to everyone, or drops the wire value on the
    // floor and returns something else entirely.
    expect(conflicts[0]!.availableResolutions).toEqual([
      'acceptServer',
      'keepLocalAsNewRevision',
      'manualFieldMerge',
    ]);
  });

  it('listCalibrationConflicts carries the payloads the sidecar returns', async () => {
    const raw = [
      {
        conflictId: '66666666-6666-4666-8666-666666666666',
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        entityType: 'CalibrationStep',
        conflictKind: 'stepDraft',
        entityId: STEP_ID,
        operationId: OP_ID,
        localPayload: { displayName: 'Local name' },
        serverPayload: { displayName: 'Server name' },
        serverRevision: 3,
        createdAt: NOW,
      },
    ];
    const sidecarClient = {
      listCalibrationConflicts: vi.fn().mockResolvedValue(raw),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    // The difference between local and server is the only thing a conflict UI
    // can show. The adapter used to return null here regardless of input.
    expect(conflicts[0]!.localPayloadSummary).toBe(
      '{"displayName":"Local name"}',
    );
    expect(conflicts[0]!.serverPayloadSummary).toBe(
      '{"displayName":"Server name"}',
    );
  });

  it('listCalibrationConflicts bounds an oversized payload to the IPC contract', async () => {
    const raw = [
      {
        conflictId: '66666666-6666-4666-8666-666666666666',
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        entityType: 'CalibrationProject',
        conflictKind: 'projectMetadata',
        entityId: PROJECT_ID,
        operationId: OP_ID,
        localPayload: { note: 'x'.repeat(8000) },
        serverPayload: null,
        serverRevision: 3,
        createdAt: NOW,
      },
    ];
    const sidecarClient = {
      listCalibrationConflicts: vi.fn().mockResolvedValue(raw),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    const summary = conflicts[0]!.localPayloadSummary!;
    expect(summary.length).toBe(4096);
    expect(summary.endsWith('...')).toBe(true);
    expect(conflicts[0]!.serverPayloadSummary).toBeNull();
    // The bounded value must still satisfy the schema the main process parses
    // the list response against, or the whole response is rejected.
    expect(() => CalibrationConflict.parse(conflicts[0])).not.toThrow();
  });

  it('countCalibrationPendingOperations returns numeric count', async () => {
    const sidecarClient = {
      countCalibrationPendingOps: vi.fn().mockResolvedValue(7),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const count = await adapter.countCalibrationPendingOperations(
      PROFILE_ID,
      PROJECT_ID,
    );

    expect(count).toBe(7);
  });

  it('isPrinterContextFresh delegates and returns boolean', async () => {
    const sidecarClient = {
      isCalibrationPrinterContextFresh: vi.fn().mockResolvedValue(true),
    } as any;
    const adapter = new SidecarCalibrationAdapter(sidecarClient);
    const fresh = await adapter.isPrinterContextFresh(PROFILE_ID, PROJECT_ID);

    expect(fresh).toBe(true);
    expect(sidecarClient.isCalibrationPrinterContextFresh).toHaveBeenCalledWith(
      PROFILE_ID,
      PROJECT_ID,
    );
  });
});

// ==========================================================================
// CalibrationSyncEngine integration with real adapters (mocked HTTP/sidecar)
// ==========================================================================

describe('CalibrationSyncEngine integration', () => {
  it('syncNow runs push → pull with real engine, resolves to succeeded', async () => {
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: vi
        .fn()
        .mockResolvedValueOnce([makeOp(1)])
        .mockResolvedValue([]),
    });
    const http = fakeHttp();
    const profileService = fakeProfileService();
    const engine = new CalibrationSyncEngine(http, sidecar, profileService);

    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('succeeded');
    expect(status.pushedOperations).toBe(1);
    expect(http.apply).toHaveBeenCalledTimes(1);
    expect(sidecar.settleCalibrationOperation).toHaveBeenCalledWith(
      PROFILE_ID,
      'op-1',
      1,
    );
  });

  it('syncNow stops pushing when a conflict is recorded', async () => {
    const ops = [makeOp(1), makeOp(2)];
    const conflictRecord: CalibrationConflictType = {
      conflictId: '66666666-6666-4666-8666-666666666666',
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      kind: 'projectMetadata',
      entityId: PROJECT_ID,
      localPayloadSummary: null,
      serverPayloadSummary: null,
      serverRevision: 1,
      availableResolutions: ['acceptServer', 'keepLocalAsNewRevision'],
      resolvedAt: null,
      resolution: null,
      createdAt: NOW,
    };
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: vi
        .fn()
        .mockResolvedValueOnce(ops)
        .mockResolvedValue([]),
      listCalibrationConflicts: vi.fn().mockResolvedValue([conflictRecord]),
    });
    const http = fakeHttp({
      apply: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'conflict',
          value: {
            conflictedOperationId: 'op-1',
            entityType: 'CalibrationProject',
            entityId: PROJECT_ID,
            serverRevision: 1,
            reason: 'Concurrent edit',
          },
        })
        .mockResolvedValue({ kind: 'success', value: { serverRevision: 2 } }),
    });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    // Conflict stops push; op-2 is NOT pushed
    expect(http.apply).toHaveBeenCalledTimes(1);
    expect(sidecar.recordCalibrationConflict).toHaveBeenCalledWith(
      PROFILE_ID,
      'op-1',
      expect.objectContaining({ entityType: 'CalibrationProject' }),
    );
    expect(status.conflictCount).toBe(1);
  });

  it('syncNow pulls multipage changes and commits cursor after each page', async () => {
    const page1 = {
      changes: [
        {
          revision: 1,
          entityType: 'CalibrationProject',
          entityId: PROJECT_ID,
          operation: 'Updated',
          projectId: PROJECT_ID,
          actorUserId: '00000000-0000-4000-8000-000000000001',
          timestamp: NOW,
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: true,
      serverRevision: 1,
    };
    const page2 = {
      changes: [],
      nextCursor: null,
      hasMore: false,
      serverRevision: 2,
    };
    const getChanges = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const sidecar = fakeSidecar();
    const http = fakeHttp({ getChanges });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('succeeded');
    expect(status.pulledChanges).toBe(1);
    expect(sidecar.commitCalibrationCursor).toHaveBeenCalledTimes(2);
    // First page commits cursor-1
    expect(sidecar.commitCalibrationCursor).toHaveBeenCalledWith(
      PROFILE_ID,
      PROJECT_ID,
      'cursor-1',
      1,
      1,
    );
  });

  it('syncNow applies tombstones without fetching REST aggregate', async () => {
    const changes = [
      {
        revision: 5,
        entityType: 'CalibrationProject',
        entityId: PROJECT_ID,
        operation: 'Deleted',
        projectId: PROJECT_ID,
        actorUserId: '00000000-0000-4000-8000-000000000001',
        timestamp: NOW,
      },
    ];
    const getChanges = vi.fn().mockResolvedValueOnce({
      changes,
      nextCursor: null,
      hasMore: false,
      serverRevision: 5,
    });
    const sidecar = fakeSidecar();
    const http = fakeHttp({ getChanges });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // Tombstone applied directly — no REST fetch
    expect(http.getProject).not.toHaveBeenCalled();
    expect(sidecar.applyCalibrationSnapshot).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationProject',
      PROJECT_ID,
      null,
      true,
      5,
    );
  });

  it('syncNow is cancellable during push', async () => {
    const controller = new AbortController();
    const slowApply = vi.fn().mockImplementation(async () => {
      controller.abort();
      await new Promise((_, reject) =>
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 1),
      );
    });
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: vi.fn().mockResolvedValue([makeOp(1)]),
    });
    const http = fakeHttp({ apply: slowApply });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      controller.signal,
    );

    expect(status.phase).toBe('failed');
    expect(status.error).toMatch(/[Cc]ancel/);
  });

  it('checkOnlineActionPrerequisites blocks when pending operations exist', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(3),
    });
    const http = fakeHttp();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );
    expect(reason).toContain('3 outbox operation');
  });

  it('checkOnlineActionPrerequisites blocks when printer context is stale', async () => {
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
      isPrinterContextFresh: vi.fn().mockResolvedValue(false),
    });
    const http = fakeHttp();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );
    expect(reason).toContain('stale');
  });

  it('checkOnlineActionPrerequisites blocks when unresolved conflicts exist', async () => {
    const singleConflict: CalibrationConflictType = {
      conflictId: '66666666-6666-4666-8666-666666666666',
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      kind: 'projectMetadata',
      entityId: PROJECT_ID,
      localPayloadSummary: null,
      serverPayloadSummary: null,
      serverRevision: 1,
      availableResolutions: ['acceptServer'],
      resolvedAt: null,
      resolution: null,
      createdAt: NOW,
    };
    const sidecar = fakeSidecar({
      countCalibrationPendingOperations: vi.fn().mockResolvedValue(0),
      isPrinterContextFresh: vi.fn().mockResolvedValue(true),
      listCalibrationConflicts: vi.fn().mockResolvedValue([singleConflict]),
    });
    const http = fakeHttp();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );
    expect(reason).toContain('1 unresolved conflict');
  });

  it('checkOnlineActionPrerequisites returns null when all gates pass', async () => {
    const sidecar = fakeSidecar();
    const http = fakeHttp();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const reason = await engine.checkOnlineActionPrerequisites(
      PROFILE_ID,
      PROJECT_ID,
    );
    expect(reason).toBeNull();
  });

  it('validateProfileContext rejects unsupported firmware', async () => {
    const badCaps = {
      ...fakeCapabilities(),
      supportedFirmwareFamilies: ['Marlin'],
      supportedGcodeDialects: ['Marlin'],
    };
    const http = fakeHttp({
      getCapabilities: vi.fn().mockResolvedValue(badCaps),
    });
    const sidecar = fakeSidecar();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toMatch(/[Kk]lipper/);
  });

  it('validateProfileContext rejects unsupported slicer', async () => {
    const badCaps = {
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
    const http = fakeHttp({
      getCapabilities: vi.fn().mockResolvedValue(badCaps),
    });
    const sidecar = fakeSidecar();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toMatch(/OrcaSlicer/);
  });

  it('validateProfileContext rejects missing capability flags', async () => {
    const badCaps = {
      ...fakeCapabilities(),
      flags: { ...fakeCapabilities().flags, calibrationApiEnabled: false },
    };
    const http = fakeHttp({
      getCapabilities: vi.fn().mockResolvedValue(badCaps),
    });
    const sidecar = fakeSidecar();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );

    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('calibrationApiEnabled');
  });
});

// ==========================================================================
// CalibrationHttpClient — token refresh, identity fencing, error mapping
// ==========================================================================

describe('CalibrationHttpClient identity fencing and error mapping', () => {
  it('sends JWT in Authorization header (never in logs)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(printFarmerCapabilitiesResponse()));
    const tokens = fakeTokenProvider();
    const client = new CalibrationHttpClient(tokens, { fetch: fetchMock });
    await client.getCapabilities(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5000),
    );

    const call = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    // JWT present in authorization header, not in URL or logged
    expect(headers.authorization).toMatch(/^Bearer /);
    // URL must not contain token
    expect(call[0].toString()).not.toContain(TOKEN);
  });

  it('performs exactly one 401 refresh and retries', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response('Unauthorized', { status: 401 });
      return json(emptyChangesPage());
    });
    const getCtx = vi
      .fn()
      .mockResolvedValueOnce({
        baseUrl: BASE_URL,
        token: TOKEN,
        binding: BINDING,
      })
      .mockResolvedValueOnce({
        baseUrl: BASE_URL,
        token: TOKEN + '-refresh',
        binding: BINDING,
      })
      .mockResolvedValue({
        baseUrl: BASE_URL,
        token: TOKEN + '-refresh',
        binding: BINDING,
      });
    const tokens = { getAuthenticatedContext: getCtx };
    const client = new CalibrationHttpClient(tokens, { fetch: fetchMock });

    await client.getChanges(
      PROFILE_ID,
      BASE_URL,
      null,
      null,
      100,
      AbortSignal.timeout(5000),
    );

    // First call: 401, second call: success after refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCtx).toHaveBeenCalled();
    // Second request should use the refreshed token
    const secondCall = fetchMock.mock.calls[1] as [URL, RequestInit];
    const headers = secondCall[1].headers as Record<string, string>;
    expect(headers.authorization).toContain(TOKEN + '-refresh');
  });

  it('rejects when the server baseUrl changes mid-request (identity fence)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(emptyChangesPage()));
    let callCount = 0;
    const getCtx = vi.fn().mockImplementation(async () => {
      callCount++;
      // After first call, the profile URL changes
      return {
        baseUrl: callCount === 1 ? BASE_URL : 'http://other-server.local',
        token: TOKEN,
        binding: BINDING,
      };
    });
    const tokens = { getAuthenticatedContext: getCtx };
    const client = new CalibrationHttpClient(tokens, { fetch: fetchMock });

    await expect(
      client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow(CalibrationHttpError);
  });

  it('maps HTTP 428 to preconditionRequired', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 428 }));
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('preconditionRequired');
    }
  });

  it('withholds the ProblemDetails body from message and keeps it on serverDetail', async () => {
    // Issue #177. `statusError` used to build the message as `detail ?? catalogued`,
    // so a server-supplied string silently outranked every reviewed literal and
    // reached the renderer through `toApiError(null)` and `CalibrationSyncStatus.error`.
    //
    // The fix must be a *withholding*, not a deletion: the operator's only
    // actionable string still has to exist somewhere. This test pins both halves,
    // and is the falsifier for the `serverDetail` constructor parameter -- remove
    // it and this fails by name instead of the field becoming dead weight.
    const detail = 'upstream slicer pool exhausted at node worker-7';
    // A fresh Response per call. `mockResolvedValue` hands back the same object
    // every time, so once the client retries, the body is already consumed and
    // `statusError` silently reads an empty string -- which looks exactly like a
    // server that sent no detail at all.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          json({ title: 'Worker rejected', detail, errorCode: 'x' }, 503),
        ),
      );
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      const httpError = error as CalibrationHttpError;

      // Withheld from the renderer-visible surface.
      expect(
        httpError.message,
        'the backend detail is the error message again, which is the #177 defect',
      ).not.toContain(detail);
      expect(
        httpError.message,
        'the backend title is the error message, and title is as server-controlled as detail',
      ).not.toContain('Worker rejected');
      expect(httpError.message).toBe(
        'Calibration generation or telemetry service is unavailable.',
      );
      // `toApiError` is the actual IPC boundary, so assert there too rather than
      // trusting that it forwards `message` unchanged.
      expect(httpError.toApiError(null).message).toBe(
        'Calibration generation or telemetry service is unavailable.',
      );

      // Retained for the operator.
      expect(
        httpError.serverDetail,
        'the backend detail was dropped entirely; #177 withholds it from the renderer, it does not destroy it',
      ).toBe(detail);
    }
  });

  it('maps HTTP 412 to revisionConflict', async () => {
    const applyRequest = {
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      operations: [
        {
          operationId: OP_ID,
          idempotencyKey: 'hash-1',
          entityType: 'CalibrationProject' as const,
          entityId: PROJECT_ID,
          operationKind: 'Update' as const,
          baseRevision: 1,
          payload: {},
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 412 }));
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.apply(
        PROFILE_ID,
        BASE_URL,
        applyRequest,
        OP_ID,
        'etag-1',
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('revisionConflict');
    }
  });

  it('maps HTTP 422 to invalidData', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Field X is required.' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('invalidData');
      // This assertion used to read `.message`, which passed only because
      // `statusError` copied the server's `detail` over the catalogued string
      // -- it was asserting issue #177's defect as though it were the contract.
      // The intent (the backend's explanation is captured) is preserved; only
      // the location changes, because `message` is renderer-visible and
      // `serverDetail` is not.
      // `toContain` on a null receiver reports an argument-type complaint, not
      // the missing value, so state the presence claim separately.
      expect(
        (error as CalibrationHttpError).serverDetail,
        'the backend explanation was dropped rather than moved to serverDetail',
      ).not.toBeNull();
      expect((error as CalibrationHttpError).serverDetail).toContain('Field X');
      expect((error as CalibrationHttpError).message).not.toContain('Field X');
    }
  });

  it('maps HTTP 503 to workerUnavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }));
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('workerUnavailable');
    }
  });

  it('enforces body limit and throws bodyTooLarge', async () => {
    const bigBody = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bigBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
      maxResponseBytes: 1024,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        AbortSignal.timeout(5000),
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('bodyTooLarge');
    }
  });

  it('maps cancellation to cancelled error code', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    try {
      await client.getChanges(
        PROFILE_ID,
        BASE_URL,
        null,
        null,
        100,
        controller.signal,
      );
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationHttpError);
      expect((error as CalibrationHttpError).code).toBe('cancelled');
    }
  });

  it('apply returns typed conflict on HTTP 409 conflict body', async () => {
    const conflictBody = {
      conflictedOperationId: OP_ID,
      entityType: 'CalibrationProject',
      entityId: PROJECT_ID,
      serverRevision: 3,
      reason: 'Stale base revision.',
    };
    const fetchMock = vi.fn().mockResolvedValue(json(conflictBody, 409));
    const client = new CalibrationHttpClient(fakeTokenProvider(), {
      fetch: fetchMock,
    });

    const applyRequest = {
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      operations: [
        {
          operationId: OP_ID,
          idempotencyKey: 'hash-1',
          entityType: 'CalibrationProject' as const,
          entityId: PROJECT_ID,
          operationKind: 'Update' as const,
          baseRevision: 1,
          payload: {},
        },
      ],
    };
    const result = await client.apply(
      PROFILE_ID,
      BASE_URL,
      applyRequest,
      OP_ID,
      null,
      AbortSignal.timeout(5000),
    );

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.value.entityType).toBe('CalibrationProject');
      expect(result.value.serverRevision).toBe(3);
    }
  });
});

// ==========================================================================
// Two-device divergent offline resolution convergence E2E
// ==========================================================================

describe('Two-device divergent offline convergence', () => {
  it('Device A syncs after Device B conflicts — stops at conflict, resolves, re-syncs', async () => {
    // Device B already updated the project on the server (revision 2).
    // Device A has an outbox operation at revision 1 → conflict.
    // Resolution: acceptServer, then re-sync should succeed.

    const opA = makeOp(1, { baseRevision: 1 });
    let callCount = 0;
    const applyMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First sync: conflict from Device B
        return {
          kind: 'conflict',
          value: {
            conflictedOperationId: 'op-1',
            entityType: 'CalibrationProject',
            entityId: PROJECT_ID,
            serverRevision: 2,
            reason: 'Device B updated concurrently.',
          },
        };
      }
      // Second sync: no conflict after resolution
      return { kind: 'success', value: { serverRevision: 3 } };
    });

    const conflicts: CalibrationConflictType[] = [];
    const recordConflict = vi.fn().mockImplementation(async () => {
      const conflict: CalibrationConflictType = {
        conflictId: '66666666-6666-4666-8666-666666666666',
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        kind: 'projectMetadata',
        entityId: PROJECT_ID,
        localPayloadSummary: null,
        serverPayloadSummary: null,
        serverRevision: 2,
        availableResolutions: ['acceptServer', 'keepLocalAsNewRevision'],
        resolvedAt: null,
        resolution: null,
        createdAt: NOW,
      };
      conflicts.push(conflict);
    });

    const sidecarA = fakeSidecar({
      listCalibrationPendingOperations: vi
        .fn()
        .mockResolvedValueOnce([opA])
        .mockResolvedValue([]),
      recordCalibrationConflict: recordConflict,
      listCalibrationConflicts: vi
        .fn()
        .mockImplementation(async () => conflicts.slice()),
    });
    const http = fakeHttp({ apply: applyMock });
    const engine = new CalibrationSyncEngine(
      http,
      sidecarA,
      fakeProfileService(),
    );

    // First sync: creates a conflict
    const { status: status1 } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );
    expect(status1.conflictCount).toBe(1);

    // User resolves: acceptServer
    conflicts.length = 0; // simulate resolution clearing the conflict

    // Second sync: no conflict, succeeds
    const { status: status2 } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );
    expect(status2.phase).toBe('succeeded');
  });
});

// ==========================================================================
// Photo staging retry / hash / conflict retention
// ==========================================================================

// Skipped under #756: the saga's CalibrationStagePhoto channel was removed with the printer-calibration saga in this PR.
describe.skip('Photo staging behavior', () => {
  it('photo staging records photoId to sidecar with snapshot', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const sidecarAdapter = {
      ...fakeSidecar(),
      applyCalibrationSnapshot: apply,
    };

    // Simulate what the IPC handler does for staging
    await sidecarAdapter.applyCalibrationSnapshot(
      PROFILE_ID,
      'CalibrationPhoto',
      'photo-111',
      {
        id: 'photo-111',
        attemptId: ATTEMPT_ID,
        stageId: 'temperature',
        projectId: PROJECT_ID,
      },
      false,
      0,
    );

    expect(apply).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationPhoto',
      'photo-111',
      expect.objectContaining({ id: 'photo-111' }),
      false,
      0,
    );
  });

  it('staged photo tombstone is applied when server deletes it', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({ applyCalibrationSnapshot: apply });
    const http = fakeHttp({
      getChanges: vi.fn().mockResolvedValueOnce({
        changes: [
          {
            revision: 4,
            entityType: 'CalibrationPhoto',
            entityId: 'photo-111',
            operation: 'Deleted',
            projectId: PROJECT_ID,
            actorUserId: '00000000-0000-4000-8000-000000000001',
            timestamp: NOW,
          },
        ],
        nextCursor: null,
        hasMore: false,
        serverRevision: 4,
      }),
    });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    expect(apply).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationPhoto',
      'photo-111',
      null,
      true,
      4,
    );
  });
});

// ==========================================================================
// IPC schema validation — privilege denial
// ==========================================================================

describe('Outbox idempotency and replay', () => {
  it('exact replay (same operationId re-accepted) marks operation as settled', async () => {
    const ops = [makeOp(1)];
    const listOps = vi.fn().mockResolvedValueOnce(ops).mockResolvedValue([]);
    // Server returns idempotent success (the replay path)
    const apply = vi.fn().mockResolvedValue({
      kind: 'success',
      value: { serverRevision: 5, appliedOperationIds: ['op-1'] },
    });
    const settle = vi.fn().mockResolvedValue(undefined);
    const sidecar = fakeSidecar({
      listCalibrationPendingOperations: listOps,
      settleCalibrationOperation: settle,
    });
    const http = fakeHttp({ apply });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    const { status } = await engine.syncNow(
      PROFILE_ID,
      PROJECT_ID,
      AbortSignal.timeout(5000),
    );

    expect(status.phase).toBe('succeeded');
    expect(settle).toHaveBeenCalledWith(PROFILE_ID, 'op-1', 5);
  });

  it('outbox operations carry idempotency keys to the HTTP client', async () => {
    const ops = [makeOp(1, { idempotencyKey: 'canonical-hash-abc' })];
    const listOps = vi.fn().mockResolvedValueOnce(ops).mockResolvedValue([]);
    const apply = vi.fn().mockResolvedValue({
      kind: 'success',
      value: { serverRevision: 1 },
    });
    const sidecar = fakeSidecar({ listCalibrationPendingOperations: listOps });
    const http = fakeHttp({ apply });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    const callArgs = (apply as any).mock.calls[0];
    const applyReq = callArgs[2];
    expect(applyReq.operations[0].idempotencyKey).toBe('canonical-hash-abc');
  });

  it('disposed engine rejects syncNow with a CalibrationEngineError', async () => {
    const sidecar = fakeSidecar();
    const http = fakeHttp();
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    engine.dispose();

    // After disposal, syncNow throws CalibrationEngineError (not returned as failed status)
    await expect(
      engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({
      name: 'CalibrationEngineError',
      code: 'DISPOSED',
    });
  });
});

// ==========================================================================
// Cursor / gap handling (REST authority after SignalR gap)
// ==========================================================================

describe('Cursor and SignalR gap handling', () => {
  it('resumes pull from last committed cursor (REST is authoritative after gap)', async () => {
    const storedCursor = 'opaque-cursor-after-gap';
    const sidecar = fakeSidecar({
      getCalibrationCursorState: vi.fn().mockResolvedValue({
        cursor: storedCursor,
        serverRevision: 10,
        checkpointGeneration: 5,
      }),
    });
    const getChanges = vi.fn().mockResolvedValue({
      changes: [],
      nextCursor: storedCursor,
      hasMore: false,
      serverRevision: 10,
    });
    const http = fakeHttp({ getChanges });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // Verify the stored cursor was passed to the change feed request
    expect(getChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      BASE_URL,
      storedCursor,
      PROJECT_ID,
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it('commits null cursor at end of first full pull', async () => {
    const sidecar = fakeSidecar();
    const http = fakeHttp({
      getChanges: vi.fn().mockResolvedValue(emptyChangesPage()),
    });
    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    // Cursor from server was null; we commit null
    expect(sidecar.commitCalibrationCursor).toHaveBeenCalledWith(
      PROFILE_ID,
      PROJECT_ID,
      null,
      0,
      1,
    );
  });

  it('applies REST hydration for Updated entities (REST authority over SignalR hints)', async () => {
    const project = {
      id: PROJECT_ID,
      displayName: 'Authoritative Project',
      description: null,
      status: 'inProgress',
      printerId: 'printer-001',
      printerSnapshot: null,
      revision: 7,
      concurrencyToken: 'tok-7',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const getProject = vi.fn().mockResolvedValue(project);
    const sidecar = fakeSidecar();
    const http = fakeHttp({
      getChanges: vi.fn().mockResolvedValueOnce({
        changes: [
          {
            revision: 7,
            entityType: 'CalibrationProject',
            entityId: PROJECT_ID,
            operation: 'Updated',
            projectId: PROJECT_ID,
            actorUserId: '00000000-0000-4000-8000-000000000001',
            timestamp: NOW,
          },
        ],
        nextCursor: null,
        hasMore: false,
        serverRevision: 7,
      }),
      getProject,
    });

    const engine = new CalibrationSyncEngine(
      http,
      sidecar,
      fakeProfileService(),
    );
    await engine.syncNow(PROFILE_ID, PROJECT_ID, AbortSignal.timeout(5000));

    expect(getProject).toHaveBeenCalledWith(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      expect.any(AbortSignal),
    );
    expect(sidecar.applyCalibrationSnapshot).toHaveBeenCalledWith(
      PROFILE_ID,
      'CalibrationProject',
      PROJECT_ID,
      expect.objectContaining({
        id: PROJECT_ID,
        displayName: 'Authoritative Project',
      }),
      false,
      7,
    );
  });
});

// ==========================================================================
// CalibrationHttpError.toApiError(null) mapping
// ==========================================================================

describe('CalibrationHttpError.toApiError(null)', () => {
  it.each([
    ['preconditionRequired', 'preconditionRequired', false],
    ['revisionConflict', 'revisionConflict', false],
    ['idempotencyPayloadChanged', 'idempotencyPayloadChanged', false],
    ['invalidData', 'invalidData', false],
    ['workerUnavailable', 'workerUnavailable', true],
    ['server', 'serverError', true],
    ['timeout', 'serverError', true],
    ['transport', 'serverError', true],
  ] as const)(
    'maps %s to apiError.code %s (retryable: %s)',
    (httpCode, apiCode, retryable) => {
      const err = new CalibrationHttpError(httpCode as any, 'test error');
      const apiError = err.toApiError(null);
      expect(apiError.code).toBe(apiCode);
      expect(apiError.retryable).toBe(retryable);
    },
  );
});

// ==========================================================================
// IPC schema additive compatibility
// ==========================================================================

describe('Calibration IPC schema additive compatibility', () => {
  it('CalibrationGetAvailability request takes no arguments (z.void schema)', () => {
    // The request schema is z.void() which means the handler takes no IPC payload.
    const schema = ipcSchemas[IpcChannel.CalibrationGetAvailability].request;
    // z.void() parses undefined successfully
    expect(() => schema.parse(undefined)).not.toThrow();
    // An empty object is NOT void
    expect(() => schema.parse({})).toThrow();
  });

  it('CalibrationSyncStatus schema validates all phases', () => {
    const phases = [
      'validatingCapabilities',
      'pushingOperations',
      'pullingChanges',
      'succeeded',
      'partialConflict',
      'failed',
    ] as const;
    for (const phase of phases) {
      expect(() =>
        CalibrationSyncStatus.parse({
          phase,
          profileId: PROFILE_ID,
          projectId: null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error: null,
        }),
      ).not.toThrow();
    }
  });

  it('CalibrationAvailability accepts available=true without unavailableReason', () => {
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse({
        available: true,
        unavailableReason: null,
        unavailableDetail: null,
        negotiatedApiVersion: '1.0',
        negotiatedSchemaVersion: '1.0',
        capabilityFlags: {
          calibrationApiEnabled: true,
          calibrationChangeFeedEnabled: true,
          calibrationOfflineDraftEnabled: true,
          calibrationPhotoUploadEnabled: true,
          calibrationGenerationEnabled: true,
          calibrationArtifactPromotionEnabled: true,
        },
        grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
        offlineEditingEnabled: true,
        serverUnavailableReasons: [],
      }),
    ).not.toThrow();
  });
});
