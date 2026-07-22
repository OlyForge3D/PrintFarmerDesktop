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
   STL/3MF parsing via lib3mf, vendor (Bambu/Orca/Prusa) metadata, and the
   normalized scene cache. It talks to the main process over a framed, versioned
   RPC protocol on a private transport.

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
