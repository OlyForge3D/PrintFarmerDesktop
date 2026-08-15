# Printer calibration — administrator guide

Operator-facing reference for the PrintFarmer Desktop (PFD) printer calibration
feature: what a printer must report before calibration is offered, which
permissions each capability needs, how to tell whether the calibration path is
healthy, what is stored locally and for how long, and how a split deployment
differs from a monolith.

Companion recovery procedures live in [`docs/runbooks/`](./runbooks/).

> **Scope.** This document describes what PFD **emits and enforces** in this
> build. Where a contract defines something the desktop never produces, that is
> called out explicitly rather than described as if it worked. Server-side
> behaviour is described only where PFD observes it.

---

## 1. Klipper identity requirements

Calibration is offered only for printers PrintFarmer reports as explicitly,
completely Klipper. There are two independent gates, and they fail with
different reason text.

### 1.1 Server-wide firmware and slicer support

Negotiated once per server profile from the calibration capabilities endpoint.
The server must advertise **both** `Klipper` in its supported firmware families
**and** `Klipper` in its supported G-code dialects; advertising only one is not
sufficient. It must also advertise an **OrcaSlicer** engine marked as supported.

| Condition                                        | `unavailableReason`      | `unavailableDetail` (exact text)                                                          |
| ------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| Firmware family or G-code dialect is not Klipper | `unsupportedFirmware`    | `Server does not advertise Klipper firmware and G-code dialect support for calibration.`  |
| No supported OrcaSlicer engine advertised        | `unsupportedSlicer`      | `Server does not advertise a supported OrcaSlicer engine for calibration.`                |
| One or more capability flags off                 | `missingCapabilityFlags` | `Server has not enabled required calibration capabilities: <comma-separated flag names>.` |
| No server profile selected                       | `noProfile`              | `No server profile is selected.`                                                          |
| Capabilities endpoint returned 404               | `serverVersionTooLow`    | the transport error text                                                                  |
| Capabilities endpoint failed any other way       | `legacyServer`           | the transport error text                                                                  |

Firmware is checked before the slicer, and the slicer before the flags, so a
server failing two gates reports only the first.

### 1.2 Per-printer eligibility

A printer is selectable only when PrintFarmer asserts every one of the following
as an explicit literal. Anything absent, or carrying a different value, makes the
whole eligibility assertion null and the printer ineligible — there is no partial
eligibility.

- `firmwareFamily` = Klipper
- `gcodeDialect` = Klipper
- `slicerFamily` = OrcaSlicer
- `slicerDistribution` = upstream
- `slicerIdentity` = OrcaSlicer
- `hardwareContextComplete`, `safetyContextComplete`, `permissionsComplete` all
  asserted true
- `reasons` empty

`firmwareCompatible` must agree with the presence of that eligibility block; a
printer claiming compatibility without a complete eligibility assertion is
rejected as a contract violation at the boundary rather than shown as eligible.

### 1.3 Staleness

A bound printer context carries `isCurrent`. A context that is no longer current,
or that no longer matches the authoritative context field-for-field, marks the
workspace as not fresh. Two consequences an administrator will be asked about:

- A **new** calibration workspace cannot be created against a stale or mismatched
  context. The user sees: `A new calibration workspace must match the current
authoritative printer context.`
- A new workspace cannot be created at all while PFD cannot reach the server. The
  user sees: `A new calibration workspace cannot be created while PrintFarmer is offline.`
- An **existing** workspace stays editable offline, but changing its printer
  binding or base profile offline is refused: `Printer binding changes require an
authoritative online context.`

Offline here means specifically a transient transport failure — `timeout`,
`transport`, `rateLimited`, `server` or `workerUnavailable`. Any other failure
propagates rather than being treated as offline.

---

## 2. Required printer, tool, nozzle and geometry metadata

Every field below is part of the completeness check. Omission does not degrade
calibration — it removes the printer from the eligible set. That is deliberate:
calibration writes G-code to hardware, and a partially described machine is not a
machine PFD will generate for.

| Metadata                                                                                                                        | Consequence if absent                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configurationId`, `configurationRevision`                                                                                      | Context incomplete; printer ineligible, and no dispatch can be pinned to a configuration.                                                                                    |
| `snapshotId`, `snapshotRevision`                                                                                                | Context incomplete; a stale-snapshot conflict cannot be detected, so the printer is ineligible.                                                                              |
| `orcaProfileId`, `orcaProfileDisplayName`, `profileRevision`                                                                    | Context incomplete; PFD cannot bind a base profile, so generation is not offered.                                                                                            |
| `toolheads` (at least one), each with `toolId`, `toolheadId`, `extruderType`                                                    | Context incomplete; no tool can be selected.                                                                                                                                 |
| `nozzle` `id`, `diameterMm`, `material` per toolhead                                                                            | Context incomplete; nozzle-bound calibration cannot be bound.                                                                                                                |
| `nozzleDiameterMm` on the context                                                                                               | Not required for eligibility, but a PrintFarmer-sourced OrcaSlicer profile is not projected without it, and an ambiguous nozzle diameter across toolheads suppresses it too. |
| `safety` block: `buildVolumeMm` `x`/`y`/`z`, `maximumNozzleTemperatureC`, `maximumBedTemperatureC`, `maximumVolumetricRateMm3S` | Context incomplete; printer ineligible.                                                                                                                                      |
| `emergencyStopAvailable`, `thermalProtectionConfirmed`, `ventilationAssessed`                                                   | Each must be **true**, not merely present. Any false value makes the printer ineligible.                                                                                     |
| `permissions` block: `readPrinter`, `writeCalibration`, `generateCalibration`, `startPrint`                                     | Each must be **true**. Any false value makes the printer ineligible.                                                                                                         |
| `bedWidthMm`, `bedDepthMm`, `printerModel`, `firmwareVersion`, `klipperConfigHash`                                              | Nullable. Absence does not block eligibility; they are display and provenance only.                                                                                          |
| `contentHash`                                                                                                                   | Must be a 64-character lowercase hex digest or it is normalised to null, which then fails the workspace freshness comparison against a bound workspace.                      |

When a workspace is compared against the authoritative context, every one of
these is compared for equality — including each safety limit and the selected
toolhead's `extruderType`, nozzle `diameterMm` and `material`. A single
difference makes the workspace stale.

---

## 3. Permissions and scopes

### 3.1 Effective permissions

PrintFarmer reports what the current session may do as canonical
`resource:action` strings in the capability payload's `effectivePermissions`
member. PFD surfaces them unchanged in both availability and diagnostics. The
token itself is never exposed to the renderer or to a log record.

| Permission             | Gates                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| `calibration:read`     | Listing candidates, reading a context, resolving profiles               |
| `calibration:create`   | Creating a calibration project                                          |
| `calibration:update`   | Recording results, syncing the outbox, queueing and dispatching a print |
| `calibration:generate` | Requesting profile generation                                           |

Opening the workspace requires only `calibration:read`. Each further action is
checked on its own against its exact permission at the moment it is attempted,
so an operator with read access can inspect the farm without being refused
entry, and a refusal names the specific permission that was missing.

Beta 4 note: a normal `farm_user` has no seeded calibration permissions, so the
production key used for calibration must belong to a `farm_admin`. Granting and
managing those roles is a PrintFarmer backend and web concern; the desktop app
only reads what the server reports.

Permissions can change while the app is running, so PFD never treats a refusal
as permanent. On a calibration 403 it re-reads
`/api/calibration/capabilities` once for the currently selected profile, tells
the operator their access may have changed, and stops there. It does **not**
replay the refused action: re-reading capabilities is a read and safe to repeat
on the operator's behalf, whereas a create, generate, queue or dispatch is not.
Repeated refusals are absorbed by a short cooldown so a permission problem
cannot become a request storm.

### 3.1.1 Expired and revoked sessions (401), which are not refusals (403)

The desktop app authenticates by exchanging its configured API key for a
short-lived JWT — **fifteen minutes** by default. Two ordinary events therefore
produce a 401 that says nothing about the operator's rights: the token ages out
while a workspace sits open, and an administrator forces a revocation, which
fails JWT validation the same way.

PFD handles the two differently, and deliberately:

| Server says | What PFD discards                                                                 | What PFD does next                                            |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **401**     | Capabilities, remembered contexts, the bed-clear acknowledgement, in-flight syncs | Re-exchanges the API key **once**, then re-reads capabilities |
| **403**     | The same evidence                                                                 | Re-reads capabilities **once**; never re-exchanges the key    |

Capabilities are re-read against the _new_ token, because an API key can be
reassigned and the renewed session is not guaranteed to resolve to the same
principal. For that same reason a mutation that met a 401 is **never re-sent** —
re-issuing a generate, queue or dispatch under a freshly minted identity is not
a retry. Read requests may be re-issued once with the renewed token.

Recovery is bounded: one attempt runs at a time per profile, concurrent
rejections join it rather than starting their own, a second 401 from the
capability read taken immediately after a successful exchange ends recovery
instead of restarting it, and a cooldown keeps a revoked key from producing an
exchange per failing request. If the session cannot be re-established,
availability reports `sessionExpired` — distinct from `missingScopes`, which
means the identity was accepted and the rights were absent, and from
`legacyServer`, which earlier builds wrongly reported for any non-404 failure.

Earlier PFD builds asserted a PascalCase JWT-scope vocabulary
(`CalibrationRead`, `CalibrationWrite`, `CalibrationGenerate`). No PrintFarmer
build has ever emitted those strings, so every check against them silently
matched nothing. They are still accepted if a server genuinely sends them, but
nothing infers or synthesises a grant from their absence.

> **Note on the printer context.** PrintFarmer's `CalibrationContextDto` carries
> no per-printer `permissions` block and no safety-interlock block. Earlier PFD
> builds required both, which made every real context incomplete and blocked
> project creation on every deployment. Authorisation now comes from
> `effectivePermissions` above; machine movement is gated on an explicit,
> single-use bed-clear acknowledgement recorded in the desktop main process
> after the server confirms the job is awaiting one.

### 3.2 Denial reasons

Denials are typed, never free text. The codes an operator will see in a log
record's `errorCode` or in an error payload are:

| Code             | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `authentication` | Authentication with the server failed.                  |
| `authorization`  | The server rejected the credentials for this operation. |
| `forbidden`      | The operation is not permitted for the granted scopes.  |
| `notFound`       | The requested resource does not exist on the server.    |

`notFound` is the code that carries the **non-disclosure** property: a request
for a resource owned by another account is intended to be indistinguishable from
a request for a resource that does not exist. Do not read a `notFound` as proof
that the resource is absent.

> **Cross-reference and its current state.** Issue #157 enumerates the desktop
> IPC authorization matrix — every `calibration:*` channel under no-profile,
> unauthenticated, missing-scope, missing-capability, identity-fence and offline
> conditions. That issue is **open** at the time of writing, so the exhaustive
> per-channel matrix does not yet exist in the repository. The four codes above
> are what this build emits; treat #157 as the authority for the full matrix once
> it lands.

> **`operatorDisabled` is defined but not produced.** It is a member of the
> unavailable-reason union and the renderer has copy for it, but no main-process
> path emits it: a deployment that has switched calibration off is reported
> through the capability flags instead. `missingScopes` and `sessionExpired`
> **are** produced — the first when the capability negotiation is refused, the
> second when the session's token is rejected outright.

---

## 4. Worker health

"Healthy" for the calibration path means four separate things, and an
administrator should check them in this order.

1. **Capability negotiation succeeded.** Diagnostics `capability` is non-null and
   its `negotiatedAt` is recent. A null means negotiation has not happened since
   the app started, not that it failed.
2. **A generation worker is available.** The typed code `workerUnavailable`
   means the server reported no generation worker. It appears as `errorCode` on a
   failed `generation.requested` record.
3. **Orchestrations advance.** `orchestration.polled` records carry the
   orchestration's `currentStep`, `retryCount`, `nextRetryAtUtc`,
   `stepStartedAtUtc` and `lastErrorCode`. A `retryCount` that climbs while
   `currentStep` does not change is the signature of a worker that accepts work
   and cannot finish it. `workerId` names the worker the server assigned.
4. **Sync completes.** Diagnostics `lastSync` reports `outcome`, `at`,
   `errorCode` and the `correlationId` to search from.

See [unhealthy worker](./runbooks/unhealthy-worker.md) and
[stuck orchestration](./runbooks/stuck-orchestration.md).

### 4.1 How an administrator observes it

There is no renderer UI for diagnostics in this build. The report is exposed
through the preload bridge on the IPC channel `calibration:getDiagnostics`, and
an operator reaches it today through the developer console. It returns
`generatedAt`, `profileId`, `capability`, `outbox`, `lastSync`,
`observedSinceAppStart` and a pre-formatted `report` string built for pasting
into a bug report.

```js
// Renderer developer console.
const d = await window.printFarmer.getCalibrationDiagnostics({});
console.log(d.report);
```

**Two limitations, each with the reason it is correct.**

1. **`capability` and `lastSync` are held in memory and reset when the app
   restarts.** They are recorded as negotiation and sync happen, and are null
   until each has happened once in the current run. This is deliberate: because
   the collector never makes a network call, the report still works when the
   server is unreachable — which is exactly when it is needed. A null means "not
   observed since this app started", never "broken".
2. **No renderer UI surfaces diagnostics.** Reaching it requires the developer
   console, as above. `observedSinceAppStart` is present in the payload so a
   runbook can state the caveat from the output itself rather than from tribal
   knowledge.

### 4.2 Structured log records

Every calibration operation in the main process emits one JSON object per line
on **stdout** (deliberately not through `console`, so the sink is machine
parseable and cannot be intercepted by renderer console forwarding).

A record may carry only these keys, in this order:

`timestamp`, `level`, `component`, `event`, `correlationId`,
`correlationOrigin`, `operationId`, `dispatchId`, `dispatchRevision`,
`profileId`, `projectId`, `attemptId`, `orchestrationId`, `outcome`,
`errorCode`, `message`, `httpStatus`, `durationMs`.

`component` is one of `calibration.http`, `calibration.engine`,
`calibration.sync`, `calibration.photo`, `calibration.profile`,
`calibration.sidecar`.

#### Which events carry which identifiers

Verified against the emitting call sites. A field not listed is absent from that
record, not merely usually empty.

| `event`                                | `component`           | Identifiers present                                                                                                                                                           |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation.requested`                 | `calibration.http`    | `correlationId`, `correlationOrigin` = `flowStart`, `operationId`, `profileId`, `projectId`, `attemptId`. On failure also `outcome`, `errorCode`, `httpStatus`, `durationMs`. |
| `generation.submitted`                 | `calibration.http`    | as above plus `orchestrationId` and `durationMs`.                                                                                                                             |
| `orchestration.polled`                 | `calibration.http`    | `correlationId`, `correlationOrigin`, `orchestrationId`, `profileId`, `durationMs`. On success also `operationId` (echoed by the server), `projectId`, `attemptId`.           |
| `queue.stateRead`                      | `calibration.http`    | `correlationId`, `correlationOrigin`, `dispatchId`, `profileId`, `projectId`. On success also `dispatchRevision` and `attemptId`.                                             |
| `bedClear.acknowledged`                | `calibration.http`    | `correlationId`, `correlationOrigin`, `operationId`, `dispatchId`, `profileId`, `durationMs`. `dispatchRevision` on success only.                                             |
| `bedClear.revisionConflict`            | `calibration.http`    | as above, with `errorCode` = `dispatchRevisionConflict`.                                                                                                                      |
| `capabilities.negotiated`              | `calibration.http`    | `profileId` and `outcome` only — **no `correlationId`**, because negotiation is not part of a user flow.                                                                      |
| `sync.completed` / `sync.failed`       | `calibration.sync`    | `correlationId`, `profileId`, `projectId`, `outcome`, `durationMs`; `errorCode` when failed. No `correlationOrigin`: a sync always starts its own flow.                       |
| `sync.scheduledTickFailed`             | `calibration.sync`    | none — the scheduler tick has no profile in hand at that point.                                                                                                               |
| `sync.profileRecoveryFailed`           | `calibration.sync`    | none.                                                                                                                                                                         |
| `photo.staleTemporaryCleanupFailed`    | `calibration.photo`   | no flow identifiers.                                                                                                                                                          |
| `profile.bindingTransitionDeferred`    | `calibration.profile` | `profileId`.                                                                                                                                                                  |
| `sceneCache.startupInvalidationFailed` | `calibration.sidecar` | no flow identifiers.                                                                                                                                                          |
| `sceneCache.recipeAdoptionFailed`      | `calibration.sidecar` | no flow identifiers.                                                                                                                                                          |
| `sidecar.processFailed`                | `calibration.sidecar` | no flow identifiers.                                                                                                                                                          |

#### `correlationId` versus `operationId`

This is the single most useful distinction for support.

- **`correlationId` is stable across every stage of one user-initiated flow.**
  It is minted at `generation.requested` and resolved by later stages through the
  identifiers they hold — the orchestration ID, then the queue job ID, then the
  attempt. Grep by this to reconstruct a flow.
- **`operationId` is minted per call** and is used as the backend idempotency
  key, so it deliberately **differs** between stages. It is the value to give the
  server team to search their side. It is not the thing that ties stages
  together.

#### `correlationOrigin`

- `flowStart` — this stage minted the ID because it is the start of a flow.
- `continued` — resolved from an identifier bound by an earlier stage. The normal
  case, and the proof correlation is working.
- `resumed` — this stage could not resolve any identifier it held and minted a
  new ID mid-flow. Causes: the app restarted; the user resumed a job this desktop
  never generated; or the correlation registry evicted the flow's bindings under
  its **512-binding** capacity bound (a flow holds three or four bindings, and
  eviction is least-recently-bound first, so an active flow survives).

**A `resumed` origin on any event that is not a `generation.*` event is the
operator-visible signature that a flow's logs have stopped correlating.** Treat
it as a diagnosable condition: the logs before and after that point belong to the
same flow but no longer share a `correlationId`. Bridge them with the
`orchestrationId` or `dispatchId` on the record.

#### Three literals an operator can actually see

| Literal                       | Field                | Meaning and action                                                                                                                                                                                                                                                                     |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[unsafe-identifier-dropped]` | any identifier field | The value failed the identifier guard — empty, over 128 characters, containing whitespace or a path separator or a control character, or JWT-shaped. It is replaced rather than omitted so a bad call site leaves evidence. Report it as a desktop defect with the surrounding record. |
| `[unsafe-revision-dropped]`   | `dispatchRevision`   | The server-supplied ETag did not match the documented base-64 shape (up to 64 characters plus padding). The operation is unaffected; the value was withheld from the record. Report the server build.                                                                                  |
| `unknownErrorCode`            | `errorCode`          | The failure code is not one this desktop build recognises. Most often this means **the server is newer than the desktop app**. Check versions before investigating further.                                                                                                            |
| `unavailable (unknown)`       | `outbox`             | The outbox is unavailable and the snapshot carried no reason for it. Every path through the IPC handler sets a reason, so this is only reachable from a hand-built snapshot — you should not see it. Report it rather than acting on it, and attach the whole diagnostics output.      |

#### `message` is never backend text

`message` is looked up from a fixed catalog keyed by `errorCode`, falling back to
`event`. A call site cannot supply free text at all. In particular a backend
error body is never stringified into a record. **Do not expect the server's error
text in a log line** — its absence is a redaction guarantee, not an omission. The
server-side detail must be obtained from the server using the `operationId`.

---

## 5. Storage and retention

### 5.1 Bounded and cleaned up deterministically

| Data                                    | Bound                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Photo capture approvals                 | Expire 5 minutes after issue and are swept on the next access.                                                           |
| Staged photo temporary files            | Removed once older than 5 minutes. A sweep failure emits `photo.staleTemporaryCleanupFailed` and does not block startup. |
| Correlation registry bindings           | 512 bindings, evicted least-recently-bound first. Eviction is visible as `correlationOrigin` = `resumed`.                |
| Legacy backup import file reads         | Capped at 50 MB; a larger file is rejected before parsing.                                                               |
| Legacy backup file approvals            | Single-use. Consuming an approval resolves it to a path and removes it.                                                  |
| Diagnostics `capability` and `lastSync` | In memory for the current app run only (section 4.1).                                                                    |

### 5.2 Never deleted by PFD

- **Authoritative calibration history** — projects, steps, attempts,
  observations, events and photos held by the server. PFD synchronises them; it
  does not expire them.
- **Promoted G-code and its provenance** — `gcodeFileId` and the immutable hash
  set (`gcodeContentSha256`, `specificationSha256`, `machineProfileSha256`,
  `processProfileSha256`, `filamentProfileSha256`,
  `printerConfigSnapshotSha256`, `planManifestSha256`, `manifestSha256`,
  `gcodeSha256`) exist so a print can be traced to the exact inputs that produced
  it. Nothing in PFD removes them.
- **Transactional profile install backups** — every Windows profile install
  writes a timestamped backup beside the target and never removes it. See
  [profile restore](./runbooks/profile-restore.md).

### 5.3 Held locally until synchronised

The sidecar's SQLite catalog holds the outbound operation queue and unresolved
conflicts. Diagnostics reports their depth as `pendingOperationCount` and
`unresolvedConflictCount`. These are not time-bounded: an operation stays until
it is acknowledged or explicitly reconciled, because dropping it would lose user
work.

---

## 6. Capability flags

Five end-to-end flags gate calibration, and **all five default to false.** The
default is fail-closed on purpose: a flag the server does not advertise is
treated as disabled, so an older server never has calibration inferred onto it.
All five must be true before calibration is offered at all.

| Flag                             | What it gates                                                                             | Advertised by the server as                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `calibrationApiEnabled`          | Calibration project persistence — the REST surface for projects.                          | calibration persistence enabled                                                                                        |
| `calibrationChangeFeedEnabled`   | The calibration change feed PFD pulls during sync.                                        | calibration sync enabled                                                                                               |
| `calibrationOfflineDraftEnabled` | Pushing offline drafts. Also drives `offlineEditingEnabled` in the availability response. | calibration sync enabled (the same server switch — the change feed and offline drafts cannot be enabled independently) |
| `calibrationPhotoUploadEnabled`  | Staged photo upload.                                                                      | calibration photos enabled                                                                                             |
| `calibrationGenerationEnabled`   | Generation and G-code promotion.                                                          | calibration generation enabled                                                                                         |

When any are false, availability reports `missingCapabilityFlags` and the detail
text names the missing flags. The negotiated set is echoed unchanged in
`capabilityFlags` on the availability response and in `flags` on the diagnostics
`capability` snapshot.

> **Rollout order.** #57 states the rollout order as migrations, then
> permissions, then contract versions, and #160 asks this section to
> cross-reference "the rollout order runbook". **No such runbook exists in this
> repository**, and none of the seven runbooks #160 names is one. The nearest
> applicable procedure is [failed migration](./runbooks/failed-migration.md),
> which covers the first step. This gap is recorded rather than papered over.

---

## 7. Split versus monolith deployments

PFD does not ask a server which shape it is. It distinguishes **configured** from
**operational** by what the capability response actually asserts, and the two
shapes produce different truthful reports.

- **Configured** — the server advertises a slicer engine entry at all.
- **Operational** — that entry has `type` OrcaSlicer **and** is marked supported.

An engine advertised but not supported is configured and not operational, and
PFD reports `unsupportedSlicer`. This is the distinction that matters in a split
deployment, where the API host can be configured for slicing that a separate
worker tier actually performs.

**A truthful monolith report:** all five capability flags true, an OrcaSlicer
engine advertised **and** supported, `Klipper` in both supported firmware
families and supported G-code dialects, `negotiatedApiVersion` and
`negotiatedSchemaVersion` both non-null.

**A truthful split report:** identical in shape. The API host must report the
capabilities of the deployment as a whole, not of the process answering the
request. A split deployment whose API host advertises generation while no worker
tier is running is reporting a configuration, not a capability — PFD will offer
calibration and generation will then fail with `workerUnavailable`. **That
mismatch is the definitive symptom of a split deployment reporting configured
rather than operational state**, and it is the first thing to check when
generation fails on a server that reports healthy.

Capability negotiation is a snapshot: it is recorded when it happens, not
polled. A worker tier that stops after negotiation will not change the reported
capability until the next negotiation.

---

## 8. Snapmaker U1 profile error codes

The retarget profile channels report failures with a machine-readable `code` and
a human-readable message. **Read both.** The code says which class of fault
occurred; only the message names the specific one, because two of the faults
below share a code.

- `sidecarUnavailable` — the profile sidecar answered and said it cannot serve
  profiles. The profile bundle really is the thing at fault. Restart the
  application; if it persists, reinstall.
- `internalError` — no classification was established. This is deliberately not
  a diagnosis, and the recovery step depends entirely on the message:
  - _"The retarget workspace could not be prepared."_ — startup could not reap
    its stale temporary instance directories, usually because a previous run's
    directory is still locked by a file scanner, a backup agent, or a surviving
    process. **Do not reinstall**; it cannot remove a temporary directory.
    Restart the application, and if it repeats, find and release the holder of
    the retarget temp directory.
  - _"Snapmaker U1 profiles could not be loaded."_ — the load failed for a
    reason the main process could not classify. Collect the application logs
    before doing anything destructive.

Before #316 every one of these reported `sidecarUnavailable` and advised a
reinstall, including the workspace fault, where a reinstall cannot succeed. If
you are reading a support report from an older build, treat a
`sidecarUnavailable` on these channels as unclassified rather than as evidence
about the bundle.

## 9. Bed-clear conflict codes (HTTP 409)

Starting a queued job sends a bed-clear acknowledgement. The server can refuse
it with HTTP 409 and a machine-readable reason. Four reasons are diagnosed:

- `wrongJob` — the acknowledgement referred to a different job than the one
  being started. Re-read the queue; the job you confirmed is not the job that
  is dispatching.
- `printerBusy` — the printer already has an active job. Wait for it, or cancel
  it deliberately.
- `jobNotDispatchable` — the job is not in a state that can be dispatched.
  Check its status in the queue before retrying.
- `idempotencyPayloadChanged` — the same operation key was reused with a
  different payload. **This is a genuine diagnosis**: the server recognised the
  key and saw that the request body had changed. See
  [`runbooks/interrupted-import.md`](./runbooks/interrupted-import.md).

Any other 409 reason, including a response with no reason at all, reports
`unclassifiedConflict`. **That code is not a diagnosis and must not be treated
as one.** It means the server refused the operation as a conflict and gave a
reason this build does not recognise — most often because the server is newer
than the desktop application. The raw server reason is preserved in the error
message and in the structured log record, so:

1. Read the message, not just the code. It carries the server's own reason
   text verbatim.
2. Check whether the server has been upgraded past this desktop build.
3. Do **not** apply the `idempotencyPayloadChanged` runbook. The operation key
   may be entirely fine.

At the renderer boundary `unclassifiedConflict` is displayed through the
generic server-error presentation, because the IPC error contract has no
unclassified member and widening it is a separate contract change. That is a
rendering fallback, not a reclassification — the honest code remains in the
logs, which is where the diagnosis is made.

Before #326 an unrecognised 409 reported `idempotencyPayloadChanged`, exactly
as a real payload mismatch did, and the two were indistinguishable to every
consumer including this guide. **If you are reading a support report from an
older build, an `idempotencyPayloadChanged` on the bed-clear start path is not
by itself evidence that an operation key was reused.**

---

## 10. PrintFarmer server REST contract

Verified from OlyForge3D/PrintFarmer read-only source:

- **Pinned:** `167a3b134a678a0d9a8c10371da8333d03ddc636`
- **Contract snapshot (queried 2026-08-05):**
  `9c1d7e4b97c5f0fee0f0c702aa864374b3e21cf0`
- **Default-branch HEAD at the time of the contract snapshot (queried
  2026-08-05):** `09f6cae810c5b48992f905bab89d5e334a3fb98c`
  — two commits ahead of the contract snapshot; changed files were UI/design
  material only (theme CSS, ThemeContext, DESIGN_SYSTEM.md).
- **Default-branch HEAD (re-queried 2026-08-09):** commit
  `SHA a91855abb901b97188e04e0aa006345076b2a2bf` (`SHA a91855ab` for short)
  — 162 commits ahead of the `09f6cae8` HEAD above, but zero `.cs` files (and
  specifically none under `src/api/` or `src/infra/`) differ between
  `09f6cae8` and this head; the added commits are UI/design, mobile,
  tooling, and documentation material only. No queue, calibration,
  controller, DTO, or contract file was modified between `9c1d7e4b` and
  `SHA a91855ab`. All claims below remain accurate at the latest head as of
  this re-verification. This is a statement about a moving branch and has a
  shelf life — re-derive it, don't inherit it, whenever §10 is next relied
  upon.

Every claim is cited to a stable source path and named symbol; line numbers are
given as `line@commit-prefix` where they differ between commits. The parity
guard in `tests/calibrationServerContractParity.test.ts` derives one side from
this section and the other from executable desktop production behavior; see that
file for the test strategy.

> **Source verification, not live validation.** The claims below were established
> by reading authoritative server C# source only. No live PrintFarmer server,
> Orca worker, or printer hardware was exercised. The residual live-instance
> requirement for issue #57 is stated in §10.7.

> **No automated gate in this repository verifies these server claims.**
> `tests/calibrationServerContractParity.test.ts` parses this section against
> PFD's own desktop-side production constants — a same-repository check that
> catches this document drifting from PFD's code, but it never reads
> `OlyForge3D/PrintFarmer` and cannot detect the server itself renaming a
> route, dropping a header, or otherwise changing behavior. A green run of
> that test is not evidence that §10 still matches the live server.

**Citation convention.** Bare `src/…` paths below are repository-prefixed by
convention, not by coincidence: `src/api/…` and `src/infra/…` always name
files in `OlyForge3D/PrintFarmer` (the server, at the commits pinned above);
every other `src/…` prefix (`src/main/`, `src/shared/`, `src/preload/`, etc.)
names a file in this repository, `OlyForge3D/PrintFarmerDesktop` (PFD). The
two repositories' `src/` trees do not share a top-level prefix, so a
citation's repository is determined by its path alone and does not depend on
filenames staying disjoint between the two trees (this repository already
has both `src/main/ipc.ts` and `src/shared/ipc.ts`; a bare `ipc.ts:NNNN`
without the full prefixed path would be ambiguous, so citations below always
give the full path).

### 10.1 Four issue-#138 parity routes

The four routes guarded by the parity test (`CALIBRATION_QUEUE_ROUTE_TEMPLATES`).
The **PFD template** column below is PFD's own desktop-side route-template
constant, not the server's ASP.NET route attribute — e.g. the server declares
`[HttpGet("{id:guid}")]` with a `Guid` route constraint, while PFD's
placeholder name is `{jobId}`; both resolve to the identical wire path, but
the placeholder text itself is PFD's, not the server's:

| PFD template                                                              | Method | Server symbol                                         | Line                         |
| ------------------------------------------------------------------------- | ------ | ----------------------------------------------------- | ---------------------------- |
| `/api/job-queue`                                                          | POST   | `JobQueueController.QueueJobAsync`                    | 101@167a3b13 / 111@9c1d7e4b  |
| `/api/job-queue/{jobId}`                                                  | GET    | `JobQueueController.GetJobAsync`                      | 199@167a3b13 / 209@9c1d7e4b  |
| `/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job` | POST   | `CalibrationGenerationController.GenerateJobAsync`    | 41 (both)                    |
| `/api/job-queue/{jobId}/acknowledge-bed-clear-and-start`                  | POST   | `JobQueueController.AcknowledgeBedClearAndStartAsync` | 960@167a3b13 / 1025@9c1d7e4b |

Source files: `src/api/Controllers/JobQueueController.cs`,
`src/api/Controllers/CalibrationGenerationController.cs`.
PFD makes additional calls (change-feed, subscription-resources, orchestration-status)
not listed here; this table covers only the four parity-guarded paths.

There is no route of the form `/api/calibration-projects/{id}/queue` and no
project-level `/api/calibration-projects/{id}/generation` route at either
inspected commit.

### 10.2 Generation is per-attempt

```
POST /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job
```

Symbol `CalibrationGenerationController.GenerateJobAsync`, line 41 at both
commits. Each immutable attempt can be independently (re-)generated. There is no
generation route scoped to a project without an attempt.

### 10.3 Bed-clear requires three precondition headers

`POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start` enforces three
precondition headers documented below. PFD always sends all three unconditionally
via `acknowledgeBedClearAndStart`, which builds its headers from the exported
`BED_CLEAR_PRECONDITION_HEADER_NAMES` constant.

| Header                      | Carries                    | Server behavior when absent                                                                                                                  |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Idempotency-Key`           | Stable per-operation key   | 428 when both header **and** body `idempotencyKey` are blank (body fallback exists; symbol `idempotencyKey` at 973@167a3b13 / 1038@9c1d7e4b) |
| `If-Match`                  | Opaque job ETag (§10.4)    | 428 when absent or blank (no body fallback; server variable _ifMatchHeader_ at 984@167a3b13 / 1049@9c1d7e4b)                                 |
| `X-Dispatch-State-If-Match` | Opaque dispatch-state ETag | 428 when absent or blank (no body fallback; server variable _dispatchIfMatchHeader_ at 985@167a3b13 / 1050@9c1d7e4b)                         |

Source: `src/api/Controllers/JobQueueController.cs`,
`AcknowledgeBedClearAndStartAsync`.

### 10.4 Opaque row-version tokens

Two distinct `[Timestamp] byte[]?` properties produce the bed-clear ETags:

- **Job ETag** (`If-Match`): `PrintJob.RowVersion`
  (`src/infra/Domain/PrintJob.cs` line 20@167a3b13 / 21@9c1d7e4b)
  mapped to base-64 by `JobQueueService.ToBase64RowVersion`
  (`src/infra/Services/Queue/JobQueueService.cs`, line
  1408@167a3b13 / 1532@9c1d7e4b; calls `Convert.ToBase64String`).
- **Dispatch-state ETag** (`X-Dispatch-State-If-Match`): `PrinterDispatchState.RowVersion`
  (`src/infra/Domain/PrinterDispatchState.cs` lines 37–38 at both commits),
  mapped by the same `ToBase64RowVersion` helper
  (`src/infra/Services/Queue/JobQueueService.cs`, called at line 806@9c1d7e4b).

**Treat both as opaque and forward without application-level interpretation.**
The server's `DecodeEtag` method is at
`JobQueueController.cs` line 1197@9c1d7e4b and calls
`Convert.FromBase64String` after trimming quotes. Three
distinct HTTP outcomes:

- **400** — `DecodeEtag` throws `FormatException` on malformed base-64 (line
  1072@9c1d7e4b); the token is corrupt or not base-64.
- **412 `dispatch_revision_conflict`** — decoded bytes do not match the stored
  row version; the token is stale but well-formed (symbol `DispatchRevisionConflict`,
  line 1127@9c1d7e4b).
- **428 `precondition_required`** — header is absent entirely (see §10.3).

PFD's wire types `RemoteJobQueueJob.rowVersion` and
`RemoteDispatchAttemptResult.jobRevision` accept the base-64 string as-is
(`z.string().max(512)`). The `acknowledgeBedClearAndStart` method forwards
`rowVersion` directly as the `If-Match` header value without modification.

Source: `src/infra/Domain/PrintJob.cs`, `src/infra/Domain/PrinterDispatchState.cs`,
`src/infra/Services/Queue/JobQueueService.cs`,
`src/api/Controllers/JobQueueController.cs`.

### 10.5 Printer-{id} redaction is scoped to `queueevent` envelopes only

The `Printer-{printerId}` SignalR group (`AuthorizedHubGroups.Printer(Guid)`,
`src/infra/Security/AuthorizedHubGroups.cs` line 17 at 9c1d7e4b) is a general
per-printer channel, not a queue-envelope-only channel. Three distinct
message types are sent to it in `OlyForge3D/PrintFarmer` at 9c1d7e4b, and
only one of them is redacted:

- **`queueevent`** — produced by `QueueEventEnvelope.RedactForPrinter()`
  (`src/infra/Services/SignalR/QueueEventEnvelope.cs`, both commits), sent
  from `QueueOutboxPublisherService.cs` line 203. `RedactForPrinter()` nulls
  `jobId`, `projectId`, `calibrationAttemptId`, `jobKind`, `jobRevision`,
  `dispatchStateRevision`, `attemptId`, `attemptNumber`, `attemptOutcome`,
  `bedClearState`, `bedClearCommandId`, `bedClearExpiresAtUtc`, `errorCode`,
  `failureCode`, `failureRetryable`, `failureRequiresReconciliation`,
  _payloadJson_, `jobLogicalRevision`, and `dispatchStateLogicalRevision`, and
  forces `eventType` to `"PrintFarmer.Queue.PrinterStateChanged.v1"`.
- **`printerupdated`** — carries `PrinterStatusDto`
  (`src/infra/Dtos/PrinterStatusDto.cs`), sent from
  `SignalRPrinterStatusBroadcaster.cs` and the per-backend polling/websocket
  adapters (FlashForge, Moonraker, OctoPrint, PrusaLink, Sdcp, TestEmulator)
  and `PrinterHub.cs`. Every field on this DTO (`Id`, `IsOnline`, `State`,
  `Progress`, `JobName`/`FileName`, position/temperature telemetry,
  `SpoolInfo`, `MmuStatus`, etc.) describes only the printer the group is
  keyed on; there is no other-printer or other-tenant identifier in the type.
  Not redacted, but reviewed here and found in-scope for the group's printer.
- **`autodispatchstatechanged`** — carries `AutoDispatchStatusDto`
  (`src/infra/Services/AutoDispatch/AutoDispatchService.cs`, sent from 7 call
  sites in the same file). **Not redacted, and not fully in-scope.** Most
  fields (`PrinterId`, `PrinterName`, `Enabled`, `IsReady`, `CurrentJobName`,
  `State`, `BedPreConfirmed`, ETags) describe only the group's own printer.
  However, `NextJobId`, `NextJobName`, `NextJobKind`, and
  `NextJobPrinterConfigRevision` are populated from
  `AutoDispatchService.GetQueuedJobSelectionAsync()`, which considers not
  only jobs already assigned to this printer (`AssignedPrinterId == printerId`)
  but also **every farm-wide unassigned queued job** that the dispatch scorer
  rates as a candidate for this printer (line ~1532–1566: the unassigned-jobs
  query filters only on `AssignedPrinterId == null`, with no creator/project/
  group check). `QueueResourceAuthorizationService.CanAccessPrinterAsync()` — the
  check gating `Printer-{printerId}` group membership
  (`PrinterHub.EnsurePrinterAccessAsync`) — authorizes only against that
  printer's `PrinterGroupAccess` rules, and never against the unassigned
  job's `CreatorSubject` or `CalibrationProjectId`, which is the ownership
  check `CanAccessJobAsync`/`FilterActorAccessibleJobIdsAsync` apply
  elsewhere. **Net effect: a principal authorized only to view one printer
  can receive the name of another user's/project's not-yet-assigned queue
  job merely because the scorer favors their printer as a dispatch target,
  with no job-level ownership or group check.** This is filed as
  OlyForge3D/PrintFarmer#1324 (see that issue for the concrete leak); it is
  not fixed here.

**Never read job state, bed-clear state, or revision tokens from a
`queueevent` printer-group envelope; never treat `NextJobName`/`NextJobId`
from an `autodispatchstatechanged` envelope as scoped to the receiving
principal's authorization.** For full, correctly-scoped job data subscribe to
`QueueJob-{jobId}` (symbol `AuthorizedHubGroups.QueueJob(Guid)`). PFD enforces
the `queueevent` rule via the exported `isJobScopedEnvelope` helper
(`src/shared/ipc.ts`) used by `CalibrationQueueDispatchPanel`; PFD has no
equivalent guard for `autodispatchstatechanged`'s `NextJob*` fields today.

### 10.5.1 Orchestration `status` and `currentStep` are forward-compatible strings

The `status` field of `CalibrationOrchestrationStatusDto`
(`src/api/Contracts/CalibrationGenerationContracts.cs`) is populated by
`CalibrationGenerationSaga.Project`
(`src/api/Services/Calibration/Generation/CalibrationGenerationSaga.cs`,
symbol, line 2131@9c1d7e4b) as
`orchestration.Status.ToString()` where `CalibrationOrchestrationStatus` is an
enum with values `Pending`, `Running`, `WaitingToRetry`, `Completed`, `Failed`,
`Cancelled` (`src/infra/Domain/CalibrationEntities.cs`, both commits).

The `currentStep` field is set directly from `CalibrationGenerationSteps`
constants (`src/api/Services/Calibration/Generation/CalibrationGenerationSteps.cs`,
both commits), which are lowercase hyphenated strings: `"created"`,
`"validating-context"`, `"resolving-model"`, `"compiling-plan"`,
`"submitting-slice-job"`, `"awaiting-worker"`, `"verifying-artifact"`,
`"composing-gcode"`, `"promoting"`, `"completed"`, `"failed"`, `"cancelled"`.

The desktop must not switch exhaustively on either field — the server can extend
both without a desktop deployment. PFD's `RemoteCalibrationOrchestrationStatus`
declares both as `z.string()` for forward compatibility.

### 10.5.2 Change-feed envelope schema version and sequence

`QueueEventSchemaVersions.Current = "3"` is declared at
`src/infra/Domain/QueueDispatchEntities.cs` line 7 at 9c1d7e4b (same at
167a3b13). The `SchemaVersion` field on `QueueDispatchOutbox` is initialized to
`QueueEventSchemaVersions.Current`
(`src/infra/Domain/QueueDispatchEntities.cs`, line 148@9c1d7e4b), persisted to
the outbox row at write time. `QueueOutboxPublisherService`
(`src/infra/Services/Queue/QueueOutboxPublisherService.cs`) calls
`QueueEventEnvelope.FromOutbox` (line 155@9c1d7e4b) with the persisted
event's `SchemaVersion`, so every
SignalR-published envelope carries the value written at outbox insert time.
The change-feed REST projection also echoes the persisted value: symbol
`GetChangesAsync` in `src/api/Controllers/JobQueueController.cs`, assigning the
event's `SchemaVersion` property at line 336@167a3b13 / 346@9c1d7e4b.

**Desktop handling:** PFD's `RemoteQueueEventEnvelope` parses `schemaVersion` as
`z.string()` (not a literal), so it accepts `"3"` from the server today and
any future version without a code change. PFD does not hold a local authority on
the deployed version — only live confirmation can establish which value a
specific deployment emits. `sequence` is `z.number().int()` and is required;
absent or non-integer `sequence` fails the schema parse.

`QueueDispatchOutbox.Sequence` (`src/infra/Domain/QueueDispatchEntities.cs`
line 56@9c1d7e4b) is a durable, monotonically increasing outbox sequence
allocated in the same database transaction as the event write. It is identical
across redeliveries of the same event. PFD's `detectQueueChangeFeedGap`
(exported from `src/main/ipc.ts`) uses `sequence` to detect cursor gaps and
internal gaps; REST is authoritative when a gap is detected.

**What source verification cannot confirm** (residual for issue #57): that the
currently deployed server instance emits `schemaVersion: "3"` on live envelopes.

### 10.6 No `/start` route at either inspected commit; PFD uses acknowledge-bed-clear-and-start

Neither `167a3b134a678a0d9a8c10371da8333d03ddc636` nor
`9c1d7e4b97c5f0fee0f0c702aa864374b3e21cf0` has a `[HttpPost("{id:guid}/start")]`
attribute in `JobQueueController.cs`.

**Per-resource POST routes under `/api/job-queue/{id}`:**

| Route segment                      | At 167a3b13 | At 9c1d7e4b |
| ---------------------------------- | ----------- | ----------- |
| `/dispatch`                        | ✓           | ✓           |
| `/cancel`                          | ✓           | ✓           |
| `/abort-print`                     | ✓           | ✓           |
| `/rerun`                           | ✓           | ✓           |
| `/harvest`                         | —           | ✓           |
| `/dispatch-to`                     | ✓           | ✓           |
| `/acknowledge-bed-clear-and-start` | ✓           | ✓           |

**Collection POST routes (not under `/{id}`):**
`/sync-orphaned` and `/batch-dispatch` at both commits.

PFD's `CALIBRATION_QUEUE_ROUTE_TEMPLATES` constant contains no `/start` route
and cannot satisfy a parity check against it. This is bounded to the two
inspected commits; it is not a historical claim about commits not examined.

### 10.7 Residual live-instance and hardware evidence requirement (issue #57)

The claims in §§10.1–10.6 were established by reading authoritative server
source only. They confirm that routes, header enforcement, row-version types,
step name constants, schema version, sequence semantics, and redaction methods
are present in the codebase at both inspected commits.

**What cannot be established from source alone (open for issue #57):**

1. **End-to-end round-trip** — that a live instance accepts `FilamentCalibration`
   jobs, returns valid base-64 ETags, and enforces all three bed-clear headers.
2. **Worker attestation** — that a running Orca worker satisfies the generation
   saga contract.
3. **Printer hardware** — that `acknowledge-bed-clear-and-start` causes a print
   to start on a Klipper-backed printer.
4. **Schema version "3" in production** — that the deployed server emits
   `schemaVersion: "3"` on live change-feed envelopes.

Until these are validated on a live instance, issue #57 remains open.

---

## Related documents

- [`docs/runbooks/`](./runbooks/) — the seven recovery procedures.
- [`docs/security/THREAT_MODEL.md`](./security/THREAT_MODEL.md) — the redaction
  reasoning the structured log contract implements.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — process boundaries.
