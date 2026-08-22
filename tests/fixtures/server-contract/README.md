# Server contract snapshots

Provenance-stamped snapshots of DTO shapes taken directly from the PrintFarmer
API server repository (`OlyForge3D/PrintFarmer`). These files are the
**source-of-truth authority** for tests that assert calibration wire requests
match the server's HTTP contract.

## Why this exists

`tests/fixtures/calibrationContract.ts` claims verbatim server provenance, but
its header is only a comment — nothing enforces it. Consequently every
"contract" test that imports from it is self-referential: the desktop asserts
against a fixture the desktop itself defined, and the check trivially passes
while the wire format silently drifts.

The snapshots here are different in two enforceable ways:

1. Each snapshot exports a **machine-checkable `PROVENANCE` object** naming a
   primary source — either a C# DTO's git blob hash at a pinned commit, or a
   captured live wire response's `serverVersion` fingerprint.
2. `calibration.snapshotProvenanceGuard.test.ts` walks every snapshot in this
   directory, asserts the `PROVENANCE` export exists and matches an approved
   shape, and — when the pfarm1 checkout is on disk — runs `git hash-object`
   against the declared `sourcePath` and compares to the declared `blobHash`.

If a `PROVENANCE` export is missing or is any other kind than the two below,
the guard test fails.

## The anti-fabrication rule

**A payload asserted in a prompt is not a source.** In Round 3, a snapshot was
built from a payload the coordinator asserted in prose. Half its field values
were inverted; the tests built on it all passed. This directory's protocol was
not sufficient to catch that: it required a prose provenance comment, and the
comment matched the prose. Round 4 closes the hole by requiring every snapshot
to carry a MACHINE-CHECKABLE `PROVENANCE` stamp of one of the two kinds below,
and by adding a guard that mechanically verifies the stamp.

## The two allowed provenance kinds

### `kind: 'csharp-source'` — field NAMES from a C# DTO

Use when the snapshot records the SHAPE of a wire message: what properties
exist, their names, their required/optional status. The names are copied
verbatim from the C# DTO.

```ts
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  sourcePath: 'src/infra/Dtos/PlatformCapabilitiesDto.cs',
  blobHash: 'da54b12c3783c6aa694f4b1904b9810b47990a74',
  typeName: 'PlatformCapabilitiesDto',
  // optional: additional C# files this snapshot also references
  additionalSources: [
    {
      sourcePath:
        'src/infra/Services/OperatorFeatures/OperatorFeatureFlagsDto.cs',
      blobHash: 'e5970c4bb216dd1d48d5b1f01fc0021ba0ca6a51',
      typeName: 'OperatorFeatureFlagsDto',
    },
  ],
};
```

The guard runs `git -C <pfarm1> hash-object <sourcePath>` and compares against
the declared `blobHash`. Any mismatch fails. If the pfarm1 checkout is not on
disk, the blob-hash check is skipped (with an explicit `it.skipIf` marker so
nobody can pretend it ran) — but the presence of a valid `PROVENANCE` shape is
still checked.

### `kind: 'live-response'` — field VALUES from a wire capture

Use when the snapshot records the VALUES of a wire response — a captured
`GET /api/…` body used as a test payload.

```ts
export const PROVENANCE = {
  kind: 'live-response' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  capturedFrom: 'http://localhost:18080/api/calibration/capabilities',
  serverVersion: '0.2.3+6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
  capturedAt: '2026-08-21T21:52-07:00',
};
```

The guard asserts that (a) the captured body's own `serverVersion` field
equals `PROVENANCE.serverVersion`, and (b) `PROVENANCE.commitSha` matches
SOME sibling `csharp-source` snapshot's `commitSha`. That cross-reference is
what proves the captured body corresponds to code we also have snapshots of.

`capturedFrom` MUST be a loopback URL (`localhost`, `127.0.0.1`, or `[::1]`).
Wire captures against production are forbidden by the user constraint.

## Adding a new snapshot

1. Locate the DTO in the server repo (`D:\s\pfarm1\src\...`).
2. Note the commit SHA (`git -C D:\s\pfarm1 rev-parse HEAD`) and blob hash
   (`git -C D:\s\pfarm1 ls-tree HEAD -- <path>` or
   `git -C D:\s\pfarm1 hash-object <path>`).
3. Copy field names into a new `.snapshot.ts` file next to this README.
4. Export a `PROVENANCE` object of the appropriate kind — see the shapes
   above. **This is not optional.** The provenance guard test will fail the
   whole suite if the export is missing or malformed.
5. If the shape you're adding also participates in the DTO-field drift check,
   wire the new snapshot into `serverContractSnapshotDrift.ts`.

## What these snapshots are NOT

They are not runtime types. The desktop's own DTOs live in `src/main/` and
`src/shared/`; those may legitimately be a subset of what the server accepts.
The snapshots capture the **superset the server expects**, so we can prove the
desktop request is a valid member of that set — never that the server accepts
only what the desktop sends.

They are also not documentation of what the server SHOULD do. They document
what the server DOES do, at a pinned commit. A snapshot that describes an
"improved" or "future" contract is a bug even if the improvement is desired.

## Historical note

Round 3 of the calibration investigation added the first four snapshots
under this protocol — `queuePrintJobDto`, `acknowledgeBedClearRequestDto`,
`platformCapabilitiesDto`, `calibrationCandidatesDto`, `jobBlockedReasonCode`.
Round 3 caught the wire DTOs matching; it missed the capability-negotiation
layer.

Round 4 caught its own error: the capability-flag snapshot was built from a
coordinator-asserted prose payload that was later disproved by a live wire
capture. `capabilitiesLiveResponse.snapshot.ts` is the corrected fixture,
carrying a `live-response` PROVENANCE stamp. The `calibration.snapshotProvenanceGuard`
test in `tests/` is the mechanism that prevents the same failure from
recurring: a snapshot with no PROVENANCE (or a fabricated one) now breaks
the build.
