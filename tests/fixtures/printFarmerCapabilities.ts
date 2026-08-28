/**
 * Verbatim shape of the PrintFarmer `GET /api/calibration/capabilities`
 * response (`PlatformCapabilitiesDto`), as produced by
 * `CalibrationCapabilityService.GetCapabilitiesAsync` and documented in the
 * server's `docs/API.md`.
 *
 * Kept as a contract fixture so desktop parsing is tested against what the
 * server actually sends rather than against a desktop-invented shape.
 */
export function printFarmerCapabilitiesResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiContractVersion: '1.0',
    minimumSupportedApiContractVersion: '1.0',
    serverVersion: '1.0.0',
    calibrationApiVersion: '1.0',
    calibrationSchemaVersion: '1.0',
    deploymentMode: 'monolith',
    architecture: 'X64',
    slicingEnabled: true,
    slicingConfigured: true,
    slicingOperational: true,
    calibrationContextEnabled: true,
    calibrationPersistenceEnabled: true,
    calibrationSyncEnabled: true,
    calibrationPhotosEnabled: true,
    calibrationProfileHistoryEnabled: true,
    // `calibrationGenerationEnabled` is deliberately NOT set: the server
    // deleted that field with the generator subsystem (7169f1d32 / #1995,
    // D2/#1979). This fixture must faithfully reflect the wire, and the wire
    // no longer carries it. The desktop flag of the same name now binds to
    // `calibrationSlicingEnabled` below.
    calibrationSlicingEnabled: true,
    calibrationArtifactPromotionEnabled: true,
    calibrationQueueEnabled: false,
    calibrationJobBoundBedClearEnabled: false,
    // The live server hardcodes `calibrationEventsEnabled: false` today
    // (`CalibrationCapabilityService.cs:203-205`, documented in
    // `docs/API.md:108-110` and DTO XML at `PlatformCapabilitiesDto.cs:71-72`).
    // It is a distinct, unimplemented future event-streaming subsystem, NOT
    // the change-feed/sync path — which is `calibrationSyncEnabled` above.
    // The desktop's `calibrationChangeFeedEnabled` gate reads
    // `calibrationSyncEnabled`; this fixture must faithfully reflect the
    // wire, so `calibrationEventsEnabled` stays `false` even in the healthy
    // baseline.
    calibrationEventsEnabled: false,
    supportedFirmwareFamilies: ['Klipper'],
    supportedGcodeDialects: ['Klipper'],
    modelFilesEnabled: true,
    thumbnailGenerationEnabled: true,
    gcodeUploadEnabled: true,
    clientThumbnailUploadEnabled: true,
    idempotentModelUploadEnabled: true,
    modelThumbnailReplacementEnabled: true,
    platformNote: null,
    operatorFeatures: {
      // `offlineWriteReplayEnabled` is an operator-facing capability the
      // server advertises via `operatorFeatures`. The desktop's
      // `calibrationOfflineDraftEnabled` gate is backed by
      // `calibrationSyncEnabled` above (the sync/change-feed subsystem);
      // this field is a related but separate capability the desktop can
      // read via `readFlagBackingField` if a future use requires it.
      // Kept faithful to the wire so nested-path parsing is exercised.
      offlineWriteReplayEnabled: true,
    },
    supportedSlicerEngines: [
      {
        type: 'OrcaSlicer',
        version: '2.3.1',
        distribution: 'upstream',
        supported: true,
      },
    ],
    calibration: {
      contextImplemented: true,
      commandsImplemented: false,
      generationImplemented: false,
      queueIntegrationImplemented: false,
      eventStreamImplemented: false,
      operational: true,
    },
    routes: {
      systemCapabilities: '/api/system/capabilities',
      calibrationCapabilities: '/api/calibration/capabilities',
    },
    limits: {
      modelUploadMaxBytes: 268_435_456,
      photoUploadMaxBytes: 20_000_000,
      photoMaxPixels: 40_000_000,
    },
    acceptedMimeTypes: {},
    supportedExportFormats: ['orca-json'],
    healthyCompatibleWorker: {
      available: true,
      healthyCount: 1,
      availableSlots: 1,
      engine: 'OrcaSlicer',
      requiredVersion: '2.3.1',
      distribution: 'upstream',
    },
    unavailableReasons: [],
    effectivePermissions: ['calibration:create', 'calibration:read'],
    effectiveCapabilities: {
      canCreate: true,
      canRead: true,
      canUpdate: true,
      canDelete: true,
      canGenerate: true,
      canPublish: true,
      canSubmitSlicing: true,
      canReadArtifacts: true,
      canManageDispatchSettings: false,
    },
    ...overrides,
  };
}
