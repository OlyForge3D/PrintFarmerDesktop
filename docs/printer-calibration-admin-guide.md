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

### 3.1 Token scopes

The calibration contract defines three JWT scopes: **CalibrationRead**,
**CalibrationWrite** and **CalibrationGenerate**. The scopes the current token
actually grants are reported by the server as `resource:action` strings in
`grantedScopes`, and PFD surfaces them unchanged in both availability and
diagnostics. The token itself is never exposed to the renderer or to a log
record.

Separately, the **printer context** carries a four-way permission assertion —
`readPrinter`, `writeCalibration`, `generateCalibration`, `startPrint` — and all
four must be true for that printer to be eligible (section 2).

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

> **Two reasons the contract defines but this build never produces.**
> `missingScopes` and `operatorDisabled` are members of the unavailable-reason
> union and the renderer has copy for both, but no main-process code path
> produces either: availability failures resolve to `noProfile`,
> `unsupportedFirmware`, `unsupportedSlicer`, `missingCapabilityFlags`,
> `serverVersionTooLow` or `legacyServer`. A scope problem therefore reaches the
> operator as a `forbidden` or `authorization` error on the failing operation,
> not as an availability reason. This is recorded as an observation, not fixed
> here.

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

---

## Related documents

- [`docs/runbooks/`](./runbooks/) — the seven recovery procedures.
- [`docs/security/THREAT_MODEL.md`](./security/THREAT_MODEL.md) — the redaction
  reasoning the structured log contract implements.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — process boundaries.
