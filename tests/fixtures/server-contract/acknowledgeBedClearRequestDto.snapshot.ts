/**
 * AcknowledgeBedClearRequestDto — snapshot of the server request body for
 * POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  678d3398934537ff6ee4528c2e51aaa4a244d37f
 * Branch:      development (at snapshot time)
 * Source file: src/modules/Farm.Modules.PrintQueue/Controllers/Requests/AcknowledgeBedClearRequestDto.cs
 * Blob hash:   c3efe8fec5186b851bac402cc78d270b4daa717c
 * C# type:     Farm.Web.Api.Controllers.Requests.AcknowledgeBedClearRequestDto
 *
 * Header preconditions enforced by the action (see JobQueueController.cs
 * `AcknowledgeBedClearAndStartAsync`, blob f6188167cd298869ee4683db1fa005f4d9eca539):
 *   - Idempotency-Key            (has body fallback via IdempotencyKey field;
 *                                 428 requires BOTH header and body blank)
 *   - If-Match                   (no body fallback; 428 if absent)
 *   - X-Dispatch-State-If-Match  (no body fallback; 428 if absent)
 */

/**
 * Every camelCase property name accepted by the server's
 * [FromBody] AcknowledgeBedClearRequestDto request binder.
 */
export const ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_FIELDS = [
  'printerId',
  'idempotencyKey',
  'expectedPrinterConfigRevision',
] as const satisfies readonly string[];

export type AcknowledgeBedClearRequestDtoField =
  (typeof ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_FIELDS)[number];

/**
 * Only `printerId` is structurally required by the server (the property has
 * no `?` in C# and defaults to Guid.Empty, which the dispatch service
 * rejects). `idempotencyKey` on the wire is a defensive belt-and-braces
 * mirror of the header; `expectedPrinterConfigRevision` is optional.
 */
export const ACKNOWLEDGE_BED_CLEAR_REQUEST_DTO_REQUIRED = [
  'printerId',
] as const satisfies readonly AcknowledgeBedClearRequestDtoField[];

/**
 * The three preconditions the server requires — enforced by
 * `BED_CLEAR_PRECONDITION_HEADER_NAMES` on the desktop side. Header names are
 * canonicalised to lowercase because Node's HTTP server lowercases incoming
 * headers on the `IncomingMessage.headers` object.
 */
export const BED_CLEAR_REQUIRED_HEADERS = [
  'idempotency-key',
  'if-match',
  'x-dispatch-state-if-match',
] as const satisfies readonly string[];

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * See `calibration.snapshotProvenanceGuard.test.ts` for the guard.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '678d3398934537ff6ee4528c2e51aaa4a244d37f',
  sourcePath:
    'src/modules/Farm.Modules.PrintQueue/Controllers/Requests/AcknowledgeBedClearRequestDto.cs',
  blobHash: 'c3efe8fec5186b851bac402cc78d270b4daa717c',
  typeName: 'AcknowledgeBedClearRequestDto',
  additionalSources: [
    {
      sourcePath:
        'src/modules/Farm.Modules.PrintQueue/Controllers/JobQueueController.cs',
      blobHash: 'f6188167cd298869ee4683db1fa005f4d9eca539',
      typeName: 'JobQueueController.AcknowledgeBedClearAndStartAsync',
      note: 'Enforces the three required headers (Idempotency-Key, If-Match, X-Dispatch-State-If-Match).',
    },
  ],
};
