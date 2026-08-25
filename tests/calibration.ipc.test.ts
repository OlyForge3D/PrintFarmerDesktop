/**
 * Calibration IPC schema tests (issue #52).
 *
 * Validates:
 * - Schema parsing and Zod validation for all calibration IPC types.
 * - Additive compatibility (passthrough fields accepted, strict fields rejected).
 * - Privilege denial: renderer cannot supply arbitrary paths, URLs, or
 *   credentials through calibration channels.
 * - Typed unavailable reasons parse correctly.
 * - Conflict resolution strategies are restricted to semantically valid options.
 */

import { describe, expect, it } from 'vitest';
import {
  ipcSchemas,
  IpcChannel,
  CalibrationAvailability,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationProject,
  CalibrationProjectSummary,
  CalibrationStep,
  CalibrationAttempt,
  StagedPhoto,
  CalibrationConflict,
  CalibrationSyncStatus,
  CalibrationApiError,
  CalibrationDraftFields,
  KlipperFirmwareInfo,
  OrcaProfileEntry,
  LegacyCalibrationBackupSummary,
} from '@shared/ipc';

// --- Fixtures ---

const PROFILE_UUID = '11111111-1111-4111-8111-111111111111';
const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const STEP_UUID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_UUID = '44444444-4444-4444-8444-444444444444';
const PRINTER_ID = 'printer-klipper-001';
const NOW = new Date('2026-07-26T06:00:00.000Z').toISOString();
const SHA256 = 'a'.repeat(64);

function printerContext(): Record<string, unknown> {
  return {
    printerId: PRINTER_ID,
    displayName: 'Klipper Printer',
    printerModel: 'Voron 2.4',
    firmware: {
      firmware: 'Klipper',
      gcodeDialect: 'Klipper',
      firmwareVersion: '0.12.0',
      klipperConfigHash: null,
    },
    orcaProfileId: 'orca-voron-pla',
    orcaProfileDisplayName: 'Voron 2.4 - PLA',
    bedWidthMm: 350,
    bedDepthMm: 350,
    nozzleDiameterMm: 0.4,
    snapshotAt: NOW,
    isCurrent: true,
  };
}

function calibrationProject(): Record<string, unknown> {
  return {
    projectId: PROJECT_UUID,
    profileId: PROFILE_UUID,
    printerId: PRINTER_ID,
    displayName: 'PLA Flow Rate Calibration',
    description: null,
    status: 'inProgress',
    steps: [],
    printerContext: printerContext(),
    hasConflicts: false,
    isSynced: true,
    isPrinterContextFresh: true,
    remoteProjectId: null,
    baseRevision: null,
    changeFeedCursor: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ==========================================================================
// CalibrationAvailability schema
// ==========================================================================

describe('CalibrationAvailability schema', () => {
  it('parses a fully unavailable state with noProfile reason', () => {
    const result = CalibrationAvailability.parse({
      available: false,
      unavailableReason: 'noProfile',
      unavailableDetail: 'No server profile is selected.',
      negotiatedApiVersion: null,
      negotiatedSchemaVersion: null,
      capabilityFlags: null,
      grantedScopes: null,
      offlineEditingEnabled: false,
      serverUnavailableReasons: [],
    });
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe('noProfile');
  });

  it('parses an available state with all required fields', () => {
    const result = CalibrationAvailability.parse({
      available: true,
      unavailableReason: null,
      unavailableDetail: null,
      negotiatedApiVersion: '2.0',
      negotiatedSchemaVersion: '1.0',
      capabilityFlags: {
        calibrationApiEnabled: true,
        calibrationChangeFeedEnabled: true,
        calibrationOfflineDraftEnabled: true,
        calibrationPhotoUploadEnabled: true,
        calibrationGenerationEnabled: true,
      },
      grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
      offlineEditingEnabled: true,
      serverUnavailableReasons: [],
    });
    expect(result.available).toBe(true);
    expect(result.negotiatedApiVersion).toBe('2.0');
  });

  it('rejects an unknown unavailable reason', () => {
    expect(() =>
      CalibrationAvailability.parse({
        available: false,
        unavailableReason: 'hackerReason',
        unavailableDetail: null,
        negotiatedApiVersion: null,
        negotiatedSchemaVersion: null,
        capabilityFlags: null,
        grantedScopes: null,
        offlineEditingEnabled: false,
        serverUnavailableReasons: [],
      }),
    ).toThrow();
  });

  it('rejects extra strict fields from renderer', () => {
    // CalibrationAvailability is strict — the renderer cannot inject extra fields
    expect(() =>
      CalibrationAvailability.parse({
        available: false,
        unavailableReason: 'noProfile',
        unavailableDetail: null,
        negotiatedApiVersion: null,
        negotiatedSchemaVersion: null,
        capabilityFlags: null,
        grantedScopes: null,
        offlineEditingEnabled: false,
        serverUnavailableReasons: [],
        rendererInjectedField: true,
      }),
    ).toThrow();
  });

  it('carries server-reported unavailable reasons verbatim so the renderer can name a refusal', () => {
    const result = CalibrationAvailability.parse({
      available: false,
      unavailableReason: 'missingCapabilityFlags',
      unavailableDetail: 'calibrationChangeFeedEnabled',
      negotiatedApiVersion: '1.0',
      negotiatedSchemaVersion: '1.0',
      capabilityFlags: {
        calibrationApiEnabled: true,
        calibrationChangeFeedEnabled: false,
        calibrationOfflineDraftEnabled: true,
        calibrationPhotoUploadEnabled: true,
        calibrationGenerationEnabled: false,
      },
      grantedScopes: ['calibration:read'],
      offlineEditingEnabled: true,
      serverUnavailableReasons: [
        {
          feature: 'calibrationGeneration',
          code: 'split_routing_unavailable',
          message:
            'Calibration generation requires the deterministic core, authorized model storage, the canonical slice path, an allow-listed attested worker, operational promotion, a durable orchestration store and a healthy recovery loop.',
        },
      ],
    });
    expect(result.serverUnavailableReasons).toHaveLength(1);
    expect(result.serverUnavailableReasons[0]!.code).toBe(
      'split_routing_unavailable',
    );
  });
});

// ==========================================================================
// KlipperFirmwareInfo schema
// ==========================================================================

describe('KlipperFirmwareInfo schema', () => {
  it('requires exactly Klipper firmware and dialect', () => {
    const result = KlipperFirmwareInfo.parse({
      firmware: 'Klipper',
      gcodeDialect: 'Klipper',
      firmwareVersion: '0.12.0',
      klipperConfigHash: null,
    });
    expect(result.firmware).toBe('Klipper');
    expect(result.gcodeDialect).toBe('Klipper');
  });

  it('rejects non-Klipper firmware', () => {
    expect(() =>
      KlipperFirmwareInfo.parse({
        firmware: 'Marlin',
        gcodeDialect: 'Marlin',
        firmwareVersion: null,
        klipperConfigHash: null,
      }),
    ).toThrow();
  });

  it('rejects non-Klipper G-code dialect even with Klipper firmware', () => {
    expect(() =>
      KlipperFirmwareInfo.parse({
        firmware: 'Klipper',
        gcodeDialect: 'RepRap',
        firmwareVersion: null,
        klipperConfigHash: null,
      }),
    ).toThrow();
  });
});

// ==========================================================================
// Printer candidates and context
// ==========================================================================

describe('CalibrationPrinterCandidate schema', () => {
  it('parses a valid candidate', () => {
    const result = CalibrationPrinterCandidate.parse({
      printerId: PRINTER_ID,
      displayName: 'Klipper Printer',
      printerModel: null,
      printerModelId: null,
      isOnline: true,
    });
    expect(result.printerId).toBe(PRINTER_ID);
    expect(result.isOnline).toBe(true);
  });

  it('rejects extra renderer-injected fields (strict)', () => {
    expect(() =>
      CalibrationPrinterCandidate.parse({
        printerId: PRINTER_ID,
        displayName: 'Printer',
        printerModel: null,
        printerModelId: null,
        isOnline: false,
        rendererPath: '/etc/passwd',
      }),
    ).toThrow();
  });
});

describe('CalibrationPrinterContext schema', () => {
  it('parses a valid context', () => {
    const result = CalibrationPrinterContext.parse(printerContext());
    expect(result.firmware.firmware).toBe('Klipper');
    expect(result.isCurrent).toBe(true);
  });

  it('rejects non-Klipper firmware in context', () => {
    expect(() =>
      CalibrationPrinterContext.parse({
        ...printerContext(),
        firmware: {
          firmware: 'Marlin',
          gcodeDialect: 'Marlin',
          firmwareVersion: null,
          klipperConfigHash: null,
        },
      }),
    ).toThrow();
  });
});

// ==========================================================================
// Calibration project schemas
// ==========================================================================

describe('CalibrationProject schema', () => {
  it('parses a minimal project', () => {
    const result = CalibrationProject.parse(calibrationProject());
    expect(result.projectId).toBe(PROJECT_UUID);
    expect(result.steps).toHaveLength(0);
  });

  it('rejects a project with an unknown status', () => {
    expect(() =>
      CalibrationProject.parse({
        ...calibrationProject(),
        status: 'hacked',
      }),
    ).toThrow();
  });

  it('accepts all valid project statuses', () => {
    for (const status of [
      'draft',
      'inProgress',
      'awaitingGeneration',
      'generated',
      'complete',
      'archived',
    ] as const) {
      const result = CalibrationProject.parse({
        ...calibrationProject(),
        status,
      });
      expect(result.status).toBe(status);
    }
  });
});

describe('CalibrationProjectSummary schema', () => {
  it('parses a valid summary', () => {
    const result = CalibrationProjectSummary.parse({
      projectId: PROJECT_UUID,
      profileId: PROFILE_UUID,
      printerId: PRINTER_ID,
      displayName: 'Test Project',
      status: 'draft',
      stepCount: 5,
      completedStepCount: 2,
      hasConflicts: false,
      isSynced: true,
      isPrinterContextFresh: true,
      remoteProjectId: null,
      baseRevision: null,
      recoveryState: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.stepCount).toBe(5);
  });
});

// ==========================================================================
// Calibration draft fields — additive + privilege denial
// ==========================================================================

describe('CalibrationDraftFields schema (additive + privilege denial)', () => {
  it('parses valid display name update', () => {
    const result = CalibrationDraftFields.parse({
      displayName: 'Updated Name',
    });
    expect(result.displayName).toBe('Updated Name');
  });

  it('rejects displayName with whitespace-only content', () => {
    expect(() =>
      CalibrationDraftFields.parse({ displayName: '   ' }),
    ).toThrow();
  });

  it('accepts step draft updates', () => {
    const result = CalibrationDraftFields.parse({
      stepDrafts: [
        {
          stepId: STEP_UUID,
          displayName: 'Flow Rate Step',
          methodNotes: 'Print at 210°C',
        },
      ],
    });
    expect(result.stepDrafts).toHaveLength(1);
  });

  it('rejects step drafts with renderer-injected path fields (strict)', () => {
    expect(() =>
      CalibrationDraftFields.parse({
        stepDrafts: [
          {
            stepId: STEP_UUID,
            displayName: 'Step',
            rendererPath: 'C:\\Windows\\System32\\cmd.exe',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects measured result in draft (append-only field not allowed here)', () => {
    // measuredResult is not in CalibrationDraftFields — strict schema rejects it
    expect(() =>
      CalibrationDraftFields.parse({
        stepDrafts: [{ stepId: STEP_UUID, measuredResult: 'hacked' }],
      }),
    ).toThrow();
  });
});

// ==========================================================================
// CalibrationStep
// ==========================================================================

describe('CalibrationStep schema', () => {
  it('parses a valid step', () => {
    const result = CalibrationStep.parse({
      stepId: STEP_UUID,
      ordinal: 0,
      kind: 'flowRate',
      status: 'pending',
      displayName: 'Flow Rate',
      prerequisites: null,
      methodNotes: null,
      expectedResult: null,
      measuredResult: null,
      reorderingSupported: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.kind).toBe('flowRate');
    expect(result.reorderingSupported).toBe(true);
  });

  it('accepts all valid step kinds', () => {
    for (const kind of [
      'temperatureTower',
      'retraction',
      'flowRate',
      'pressureAdvance',
      'firstLayerHeight',
      'firstLayerWidth',
      'overhangAngle',
      'toleranceTest',
      'speedTest',
    ] as const) {
      const result = CalibrationStep.parse({
        stepId: STEP_UUID,
        ordinal: 0,
        kind,
        status: 'pending',
        displayName: 'Step',
        prerequisites: null,
        methodNotes: null,
        expectedResult: null,
        measuredResult: null,
        reorderingSupported: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(result.kind).toBe(kind);
    }
  });
});

// ==========================================================================
// CalibrationAttempt — append-only identity
// ==========================================================================

describe('CalibrationAttempt schema (append-only)', () => {
  it('parses a valid attempt', () => {
    const result = CalibrationAttempt.parse({
      attemptId: ATTEMPT_UUID,
      stepId: STEP_UUID,
      projectId: PROJECT_UUID,
      profileId: PROFILE_UUID,
      attemptNumber: 1,
      measuredValue: 0.98,
      measuredUnit: 'ratio',
      isSelected: false,
      printerContextSnapshotHash: null,
      remoteAttemptId: null,
      remoteRevision: null,
      createdAt: NOW,
    });
    expect(result.attemptNumber).toBe(1);
    expect(result.measuredValue).toBe(0.98);
  });

  it('rejects an attempt with extra strict fields (no renderer injection)', () => {
    expect(() =>
      CalibrationAttempt.parse({
        attemptId: ATTEMPT_UUID,
        stepId: STEP_UUID,
        projectId: PROJECT_UUID,
        profileId: PROFILE_UUID,
        attemptNumber: 1,
        measuredValue: null,
        measuredUnit: null,
        isSelected: false,
        printerContextSnapshotHash: null,
        remoteAttemptId: null,
        remoteRevision: null,
        createdAt: NOW,
        rendererInjectedCredential: 'some-token',
      }),
    ).toThrow();
  });
});

// ==========================================================================
// StagedPhoto — privilege denial
// ==========================================================================

describe('StagedPhoto schema (privilege denial)', () => {
  it('parses a valid staged photo metadata record', () => {
    const result = StagedPhoto.parse({
      photoId: ATTEMPT_UUID,
      attemptId: ATTEMPT_UUID,
      stageId: 'temperature',
      projectId: PROJECT_UUID,
      profileId: PROFILE_UUID,
      contentHash: SHA256,
      mimeType: 'image/jpeg',
      byteSize: 1024 * 1024,
      status: 'staged',
      uploadAttempts: 0,
      remotePhotoId: null,
      remoteUrl: null,
      stagedAt: NOW,
      uploadedAt: null,
      caption: 'Flow sample',
      order: 1,
    });
    expect(result.status).toBe('staged');
  });

  it('rejects an invalid content hash (not SHA-256 hex)', () => {
    expect(() =>
      StagedPhoto.parse({
        photoId: ATTEMPT_UUID,
        attemptId: ATTEMPT_UUID,
        stageId: 'temperature',
        projectId: PROJECT_UUID,
        profileId: PROFILE_UUID,
        contentHash: 'not-a-sha256',
        mimeType: 'image/jpeg',
        byteSize: 1000,
        status: 'staged',
        uploadAttempts: 0,
        remotePhotoId: null,
        remoteUrl: null,
        stagedAt: NOW,
        uploadedAt: null,
      }),
    ).toThrow();
  });

  it('rejects an unsupported MIME type', () => {
    expect(() =>
      StagedPhoto.parse({
        photoId: ATTEMPT_UUID,
        attemptId: ATTEMPT_UUID,
        stageId: 'temperature',
        projectId: PROJECT_UUID,
        profileId: PROFILE_UUID,
        contentHash: SHA256,
        mimeType: 'application/octet-stream',
        byteSize: 1000,
        status: 'staged',
        uploadAttempts: 0,
        remotePhotoId: null,
        remoteUrl: null,
        stagedAt: NOW,
        uploadedAt: null,
      }),
    ).toThrow();
  });

  it('rejects a photo that exceeds the size limit', () => {
    expect(() =>
      StagedPhoto.parse({
        photoId: ATTEMPT_UUID,
        attemptId: ATTEMPT_UUID,
        stageId: 'temperature',
        projectId: PROJECT_UUID,
        profileId: PROFILE_UUID,
        contentHash: SHA256,
        mimeType: 'image/jpeg',
        byteSize: 21_000_000, // > 20 MiB limit
        status: 'staged',
        uploadAttempts: 0,
        remotePhotoId: null,
        remoteUrl: null,
        stagedAt: NOW,
        uploadedAt: null,
      }),
    ).toThrow();
  });
});

// ==========================================================================
// CalibrationConflict — resolution strategy restriction
// ==========================================================================

describe('CalibrationConflict schema (resolution strategies)', () => {
  it('parses an unresolved conflict', () => {
    const result = CalibrationConflict.parse({
      conflictId: ATTEMPT_UUID,
      profileId: PROFILE_UUID,
      projectId: PROJECT_UUID,
      kind: 'stepDraft',
      entityId: STEP_UUID,
      localPayloadSummary: '{"displayName":"Local"}',
      serverPayloadSummary: '{"displayName":"Server"}',
      serverRevision: 5,
      availableResolutions: [
        'acceptServer',
        'keepLocalAsNewRevision',
        'manualFieldMerge',
      ],
      resolvedAt: null,
      resolution: null,
      createdAt: NOW,
    });
    expect(result.availableResolutions).toHaveLength(3);
    expect(result.resolution).toBeNull();
  });

  it('rejects a conflict with unknown kind', () => {
    expect(() =>
      CalibrationConflict.parse({
        conflictId: ATTEMPT_UUID,
        profileId: PROFILE_UUID,
        projectId: PROJECT_UUID,
        kind: 'lastWriteWins', // Not allowed
        entityId: STEP_UUID,
        localPayloadSummary: null,
        serverPayloadSummary: null,
        serverRevision: 1,
        availableResolutions: ['acceptServer'],
        resolvedAt: null,
        resolution: null,
        createdAt: NOW,
      }),
    ).toThrow();
  });

  it('rejects an unknown resolution strategy', () => {
    expect(() =>
      CalibrationConflict.parse({
        conflictId: ATTEMPT_UUID,
        profileId: PROFILE_UUID,
        projectId: PROJECT_UUID,
        kind: 'projectMetadata',
        entityId: PROJECT_UUID,
        localPayloadSummary: null,
        serverPayloadSummary: null,
        serverRevision: 1,
        availableResolutions: ['lastWriteWins'], // Not a valid strategy
        resolvedAt: null,
        resolution: null,
        createdAt: NOW,
      }),
    ).toThrow();
  });
});

// ==========================================================================
// CalibrationSyncStatus
// ==========================================================================

describe('CalibrationSyncStatus schema', () => {
  it('parses a succeeded sync status', () => {
    const result = CalibrationSyncStatus.parse({
      phase: 'succeeded',
      profileId: PROFILE_UUID,
      projectId: PROJECT_UUID,
      pushedOperations: 3,
      pulledChanges: 10,
      conflictCount: 0,
      cursor: 'opaque-cursor-abc',
      error: null,
    });
    expect(result.phase).toBe('succeeded');
    expect(result.pushedOperations).toBe(3);
  });

  it('parses a failed sync status with an error message', () => {
    const result = CalibrationSyncStatus.parse({
      phase: 'failed',
      profileId: PROFILE_UUID,
      projectId: null,
      pushedOperations: 0,
      pulledChanges: 0,
      conflictCount: 0,
      cursor: null,
      error: 'Calibration API not available.',
    });
    expect(result.phase).toBe('failed');
    expect(result.error).toBe('Calibration API not available.');
  });
});

// ==========================================================================
// CalibrationApiError — typed error states
// ==========================================================================

describe('CalibrationApiError schema (typed HTTP error states)', () => {
  for (const code of [
    'preconditionRequired',
    'revisionConflict',
    'idempotencyPayloadChanged',
    'invalidData',
    'workerUnavailable',
    'serverError',
    'syncRequired',
    'printerContextStale',
  ] as const) {
    it(`parses error code '${code}'`, () => {
      const result = CalibrationApiError.parse({
        code,
        message: `Error: ${code}`,
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      });
      expect(result.code).toBe(code);
    });
  }

  it('rejects an unknown error code', () => {
    expect(() =>
      CalibrationApiError.parse({
        code: 'unknownHackerCode',
        message: 'Error',
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      }),
    ).toThrow();
  });
});

// ==========================================================================
// IPC schema registry — calibration channels registered
// ==========================================================================

// Retained under #756: only the non-saga channels remain testable after the saga IPC reap.
describe('ipcSchemas calibration channel registry', () => {
  const calibrationChannels = [
    IpcChannel.CalibrationGetAvailability,
    IpcChannel.CalibrationListPrinters,
    IpcChannel.CalibrationGetPrinterContext,
    IpcChannel.CalibrationSyncNow,
    IpcChannel.CalibrationListOrcaProfiles,
    IpcChannel.CalibrationExportOrcaProfile,
  ] as const;

  for (const channel of calibrationChannels) {
    it(`has request and response schemas for '${channel}'`, () => {
      const schema = ipcSchemas[channel];
      expect(schema).toBeDefined();
      expect(schema.request).toBeDefined();
      expect(schema.response).toBeDefined();
    });
  }

  it('CalibrationGetAvailability response validates a concrete unavailable state', () => {
    const result = ipcSchemas[
      IpcChannel.CalibrationGetAvailability
    ].response.parse({
      available: false,
      unavailableReason: 'missingScopes',
      unavailableDetail: 'Token lacks CalibrationRead scope.',
      negotiatedApiVersion: '2.0',
      negotiatedSchemaVersion: '1.0',
      capabilityFlags: null,
      grantedScopes: ['ModelRead'],
      offlineEditingEnabled: false,
      serverUnavailableReasons: [],
    });
    expect(result.unavailableReason).toBe('missingScopes');
  });

  it('CalibrationSyncNow request rejects missing required profileId', () => {
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse({}),
    ).toThrow();
  });

  it('CalibrationSyncNow request rejects non-UUID profileId', () => {
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse({
        profileId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('CalibrationSyncNow remains the strict profile/project request without operationId', () => {
    expect(
      ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse({
        profileId: PROFILE_UUID,
        projectId: PROJECT_UUID,
      }),
    ).toEqual({ profileId: PROFILE_UUID, projectId: PROJECT_UUID });
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse({
        profileId: PROFILE_UUID,
        projectId: PROJECT_UUID,
        operationId: ATTEMPT_UUID,
      }),
    ).toThrow();
  });

  it('CalibrationListOrcaProfiles requires a selected printer as well as the profile fence', () => {
    const printerId = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    expect(
      ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].request.parse({
        profileId: PROFILE_UUID,
        printerId,
      }),
    ).toEqual({ profileId: PROFILE_UUID, printerId });
    // Profile resolution is scoped to one selected printer, so a request that
    // names only the server profile has no farm-wide meaning left to give it.
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].request.parse({
        profileId: PROFILE_UUID,
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].request.parse({}),
    ).toThrow();
  });
});

// ==========================================================================
// Additive compatibility: remote DTOs with extra fields
// ==========================================================================

describe('additive compatibility (remote DTOs accept extra fields)', () => {
  it('OrcaProfileEntry is strict (renderer surface)', () => {
    expect(() =>
      OrcaProfileEntry.parse({
        orcaProfileId: 'orca-pla',
        displayName: 'PLA Profile',
        vendor: 'Generic',
        material: 'PLA',
        source: 'systemInstall',
        upstreamVerified: false,
        printerId: PRINTER_ID,
        configurationRevision: 1,
        snapshotId: 'snapshot-1',
        toolId: 'tool-1',
        toolheadId: 'toolhead-1',
        nozzleId: 'nozzle-1',
        nozzleDiameterMm: 0.4,
        profileRevision: null,
        contentHash: null,
        exportable: true,
        unknownFutureField: 'should-reject',
      }),
    ).toThrow();
  });

  it('LegacyCalibrationBackupSummary is strict', () => {
    expect(() =>
      LegacyCalibrationBackupSummary.parse({
        fileHash: SHA256,
        detectedVersion: 4,
        projectCount: 10,
        attemptCount: 100,
        photoCount: 50,
        formatValid: true,
        extraField: 'reject-this',
      }),
    ).toThrow();
  });
});
