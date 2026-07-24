# Bishop — Recent Sessions

Bishop is the Rust/SQLite/integration developer for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). No Rust/SQLite code touched during this session — infrastructure only.

## Learnings

- 2026-07-23: The native workspace lives at `native/` with a `model-core` crate (`Cargo.toml`, `Cargo.lock`, `target/`) — this is where SQLite schema and model parsing logic will live. Look here first for any native integration work.
