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
gets static types. Bump `IPC_CONTRACT_VERSION` on any breaking change.

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
