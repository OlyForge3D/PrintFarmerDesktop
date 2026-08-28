/**
 * capabilitiesLiveResponse.snapshot.ts — VERBATIM captured live response
 * from GET /api/calibration/capabilities on Bishop's daily-validation stack.
 *
 * WHY THIS FIXTURE EXISTS
 * -----------------------
 * The Round-3 capability-flag test encoded a shape asserted in prose by the
 * coordinator and never verified against the wire. Half the fields were
 * inverted. Round 4 closes that hole by requiring every payload the tests
 * evaluate to come from ONE of two provenance kinds:
 *   - `csharp-source`   — a C# DTO whose blob hash pins the field NAMES; or
 *   - `live-response`   — a captured wire response whose `serverVersion` pins
 *                         the field VALUES.
 *
 * A payload asserted in a prompt is not a source. See
 * `calibration.snapshotProvenanceGuard.test.ts` for the machine check that
 * enforces the rule.
 *
 * CAPTURE
 * -------
 * curl -s http://localhost:18080/api/calibration/capabilities
 *   Host      : Bishop's daily-validation stack, nginx on loopback 18080
 *               (API 15245, moonraker-ready 17125)
 *   Wire      : Response body reproduced BELOW verbatim as of capture time.
 *   Auth      : Anonymous (capabilities endpoint is unauthenticated).
 *   Timestamp : 2026-08-21T21:52-07:00 (America/Los_Angeles)
 *
 * The `serverVersion` field is what makes this fixture cross-referenceable
 * against the C# DTO snapshots — it contains the source commit SHA and can
 * be diffed against `PROVENANCE.commitSha` on those snapshots. The provenance
 * guard test does exactly that.
 */

export const CAPABILITIES_LIVE_RESPONSE = {
  apiContractVersion: '1.0',
  minimumSupportedApiContractVersion: '1.0',
  serverVersion: '0.2.3+6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  calibrationApiVersion: '1.0',
  calibrationSchemaVersion: '1.0',
  deploymentMode: 'split',
  architecture: 'X64',
  slicingEnabled: true,
  slicingConfigured: false,
  slicingOperational: false,
  calibrationContextEnabled: true,
  calibrationPersistenceEnabled: true,
  calibrationSyncEnabled: true,
  calibrationPhotosEnabled: true,
  calibrationProfileHistoryEnabled: true,
  calibrationGenerationEnabled: false,
  calibrationSlicingEnabled: false,
  calibrationArtifactPromotionEnabled: false,
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
  operatorFeatures: {
    attentionEnabled: true,
    nativePushEnabled: false,
    filamentCoverageEnabled: true,
    guidedSwapEnabled: true,
    multiSlotFallbackEnabled: true,
    shiftPlanEnabled: true,
    printedPartsInventoryEnabled: false,
    offlineWriteReplayEnabled: true,
  },
  supportedSlicerEngines: [
    {
      type: 'OrcaSlicer',
      version: '2.4.2',
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
    printers: '/api/printers',
    calibrationCandidates: '/api/printers/calibration-candidates',
    calibrationContext:
      '/api/printers/{id}/calibration-context?slicerType=OrcaSlicer',
    calibrationProjects: '/api/calibration-projects',
    calibrationGenerateJob:
      '/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job',
    calibrationOrchestration: '/api/calibration-orchestrations/{id}',
    calibrationSync: '/api/calibration-sync/changes',
    calibrationImports: '/api/calibration-imports/legacy-v4',
    sliceJobs: '/api/slice',
    sliceJob: '/api/slice/{id}',
    jobArtifact: '/api/artifacts/job/{jobId}',
    gcodePromotions: '/api/gcode-promotions',
    gcodePromotion: '/api/gcode-promotions/{operationId}',
    printerHub: '/hubs/printers',
    slicerRegistryHub: '/hubs/slicer-registry',
    slicerProgressHub: '/hubs/slicers',
  },
  limits: {
    modelUploadMaxBytes: 104857600,
    photoUploadMaxBytes: 10485760,
    photoMaxPixels: 32000000,
  },
  acceptedMimeTypes: {
    model: [
      'application/octet-stream',
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      'model/3mf',
      'model/obj',
      'model/stl',
    ],
    photo: ['image/jpeg', 'image/png', 'image/webp'],
  },
  supportedExportFormats: ['orca-json'],
  healthyCompatibleWorker: {
    available: false,
    healthyCount: 0,
    availableSlots: 0,
    engine: 'OrcaSlicer',
    requiredVersion: '2.4.2',
    supportedVersions: ['2.4.2'],
    observedVersions: [],
    versionPolicy: 'allow-list',
    distribution: 'upstream',
  },
  unavailableReasons: [
    {
      feature: 'slicing',
      code: 'slicer_registry_unavailable',
      message: 'The slicer registry is not currently available.',
    },
    {
      feature: 'calibrationArtifactPromotion',
      code: 'artifact_source_unroutable',
      message:
        'Artifact promotion requires routable artifacts, writable G-code storage, a durable promotion checkpoint store and a healthy reconciler.',
    },
    {
      feature: 'calibrationGeneration',
      code: 'split_routing_unavailable',
      message:
        'Calibration generation requires the deterministic core, authorized model storage, the canonical slice path, an allow-listed attested worker, operational promotion, a durable orchestration store and a healthy recovery loop.',
    },
  ],
} as const;

export type CapabilitiesLiveResponse = typeof CAPABILITIES_LIVE_RESPONSE;

/**
 * PROVENANCE — the machine-checkable provenance stamp.
 *
 * `kind: 'live-response'` means the FIELD VALUES were captured off the wire.
 * The `serverVersion` field is the fingerprint for cross-referencing against
 * the C# DTO snapshots — everything after the `+` is the git commit SHA the
 * server was built from, and it MUST match `PROVENANCE.commitSha` on the
 * corresponding source snapshots (`platformCapabilitiesDto.snapshot.ts` here).
 *
 * The guard test enforces both:
 *   1. `PROVENANCE.serverVersion === CAPABILITIES_LIVE_RESPONSE.serverVersion`
 *      — the stamp cannot lie about the response it belongs to.
 *   2. The commit SHA embedded in serverVersion matches a sibling
 *      `csharp-source` snapshot's `PROVENANCE.commitSha`.
 */
export const PROVENANCE = {
  kind: 'live-response' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  capturedFrom: 'http://localhost:18080/api/calibration/capabilities',
  serverVersion: '0.2.3+6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  capturedAt: '2026-08-21T21:52-07:00',
  /**
   * The csharp-source snapshots in this directory have moved forward to
   * `678d339…`; no source snapshot remains at `6cf79de…`, so this capture is
   * no longer anchored by commit equality.
   *
   * This field is NOT a re-stamp. The body below is still the verbatim
   * response from a server built at `6cf79de…` — re-stamping `commitSha` to
   * the newer pin would claim a capture from a server nobody contacted, which
   * is precisely the fabrication the provenance guard exists to catch.
   *
   * Known deltas between this capture and the `678d339…` contract:
   *   - `calibrationGenerationEnabled` — DELETED server-side (7169f1d32 /
   *     #1995) along with the generator subsystem (D2/#1979). Still present in
   *     the body below because the server did send it at capture time.
   *   - `supportedExportFormats` — DELETED by the same commit.
   *
   * Neither delta weakens this fixture's current job: it is the payload the
   * flag-mapping suite parses, and the desktop schema is `.passthrough()`, so
   * the two dead fields are inert. `calibrationSlicingEnabled` — the field the
   * desktop's generation flag now binds to — is present in the capture, so the
   * re-pointed alias is exercised against real captured data.
   *
   * REPLACE THIS FIXTURE when a server at or after `678d339…` is reachable:
   * re-capture, update the body, set `commitSha`, and delete `supersededBy`.
   */
  supersededBy: '678d3398934537ff6ee4528c2e51aaa4a244d37f',
};
