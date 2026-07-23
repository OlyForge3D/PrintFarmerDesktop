//! Persistent SQLite-backed [`CatalogStore`].
//!
//! This is the authoritative on-disk catalog: logical models keyed by content
//! hash, their physical locations, and duplicate grouping, all in a WAL-mode
//! SQLite database using the schema in [`crate::schema`]. It is compiled only
//! when the `sqlite` feature is enabled, because the bundled SQLite driver
//! requires a C toolchain. The pure-Rust [`crate::catalog::InMemoryCatalog`]
//! mirrors the same semantics for toolchain-free development and is the
//! reference implementation these two stores are tested against.
//!
//! The [`CatalogStore`] trait is infallible by design (mirroring the in-memory
//! store), so genuine SQL faults on writes are treated as bugs and panic;
//! read paths degrade to empty results. A fallible store API is future work.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::catalog::{new_collection_id, normalize_tag};
use crate::catalog::{
    CatalogStore, Collection, LocationUpsert, LogicalModel, ModelLocation, StoredLocation, Tag,
};
use crate::model::{FileFingerprint, ModelFormat};
use crate::schema::{
    SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8,
    SCHEMA_VERSION,
};
use crate::sync::{
    self, ApplyPullBatchDto, ClaimedOutboundBatchDto, ConflictInputDto, ConflictResolution,
    DisposeFailedBatchDto, EnqueueOutboundOperationDto, EntityRevisionDto, FailOutboundBatchDto,
    OutboundFailureOutcome, OutboundOperationDto, OutboundState, ReconcileUncertainBatchDto,
    RemoteModelLinkDto, RemoteUploadStatus, SettleOutboundBatchDto, SettledOutboundBatchDto,
    SyncConflictDto, SyncEntityType, SyncStatusDto, SyncVisibility, UnknownOutcomeResolution,
};

/// A SQLite-backed catalog. Wraps one connection; use single-threaded per the
/// [`CatalogStore`] contract (reconciliation is sequential).
pub struct SqliteCatalog {
    conn: Connection,
}

impl SqliteCatalog {
    /// Open (or create) a catalog database at `path`, applying migrations.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// Open an ephemeral in-memory catalog, applying migrations. Used in tests.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        // WAL and FK enforcement are per-connection and must run outside a
        // transaction, so apply them before any migration.
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if version < SCHEMA_VERSION {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let migration = (|| {
                if version < 1 {
                    let schema_v1 = SCHEMA_V1
                        .lines()
                        .filter(|line| !line.trim_start().starts_with("PRAGMA"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    conn.execute_batch(&schema_v1)?;
                }
                if version < 2 {
                    conn.execute_batch(SCHEMA_V2)?;
                }
                if version < 3 {
                    conn.execute_batch(SCHEMA_V3)?;
                }
                if version < 4 {
                    conn.execute_batch(SCHEMA_V4)?;
                }
                if version < 5 {
                    conn.execute_batch(SCHEMA_V5)?;
                    migrate_v5_fencing(&conn)?;
                }
                if version < 6 {
                    conn.execute_batch(SCHEMA_V6)?;
                }
                if version < 7 {
                    conn.execute_batch(SCHEMA_V7)?;
                }
                if version < 8 {
                    conn.execute_batch(SCHEMA_V8)?;
                }
                conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
                conn.execute_batch("COMMIT")
            })();
            if let Err(error) = migration {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        Ok(Self { conn })
    }

    /// Record (or update the path of) a source root. The [`CatalogStore`] trait
    /// carries only a `root_id`, so [`Self::upsert_location`] auto-creates a
    /// placeholder root row; call this to store the real absolute path.
    pub fn ensure_root(&self, root_id: &str, path: &Path) {
        let now = now_ts();
        self.conn
            .execute(
                "INSERT INTO source_roots(id, path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at",
                params![root_id, path_to_str(path), now],
            )
            .expect("catalog write failed: ensure_root");
    }

    fn build_model(&self, hash: &str) -> Option<LogicalModel> {
        let (format, size): (String, i64) = self
            .conn
            .query_row(
                "SELECT format, size_bytes FROM models WHERE hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("catalog read failed: model")?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT root_id, path, root_relative, size_bytes, modified_unix_secs, available
                 FROM model_locations WHERE model_hash = ?1 ORDER BY path",
            )
            .expect("catalog read failed: locations prepare");
        let locations = stmt
            .query_map(params![hash], |row| {
                let size_bytes: i64 = row.get(3)?;
                let modified: Option<i64> = row.get(4)?;
                let available: i64 = row.get(5)?;
                let path: String = row.get(1)?;
                let root_relative: String = row.get(2)?;
                Ok(ModelLocation {
                    root_id: row.get(0)?,
                    path: PathBuf::from(path),
                    root_relative: PathBuf::from(root_relative),
                    fingerprint: FileFingerprint {
                        size: size_bytes as u64,
                        modified_unix_secs: modified,
                    },
                    available: available != 0,
                })
            })
            .expect("catalog read failed: locations query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("catalog read failed: locations collect");

        Some(LogicalModel {
            hash: hash.to_string(),
            format: format_from_db(&format),
            size: size as u64,
            locations,
        })
    }

    fn ensure_sync_profile(&self, profile_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO sync_profiles(profile_id) VALUES(?1)",
                params![profile_id],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    fn finish_batch<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
        match result {
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
            Ok(value) => match self.commit_batch() {
                Ok(()) => Ok(value),
                Err(error) => {
                    self.rollback_batch();
                    Err(error)
                }
            },
        }
    }

    fn outbound_by_id(
        &self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<Option<OutboundOperationDto>, String> {
        self.conn
            .query_row(
                "SELECT profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, base_revision, concurrency_token, state, attempt_count,
                        retry_eligible, retry_at, lease_until, last_error, created_at,
                        updated_at, acked_at, sequence, batch_id, batch_ordinal, lease_token,
                        batch_incarnation, attempt_token
                 FROM sync_outbox WHERE profile_id = ?1 AND operation_id = ?2",
                params![profile_id, operation_id],
                outbound_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn load_outbound_batch(
        &self,
        profile_id: &str,
        batch_id: &str,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, base_revision, concurrency_token, state, attempt_count,
                        retry_eligible, retry_at, lease_until, last_error, created_at,
                        updated_at, acked_at, sequence, batch_id, batch_ordinal, lease_token,
                        batch_incarnation, attempt_token
                 FROM sync_outbox WHERE profile_id = ?1 AND batch_id = ?2
                 ORDER BY batch_ordinal LIMIT 500",
            )
            .map_err(sql_error)?;
        let operations = stmt
            .query_map(params![profile_id, batch_id], outbound_from_row)
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(operations)
    }

    fn entity_by_remote(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        remote_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        self.conn
            .query_row(
                "SELECT profile_id, entity_type, local_id, remote_id, revision,
                        concurrency_token, tombstone, visibility, snapshot_json, updated_at
                 FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = ?2 AND remote_id = ?3",
                params![profile_id, entity_type.as_db(), remote_id],
                entity_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn upsert_entity_revision(
        &self,
        mapping: &EntityRevisionDto,
        journal_revision: u64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO sync_entities(
                    profile_id, entity_type, local_id, remote_id, revision,
                    concurrency_token, tombstone, visibility, snapshot_json, updated_at,
                    journal_revision)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(profile_id, entity_type, remote_id) DO UPDATE SET
                    local_id = excluded.local_id, revision = excluded.revision,
                    concurrency_token = excluded.concurrency_token,
                    tombstone = excluded.tombstone, visibility = excluded.visibility,
                    snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at,
                    journal_revision = excluded.journal_revision",
                params![
                    mapping.profile_id,
                    mapping.entity_type.as_db(),
                    mapping.local_id,
                    mapping.remote_id,
                    mapping.revision as i64,
                    mapping.concurrency_token,
                    i64::from(mapping.tombstone),
                    mapping.visibility.as_db(),
                    optional_json(&mapping.snapshot)?,
                    mapping.updated_at,
                    journal_revision as i64,
                ],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    fn remove_materialized_membership(
        &self,
        profile_id: &str,
        mapping: &EntityRevisionDto,
    ) -> Result<(), String> {
        let Some(snapshot) = mapping.snapshot.clone() else {
            return Ok(());
        };
        let snapshot: sync::MembershipSnapshotDto = serde_json::from_value(snapshot)
            .map_err(|error| format!("invalid membership snapshot: {error}"))?;
        let collection_id: Option<String> = self
            .conn
            .query_row(
                "SELECT local_id FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = 'ModelCollection' AND remote_id = ?2",
                params![profile_id, snapshot.collection_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?
            .flatten();
        let model_hash: Option<String> = self
            .conn
            .query_row(
                "SELECT local_model_hash FROM remote_model_links
                 WHERE profile_id = ?1 AND remote_model_id = ?2",
                params![profile_id, snapshot.model_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if let (Some(collection_id), Some(model_hash)) = (collection_id, model_hash) {
            self.conn
                .execute(
                    "DELETE FROM collection_models WHERE collection_id = ?1 AND model_hash = ?2",
                    params![collection_id, model_hash],
                )
                .map_err(sql_error)?;
        }
        Ok(())
    }

    fn materialize_memberships(&self, profile_id: &str) -> Result<(), String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT snapshot_json FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = 'ModelCollectionMembership'
                   AND tombstone = 0 AND snapshot_json IS NOT NULL",
            )
            .map_err(sql_error)?;
        let snapshots = stmt
            .query_map(params![profile_id], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        drop(stmt);
        for value in snapshots {
            let snapshot: sync::MembershipSnapshotDto = serde_json::from_str(&value)
                .map_err(|error| format!("invalid persisted membership snapshot: {error}"))?;
            self.materialize_membership_snapshot(profile_id, &snapshot)?;
        }
        Ok(())
    }

    fn materialize_membership_snapshot(
        &self,
        profile_id: &str,
        snapshot: &sync::MembershipSnapshotDto,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO collection_models(collection_id, model_hash)
                     SELECT collection.local_id, link.local_model_hash
                     FROM sync_entities collection
                     JOIN remote_model_links link
                       ON link.profile_id = collection.profile_id
                      AND link.remote_model_id = ?3
                     JOIN models model ON model.hash = link.local_model_hash
                     JOIN collections local_collection ON local_collection.id = collection.local_id
                     WHERE collection.profile_id = ?1
                       AND collection.entity_type = 'ModelCollection'
                       AND collection.remote_id = ?2 AND collection.tombstone = 0
                       AND collection.local_id IS NOT NULL",
                params![profile_id, snapshot.collection_id, snapshot.model_id],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    fn materialize_pull(
        &self,
        batch: &ApplyPullBatchDto,
        previous: &[Option<EntityRevisionDto>],
    ) -> Result<(), String> {
        for entity in &batch.entities {
            let mapping = self
                .entity_by_remote(&batch.profile_id, entity.entity_type, &entity.remote_id)?
                .ok_or_else(|| "materialized sync entity is missing".to_string())?;
            match entity.entity_type {
                SyncEntityType::ModelCollection => {
                    let Some(local_id) = mapping.local_id.as_deref() else {
                        continue;
                    };
                    if mapping.tombstone {
                        self.conn
                            .execute(
                                "DELETE FROM collections
                                 WHERE id = ?1 AND sync_profile_id = ?2 AND sync_remote_id = ?3",
                                params![local_id, batch.profile_id, mapping.remote_id],
                            )
                            .map_err(sql_error)?;
                    } else {
                        let provenance: Option<Option<String>> = self
                            .conn
                            .query_row(
                                "SELECT sync_profile_id FROM collections WHERE id = ?1",
                                params![local_id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(sql_error)?;
                        if provenance == Some(None) {
                            continue;
                        }
                        let snapshot: sync::CollectionSnapshotDto = serde_json::from_value(
                            mapping
                                .snapshot
                                .ok_or_else(|| "collection snapshot is missing".to_string())?,
                        )
                        .map_err(|error| format!("invalid collection snapshot: {error}"))?;
                        self.conn
                            .execute(
                                "INSERT INTO collections(
                                    id, name, shared_to_farm, created_at, updated_at,
                                    sync_profile_id, sync_remote_id, sync_owner_user_id,
                                    sync_visibility, sync_read_only)
                                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                                 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                    shared_to_farm = excluded.shared_to_farm,
                                    updated_at = excluded.updated_at,
                                    sync_profile_id = excluded.sync_profile_id,
                                    sync_remote_id = excluded.sync_remote_id,
                                    sync_owner_user_id = excluded.sync_owner_user_id,
                                    sync_visibility = excluded.sync_visibility,
                                    sync_read_only = excluded.sync_read_only",
                                params![
                                    local_id,
                                    snapshot.name,
                                    i64::from(snapshot.is_shared),
                                    snapshot.created_at,
                                    snapshot.updated_at,
                                    batch.profile_id,
                                    mapping.remote_id,
                                    snapshot.owner_user_id,
                                    mapping.visibility.as_db(),
                                    i64::from(mapping.visibility == SyncVisibility::Shared)
                                ],
                            )
                            .map_err(sql_error)?;
                    }
                }
                SyncEntityType::Tag => {
                    let Some(local_id) = mapping.local_id.as_deref() else {
                        continue;
                    };
                    if mapping.tombstone {
                        self.conn
                            .execute(
                                "DELETE FROM tags
                                 WHERE id = ?1 AND sync_profile_id = ?2 AND sync_remote_id = ?3",
                                params![local_id, batch.profile_id, mapping.remote_id],
                            )
                            .map_err(sql_error)?;
                    } else {
                        let provenance: Option<Option<String>> = self
                            .conn
                            .query_row(
                                "SELECT sync_profile_id FROM tags WHERE id = ?1",
                                params![local_id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(sql_error)?;
                        if provenance == Some(None) {
                            continue;
                        }
                        let snapshot: sync::TagSnapshotDto = serde_json::from_value(
                            mapping
                                .snapshot
                                .ok_or_else(|| "tag snapshot is missing".to_string())?,
                        )
                        .map_err(|error| format!("invalid tag snapshot: {error}"))?;
                        self.conn
                            .execute(
                                "INSERT INTO tags(
                                    id, name, sync_profile_id, sync_remote_id,
                                    sync_visibility, sync_read_only)
                                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                                 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                    sync_profile_id = excluded.sync_profile_id,
                                    sync_remote_id = excluded.sync_remote_id,
                                    sync_visibility = excluded.sync_visibility,
                                    sync_read_only = excluded.sync_read_only",
                                params![
                                    local_id,
                                    snapshot.name,
                                    batch.profile_id,
                                    mapping.remote_id,
                                    mapping.visibility.as_db(),
                                    i64::from(mapping.visibility == SyncVisibility::Shared)
                                ],
                            )
                            .map_err(sql_error)?;
                    }
                }
                SyncEntityType::ModelCollectionMembership => {}
            }
        }
        for old in previous
            .iter()
            .flatten()
            .filter(|mapping| mapping.entity_type == SyncEntityType::ModelCollectionMembership)
        {
            self.remove_materialized_membership(&batch.profile_id, old)?;
        }
        for entity in batch.entities.iter().filter(|entity| {
            entity.entity_type == SyncEntityType::ModelCollectionMembership && !entity.tombstone
        }) {
            let snapshot: sync::MembershipSnapshotDto = serde_json::from_value(
                entity
                    .snapshot
                    .clone()
                    .ok_or_else(|| "membership snapshot is missing".to_string())?,
            )
            .map_err(|error| format!("invalid membership snapshot: {error}"))?;
            self.materialize_membership_snapshot(&batch.profile_id, &snapshot)?;
        }
        Ok(())
    }

    fn dispose_failed_batch_inner(
        &self,
        disposition: &DisposeFailedBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        let existing = self.load_outbound_batch(&disposition.profile_id, &disposition.batch_id)?;
        if existing.is_empty()
            || existing.iter().any(|operation| {
                operation.batch_incarnation != disposition.batch_incarnation
                    || operation.attempt_token.as_deref()
                        != Some(&disposition.expected_attempt_token)
                    || operation.state != OutboundState::Failed
            })
        {
            return Err("only a wholly failed batch can be disposed".to_string());
        }
        let unresolved: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(
                SELECT 1 FROM sync_conflicts
                WHERE profile_id = ?1 AND batch_id = ?2 AND batch_incarnation = ?3
                  AND resolved_at IS NULL)",
                params![
                    disposition.profile_id,
                    disposition.batch_id,
                    disposition.batch_incarnation
                ],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if unresolved {
            return Err("failed batch still has unresolved conflicts".to_string());
        }
        let replacements: std::collections::HashMap<_, _> = disposition
            .operations
            .iter()
            .map(|entry| (entry.operation_id.as_str(), entry))
            .collect();
        if disposition.disposition == sync::FailedBatchDisposition::Requeue
            && (replacements.len() != existing.len()
                || existing
                    .iter()
                    .any(|operation| !replacements.contains_key(operation.operation_id.as_str())))
        {
            return Err("requeue disposition must cover every operation in the batch".to_string());
        }
        for operation in &existing {
            let (state, retry_eligible, acked_at, last_error) = match disposition.disposition {
                sync::FailedBatchDisposition::Requeue => ("pending", 1_i64, None, None),
                sync::FailedBatchDisposition::Acked => {
                    ("acked", 0_i64, Some(disposition.disposed_at), None)
                }
                sync::FailedBatchDisposition::Discard => (
                    "acked",
                    0_i64,
                    Some(disposition.disposed_at),
                    Some("discarded after conflict resolution"),
                ),
            };
            let replacement = replacements.get(operation.operation_id.as_str());
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = ?4, retry_eligible = ?5,
                        base_revision = COALESCE(?6, base_revision),
                        concurrency_token = COALESCE(?7, concurrency_token),
                        retry_at = NULL, lease_until = NULL, lease_token = NULL,
                        updated_at = ?8, acked_at = ?9, last_error = ?10
                     WHERE profile_id = ?1 AND batch_id = ?2 AND operation_id = ?3
                       AND state = 'failed'",
                    params![
                        disposition.profile_id,
                        disposition.batch_id,
                        operation.operation_id,
                        state,
                        retry_eligible,
                        replacement
                            .and_then(|entry| entry.base_revision)
                            .map(|revision| revision as i64),
                        replacement.and_then(|entry| entry.concurrency_token.as_deref()),
                        disposition.disposed_at,
                        acked_at,
                        last_error,
                    ],
                )
                .map_err(sql_error)?;
        }
        self.load_outbound_batch(&disposition.profile_id, &disposition.batch_id)
    }

    fn insert_conflict(
        &self,
        profile_id: &str,
        input: &ConflictInputDto,
    ) -> Result<SyncConflictDto, String> {
        self.insert_conflict_associated(profile_id, input, None, None, None, None)
    }

    fn insert_conflict_associated(
        &self,
        profile_id: &str,
        input: &ConflictInputDto,
        batch_id: Option<&str>,
        operation_id: Option<&str>,
        batch_incarnation: Option<&str>,
        attempt_token: Option<&str>,
    ) -> Result<SyncConflictDto, String> {
        let incoming = SyncConflictDto {
            profile_id: profile_id.to_string(),
            conflict_id: input.conflict_id.clone(),
            entity_type: input.entity_type,
            entity_id: input.entity_id.clone(),
            batch_id: batch_id.map(str::to_string),
            operation_id: operation_id.map(str::to_string),
            batch_incarnation: batch_incarnation.map(str::to_string),
            attempt_token: attempt_token.map(str::to_string),
            local_payload: input.local_payload.clone(),
            server_payload: input.server_payload.clone(),
            submitted_payload: input.submitted_payload.clone(),
            reason: input.reason.clone(),
            server_revision: input.server_revision,
            created_at: input.created_at,
            resolved_at: None,
            resolution: None,
        };
        if let Some(existing) = self
            .conn
            .query_row(
                "SELECT profile_id, conflict_id, entity_type, entity_id,
                        local_payload_json, server_payload_json, submitted_payload_json,
                        reason, server_revision, created_at, resolved_at, resolution,
                        batch_id, operation_id, batch_incarnation, attempt_token
                 FROM sync_conflicts WHERE profile_id = ?1 AND conflict_id = ?2",
                params![profile_id, input.conflict_id],
                conflict_from_row,
            )
            .optional()
            .map_err(sql_error)?
        {
            let same_content = existing.entity_type == incoming.entity_type
                && existing.entity_id == incoming.entity_id
                && existing.batch_id == incoming.batch_id
                && existing.operation_id == incoming.operation_id
                && existing.batch_incarnation == incoming.batch_incarnation
                && existing.attempt_token == incoming.attempt_token
                && existing.local_payload == incoming.local_payload
                && existing.server_payload == incoming.server_payload
                && existing.submitted_payload == incoming.submitted_payload
                && existing.reason == incoming.reason
                && existing.server_revision == incoming.server_revision
                && existing.created_at == incoming.created_at;
            return if same_content {
                Ok(existing)
            } else {
                Err(format!(
                    "conflictId {} has different persisted content",
                    input.conflict_id
                ))
            };
        }
        self.conn
            .execute(
                "INSERT INTO sync_conflicts(
                    profile_id, conflict_id, entity_type, entity_id, local_payload_json,
                    server_payload_json, submitted_payload_json, reason, server_revision,
                    created_at, resolved_at, resolution, batch_id, operation_id,
                    batch_incarnation, attempt_token)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL,
                        ?11, ?12, ?13, ?14)",
                params![
                    profile_id,
                    input.conflict_id,
                    input.entity_type.as_db(),
                    input.entity_id,
                    optional_json(&input.local_payload)?,
                    optional_json(&input.server_payload)?,
                    optional_json(&input.submitted_payload)?,
                    input.reason,
                    input.server_revision as i64,
                    input.created_at,
                    batch_id,
                    operation_id,
                    batch_incarnation,
                    attempt_token,
                ],
            )
            .map_err(sql_error)?;
        Ok(incoming)
    }
}

impl CatalogStore for SqliteCatalog {
    fn begin_batch(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| format!("failed to begin catalog batch: {error}"))
    }

    fn commit_batch(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("COMMIT")
            .map_err(|error| format!("failed to commit catalog batch: {error}"))
    }

    fn rollback_batch(&mut self) {
        let _ = self.conn.execute_batch("ROLLBACK");
    }

    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation> {
        self.conn
            .query_row(
                "SELECT model_hash, size_bytes, modified_unix_secs, available
                 FROM model_locations WHERE root_id = ?1 AND path = ?2",
                params![root_id, path_to_str(path)],
                |row| {
                    let size_bytes: i64 = row.get(1)?;
                    let modified: Option<i64> = row.get(2)?;
                    let available: i64 = row.get(3)?;
                    Ok(StoredLocation {
                        hash: row.get(0)?,
                        fingerprint: FileFingerprint {
                            size: size_bytes as u64,
                            modified_unix_secs: modified,
                        },
                        available: available != 0,
                    })
                },
            )
            .optional()
            .expect("catalog read failed: get_location")
    }

    fn upsert_location(&mut self, upsert: LocationUpsert) {
        let now = now_ts();
        let prev_hash = self
            .get_location(&upsert.root_id, &upsert.path)
            .map(|s| s.hash);

        // Ensure the referenced root and model rows exist so the foreign keys
        // hold. A location's root may not have been registered with its real
        // path yet; seed a placeholder that ensure_root can later correct.
        self.conn
            .execute(
                "INSERT OR IGNORE INTO source_roots(id, path, created_at, updated_at)
                 VALUES (?1, ?1, ?2, ?2)",
                params![upsert.root_id, now],
            )
            .expect("catalog write failed: seed root");
        self.conn
            .execute(
                "INSERT OR IGNORE INTO models(hash, format, size_bytes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![
                    upsert.hash,
                    format_to_db(upsert.format),
                    upsert.size as i64,
                    now
                ],
            )
            .expect("catalog write failed: insert model");

        self.conn
            .execute(
                "INSERT INTO model_locations(
                     root_id, path, root_relative, model_hash,
                     size_bytes, modified_unix_secs, available, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
                 ON CONFLICT(root_id, path) DO UPDATE SET
                     root_relative = excluded.root_relative,
                     model_hash = excluded.model_hash,
                     size_bytes = excluded.size_bytes,
                     modified_unix_secs = excluded.modified_unix_secs,
                     available = 1,
                     last_seen_at = excluded.last_seen_at",
                params![
                    upsert.root_id,
                    path_to_str(&upsert.path),
                    path_to_str(&upsert.root_relative),
                    upsert.hash,
                    upsert.fingerprint.size as i64,
                    upsert.fingerprint.modified_unix_secs,
                    now,
                ],
            )
            .expect("catalog write failed: upsert location");

        // If the location moved to a different model, drop the old model when it
        // has no remaining locations, matching the in-memory store's behavior.
        if let Some(prev) = prev_hash {
            if prev != upsert.hash {
                self.conn
                    .execute(
                        "DELETE FROM models WHERE hash = ?1
                         AND NOT EXISTS (SELECT 1 FROM model_locations WHERE model_hash = ?1)",
                        params![prev],
                    )
                    .expect("catalog write failed: prune orphan model");
            }
        }
    }

    fn set_available(&mut self, root_id: &str, path: &Path, available: bool) {
        self.conn
            .execute(
                "UPDATE model_locations SET available = ?3 WHERE root_id = ?1 AND path = ?2",
                params![root_id, path_to_str(path), i64::from(available)],
            )
            .expect("catalog write failed: set_available");
    }

    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM model_locations WHERE root_id = ?1")
            .expect("catalog read failed: paths_for_root prepare");
        stmt.query_map(params![root_id], |row| {
            let path: String = row.get(0)?;
            Ok(PathBuf::from(path))
        })
        .expect("catalog read failed: paths_for_root query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: paths_for_root collect")
    }

    fn model(&self, hash: &str) -> Option<LogicalModel> {
        self.build_model(hash)
    }

    fn models(&self) -> Vec<LogicalModel> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash FROM models ORDER BY hash")
            .expect("catalog read failed: models prepare");
        let hashes: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("catalog read failed: models query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("catalog read failed: models collect");
        hashes
            .into_iter()
            .filter_map(|h| self.build_model(&h))
            .collect()
    }

    fn all_tags(&self) -> Vec<Tag> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name FROM tags ORDER BY LOWER(name)")
            .expect("catalog read failed: tags prepare");
        stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .expect("catalog read failed: tags query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: tags collect")
    }

    fn tags_for_model(&self, hash: &str) -> Vec<Tag> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT t.id, t.name FROM tags t \
                 JOIN model_tags mt ON mt.tag_id = t.id \
                 WHERE mt.model_hash = ?1 ORDER BY LOWER(t.name)",
            )
            .expect("catalog read failed: model tags prepare");
        stmt.query_map(params![hash], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .expect("catalog read failed: model tags query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: model tags collect")
    }

    fn add_model_tag(&mut self, hash: &str, name: &str) -> Option<Tag> {
        // Only tag models the catalog actually knows about (FK safety).
        let known: bool = self
            .conn
            .query_row(
                "SELECT 1 FROM models WHERE hash = ?1",
                params![hash],
                |_| Ok(()),
            )
            .optional()
            .expect("catalog read failed: model exists")
            .is_some();
        if !known {
            return None;
        }
        let tag = normalize_tag(name)?;
        self.conn
            .execute(
                "INSERT INTO tags(id, name) VALUES(?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                params![tag.id, tag.name],
            )
            .expect("catalog write failed: upsert tag");
        self.conn
            .execute(
                "INSERT OR IGNORE INTO model_tags(model_hash, tag_id) VALUES(?1, ?2)",
                params![hash, tag.id],
            )
            .expect("catalog write failed: assign tag");
        Some(tag)
    }

    fn remove_model_tag(&mut self, hash: &str, tag_id: &str) {
        self.conn
            .execute(
                "DELETE FROM model_tags WHERE model_hash = ?1 AND tag_id = ?2",
                params![hash, tag_id],
            )
            .expect("catalog write failed: unassign tag");
        // Prune the tag once nothing references it anymore.
        self.conn
            .execute(
                "DELETE FROM tags WHERE id = ?1 \
                 AND NOT EXISTS (SELECT 1 FROM model_tags WHERE tag_id = ?1)",
                params![tag_id],
            )
            .expect("catalog write failed: prune tag");
    }

    fn all_collections(&self) -> Vec<Collection> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT c.id, c.name, c.shared_to_farm, \
                 (SELECT COUNT(*) FROM collection_models cm WHERE cm.collection_id = c.id) \
                 FROM collections c ORDER BY LOWER(c.name)",
            )
            .expect("catalog read failed: collections prepare");
        stmt.query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                shared_to_farm: row.get::<_, i64>(2)? != 0,
                member_count: row.get::<_, i64>(3)? as usize,
            })
        })
        .expect("catalog read failed: collections query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: collections collect")
    }

    fn collections_for_model(&self, hash: &str) -> Vec<Collection> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT c.id, c.name, c.shared_to_farm, \
                 (SELECT COUNT(*) FROM collection_models cm2 WHERE cm2.collection_id = c.id) \
                 FROM collections c \
                 JOIN collection_models cm ON cm.collection_id = c.id \
                 WHERE cm.model_hash = ?1 ORDER BY LOWER(c.name)",
            )
            .expect("catalog read failed: model collections prepare");
        stmt.query_map(params![hash], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                shared_to_farm: row.get::<_, i64>(2)? != 0,
                member_count: row.get::<_, i64>(3)? as usize,
            })
        })
        .expect("catalog read failed: model collections query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: model collections collect")
    }

    fn create_collection(&mut self, name: &str) -> Option<Collection> {
        let display = name.trim();
        if display.is_empty() {
            return None;
        }

        let id = new_collection_id();
        let ts = now_ts();
        self.conn
            .execute(
                "INSERT INTO collections(id, name, shared_to_farm, created_at, updated_at) \
                 VALUES(?1, ?2, 0, ?3, ?3)",
                params![id, display, ts],
            )
            .expect("catalog write failed: create collection");
        Some(Collection {
            id,
            name: display.to_string(),
            shared_to_farm: false,
            member_count: 0,
        })
    }

    fn update_collection(
        &mut self,
        id: &str,
        name: &str,
        shared_to_farm: bool,
    ) -> Option<Collection> {
        let display = name.trim();
        if display.is_empty() {
            return None;
        }
        let changed = self
            .conn
            .execute(
                "UPDATE collections SET name = ?2, shared_to_farm = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![id, display, i64::from(shared_to_farm), now_ts()],
            )
            .expect("catalog write failed: update collection");
        if changed == 0 {
            return None;
        }
        self.all_collections()
            .into_iter()
            .find(|collection| collection.id == id)
    }

    fn delete_collection(&mut self, id: &str) {
        // collection_models cascades via its FK, but delete explicitly in case
        // foreign keys are not enforced on this connection.
        self.conn
            .execute(
                "DELETE FROM collection_models WHERE collection_id = ?1",
                params![id],
            )
            .expect("catalog write failed: delete memberships");
        self.conn
            .execute("DELETE FROM collections WHERE id = ?1", params![id])
            .expect("catalog write failed: delete collection");
    }

    fn add_model_to_collection(&mut self, id: &str, hash: &str) -> bool {
        let both_exist: bool = self
            .conn
            .query_row(
                "SELECT 1 FROM collections c, models m \
                 WHERE c.id = ?1 AND m.hash = ?2",
                params![id, hash],
                |_| Ok(()),
            )
            .optional()
            .expect("catalog read failed: collection/model exists")
            .is_some();
        if !both_exist {
            return false;
        }
        self.conn
            .execute(
                "INSERT OR IGNORE INTO collection_models(collection_id, model_hash) \
                 VALUES(?1, ?2)",
                params![id, hash],
            )
            .expect("catalog write failed: add to collection");
        true
    }

    fn remove_model_from_collection(&mut self, id: &str, hash: &str) {
        self.conn
            .execute(
                "DELETE FROM collection_models \
                 WHERE collection_id = ?1 AND model_hash = ?2",
                params![id, hash],
            )
            .expect("catalog write failed: remove from collection");
    }

    fn sync_status(&self, profile_id: &str) -> Result<SyncStatusDto, String> {
        sync::validate_profile(profile_id)?;
        self.conn
            .query_row(
                "SELECT profile_id, cursor, server_revision, checkpoint_generation,
                        last_pulled_at, last_pushed_at, updated_at
                 FROM sync_profiles WHERE profile_id = ?1",
                params![profile_id],
                |row| {
                    Ok(SyncStatusDto {
                        profile_id: row.get(0)?,
                        cursor: row.get(1)?,
                        server_revision: row.get::<_, i64>(2)? as u64,
                        checkpoint_generation: row.get::<_, i64>(3)? as u64,
                        last_pulled_at: row.get(4)?,
                        last_pushed_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map(|status| status.unwrap_or_else(|| SyncStatusDto::empty(profile_id)))
            .map_err(sql_error)
    }

    fn bind_sync_profile(
        &mut self,
        profile_id: &str,
        binding: &str,
        now: i64,
    ) -> Result<SyncStatusDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("profileBinding", binding)?;
        sync::validate_timestamp("now", now)?;
        let owns_batch = self.conn.is_autocommit();
        if owns_batch {
            self.begin_batch()?;
        }
        let result = (|| {
            let current: Option<(Option<String>, i64)> = self
                .conn
                .query_row(
                    "SELECT profile_binding, binding_cas_revision
                     FROM sync_profiles WHERE profile_id = ?1",
                    params![profile_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(sql_error)?;
            if current.as_ref().is_some_and(|(value, cas_revision)| {
                value.as_deref().is_some_and(|value| {
                    value != binding
                        && !(*cas_revision == 0
                            && value.len() == 66
                            && value.ends_with(":1")
                            && binding.ends_with(":1"))
                })
            }) {
                return Err("sync profile binding replacement requires CAS".to_string());
            }
            self.ensure_sync_profile(profile_id)?;
            self.conn
                .execute(
                    "UPDATE sync_profiles SET profile_binding = ?2, updated_at = ?3,
                        binding_cas_revision = MAX(binding_cas_revision, 1)
                     WHERE profile_id = ?1",
                    params![profile_id, binding, now],
                )
                .map_err(sql_error)?;
            self.sync_status(profile_id)
        })();
        if owns_batch {
            self.finish_batch(result)
        } else {
            result
        }
    }

    fn replace_sync_profile_binding(
        &mut self,
        profile_id: &str,
        expected_binding: &str,
        new_binding: &str,
        now: i64,
    ) -> Result<SyncStatusDto, String> {
        self.validate_sync_profile_binding(profile_id, expected_binding)?;
        sync::validate_identifier("newProfileBinding", new_binding)?;
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "DELETE FROM collections WHERE sync_profile_id = ?1",
                    params![profile_id],
                )
                .map_err(sql_error)?;
            self.conn
                .execute(
                    "DELETE FROM tags WHERE sync_profile_id = ?1",
                    params![profile_id],
                )
                .map_err(sql_error)?;
            self.conn
                .execute(
                    "DELETE FROM sync_profiles WHERE profile_id = ?1 AND profile_binding = ?2",
                    params![profile_id, expected_binding],
                )
                .map_err(sql_error)?;
            self.ensure_sync_profile(profile_id)?;
            self.conn
                .execute(
                    "UPDATE sync_profiles SET profile_binding = ?2, updated_at = ?3,
                        binding_cas_revision = 1
                     WHERE profile_id = ?1",
                    params![profile_id, new_binding, now],
                )
                .map_err(sql_error)?;
            self.sync_status(profile_id)
        })();
        self.finish_batch(result)
    }

    fn validate_sync_profile_binding(&self, profile_id: &str, binding: &str) -> Result<(), String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("profileBinding", binding)?;
        let matches: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_profiles
                 WHERE profile_id = ?1 AND profile_binding = ?2)",
                params![profile_id, binding],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if matches {
            Ok(())
        } else {
            Err("stale or unbound sync profile binding".to_string())
        }
    }

    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String> {
        sync::validate_pull_batch(&batch)?;
        self.begin_batch()?;
        let result = (|| {
            self.ensure_sync_profile(&batch.profile_id)?;
            let current = self.sync_status(&batch.profile_id)?;
            if current.checkpoint_generation != batch.expected_checkpoint_generation {
                return Err(
                    "stale pull checkpoint: expectedCheckpointGeneration does not match"
                        .to_string(),
                );
            }
            if current.checkpoint_generation == i64::MAX as u64 {
                return Err("checkpoint generation overflow".to_string());
            }
            if current.cursor != batch.expected_previous_cursor {
                return Err("stale pull cursor: expectedPreviousCursor does not match".to_string());
            }
            if batch.server_revision < current.server_revision {
                return Err("serverRevision must not move backwards".to_string());
            }
            let mut previous_entities = Vec::with_capacity(batch.entities.len());
            let mut accepted_entities = Vec::new();
            for entity in &batch.entities {
                let previous_journal: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT journal_revision FROM sync_entities
                         WHERE profile_id = ?1 AND entity_type = ?2 AND remote_id = ?3",
                        params![
                            batch.profile_id,
                            entity.entity_type.as_db(),
                            entity.remote_id
                        ],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(sql_error)?;
                if previous_journal
                    .is_some_and(|revision| revision as u64 >= entity.journal_revision)
                {
                    continue;
                }
                if let Some(local_id) = entity.local_id.as_deref() {
                    let operation_id: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT operation_id FROM sync_outbox
                             WHERE profile_id = ?1 AND entity_id = ?2 AND state <> 'acked'
                             ORDER BY sequence LIMIT 1",
                            params![batch.profile_id, local_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(sql_error)?;
                    if let Some(operation_id) = operation_id {
                        let pending = self
                            .outbound_by_id(&batch.profile_id, &operation_id)?
                            .ok_or_else(|| "pending conflict operation disappeared".to_string())?;
                        self.insert_conflict(
                            &batch.profile_id,
                            &ConflictInputDto {
                                conflict_id: sync::new_operation_token("pull-conflict"),
                                entity_type: entity.entity_type,
                                entity_id: local_id.to_string(),
                                local_payload: Some(pending.payload.clone()),
                                server_payload: entity.snapshot.clone(),
                                submitted_payload: Some(pending.payload),
                                reason: "remote change overlaps pending local work".to_string(),
                                server_revision: batch.server_revision,
                                created_at: batch.applied_at,
                            },
                        )?;
                        continue;
                    }
                }
                if let Some(local_id) = &entity.local_id {
                    let rebound: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT remote_id FROM sync_entities
                             WHERE profile_id = ?1 AND entity_type = ?2 AND local_id = ?3
                               AND remote_id <> ?4",
                            params![
                                batch.profile_id,
                                entity.entity_type.as_db(),
                                local_id,
                                entity.remote_id
                            ],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(sql_error)?;
                    if rebound.is_some() {
                        return Err(format!(
                            "localId {local_id} is already mapped to another remote entity"
                        ));
                    }
                }
                let incoming = EntityRevisionDto {
                    profile_id: batch.profile_id.clone(),
                    entity_type: entity.entity_type,
                    local_id: entity.local_id.clone(),
                    remote_id: entity.remote_id.clone(),
                    revision: entity.revision,
                    concurrency_token: entity.concurrency_token.clone(),
                    tombstone: entity.tombstone,
                    visibility: entity.visibility,
                    snapshot: entity.snapshot.clone(),
                    updated_at: batch.applied_at,
                };
                let existing = self.entity_by_remote(
                    &batch.profile_id,
                    entity.entity_type,
                    &entity.remote_id,
                )?;
                let merge_base = existing
                    .as_ref()
                    .filter(|mapping| !(mapping.tombstone && !entity.tombstone));
                let mapping = sync::merge_entity_revision(merge_base, incoming)?;
                self.upsert_entity_revision(&mapping, entity.journal_revision)?;
                previous_entities.push(existing);
                accepted_entities.push(entity.clone());
            }
            let mut effective_batch = batch.clone();
            effective_batch.entities = accepted_entities;
            self.materialize_pull(&effective_batch, &previous_entities)?;
            for conflict in &batch.conflicts {
                self.insert_conflict(&batch.profile_id, conflict)?;
            }
            self.conn
                .execute(
                    "UPDATE sync_profiles SET cursor = ?2, server_revision = ?3,
                        checkpoint_generation = checkpoint_generation + 1,
                        last_pulled_at = ?4, updated_at = ?4 WHERE profile_id = ?1",
                    params![
                        batch.profile_id,
                        batch.cursor,
                        batch.server_revision as i64,
                        batch.applied_at
                    ],
                )
                .map_err(sql_error)?;
            self.sync_status(&batch.profile_id)
        })();
        self.finish_batch(result)
    }

    fn link_remote_model(
        &mut self,
        link: RemoteModelLinkDto,
    ) -> Result<RemoteModelLinkDto, String> {
        sync::validate_remote_link(&link)?;
        self.ensure_sync_profile(&link.profile_id)?;
        let link = self
            .remote_model_link(&link.profile_id, &link.local_model_hash)?
            .map_or_else(
                || Ok(link.clone()),
                |existing| sync::merge_remote_link(&existing, &link),
            )?;
        if link.upload_status == RemoteUploadStatus::Uploaded && link.uploaded_at.is_none() {
            return Err("uploaded status requires uploadedAt".to_string());
        }
        self.conn
            .execute(
                "INSERT INTO remote_model_links(
                    profile_id, local_model_hash, remote_model_id, client_upload_id,
                    etag, upload_status, created_at, updated_at, uploaded_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(profile_id, local_model_hash) DO UPDATE SET
                    etag = excluded.etag,
                    upload_status = excluded.upload_status,
                    updated_at = excluded.updated_at,
                    uploaded_at = excluded.uploaded_at",
                params![
                    link.profile_id,
                    link.local_model_hash,
                    link.remote_model_id,
                    link.client_upload_id,
                    link.etag,
                    link.upload_status.as_db(),
                    link.created_at,
                    link.updated_at,
                    link.uploaded_at,
                ],
            )
            .map_err(|error| {
                if matches!(error, rusqlite::Error::SqliteFailure(_, _)) {
                    "remoteModelId/clientUploadId is already linked in this profile".to_string()
                } else {
                    sql_error(error)
                }
            })?;
        self.materialize_memberships(&link.profile_id)?;
        Ok(link)
    }

    fn remote_model_link(
        &self,
        profile_id: &str,
        local_model_hash: &str,
    ) -> Result<Option<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_local_hash(local_model_hash)?;
        self.conn
            .query_row(
                "SELECT profile_id, local_model_hash, remote_model_id, client_upload_id,
                        etag, upload_status, created_at, updated_at, uploaded_at
                 FROM remote_model_links WHERE profile_id = ?1 AND local_model_hash = ?2",
                params![profile_id, local_model_hash],
                remote_link_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn remote_model_links(
        &self,
        profile_id: &str,
        limit: usize,
    ) -> Result<Vec<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT profile_id, local_model_hash, remote_model_id, client_upload_id,
                        etag, upload_status, created_at, updated_at, uploaded_at
                 FROM remote_model_links WHERE profile_id = ?1
                 ORDER BY local_model_hash LIMIT ?2",
            )
            .map_err(sql_error)?;
        let links = stmt
            .query_map(params![profile_id, limit as i64], remote_link_from_row)
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(links)
    }

    fn entity_revisions(
        &self,
        profile_id: &str,
        entity_type: Option<SyncEntityType>,
        limit: usize,
    ) -> Result<Vec<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let sql = "SELECT profile_id, entity_type, local_id, remote_id, revision,
                          concurrency_token, tombstone, visibility, snapshot_json, updated_at
                   FROM sync_entities WHERE profile_id = ?1";
        let entities = match entity_type {
            Some(entity_type) => {
                let mut stmt = self
                    .conn
                    .prepare(&format!(
                        "{sql} AND entity_type = ?2 ORDER BY remote_id LIMIT ?3"
                    ))
                    .map_err(sql_error)?;
                let result = stmt
                    .query_map(
                        params![profile_id, entity_type.as_db(), limit as i64],
                        entity_from_row,
                    )
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)?;
                result
            }
            None => {
                let mut stmt = self
                    .conn
                    .prepare(&format!("{sql} ORDER BY entity_type, remote_id LIMIT ?2"))
                    .map_err(sql_error)?;
                let result = stmt
                    .query_map(params![profile_id, limit as i64], entity_from_row)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)?;
                result
            }
        };
        Ok(entities)
    }

    fn entity_revision_by_remote(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        remote_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("remoteId", remote_id)?;
        self.conn
            .query_row(
                "SELECT profile_id, entity_type, local_id, remote_id, revision,
                        concurrency_token, tombstone, visibility, snapshot_json, updated_at
                 FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = ?2 AND remote_id = ?3",
                params![profile_id, entity_type.as_db(), remote_id],
                entity_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn entity_revision_by_local(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        local_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("localId", local_id)?;
        self.conn
            .query_row(
                "SELECT profile_id, entity_type, local_id, remote_id, revision,
                        concurrency_token, tombstone, visibility, snapshot_json, updated_at
                 FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = ?2 AND local_id = ?3",
                params![profile_id, entity_type.as_db(), local_id],
                entity_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn membership_revision(
        &self,
        profile_id: &str,
        collection_remote_id: &str,
        model_remote_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        self.conn
            .query_row(
                "SELECT profile_id, entity_type, local_id, remote_id, revision,
                        concurrency_token, tombstone, visibility, snapshot_json, updated_at
                 FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = 'ModelCollectionMembership'
                   AND json_extract(snapshot_json, '$.collectionId') = ?2
                   AND json_extract(snapshot_json, '$.modelId') = ?3
                 LIMIT 1",
                params![profile_id, collection_remote_id, model_remote_id],
                entity_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn provision_entity_mapping(&mut self, mapping: EntityRevisionDto) -> Result<(), String> {
        self.ensure_sync_profile(&mapping.profile_id)?;
        self.upsert_entity_revision(&mapping, 0)
    }

    fn pending_membership_create(
        &self,
        profile_id: &str,
        collection_local_id: &str,
        model_hash: &str,
    ) -> Result<Option<OutboundOperationDto>, String> {
        self.conn
            .query_row(
                "SELECT profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, base_revision, concurrency_token, state, attempt_count,
                        retry_eligible, retry_at, lease_until, last_error, created_at,
                        updated_at, acked_at, sequence, batch_id, batch_ordinal, lease_token,
                        batch_incarnation, attempt_token
                 FROM sync_outbox
                 WHERE profile_id = ?1 AND entity_type = 'ModelCollectionMembership'
                   AND operation_kind = 'Create' AND state <> 'acked'
                   AND json_extract(payload_json, '$.collectionId') = ?2
                   AND json_extract(payload_json, '$.modelHash') = ?3
                 ORDER BY sequence LIMIT 1",
                params![profile_id, collection_local_id, model_hash],
                outbound_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn enqueue_outbound_operations(
        &mut self,
        profile_id: &str,
        batch_id: &str,
        operations: Vec<EnqueueOutboundOperationDto>,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_enqueue_batch(profile_id, &operations)?;
        sync::validate_identifier("batchId", batch_id)?;
        let owns_batch = self.conn.is_autocommit();
        if owns_batch {
            self.begin_batch()?;
        }
        let result = (|| {
            self.ensure_sync_profile(profile_id)?;
            let existing_batch = self.load_outbound_batch(profile_id, batch_id)?;
            if !existing_batch.is_empty() {
                if existing_batch.len() != operations.len()
                    || operations.iter().enumerate().any(|(ordinal, operation)| {
                        !sqlite_outbound_matches_input(
                            &existing_batch[ordinal],
                            batch_id,
                            ordinal as u32,
                            operation,
                        )
                    })
                {
                    return Err("batchId has different persisted content".to_string());
                }
                return Ok(existing_batch);
            }
            for operation in &operations {
                if self
                    .outbound_by_id(profile_id, &operation.operation_id)?
                    .is_some()
                {
                    return Err("operationId already belongs to another logical batch".to_string());
                }
            }
            let unresolved: bool = self
                .conn
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM sync_conflicts
                        WHERE profile_id = ?1 AND batch_id = ?2 AND resolved_at IS NULL)",
                    params![profile_id, batch_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if unresolved {
                return Err("batchId is still referenced by unresolved conflicts".to_string());
            }
            let batch_incarnation = sync::new_batch_incarnation();
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO sync_profile_sequences(profile_id, next_sequence)
                     VALUES(?1, 1)",
                    params![profile_id],
                )
                .map_err(sql_error)?;
            let mut queued = Vec::with_capacity(operations.len());
            for (ordinal, operation) in operations.into_iter().enumerate() {
                if let Some(existing) = self.outbound_by_id(profile_id, &operation.operation_id)? {
                    if !sqlite_outbound_matches_input(
                        &existing,
                        batch_id,
                        ordinal as u32,
                        &operation,
                    ) {
                        return Err(format!(
                            "operationId {} has different persisted content",
                            operation.operation_id
                        ));
                    }
                    queued.push(existing);
                    continue;
                }
                let sequence: i64 = self
                    .conn
                    .query_row(
                        "SELECT next_sequence FROM sync_profile_sequences WHERE profile_id = ?1",
                        params![profile_id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
                self.conn
                    .execute(
                        "UPDATE sync_profile_sequences SET next_sequence = next_sequence + 1
                         WHERE profile_id = ?1",
                        params![profile_id],
                    )
                    .map_err(sql_error)?;
                self.conn
                    .execute(
                        "INSERT INTO sync_outbox(
                            profile_id, operation_id, entity_type, operation_kind, entity_id,
                            payload_json, base_revision, concurrency_token, state, attempt_count,
                            retry_eligible, retry_at, lease_until, last_error, created_at,
                            updated_at, acked_at, sequence, batch_id, batch_ordinal, lease_token,
                            batch_incarnation, attempt_token)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0,
                                1, NULL, NULL, NULL, ?9, ?9, NULL, ?10, ?11, ?12, NULL,
                                ?13, NULL)",
                        params![
                            profile_id,
                            operation.operation_id,
                            operation.entity_type.as_db(),
                            operation.operation.as_db(),
                            operation.entity_id,
                            json_string(&operation.payload)?,
                            operation.base_revision.map(|revision| revision as i64),
                            operation.concurrency_token,
                            operation.created_at,
                            sequence,
                            batch_id,
                            ordinal as i64,
                            batch_incarnation,
                        ],
                    )
                    .map_err(sql_error)?;
                queued.push(
                    self.outbound_by_id(profile_id, &operation.operation_id)?
                        .expect("inserted outbox row exists"),
                );
            }
            let persisted_count: i64 = self
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_outbox
                     WHERE profile_id = ?1 AND batch_id = ?2",
                    params![profile_id, batch_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if persisted_count as usize != queued.len() {
                return Err("batchId has different persisted operation count".to_string());
            }
            Ok(queued)
        })();
        if owns_batch {
            self.finish_batch(result)
        } else {
            result
        }
    }

    fn outbound_operations(
        &self,
        profile_id: &str,
        states: &[OutboundState],
        limit: usize,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let state_filter = if states.is_empty() {
            "state IN ('pending','inFlight','uncertain','failed')".to_string()
        } else {
            format!(
                "state IN ({})",
                states
                    .iter()
                    .map(|state| format!("'{}'", state.as_db()))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, base_revision, concurrency_token, state, attempt_count,
                        retry_eligible, retry_at, lease_until, last_error, created_at,
                        updated_at, acked_at, sequence, batch_id, batch_ordinal, lease_token,
                        batch_incarnation, attempt_token
                 FROM sync_outbox WHERE profile_id = ?1 AND {state_filter}
                 ORDER BY sequence LIMIT ?2"
            ))
            .map_err(sql_error)?;
        let operations: Vec<_> = stmt
            .query_map(params![profile_id, limit as i64], outbound_from_row)
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(operations)
    }

    fn outbound_batch(
        &self,
        profile_id: &str,
        batch_id: &str,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("batchId", batch_id)?;
        self.load_outbound_batch(profile_id, batch_id)
    }

    fn claim_outbound_operations(
        &mut self,
        profile_id: &str,
        limit: usize,
        now: i64,
        lease_seconds: i64,
    ) -> Result<Option<ClaimedOutboundBatchDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let lease_until = sync::validate_lease(now, lease_seconds)?;
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = 'uncertain', retry_eligible = 0,
                        lease_until = NULL, lease_token = NULL, retry_at = NULL, updated_at = ?2
                     WHERE profile_id = ?1 AND state = 'inFlight'
                       AND lease_until <= ?2",
                    params![profile_id, now],
                )
                .map_err(sql_error)?;
            let batch_id: Option<String> = self
                .conn
                .query_row(
                    "SELECT batch_id FROM sync_outbox
                     WHERE profile_id = ?1
                       AND state IN ('pending','inFlight','uncertain','failed')
                     ORDER BY sequence LIMIT 1",
                    params![profile_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error)?;
            let Some(batch_id) = batch_id else {
                return Ok(None);
            };
            let (total, claimable): (i64, i64) = self
                .conn
                .query_row(
                    "SELECT COUNT(*),
                            SUM(CASE WHEN retry_eligible = 1
                                      AND (state = 'pending'
                                           OR (state = 'failed' AND retry_at IS NOT NULL
                                               AND retry_at <= ?3))
                                     THEN 1 ELSE 0 END)
                     FROM sync_outbox WHERE profile_id = ?1 AND batch_id = ?2",
                    params![profile_id, batch_id, now],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(sql_error)?;
            if claimable != total {
                return Ok(None);
            }
            if total as usize > limit || total as usize > sync::MAX_SYNC_BATCH {
                return Err("claim limit would split the next logical batch".to_string());
            }
            let lease_token = sync::new_lease_token();
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = 'inFlight',
                        attempt_count = attempt_count + 1, retry_at = NULL,
                        lease_until = ?3, lease_token = ?4, attempt_token = ?4, updated_at = ?5
                     WHERE profile_id = ?1 AND batch_id = ?2",
                    params![profile_id, batch_id, lease_until, lease_token, now],
                )
                .map_err(sql_error)?;
            let operations = self.load_outbound_batch(profile_id, &batch_id)?;
            Ok(Some(ClaimedOutboundBatchDto {
                profile_id: profile_id.to_string(),
                batch_id,
                batch_incarnation: operations[0].batch_incarnation.clone(),
                lease_token: lease_token.clone(),
                attempt_token: lease_token,
                lease_until,
                operations,
            }))
        })();
        self.finish_batch(result)
    }

    fn recover_outbound_operations(&mut self, profile_id: &str, now: i64) -> Result<usize, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_timestamp("now", now)?;
        self.conn
            .execute(
                "UPDATE sync_outbox SET state = 'uncertain', retry_eligible = 0,
                    lease_until = NULL, lease_token = NULL, retry_at = NULL, updated_at = ?2
                 WHERE profile_id = ?1 AND state = 'inFlight'
                   AND lease_until <= ?2",
                params![profile_id, now],
            )
            .map_err(sql_error)
    }

    fn fail_outbound_batch(
        &mut self,
        failure: FailOutboundBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_batch_failure(&failure)?;
        self.begin_batch()?;
        let result = (|| {
            let existing = self.load_outbound_batch(&failure.profile_id, &failure.batch_id)?;
            if existing.is_empty()
                || existing.iter().any(|operation| {
                    operation.batch_incarnation != failure.batch_incarnation
                        || operation.state != OutboundState::InFlight
                        || operation.lease_token.as_deref() != Some(&failure.lease_token)
                })
            {
                return Err("outbound batch is not owned by the active lease".to_string());
            }
            let (state, retry_eligible) = match failure.outcome {
                OutboundFailureOutcome::DefiniteTransient => ("failed", 1_i64),
                OutboundFailureOutcome::DefinitePermanent => ("failed", 0_i64),
                OutboundFailureOutcome::Ambiguous => ("uncertain", 0_i64),
            };
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = ?5, retry_eligible = ?6,
                        retry_at = ?7, lease_until = NULL, lease_token = NULL,
                        last_error = ?8, updated_at = ?9
                     WHERE profile_id = ?1 AND batch_id = ?2
                       AND batch_incarnation = ?3 AND lease_token = ?4
                       AND state = 'inFlight'",
                    params![
                        failure.profile_id,
                        failure.batch_id,
                        failure.batch_incarnation,
                        failure.lease_token,
                        state,
                        retry_eligible,
                        failure.retry_at,
                        failure.error,
                        failure.failed_at
                    ],
                )
                .map_err(sql_error)?;
            self.load_outbound_batch(&failure.profile_id, &failure.batch_id)
        })();
        self.finish_batch(result)
    }

    fn complete_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        batch_incarnation: &str,
        lease_token: &str,
        completed_at: i64,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
        sync::validate_identifier("batchIncarnation", batch_incarnation)?;
        sync::validate_identifier("leaseToken", lease_token)?;
        sync::validate_timestamp("completedAt", completed_at)?;
        let existing = self
            .outbound_by_id(profile_id, operation_id)?
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if self
            .load_outbound_batch(profile_id, &existing.batch_id)?
            .len()
            != 1
        {
            return Err("multi-operation batches require transactional settlement".to_string());
        }
        if existing.batch_incarnation != batch_incarnation
            || existing.state != OutboundState::InFlight
            || existing.lease_token.as_deref() != Some(lease_token)
        {
            return Err("operation is not owned by the active lease".to_string());
        }
        if completed_at < existing.updated_at {
            return Err("completedAt must not precede the claim timestamp".to_string());
        }
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = 'acked', retry_eligible = 0,
                        retry_at = NULL, lease_until = NULL, lease_token = NULL, last_error = NULL,
                        updated_at = ?3, acked_at = ?3
                     WHERE profile_id = ?1 AND operation_id = ?2 AND state = 'inFlight'
                       AND batch_incarnation = ?4 AND lease_token = ?5",
                    params![
                        profile_id,
                        operation_id,
                        completed_at,
                        batch_incarnation,
                        lease_token
                    ],
                )
                .map_err(sql_error)?;
            self.ensure_sync_profile(profile_id)?;
            self.conn
                .execute(
                    "UPDATE sync_profiles SET last_pushed_at = ?2, updated_at = ?2
                     WHERE profile_id = ?1",
                    params![profile_id, completed_at],
                )
                .map_err(sql_error)?;
            self.outbound_by_id(profile_id, operation_id)?
                .ok_or_else(|| "outbound operation not found".to_string())
        })();
        self.finish_batch(result)
    }

    #[allow(clippy::too_many_arguments)]
    fn fail_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        batch_incarnation: &str,
        lease_token: &str,
        error: &str,
        failed_at: i64,
        retry_at: Option<i64>,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
        sync::validate_identifier("batchIncarnation", batch_incarnation)?;
        sync::validate_identifier("leaseToken", lease_token)?;
        sync::validate_timestamp("failedAt", failed_at)?;
        if error.is_empty() || error.len() > sync::MAX_ERROR_BYTES {
            return Err(format!("error must be 1..={} bytes", sync::MAX_ERROR_BYTES));
        }
        if let Some(retry_at) = retry_at {
            sync::validate_timestamp("retryAt", retry_at)?;
            if retry_at < failed_at {
                return Err("retryAt must not precede failedAt".to_string());
            }
        }
        let existing = self
            .outbound_by_id(profile_id, operation_id)?
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if self
            .load_outbound_batch(profile_id, &existing.batch_id)?
            .len()
            != 1
        {
            return Err("multi-operation batches require transactional settlement".to_string());
        }
        if existing.batch_incarnation != batch_incarnation
            || existing.state != OutboundState::InFlight
            || existing.lease_token.as_deref() != Some(lease_token)
        {
            return Err("operation is not owned by the active lease".to_string());
        }
        if failed_at < existing.updated_at {
            return Err("failedAt must not precede the claim timestamp".to_string());
        }
        self.conn
            .execute(
                "UPDATE sync_outbox SET state = 'failed', retry_eligible = ?3,
                    retry_at = ?4, lease_until = NULL, lease_token = NULL,
                    last_error = ?5, updated_at = ?6
                 WHERE profile_id = ?1 AND operation_id = ?2 AND state = 'inFlight'
                   AND batch_incarnation = ?7 AND lease_token = ?8",
                params![
                    profile_id,
                    operation_id,
                    i64::from(retry_at.is_some()),
                    retry_at,
                    error,
                    failed_at,
                    batch_incarnation,
                    lease_token
                ],
            )
            .map_err(sql_error)?;
        self.outbound_by_id(profile_id, operation_id)?
            .ok_or_else(|| "outbound operation not found".to_string())
    }

    fn settle_outbound_batch(
        &mut self,
        settlement: SettleOutboundBatchDto,
    ) -> Result<SettledOutboundBatchDto, String> {
        sync::validate_settlement(&settlement)?;
        let existing = self.load_outbound_batch(&settlement.profile_id, &settlement.batch_id)?;
        if existing.is_empty() {
            return Err("outbound batch not found".to_string());
        }
        if existing.iter().any(|operation| {
            operation.batch_incarnation != settlement.batch_incarnation
                || operation.state != OutboundState::InFlight
                || operation.lease_token.as_deref() != Some(&settlement.lease_token)
        }) {
            return Err("outbound batch is not owned by the active lease".to_string());
        }
        let operation_ids: std::collections::HashSet<_> = existing
            .iter()
            .map(|operation| operation.operation_id.as_str())
            .collect();
        if !settlement.applied.is_empty()
            && (settlement.applied.len() != existing.len()
                || settlement
                    .applied
                    .iter()
                    .any(|result| !operation_ids.contains(result.operation_id.as_str())))
        {
            return Err("applied settlement must cover the complete logical batch".to_string());
        }
        if settlement.applied.is_empty() && settlement.conflicts.is_empty() {
            return Err("settlement must contain applied results or conflicts".to_string());
        }
        if settlement
            .conflicts
            .iter()
            .any(|conflict| !operation_ids.contains(conflict.operation_id.as_str()))
        {
            return Err("settlement references an operation outside the batch".to_string());
        }
        let mapping_plan = if settlement.conflicts.is_empty() {
            let mut current_mappings = Vec::new();
            let mut incoming = Vec::with_capacity(settlement.applied.len());
            for applied in &settlement.applied {
                let operation = existing
                    .iter()
                    .find(|operation| operation.operation_id == applied.operation_id)
                    .expect("settlement operation was preflighted");
                if let Some(mapping) = self.entity_by_remote(
                    &settlement.profile_id,
                    operation.entity_type,
                    &applied.remote_id,
                )? {
                    current_mappings.push(mapping);
                }
                if let Some(mapping) = self.entity_revision_by_local(
                    &settlement.profile_id,
                    operation.entity_type,
                    &operation.entity_id,
                )? {
                    current_mappings.push(mapping);
                }
                let settled_snapshot =
                    if operation.entity_type == SyncEntityType::ModelCollectionMembership {
                        let collection_id =
                            operation.payload["collectionId"]
                                .as_str()
                                .and_then(|local_id| {
                                    self.entity_revision_by_local(
                                        &settlement.profile_id,
                                        SyncEntityType::ModelCollection,
                                        local_id,
                                    )
                                    .ok()
                                    .flatten()
                                    .map(|mapping| mapping.remote_id)
                                });
                        let model_id = operation.payload["modelHash"].as_str().and_then(|hash| {
                            self.remote_model_link(&settlement.profile_id, hash)
                                .ok()
                                .flatten()
                                .map(|link| link.remote_model_id)
                        });
                        match (collection_id, model_id) {
                            (Some(collection_id), Some(model_id)) => Some(serde_json::json!({
                                "id": applied.remote_id,
                                "collectionId": collection_id,
                                "modelId": model_id,
                                "createdAt": "1970-01-01T00:00:00Z",
                                "updatedAt": "1970-01-01T00:00:00Z",
                                "revision": applied.revision
                            })),
                            _ => None,
                        }
                    } else {
                        None
                    };
                incoming.push(EntityRevisionDto {
                    profile_id: settlement.profile_id.clone(),
                    entity_type: operation.entity_type,
                    local_id: Some(operation.entity_id.clone()),
                    remote_id: applied.remote_id.clone(),
                    revision: applied.revision,
                    concurrency_token: applied.concurrency_token.clone(),
                    tombstone: operation.operation == sync::SyncOperationKind::Delete,
                    visibility: SyncVisibility::Private,
                    snapshot: settled_snapshot,
                    updated_at: settlement.settled_at,
                });
            }
            sync::preflight_entity_revision_set(&current_mappings, incoming)?
        } else {
            Vec::new()
        };

        self.begin_batch()?;
        let result = (|| {
            let mut conflict_records = Vec::new();
            if settlement.conflicts.is_empty() {
                for applied in &settlement.applied {
                    let operation = existing
                        .iter()
                        .find(|operation| operation.operation_id == applied.operation_id)
                        .expect("settlement operation was preflighted");
                    self.conn
                        .execute(
                            "UPDATE sync_outbox SET state = 'acked', retry_eligible = 0,
                                retry_at = NULL, lease_until = NULL, lease_token = NULL,
                                last_error = NULL, updated_at = ?5, acked_at = ?5
                             WHERE profile_id = ?1 AND batch_id = ?2 AND operation_id = ?3
                               AND state = 'inFlight' AND lease_token = ?4
                               AND batch_incarnation = ?6",
                            params![
                                settlement.profile_id,
                                settlement.batch_id,
                                operation.operation_id,
                                settlement.lease_token,
                                settlement.settled_at,
                                settlement.batch_incarnation
                            ],
                        )
                        .map_err(sql_error)?;
                }
                for mapping in &mapping_plan {
                    self.upsert_entity_revision(mapping, settlement.server_revision)?;
                    if let Some(local_id) = mapping.local_id.as_deref() {
                        self.conn
                            .execute(
                                "UPDATE sync_outbox SET base_revision = ?4,
                                    concurrency_token = ?5
                                 WHERE profile_id = ?1 AND entity_type = ?2
                                   AND entity_id = ?3 AND state = 'pending'",
                                params![
                                    mapping.profile_id,
                                    mapping.entity_type.as_db(),
                                    local_id,
                                    mapping.revision as i64,
                                    mapping.concurrency_token
                                ],
                            )
                            .map_err(sql_error)?;
                    }
                    if mapping.entity_type == SyncEntityType::ModelCollection && !mapping.tombstone
                    {
                        if let Some(local_id) = mapping.local_id.as_deref() {
                            self.conn
                                .execute(
                                    "UPDATE collections SET sync_profile_id = ?2,
                                        sync_remote_id = ?3, sync_visibility = 'Private',
                                        sync_read_only = 0 WHERE id = ?1",
                                    params![local_id, mapping.profile_id, mapping.remote_id],
                                )
                                .map_err(sql_error)?;
                        }
                    }
                }
            } else {
                self.conn
                    .execute(
                        "UPDATE sync_outbox SET state = 'failed', retry_eligible = 0,
                            retry_at = NULL, lease_until = NULL, lease_token = NULL,
                            last_error = 'server conflict', updated_at = ?4
                         WHERE profile_id = ?1 AND batch_id = ?2 AND lease_token = ?3
                           AND state = 'inFlight' AND batch_incarnation = ?5",
                        params![
                            settlement.profile_id,
                            settlement.batch_id,
                            settlement.lease_token,
                            settlement.settled_at,
                            settlement.batch_incarnation
                        ],
                    )
                    .map_err(sql_error)?;
                for conflict in &settlement.conflicts {
                    conflict_records.push(self.insert_conflict_associated(
                        &settlement.profile_id,
                        &conflict.conflict,
                        Some(&settlement.batch_id),
                        Some(&conflict.operation_id),
                        Some(&settlement.batch_incarnation),
                        Some(&settlement.lease_token),
                    )?);
                }
            }
            self.ensure_sync_profile(&settlement.profile_id)?;
            self.conn
                .execute(
                    "UPDATE sync_profiles SET server_revision = MAX(server_revision, ?2),
                        last_pushed_at = ?3, updated_at = ?3 WHERE profile_id = ?1",
                    params![
                        settlement.profile_id,
                        settlement.server_revision as i64,
                        settlement.settled_at
                    ],
                )
                .map_err(sql_error)?;
            Ok(SettledOutboundBatchDto {
                operations: self
                    .load_outbound_batch(&settlement.profile_id, &settlement.batch_id)?,
                conflicts: conflict_records,
            })
        })();
        self.finish_batch(result)
    }

    fn reconcile_uncertain_batch(
        &mut self,
        reconciliation: ReconcileUncertainBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_reconciliation(&reconciliation)?;
        let existing =
            self.load_outbound_batch(&reconciliation.profile_id, &reconciliation.batch_id)?;
        if existing.is_empty()
            || existing.iter().any(|operation| {
                operation.batch_incarnation != reconciliation.batch_incarnation
                    || operation.attempt_token.as_deref()
                        != Some(&reconciliation.expected_attempt_token)
                    || operation.state != OutboundState::Uncertain
            })
        {
            return Err("only a wholly uncertain batch can be reconciled".to_string());
        }
        let replacements: std::collections::HashMap<_, _> = reconciliation
            .operations
            .iter()
            .map(|entry| (entry.operation_id.as_str(), entry))
            .collect();
        if replacements.len() != existing.len()
            || existing
                .iter()
                .any(|operation| !replacements.contains_key(operation.operation_id.as_str()))
        {
            return Err("reconciliation must cover every operation in the batch".to_string());
        }
        let (state, retry_eligible, acked_at) = match reconciliation.resolution {
            UnknownOutcomeResolution::Acked => ("acked", 0_i64, Some(reconciliation.reconciled_at)),
            UnknownOutcomeResolution::Requeue => ("pending", 1_i64, None),
        };
        self.begin_batch()?;
        let result = (|| {
            for operation in &existing {
                let replacement = replacements[operation.operation_id.as_str()];
                self.conn
                    .execute(
                        "UPDATE sync_outbox SET state = ?4, retry_eligible = ?5,
                            base_revision = COALESCE(?6, base_revision),
                            concurrency_token = COALESCE(?7, concurrency_token),
                            retry_at = NULL, lease_until = NULL, lease_token = NULL,
                            updated_at = ?8, acked_at = ?9
                         WHERE profile_id = ?1 AND batch_id = ?2 AND operation_id = ?3
                           AND state = 'uncertain'",
                        params![
                            reconciliation.profile_id,
                            reconciliation.batch_id,
                            operation.operation_id,
                            state,
                            retry_eligible,
                            replacement.base_revision.map(|revision| revision as i64),
                            replacement.concurrency_token,
                            reconciliation.reconciled_at,
                            acked_at,
                        ],
                    )
                    .map_err(sql_error)?;
            }
            self.load_outbound_batch(&reconciliation.profile_id, &reconciliation.batch_id)
        })();
        self.finish_batch(result)
    }

    fn dispose_failed_batch(
        &mut self,
        disposition: DisposeFailedBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_failed_disposition(&disposition)?;
        self.begin_batch()?;
        let result = self.dispose_failed_batch_inner(&disposition);
        self.finish_batch(result)
    }

    fn prune_acked_outbound_operations(
        &mut self,
        profile_id: &str,
        acked_before: i64,
        limit: usize,
    ) -> Result<usize, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_timestamp("ackedBefore", acked_before)?;
        sync::validate_limit(limit)?;
        let candidates: Vec<(String, String, usize)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT o.batch_id, o.batch_incarnation, COUNT(*) FROM sync_outbox o
                     WHERE o.profile_id = ?1
                       AND NOT EXISTS (
                           SELECT 1 FROM sync_conflicts c
                           WHERE c.profile_id = o.profile_id
                             AND c.batch_id = o.batch_id
                             AND c.batch_incarnation = o.batch_incarnation
                             AND c.resolved_at IS NULL)
                     GROUP BY o.batch_id, o.batch_incarnation
                     HAVING SUM(CASE WHEN state = 'acked' THEN 1 ELSE 0 END) = COUNT(*)
                        AND COUNT(acked_at) = COUNT(*)
                        AND MAX(acked_at) < ?2
                     ORDER BY MIN(sequence) LIMIT 500",
                )
                .map_err(sql_error)?;
            let rows = stmt
                .query_map(params![profile_id, acked_before], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? as usize))
                })
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?;
            rows
        };
        let mut selected = Vec::new();
        let mut count = 0;
        for (batch_id, batch_incarnation, batch_count) in candidates {
            if count + batch_count > limit {
                break;
            }
            count += batch_count;
            selected.push((batch_id, batch_incarnation));
        }
        if selected.is_empty() {
            return Ok(0);
        }
        self.begin_batch()?;
        let result = (|| {
            for (batch_id, batch_incarnation) in &selected {
                self.conn
                    .execute(
                        "DELETE FROM sync_outbox
                         WHERE profile_id = ?1 AND batch_id = ?2
                           AND batch_incarnation = ?3 AND state = 'acked'",
                        params![profile_id, batch_id, batch_incarnation],
                    )
                    .map_err(sql_error)?;
            }
            Ok(count)
        })();
        self.finish_batch(result)
    }

    fn record_sync_conflicts(
        &mut self,
        profile_id: &str,
        conflicts: Vec<ConflictInputDto>,
    ) -> Result<Vec<SyncConflictDto>, String> {
        sync::validate_profile(profile_id)?;
        if conflicts.is_empty() || conflicts.len() > sync::MAX_SYNC_BATCH {
            return Err(format!(
                "conflict batches must contain 1..={} conflicts",
                sync::MAX_SYNC_BATCH
            ));
        }
        for conflict in &conflicts {
            sync::validate_conflict_input(conflict)?;
        }
        self.begin_batch()?;
        let result = (|| {
            self.ensure_sync_profile(profile_id)?;
            conflicts
                .iter()
                .map(|conflict| self.insert_conflict(profile_id, conflict))
                .collect()
        })();
        self.finish_batch(result)
    }

    fn sync_conflicts(
        &self,
        profile_id: &str,
        include_resolved: bool,
        limit: usize,
    ) -> Result<Vec<SyncConflictDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT profile_id, conflict_id, entity_type, entity_id,
                        local_payload_json, server_payload_json, submitted_payload_json,
                        reason, server_revision, created_at, resolved_at, resolution,
                        batch_id, operation_id, batch_incarnation, attempt_token
                 FROM sync_conflicts
                 WHERE profile_id = ?1 AND (?2 = 1 OR resolved_at IS NULL)
                 ORDER BY created_at, conflict_id LIMIT ?3",
            )
            .map_err(sql_error)?;
        let conflicts = stmt
            .query_map(
                params![profile_id, i64::from(include_resolved), limit as i64],
                conflict_from_row,
            )
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(conflicts)
    }

    fn resolve_sync_conflict(
        &mut self,
        profile_id: &str,
        conflict_id: &str,
        resolution: ConflictResolution,
        resolved_at: i64,
        failed_disposition: Option<DisposeFailedBatchDto>,
    ) -> Result<SyncConflictDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("conflictId", conflict_id)?;
        sync::validate_timestamp("resolvedAt", resolved_at)?;
        let existing = self
            .conn
            .query_row(
                "SELECT profile_id, conflict_id, entity_type, entity_id,
                        local_payload_json, server_payload_json, submitted_payload_json,
                        reason, server_revision, created_at, resolved_at, resolution,
                        batch_id, operation_id, batch_incarnation, attempt_token
                 FROM sync_conflicts WHERE profile_id = ?1 AND conflict_id = ?2",
                params![profile_id, conflict_id],
                conflict_from_row,
            )
            .optional()
            .map_err(sql_error)?
            .ok_or_else(|| "sync conflict not found".to_string())?;
        if existing.resolved_at.is_some() {
            return Err("sync conflict is already resolved".to_string());
        }
        if resolved_at < existing.created_at {
            return Err("resolvedAt must not precede createdAt".to_string());
        }
        if let Some(disposition) = &failed_disposition {
            sync::validate_failed_disposition(disposition)?;
            if disposition.profile_id != profile_id
                || existing.batch_id.as_deref() != Some(&disposition.batch_id)
                || existing.batch_incarnation.as_deref() != Some(&disposition.batch_incarnation)
                || existing.attempt_token.as_deref() != Some(&disposition.expected_attempt_token)
            {
                return Err("conflict disposition does not match the associated batch".to_string());
            }
            let siblings: bool = self
                .conn
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM sync_conflicts
                        WHERE profile_id = ?1 AND batch_incarnation = ?2
                          AND conflict_id <> ?3 AND resolved_at IS NULL)",
                    params![profile_id, disposition.batch_incarnation, conflict_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if siblings {
                return Err(
                    "all sibling conflicts must be resolved before batch disposition".to_string(),
                );
            }
        }
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE sync_conflicts SET resolved_at = ?3, resolution = ?4
                     WHERE profile_id = ?1 AND conflict_id = ?2 AND resolved_at IS NULL",
                    params![profile_id, conflict_id, resolved_at, resolution.as_db()],
                )
                .map_err(sql_error)?;
            if let Some(disposition) = &failed_disposition {
                self.dispose_failed_batch_inner(disposition)?;
            }
            self.conn
                .query_row(
                    "SELECT profile_id, conflict_id, entity_type, entity_id,
                            local_payload_json, server_payload_json, submitted_payload_json,
                            reason, server_revision, created_at, resolved_at, resolution,
                            batch_id, operation_id, batch_incarnation, attempt_token
                     FROM sync_conflicts WHERE profile_id = ?1 AND conflict_id = ?2",
                    params![profile_id, conflict_id],
                    conflict_from_row,
                )
                .map_err(sql_error)
        })();
        self.finish_batch(result)
    }
}

/// Whole seconds since the Unix epoch, as text, for `*_at` columns.
fn now_ts() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn path_to_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Persisted form of a format, matching the enum's camelCase serde names.
fn format_to_db(format: ModelFormat) -> &'static str {
    match format {
        ModelFormat::Stl => "stl",
        ModelFormat::ThreeMf => "threeMf",
        ModelFormat::Obj => "obj",
    }
}

fn format_from_db(value: &str) -> ModelFormat {
    match value {
        "threeMf" => ModelFormat::ThreeMf,
        "obj" => ModelFormat::Obj,
        _ => ModelFormat::Stl,
    }
}

fn migrate_v5_fencing(conn: &Connection) -> rusqlite::Result<()> {
    let oversized: Vec<(i64, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT rowid, profile_id, sequence FROM sync_outbox
             WHERE length(CAST(batch_id AS BLOB)) > 256 ORDER BY profile_id, sequence",
        )?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (rowid, profile_id, sequence) in oversized {
        let base = format!("legacy-{sequence:016x}");
        let mut suffix = 0_u32;
        let replacement = loop {
            let candidate = if suffix == 0 {
                base.clone()
            } else {
                format!("{base}-{suffix:08x}")
            };
            let collision: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sync_outbox
                    WHERE profile_id = ?1 AND batch_id = ?2 AND rowid <> ?3)",
                params![profile_id, candidate, rowid],
                |row| row.get(0),
            )?;
            if !collision {
                break candidate;
            }
            suffix = suffix.checked_add(1).ok_or(rusqlite::Error::InvalidQuery)?;
        };
        conn.execute(
            "UPDATE sync_outbox SET batch_id = ?2 WHERE rowid = ?1",
            params![rowid, replacement],
        )?;
    }

    let batches: Vec<(String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT profile_id, batch_id, MIN(sequence) FROM sync_outbox
             GROUP BY profile_id, batch_id ORDER BY profile_id, MIN(sequence)",
        )?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (profile_id, batch_id, sequence) in batches {
        let incarnation = format!("migrated-batch-{sequence:016x}");
        let attempt = format!("migrated-attempt-{sequence:016x}");
        conn.execute(
            "UPDATE sync_outbox SET batch_incarnation = COALESCE(batch_incarnation, ?3)
             WHERE profile_id = ?1 AND batch_id = ?2",
            params![profile_id, batch_id, incarnation],
        )?;
        conn.execute(
            "UPDATE sync_outbox
             SET attempt_token = COALESCE(attempt_token, lease_token, ?3)
             WHERE profile_id = ?1 AND batch_id = ?2
               AND state IN ('inFlight', 'uncertain', 'failed')",
            params![profile_id, batch_id, attempt],
        )?;
    }
    conn.execute_batch(
        "UPDATE sync_conflicts
         SET batch_incarnation = (
                 SELECT o.batch_incarnation FROM sync_outbox o
                 WHERE o.profile_id = sync_conflicts.profile_id
                   AND o.batch_id = sync_conflicts.batch_id
                 ORDER BY o.sequence LIMIT 1),
             attempt_token = (
                 SELECT o.attempt_token FROM sync_outbox o
                 WHERE o.profile_id = sync_conflicts.profile_id
                   AND o.batch_id = sync_conflicts.batch_id
                 ORDER BY o.sequence LIMIT 1)
         WHERE batch_id IS NOT NULL;",
    )?;
    Ok(())
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("catalog sync operation failed: {error}")
}

fn invalid_db_value() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn json_string(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("failed to serialize JSON payload: {error}"))
}

fn optional_json(value: &Option<serde_json::Value>) -> Result<Option<String>, String> {
    value.as_ref().map(json_string).transpose()
}

fn parse_json(value: String) -> rusqlite::Result<serde_json::Value> {
    serde_json::from_str(&value).map_err(|_| invalid_db_value())
}

fn parse_optional_json(value: Option<String>) -> rusqlite::Result<Option<serde_json::Value>> {
    value.map(parse_json).transpose()
}

fn remote_link_from_row(row: &Row<'_>) -> rusqlite::Result<RemoteModelLinkDto> {
    let status: String = row.get(5)?;
    Ok(RemoteModelLinkDto {
        profile_id: row.get(0)?,
        local_model_hash: row.get(1)?,
        remote_model_id: row.get(2)?,
        client_upload_id: row.get(3)?,
        etag: row.get(4)?,
        upload_status: RemoteUploadStatus::from_db(&status).map_err(|_| invalid_db_value())?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        uploaded_at: row.get(8)?,
    })
}

fn entity_from_row(row: &Row<'_>) -> rusqlite::Result<EntityRevisionDto> {
    let entity_type: String = row.get(1)?;
    let visibility: String = row.get(7)?;
    let snapshot: Option<String> = row.get(8)?;
    Ok(EntityRevisionDto {
        profile_id: row.get(0)?,
        entity_type: SyncEntityType::from_db(&entity_type).map_err(|_| invalid_db_value())?,
        local_id: row.get(2)?,
        remote_id: row.get(3)?,
        revision: row.get::<_, i64>(4)? as u64,
        concurrency_token: row.get(5)?,
        tombstone: row.get::<_, i64>(6)? != 0,
        visibility: SyncVisibility::from_db(&visibility).map_err(|_| invalid_db_value())?,
        snapshot: parse_optional_json(snapshot)?,
        updated_at: row.get(9)?,
    })
}

fn outbound_from_row(row: &Row<'_>) -> rusqlite::Result<OutboundOperationDto> {
    let entity_type: String = row.get(2)?;
    let operation: String = row.get(3)?;
    let payload: String = row.get(5)?;
    let state: String = row.get(8)?;
    Ok(OutboundOperationDto {
        profile_id: row.get(0)?,
        operation_id: row.get(1)?,
        sequence: row.get::<_, i64>(17)? as u64,
        batch_id: row.get(18)?,
        batch_incarnation: row.get(21)?,
        batch_ordinal: row.get::<_, i64>(19)? as u32,
        entity_type: SyncEntityType::from_db(&entity_type).map_err(|_| invalid_db_value())?,
        operation: crate::sync::SyncOperationKind::from_db(&operation)
            .map_err(|_| invalid_db_value())?,
        entity_id: row.get(4)?,
        payload: parse_json(payload)?,
        base_revision: row
            .get::<_, Option<i64>>(6)?
            .map(|revision| revision as u64),
        concurrency_token: row.get(7)?,
        state: OutboundState::from_db(&state).map_err(|_| invalid_db_value())?,
        attempt_count: row.get::<_, i64>(9)? as u32,
        retry_eligible: row.get::<_, i64>(10)? != 0,
        retry_at: row.get(11)?,
        lease_until: row.get(12)?,
        lease_token: row.get(20)?,
        attempt_token: row.get(22)?,
        last_error: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        acked_at: row.get(16)?,
    })
}

fn conflict_from_row(row: &Row<'_>) -> rusqlite::Result<SyncConflictDto> {
    let entity_type: String = row.get(2)?;
    let local_payload: Option<String> = row.get(4)?;
    let server_payload: Option<String> = row.get(5)?;
    let submitted_payload: Option<String> = row.get(6)?;
    let resolution: Option<String> = row.get(11)?;
    Ok(SyncConflictDto {
        profile_id: row.get(0)?,
        conflict_id: row.get(1)?,
        entity_type: SyncEntityType::from_db(&entity_type).map_err(|_| invalid_db_value())?,
        entity_id: row.get(3)?,
        batch_id: row.get(12)?,
        operation_id: row.get(13)?,
        batch_incarnation: row.get(14)?,
        attempt_token: row.get(15)?,
        local_payload: parse_optional_json(local_payload)?,
        server_payload: parse_optional_json(server_payload)?,
        submitted_payload: parse_optional_json(submitted_payload)?,
        reason: row.get(7)?,
        server_revision: row.get::<_, i64>(8)? as u64,
        created_at: row.get(9)?,
        resolved_at: row.get(10)?,
        resolution: resolution
            .map(|value| ConflictResolution::from_db(&value).map_err(|_| invalid_db_value()))
            .transpose()?,
    })
}

fn sqlite_outbound_matches_input(
    existing: &OutboundOperationDto,
    batch_id: &str,
    batch_ordinal: u32,
    input: &EnqueueOutboundOperationDto,
) -> bool {
    existing.operation_id == input.operation_id
        && existing.batch_id == batch_id
        && existing.batch_ordinal == batch_ordinal
        && existing.entity_type == input.entity_type
        && existing.operation == input.operation
        && existing.entity_id == input.entity_id
        && existing.payload == input.payload
        && existing.base_revision == input.base_revision
        && existing.concurrency_token == input.concurrency_token
        && existing.created_at == input.created_at
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::reconcile_root;
    use crate::scan::scan_root;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn scan(root: &Path) -> crate::scan::ScanResult {
        scan_root(root, &AtomicBool::new(false))
    }

    #[test]
    fn migration_sets_the_schema_version() {
        let store = SqliteCatalog::open_in_memory().unwrap();
        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_v1_additively_and_preserves_catalog_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v1.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute(
                "INSERT INTO collections(id, name, created_at, updated_at)
                 VALUES('existing', 'Existing', '1', '1')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }

        let store = SqliteCatalog::open(&db).unwrap();
        assert_eq!(store.all_collections()[0].id, "existing");
        assert_eq!(store.sync_status("profile").unwrap().server_revision, 0);
        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_v2_outbox_rows_with_stable_legacy_ordering() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v2.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute("INSERT INTO sync_profiles(profile_id) VALUES('p')", [])
                .unwrap();
            for operation_id in ["x".repeat(256), "second".to_string()] {
                conn.execute(
                    "INSERT INTO sync_outbox(
                        profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, state, attempt_count, retry_eligible, created_at, updated_at)
                     VALUES('p', ?1, 'ModelCollection', 'Create', ?1, '{}',
                            'pending', 0, 1, 1, 1)",
                    params![operation_id],
                )
                .unwrap();
            }

            conn.pragma_update(None, "user_version", 2).unwrap();
        }

        let mut store = SqliteCatalog::open(&db).unwrap();
        let operations = store
            .outbound_operations("p", &[OutboundState::Pending], 10)
            .unwrap();
        assert_eq!(operations.len(), 2);
        assert!(operations[0].sequence < operations[1].sequence);
        assert!(operations.iter().all(|operation| {
            operation.batch_id.starts_with("legacy-") && operation.batch_id.len() <= 256
        }));
        let claim = store
            .claim_outbound_operations("p", 1, 2, 10)
            .unwrap()
            .unwrap();
        let operation_id = claim.operations[0].operation_id.clone();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "p".to_string(),
                batch_id: claim.batch_id,
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 3,
                server_revision: 1,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id,
                    remote_id: "legacy-remote".to_string(),
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();
    }

    #[test]
    fn v3_migration_uses_utf8_bytes_and_avoids_synthetic_id_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v3-collision.sqlite3");
        let multibyte_operation_id = "é".repeat(125);
        assert_eq!(multibyte_operation_id.len(), 250);
        let synthetic_collision = "legacy-0000000000000002";
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.execute("INSERT INTO sync_profiles(profile_id) VALUES('p')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO sync_profile_sequences(profile_id, next_sequence) VALUES('p', 3)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_outbox(
                    profile_id, operation_id, entity_type, operation_kind, entity_id,
                    payload_json, state, attempt_count, retry_eligible, created_at, updated_at,
                    sequence, batch_id, batch_ordinal)
                 VALUES('p', 'collision', 'ModelCollection', 'Create', 'collision-local',
                        '{}', 'pending', 0, 1, 1, 1, 1, ?1, 0)",
                params![synthetic_collision],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_outbox(
                    profile_id, operation_id, entity_type, operation_kind, entity_id,
                    payload_json, state, attempt_count, retry_eligible, created_at, updated_at,
                    sequence, batch_id, batch_ordinal)
                 VALUES('p', ?1, 'ModelCollection', 'Create', 'multibyte-local',
                        '{}', 'pending', 0, 1, 1, 1, 2, ?2, 0)",
                params![
                    multibyte_operation_id,
                    format!("legacy-{multibyte_operation_id}")
                ],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 3).unwrap();
        }

        let mut store = SqliteCatalog::open(&db).unwrap();
        let operations = store
            .outbound_operations("p", &[OutboundState::Pending], 10)
            .unwrap();
        assert_eq!(operations.len(), 2);
        assert_ne!(operations[0].batch_id, operations[1].batch_id);
        assert!(operations
            .iter()
            .all(|operation| operation.batch_id.len() <= 256));
        assert_eq!(operations[1].operation_id.len(), 250);

        for (now, remote_id) in [(2, "collision-remote"), (4, "multibyte-remote")] {
            let claim = store
                .claim_outbound_operations("p", 1, now, 10)
                .unwrap()
                .unwrap();
            let operation_id = claim.operations[0].operation_id.clone();
            store
                .settle_outbound_batch(SettleOutboundBatchDto {
                    profile_id: "p".to_string(),
                    batch_id: claim.batch_id,
                    batch_incarnation: claim.batch_incarnation,
                    lease_token: claim.lease_token,
                    settled_at: now + 1,
                    server_revision: now as u64,
                    applied: vec![crate::sync::AppliedOutboundResultDto {
                        operation_id,
                        remote_id: remote_id.to_string(),
                        revision: now as u64,
                        concurrency_token: None,
                    }],
                    conflicts: vec![],
                })
                .unwrap();
        }
    }

    #[test]
    fn rejects_unknown_future_schema_versions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("future.sqlite3");
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(SqliteCatalog::open(&db).is_err());
    }

    #[test]
    fn v6_tag_migration_preserves_assignments_and_allows_duplicate_display_names() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v5-tags.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.execute_batch(SCHEMA_V4).unwrap();
            conn.execute_batch(SCHEMA_V5).unwrap();
            conn.execute(
                "INSERT INTO models(hash, format, size_bytes, created_at, updated_at)
                 VALUES('hash', 'stl', 1, '1', '1')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO tags(id, name) VALUES('local', 'Same')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO model_tags(model_hash, tag_id) VALUES('hash', 'local')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }

        let store = SqliteCatalog::open(&db).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO tags(id, name) VALUES('pf-sync-tag-a', 'Same')",
                [],
            )
            .unwrap();
        assert_eq!(store.tags_for_model("hash")[0].id, "local");
        assert_eq!(store.all_tags().len(), 2);
    }

    #[test]
    fn failed_upgrade_rolls_back_ddl_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("broken-v1.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("CREATE TABLE sync_outbox(bad INTEGER);")
                .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }

        assert!(SqliteCatalog::open(&db).is_err());
        let conn = Connection::open(&db).unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let remote_links_exist: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'remote_model_links')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!remote_links_exist);
    }

    #[test]
    fn opening_twice_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("catalog.db");
        {
            let mut store = SqliteCatalog::open(&db).unwrap();
            store.upsert_location(LocationUpsert {
                hash: "h".into(),
                format: ModelFormat::Stl,
                size: 3,
                root_id: "r".into(),
                path: PathBuf::from("/root/a.stl"),
                root_relative: PathBuf::from("a.stl"),
                fingerprint: FileFingerprint {
                    size: 3,
                    modified_unix_secs: Some(1),
                },
            });
        }

        // Reopening the same file must find the migration already applied and
        // the previously written model intact.
        let store = SqliteCatalog::open(&db).unwrap();
        assert_eq!(store.models().len(), 1);
        assert_eq!(store.model("h").unwrap().locations.len(), 1);
    }

    #[test]
    fn sqlite_connected_collection_create_commits_catalog_and_outbox_together() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        assert!(store
            .all_collections()
            .iter()
            .any(|value| value.id == collection.id));
        let queued = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].entity_id, collection.id);
        assert!(queued[0].payload["remoteId"]
            .as_str()
            .is_some_and(|value| value.len() == 36));
    }

    #[test]
    fn identical_bytes_across_paths_form_one_duplicate_group() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"same-bytes");
        write(&root.join("nested/copy.stl"), b"same-bytes");
        write(&root.join("other.stl"), b"different");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let report = reconcile_root(&mut store, "root1", &scan(root));

        assert_eq!(report.added, 3);
        assert_eq!(store.models().len(), 2);
        let dupes = store.duplicate_groups();
        assert_eq!(dupes.len(), 1);
        assert_eq!(dupes[0].locations.len(), 2);
    }

    #[test]
    fn unchanged_files_are_not_rehashed_on_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"hello");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.unchanged, 1);
        assert_eq!(report.added, 0);
        assert_eq!(report.changed, 0);
    }

    #[test]
    fn changed_content_moves_the_location_to_a_new_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("a.stl");
        write(&file, b"v1");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let first_hash = store.models()[0].hash.clone();

        write(&file, b"v2-longer");
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.changed, 1);
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert_ne!(models[0].hash, first_hash);
        assert_eq!(models[0].locations.len(), 1);
    }

    #[test]
    fn removed_files_are_marked_missing_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("gone.stl");
        write(&file, b"bytes");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));

        fs::remove_file(&file).unwrap();
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.missing, 1);
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert!(!models[0].locations[0].available);
    }

    #[test]
    fn ensure_root_stores_the_absolute_path() {
        let store = SqliteCatalog::open_in_memory().unwrap();
        store.ensure_root("r", Path::new("/models/root"));
        let path: String = store
            .conn
            .query_row("SELECT path FROM source_roots WHERE id = 'r'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(path, "/models/root");
    }

    #[test]
    fn tags_persist_dedupe_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();

        let tag = store.add_model_tag(&hash, " Terrain ").unwrap();
        assert_eq!(tag.id, "terrain");
        assert_eq!(tag.name, "Terrain");
        // Re-adding with different casing keeps a single assignment.
        store.add_model_tag(&hash, "TERRAIN");
        assert_eq!(store.tags_for_model(&hash).len(), 1);
        assert_eq!(store.all_tags().len(), 1);

        // Unknown models cannot be tagged.
        assert!(store.add_model_tag("missing", "x").is_none());

        store.remove_model_tag(&hash, &tag.id);
        assert!(store.tags_for_model(&hash).is_empty());
        assert!(store.all_tags().is_empty());
    }

    #[test]
    fn collections_persist_membership_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();

        assert!(store.create_collection("   ").is_none());
        let coll = store.create_collection("Warhammer").unwrap();
        assert_eq!(coll.name, "Warhammer");

        assert!(store.add_model_to_collection(&coll.id, &hash));
        assert!(!store.add_model_to_collection(&coll.id, "missing"));
        assert!(!store.add_model_to_collection("missing", &hash));

        let for_model = store.collections_for_model(&hash);
        assert_eq!(for_model.len(), 1);
        assert_eq!(for_model[0].member_count, 1);

        store.remove_model_from_collection(&coll.id, &hash);
        assert!(store.collections_for_model(&hash).is_empty());
        assert_eq!(store.all_collections().len(), 1);

        store.delete_collection(&coll.id);
        assert!(store.all_collections().is_empty());
    }

    #[test]
    fn catalog_batch_rolls_back_sqlite_mutations() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store.begin_batch().unwrap();
        store.create_collection("Temporary").unwrap();

        store.rollback_batch();

        assert!(store.all_collections().is_empty());
    }

    #[test]
    fn dropping_an_uncommitted_catalog_batch_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("catalog.sqlite3");
        {
            let mut store = SqliteCatalog::open(&database).unwrap();
            store.begin_batch().unwrap();
            store.create_collection("Temporary").unwrap();
        }

        let store = SqliteCatalog::open(&database).unwrap();
        assert!(store.all_collections().is_empty());
    }

    #[test]
    fn dropping_uncommitted_sync_work_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("sync-rollback.sqlite3");
        let hash = "a".repeat(64);
        {
            let mut store = SqliteCatalog::open(&database).unwrap();
            store.begin_batch().unwrap();
            store
                .link_remote_model(RemoteModelLinkDto {
                    profile_id: "p".to_string(),
                    local_model_hash: hash.clone(),
                    remote_model_id: "remote".to_string(),
                    client_upload_id: "upload".to_string(),
                    etag: None,
                    upload_status: RemoteUploadStatus::Pending,
                    created_at: 1,
                    updated_at: 1,
                    uploaded_at: None,
                })
                .unwrap();
        }

        let store = SqliteCatalog::open(&database).unwrap();
        assert!(store.remote_model_link("p", &hash).unwrap().is_none());
    }

    #[test]
    fn commit_failure_is_rolled_back_and_connection_remains_usable() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store.begin_batch().unwrap();
        store
            .conn
            .execute_batch("PRAGMA defer_foreign_keys = ON")
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO remote_model_links(
                    profile_id, local_model_hash, remote_model_id, client_upload_id,
                    upload_status, created_at, updated_at)
                 VALUES('missing-profile', ?1, 'remote', 'upload', 'pending', 1, 1)",
                params!["a".repeat(64)],
            )
            .unwrap();

        assert!(store.finish_batch(Ok(())).is_err());
        store.ensure_sync_profile("usable").unwrap();
        assert_eq!(store.sync_status("usable").unwrap().server_revision, 0);
        store.begin_batch().unwrap();
        store.rollback_batch();
    }

    #[test]
    fn state_filtered_history_queries_are_bounded_and_acked_rows_can_be_pruned() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store.ensure_sync_profile("history").unwrap();
        store
            .conn
            .execute_batch(
                "WITH RECURSIVE n(x) AS (
                    VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000
                 )
                 INSERT INTO sync_outbox(
                    profile_id, operation_id, entity_type, operation_kind, entity_id,
                    payload_json, state, attempt_count, retry_eligible, created_at, updated_at,
                    acked_at, sequence, batch_id, batch_ordinal, batch_incarnation)
                 SELECT 'history', 'acked-' || x, 'ModelCollection', 'Create', 'entity-' || x,
                        'not-json', 'acked', 1, 0, 1, 1, 1, x, 'batch-' || x, 0,
                        'inc-' || x
                 FROM n;
                 INSERT INTO sync_outbox(
                    profile_id, operation_id, entity_type, operation_kind, entity_id,
                    payload_json, state, attempt_count, retry_eligible, created_at, updated_at,
                    sequence, batch_id, batch_ordinal, batch_incarnation)
                 VALUES('history', 'pending', 'ModelCollection', 'Create', 'pending',
                        '{}', 'pending', 0, 1, 2, 2, 1001, 'pending-batch', 0,
                        'pending-inc');",
            )
            .unwrap();

        let pending = store
            .outbound_operations("history", &[OutboundState::Pending], 1)
            .unwrap();
        assert_eq!(pending[0].operation_id, "pending");
        assert_eq!(
            store
                .prune_acked_outbound_operations("history", 2, 500)
                .unwrap(),
            500
        );
        assert_eq!(
            store
                .prune_acked_outbound_operations("history", 2, 500)
                .unwrap(),
            500
        );
        assert_eq!(
            store
                .outbound_operations("history", &[OutboundState::Pending], 1)
                .unwrap()[0]
                .operation_id,
            "pending"
        );
    }
}
