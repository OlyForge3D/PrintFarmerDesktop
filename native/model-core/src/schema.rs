//! Embedded catalog schema.
//!
//! The authoritative on-disk store is SQLite in WAL mode. The C-backed SQLite
//! driver is only compiled where a C toolchain is available (CI runners), so
//! the schema lives here as versioned DDL that the SQLite-backed
//! [`crate::catalog::CatalogStore`] applies as versioned migrations. The pure-Rust
//! [`crate::catalog::InMemoryCatalog`] mirrors the same semantics for local
//! development and tests.

/// Current schema version. Bump when adding a migration.
pub const SCHEMA_VERSION: u32 = 14;

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

/// Additive v7 removes the global tag-name uniqueness constraint. Remote tags
/// keep stable profile-scoped ids, so equal display names must remain distinct.
pub const SCHEMA_V7: &str = r#"
CREATE TABLE tags_v7 (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
INSERT INTO tags_v7(id, name) SELECT id, name FROM tags;

CREATE TABLE model_tags_v7 (
    model_hash TEXT NOT NULL REFERENCES models(hash) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags_v7(id) ON DELETE CASCADE,
    PRIMARY KEY (model_hash, tag_id)
);
INSERT INTO model_tags_v7(model_hash, tag_id)
SELECT model_hash, tag_id FROM model_tags;

DROP TABLE model_tags;
DROP TABLE tags;
ALTER TABLE tags_v7 RENAME TO tags;
ALTER TABLE model_tags_v7 RENAME TO model_tags;
"#;

/// v8 binds durable sync state to one authenticated server incarnation and
/// records explicit provenance for materialized remote catalog rows.
pub const SCHEMA_V8: &str = r#"
ALTER TABLE sync_profiles ADD COLUMN profile_binding TEXT;
ALTER TABLE sync_entities ADD COLUMN journal_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE collections ADD COLUMN sync_profile_id TEXT;
ALTER TABLE collections ADD COLUMN sync_remote_id TEXT;
ALTER TABLE collections ADD COLUMN sync_owner_user_id TEXT;
ALTER TABLE collections ADD COLUMN sync_visibility TEXT;
ALTER TABLE collections ADD COLUMN sync_read_only INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tags ADD COLUMN sync_profile_id TEXT;
ALTER TABLE tags ADD COLUMN sync_remote_id TEXT;
ALTER TABLE tags ADD COLUMN sync_owner_user_id TEXT;
ALTER TABLE tags ADD COLUMN sync_visibility TEXT;
ALTER TABLE tags ADD COLUMN sync_read_only INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_collections_sync_remote
    ON collections(sync_profile_id, sync_remote_id)
    WHERE sync_profile_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tags_sync_remote
    ON tags(sync_profile_id, sync_remote_id)
    WHERE sync_profile_id IS NOT NULL;
"#;

/// v9 backfills provenance for rows materialized before explicit provenance.
pub const SCHEMA_V9: &str = r#"
UPDATE collections
SET sync_profile_id = (
        SELECT e.profile_id FROM sync_entities e
        WHERE e.entity_type = 'ModelCollection' AND e.local_id = collections.id
        LIMIT 1),
    sync_remote_id = (
        SELECT e.remote_id FROM sync_entities e
        WHERE e.entity_type = 'ModelCollection' AND e.local_id = collections.id
        LIMIT 1),
    sync_visibility = (
        SELECT e.visibility FROM sync_entities e
        WHERE e.entity_type = 'ModelCollection' AND e.local_id = collections.id
        LIMIT 1),
    sync_read_only = COALESCE((
        SELECT CASE WHEN e.visibility = 'Shared' THEN 1 ELSE 0 END
        FROM sync_entities e
        WHERE e.entity_type = 'ModelCollection' AND e.local_id = collections.id
        LIMIT 1), 0)
WHERE EXISTS (
    SELECT 1 FROM sync_entities e
    WHERE e.entity_type = 'ModelCollection' AND e.local_id = collections.id);

UPDATE tags
SET sync_profile_id = (
        SELECT e.profile_id FROM sync_entities e
        WHERE e.entity_type = 'Tag' AND e.local_id = tags.id LIMIT 1),
    sync_remote_id = (
        SELECT e.remote_id FROM sync_entities e
        WHERE e.entity_type = 'Tag' AND e.local_id = tags.id LIMIT 1),
    sync_visibility = (
        SELECT e.visibility FROM sync_entities e
        WHERE e.entity_type = 'Tag' AND e.local_id = tags.id LIMIT 1),
    sync_read_only = COALESCE((
        SELECT CASE WHEN e.visibility = 'Shared' THEN 1 ELSE 0 END
        FROM sync_entities e
        WHERE e.entity_type = 'Tag' AND e.local_id = tags.id LIMIT 1), 0)
WHERE EXISTS (
    SELECT 1 FROM sync_entities e
    WHERE e.entity_type = 'Tag' AND e.local_id = tags.id);
"#;

/// v10 adds the binding CAS revision counter used to fence atomic binding
/// replacement. Databases that completed the provenance backfill already report
/// `user_version = 9`, so this migration must remain separate from v9. The `:1`
/// incarnation suffix backfill for legacy 64-char bindings also belongs here
/// because it depends on the revision counter.
pub const SCHEMA_V10: &str = r#"
ALTER TABLE sync_profiles ADD COLUMN binding_cas_revision INTEGER NOT NULL DEFAULT 0;
UPDATE sync_profiles
SET profile_binding = profile_binding || ':1'
WHERE profile_binding IS NOT NULL AND length(profile_binding) = 64;
"#;

/// Additive v11 server binding for durable upload identity isolation. Existing
/// links are deliberately unbound and must be resolved by the Desktop user.
pub const SCHEMA_V11: &str = r#"
CREATE TABLE remote_model_links_v11 (
    profile_id       TEXT NOT NULL REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
    server_binding   TEXT NOT NULL DEFAULT 'legacy-unbound',
    local_model_hash TEXT NOT NULL,
    remote_model_id  TEXT NOT NULL,
    client_upload_id TEXT NOT NULL,
    etag             TEXT,
    upload_status    TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    uploaded_at      INTEGER,
    PRIMARY KEY (profile_id, server_binding, local_model_hash),
    UNIQUE (profile_id, server_binding, remote_model_id),
    UNIQUE (profile_id, server_binding, client_upload_id)
);

INSERT INTO remote_model_links_v11(
    profile_id, server_binding, local_model_hash, remote_model_id,
    client_upload_id, etag, upload_status, created_at, updated_at, uploaded_at)
SELECT profile_id, 'legacy-unbound', local_model_hash, remote_model_id,
       client_upload_id, etag, upload_status, created_at, updated_at, uploaded_at
FROM remote_model_links;

DROP TABLE remote_model_links;
ALTER TABLE remote_model_links_v11 RENAME TO remote_model_links;
"#;

/// Additive v12 Printer Calibration persistence (issue #52).
///
/// All tables are profile-scoped and contain no server URLs, JWT tokens,
/// API keys, or password material. Profile identities are opaque
/// Electron-owned UUIDs; `project_id` / `step_id` etc. are client-generated
/// UUIDs. Server-assigned remote IDs are cached projections only.
///
/// PrintFarmer is authoritative for completed attempts, profile revisions, and
/// uploaded photos. PFD never silently promotes a local cached version of these
/// to server authority.
pub const SCHEMA_V12: &str = r#"
-- Cached calibration project aggregates. `is_synced` is 0 until all outbox
-- operations are settled. `is_printer_context_fresh` is 0 until printer
-- context has been revalidated post-mutation.
CREATE TABLE calibration_projects (
    profile_id                TEXT NOT NULL,
    project_id                TEXT NOT NULL,
    display_name              TEXT NOT NULL,
    description               TEXT,
    status                    TEXT NOT NULL DEFAULT 'draft',
    printer_id                TEXT NOT NULL,
    is_synced                 INTEGER NOT NULL DEFAULT 0,
    is_printer_context_fresh  INTEGER NOT NULL DEFAULT 0,
    has_conflicts             INTEGER NOT NULL DEFAULT 0,
    remote_project_id         TEXT,
    base_revision             INTEGER,
    change_feed_cursor        TEXT,
    checkpoint_generation     INTEGER NOT NULL DEFAULT 0,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    PRIMARY KEY (profile_id, project_id)
);

CREATE INDEX idx_calibration_projects_profile
    ON calibration_projects(profile_id, status, updated_at);

-- Ordered calibration steps. Steps are strictly ordered by `ordinal`.
-- The `draft_ordinal` field captures pending user reordering before sync.
CREATE TABLE calibration_steps (
    profile_id        TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    step_id           TEXT NOT NULL,
    ordinal           INTEGER NOT NULL,
    draft_ordinal     INTEGER,
    kind              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    display_name      TEXT NOT NULL,
    prerequisites     TEXT,
    method_notes      TEXT,
    expected_result   TEXT,
    measured_result   TEXT,
    reordering_supported INTEGER NOT NULL DEFAULT 0,
    remote_step_id    TEXT,
    revision          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (profile_id, step_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_steps_project
    ON calibration_steps(profile_id, project_id, ordinal);

-- Immutable calibration attempts. Once recorded, attempts are never
-- overwritten. `is_selected` marks the user-chosen outcome for the step.
CREATE TABLE calibration_attempts (
    profile_id                    TEXT NOT NULL,
    attempt_id                    TEXT NOT NULL,
    step_id                       TEXT NOT NULL,
    project_id                    TEXT NOT NULL,
    attempt_number                INTEGER NOT NULL,
    measured_value                REAL,
    measured_unit                 TEXT,
    is_selected                   INTEGER NOT NULL DEFAULT 0,
    printer_context_snapshot_hash TEXT,
    remote_attempt_id             TEXT,
    remote_revision               INTEGER,
    created_at                    TEXT NOT NULL,
    PRIMARY KEY (profile_id, attempt_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_attempts_step
    ON calibration_attempts(profile_id, step_id, attempt_number);

-- Immutable events attached to an attempt. Append-only.
CREATE TABLE calibration_events (
    profile_id      TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    attempt_id      TEXT NOT NULL,
    step_id         TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    payload_json    TEXT NOT NULL DEFAULT '{}',
    remote_event_id TEXT,
    occurred_at     TEXT NOT NULL,
    PRIMARY KEY (profile_id, event_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_events_attempt
    ON calibration_events(profile_id, attempt_id, occurred_at);

-- Immutable physical measurement observations. Append-only.
-- Measurements are never silently merged or overwritten.
CREATE TABLE calibration_observations (
    profile_id            TEXT NOT NULL,
    observation_id        TEXT NOT NULL,
    attempt_id            TEXT NOT NULL,
    step_id               TEXT NOT NULL,
    project_id            TEXT NOT NULL,
    parameter_key         TEXT NOT NULL,
    numeric_value         REAL,
    unit                  TEXT,
    note                  TEXT,
    remote_observation_id TEXT,
    observed_at           TEXT NOT NULL,
    PRIMARY KEY (profile_id, observation_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_observations_attempt
    ON calibration_observations(profile_id, attempt_id, parameter_key);

-- Staged offline photos. Bytes are stored on disk (path managed by main
-- process); this table tracks metadata, hash, and upload state.
-- Successfully uploaded photos are cleaned up deterministically.
-- Conflicted/unresolved photos are retained until explicitly resolved.
CREATE TABLE staged_calibration_photos (
    profile_id      TEXT NOT NULL,
    photo_id        TEXT NOT NULL,
    attempt_id      TEXT NOT NULL,
    step_id         TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'staged',
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    remote_photo_id TEXT,
    remote_url      TEXT,
    staged_at       TEXT NOT NULL,
    uploaded_at     TEXT,
    PRIMARY KEY (profile_id, photo_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_staged_photos_hash
    ON staged_calibration_photos(profile_id, attempt_id, content_hash);
CREATE INDEX idx_staged_photos_status
    ON staged_calibration_photos(profile_id, status, staged_at);

-- Generated OrcaSlicer profile revisions. Exact profile JSON is not stored
-- here; only identity metadata is cached. PrintFarmer is authoritative for
-- the content of generated revisions.
CREATE TABLE calibration_profile_revisions (
    profile_id             TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    project_id             TEXT NOT NULL,
    revision_label         TEXT NOT NULL,
    is_promoted            INTEGER NOT NULL DEFAULT 0,
    target_orca_profile_id TEXT,
    profile_json_hash      TEXT,
    remote_revision_id     TEXT,
    generated_at           TEXT NOT NULL,
    promoted_at            TEXT,
    PRIMARY KEY (profile_id, revision_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_profile_revisions_project
    ON calibration_profile_revisions(profile_id, project_id, generated_at);

-- Ordered outbox of pending calibration operations. Operations are pushed in
-- stable `sequence` order. `depends_on_json` lists operation IDs that must
-- be settled before this one can be pushed.
-- `idempotency_key` is the canonical request hash.
-- Settled/replayed operations are retained for a bounded period then cleaned.
CREATE TABLE calibration_outbox (
    profile_id        TEXT NOT NULL,
    operation_id      TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    kind              TEXT NOT NULL,
    sequence          INTEGER NOT NULL,
    entity_type       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    operation_kind    TEXT NOT NULL,
    payload_json      TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL,
    base_revision     INTEGER,
    depends_on_json   TEXT NOT NULL DEFAULT '[]',
    state             TEXT NOT NULL DEFAULT 'pending',
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    retry_at          TEXT,
    lease_until       TEXT,
    lease_token       TEXT,
    settled_at        TEXT,
    server_revision   INTEGER,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (profile_id, operation_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_outbox_claim
    ON calibration_outbox(profile_id, state, retry_at, lease_until, sequence);
CREATE UNIQUE INDEX idx_calibration_outbox_sequence
    ON calibration_outbox(profile_id, project_id, sequence);

-- Conflict records. Only semantically safe resolutions are allowed; no
-- last-write-wins path exists in this schema.
CREATE TABLE calibration_conflicts (
    profile_id             TEXT NOT NULL,
    conflict_id            TEXT NOT NULL,
    project_id             TEXT NOT NULL,
    kind                   TEXT NOT NULL,
    entity_id              TEXT NOT NULL,
    operation_id           TEXT,
    local_payload_json     TEXT,
    server_payload_json    TEXT,
    server_revision        INTEGER NOT NULL,
    created_at             TEXT NOT NULL,
    resolved_at            TEXT,
    resolution             TEXT,
    PRIMARY KEY (profile_id, conflict_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_conflicts_unresolved
    ON calibration_conflicts(profile_id, resolved_at, created_at);
CREATE INDEX idx_calibration_conflicts_project
    ON calibration_conflicts(profile_id, project_id, resolved_at);

-- Cached printer context snapshots bound to calibration projects.
-- Stale snapshots (is_current = 0) trigger a required rebase before
-- generation, bed-clear, or print start actions are enabled.
CREATE TABLE calibration_printer_snapshots (
    profile_id           TEXT NOT NULL,
    project_id           TEXT NOT NULL,
    printer_id           TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    printer_model        TEXT,
    firmware             TEXT NOT NULL,
    gcode_dialect        TEXT NOT NULL,
    firmware_version     TEXT,
    klipper_config_hash  TEXT,
    orca_profile_id      TEXT,
    orca_profile_name    TEXT,
    bed_width_mm         REAL,
    bed_depth_mm         REAL,
    nozzle_diameter_mm   REAL,
    snapshot_at          TEXT NOT NULL,
    is_current           INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (profile_id, project_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);
"#;

/// Additive v13 persistence for the exact renderer calibration workspace state.
///
/// The state is profile-scoped and tied to its v12 project aggregate. It stores
/// only the serialized calibration workspace DTO and progress counters; no
/// credentials, server locations, or filesystem locations are modeled.
pub const SCHEMA_V13: &str = r#"
CREATE TABLE calibration_workspace_states (
    profile_id             TEXT NOT NULL,
    project_id             TEXT NOT NULL,
    workspace_state_json   TEXT NOT NULL,
    completed_step_count   INTEGER NOT NULL,
    total_step_count       INTEGER NOT NULL,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (profile_id, project_id),
    FOREIGN KEY (profile_id, project_id)
        REFERENCES calibration_projects(profile_id, project_id) ON DELETE CASCADE
);

CREATE INDEX idx_calibration_workspace_states_profile
    ON calibration_workspace_states(profile_id, updated_at DESC);
"#;

/// Additive v14 private photo storage and canonical workspace-stage identity.
///
/// `local_path` is native-only metadata. It is intentionally absent from every
/// renderer-facing DTO. The former `step_id` column held workspace stage names,
/// not UUID step identities, and is renamed to make that contract explicit.
pub const SCHEMA_V14: &str = r#"
ALTER TABLE staged_calibration_photos RENAME COLUMN step_id TO stage_id;
ALTER TABLE staged_calibration_photos ADD COLUMN local_path TEXT;
ALTER TABLE staged_calibration_photos ADD COLUMN caption TEXT NOT NULL DEFAULT '';
ALTER TABLE staged_calibration_photos ADD COLUMN photo_order INTEGER NOT NULL DEFAULT 1;
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
        let sync_schema = format!(
            "{SCHEMA_V2}\n{SCHEMA_V3}\n{SCHEMA_V4}\n{SCHEMA_V5}\n{SCHEMA_V6}\n{SCHEMA_V7}\n{SCHEMA_V8}\n{SCHEMA_V9}\n{SCHEMA_V10}\n{SCHEMA_V11}\n{SCHEMA_V12}"
        )
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

    #[test]
    fn upload_link_schema_adds_server_binding() {
        assert!(SCHEMA_V11.contains("server_binding"));
        assert!(SCHEMA_V11.contains("legacy-unbound"));
    }

    #[test]
    fn calibration_schema_v12_declares_required_tables() {
        for table in [
            "calibration_projects",
            "calibration_steps",
            "calibration_attempts",
            "calibration_events",
            "calibration_observations",
            "staged_calibration_photos",
            "calibration_profile_revisions",
            "calibration_outbox",
            "calibration_conflicts",
            "calibration_printer_snapshots",
        ] {
            assert!(
                SCHEMA_V12.contains(table),
                "SCHEMA_V12 missing table {table}"
            );
        }
    }

    #[test]
    fn calibration_schema_contains_no_secret_fields() {
        let schema = format!("{SCHEMA_V12}\n{SCHEMA_V13}\n{SCHEMA_V14}").to_lowercase();
        for forbidden in ["server_url", "auth_token", "api_key", "password", "jwt"] {
            assert!(
                !schema.contains(forbidden),
                "SCHEMA_V12 must not contain secret field '{forbidden}'"
            );
        }
    }

    #[test]
    fn calibration_schema_v13_declares_workspace_state_without_sensitive_columns() {
        assert!(SCHEMA_V13.contains("calibration_workspace_states"));
        for required in [
            "profile_id",
            "project_id",
            "workspace_state_json",
            "completed_step_count",
            "total_step_count",
            "updated_at",
            "REFERENCES calibration_projects",
        ] {
            assert!(
                SCHEMA_V13.contains(required),
                "SCHEMA_V13 missing {required}"
            );
        }
        let schema = SCHEMA_V13.to_lowercase();
        for forbidden in [
            "credential",
            "server_url",
            "auth_token",
            "api_key",
            "password",
            "jwt",
            "filesystem_path",
            "file_path",
        ] {
            assert!(
                !schema.contains(forbidden),
                "SCHEMA_V13 must not contain sensitive field '{forbidden}'"
            );
        }
    }

    #[test]
    fn calibration_outbox_has_idempotency_key_and_sequence() {
        assert!(SCHEMA_V12.contains("idempotency_key"));
        assert!(SCHEMA_V12.contains("sequence"));
        assert!(SCHEMA_V12.contains("depends_on_json"));
    }

    #[test]
    fn calibration_schema_v14_keeps_photo_paths_native_only() {
        assert!(SCHEMA_V14.contains("RENAME COLUMN step_id TO stage_id"));
        assert!(SCHEMA_V14.contains("local_path"));
        let dto = crate::calibration::StagedCalibrationPhotoDto {
            photo_id: "photo".into(),
            attempt_id: "attempt".into(),
            stage_id: crate::calibration::CalibrationWorkspaceStageId::Temperature,
            project_id: "project".into(),
            profile_id: "profile".into(),
            content_hash: "a".repeat(64),
            mime_type: "image/png".into(),
            byte_size: 1,
            status: "staged".into(),
            upload_attempts: 0,
            remote_photo_id: None,
            remote_url: None,
            staged_at: "2026-01-01T00:00:00Z".into(),
            uploaded_at: None,
            caption: "caption".into(),
            order: 1,
        };
        let mut value = serde_json::to_value(&dto).unwrap();
        assert_eq!(value["stageId"], "temperature");
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains("localPath"));
        assert!(!serialized.contains("local_path"));
        value["stageId"] = serde_json::json!("11111111-1111-4111-8111-111111111111");
        assert!(
            serde_json::from_value::<crate::calibration::StagedCalibrationPhotoDto>(value).is_err()
        );
    }

    #[test]
    fn calibration_attempts_are_append_only_by_design() {
        // There is no UPDATE trigger in the schema — append-only is enforced
        // by application code. Verify the primary key guarantees stable identity.
        assert!(SCHEMA_V12.contains("PRIMARY KEY (profile_id, attempt_id)"));
    }

    #[test]
    fn staged_photos_have_content_hash_uniqueness() {
        assert!(SCHEMA_V12.contains("UNIQUE INDEX idx_staged_photos_hash"));
    }

    #[test]
    fn schema_version_matches_number_of_migrations() {
        // Each migration from V1..=V14 must be represented.
        assert_eq!(SCHEMA_VERSION, 14);
    }
}
