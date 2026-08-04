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

The five flags PFD reasons about are **not** the four switches an operator
sets. `RemoteCalibrationCapabilities` normalises the wire names into the
negotiation shape the feature gate consumes, so callers never depend on raw
wire naming.

| Client flag (`CalibrationCapabilityFlags`) | Server switch (`RemoteCalibrationCapabilities`) | What it gates                                               |
| ------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| `calibrationApiEnabled`                    | `calibrationPersistenceEnabled`                 | Calibration REST APIs and authoritative project persistence |
| `calibrationChangeFeedEnabled`             | `calibrationSyncEnabled`                        | Change-feed events, cursors and replay                      |
| `calibrationOfflineDraftEnabled`           | `calibrationSyncEnabled`                        | Offline draft push through the calibration sync endpoint    |
| `calibrationPhotoUploadEnabled`            | `calibrationPhotosEnabled`                      | Staged calibration photo upload                             |
| `calibrationGenerationEnabled`             | `calibrationGenerationEnabled`                  | Generation and G-code promotion                             |

**Two consequences an operator must know before starting.**

1. **`calibrationChangeFeedEnabled` and `calibrationOfflineDraftEnabled` are
   one switch.** Offline drafts are pushed through the calibration sync
   endpoint, so they are gated by `calibrationSyncEnabled` together with the
   change feed. There is no server state in which one is on and the other is
   off, and an operator asking to enable offline drafts alone must be told
   that the request is not expressible.
2. **Because of (1), stage 6 enables no new server switch.** The capability
   that makes PFD offline support work is turned on at stage 3. Stage 6 is a
   client-transport and verification stage, not an enablement stage. Treating
   it as one produces a rollout that appears stalled because there is nothing
   to flip.

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
  G-code are **not** deleted by this rollback; anything that deletes them is a
  defect, not a rollback.

### Stage 4 — Production upstream-Orca worker path and artifact promotion

- **Capability flags:** none at this stage — `calibrationGenerationEnabled` is
  deliberately held until stage 5, so the worker path can be proven healthy
  before any user can reach it.
- **Precondition:** stage 3 healthy. The pinned upstream-Orca binary or
  container is deployed, and artifact storage accepts promotion.
- **Health signal:** _operational_ slicing observed — a worker claims, renews,
  reports progress, produces an artifact and completes, yielding an immutable
  `GcodeFile`. A configured-but-idle worker does not satisfy this.
- **Rollback:** drain and stop the worker. No client-visible flag changes.

### Stage 5 — Idempotent calibration queue and shared safe dispatch

- **Capability flags:** `calibrationGenerationEnabled`
- **Precondition:** stage 4 healthy and observed operational. Duplicate
  generation, queue and start commands replay a single operation under
  concurrent clients; two backend instances cannot claim the same printer;
  bed-clear acknowledgement is bound to an exact job.
- **Health signal:** a duplicate start command produces one job, not two; an
  uncertain backend start remains `Starting` until reconciliation and is never
  blindly retried; changed firmware, stale telemetry, busy/maintenance state
  and an expired acknowledgement each block safely with a typed reason.
- **Rollback:** set `calibrationGenerationEnabled` false. In-flight jobs must
  reconcile rather than being force-failed.

### Stage 6 — PFD transport and offline support

- **Capability flags:** none — see "Flag vocabulary" above. Offline draft push
  is gated by `calibrationSyncEnabled`, already enabled at stage 3. **This
  stage flips no switch.**
- **Precondition:** stages 1–5 healthy. Packaged PFD builds carrying the
  calibration transport are distributed.
- **Health signal:** offline draft and photo staging survive both a process
  restart and a machine restart; two divergent devices reconnect, receive an
  **explicit** conflict, and converge only after a chosen resolution.
- **Rollback:** ship or roll back the PFD build. Because no switch is flipped
  here, a server-side rollback will not undo a bad client; that asymmetry is
  the reason this stage is listed separately despite enabling nothing.

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

## External asset manifest gate

Every entry in `assets/calibration-asset-manifest.json` is `enabled: false`
today, each with a concrete `disabledReason`. This is a deliberate release
posture, not an oversight.

Flipping any entry to `enabled: true` requires **all** of:

- a reviewed `sourceUrl`,
- a named `author`,
- a declared redistributable `license` and an `attribution` string,
- a checksum policy — a non-null `expectedSha256` — and a passing validation
  fixture.

`tests/calibrationRolloutRunbook.test.ts` asserts the checksum and license half
mechanically: no entry can be `enabled: true` without a non-null
`expectedSha256` and a non-empty `license`. The review half — that the licence
is genuinely redistributable and the source genuinely approved — is a human
judgement and is **not** machine-checked. Do not read a green test as approval.

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
- **That the asset licences are acceptable.** See above.
