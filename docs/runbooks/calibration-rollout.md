# Runbook: calibration capability rollout

**Parent issue:** #57 (release gate) — this document is delivered by #161.

**Environment for this document:** none. The document and its parity test are
verifiable in CI with no live server and no hardware.

**Environment for the procedure it describes:** the rollout itself is executed
against a live PrintFarmer deployment by an operator with permission to change
capability switches. **No agent session can perform it.** This runbook delivers
the _procedure_ and the invariants that keep it honest; it does not and cannot
record that a rollout happened.

## Why this document exists

#57 states the required capability-enablement order in a paragraph inside a
release-gate issue. When #57 closes that paragraph becomes unfindable, and
nothing fails when the flag set in code drifts from the flag set in the plan.
This document is the durable home for that order, and
`tests/calibrationRolloutRunbook.test.ts` is what keeps it true.

## The gating rule

PFD decides whether to offer calibration from **negotiated contract versions,
advertised capability flags and effective permissions**. It never infers
capability from a server version string, a hostname, a build channel or the
absence of an error.

Enforcement site: `src/main/calibrationWire.ts`.

- `RemoteCalibrationCapabilities` parses `GET /api/calibration/capabilities`.
  Parsing is **additive**: unknown members pass through, and a capability
  switch this client did not receive is treated as **disabled**, not as a
  malformed body. A server that omits a switch therefore fails closed.
- `REQUIRED_CALIBRATION_FLAGS` and `missingCalibrationFlags()` name what is
  absent, so the renderer can say _which_ capability is missing rather than
  reporting a generic failure.
- `supportsKlipper()` and `supportsOrcaSlicer()` require the firmware family,
  the G-code dialect and the slicer engine to be advertised explicitly.
  `CalibrationUnavailableReason` in `src/shared/ipc.ts` is the typed vocabulary
  for every way this can come out negative.

All new backend capability switches default **false**. Enable each only after
its public route, its authorization, its worker/storage dependency and its
production-contract E2E are deployed and healthy.

## Flag vocabulary: client flags are not server switches

The six flags PFD reasons about are **not** the five switches an operator
sets. `RemoteCalibrationCapabilities` normalises the wire names into the
negotiation shape the feature gate consumes, so callers never depend on raw
wire naming.

| Client flag (`CalibrationCapabilityFlags`) | Server switch (`RemoteCalibrationCapabilities`) | What it gates                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calibrationApiEnabled`                    | `calibrationPersistenceEnabled`                 | Calibration persistence API — the discovery/read surface every later stage stands on                                                                                                                                                                                                               |
| `calibrationChangeFeedEnabled`             | `calibrationSyncEnabled`                        | Change-feed / sync path — cursors and replay                                                                                                                                                                                                                                                       |
| `calibrationOfflineDraftEnabled`           | `calibrationSyncEnabled`                        | Offline draft replay travels through the same sync/change-feed path                                                                                                                                                                                                                                |
| `calibrationPhotoUploadEnabled`            | `calibrationPhotosEnabled`                      | Staged calibration photo upload                                                                                                                                                                                                                                                                    |
| `calibrationGenerationEnabled`             | `calibrationSlicingEnabled`                     | Generation and slicing — the server deleted its own `calibrationGenerationEnabled` field with the generator subsystem (PrintFarmer 7169f1d32 / #1995); the client flag keeps its name and now reads the slicing switch. Does not gate promotion — see `calibrationArtifactPromotionEnabled` below. |
| `calibrationArtifactPromotionEnabled`      | `calibrationArtifactPromotionEnabled`           | Artifact promotion — gates promoting a generated patch independently of slicing, so a deployment can produce G-code without being able to promote it.                                                                                                                                              |

**Two consequences an operator must know before starting.**

1. **`calibrationChangeFeedEnabled` and `calibrationOfflineDraftEnabled`
   share one server switch.** Both are backed by `calibrationSyncEnabled`
   on the wire. The client-side distinction is a diagnostic and rollout
   convenience: the change feed and offline draft replay are two ends of
   the same sync subsystem, and there is no server state where sync is
   down but offline draft replay is possible.
2. **`calibrationEventsEnabled` is a distinct future subsystem, NOT the
   change feed.** It backs an event-streaming path that is not implemented
   in the current server build (`CalibrationCapabilityService.cs:203-205`
   hardcodes it `false`, and `PlatformCapabilitiesDto.cs:71-72` documents
   it as a separate concern from `CalibrationSyncEnabled` at `:47-48`).
   Do not read a `false` for `calibrationEventsEnabled` as "the change
   feed is down" — the change feed is `calibrationSyncEnabled`.

## Deployment topology

Both monolith and split deployments must report **truthful** same-origin or
allowlisted service routes. A split deployment that advertises a route it does
not serve, or serves a route it does not advertise, breaks the gating rule
above, because PFD's decision is only as good as the advertisement.

**Configured slicing must be distinguished from operational slicing.** A
deployment that has an upstream-Orca worker _configured_ is not the same as one
where that worker is _claiming and completing jobs_. Stage 4's health signal is
about the second; a configured-but-idle worker satisfies nothing.

## Rollout stages

Enable in this order. Each stage's precondition must hold before its flags are
enabled; each stage's health signal must be observed before proceeding to the
next.

### Stage 1 — Migrations, permissions, contract versions and secure hubs/artifacts

- **Capability flags:** none — this stage enables no client-visible flag; it
  establishes what the later flags depend on.
- **Precondition:** database and sidecar migrations applied from every
  supported prior schema; the calibration permission matrix deployed for every
  project, printer, photo, profile, generation, artifact, queue,
  acknowledgement and event route; contract versions served; SignalR hubs and
  artifact storage authenticated and group-scoped, with no protected
  `Clients.All`.
- **Health signal:** `GET /api/calibration/capabilities` returns a non-null
  `apiContractVersion`, and an anonymous or under-scoped caller is denied on
  every calibration route without leaking resource existence.
- **Rollback:** revert the migration to the prior schema. This is the only
  stage whose rollback is a schema operation; if it cannot be rolled back
  safely, no later stage should be started.

### Stage 2 — Calibration printer context

- **Capability flags:** none — printer context is derived from printer records
  and the capabilities response, not from a dedicated switch.
- **Precondition:** stage 1 healthy. Printers carry explicit Klipper firmware
  and Klipper G-code dialect, upstream-OrcaSlicer identity, and complete
  geometry/tool/nozzle metadata.
- **Health signal:** a complete explicitly identified Klipper printer projects
  a non-null eligibility through `projectCalibrationEligibility()`, and an
  incomplete, stale or non-Klipper record produces a **typed** rejection rather
  than a silent absence.
- **Rollback:** none required — no switch was flipped. Correct the printer
  records.

### Stage 3 — Authoritative persistence, sync, photos and profile history

- **Capability flags:** `calibrationApiEnabled`, `calibrationChangeFeedEnabled`, `calibrationOfflineDraftEnabled`, `calibrationPhotoUploadEnabled`
- **Precondition:** stages 1–2 healthy. Photo storage has bounded size and
  retention configured. Tombstones, cursors and replay ordering are
  implemented; there is no last-write-wins path and no duplicate append-only
  record.
- **Health signal:** a project created on device A appears on device B with
  attempts, events, observations, photos and profile history intact and
  immutable; a cursor gap is reconciled by REST rather than silently skipped.
- **Rollback:** set `calibrationPersistenceEnabled`, `calibrationSyncEnabled`
  and `calibrationPhotosEnabled` false. Authoritative history and promoted
  G-code are **not** deleted by this rollback; anything that deletes them
  is a defect, not a rollback.

### Stage 4 — Production upstream-Orca worker path and artifact promotion

- **Capability flags:** `calibrationArtifactPromotionEnabled` — gates
  promoting a generated patch independently of slicing. `calibrationGenerationEnabled`
  is deliberately held until stage 5, so the worker path can be proven healthy
  before any user can reach it.
- **Precondition:** stage 3 healthy. The pinned upstream-Orca binary or
  container is deployed, and artifact storage accepts promotion.
- **Health signal:** _operational_ slicing observed — a worker claims, renews,
  reports progress, produces an artifact and completes, yielding an immutable
  `GcodeFile`. A configured-but-idle worker does not satisfy this.
- **Rollback:** drain and stop the worker, and set
  `calibrationArtifactPromotionEnabled` false. `calibrationGenerationEnabled`
  is unaffected by this rollback since it is not yet enabled at this stage.

### Stage 5 — Idempotent calibration queue and shared safe dispatch

- **Capability flags:** `calibrationGenerationEnabled` (for the server switch it reads, see the mapping table above)
- **Precondition:** stage 4 healthy and observed operational. Duplicate
  generation, queue and start commands replay a single operation under
  concurrent clients; two backend instances cannot claim the same printer;
  bed-clear acknowledgement is bound to an exact job.
- **Health signal:** a duplicate start command produces one job, not two; an
  uncertain backend start remains `Starting` until reconciliation and is never
  blindly retried; changed firmware, stale telemetry, busy/maintenance state
  and an expired acknowledgement each block safely with a typed reason.
- **Rollback:** set the backing server switch false (see the mapping table above). In-flight jobs must
  reconcile rather than being force-failed.

### Stage 6 — PFD transport and offline support

- **Capability flags:** `calibrationOfflineDraftEnabled` — see "Flag
  vocabulary" above. Offline draft replay is gated by the same
  `calibrationSyncEnabled` switch as the stage-3 change feed; the client
  distinction exists so a rollout can note independently whether the PFD
  transport is ready to consume replayed writes.
- **Precondition:** stages 1–5 healthy. Packaged PFD builds carrying the
  calibration transport are distributed.
- **Health signal:** offline draft and photo staging survive both a process
  restart and a machine restart; two divergent devices reconnect, receive an
  **explicit** conflict, and converge only after a chosen resolution.
- **Rollback:** set `calibrationSyncEnabled` false and ship or roll back
  the PFD build. Because the client transport is what produces the writes
  to be replayed, a server-side rollback alone will not undo a bad client;
  both sides are involved.

### Stage 7 — Workspace, job workflow, profile workflow and importer

- **Capability flags:** none — these workflows are composed from capabilities
  already enabled at stages 3 and 5.
- **Precondition:** stage 6 healthy. Legacy backup v4 import fixtures pass,
  including idempotent retry and a migration report for corrupt or unsupported
  content.
- **Health signal:** packaged Windows PFD discovers profile fixtures, previews
  a diff, backs up, writes, verifies, atomically installs and rolls back;
  packaged macOS PFD exports and verifies the exact profile and does **not**
  advertise direct install.
- **Rollback:** restore the profile backup taken before install. An import that
  cannot be rolled back must not have been started.

### Stage 8 — Packaged cross-platform acceptance

- **Capability flags:** none — acceptance observes the enabled set, it does not
  extend it.
- **Precondition:** stages 1–7 healthy. Signed and notarized packaged builds
  for both platforms.
- **Health signal:** the packaged Windows and macOS matrices pass the workflows
  applicable to each platform and report **accurate platform capabilities** —
  a platform that cannot direct-install must not claim it can.
- **Rollback:** withdraw the release. By this stage every server-side switch is
  already on, so rollback is a distribution action, not a configuration one.

## Closing rule

Implementation PRs close **child** issues. They never close the epic (#42) and
never close the release gate (#57). #57 closes when its children are done; a
stray closing keyword in a child would close the gate early, which is the
failure this rule exists to prevent. The same rule applies one level down: a PR
implementing part of a child closes that child, not #57.

## What this document does not establish

- **That a rollout occurred.** Nothing here is evidence of a live deployment.
  Every health signal must be observed against a real server by a human with
  access, and recorded elsewhere.
- **That the server switch names are correct.** The parity test checks the
  mapping table against `RemoteCalibrationCapabilities` in this repository —
  which is PFD's _model_ of the server, not the server. If PrintFarmer renames
  a switch, this repository and this document can agree with each other and
  both be wrong. That gap is the cross-repository contract risk tracked in
  #138.
