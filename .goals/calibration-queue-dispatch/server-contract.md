<!--
Verified PrintFarmer server contract extracted from OlyForge3D/PrintFarmer @ development
SHA 167a3b134a678a0d9a8c10371da8333d03ddc636 on 2026-07-29.
Every claim below is cited to a file in that repository. This document is the
AUTHORITATIVE contract for issue #54: where it disagrees with the issue prose,
this document wins.
-->

I now have all the information needed. Here is the complete, citation-accurate HTTP contract reference document.

---

# PrintFarmer HTTP Contract Reference
**Branch:** `development` | **SHA:** `167a3b134a678a0d9a8c10371da8333d03ddc636`

---

## 1. POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start

```http
POST /api/job-queue/{jobId:guid}/acknowledge-bed-clear-and-start
Authorization: Bearer <token>
Idempotency-Key: <stable-string>
If-Match: <base64-job-rowversion>
X-Dispatch-State-If-Match: <base64-dispatch-state-rowversion>
Content-Type: application/json

{
  "printerId": "UUID",
  "idempotencyKey": "string (fallback if header absent)",
  "expectedPrinterConfigRevision": 42
}
```

**Source:** `src/api/Controllers/JobQueueController.cs` (method `AcknowledgeBedClearAndStartAsync`)

### Route / Verb / Auth
| Attribute | Value | Citation |
|-----------|-------|---------|
| HTTP verb | POST | `[HttpPost("{jobId:guid}/acknowledge-bed-clear-and-start")]` |
| Controller route | `[Route("api/job-queue")]` | controller class attribute |
| `[Authorize]` | yes, on controller class | |
| `[RequirePermission]` | `"queue:acknowledge-bed-clear"` AND `"queue:start"` | `src/infra/Security/PrintFarmerPermissions.cs` |

### Header Binding

All three headers are read via `Request.Headers[...]`, **not** via model binding:

| Header | Behaviour if missing |
|--------|---------------------|
| `Idempotency-Key` | Falls back to `request.IdempotencyKey` (body). If still blank → **428** `precondition_required` |
| `If-Match` | **428** `precondition_required` |
| `X-Dispatch-State-If-Match` | **428** `precondition_required` |

ETag decoding: `DecodeEtag()` strips `W/` prefix and surrounding quote characters, then calls `Convert.FromBase64String()`. A bad base-64 value → **400**. `src/api/Controllers/JobQueueController.cs`

### Request Body DTO — `AcknowledgeBedClearRequestDto`
`src/api/Controllers/Requests/AcknowledgeBedClearRequestDto.cs`

| Property | C# Type | Notes |
|----------|---------|-------|
| `PrinterId` | `Guid` | The printer the job is assigned to |
| `IdempotencyKey` | `string?` | Header takes precedence; this is body fallback |
| `ExpectedPrinterConfigRevision` | `long?` | Guards against printer config advancing since the client read the job |

### Status Code Table

| Status | Error `code` string (literal) | Body Shape | Outcome Enum |
|--------|-------------------------------|-----------|--------------|
| **202 Accepted** | *(none)* | `{message, jobETag, dispatchStateETag}` | `BedClearAckOutcome.Accepted` |
| **200 OK** | *(none)* | `{message, jobETag, dispatchStateETag}` | `Replayed` or `AlreadyStartingOrPrinting` |
| **400 Bad Request** | *(varies)* | `{error}` | missing body / bad ETag format |
| **403 Forbidden** | `"forbidden"` | `{error, detail}` | `Forbidden` |
| **404 Not Found** | `"job_not_found"` | `{error, detail}` | `JobNotFound` |
| **409 Conflict** | `"wrong_job"` | `{error, detail}` | `WrongJob` |
| **409 Conflict** | `"printer_busy"` | `{error, detail}` | `PrinterBusy` |
| **409 Conflict** | `"job_not_dispatchable"` | `{error, detail}` | `JobNotDispatchable` |
| **409 Conflict** | `"idempotency_payload_mismatch"` | `{error, detail}` | `IdempotencyMismatch` |
| **412 Precondition Failed** | `"dispatch_revision_conflict"` | `{error, detail, jobETag, dispatchStateETag}` | `DispatchRevisionConflict` |
| **422 Unprocessable** | `"calibration_job_incompatible"` | `{error, detail}` | `CalibrationJobIncompatible` |
| **422 Unprocessable** | `"filament_check_failed"` | `{error, detail}` | `FilamentCheckFailed` |
| **428 Precondition Required** | `"precondition_required"` | `{error, detail}` | `PreconditionRequired` |
| **503 Service Unavailable** | `"printer_offline_or_stale"` | `{error, detail}` | `PrinterOfflineOrStale` |

All enum values cited from `src/infra/Services/Queue/IBedClearAcknowledgementService.cs`. All HTTP mappings cited from `src/api/Controllers/JobQueueController.cs` (`result.Outcome switch`).

**Success body** (202 / 200) — `BuildAckResponse()`:
```json
{
  "message": "Bed-clear acknowledged; dispatch will start shortly.",
  "jobETag": "base64...",
  "dispatchStateETag": "base64..."
}
```
`jobETag` and `dispatchStateETag` may be `null` if the service did not have current row versions.

**412 body** — returns **current** ETags (not the submitted ones) so the client can retry:
```json
{
  "error": "dispatch_revision_conflict",
  "detail": "...",
  "jobETag": "base64...",
  "dispatchStateETag": "base64..."
}
```

**Response headers set:** None. No `Location`, no `Retry-After`, no `Idempotency-Replayed`.

---

## 2. POST /api/job-queue (calibration job creation)

```http
POST /api/job-queue
Authorization: Bearer <token>
Idempotency-Key: <stable-string>
Content-Type: application/json

{
  "gcodeFileId": "UUID",
  "jobKind": "FilamentCalibration",
  "idempotencyKey": "string",
  "idempotencyScope": "calib-project-UUID",
  "calibrationProjectId": "UUID",
  "calibrationAttemptId": "UUID",
  "calibrationConfigSnapshotId": "UUID",
  "calibrationOrchestrationId": "UUID",
  "sourceArtifactId": "UUID",
  "assignedPrinterId": "UUID",
  "priority": "Normal",
  "pinnedPrinterConfigRevision": 42,
  "requiredFirmwareFamily": "Klipper",
  "requiredGcodeDialect": "Klipper",
  "requiredSlicerEngine": "OrcaSlicer",
  "requiredSlicerDistribution": "upstream",
  "requiredSlicerVersion": "2.2.0",
  "requiredSlicerContainerDigest": "sha256:...",
  "gcodeContentSha256": "hex64",
  "specificationSha256": "hex64",
  "machineProfileSha256": "hex64",
  "processProfileSha256": "hex64",
  "filamentProfileSha256": "hex64",
  "printerConfigSnapshotSha256": "hex64",
  "copies": 1
}
```

**Source:** `src/api/Controllers/JobQueueController.cs` (`QueueJobAsync`), `src/infra/Dtos/QueueDtos.cs` (`QueuePrintJobDto`)

### `JobKind` enum (literal serialized values)
`src/infra/Domain/PrintJobEnums.cs` — `[JsonConverter(typeof(JsonStringEnumConverter))]`
```
Standard = 0        → wire: "Standard"
FilamentCalibration = 1  → wire: "FilamentCalibration"
```

### Idempotency Semantics

| Scenario | Status | Response Headers |
|----------|--------|-----------------|
| New job | **201 Created** | `Location: /api/job-queue/{id}`, `ETag: "{rowVersion}"`, `X-Dispatch-State-ETag: "{dispatchStateRowVersion}"`, `Idempotency-Replayed: false` |
| Exact replay | **200 OK** | `Idempotency-Replayed: true` |
| Payload hash mismatch | **409 Conflict** | `{error: "idempotency_payload_mismatch", detail}` |
| Calibration resource not found | **404** | `{error: "calibration_resource_not_found", detail}` |
| Calibration job incompatible | **422** | `{error: "calibration_job_incompatible", detail}` |

Header `Idempotency-Key` is read first and overwrites `request.IdempotencyKey`. `src/api/Controllers/JobQueueController.cs`

### `PrintJobPriority` enum
`src/infra/Dtos/PrintJobDtos.cs`
```
Low = 0, Normal = 1, High = 2, Urgent = 3
```
Default for `QueuePrintJobDto.Priority` is `PrintJobPriority.Normal`.

---

## 3. Dispatch State / Job State DTOs

### `JobQueuePrintJobDto` (response to GET and POST /api/job-queue)
`src/infra/Dtos/QueueDtos.cs`

```
id: Guid
rowVersion: string?                   // base64 job ETag → send as If-Match on mutations
revision: long                         // logical (provider-independent) job revision
dispatchStateRowVersion: string?       // base64 dispatch state ETag → send as X-Dispatch-State-If-Match
dispatchStateRevision: long?           // logical dispatch state revision
dispatchResult: DispatchAttemptResultDto?
jobKind: "Standard"|"FilamentCalibration"|null
calibrationProjectId: Guid?
pinnedPrinterConfigRevision: long?
isIdempotentReplay: bool
gcodeFileId: Guid?
gcodeFileName: string
assignedPrinterId: Guid?
assignedPrinterName: string
status: PrintJobStatus?                // see enum below
priority: int
queuePosition: int
copies: int, completedCopies: int, remainingCopies: int
...timestamps, costs, filament fields...
toolheadUsages: PrintJobToolheadUsageDto[]
createdAt: DateTime, updatedAt: DateTime
```

### `PrintJobStatus` enum (exact literal values)
`src/infra/Dtos/PrintJobDtos.cs` — custom permissive JSON converter accepts numeric or string

```
Queued = 0, Assigned = 1, Starting = 2, Printing = 3,
Paused = 4, Completed = 5, Failed = 6, Cancelled = 7
```

Active states (used in subscription-resources filter): `Queued`, `Assigned`, `Starting`, `Printing`, `Paused`.

### `DispatchAttemptResultDto`
`src/infra/Dtos/PrintQueue/PrintQueueDtos.cs`

```
attemptId: Guid?
attemptNumber: int?
outcome: DispatchAttemptOutcome          // see enum
backendAcceptedAtUtc: DateTime?
errorCode: string?
errorDetail: string?
isRetryable: bool
requiresReconciliation: bool
jobRevision: string?                    // base64 byte array
dispatchStateRevision: string?          // base64 byte array
```

### `DispatchAttemptOutcome` enum
`src/infra/Domain/PrintJobEnums.cs` — `[JsonConverter(typeof(JsonStringEnumConverter))]`

```
InProgress = 0, Accepted = 1, Rejected = 2, FailedBeforeStart = 3, Unknown = 4
```

`MapDispatchResponse()` maps outcomes → HTTP: `Accepted` → 200, `Unknown` → 202, `Rejected`/`FailedBeforeStart` → 409, others → 503.

### Bed-clear state string values
`src/infra/Domain/QueueDispatchEntities.cs` (comment on `QueueDispatchOutbox.BedClearState`):

| Value | Meaning |
|-------|---------|
| `"None"` | No active acknowledgement |
| `"Acknowledged"` | Operator acknowledged bed clear; not yet consumed |
| `"Consumed"` | Consumed by a dispatch claim |
| `"Invalidated"` | Stale — job changed, queue changed, or expired |

These are the values appearing in `QueueEventEnvelope.BedClearState` (the SignalR/change-feed field). They are **distinct** from `BedClearCommandStatus` enum (`Pending/Claimed/Accepted/Rejected/Unknown/Expired`) which is the internal durable record state; clients never see `BedClearCommandStatus` directly.

### ETag semantics
- `rowVersion` / `dispatchStateRowVersion` in responses are base-64 encoded `byte[]` (SQL Server `rowversion` or equivalent).
- When sending `If-Match` / `X-Dispatch-State-If-Match`, send the value exactly as received — no transformation. Server strips quotes and `W/` before base-64 decoding.
- `ETag` response header format: `"{rowVersion}"` (quoted). `X-Dispatch-State-ETag` same format.

---

## 4. GET Endpoints for REST State Reconciliation

### GET /api/job-queue/{id}
`src/api/Controllers/JobQueueController.cs`
- Auth: `[RequirePermission("queue:read")]`
- Returns: `JobQueuePrintJobDto`
- Response headers: `ETag: "{rowVersion}"`, `X-Dispatch-State-ETag: "{dispatchStateRowVersion}"`

### GET /api/job-queue/changes (change feed / cursor poll)
- Auth: `[RequirePermission("queue:read")]`
- Query params: `afterSequence: long` (default 0), `limit: int` (default 100, max 500)
- Returns:
```json
{
  "afterSequence": 0,
  "nextSequence": 42,
  "hasMore": false,
  "events": [QueueEventEnvelope, ...]
}
```
- **Filtered out** (not exposed to clients): `BedClearAcknowledgementService.BackendStartCommandEventType` and `BackendControlCommandConsumerService.EventType` (internal dispatch command events). Only lifecycle/state events reach the client.
- Errors: 400 for invalid cursor, 503 if db/authorization unavailable.

### GET /api/job-queue/subscription-resources
- Auth: `[RequirePermission("queue:read")]`
- Returns: `QueueSubscriptionResourcesDto { PrinterIds: UUID[], JobIds: UUID[], ProjectIds: UUID[] }`
- Only active jobs (Queued/Assigned/Starting/Printing/Paused) are included.

### Routes that DO NOT EXIST
| Desktop Call | Server-side Status |
|-------------|-------------------|
| `GET /api/calibration-projects/{projectId}/queue` | **DOES NOT EXIST** — confirmed by full read of `CalibrationProjectsController.cs` |
| `GET /api/calibration-projects/{projectId}/generation` | **DOES NOT EXIST** — same confirmation |

---

## 5. Generation Orchestration (issue #899)

### POST /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job
`src/api/Controllers/CalibrationGenerationController.cs`

```http
POST /api/calibration-projects/{projectId:guid}/attempts/{attemptId:guid}/generate-job
Authorization: Bearer <token>
Idempotency-Key: <stable-string>
Content-Type: application/json

{
  "method": "temperature",
  "definitionVersion": "1.0",
  "baseRevision": 5,
  "options": {
    "startCelsius": 200,
    "endCelsius": 240,
    "stepCelsius": 5,
    "startRatio": null,
    "endRatio": null,
    ...
  }
}
```

**Auth:** `[RequirePermission("calibration:generate")]` + `[RequirePermission("slicing:submit")]`

**`CalibrationGenerateJobRequest`** (`src/api/Contracts/CalibrationGenerationContracts.cs`):

| Property | Type | Notes |
|----------|------|-------|
| `Method` | `string` | e.g. `"temperature"` |
| `DefinitionVersion` | `string` | e.g. `"1.0"` |
| `Options` | `CalibrationMethodOptionsRequest?` | See below |
| `BaseRevision` | `long?` | Optimistic revision — 412 if stale |

**`CalibrationMethodOptionsRequest`** — all `nullable` scalars, only applicable ones needed:
`StartCelsius`, `EndCelsius`, `StepCelsius` (temp tower) | `StartRatio`, `EndRatio`, `StepRatio` (flow sweep) | `FlowRatio` (flow verification) | `StartPressureAdvance`, `EndPressureAdvance`, `StepPressureAdvance`, `LineCount`, `LineLengthMillimeters`, `CornersPerRow` (PA) | `StartLengthMillimeters`, `EndLengthMillimeters`, `StepLengthMillimeters`, `RetractionSpeedMillimetersPerSecond` (retraction) | `StartCubicMillimetersPerSecond`, `EndCubicMillimetersPerSecond`, `StepCubicMillimetersPerSecond` (MVS) | `NominalLengthMillimeters`, `BarWidthMillimeters` (shrinkage) | `Model3DId: Guid?`, `ExpectedSha256: string?` (final print)

**Status codes:** 202 (new/resumed), 200 (exact replay), 409 (saga semantic conflict), 412 (`baseRevision` stale), 422 (invalid options), 503 (worker unavailable).
Response body on success: `CalibrationOrchestrationStatusDto`.

### GET /api/calibration-orchestrations/{id}
`src/api/Controllers/CalibrationGenerationController.cs` (`CalibrationOrchestrationsController`)
- Auth: `[RequirePermission("calibration:read")]`
- Returns: `CalibrationOrchestrationStatusDto`

**`CalibrationOrchestrationStatusDto`** (`src/api/Contracts/CalibrationGenerationContracts.cs`):

| Property | Type | Notes |
|----------|------|-------|
| `Id` | `Guid` (required) | |
| `ProjectId` | `Guid` (required) | |
| `AttemptId` | `Guid` (required) | |
| `OperationId` | `string` (required) | idempotency key |
| `Status` | `string` (required) | e.g. `"Running"`, `"Completed"` — NOT an enum, values from saga impl |
| `CurrentStep` | `string` (required) | e.g. `"Slicing"` — NOT an enum, values from saga impl |
| `Revision` | `long` (required) | |
| `RetryCount` | `int` (required) | |
| `NextRetryAtUtc` | `DateTime?` | |
| `StepStartedAtUtc` | `DateTime?` | |
| `LastErrorCode` | `string?` | stable snake_case |
| `Problems` | `CalibrationGenerationProblemDto[]` | `{Code, Field, Message}` — empty on success |
| `Model3DId`, `SliceJobId`, `WorkerId`, `SourceArtifactId`, `FinalArtifactId`, `GcodeFileId` | `Guid?` | |
| `SpecificationSha256`, `PlanManifestSha256`, `GcodeSha256`, `ManifestSha256`, `GeneratorVersion`, `SlicerContainerDigest`, `SlicerBinarySha256` | `string?` | |
| `StatusRoute` | `string` (required) | authenticated URL for polling this orchestration |
| `CreatedAtUtc`, `UpdatedAtUtc` | `DateTime` (required) | |
| `CompletedAtUtc` | `DateTime?` | |

---

## 6. SignalR Event Envelope

### Hub
- Class: `PrinterHub`, `src/infra/Services/SignalR/PrinterHub.cs`
- Mapped route: `/hubs/printers` — `src/api/Program.cs`: `app.MapHub<PrinterHub>("/hubs/printers")`
- Auth: `[Authorize]` on hub class

### Group Name Strings (all literal)
`src/infra/Security/AuthorizedHubGroups.cs`

| Group | String pattern |
|-------|---------------|
| Farm-wide | `"Farm-default"` (const) |
| Administrators | `"FarmAdministrators"` (const) |
| Queue readers | `"QueueReaders"` (const) |
| Slicing monitors | `"SlicingMonitors"` (const) |
| Per-user | `$"User-{userId}"` |
| Per-printer | `$"Printer-{printerId}"` |
| Per-queue-job | `$"QueueJob-{queueJobId}"` |
| Per-project | `$"Project-{projectId}"` |
| Per-calib-attempt | `$"CalibrationAttempt-{calibrationAttemptId}"` |
| Per-slice-job | `$"Job-{jobId}"` |
| Per-discovery-session | `$"discovery-{sessionId}"` (ad-hoc) |

### Auto-joined Groups on `OnConnectedAsync`
- `"User-{userId}"` — all authenticated users
- `"FarmAdministrators"` — if farm admin
- `"QueueReaders"` — if has `queue:read` permission

### Client → Server Hub Methods
| Method wire name | Joins group | Notes |
|-----------------|-------------|-------|
| `SubscribeToPrinterAsync(printerId)` | `"Printer-{id}"` | Replays cached `PrinterStatusDto` to caller |
| `SubscribeToQueueJobAsync(jobId)` | `"QueueJob-{id}"` | ACL-checked via `IQueueResourceAuthorizationService` |
| `SubscribeToProjectAsync(projectId)` | `"Project-{id}"` | ACL-checked |
| `SubscribeToFarmAsync()` | `"Farm-default"` | Farm admin only |
| `UnsubscribeFromPrinterAsync(printerId)` | leaves | |
| `UnsubscribeFromQueueJobAsync(jobId)` | leaves | |
| `UnsubscribeFromProjectAsync(projectId)` | leaves | |
| `RequestPrinterStatus(printerId)` [HubMethodName] | — | Sends `"printerupdated"` to caller |
| `JoinDiscoveryGroupAsync(sessionId)` | `"discovery-{sessionId}"` | Replays cached progress |
| `LeaveDiscoveryGroupAsync(sessionId)` | leaves | |

### Server → Client Events
`src/infra/Services/Queue/QueueOutboxPublisherService.cs` — the outbox publisher

| Event name | Payload | Sent to |
|-----------|---------|--------|
| `"printerupdated"` | `PrinterStatusDto` | `"Printer-{printerId}"` group |
| `"discoveryprogress"` | `DiscoveryProgressDto` | `"discovery-{sessionId}"` group |
| `"queueresourceschanged"` | **no payload** | `"QueueReaders"` group (hint to re-call `/api/job-queue/subscription-resources`) |
| `"queueevent"` | `QueueEventEnvelope` (full) | `"QueueJob-{jobId}"` group |
| `"queueevent"` | `QueueEventEnvelope` (full) | `"Project-{projectId}"` group |
| `"queueevent"` | `QueueEventEnvelope` (**REDACTED**) | `"Printer-{printerId}"` group |

**REDACTED for printer group:** `RedactForPrinter()` forces `EventType = "PrintFarmer.Queue.PrinterStateChanged.v1"` and nulls `JobId`, `ProjectId`, `CalibrationAttemptId`, `JobKind`, `JobRevision`, `DispatchStateRevision`, `AttemptId`, `AttemptNumber`, `AttemptOutcome`, `BedClearState`, `BedClearCommandId`, `BedClearExpiresAtUtc`, `ErrorCode`, `FailureCode`, `FailureRetryable`, `FailureRequiresReconciliation`, `PayloadJson`, `JobLogicalRevision`, `DispatchStateLogicalRevision`. `src/infra/Services/SignalR/QueueEventEnvelope.cs`

### `QueueEventEnvelope` record (complete property list)
`src/infra/Services/SignalR/QueueEventEnvelope.cs` | `src/infra/Domain/QueueDispatchEntities.cs` (`QueueEventSchemaVersions.Current = "3"`)

```typescript
schemaVersion: string            // "3" (constant QueueEventSchemaVersions.Current)
eventId: UUID                    // durable — stable across redeliveries
sequence: long                   // monotonic outbox sequence — use for gaps / cursor
eventType: string                // e.g. "PrintFarmer.Queue.CalibrationJobQueued.v1"
occurredAtUtc: DateTime          // durable write timestamp — stable across redeliveries
jobId: UUID | null
printerId: UUID | null
projectId: UUID | null
calibrationAttemptId: UUID | null
jobStatus: string | null         // "Queued","Assigned","Starting","Printing","Paused","Completed","Failed","Cancelled"
jobKind: string | null           // "Standard","FilamentCalibration"
jobRevision: string | null       // base-64 byte array
dispatchStateRevision: string | null   // base-64 byte array
attemptId: UUID | null
attemptNumber: int | null
attemptOutcome: string | null    // "InProgress","Accepted","Rejected","FailedBeforeStart","Unknown"
bedClearState: string | null     // "None","Acknowledged","Consumed","Invalidated"
bedClearCommandId: UUID | null
bedClearExpiresAtUtc: DateTime | null
errorCode: string | null         // legacy field kept for wire compatibility
failureCode: string | null       // typed terminal/failure code
failureRetryable: bool | null
failureRequiresReconciliation: bool | null
payloadJson: string | null       // redacted JSON, public identifiers only
jobLogicalRevision: long | null  // provider-independent revision counter
dispatchStateLogicalRevision: long | null
```

---

## GAPS AND CONTRADICTIONS

### (a) Issue #900 prose vs. shipped code — items NOT implemented or contradicted

1. **`dispatch_revision_conflict` is 412, not 409.** The user's question listed it as a possible 409. The `IBedClearAcknowledgementService.cs` doc comment says `412`, and the controller switch case confirms `StatusCodes.Status412PreconditionFailed`. If any spec doc said 409, the code says 412.

2. **No `Retry-After` header on 503.** The 503 `printer_offline_or_stale` response does not set a `Retry-After` header. `src/api/Controllers/JobQueueController.cs`.

3. **No `Idempotency-Replayed` header on the bed-clear endpoint.** `Idempotency-Replayed` is only set on `POST /api/job-queue`. The acknowledge-bed-clear endpoint returns 200 for replays with no such header — the body `message` field is the only distinguishing signal.

4. **Two different bed-clear status concepts.** `BedClearCommandStatus` enum (internal durable record: `Pending/Claimed/Accepted/Rejected/Unknown/Expired`, `src/infra/Domain/PrintJobEnums.cs`) is NOT the same as `BedClearState` string (SignalR/outbox field: `None/Acknowledged/Consumed/Invalidated`, `src/infra/Domain/QueueDispatchEntities.cs`). Clients only see the latter.

5. **`CalibrationOrchestrationStatusDto.Status` and `.CurrentStep` are free strings, not enums.** Their legal values are defined by the saga implementation, not by the contracts file. Desktop code cannot exhaustively switch on them. `src/api/Contracts/CalibrationGenerationContracts.cs`.

### (b) Desktop client calls that DO NOT EXIST server-side — CRITICAL

1. **`GET /api/calibration-projects/{projectId}/queue` — DOES NOT EXIST.** A full read of `src/api/Controllers/CalibrationProjectsController.cs` confirms no such route. The desktop must use `GET /api/job-queue/{id}` (REST) or `"queueevent"` on a `QueueJob-{jobId}` SignalR group for job-level state.

2. **`GET /api/calibration-projects/{projectId}/generation` — DOES NOT EXIST.** Same controller, confirmed absent. The correct endpoint for generation status is `GET /api/calibration-orchestrations/{orchestrationId}`.

3. **`QueueReaders` group does NOT receive `"queueevent"`.** Only `"queueresourceschanged"` (no payload) goes to `QueueReaders`. Full envelopes go to `"QueueJob-{jobId}"` and `"Project-{projectId}"` groups. The desktop MUST call `SubscribeToQueueJobAsync(jobId)` after queuing a job to receive real-time dispatch events.

4. **Printer group receives ONLY redacted envelopes.** A desktop subscribing to `"Printer-{printerId}"` via `SubscribeToPrinterAsync` will receive `"queueevent"` messages where `jobId`, `jobRevision`, `attemptOutcome`, `bedClearState`, and all sensitive fields are null, and `eventType` is always `"PrintFarmer.Queue.PrinterStateChanged.v1"`. For full job data subscribe to the job group, not the printer group.
