/**
 * CalibrationProjectCreateRequest / CalibrationProjectDto — snapshot of the
 * request and response shapes for `POST /api/calibration-projects` (issue
 * #798: create a server-side `CalibrationProject` at calibration start).
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  0720b9d146256c69fa2780c029ab5982bba509a1
 * Source file: src/modules/Farm.Modules.Calibration/Contracts/CalibrationProjectContracts.cs
 * Blob hash:   48353af39c7f6b4d9d5e0062254e5fa648860e39
 *
 * `CalibrationProjectCreateRequest` is a plain class with `{ get; init; }`
 * properties (picked up by the drift-check regex if it is ever wired in).
 * `CalibrationProjectDto` and `CalibrationFilamentIdentityDto` are C# records
 * with POSITIONAL constructor parameters, not `{ get; }` properties — the
 * shared `extractCSharpDtoFields` regex in `serverContractSnapshotDrift.ts`
 * cannot parse that syntax, which is why this snapshot is not wired into the
 * automated field-drift check (README step 5 is opt-in). The field lists
 * below were copied by hand from the record's parameter list, in
 * declaration order, camelCased per the server's `System.Text.Json` default
 * naming policy (confirmed for this controller — see
 * `src/main/calibrationHttp.ts`'s `createProject` doc comment).
 */

/**
 * `CalibrationProjectCreateRequest` — every settable property, verbatim
 * (camelCase) from the C# class.
 */
export const CALIBRATION_PROJECT_CREATE_REQUEST_FIELDS = [
  'clientId',
  'requestId',
  'name',
  'printerId',
  'printerConfigurationRevision',
  'selectedToolheadId',
  'selectedToolheadIndex',
  'filamentProvider',
  'filamentProductId',
  'filamentSku',
  'filamentVendor',
  'filamentProductName',
  'filamentMaterial',
  'filamentDiameter',
  'filamentColor',
  'filamentTypeId',
  'spoolmanFilamentId',
  'localSpoolId',
  'spoolmanSpoolId',
  'filamentSnapshot',
  'orderedSteps',
  'currentSelections',
  'currentStep',
  'experienceMode',
] as const satisfies readonly string[];

export type CalibrationProjectCreateRequestField =
  (typeof CALIBRATION_PROJECT_CREATE_REQUEST_FIELDS)[number];

/**
 * `CalibrationProjectDto` — the response body, in the record's positional
 * parameter order.
 */
export const CALIBRATION_PROJECT_DTO_FIELDS = [
  'id',
  'name',
  'lifecycleStatus',
  'experienceMode',
  'printerId',
  'selectedToolheadId',
  'selectedToolheadIndex',
  'filament',
  'orderedSteps',
  'currentStep',
  'currentSelections',
  'revision',
  'createdAtUtc',
  'updatedAtUtc',
  'completedAtUtc',
  'deletedAtUtc',
] as const satisfies readonly string[];

export type CalibrationProjectDtoField =
  (typeof CALIBRATION_PROJECT_DTO_FIELDS)[number];

/**
 * `CalibrationFilamentIdentityDto` — the nested `filament` object on
 * `CalibrationProjectDto`.
 */
export const CALIBRATION_FILAMENT_IDENTITY_DTO_FIELDS = [
  'provider',
  'productId',
  'sku',
  'vendor',
  'productName',
  'material',
  'diameter',
  'color',
  'filamentTypeId',
  'spoolmanFilamentId',
  'localSpoolId',
  'spoolmanSpoolId',
  'snapshot',
] as const satisfies readonly string[];

export type CalibrationFilamentIdentityDtoField =
  (typeof CALIBRATION_FILAMENT_IDENTITY_DTO_FIELDS)[number];

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * The guard test in `calibration.snapshotProvenanceGuard.test.ts` verifies
 * that (a) this file exports PROVENANCE, (b) when the pfarm1 checkout is on
 * disk the current git blob for `sourcePath`, resolved AT the pinned commit,
 * matches `blobHash`.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '0720b9d146256c69fa2780c029ab5982bba509a1',
  sourcePath:
    'src/modules/Farm.Modules.Calibration/Contracts/CalibrationProjectContracts.cs',
  blobHash: '48353af39c7f6b4d9d5e0062254e5fa648860e39',
  typeName: 'CalibrationProjectCreateRequest',
  additionalSources: [
    {
      sourcePath:
        'src/modules/Farm.Modules.Calibration/Controllers/CalibrationProjectsController.cs',
      blobHash: '657e551a6b75fd2dfdc2a2fe85d8329d6aac7f69',
      typeName: 'CalibrationProjectsController',
      note: 'Confirms the route: POST /api/calibration-projects, and the required-field validation rules referenced in src/main/calibrationHttp.ts.',
    },
  ],
};
