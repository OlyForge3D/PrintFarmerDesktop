/**
 * PlatformCapabilitiesDto — snapshot of the server response body for
 * GET /api/calibration/capabilities.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  678d3398934537ff6ee4528c2e51aaa4a244d37f
 * Branch:      development (at snapshot time)
 * Source file: src/infra/Dtos/PlatformCapabilitiesDto.cs
 * Blob hash:   7ab8cd45cfb7d0587e72e175c3104e5851b71fa8
 * C# type:     Farm.Infrastructure.Dtos.PlatformCapabilitiesDto
 *
 * This DTO is what the "capability negotiation" layer resolves against.
 * Two structural facts a flat key-set comparison would silently miss:
 *
 *   1. `operatorFeatures` is a NESTED object of type OperatorFeatureFlagsDto.
 *      Flag aliases into that sub-record use dotted paths
 *      (e.g. `operatorFeatures.offlineWriteReplayEnabled`); the desktop's
 *      `readFlagBackingField` walker handles both flat and nested paths, and
 *      the path-walker controls in `calibration.capabilityFlagMapping.test.ts`
 *      make the nested case load-bearing.
 *
 *   2. Some of the boolean fields on this DTO are HARDCODED FALSE on the
 *      server side because their backing subsystem is unimplemented — see
 *      `src/modules/Farm.Modules.Calibration/Services/Capabilities/CalibrationCapabilityService.cs:203-205`
 *      (blob b3856c06f7e6827024dfbebba13cc86548241595), which hardcodes
 *      `CalibrationQueueEnabled = false`, `CalibrationJobBoundBedClearEnabled
 *      = false`, and `CalibrationEventsEnabled = false`. A desktop alias that
 *      binds a REQUIRED calibration flag to one of these hardcoded-false
 *      fields would fail gate G5 unconditionally, on every deployment,
 *      forever, no matter how the server operator configures it. The
 *      counterfactual regression guard in `capabilityFlagMapping` pins this
 *      failure mode against re-introduction.
 *
 *   3. TWO FIELDS WERE DELETED SERVER-SIDE and are deliberately absent below:
 *      `calibrationGenerationEnabled` and `supportedExportFormats`. They were
 *      removed by PrintFarmer 7169f1d32 ("D6: Rescope
 *      CalibrationCapabilitiesController / PlatformCapabilitiesDto for
 *      filament calibration", #1995), which rescoped this DTO to describe only
 *      what a thin client needs to drive *server-orchestrated filament
 *      calibration*. The generator subsystem those fields described
 *      (`Farm.Web.Api.Services.Calibration.Generation`) was deleted outright by
 *      D2/#1979 — so this is a subsystem removal, NOT a rename. Do not
 *      "restore" them to make a test pass.
 *
 *      The desktop's `calibrationGenerationEnabled` capability flag survives as
 *      a *desktop* concept ("can this server produce calibration output?") but
 *      now binds to `calibrationSlicingEnabled`, which the server computes from
 *      `calibrationSlicingOperational` rather than hardcoding. See the semantic
 *      mapping in `CALIBRATION_FLAG_SOURCES` for the reasoning.
 */

/**
 * Every camelCase property name serialised on the `PlatformCapabilitiesDto`
 * response by the default `System.Text.Json` naming policy.
 */
export const PLATFORM_CAPABILITIES_DTO_FIELDS = [
  'apiContractVersion',
  'minimumSupportedApiContractVersion',
  'serverVersion',
  'calibrationApiVersion',
  'calibrationSchemaVersion',
  'deploymentMode',
  'architecture',
  'slicingEnabled',
  'slicingConfigured',
  'slicingOperational',
  'calibrationContextEnabled',
  'calibrationPersistenceEnabled',
  'calibrationSyncEnabled',
  'calibrationPhotosEnabled',
  'calibrationProfileHistoryEnabled',
  'calibrationSlicingEnabled',
  'calibrationArtifactPromotionEnabled',
  'calibrationQueueEnabled',
  'calibrationJobBoundBedClearEnabled',
  'calibrationEventsEnabled',
  'supportedFirmwareFamilies',
  'supportedGcodeDialects',
  'modelFilesEnabled',
  'thumbnailGenerationEnabled',
  'gcodeUploadEnabled',
  'clientThumbnailUploadEnabled',
  'idempotentModelUploadEnabled',
  'modelThumbnailReplacementEnabled',
  'platformNote',
  'operatorFeatures',
  'supportedSlicerEngines',
  'calibration',
  'routes',
  'limits',
  'acceptedMimeTypes',
  'healthyCompatibleWorker',
  'unavailableReasons',
  'effectivePermissions',
  'effectiveCapabilities',
] as const satisfies readonly string[];

export type PlatformCapabilitiesDtoField =
  (typeof PLATFORM_CAPABILITIES_DTO_FIELDS)[number];

/**
 * OperatorFeatureFlagsDto — snapshot of the NESTED object at
 * `PlatformCapabilitiesDto.OperatorFeatures`.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Source file: src/infra/Services/OperatorFeatures/OperatorFeatureFlagsDto.cs
 * Blob hash:   e5970c4bb216dd1d48d5b1f01fc0021ba0ca6a51
 * C# type:     Farm.Infrastructure.Services.OperatorFeatures.OperatorFeatureFlagsDto
 *
 * NOTE ON PROVENANCE: this DTO uses explicit `[JsonPropertyName("…")]`
 * attributes on every property. The camelCase names below match those
 * attributes verbatim — they are NOT a lowercased-first-letter transform of
 * the C# property names (although they happen to coincide today).
 */
export const OPERATOR_FEATURE_FLAGS_DTO_FIELDS = [
  'attentionEnabled',
  'nativePushEnabled',
  'filamentCoverageEnabled',
  'guidedSwapEnabled',
  'multiSlotFallbackEnabled',
  'shiftPlanEnabled',
  'printedPartsInventoryEnabled',
  'offlineWriteReplayEnabled',
] as const satisfies readonly string[];

export type OperatorFeatureFlagsDtoField =
  (typeof OPERATOR_FEATURE_FLAGS_DTO_FIELDS)[number];

/**
 * The subset of `PlatformCapabilitiesDto` fields the desktop's
 * `CALIBRATION_FLAG_SOURCES` map is entitled to reference. If the desktop
 * points a required-flag alias at a name outside this list, it is either
 * pointing at a field that no longer exists on the server, or a field this
 * snapshot has not authorised as a legitimate calibration switch.
 *
 * KEEP THIS TIGHT — expanding it is an intentional decision. A test that
 * treats the whole DTO as a valid source of calibration flags will
 * accidentally green-light a mapping that binds to the wrong switch (e.g.
 * `slicingEnabled`), so the allowlist stays scoped to the calibration seam.
 */
export const CALIBRATION_CAPABILITY_FLAG_ALLOWLIST = [
  'calibrationContextEnabled',
  'calibrationPersistenceEnabled',
  'calibrationSyncEnabled',
  'calibrationPhotosEnabled',
  'calibrationProfileHistoryEnabled',
  // Backs the desktop's `calibrationGenerationEnabled` flag since the server
  // deleted its own generation field (PrintFarmer 7169f1d32 / #1995).
  // Authorised because the service computes it from
  // `calibrationSlicingOperational` — a real deployment switch, not one of the
  // hardcoded-false fields below.
  'calibrationSlicingEnabled',
  'calibrationArtifactPromotionEnabled',
  'calibrationQueueEnabled',
  'calibrationJobBoundBedClearEnabled',
  'calibrationEventsEnabled',
  // Nested calibration switch — offline-write replay lives inside the
  // `operatorFeatures` object on PlatformCapabilitiesDto. It IS a real
  // calibration switch (backs `calibrationOfflineDraftEnabled`) and is
  // explicitly authorised here.
] as const satisfies readonly string[];

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * The guard test in `calibration.snapshotProvenanceGuard.test.ts` verifies
 * that (a) this file exports PROVENANCE, (b) when the pfarm1 checkout is on
 * disk the current git blob for `sourcePath` matches `blobHash`.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '678d3398934537ff6ee4528c2e51aaa4a244d37f',
  sourcePath: 'src/infra/Dtos/PlatformCapabilitiesDto.cs',
  blobHash: '7ab8cd45cfb7d0587e72e175c3104e5851b71fa8',
  typeName: 'PlatformCapabilitiesDto',
  additionalSources: [
    {
      sourcePath:
        'src/infra/Services/OperatorFeatures/OperatorFeatureFlagsDto.cs',
      blobHash: 'e5970c4bb216dd1d48d5b1f01fc0021ba0ca6a51',
      typeName: 'OperatorFeatureFlagsDto',
    },
    {
      sourcePath:
        'src/modules/Farm.Modules.Calibration/Services/Capabilities/CalibrationCapabilityService.cs',
      blobHash: 'b3856c06f7e6827024dfbebba13cc86548241595',
      typeName: 'CalibrationCapabilityService',
      note: 'Hardcoded-false calibration flags at lines 203-205; cited by the mis-fix counterfactual.',
    },
  ],
};
