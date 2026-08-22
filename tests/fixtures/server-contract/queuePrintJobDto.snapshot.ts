/**
 * QueuePrintJobDto — snapshot of the server request body for
 * POST /api/job-queue.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e
 * Branch:      development (at snapshot time)
 * Source file: src/infra/Dtos/QueueDtos.cs
 * Blob hash:   d43cc5354d53c4fc217f659fc7db279933df5501
 * C# type:     Farm.Infrastructure.Dtos.PrintQueue.QueuePrintJobDto (lines 80–202)
 *
 * The property list below is copied verbatim from the server DTO's C# properties.
 * Names use camelCase because the PrintFarmer API is served with the default
 * System.Text.Json naming policy (JsonNamingPolicy.CamelCase).
 *
 * When the server changes:
 *   - Bump the commit SHA and blob hash above.
 *   - Update the field list to match the new C# properties.
 *   - Run `npx vitest run tests/calibration.mockPrinterDispatch.test.ts` — the
 *     drift check will flag any mismatch against the local server checkout.
 */

/**
 * Every camelCase property name accepted by the server's
 * [FromBody] QueuePrintJobDto request binder.
 */
export const QUEUE_PRINT_JOB_DTO_FIELDS = [
  'gcodeFileId',
  'jobKind',
  'idempotencyKey',
  'idempotencyScope',
  'calibrationProjectId',
  'calibrationAttemptId',
  'calibrationConfigSnapshotId',
  'calibrationOrchestrationId',
  'sourceArtifactId',
  'gcodeContentSha256',
  'requiredFirmwareFamily',
  'requiredGcodeDialect',
  'requiredSlicerEngine',
  'requiredSlicerDistribution',
  'requiredSlicerVersion',
  'requiredSlicerContainerDigest',
  'specificationSha256',
  'machineProfileSha256',
  'processProfileSha256',
  'filamentProfileSha256',
  'printerConfigSnapshotSha256',
  'pinnedPrinterConfigRevision',
  'assignedPrinterId',
  'priority',
  'requiredNozzleDiameter',
  'requiredMaterialType',
  'requiredCapabilities',
  'requiredPrinterModel',
  'projectId',
  'projectName',
  'spoolmanFilamentId',
  'filamentName',
  'filamentVendor',
  'filamentColor',
  'copies',
  'projectFileId',
  'plateIndex',
  'plateName',
  'deadlineAtUtc',
] as const satisfies readonly string[];

export type QueuePrintJobDtoField = (typeof QUEUE_PRINT_JOB_DTO_FIELDS)[number];

/**
 * The C# properties that are structurally required for a
 * calibration-print request (kind = FilamentCalibration).
 *
 * A calibration wire request MUST carry `gcodeFileId` (points to the artifact)
 * and `jobKind` (discriminator that unlocks the calibration dispatch path).
 * `idempotencyKey` is server-normalised: header wins, but the desktop client
 * always sends it in the body too — so it is required on the wire we assert.
 */
export const QUEUE_PRINT_JOB_DTO_REQUIRED_FOR_CALIBRATION = [
  'gcodeFileId',
  'jobKind',
  'idempotencyKey',
] as const satisfies readonly QueuePrintJobDtoField[];

/**
 * JobKind enum values recognised by the server's job-queue endpoint.
 * Serialised as strings under the default `JsonStringEnumConverter` configured
 * for PrintFarmer. Verified against `src/infra/Domain/JobKind.cs` at the same
 * commit; the two calibration-relevant values below MUST be a subset of the
 * live enum. The drift check enforces membership rather than equality: the
 * server may add new job kinds without breaking the desktop.
 */
export const CALIBRATION_JOB_KIND = 'FilamentCalibration' as const;

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * See `calibration.snapshotProvenanceGuard.test.ts` for the guard.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  sourcePath: 'src/infra/Dtos/QueueDtos.cs',
  blobHash: 'd43cc5354d53c4fc217f659fc7db279933df5501',
  typeName: 'QueuePrintJobDto',
};
