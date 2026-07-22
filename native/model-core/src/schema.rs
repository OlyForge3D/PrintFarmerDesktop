//! Embedded catalog schema.
//!
//! The authoritative on-disk store is SQLite in WAL mode. The C-backed SQLite
//! driver is only compiled where a C toolchain is available (CI runners), so
//! the schema lives here as versioned DDL that the SQLite-backed
//! [`crate::catalog::CatalogStore`] applies as migration v1. The pure-Rust
//! [`crate::catalog::InMemoryCatalog`] mirrors the same semantics for local
//! development and tests.

/// Current schema version. Bump when adding a migration.
pub const SCHEMA_VERSION: u32 = 1;

/// DDL for schema v1. Separates logical model identity (`models`) from physical
/// files (`model_locations`) and treats duplicates as one model with many
/// locations.
pub const SCHEMA_V1: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_roots (
    id            TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    available     INTEGER NOT NULL DEFAULT 1,
    scan_cursor   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
    hash          TEXT PRIMARY KEY,
    format        TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    scene_version INTEGER,
    parse_status  TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_locations (
    root_id            TEXT NOT NULL REFERENCES source_roots(id) ON DELETE CASCADE,
    path               TEXT NOT NULL,
    root_relative      TEXT NOT NULL,
    model_hash         TEXT NOT NULL REFERENCES models(hash),
    size_bytes         INTEGER NOT NULL,
    modified_unix_secs INTEGER,
    available          INTEGER NOT NULL DEFAULT 1,
    last_seen_at       TEXT NOT NULL,
    PRIMARY KEY (root_id, path)
);

CREATE INDEX IF NOT EXISTS idx_model_locations_hash
    ON model_locations(model_hash);

CREATE TABLE IF NOT EXISTS thumbnails (
    model_hash    TEXT NOT NULL REFERENCES models(hash) ON DELETE CASCADE,
    recipe        TEXT NOT NULL,
    path          TEXT NOT NULL,
    width         INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    source        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'ready',
    PRIMARY KEY (model_hash, recipe)
);

CREATE TABLE IF NOT EXISTS tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS model_tags (
    model_hash TEXT NOT NULL REFERENCES models(hash) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (model_hash, tag_id)
);

CREATE TABLE IF NOT EXISTS collections (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    shared_to_farm INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_models (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    model_hash    TEXT NOT NULL REFERENCES models(hash) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, model_hash)
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_declares_core_tables() {
        for table in [
            "source_roots",
            "models",
            "model_locations",
            "thumbnails",
            "tags",
            "collections",
        ] {
            assert!(SCHEMA_V1.contains(table), "schema missing table {table}");
        }
    }

    #[test]
    fn schema_enables_wal() {
        assert!(SCHEMA_V1.contains("journal_mode = WAL"));
    }
}
