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
    calibrationGenerationEnabled: true,
    calibrationSlicingEnabled: true,
    calibrationArtifactPromotionEnabled: true,
    calibrationQueueEnabled: false,
    calibrationJobBoundBedClearEnabled: false,
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
    operatorFeatures: {},
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
