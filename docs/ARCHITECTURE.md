# Architecture

PrintFarmer Desktop is a local-first 3D model library. It never moves, edits,
or uploads source models without an explicit user action.

## Processes

1. **Electron main** (`src/main`) — owns windows, the hardened security policy
   (CSP, navigation/window guards, permission denial, fuses), the versioned and
   runtime-validated IPC surface, PrintFarmer networking, credential encryption,
   and the Rust sidecar lifecycle. It exposes no generic filesystem, shell, or
   network primitive to the renderer.
2. **Preload** (`src/preload`) — a minimal `contextBridge` that publishes only
   the typed `window.printFarmer` API. `contextIsolation` is on, `sandbox` is
   on, `nodeIntegration` is off.
3. **Renderer** (`src/renderer`) — React + strict TypeScript. Presentation only;
   it cannot read arbitrary files, hold credentials, or call PrintFarmer
   directly. Hosts one Three.js scene at a time.
4. **Rust sidecar** (`native/model-core`) — a separately signed executable that
   owns SQLite (WAL), folder scanning/watching, streaming SHA-256 hashing,
   pure-Rust STL, OBJ, standard 3MF and Production Extension 3MF parsing, vendor
   (Bambu/Orca/Prusa) metadata, and the normalized scene cache. It talks to the
   main process over a framed, versioned RPC protocol on a private transport.

## IPC contract

All renderer↔main messages are defined once in `src/shared/ipc.ts` with Zod
schemas. The main process validates every request and response; the renderer
gets static types. Desktop IPC is currently version 2. It is intentionally
independent from the Rust sidecar RPC handshake, which remains protocol version
1; bump each constant only for changes to its own wire boundary.

## Data model

The sidecar keeps logical model identity (`models`, keyed by SHA-256) separate
from physical files (`model_locations`). Duplicate grouping is exact content
hashing. Filesystems are treated as eventually consistent: watcher events drive
targeted work, but periodic reconciliation is authoritative.

## PrintFarmer integration

Backward-compatible changes to the .NET 10 PrintFarmer server cover: personal
API-key → short-lived JWT exchange, streamed model + client-thumbnail upload
with idempotency, a first-class collection domain, and revisioned two-way sync
of tags and collections.

Server profiles are stored as a strictly validated, versioned file below
Electron's per-user data directory. Writes use a temporary file and atomic
rename. Profile mutations are serialized and network retests use configuration
revisions so a stale result cannot overwrite an update or resurrect a deleted
credential. API keys and passwords are encrypted with Electron `safeStorage`;
the main process refuses to save them when OS-backed encryption is unavailable.
The encrypted envelope binds each secret to its profile ID, normalized server
URL, authentication mode, and username identity. JWTs exist only in
main-process memory and are reissued before expiration. Per-profile
authentication generations prevent superseded renewals from caching or
returning tokens; a renewed token is returned only after the profile revision is
revalidated. Probes retain their starting generation across all network awaits;
superseded probes are cancellation outcomes and cannot mark a profile as
failed. The atomic profile write is the final guarded commit before its validated
token candidate is conditionally installed; token purges during the write prevent
installation without turning a successful persistence commit into an error.
Vault failures advance the same generation before persisting error state. Draft
probes use isolated ephemeral authentication identities.

The App owns ordered profile-list reconciliation, including mutations that
finish after the profile dialog closes. A synchronous modal owner coordinates
profile, import, file-picker, preview, and upload-queue entry so asynchronous
preparation cannot overlap or later remount another modal.

## Snapmaker U1 retargeting

The U1 workflow preserves the process boundary rather than teaching the
renderer about files:

1. The renderer sends only a catalog model hash/root ID, an opaque profile ID,
   an object-exclusion choice, or an artifact token through strict Zod IPC.
2. Electron main resolves the cataloged source path, rejects symlinks and
   unavailable locations, computes the source SHA-256, and resolves either a
   bundled profile ID or a content-addressed imported reference. Paths never
   cross into the renderer.
3. The Rust sidecar performs strict editable-project preflight and returns
   typed blockers/warnings. Builds replace machine/process/filament-owned
   settings, remove stale slice/G-code/signature parts and links, clamp every
   supported global and per-object motion override, rebuild OPC control parts
   deterministically, and validate the output by reopening it. Retarget/profile
   requests use a dedicated, serialized sidecar so archive-heavy work cannot
   consume catalog/sync deadlines; timeouts start when requests are dispatched.
4. Electron independently checks the returned source/output hashes and native
   validation result before issuing an owner-bound random artifact token. The
   renderer can request only the source or output scene associated with that
   token.
5. Save As uses an exclusive temporary write plus hard link. It rejects the
   source and any existing destination, then disposes the temporary artifact
   only after a successful save. Cancellation and collisions leave the review
   copy available for another destination.

Artifact tokens are bound to the originating `webContents`, expire after 30
minutes, and are disposed on workflow/window teardown. Each app instance owns a
mode-restricted random directory under the OS temporary directory with an
ownership marker. Startup ignores links, unmarked directories, and directories
owned by a live process; it removes only validated stale instance directories.
Shutdown removes the active owned directory. Request epochs
prevent stale profile imports, preflights, builds, and source/output scene loads
from replacing newer UI state or retaining a late token.

Bundled U1 profiles are an offline snapshot of `Snapmaker/Orca_Presets` pinned
to exact commit `0c2d17834b7820339c1cf4326fda7db9da4a766a`. The generated
manifest records every selected path and SHA-256, provenance, retrieval date,
and the no-runtime-fetch policy. Packaging verifies the source bundle before
copying it; Windows and macOS package/release jobs then verify the sidecar,
manifest, and every declared profile hash inside packaged resources. Imported
U1 references are copied into the Electron user-data directory under their
SHA-256, recorded in a strict atomic manifest, re-inspected on refresh, and
excluded individually if missing or corrupt without hiding bundled profiles.
Native inspection rejects executable post-processing settings before any
imported settings can be carried into the generated project. Imported machine
identity, dimensions, motion limits, tools, and every machine/filament G-code
hook are never trusted: generated projects always use manifest-verified values
from the pinned bundled snapshot. Imported process motion values are clamped
against those independent machine ceilings before they can become a target;
imported filament temperatures and volumetric flow are capped by the
corresponding pinned material profile.

Paint-bearing model parts are preserved byte-for-byte, but the normalized
viewer does not certify the slicer's paint semantics. A typed
`paintMetadataPreservedUnverified` warning therefore requires review in the
accepted Snapmaker Orca release. Direct slicing, printer communication, and
physical tool-change validation remain outside the desktop trust boundary.

The main process probes the anonymous version and capability endpoints and
publishes only redacted profile metadata plus explicit feature availability.
HTTP LAN profiles remain supported with a persistent warning. A missing
capability/version endpoint is treated as legacy and requires explicit user
confirmation. Legacy availability exposes only the conservative model-file and
server-thumbnail fallback; modern idempotent upload, client thumbnails, and
library sync stay gated. HTTPS certificate verification is never bypassed.
Remote DTO parsers tolerate additive server fields, then transform responses
into the strict internal IPC/profile models.

Model uploads are durable main-process jobs. The renderer submits only a
profile ID and catalog SHA-256 identities; main resolves and re-verifies an
available catalog location, acquires JWTs, streams bounded multipart requests,
and persists progress atomically under `userData`. Modern jobs retain one
client upload ID per item for safe retry. Confirmed legacy servers omit client
IDs and client thumbnails, and interrupted active uploads become explicitly
uncertain because retrying can create a duplicate. Successful jobs persist the
profile-scoped remote-model link through the sidecar before reporting success.

Folder access is separately authorized by the native picker. Main persists
canonical roots and gives the renderer opaque approval IDs; scan, preview,
import, and upload operations reject renderer-supplied paths or catalog
locations outside an approved path boundary. Existing catalog roots require
reauthorization. Model parsing and thumbnail RPCs likewise accept only files
under an approved root or the exact canonical file returned by the native file
picker.

Before network I/O, main rejects symlink sources and copies one securely opened
file handle through bounded SHA-256 verification into a private per-job
snapshot. Multipart streaming reads only that immutable snapshot and always
tears down its writer before releasing scheduler capacity. State transitions
to uploading are copy-on-write atomic checkpoints. Profile revision and auth
generation are revalidated immediately before send; a conditional 401 refresh
can retry one modern request with the same durable profile/hash upload
identity. Legacy ambiguity requires a separate duplicate-risk confirmation.
Queue reset is deliberate and retains the previous store as a backup.

Upload source approval returns one verified file handle: main compares
canonical paths and lstat/fstat identities before and after opening, without
case folding, using lossless bigint device/file IDs, and snapshot hashing reads
only that handle. Startup removes only well-formed stale snapshot directories.
Queue generations fence initialization, scheduler claims, long-running starts,
workers, progress, reset, and removal. Reset preserves the separate durable
modern upload identities. Remote links are keyed and persisted in Rust/SQLite
by profile, immutable server binding, and local hash; only uploaded,
exact-binding links suppress transfer. Pre-migration unbound links require
explicit duplicate-risk resolution; confirming one adopts the current
authenticated server binding for the whole job rather than retrying against
the placeholder binding, and already-succeeded items are never re-flagged as
duplicate risk on a later restart. Profile endpoint changes await old workers
before purging only the old binding. Approval reset is a separate confirmed
user action.
