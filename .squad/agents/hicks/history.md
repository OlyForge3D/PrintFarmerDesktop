# Hicks — Recent Sessions

Hicks is QA and contract testing for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). No test code touched during this session — infrastructure only.

## Learnings

- 2026-07-23: Test surface: Vitest unit tests (`vitest.config.ts`, `npm test`), Playwright e2e (`playwright.config.ts`, `e2e/`, `tests/`, `scripts/build-e2e.mjs` runs pre-e2e). Rust side likely has its own `cargo test` suite under `native/model-core` — confirm with Bishop before assuming coverage exists.
