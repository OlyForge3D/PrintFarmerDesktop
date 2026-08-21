# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Print-farm operators and advanced 3D-printing users who manage real printers through PrintFarmer. They work at a desktop near active hardware and need to calibrate a specific physical toolhead, nozzle, and filament without losing traceability or bypassing server authority.

## Product Purpose

PrintFarmer Desktop is a local-first native workspace for organizing printable models and completing safety-conscious printer workflows against authenticated PrintFarmer data. Success means users can move from an explicit backend printer configuration to a verified, auditable calibration result while retaining useful offline drafting and never guessing hardware, firmware, material, or profile context.

## Positioning

Calibration here is server-authoritative and auditable. A project binds to an explicit backend printer, toolhead, nozzle, material, and base profile before it will start, the app refuses to infer any of that context, and every stage decision is stored as reviewable data rather than a setting that silently changed. A neighbouring model manager or slicer can produce the same numbers; it cannot truthfully claim the operator can reconstruct which physical hardware and which authority produced them.

## Operating Context

A packaged Windows and macOS desktop application, run at a workstation beside active printers, and a companion to a PrintFarmer server rather than a replacement for one. It authenticates against that server for model and thumbnail upload, collections, and metadata sync, and treats the server as the source of truth for printer configuration.

Printer Calibration walks one printer, toolhead, nozzle, and filament through nine stages, records what the operator observed at each, and produces a deterministic OrcaSlicer filament profile from the results. Stage definitions follow upstream OrcaSlicer behaviour; the app bundles no third-party calibration models and is not a wrapper around another tool.

The Snapmaker U1 workflow prepares a new review copy of an Orca-family 3MF from a pinned bundled snapshot. It is local-only: nothing is uploaded and no profile is downloaded at runtime.

Drafting works offline, but offline or stale state is never presented as readiness.

## Capabilities and Constraints

Confirmed functionality: in-place scanning of existing STL, 3MF, and OBJ folders; a searchable virtualized library with duplicate grouping, tags, and collections; a Three.js viewer and deterministic thumbnails; upload to PrintFarmer with idempotent retry; guided printer calibration with report and profile-patch output; and Snapmaker U1 project preparation.

Durable constraints future work must preserve:

- Source models are read-only. Nothing is moved, renamed, modified, or uploaded without an explicit user action.
- Model identity is the SHA-256 of content and is kept separate from the physical files that carry it. Filesystems are treated as eventually consistent: watcher events drive targeted work, periodic reconciliation is authoritative.
- Four trust boundaries in decreasing privilege: main, preload, renderer, and a separately signed Rust sidecar that owns SQLite (WAL), scanning and watching, streaming hashing, mesh parsing, and the scene cache. The renderer gets no Node, no `ipcRenderer`, and no filesystem or network primitive.
- Renderer capability is added only by declaring a Zod-validated channel in `src/shared/ipc.ts`, with main validating request and response. The desktop IPC contract and the sidecar RPC handshake version independently.
- Calibration source-derived files live under the `derivedRoots` of `compliance/printer-calibration-provenance.json` and require a provenance header plus a manifest record. Orchestration, UI, persistence, ownership, authorization, queueing, and safety code stays outside those roots and is independently implemented.
- The app never claims to have verified a physical change it cannot observe, and never presents a safety action as celebratory.
- Credentials are encrypted in the OS vault; credentials and signing material are never committed.
- Inputs are rejected with actionable blockers rather than best-effort repair: geometry-only or pre-sliced 3MFs, unsupported producers, malformed archives, and imported references carrying local executable post-processing commands. Preserved paint metadata is reported as render-unverified.

Terminology that carries meaning and should not be used loosely: model versus model location; source root; server profile; calibration project, stage, report, and profile patch; upload job.

Explicitly undecided: Snapmaker U1 hardware acceptance is not complete, and awaits either a physical print or a product-owner waiver.

## Brand Commitments

Named PrintFarmer Desktop, by OlyForge3D, and positioned as a companion to the PrintFarmer server rather than a standalone product.

Free and open source permanently: AGPL-3.0-only is a product commitment, not a placeholder, and no paid or hosted tier is planned. Corresponding-source obligations are documented in `docs/compliance/CORRESPONDING_SOURCE.md` and future work must not introduce anything that cannot ship under that licence.

Voice is precise, calm, and trustworthy. The product should feel like a focused professional instrument: technically fluent without being cryptic, cautious without becoming obstructive, and direct about uncertainty.

Existing assets: `assets/icon.png`, `assets/icon.ico`, `assets/icon.icns`, and `assets/installing.gif`.

## Anti-references

Do not resemble a decorative SaaS dashboard, an embedded website, a consumer setup toy, or a slicer clone. Avoid guessed defaults, celebratory safety actions, modal-first navigation, browser/Tauri conventions, dense walls of unexplained expert terminology, and generic card grids that obscure workflow state.

## Evidence on Hand

Pre-release. Version 0.1.0-beta.4, working software, real printers in-house, and no public users.

Real and citable: the shipped application itself; `docs/printer-calibration-user-guide.md` and `docs/printer-calibration-admin-guide.md`; `docs/ARCHITECTURE.md`; `docs/security/THREAT_MODEL.md`; `docs/release-validation.md`, which records the packaged Windows/macOS release matrix, WebGL2 capability reporting, SwiftShader fallback, and the accessibility gate; `compliance/printer-calibration-provenance.json`; and `assets/calibration-asset-manifest.json`.

Future work must not fabricate what does not exist: there are no customers, testimonials, case studies, press mentions, install counts, uptime or performance benchmarks, pricing, or third-party endorsements. Snapmaker U1 hardware acceptance has not been completed, so no claim may imply a verified physical print.

## Product Principles

1. Make authority and physical context visible before action.
2. Preserve work locally, but never disguise offline or stale state as readiness.
3. Teach in place while keeping expert paths efficient.
4. Represent every calibration decision as explicit, reviewable data.
5. Keep one coherent desktop interaction vocabulary across Library and Printer Calibration.

## Accessibility & Inclusion

Meet WCAG 2.2 AA expectations for keyboard operation, landmarks, headings, labels, status and error announcements, visible focus, contrast, large text, and reduced motion. Dialogs must trap and restore focus. Calibration photos require captions and ordering, reports must print clearly, and color must never be the only carrier of status or confidence.
