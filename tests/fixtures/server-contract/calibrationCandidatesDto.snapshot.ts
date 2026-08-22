/**
 * CalibrationCandidateDto — snapshot of the array element returned by
 * GET /api/printers/calibration-candidates, and CalibrationContextDto —
 * snapshot of the object returned by
 * GET /api/printers/{id}/calibration-context?slicerType=OrcaSlicer.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e
 * Contracts source: src/infra/Calibration/CalibrationContracts.cs
 *   Blob SHA:       d063f0a1aeaf19669a21700ce2c81622d48d7dc0
 *   C# types:       Farm.Infrastructure.Calibration.CalibrationCandidateDto,
 *                   Farm.Infrastructure.Calibration.CalibrationContextDto
 * Controller:  src/api/Controllers/PrinterCalibrationController.cs
 *   Blob SHA:  ebde4688551bd1848d7ab17165d1ffb63d8c38dc
 *
 * CalibrationContextDto extends CalibrationCandidateDto (C# class inheritance)
 * so its wire shape is Candidate + Context-only fields. The two lists below
 * are the parts, not overlapping.
 */

/**
 * Every camelCase property name serialised on the array-element
 * `CalibrationCandidateDto` response body. This covers the fields Ripley's
 * Q5 enumerated — `toolheads`, `configurationRevision` — plus the whole
 * eligibility surface.
 */
export const CALIBRATION_CANDIDATE_DTO_FIELDS = [
  'id',
  'name',
  'enabled',
  'inMaintenance',
  'backend',
  'location',
  'configurationRevision',
  'reachability',
  'operationalState',
  'statusSource',
  'observedAtUtc',
  'lastSeenAtUtc',
  'isStale',
  'staleAfterSeconds',
  'statusSupported',
  'supportsStatus',
  'supportsFileUpload',
  'supportsStartPrint',
  'supportsUploadAndPrint',
  'supportsDirectCommand',
  'supportsMultiExtruderStatus',
  'buildVolume',
  'bedOrigin',
  'printablePolygon',
  'excludedRegions',
  'motionType',
  'maxPrintSpeed',
  'maxTravelSpeed',
  'maxAcceleration',
  'maxTravelAcceleration',
  'physicalToolheadCount',
  'activeToolheadIndex',
  'toolheads',
  'hasHeatedBed',
  'maxBedTemperature',
  'hasEnclosure',
  'hasHeatedChamber',
  'maxChamberTemperature',
  'firmware',
  'slicer',
  'profilesEvaluated',
  'eligible',
  'missingInputs',
  'rejectionReasons',
] as const satisfies readonly string[];

/**
 * The Context-only fields added by `CalibrationContextDto` on top of every
 * `CalibrationCandidateDto` field. The Q5 fields `snapshotSha256`,
 * `capturedAtUtc`, `capturedBySubject`, `schemaVersion`, and the nested
 * `snapshot` payload live here.
 */
export const CALIBRATION_CONTEXT_DTO_ADDITIONAL_FIELDS = [
  'schemaVersion',
  'snapshotSha256',
  'capturedAtUtc',
  'capturedBySubject',
  'supportsPressureAdvance',
  'supportsFirmwareRetraction',
  'calibrationHardwareVerifiedAtUtc',
  'snapshot',
] as const satisfies readonly string[];

/**
 * Combined shape a live GET calibration-context response satisfies.
 */
export const CALIBRATION_CONTEXT_DTO_FIELDS = [
  ...CALIBRATION_CANDIDATE_DTO_FIELDS,
  ...CALIBRATION_CONTEXT_DTO_ADDITIONAL_FIELDS,
] as const satisfies readonly string[];

/**
 * Every camelCase property name on the nested `RejectionReasons` array
 * element (`CalibrationRejectionReasonDto`).
 */
export const CALIBRATION_REJECTION_REASON_DTO_FIELDS = [
  'code',
  'field',
  'message',
] as const satisfies readonly string[];

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * See `calibration.snapshotProvenanceGuard.test.ts` for the guard.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  sourcePath: 'src/infra/Calibration/CalibrationContracts.cs',
  blobHash: 'd063f0a1aeaf19669a21700ce2c81622d48d7dc0',
  typeName: 'CalibrationCandidateDto',
  additionalSources: [
    {
      sourcePath: 'src/api/Controllers/PrinterCalibrationController.cs',
      blobHash: 'ebde4688551bd1848d7ab17165d1ffb63d8c38dc',
      typeName: 'PrinterCalibrationController',
      note: 'Serves candidates + context under /api/printers/**.',
    },
  ],
};
