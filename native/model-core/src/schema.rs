//! Embedded catalog schema.
//!
//! The authoritative on-disk store is SQLite in WAL mode. The C-backed SQLite
//! driver is only compiled where a C toolchain is available (CI runners), so
//! the schema lives here as versioned DDL that the SQLite-backed
//! [`crate::catalog::CatalogStore`] applies as versioned migrations. The pure-Rust
//! [`crate::catalog::InMemoryCatalog`] mirrors the same semantics for local
//! development and tests.

/// Current schema version. Bump when adding a migration.
pub const SCHEMA_VERSION: u32 = 6;

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

/// Additive v2 synchronization state. Profiles are opaque Electron-owned
/// identifiers; this schema deliberately contains no server location or secret
/// material.
pub const SCHEMA_V2: &str = r#"
CREATE TABLE IF NOT EXISTS sync_profiles (
    profile_id       TEXT PRIMARY KEY,
    cursor           TEXT,
    server_revision  INTEGER NOT NULL DEFAULT 0,
    last_pulled_at   INTEGER,
    last_pushed_at   INTEGER,
    updated_at       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remote_model_links (
    profile_id       TEXT NOT NULL REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    local_model_hash TEXT NOT NULL,
    remote_model_id  TEXT NOT NULL,
    client_upload_id TEXT NOT NULL,
    etag             TEXT,
    upload_status    TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    uploaded_at      INTEGER,
    PRIMARY KEY (profile_id, local_model_hash),
    UNIQUE (profile_id, remote_model_id),
    UNIQUE (profile_id, client_upload_id)
);

CREATE TABLE IF NOT EXISTS sync_entities (
    profile_id       TEXT NOT NULL REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    entity_type      TEXT NOT NULL,
    local_id         TEXT,
    remote_id        TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    concurrency_token TEXT,
    tombstone        INTEGER NOT NULL DEFAULT 0,
    visibility       TEXT NOT NULL,
    snapshot_json    TEXT,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (profile_id, entity_type, remote_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_entities_local
    ON sync_entities(profile_id, entity_type, local_id)
    WHERE local_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_outbox (
    profile_id       TEXT NOT NULL REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    operation_id     TEXT NOT NULL,
    entity_type      TEXT NOT NULL,
    operation_kind   TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    base_revision    INTEGER,
    concurrency_token TEXT,
    state            TEXT NOT NULL,
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    retry_eligible   INTEGER NOT NULL DEFAULT 1,
    retry_at         INTEGER,
    lease_until      INTEGER,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    acked_at         INTEGER,
    PRIMARY KEY (profile_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_claim
    ON sync_outbox(profile_id, state, retry_at, lease_until, created_at);

CREATE TABLE IF NOT EXISTS sync_conflicts (
    profile_id       TEXT NOT NULL REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    conflict_id      TEXT NOT NULL,
    entity_type      TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    local_payload_json TEXT,
    server_payload_json TEXT,
    submitted_payload_json TEXT,
    reason           TEXT NOT NULL,
    server_revision  INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    resolved_at      INTEGER,
    resolution       TEXT,
    PRIMARY KEY (profile_id, conflict_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved
    ON sync_conflicts(profile_id, resolved_at, created_at);
"#;

/// Additive v3 fencing and ordering metadata for durable outbound batches.
pub const SCHEMA_V3: &str = r#"
ALTER TABLE sync_outbox ADD COLUMN sequence INTEGER;
ALTER TABLE sync_outbox ADD COLUMN batch_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN batch_ordinal INTEGER;
ALTER TABLE sync_outbox ADD COLUMN lease_token TEXT;

UPDATE sync_outbox
SET sequence = rowid,
    batch_id = 'legacy-' || printf('%016x', rowid),
    batch_ordinal = 0
WHERE sequence IS NULL;

CREATE TABLE sync_profile_sequences (
    profile_id    TEXT PRIMARY KEY REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    next_sequence INTEGER NOT NULL
);

INSERT INTO sync_profile_sequences(profile_id, next_sequence)
SELECT profile_id, COALESCE(MAX(sequence), 0) + 1
FROM sync_outbox
GROUP BY profile_id;

CREATE UNIQUE INDEX idx_sync_outbox_sequence
    ON sync_outbox(profile_id, sequence);
CREATE UNIQUE INDEX idx_sync_outbox_batch_ordinal
    ON sync_outbox(profile_id, batch_id, batch_ordinal);
CREATE INDEX idx_sync_outbox_state_sequence
    ON sync_outbox(profile_id, state, retry_eligible, retry_at, sequence);
CREATE INDEX idx_sync_outbox_active_sequence
    ON sync_outbox(profile_id, state, sequence);
CREATE INDEX idx_sync_outbox_retention
    ON sync_outbox(profile_id, state, acked_at, sequence);
CREATE INDEX idx_sync_outbox_batch_state
    ON sync_outbox(profile_id, batch_id, state, sequence);
"#;

/// Additive v4 checkpoint fencing and conflict/outbox association.
pub const SCHEMA_V4: &str = r#"
ALTER TABLE sync_profiles ADD COLUMN checkpoint_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_conflicts ADD COLUMN batch_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN operation_id TEXT;

CREATE INDEX idx_sync_conflicts_batch
    ON sync_conflicts(profile_id, batch_id, resolved_at);
"#;

/// Additive v5 incarnation and attempt fencing. Existing rows are populated by
/// the Rust migration while the schema transaction remains open.
pub const SCHEMA_V5: &str = r#"
ALTER TABLE sync_outbox ADD COLUMN batch_incarnation TEXT;
ALTER TABLE sync_outbox ADD COLUMN attempt_token TEXT;
ALTER TABLE sync_conflicts ADD COLUMN batch_incarnation TEXT;
ALTER TABLE sync_conflicts ADD COLUMN attempt_token TEXT;

CREATE INDEX idx_sync_outbox_incarnation
    ON sync_outbox(profile_id, batch_id, batch_incarnation, state, sequence);
CREATE INDEX idx_sync_conflicts_incarnation
    ON sync_conflicts(profile_id, batch_id, batch_incarnation, resolved_at);
"#;

/// Additive v6 local-only library favorites keyed by logical model hash.
pub const SCHEMA_V6: &str = r#"
CREATE TABLE favorite_models (
    model_hash  TEXT PRIMARY KEY REFERENCES models(hash) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
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

    #[test]
    fn sync_schema_contains_no_transport_or_secret_fields() {
        let sync_schema =
            format!("{SCHEMA_V2}\n{SCHEMA_V3}\n{SCHEMA_V4}\n{SCHEMA_V5}\n{SCHEMA_V6}")
                .to_lowercase();
        for forbidden in ["server_url", "auth_token", "api_key", "password", "jwt"] {
            assert!(!sync_schema.contains(forbidden));
        }
        for table in [
            "sync_profiles",
            "remote_model_links",
            "sync_entities",
            "sync_outbox",
            "sync_conflicts",
        ] {
            assert!(SCHEMA_V2.contains(table), "schema missing table {table}");
        }
    }

    #[test]
    fn favorites_schema_references_models() {
        assert!(SCHEMA_V6.contains("favorite_models"));
        assert!(SCHEMA_V6.contains("REFERENCES models"));
    }
}
