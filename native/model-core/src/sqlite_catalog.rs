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

use crate::calibration::{
    calibration_resolution_error, CalibrationConflictDto, CalibrationConflictResolutionDto,
    CalibrationCursorStateDto, CalibrationPendingOpDto, CalibrationUnhydratedProjectDto,
    CalibrationWorkspaceStageId, CalibrationWorkspaceStateDto, ResolveCalibrationConflictParams,
    SaveCalibrationWorkspaceStateParams, StageCalibrationPhotoParams, StagedCalibrationPhotoDto,
    SupersededObservationDto,
};
use crate::catalog::{new_collection_id, normalize_tag, CatalogResetSummary};
use crate::catalog::{
    CatalogStore, Collection, LocationUpsert, LogicalModel, ModelLocation, StoredLocation, Tag,
};
use crate::model::{FileFingerprint, ModelFormat};
use crate::schema::{
    SCHEMA_V1, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12, SCHEMA_V13, SCHEMA_V14, SCHEMA_V15, SCHEMA_V2,
    SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8, SCHEMA_V9, SCHEMA_VERSION,
};
use crate::sync::{
    self, ApplyPullBatchDto, CalibrationConflictKind, CalibrationConflictResolutionKind,
    CalibrationEntityType, CalibrationOutboxState, ClaimedOutboundBatchDto, ConflictInputDto,
    ConflictResolution, DisposeFailedBatchDto, EnqueueOutboundOperationDto, EntityRevisionDto,
    FailOutboundBatchDto, OutboundFailureOutcome, OutboundOperationDto, OutboundState,
    ReconcileUncertainBatchDto, RemoteModelLinkDto, RemoteUploadStatus, SettleOutboundBatchDto,
    SettledOutboundBatchDto, SyncConflictDto, SyncEntityType, SyncStatusDto, SyncVisibility,
    UnknownOutcomeResolution,
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
                if version < 9 {
                    conn.execute_batch(SCHEMA_V9)?;
                }
                if version < 10 {
                    conn.execute_batch(SCHEMA_V10)?;
                }
                if version < 11 {
                    conn.execute_batch(SCHEMA_V11)?;
                }
                if version < 12 {
                    conn.execute_batch(SCHEMA_V12)?;
                }
                if version < 13 {
                    conn.execute_batch(SCHEMA_V13)?;
                }
                if version < 14 {
                    conn.execute_batch(SCHEMA_V14)?;
                }
                if version < 15 {
                    conn.execute_batch(SCHEMA_V15)?;
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

    /// Reads the per-entity pull-journal watermark currently persisted for
    /// `remote_id`, or `0` if the entity has never been observed via a pull.
    /// Callers that are *not* applying a pull batch (e.g. push settlement)
    /// must preserve this value rather than substituting an unrelated global
    /// counter such as the journal head at settlement time: doing so would
    /// advance the watermark past legitimate, not-yet-pulled changes from
    /// other writers to the same entity, causing `apply_pull_batch` to
    /// silently skip them once they do arrive.
    fn existing_journal_revision(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        remote_id: &str,
    ) -> Result<u64, String> {
        self.conn
            .query_row(
                "SELECT journal_revision FROM sync_entities
                 WHERE profile_id = ?1 AND entity_type = ?2 AND remote_id = ?3",
                params![profile_id, entity_type.as_db(), remote_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(sql_error)
            .map(|value| value.unwrap_or(0) as u64)
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

    /// Observations whose binding printer-snapshot revision is behind
    /// `accepted_revision`.
    ///
    /// A pure read. Q2 rules that accepting a server snapshot reports the
    /// affected measurements rather than invalidating them, so this function
    /// must not write: if it ever does, the cascade the ruling forbids has been
    /// reintroduced somewhere no reviewer is looking.
    ///
    /// Observations with a NULL `bound_snapshot_revision` are not reported. They
    /// were recorded before the binding existed, so "is it superseded?" has no
    /// answer for them, and reporting them would claim knowledge we do not have.
    fn observations_superseded_by(
        &self,
        profile_id: &str,
        project_id: &str,
        accepted_revision: i64,
    ) -> Result<Vec<SupersededObservationDto>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT observation_id, attempt_id, step_id, parameter_key,
                        bound_snapshot_revision
                 FROM calibration_observations
                 WHERE profile_id = ?1 AND project_id = ?2
                   AND bound_snapshot_revision IS NOT NULL
                   AND bound_snapshot_revision < ?3
                 ORDER BY observed_at ASC, observation_id ASC",
            )
            .map_err(sql_error)?;
        let rows = stmt
            .query_map(params![profile_id, project_id, accepted_revision], |row| {
                Ok(SupersededObservationDto {
                    observation_id: row.get(0)?,
                    attempt_id: row.get(1)?,
                    step_id: row.get(2)?,
                    parameter_key: row.get(3)?,
                    bound_snapshot_revision: row.get(4)?,
                })
            })
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(rows)
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

    fn reset_catalog(&mut self) -> CatalogResetSummary {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .expect("catalog reset failed: begin transaction");
        let result = (|| -> rusqlite::Result<CatalogResetSummary> {
            let models_removed: i64 =
                self.conn
                    .query_row("SELECT COUNT(*) FROM models", [], |row| row.get(0))?;
            let source_roots_removed: i64 =
                self.conn
                    .query_row("SELECT COUNT(*) FROM source_roots", [], |row| row.get(0))?;
            // Root deletion removes every location first. Model deletion can
            // then cascade favorites, memberships, tags assignments, and
            // thumbnail rows without touching tag/collection definitions.
            self.conn.execute("DELETE FROM source_roots", [])?;
            self.conn.execute("DELETE FROM models", [])?;
            Ok(CatalogResetSummary {
                models_removed: models_removed as usize,
                source_roots_removed: source_roots_removed as usize,
            })
        })();
        match result {
            Ok(summary) => {
                self.conn
                    .execute_batch("COMMIT")
                    .expect("catalog reset failed: commit transaction");
                summary
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                panic!("catalog reset failed: {error}");
            }
        }
    }

    fn favorite_hashes(&self) -> Vec<String> {
        let mut stmt = self
            .conn
            .prepare("SELECT model_hash FROM favorite_models ORDER BY model_hash")
            .expect("catalog read failed: favorites prepare");
        stmt.query_map([], |row| row.get(0))
            .expect("catalog read failed: favorites query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("catalog read failed: favorites collect")
    }

    fn add_favorite(&mut self, hash: &str) -> bool {
        let known: bool = self
            .conn
            .query_row(
                "SELECT 1 FROM models WHERE hash = ?1",
                params![hash],
                |_| Ok(()),
            )
            .optional()
            .expect("catalog read failed: favorite model exists")
            .is_some();
        if !known {
            return false;
        }
        self.conn
            .execute(
                "INSERT OR IGNORE INTO favorite_models(model_hash, created_at) VALUES(?1, ?2)",
                params![hash, now_ts()],
            )
            .expect("catalog write failed: add favorite");
        true
    }

    fn remove_favorite(&mut self, hash: &str) {
        self.conn
            .execute(
                "DELETE FROM favorite_models WHERE model_hash = ?1",
                params![hash],
            )
            .expect("catalog write failed: remove favorite");
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
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("expectedProfileBinding", expected_binding)?;
        sync::validate_identifier("newProfileBinding", new_binding)?;
        self.begin_batch()?;
        let result = (|| {
            let current_binding: Option<String> = self
                .conn
                .query_row(
                    "SELECT profile_binding FROM sync_profiles WHERE profile_id = ?1",
                    params![profile_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error)?
                .flatten();
            // Idempotent replay: the scheduler tick recovery path replays
            // every pending binding transition on every tick until it is
            // acknowledged. If a prior attempt already committed this exact
            // transition but crashed before acknowledging it, `expected_binding`
            // is now stale by construction -- treat the already-applied state
            // as success instead of re-running the destructive materialised
            // data wipe below (which would otherwise retry forever, since a
            // fresh CAS against the now-stale expectation can never succeed).
            if current_binding.as_deref() == Some(new_binding) {
                return self.sync_status(profile_id);
            }
            if current_binding.as_deref() != Some(expected_binding) {
                return Err("sync profile binding replacement requires CAS".to_string());
            }
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
            // CAS-conditioned: if an intervening writer already changed the
            // binding since we read `current_binding` above (a concurrent
            // SQLite connection racing us to this same row), this deletes
            // zero rows. Checking the count closes that race instead of
            // silently clobbering the intervening writer's binding with the
            // unconditional UPDATE that used to follow unconditionally.
            let deleted = self
                .conn
                .execute(
                    "DELETE FROM sync_profiles WHERE profile_id = ?1 AND profile_binding = ?2",
                    params![profile_id, expected_binding],
                )
                .map_err(sql_error)?;
            if deleted == 0 {
                return Err("sync profile binding replacement requires CAS".to_string());
            }
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
            .remote_model_link(
                &link.profile_id,
                &link.server_binding,
                &link.local_model_hash,
            )?
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
                    profile_id, server_binding, local_model_hash, remote_model_id,
                    client_upload_id, etag, upload_status, created_at, updated_at, uploaded_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(profile_id, server_binding, local_model_hash) DO UPDATE SET
                    etag = excluded.etag,
                    upload_status = excluded.upload_status,
                    updated_at = excluded.updated_at,
                    uploaded_at = excluded.uploaded_at",
                params![
                    link.profile_id,
                    link.server_binding,
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
        server_binding: &str,
        local_model_hash: &str,
    ) -> Result<Option<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("serverBinding", server_binding)?;
        sync::validate_local_hash(local_model_hash)?;
        self.conn
            .query_row(
                "SELECT profile_id, local_model_hash, remote_model_id, client_upload_id,
                        etag, upload_status, created_at, updated_at, uploaded_at,
                        server_binding
                 FROM remote_model_links
                 WHERE profile_id = ?1 AND server_binding = ?2 AND local_model_hash = ?3",
                params![profile_id, server_binding, local_model_hash],
                remote_link_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn remote_model_links(
        &self,
        profile_id: &str,
        server_binding: &str,
        limit: usize,
    ) -> Result<Vec<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("serverBinding", server_binding)?;
        sync::validate_limit(limit)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT profile_id, local_model_hash, remote_model_id, client_upload_id,
                        etag, upload_status, created_at, updated_at, uploaded_at,
                        server_binding
                 FROM remote_model_links
                 WHERE profile_id = ?1 AND server_binding = ?2
                 ORDER BY local_model_hash LIMIT ?3",
            )
            .map_err(sql_error)?;
        let links = stmt
            .query_map(
                params![profile_id, server_binding, limit as i64],
                remote_link_from_row,
            )
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(links)
    }

    fn remove_remote_model_link(
        &mut self,
        profile_id: &str,
        server_binding: &str,
        local_model_hash: &str,
    ) -> Result<bool, String> {
        crate::sync::validate_profile(profile_id)?;
        crate::sync::validate_identifier("serverBinding", server_binding)?;
        crate::sync::validate_local_hash(local_model_hash)?;
        self.conn
            .execute(
                "DELETE FROM remote_model_links
                 WHERE profile_id = ?1 AND server_binding = ?2 AND local_model_hash = ?3",
                params![profile_id, server_binding, local_model_hash],
            )
            .map(|changed| changed > 0)
            .map_err(sql_error)
    }

    fn purge_remote_model_links(
        &mut self,
        profile_id: &str,
        server_binding: &str,
    ) -> Result<usize, String> {
        crate::sync::validate_profile(profile_id)?;
        crate::sync::validate_identifier("serverBinding", server_binding)?;
        self.conn
            .execute(
                "DELETE FROM remote_model_links
                 WHERE profile_id = ?1 AND server_binding = ?2",
                params![profile_id, server_binding],
            )
            .map_err(sql_error)
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

    fn pending_membership_delete(
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
                   AND operation_kind = 'Delete' AND state <> 'acked'
                   AND json_extract(payload_json, '$.collectionId') = ?2
                   AND json_extract(payload_json, '$.modelHash') = ?3
                 ORDER BY sequence LIMIT 1",
                params![profile_id, collection_local_id, model_hash],
                outbound_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn cancel_pending_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        let deleted = self
            .conn
            .execute(
                "DELETE FROM sync_outbox
                 WHERE profile_id = ?1 AND operation_id = ?2 AND state = 'pending'",
                params![profile_id, operation_id],
            )
            .map_err(sql_error)?;
        Ok(deleted > 0)
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
                            let profile_binding: String = self
                            .conn
                            .query_row(
                                "SELECT profile_binding FROM sync_profiles WHERE profile_id = ?1",
                                params![settlement.profile_id],
                                |row| row.get(0),
                            )
                            .unwrap_or_else(|_| "legacy-unbound".to_string());
                            self.remote_model_link(&settlement.profile_id, &profile_binding, hash)
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
                    // Push settlement confirms the server accepted our local
                    // state; it does not tell us where in the journal this
                    // change landed. Preserve whatever watermark the pull
                    // path already owns (0 for a first-time create) instead
                    // of stamping the batch's global server_revision here --
                    // see `existing_journal_revision` for why that would
                    // hide legitimate intervening writes on the next pull.
                    let journal_revision = self.existing_journal_revision(
                        &mapping.profile_id,
                        mapping.entity_type,
                        &mapping.remote_id,
                    )?;
                    self.upsert_entity_revision(mapping, journal_revision)?;
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

    // --- Calibration persistence (issue #52) ---------------------------------

    fn save_calibration_workspace_state(
        &mut self,
        input: &SaveCalibrationWorkspaceStateParams,
    ) -> Result<CalibrationWorkspaceStateDto, String> {
        if input.completed_step_count < 0
            || input.total_step_count < 0
            || input.completed_step_count > input.total_step_count
        {
            return Err("calibration workspace step counts are invalid".to_string());
        }

        let payload = serde_json::json!({
            "displayName": input.display_name,
            "description": input.description,
            "printerId": input.printer_id,
            "status": input.status,
            "workspaceState": input.workspace_state,
        });
        let payload_json = json_string(&payload)?;
        let workspace_state_json = json_string(&input.workspace_state)?;
        let operation_kind = if input.base_revision.is_some() {
            "Update"
        } else {
            "Create"
        };

        self.begin_batch()?;
        let result = (|| {
            let existing = self
                .conn
                .query_row(
                    "SELECT project_id, kind, entity_type, entity_id, operation_kind,
                            payload_json, idempotency_key, base_revision, created_at
                     FROM calibration_outbox
                     WHERE profile_id = ?1 AND operation_id = ?2",
                    params![input.profile_id, input.operation_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, Option<i64>>(7)?,
                            row.get::<_, String>(8)?,
                        ))
                    },
                )
                .optional()
                .map_err(sql_error)?;

            if let Some((
                project_id,
                kind,
                entity_type,
                entity_id,
                stored_operation_kind,
                stored_payload_json,
                idempotency_key,
                base_revision,
                created_at,
            )) = existing
            {
                if idempotency_key != input.idempotency_key {
                    return Err(
                        "operationId was already used with a different idempotencyKey".to_string(),
                    );
                }
                let stored_payload: serde_json::Value = serde_json::from_str(&stored_payload_json)
                    .map_err(|error| {
                        format!("stored calibration outbox payload is invalid: {error}")
                    })?;
                if project_id != input.project_id
                    || kind != "saveProjectDraft"
                    || entity_type != CalibrationEntityType::CalibrationProject.as_db()
                    || entity_id != input.project_id
                    || stored_operation_kind != operation_kind
                    || stored_payload != payload
                    || base_revision != input.base_revision
                    || created_at != input.created_at
                {
                    return Err(
                        "operationId replay does not match the immutable calibration payload"
                            .to_string(),
                    );
                }
                return self
                    .get_calibration_workspace_state(&input.profile_id, &input.project_id)?
                    .ok_or_else(|| {
                        "calibration operation exists without its workspace state".to_string()
                    });
            }

            self.conn
                .execute(
                    "INSERT INTO calibration_projects(
                        profile_id, project_id, display_name, description, status, printer_id,
                        is_synced, is_printer_context_fresh, base_revision, created_at, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10)
                     ON CONFLICT(profile_id, project_id) DO UPDATE SET
                        display_name = excluded.display_name,
                        description = excluded.description,
                        status = excluded.status,
                        printer_id = excluded.printer_id,
                        is_synced = 0,
                        is_printer_context_fresh = excluded.is_printer_context_fresh,
                        base_revision = COALESCE(
                            excluded.base_revision, calibration_projects.base_revision),
                        updated_at = excluded.updated_at",
                    params![
                        input.profile_id,
                        input.project_id,
                        input.display_name,
                        input.description,
                        input.status,
                        input.printer_id,
                        input.printer_context_fresh,
                        input.base_revision,
                        input.created_at,
                        input.updated_at,
                    ],
                )
                .map_err(sql_error)?;

            self.conn
                .execute(
                    "INSERT INTO calibration_workspace_states(
                        profile_id, project_id, workspace_state_json,
                        completed_step_count, total_step_count, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(profile_id, project_id) DO UPDATE SET
                        workspace_state_json = excluded.workspace_state_json,
                        completed_step_count = excluded.completed_step_count,
                        total_step_count = excluded.total_step_count,
                        updated_at = excluded.updated_at",
                    params![
                        input.profile_id,
                        input.project_id,
                        workspace_state_json,
                        input.completed_step_count,
                        input.total_step_count,
                        input.updated_at,
                    ],
                )
                .map_err(sql_error)?;

            self.conn
                .execute(
                    "UPDATE calibration_outbox
                     SET state = ?4, settled_at = ?5, updated_at = ?5
                     WHERE profile_id = ?1 AND project_id = ?2
                       AND kind = 'saveProjectDraft' AND state = ?3",
                    params![
                        input.profile_id,
                        input.project_id,
                        CalibrationOutboxState::Pending.as_db(),
                        CalibrationOutboxState::Superseded.as_db(),
                        input.updated_at,
                    ],
                )
                .map_err(sql_error)?;

            let sequence: i64 = self
                .conn
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) + 1
                     FROM calibration_outbox
                     WHERE profile_id = ?1 AND project_id = ?2",
                    params![input.profile_id, input.project_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            self.conn
                .execute(
                    "INSERT INTO calibration_outbox(
                        profile_id, operation_id, project_id, kind, sequence,
                        entity_type, entity_id, operation_kind, payload_json,
                        idempotency_key, base_revision, depends_on_json, state,
                        created_at, updated_at)
                     VALUES(?1, ?2, ?3, 'saveProjectDraft', ?4,
                            ?5, ?3, ?6, ?7, ?8, ?9, '[]', 'pending', ?10, ?11)",
                    params![
                        input.profile_id,
                        input.operation_id,
                        input.project_id,
                        sequence,
                        CalibrationEntityType::CalibrationProject.as_db(),
                        operation_kind,
                        payload_json,
                        input.idempotency_key,
                        input.base_revision,
                        input.created_at,
                        input.updated_at,
                    ],
                )
                .map_err(sql_error)?;

            self.get_calibration_workspace_state(&input.profile_id, &input.project_id)?
                .ok_or_else(|| "saved calibration workspace state could not be read".to_string())
        })();
        self.finish_batch(result)
    }

    fn list_calibration_workspace_states(
        &self,
        profile_id: &str,
    ) -> Result<Vec<CalibrationWorkspaceStateDto>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT p.profile_id, p.project_id, p.display_name, p.description,
                        p.printer_id, p.status, s.completed_step_count, s.total_step_count,
                        p.is_synced, p.is_printer_context_fresh, p.has_conflicts,
                        p.remote_project_id, p.base_revision, p.created_at, p.updated_at,
                        s.workspace_state_json
                 FROM calibration_projects p
                 JOIN calibration_workspace_states s
                   ON s.profile_id = p.profile_id AND s.project_id = p.project_id
                 WHERE p.profile_id = ?1
                 ORDER BY s.updated_at DESC, p.project_id ASC",
            )
            .map_err(sql_error)?;
        let states = stmt
            .query_map(params![profile_id], calibration_workspace_state_from_row)
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(states)
    }

    fn list_calibration_unhydrated_projects(
        &self,
        profile_id: &str,
    ) -> Result<Vec<CalibrationUnhydratedProjectDto>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT p.profile_id, p.project_id, p.display_name, p.description,
                        p.printer_id, p.status, p.is_synced,
                        p.is_printer_context_fresh, p.has_conflicts,
                        p.remote_project_id, p.base_revision, p.created_at, p.updated_at
                 FROM calibration_projects p
                 LEFT JOIN calibration_workspace_states s
                   ON s.profile_id = p.profile_id AND s.project_id = p.project_id
                 WHERE p.profile_id = ?1 AND s.project_id IS NULL
                   AND p.remote_project_id IS NOT NULL
                   AND p.base_revision IS NOT NULL
                   AND p.is_synced = 1
                 ORDER BY p.updated_at DESC, p.project_id ASC",
            )
            .map_err(sql_error)?;
        let projects = stmt
            .query_map(params![profile_id], |row| {
                Ok(CalibrationUnhydratedProjectDto {
                    profile_id: row.get(0)?,
                    project_id: row.get(1)?,
                    display_name: row.get(2)?,
                    description: row.get(3)?,
                    printer_id: row.get(4)?,
                    status: row.get(5)?,
                    is_synced: row.get::<_, i64>(6)? != 0,
                    is_printer_context_fresh: row.get::<_, i64>(7)? != 0,
                    has_conflicts: row.get::<_, i64>(8)? != 0,
                    remote_project_id: row.get(9)?,
                    base_revision: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    recovery_state: "migrationRequired".to_string(),
                })
            })
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        Ok(projects)
    }

    fn get_calibration_workspace_state(
        &self,
        profile_id: &str,
        project_id: &str,
    ) -> Result<Option<CalibrationWorkspaceStateDto>, String> {
        self.conn
            .query_row(
                "SELECT p.profile_id, p.project_id, p.display_name, p.description,
                        p.printer_id, p.status, s.completed_step_count, s.total_step_count,
                        p.is_synced, p.is_printer_context_fresh, p.has_conflicts,
                        p.remote_project_id, p.base_revision, p.created_at, p.updated_at,
                        s.workspace_state_json
                 FROM calibration_projects p
                 JOIN calibration_workspace_states s
                   ON s.profile_id = p.profile_id AND s.project_id = p.project_id
                 WHERE p.profile_id = ?1 AND p.project_id = ?2",
                params![profile_id, project_id],
                calibration_workspace_state_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn stage_calibration_photo(
        &mut self,
        input: &StageCalibrationPhotoParams,
    ) -> Result<StagedCalibrationPhotoDto, String> {
        if input.byte_size <= 0 || input.byte_size > 20_000_000 {
            return Err("staged calibration photo size is invalid".to_string());
        }
        if input.content_hash.len() != 64
            || !input
                .content_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("staged calibration photo content hash is invalid".to_string());
        }
        if !matches!(
            input.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err("staged calibration photo MIME type is invalid".to_string());
        }
        if input.local_path.is_empty() {
            return Err("staged calibration photo private path is missing".to_string());
        }
        if input.caption.is_empty() || input.caption.chars().count() > 512 {
            return Err("staged calibration photo caption is invalid".to_string());
        }
        if !(1..=1000).contains(&input.order) {
            return Err("staged calibration photo order is invalid".to_string());
        }

        let existing = self
            .conn
            .query_row(
                "SELECT photo_id, attempt_id, stage_id, project_id, profile_id,
                        content_hash, mime_type, byte_size, status, upload_attempts,
                        remote_photo_id, remote_url, staged_at, uploaded_at, caption, photo_order
                 FROM staged_calibration_photos
                 WHERE profile_id = ?1 AND photo_id = ?2",
                params![input.profile_id, input.photo_id],
                staged_calibration_photo_from_row,
            )
            .optional()
            .map_err(sql_error)?;
        if let Some(photo) = existing {
            if photo.attempt_id != input.attempt_id
                || photo.stage_id != input.stage_id
                || photo.project_id != input.project_id
                || photo.content_hash != input.content_hash
                || photo.mime_type != input.mime_type
                || photo.byte_size != input.byte_size
                || photo.caption != input.caption
                || photo.order != input.order
            {
                return Err(
                    "photoId was already staged with different immutable metadata".to_string(),
                );
            }
            return Ok(photo);
        }

        self.conn
            .execute(
                "INSERT INTO staged_calibration_photos(
                    profile_id, photo_id, attempt_id, stage_id, project_id,
                    content_hash, mime_type, byte_size, status, upload_attempts,
                    staged_at, local_path, caption, photo_order)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staged', 0, ?9, ?10, ?11, ?12)",
                params![
                    input.profile_id,
                    input.photo_id,
                    input.attempt_id,
                    input.stage_id.as_str(),
                    input.project_id,
                    input.content_hash,
                    input.mime_type,
                    input.byte_size,
                    input.staged_at,
                    input.local_path,
                    input.caption,
                    input.order,
                ],
            )
            .map_err(sql_error)?;

        self.conn
            .query_row(
                "SELECT photo_id, attempt_id, stage_id, project_id, profile_id,
                        content_hash, mime_type, byte_size, status, upload_attempts,
                        remote_photo_id, remote_url, staged_at, uploaded_at, caption, photo_order
                 FROM staged_calibration_photos
                 WHERE profile_id = ?1 AND photo_id = ?2",
                params![input.profile_id, input.photo_id],
                staged_calibration_photo_from_row,
            )
            .map_err(sql_error)
    }

    fn list_calibration_pending_ops(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CalibrationPendingOpDto>, String> {
        let pending = CalibrationOutboxState::Pending.as_db();
        let mut stmt = if project_id.is_some() {
            self.conn
                .prepare(
                    "SELECT operation_id, profile_id, project_id, kind, sequence,
                            base_revision, idempotency_key, entity_type, entity_id,
                            operation_kind, payload_json, depends_on_json
                     FROM calibration_outbox
                     WHERE profile_id = ?1 AND project_id = ?2
                       AND state = ?3
                     ORDER BY sequence ASC
                     LIMIT ?4",
                )
                .map_err(sql_error)?
        } else {
            self.conn
                .prepare(
                    "SELECT operation_id, profile_id, project_id, kind, sequence,
                            base_revision, idempotency_key, entity_type, entity_id,
                            operation_kind, payload_json, depends_on_json
                     FROM calibration_outbox
                     WHERE profile_id = ?1 AND state = ?2
                     ORDER BY sequence ASC
                     LIMIT ?3",
                )
                .map_err(sql_error)?
        };
        let limit_i64 = limit as i64;
        let rows: Vec<CalibrationPendingOpDto> = if let Some(pid) = project_id {
            stmt.query_map(
                params![profile_id, pid, pending, limit_i64],
                calibration_pending_op_from_row,
            )
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
        } else {
            stmt.query_map(
                params![profile_id, pending, limit_i64],
                calibration_pending_op_from_row,
            )
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
        };
        Ok(rows)
    }

    fn settle_calibration_op(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        server_revision: i64,
    ) -> Result<(), String> {
        let now = now_ts();
        self.conn
            .execute(
                "UPDATE calibration_outbox
                 SET state = ?3, server_revision = ?4, settled_at = ?5, updated_at = ?5
                 WHERE profile_id = ?1 AND operation_id = ?2",
                params![
                    profile_id,
                    operation_id,
                    CalibrationOutboxState::Settled.as_db(),
                    server_revision,
                    now
                ],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    fn replay_calibration_op(
        &mut self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        let now = now_ts();
        self.conn
            .execute(
                "UPDATE calibration_outbox
                 SET state = ?3, settled_at = ?4, updated_at = ?4
                 WHERE profile_id = ?1 AND operation_id = ?2",
                params![
                    profile_id,
                    operation_id,
                    CalibrationOutboxState::Replayed.as_db(),
                    now
                ],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_calibration_conflict(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        entity_type: &str,
        entity_id: &str,
        reason: &str,
        server_revision: i64,
        conflict_kind: Option<CalibrationConflictKind>,
    ) -> Result<(), String> {
        // Look up the project_id from the outbox operation.
        let project_id: Option<String> = self
            .conn
            .query_row(
                "SELECT project_id FROM calibration_outbox
                 WHERE profile_id = ?1 AND operation_id = ?2",
                params![profile_id, operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?
            .flatten();
        // An empty project_id cannot satisfy the calibration_projects foreign key.
        // Left to SQLite this surfaces as "FOREIGN KEY constraint failed", which
        // names nothing the sync engine or an operator can act on. Refuse here
        // instead, naming the operation whose project could not be resolved.
        let project_id = project_id.filter(|id| !id.is_empty()).ok_or_else(|| {
            format!(
                "cannot record calibration conflict: operation {operation_id} has no owning project",
            )
        })?;
        // The IPC contract declares conflictId as a UUID (CalibrationConflict in
        // src/shared/ipc.ts), and the main process parses the list response against
        // it. A "conflict-" prefix makes every recorded conflict unreadable.
        let conflict_id = uuid_v4_placeholder();
        let now = now_ts();
        self.conn
            .execute(
                // Plain INSERT, not INSERT OR IGNORE: conflict_id is freshly
                // generated so the primary key can never collide, which left
                // OR IGNORE with nothing to suppress. (It never suppressed the
                // foreign key failure above -- SQLite raises those regardless.)
                "INSERT INTO calibration_conflicts
                     (profile_id, conflict_id, project_id, kind, entity_id,
                      operation_id, server_revision, created_at, conflict_kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    profile_id,
                    conflict_id,
                    project_id,
                    entity_type,
                    entity_id,
                    operation_id,
                    server_revision,
                    now,
                    conflict_kind.map(conflict_kind_as_db)
                ],
            )
            .map(|_| ())
            .map_err(sql_error)?;
        // Also mark the outbox operation as conflicted
        self.conn
            .execute(
                "UPDATE calibration_outbox
                 SET state = 'conflict', last_error = ?3, updated_at = ?4
                 WHERE profile_id = ?1 AND operation_id = ?2",
                params![profile_id, operation_id, reason, now],
            )
            .map(|_| ())
            .map_err(sql_error)
    }

    /// Resolve a calibration conflict under the ratified policy (issue #216).
    ///
    /// Enforced here rather than in the adapter because three of the four
    /// rulings are invariants over stored rows. A renderer-side or adapter-side
    /// check is a convention that the next writer of a store method is free to
    /// bypass without noticing; a store-side check is a control.
    #[allow(clippy::type_complexity)]
    fn resolve_calibration_conflict(
        &mut self,
        params: &ResolveCalibrationConflictParams,
    ) -> Result<CalibrationConflictResolutionDto, String> {
        let row: Option<(
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            String,
        )> = self
            .conn
            .query_row(
                "SELECT project_id, conflict_kind, entity_id, resolved_at, resolution,
                        resolution_revision_id, server_revision, kind
                 FROM calibration_conflicts
                 WHERE profile_id = ?1 AND conflict_id = ?2",
                params![params.profile_id, params.conflict_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(sql_error)?;
        let (
            project_id,
            stored_kind,
            entity_id,
            resolved_at,
            stored_resolution,
            stored_revision_id,
            server_revision,
            entity_type,
        ) = row.ok_or_else(|| {
            format!(
                "{}: no calibration conflict {} exists for profile {}",
                calibration_resolution_error::NOT_FOUND,
                params.conflict_id,
                params.profile_id
            )
        })?;

        // The kind is read back from the store, never taken from the request.
        // A caller that supplied its own kind could choose the one whose policy
        // permits what it wanted to do, which would make the policy advisory.
        let kind: CalibrationConflictKind = stored_kind
            .as_deref()
            .and_then(|value| {
                serde_json::from_value(serde_json::Value::String(value.to_string())).ok()
            })
            .ok_or_else(|| {
                format!(
                    "{}: conflict {} stores entity type {:?} and no ratified conflict \
                     kind, so no per-kind resolution policy applies to it. Inferring a \
                     kind from the entity type would grant permissions nobody ratified \
                     (issue #219)",
                    calibration_resolution_error::UNCLASSIFIED,
                    params.conflict_id,
                    entity_type
                )
            })?;

        // Q4 (immutability) combined with Q3 (replay). A resolved conflict is
        // never rewritten. Replaying the *same* resolution is normal outbox
        // operation and returns the first attempt's result unchanged; asking for
        // a *different* one is the mutation the ruling forbids.
        if let Some(resolved_at) = resolved_at {
            let recorded = stored_resolution.as_deref().unwrap_or("");
            let requested = resolution_as_db(params.resolution);
            if recorded != requested {
                return Err(format!(
                    "{}: conflict {} was resolved as {} at {}; correcting a \
                     mis-resolution requires a new conflict record, because \
                     rewriting this one changes what an earlier unresolved-list \
                     query would have returned",
                    calibration_resolution_error::ALREADY_RESOLVED,
                    params.conflict_id,
                    recorded,
                    resolved_at
                ));
            }
            let supersedes_revision_id = match stored_revision_id.as_deref() {
                Some(revision_id) => self
                    .conn
                    .query_row(
                        "SELECT supersedes_revision_id FROM calibration_profile_revisions
                         WHERE profile_id = ?1 AND revision_id = ?2",
                        params![params.profile_id, revision_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(sql_error)?
                    .flatten(),
                None => None,
            };
            let superseded_observations =
                if params.resolution == CalibrationConflictResolutionKind::AcceptServer {
                    self.observations_superseded_by(
                        &params.profile_id,
                        &project_id,
                        server_revision,
                    )?
                } else {
                    Vec::new()
                };
            return Ok(CalibrationConflictResolutionDto {
                conflict_id: params.conflict_id.clone(),
                profile_id: params.profile_id.clone(),
                project_id,
                kind,
                resolution: params.resolution,
                resolved_at,
                revision_id: stored_revision_id,
                supersedes_revision_id,
                superseded_observations,
                replayed: true,
            });
        }

        // Per-kind permission, read from the ratified table in sync.rs. That
        // table existed with no caller until now (issue #219): a policy with no
        // reader cannot reject anything.
        if !kind.available_resolutions().contains(&params.resolution) {
            let permitted = kind
                .available_resolutions()
                .iter()
                .map(|value| resolution_as_db(*value))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{}: {} is not a permitted resolution for a {} conflict; permitted: {}",
                calibration_resolution_error::NOT_PERMITTED,
                resolution_as_db(params.resolution),
                conflict_kind_as_db(kind),
                permitted
            ));
        }

        if params.resolution == CalibrationConflictResolutionKind::ManualFieldMerge
            && params.merged_fields.is_none()
        {
            return Err(format!(
                "{}: a manualFieldMerge of conflict {} carries no merged fields, so \
                 it would record a merge that merged nothing",
                calibration_resolution_error::MERGED_FIELDS_REQUIRED,
                params.conflict_id
            ));
        }

        let now = now_ts();
        let mut revision_id: Option<String> = None;
        let mut supersedes_revision_id: Option<String> = None;

        // Q1. keepLocalAsNewRevision is not a resurrection. It mints a new
        // identity that *names* the deleted predecessor, and leaves the
        // predecessor deleted. Without the provenance link the row is
        // indistinguishable from an ordinary create, and the server's deletion
        // becomes unobservable: nobody could later separate "never deleted" from
        // "deleted, and a client put it back".
        if params.resolution == CalibrationConflictResolutionKind::KeepLocalAsNewRevision {
            let new_revision_id = uuid_v4_placeholder();
            self.conn
                .execute(
                    "INSERT INTO calibration_profile_revisions
                         (profile_id, revision_id, project_id, revision_label,
                          is_promoted, generated_at, supersedes_revision_id)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
                    params![
                        params.profile_id,
                        new_revision_id,
                        project_id,
                        format!("Local edit kept over server deletion of {entity_id}"),
                        now,
                        entity_id
                    ],
                )
                .map_err(sql_error)?;
            supersedes_revision_id = Some(entity_id.clone());
            revision_id = Some(new_revision_id);
        }

        // Q2. acceptServer reports; it does not cascade. Invalidating the
        // dependent observations here would destroy measurement work whose blast
        // radius is invisible at the moment of pressing. Staying silent is the
        // other failure: a snapshot accepted while superseded observations still
        // display as valid is one UI state consistent with two realities.
        let superseded_observations =
            if params.resolution == CalibrationConflictResolutionKind::AcceptServer {
                self.observations_superseded_by(&params.profile_id, &project_id, server_revision)?
            } else {
                Vec::new()
            };

        // Q3/Q4 guard, expressed in SQL as well as in the branch above. The
        // `resolved_at IS NULL` predicate is the control: if a concurrent writer
        // resolved this conflict between the SELECT and here, this UPDATE
        // matches no row and we refuse rather than overwrite.
        let updated = self
            .conn
            .execute(
                "UPDATE calibration_conflicts
                    SET resolved_at = ?3, resolution = ?4, resolution_revision_id = ?5,
                        resolution_payload = ?6
                  WHERE profile_id = ?1 AND conflict_id = ?2 AND resolved_at IS NULL",
                params![
                    params.profile_id,
                    params.conflict_id,
                    now,
                    resolution_as_db(params.resolution),
                    revision_id,
                    params
                        .merged_fields
                        .as_ref()
                        .map(|fields| fields.to_string())
                ],
            )
            .map_err(sql_error)?;
        if updated != 1 {
            return Err(format!(
                "{}: conflict {} was resolved concurrently, so this resolution was \
                 not applied",
                calibration_resolution_error::ALREADY_RESOLVED,
                params.conflict_id
            ));
        }

        Ok(CalibrationConflictResolutionDto {
            conflict_id: params.conflict_id.clone(),
            profile_id: params.profile_id.clone(),
            project_id,
            kind,
            resolution: params.resolution,
            resolved_at: now,
            revision_id,
            supersedes_revision_id,
            superseded_observations,
            replayed: false,
        })
    }

    fn get_calibration_cursor_state(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<CalibrationCursorStateDto, String> {
        if let Some(pid) = project_id {
            let row = self
                .conn
                .query_row(
                    "SELECT change_feed_cursor, base_revision, checkpoint_generation
                     FROM calibration_projects
                     WHERE profile_id = ?1 AND project_id = ?2",
                    params![profile_id, pid],
                    |row| {
                        Ok(CalibrationCursorStateDto {
                            cursor: row.get(0)?,
                            server_revision: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            checkpoint_generation: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(sql_error)?;
            Ok(row.unwrap_or(CalibrationCursorStateDto {
                cursor: None,
                server_revision: 0,
                checkpoint_generation: 0,
            }))
        } else {
            // Profile-wide cursor: use the minimum revision across all projects.
            let row = self
                .conn
                .query_row(
                    "SELECT MIN(base_revision), MIN(checkpoint_generation)
                     FROM calibration_projects WHERE profile_id = ?1",
                    params![profile_id],
                    |row| {
                        Ok(CalibrationCursorStateDto {
                            cursor: None,
                            server_revision: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                            checkpoint_generation: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        })
                    },
                )
                .optional()
                .map_err(sql_error)?;
            Ok(row.unwrap_or(CalibrationCursorStateDto {
                cursor: None,
                server_revision: 0,
                checkpoint_generation: 0,
            }))
        }
    }

    fn commit_calibration_cursor(
        &mut self,
        profile_id: &str,
        project_id: Option<&str>,
        cursor: Option<&str>,
        server_revision: i64,
        checkpoint_generation: i64,
    ) -> Result<(), String> {
        let now = now_ts();
        if let Some(pid) = project_id {
            self.conn
                .execute(
                    "UPDATE calibration_projects
                     SET change_feed_cursor = ?3, base_revision = ?4,
                         checkpoint_generation = ?5, updated_at = ?6
                     WHERE profile_id = ?1 AND project_id = ?2",
                    params![
                        profile_id,
                        pid,
                        cursor,
                        server_revision,
                        checkpoint_generation,
                        now
                    ],
                )
                .map(|_| ())
                .map_err(sql_error)
        } else {
            // Profile-wide cursor update: update all projects for this profile.
            self.conn
                .execute(
                    "UPDATE calibration_projects
                     SET change_feed_cursor = ?2, base_revision = ?3,
                         checkpoint_generation = ?4, updated_at = ?5
                     WHERE profile_id = ?1",
                    params![
                        profile_id,
                        cursor,
                        server_revision,
                        checkpoint_generation,
                        now
                    ],
                )
                .map(|_| ())
                .map_err(sql_error)
        }
    }

    fn apply_calibration_snapshot(
        &mut self,
        profile_id: &str,
        entity_type: &str,
        entity_id: &str,
        snapshot: Option<&serde_json::Value>,
        tombstone: bool,
        server_revision: i64,
    ) -> Result<(), String> {
        let now = now_ts();
        // For CalibrationProject entities, update the project record.
        // For other entity types, update the project's is_synced and base_revision
        // from the remote snapshot metadata if available.
        match entity_type {
            et if et == CalibrationEntityType::CalibrationProject.as_db() => {
                if tombstone {
                    // Tombstone: mark the project as deleted (if it exists locally)
                    // We don't physically delete; leave it for the UI to handle.
                    self.conn
                        .execute(
                            "UPDATE calibration_projects
                             SET is_synced = 0, status = 'deleted', base_revision = ?3, updated_at = ?4
                             WHERE profile_id = ?1 AND (project_id = ?2 OR remote_project_id = ?2)",
                            params![profile_id, entity_id, server_revision, now],
                        )
                        .map_err(sql_error)?;
                } else if let Some(snap) = snapshot {
                    let remote_project_id = snap
                        .get("id")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "remote calibration project is missing id".to_string())?;
                    if remote_project_id != entity_id {
                        return Err(
                            "remote calibration project identity does not match change".to_string()
                        );
                    }
                    let display_name = snap
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| {
                            "remote calibration project is missing displayName".to_string()
                        })?;
                    let description = snap.get("description").and_then(|v| v.as_str());
                    let status = snap.get("status").and_then(|v| v.as_str()).ok_or_else(|| {
                        "remote calibration project is missing status".to_string()
                    })?;
                    let printer_id =
                        snap.get("printerId")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| {
                                "remote calibration project is missing printerId".to_string()
                            })?;
                    let project_revision = snap
                        .get("revision")
                        .and_then(|v| v.as_i64())
                        .ok_or_else(|| {
                            "remote calibration project is missing revision".to_string()
                        })?;
                    let created_at =
                        snap.get("createdAt")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| {
                                "remote calibration project is missing createdAt".to_string()
                            })?;
                    let updated_at =
                        snap.get("updatedAt")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| {
                                "remote calibration project is missing updatedAt".to_string()
                            })?;
                    let updated = self
                        .conn
                        .execute(
                            "UPDATE calibration_projects
                             SET display_name = ?3, description = ?4, status = ?5,
                                is_synced = CASE WHEN EXISTS(
                                    SELECT 1 FROM calibration_outbox o
                                    WHERE o.profile_id = calibration_projects.profile_id
                                      AND o.project_id = calibration_projects.project_id
                                      AND o.state = 'pending'
                                ) THEN 0 ELSE 1 END,
                                remote_project_id = ?6, base_revision = ?7, updated_at = ?8
                             WHERE profile_id = ?1
                               AND (project_id = ?2 OR remote_project_id = ?2)",
                            params![
                                profile_id,
                                entity_id,
                                display_name,
                                description,
                                status,
                                remote_project_id,
                                project_revision,
                                updated_at,
                            ],
                        )
                        .map_err(sql_error)?;
                    if updated == 0 {
                        self.conn
                            .execute(
                                "INSERT INTO calibration_projects(
                                   profile_id, project_id, display_name, description,
                                   status, printer_id, is_synced,
                                   is_printer_context_fresh, has_conflicts,
                                   remote_project_id, base_revision, created_at, updated_at)
                                VALUES(?1, ?2, ?3, ?4, ?5, ?6, 1, 0, 0, ?2, ?7, ?8, ?9)",
                                params![
                                    profile_id,
                                    remote_project_id,
                                    display_name,
                                    description,
                                    status,
                                    printer_id,
                                    project_revision,
                                    created_at,
                                    updated_at,
                                ],
                            )
                            .map_err(sql_error)?;
                    }

                    if let Some(workspace_state) =
                        snap.get("workspaceState").filter(|value| !value.is_null())
                    {
                        let (completed_step_count, total_step_count, derived_status) =
                            calibration_workspace_projection(workspace_state)?;
                        let workspace_project_id = workspace_state
                            .get("domainState")
                            .and_then(|value| value.get("projectId"))
                            .and_then(|value| value.as_str())
                            .ok_or_else(|| {
                                "remote calibration workspace is missing projectId".to_string()
                            })?;
                        if workspace_project_id != remote_project_id {
                            return Err(
                                "remote calibration workspace project identity does not match"
                                    .to_string(),
                            );
                        }
                        let workspace_json = json_string(workspace_state)?;
                        self.conn
                            .execute(
                                "UPDATE calibration_projects
                                SET status = ?3
                                WHERE profile_id = ?1
                                  AND (project_id = ?2 OR remote_project_id = ?2)",
                                params![profile_id, remote_project_id, derived_status],
                            )
                            .map_err(sql_error)?;
                        let local_project_id: String = self
                            .conn
                            .query_row(
                                "SELECT project_id FROM calibration_projects
                                WHERE profile_id = ?1
                                  AND (project_id = ?2 OR remote_project_id = ?2)
                                LIMIT 1",
                                params![profile_id, remote_project_id],
                                |row| row.get(0),
                            )
                            .map_err(sql_error)?;
                        self.conn
                            .execute(
                                "INSERT INTO calibration_workspace_states(
                                   profile_id, project_id, workspace_state_json,
                                   completed_step_count, total_step_count, updated_at)
                                VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                                ON CONFLICT(profile_id, project_id) DO UPDATE SET
                                   workspace_state_json = excluded.workspace_state_json,
                                   completed_step_count = excluded.completed_step_count,
                                   total_step_count = excluded.total_step_count,
                                   updated_at = excluded.updated_at",
                                params![
                                    profile_id,
                                    local_project_id,
                                    workspace_json,
                                    completed_step_count,
                                    total_step_count,
                                    updated_at,
                                ],
                            )
                            .map_err(sql_error)?;
                    }
                }
            }
            _ => {
                // For other entity types, just mark the project as synced
                // (we track the high-water revision in the project row).
                if let Some(snap) = snapshot {
                    let project_id = snap.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
                    if !project_id.is_empty() {
                        self.conn
                            .execute(
                                "UPDATE calibration_projects
                                 SET base_revision = MAX(COALESCE(base_revision, 0), ?3),
                                     updated_at = ?4
                                 WHERE profile_id = ?1
                                   AND (project_id = ?2 OR remote_project_id = ?2)",
                                params![profile_id, project_id, server_revision, now],
                            )
                            .map_err(sql_error)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn list_calibration_conflicts(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<Vec<CalibrationConflictDto>, String> {
        let mut stmt = if project_id.is_some() {
            self.conn
                .prepare(
                    "SELECT conflict_id, profile_id, project_id, kind, entity_id,
                            operation_id, local_payload_json, server_payload_json,
                            server_revision, created_at
                     FROM calibration_conflicts
                     WHERE profile_id = ?1 AND project_id = ?2 AND resolved_at IS NULL
                     ORDER BY created_at ASC",
                )
                .map_err(sql_error)?
        } else {
            self.conn
                .prepare(
                    "SELECT conflict_id, profile_id, project_id, kind, entity_id,
                            operation_id, local_payload_json, server_payload_json,
                            server_revision, created_at
                     FROM calibration_conflicts
                     WHERE profile_id = ?1 AND resolved_at IS NULL
                     ORDER BY created_at ASC",
                )
                .map_err(sql_error)?
        };
        let rows = if let Some(pid) = project_id {
            stmt.query_map(params![profile_id, pid], calibration_conflict_from_row)
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
        } else {
            stmt.query_map(params![profile_id], calibration_conflict_from_row)
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
        };
        Ok(rows)
    }

    fn count_calibration_pending_ops(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<i64, String> {
        let pending = CalibrationOutboxState::Pending.as_db();
        if let Some(pid) = project_id {
            self.conn
                .query_row(
                    "SELECT COUNT(*) FROM calibration_outbox
                     WHERE profile_id = ?1 AND project_id = ?2 AND state = ?3",
                    params![profile_id, pid, pending],
                    |row| row.get(0),
                )
                .map_err(sql_error)
        } else {
            self.conn
                .query_row(
                    "SELECT COUNT(*) FROM calibration_outbox
                     WHERE profile_id = ?1 AND state = ?2",
                    params![profile_id, pending],
                    |row| row.get(0),
                )
                .map_err(sql_error)
        }
    }

    fn is_printer_context_fresh(&self, profile_id: &str, project_id: &str) -> Result<bool, String> {
        let result: Option<i64> = self
            .conn
            .query_row(
                "SELECT is_printer_context_fresh FROM calibration_projects
                 WHERE profile_id = ?1 AND project_id = ?2",
                params![profile_id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        Ok(result.unwrap_or(0) != 0)
    }
}

fn calibration_workspace_projection(
    workspace_state: &serde_json::Value,
) -> Result<(i64, i64, &'static str), String> {
    const STAGE_IDS: [&str; 9] = [
        "temperature",
        "flowPass1",
        "flowPass2",
        "pressureAdvance",
        "flowVerification",
        "retraction",
        "maximumVolumetricSpeed",
        "shrinkage",
        "finalVerification",
    ];
    let domain = workspace_state
        .get("domainState")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "remote calibration workspace is missing domainState".to_string())?;
    let stages = domain
        .get("stages")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "remote calibration workspace is missing stages".to_string())?;
    if stages.len() != STAGE_IDS.len() {
        return Err("remote calibration workspace must contain exactly nine stages".to_string());
    }
    let mut completed = 0_i64;
    let mut all_resolved = true;
    for stage_id in STAGE_IDS {
        let stage = stages
            .get(stage_id)
            .and_then(|value| value.as_object())
            .ok_or_else(|| format!("remote calibration workspace is missing stage {stage_id}"))?;
        if stage.get("stageId").and_then(|value| value.as_str()) != Some(stage_id) {
            return Err(format!(
                "remote calibration workspace stage identity does not match {stage_id}"
            ));
        }
        match stage.get("status").and_then(|value| value.as_str()) {
            Some("completed") => completed += 1,
            Some("skipped") => {}
            Some("notStarted") | Some("inProgress") | Some("needsRetest") => all_resolved = false,
            _ => {
                return Err(format!(
                    "remote calibration workspace stage {stage_id} has invalid status"
                ))
            }
        }
    }
    let has_attempts = domain
        .get("attempts")
        .and_then(|value| value.as_array())
        .is_some_and(|attempts| !attempts.is_empty());
    let has_history = domain
        .get("history")
        .and_then(|value| value.as_array())
        .is_some_and(|history| !history.is_empty());
    let status = if all_resolved {
        "complete"
    } else if has_attempts || has_history {
        "inProgress"
    } else {
        "draft"
    };
    Ok((completed, 9, status))
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
        ModelFormat::Step => "step",
    }
}

fn format_from_db(value: &str) -> ModelFormat {
    match value {
        "threeMf" => ModelFormat::ThreeMf,
        "obj" => ModelFormat::Obj,
        "step" => ModelFormat::Step,
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

// --- Calibration row helpers -------------------------------------------------

fn calibration_workspace_state_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<CalibrationWorkspaceStateDto> {
    let workspace_state_json: String = row.get(15)?;
    let workspace_state = serde_json::from_str(&workspace_state_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(15, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CalibrationWorkspaceStateDto {
        profile_id: row.get(0)?,
        project_id: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        printer_id: row.get(4)?,
        status: row.get(5)?,
        completed_step_count: row.get(6)?,
        total_step_count: row.get(7)?,
        is_synced: row.get::<_, i64>(8)? != 0,
        is_printer_context_fresh: row.get::<_, i64>(9)? != 0,
        has_conflicts: row.get::<_, i64>(10)? != 0,
        remote_project_id: row.get(11)?,
        base_revision: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        workspace_state,
    })
}

fn calibration_pending_op_from_row(row: &Row<'_>) -> rusqlite::Result<CalibrationPendingOpDto> {
    let payload_json: String = row.get(10)?;
    let depends_on_json: String = row.get(11)?;
    let payload = serde_json::from_str(&payload_json)
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let depends_on: Vec<String> = serde_json::from_str(&depends_on_json).unwrap_or_default();
    Ok(CalibrationPendingOpDto {
        operation_id: row.get(0)?,
        profile_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: row.get(3)?,
        sequence: row.get(4)?,
        base_revision: row.get(5)?,
        idempotency_key: row.get(6)?,
        entity_type: row.get(7)?,
        entity_id: row.get(8)?,
        operation_kind: row.get(9)?,
        payload,
        depends_on,
    })
}

fn staged_calibration_photo_from_row(row: &Row<'_>) -> rusqlite::Result<StagedCalibrationPhotoDto> {
    let raw_stage_id: String = row.get(2)?;
    let stage_id =
        CalibrationWorkspaceStageId::try_from(raw_stage_id.as_str()).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
            )
        })?;
    Ok(StagedCalibrationPhotoDto {
        photo_id: row.get(0)?,
        attempt_id: row.get(1)?,
        stage_id,
        project_id: row.get(3)?,
        profile_id: row.get(4)?,
        content_hash: row.get(5)?,
        mime_type: row.get(6)?,
        byte_size: row.get(7)?,
        status: row.get(8)?,
        upload_attempts: row.get(9)?,
        remote_photo_id: row.get(10)?,
        remote_url: row.get(11)?,
        staged_at: row.get(12)?,
        uploaded_at: row.get(13)?,
        caption: row.get(14)?,
        order: row.get(15)?,
    })
}

fn calibration_conflict_from_row(row: &Row<'_>) -> rusqlite::Result<CalibrationConflictDto> {
    let local_payload_json: Option<String> = row.get(6)?;
    let server_payload_json: Option<String> = row.get(7)?;
    let local_payload = local_payload_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let server_payload = server_payload_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    Ok(CalibrationConflictDto {
        conflict_id: row.get(0)?,
        profile_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: row.get(3)?,
        entity_id: row.get(4)?,
        operation_id: row.get(5)?,
        local_payload,
        server_payload,
        server_revision: row.get(8)?,
        created_at: row.get(9)?,
    })
}

/// Serialize a conflict kind to its stored form.
///
/// Goes through serde rather than a hand-written `match` so the stored string
/// can never drift from the wire form the renderer parses. A second mapping
/// would be a second place to be wrong.
fn conflict_kind_as_db(kind: CalibrationConflictKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(value)) => value,
        _ => String::new(),
    }
}

/// Serialize a resolution kind to its stored form. See [`conflict_kind_as_db`].
fn resolution_as_db(resolution: CalibrationConflictResolutionKind) -> String {
    match serde_json::to_value(resolution) {
        Ok(serde_json::Value::String(value)) => value,
        _ => String::new(),
    }
}

/// Simple UUID v4 placeholder for conflict IDs.
/// Uses a combination of the current time and a counter for uniqueness.
fn uuid_v4_placeholder() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 32) as u32,
        (nanos >> 16) as u16,
        nanos as u16 & 0x0fff,
        (seq & 0x3fff) | 0x8000,
        seq & 0x0000_ffff_ffff
    )
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
        server_binding: row.get(9)?,
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
    fn upgrades_v5_adds_favorites_table_and_preserves_models() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v5.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.execute_batch(SCHEMA_V4).unwrap();
            conn.execute_batch(SCHEMA_V5).unwrap();
            conn.execute(
                "INSERT INTO source_roots(id, path, created_at, updated_at)
                 VALUES('root', 'C:\\\\models', '1', '1')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO models(hash, format, size_bytes, scene_version, parse_status, created_at, updated_at)
                 VALUES('hash-a', 'stl', 111, NULL, 'ready', '1', '1'),
                       ('hash-b', 'obj', 222, NULL, 'ready', '1', '1')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO model_locations(
                    root_id, path, root_relative, model_hash, size_bytes, modified_unix_secs, available, last_seen_at)
                 VALUES
                    ('root', 'C:\\\\models\\\\alpha.stl', 'alpha.stl', 'hash-a', 111, 11, 1, '1'),
                    ('root', 'C:\\\\models\\\\beta.obj', 'beta.obj', 'hash-b', 222, 22, 1, '1')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }

        let mut store = SqliteCatalog::open(&db).unwrap();
        let models = store.models();
        assert_eq!(models.len(), 2);
        assert_eq!(
            models
                .iter()
                .map(|model| model.hash.as_str())
                .collect::<Vec<_>>(),
            vec!["hash-a", "hash-b"]
        );
        assert_eq!(
            models
                .iter()
                .map(|model| model.locations[0]
                    .root_relative
                    .to_string_lossy()
                    .into_owned())
                .collect::<Vec<_>>(),
            vec!["alpha.stl".to_string(), "beta.obj".to_string()]
        );

        let favorites_table_exists: bool = store
            .conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'favorite_models')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(favorites_table_exists);

        let favorite_columns = store
            .conn
            .prepare("PRAGMA table_info(favorite_models)")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(5)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            favorite_columns,
            vec![
                ("model_hash".to_string(), "TEXT".to_string(), 0, 1),
                ("created_at".to_string(), "TEXT".to_string(), 1, 0),
            ]
        );

        let favorite_foreign_keys = store
            .conn
            .prepare("PRAGMA foreign_key_list(favorite_models)")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            favorite_foreign_keys,
            vec![(
                "models".to_string(),
                "model_hash".to_string(),
                "hash".to_string(),
                "NO ACTION".to_string(),
                "CASCADE".to_string(),
            )]
        );

        let foreign_keys_enabled: bool = store
            .conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert!(foreign_keys_enabled);

        assert!(store.add_favorite("hash-a"));
        assert_eq!(store.favorite_hashes(), vec!["hash-a".to_string()]);
        assert!(!store.add_favorite("missing"));

        let err = store
            .conn
            .execute(
                "INSERT INTO favorite_models(model_hash, created_at) VALUES(?1, ?2)",
                params!["missing", "2"],
            )
            .unwrap_err();
        match err {
            rusqlite::Error::SqliteFailure(sql_err, Some(message))
                if sql_err.code == rusqlite::ErrorCode::ConstraintViolation
                    && message.contains("FOREIGN KEY constraint failed") => {}
            other => panic!("expected SQLite foreign key violation, got {other:?}"),
        }

        store.remove_favorite("hash-a");
        assert!(store.favorite_hashes().is_empty());

        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
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
    fn v7_tag_migration_preserves_favorites_assignments_and_duplicate_names() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v6-tags.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.execute_batch(SCHEMA_V4).unwrap();
            conn.execute_batch(SCHEMA_V5).unwrap();
            conn.execute_batch(SCHEMA_V6).unwrap();
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
            conn.execute(
                "INSERT INTO favorite_models(model_hash, created_at) VALUES('hash', '1')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
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
        assert_eq!(store.favorite_hashes(), vec!["hash".to_string()]);
    }

    #[test]
    fn v10_upgrade_adds_binding_cas_revision_and_backfills_legacy_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v9-binding.sqlite3");
        let legacy_binding = "a".repeat(64);
        {
            let conn = Connection::open(&db).unwrap();
            for ddl in [
                SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7,
                SCHEMA_V8, SCHEMA_V9,
            ] {
                conn.execute_batch(ddl).unwrap();
            }
            conn.execute(
                "INSERT INTO sync_profiles(profile_id, profile_binding) VALUES('p', ?1)",
                params![legacy_binding],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 9).unwrap();
            // A genuine prior-V10 database must not yet carry the CAS column;
            // V9 stays immutable so the column can only arrive via V10.
            assert!(conn
                .prepare("SELECT binding_cas_revision FROM sync_profiles")
                .is_err());
        }

        // Prior-V10 upgrade: opening runs V10, adds the column, backfills the
        // `:1` incarnation suffix, and stamps the current version.
        let store = SqliteCatalog::open(&db).unwrap();
        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let (binding, cas_revision): (String, i64) = store
            .conn
            .query_row(
                "SELECT profile_binding, binding_cas_revision
                 FROM sync_profiles WHERE profile_id = 'p'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(binding, format!("{legacy_binding}:1"));
        assert_eq!(cas_revision, 0);
        drop(store);

        // Repeat open is idempotent: the ALTER does not run twice and the
        // length-gated backfill does not double-suffix an already-migrated row.
        let store = SqliteCatalog::open(&db).unwrap();
        let repeat_binding: String = store
            .conn
            .query_row(
                "SELECT profile_binding FROM sync_profiles WHERE profile_id = 'p'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repeat_binding, format!("{legacy_binding}:1"));
    }

    #[test]
    fn fresh_open_reports_binding_cas_revision_column() {
        let store = SqliteCatalog::open_in_memory().unwrap();
        store
            .conn
            .execute("INSERT INTO sync_profiles(profile_id) VALUES('p')", [])
            .unwrap();
        let cas_revision: i64 = store
            .conn
            .query_row(
                "SELECT binding_cas_revision FROM sync_profiles WHERE profile_id = 'p'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cas_revision, 0);
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
    fn v7_migrates_links_as_unbound_and_allows_binding_parity() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v6-links.sqlite3");
        let hash = "a".repeat(64);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.execute_batch(SCHEMA_V4).unwrap();
            conn.execute_batch(SCHEMA_V5).unwrap();
            migrate_v5_fencing(&conn).unwrap();
            conn.execute_batch(SCHEMA_V6).unwrap();
            conn.execute("INSERT INTO sync_profiles(profile_id) VALUES('p')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO models(hash, format, size_bytes, parse_status, created_at, updated_at)
                 VALUES(?1, 'stl', 1, 'ready', '1', '1')",
                params![hash],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO favorite_models(model_hash, created_at) VALUES(?1, '1')",
                params![hash],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO remote_model_links(
                        profile_id, local_model_hash, remote_model_id, client_upload_id,
                        upload_status, created_at, updated_at, uploaded_at)
                     VALUES('p', ?1, 'remote-a', 'upload-a', 'uploaded', 1, 1, 1)",
                params![hash],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
        }

        let mut store = SqliteCatalog::open(&db).unwrap();
        assert_eq!(store.favorite_hashes(), vec![hash.clone()]);
        let legacy = store
            .remote_model_link("p", "legacy-unbound", &hash)
            .unwrap()
            .unwrap();
        assert_eq!(legacy.server_binding, "legacy-unbound");
        store
            .link_remote_model(RemoteModelLinkDto {
                profile_id: "p".to_string(),
                server_binding: "binding-new".to_string(),
                local_model_hash: hash.clone(),
                remote_model_id: "remote-a".to_string(),
                client_upload_id: "upload-a".to_string(),
                etag: None,
                upload_status: RemoteUploadStatus::Uploaded,
                created_at: 1,
                updated_at: 1,
                uploaded_at: Some(1),
            })
            .unwrap();
        assert!(store
            .remote_model_link("p", "binding-new", &hash)
            .unwrap()
            .is_some());
        assert!(store
            .remote_model_link("p", "legacy-unbound", &hash)
            .unwrap()
            .is_some());
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
    fn settlement_preserves_journal_revision_so_intervening_pull_is_not_skipped() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Dragons", "profile-a", "binding-a", 2)
            .unwrap();
        let queued = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        let remote_id = queued[0].payload["remoteId"].as_str().unwrap().to_string();

        // Settle the push at a very high global server_revision, simulating
        // a batch that lands late in the server's overall journal.
        let claim = store
            .claim_outbound_operations("profile-a", 1, 100, 10)
            .unwrap()
            .unwrap();
        let operation_id = claim.operations[0].operation_id.clone();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: claim.batch_id,
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 101,
                server_revision: 500,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id,
                    remote_id: remote_id.clone(),
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        // The settlement must not have stamped the per-entity pull-journal
        // watermark with the batch's global server_revision (500) -- this
        // entity has never been pulled, so it must remain 0.
        assert_eq!(
            store
                .existing_journal_revision("profile-a", SyncEntityType::ModelCollection, &remote_id)
                .unwrap(),
            0
        );

        // An intervening writer's genuine update, arriving on the next pull
        // with a journal_revision far below the settlement's server_revision,
        // must still be applied instead of being silently skipped as
        // "already seen" (which is what happens if settlement had wrongly
        // advanced the watermark to 500).
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "profile-a".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("cursor-1".to_string()),
                server_revision: 500,
                applied_at: 200,
                entities: vec![crate::sync::PullEntityDto {
                    entity_type: SyncEntityType::ModelCollection,
                    local_id: Some(collection.id.clone()),
                    remote_id: remote_id.clone(),
                    revision: 2,
                    journal_revision: 2,
                    concurrency_token: Some("token-2".to_string()),
                    tombstone: false,
                    visibility: SyncVisibility::Private,
                    snapshot: Some(serde_json::json!({
                        "id": remote_id,
                        "name": "Dragons Updated",
                        "description": null,
                        "ownerUserId": null,
                        "isShared": false,
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-02T00:00:00Z",
                        "memberCount": 0,
                        "modelIds": [],
                        "revision": 2,
                        "concurrencyToken": "token-2"
                    })),
                }],
                conflicts: vec![],
            })
            .unwrap();

        let entities = store.entity_revisions("profile-a", None, 500).unwrap();
        let updated = entities
            .iter()
            .find(|entity| entity.remote_id == remote_id)
            .expect("intervening pull update must not be skipped");
        assert_eq!(updated.revision, 2);
    }

    #[test]
    fn sqlite_remove_then_add_coalesces_a_pending_membership_delete_to_zero_operations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        let collection_claim = store
            .claim_outbound_operations("profile-a", 10, 3, 30)
            .unwrap()
            .unwrap();
        let collection_remote_id = collection_claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: collection_claim.batch_id,
                batch_incarnation: collection_claim.batch_incarnation,
                lease_token: collection_claim.lease_token,
                settled_at: 4,
                server_revision: 1,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: collection_claim.operations[0].operation_id.clone(),
                    remote_id: collection_remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();
        store
            .link_remote_model(crate::sync::RemoteModelLinkDto {
                profile_id: "profile-a".to_string(),
                server_binding: "binding-a".to_string(),
                local_model_hash: hash.clone(),
                remote_model_id: "remote-model".to_string(),
                client_upload_id: "upload-a".to_string(),
                etag: None,
                upload_status: crate::sync::RemoteUploadStatus::Pending,
                created_at: 5,
                updated_at: 5,
                uploaded_at: None,
            })
            .unwrap();
        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 6)
            .unwrap());
        let membership_claim = store
            .claim_outbound_operations("profile-a", 10, 7, 30)
            .unwrap()
            .unwrap();
        let membership_remote_id = membership_claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: membership_claim.batch_id,
                batch_incarnation: membership_claim.batch_incarnation,
                lease_token: membership_claim.lease_token,
                settled_at: 8,
                server_revision: 2,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: membership_claim.operations[0].operation_id.clone(),
                    remote_id: membership_remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        store
            .remove_model_from_collection_with_sync(
                &collection.id,
                &hash,
                "profile-a",
                "binding-a",
                9,
            )
            .unwrap();
        let pending_delete = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(pending_delete.len(), 1);
        assert_eq!(
            pending_delete[0].operation,
            crate::sync::SyncOperationKind::Delete
        );

        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 10)
            .unwrap());
        let pending = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert!(
            pending.is_empty(),
            "re-adding before the delete is claimed should cancel the pending delete instead of queueing a compensating create"
        );
        assert!(store
            .collections_for_model(&hash)
            .iter()
            .any(|value| value.id == collection.id));
    }

    #[test]
    fn sqlite_remove_then_add_preserves_a_claimed_delete_and_queues_a_create() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        let collection_claim = store
            .claim_outbound_operations("profile-a", 10, 3, 30)
            .unwrap()
            .unwrap();
        let collection_remote_id = collection_claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: collection_claim.batch_id,
                batch_incarnation: collection_claim.batch_incarnation,
                lease_token: collection_claim.lease_token,
                settled_at: 4,
                server_revision: 1,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: collection_claim.operations[0].operation_id.clone(),
                    remote_id: collection_remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();
        store
            .link_remote_model(crate::sync::RemoteModelLinkDto {
                profile_id: "profile-a".to_string(),
                server_binding: "binding-a".to_string(),
                local_model_hash: hash.clone(),
                remote_model_id: "remote-model".to_string(),
                client_upload_id: "upload-a".to_string(),
                etag: None,
                upload_status: crate::sync::RemoteUploadStatus::Pending,
                created_at: 5,
                updated_at: 5,
                uploaded_at: None,
            })
            .unwrap();
        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 6)
            .unwrap());
        let membership_claim = store
            .claim_outbound_operations("profile-a", 10, 7, 30)
            .unwrap()
            .unwrap();
        let membership_remote_id = membership_claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: membership_claim.batch_id,
                batch_incarnation: membership_claim.batch_incarnation,
                lease_token: membership_claim.lease_token,
                settled_at: 8,
                server_revision: 2,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: membership_claim.operations[0].operation_id.clone(),
                    remote_id: membership_remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        store
            .remove_model_from_collection_with_sync(
                &collection.id,
                &hash,
                "profile-a",
                "binding-a",
                9,
            )
            .unwrap();
        let delete_claim = store
            .claim_outbound_operations("profile-a", 10, 10, 30)
            .unwrap()
            .unwrap();
        assert_eq!(
            delete_claim.operations[0].operation,
            crate::sync::SyncOperationKind::Delete
        );

        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 11)
            .unwrap());
        let inflight = store
            .outbound_operations("profile-a", &[OutboundState::InFlight], 500)
            .unwrap();
        assert_eq!(inflight.len(), 1);
        assert_eq!(
            inflight[0].operation,
            crate::sync::SyncOperationKind::Delete
        );
        let pending = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].entity_type,
            SyncEntityType::ModelCollectionMembership
        );
        assert_eq!(pending[0].operation, crate::sync::SyncOperationKind::Create);
    }

    #[test]
    fn replace_sync_profile_binding_replay_is_idempotent_and_does_not_rewipe() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store
            .bind_sync_profile("profile-a", "old-binding", 1)
            .unwrap();
        store
            .create_collection_with_sync("Stale", "profile-a", "old-binding", 2)
            .unwrap();
        // Settle the push so the collection is actually materialized under
        // `old-binding` (an unsettled local create has no sync profile
        // association yet, so rebinding would have nothing to purge).
        let claim = store
            .claim_outbound_operations("profile-a", 10, 3, 30)
            .unwrap()
            .unwrap();
        // Settlement must confirm the same client-generated remote id
        // provisioned at create time, or the local id would end up mapped
        // to two different remote ids, which the settlement preflight
        // correctly rejects as a sibling-mapping conflict.
        let remote_id = claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: claim.batch_id,
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 4,
                server_revision: 1,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: claim.operations[0].operation_id.clone(),
                    remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        store
            .replace_sync_profile_binding("profile-a", "old-binding", "new-binding", 5)
            .unwrap();
        assert!(
            store.all_collections().is_empty(),
            "stale binding's collections must be purged once"
        );

        let survivor = store
            .create_collection_with_sync("Survivor", "profile-a", "new-binding", 4)
            .unwrap();

        // Replaying the exact same transition (e.g. a scheduler tick retry
        // after a crash before the transition was acknowledged) must succeed
        // as a no-op rather than treating the now-stale `expected_binding` as
        // a CAS failure, and it must not re-run the destructive
        // collection/tag wipe against data that already belongs to the new
        // binding.
        store
            .replace_sync_profile_binding("profile-a", "old-binding", "new-binding", 5)
            .unwrap();
        assert!(store
            .all_collections()
            .iter()
            .any(|collection| collection.id == survivor.id));
    }

    #[test]
    fn replace_sync_profile_binding_rejects_stale_cas_without_wiping_data() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        store
            .bind_sync_profile("profile-a", "binding-1", 1)
            .unwrap();
        store
            .replace_sync_profile_binding("profile-a", "binding-1", "binding-2", 2)
            .unwrap();
        let survivor = store
            .create_collection_with_sync("Survivor", "profile-a", "binding-2", 3)
            .unwrap();

        // A second writer, still racing off the original `binding-1`
        // expectation, must be rejected by CAS now that an intervening
        // writer already advanced the binding to `binding-2` -- and must not
        // clobber `binding-2`'s already-materialized data in the process.
        let result = store.replace_sync_profile_binding("profile-a", "binding-1", "binding-3", 4);
        assert!(result.is_err());
        assert!(store
            .all_collections()
            .iter()
            .any(|collection| collection.id == survivor.id));
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
    fn reset_catalog_is_transactional_and_preserves_unrelated_state() {
        let dir = tempfile::tempdir().unwrap();
        let model_path = dir.path().join("m.stl");
        write(&model_path, b"bytes");
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(dir.path()));
        store.ensure_root("empty", Path::new("/models/empty"));
        let hash = store.models()[0].hash.clone();
        store.add_favorite(&hash);
        store.add_model_tag(&hash, "Keep tag").unwrap();
        let collection = store.create_collection("Keep collection").unwrap();
        store.add_model_to_collection(&collection.id, &hash);
        store
            .conn
            .execute(
                "INSERT INTO thumbnails(model_hash, recipe, path, width, height, source)
                 VALUES(?1, 'grid', '/thumb.png', 64, 64, 'rendered')",
                params![hash],
            )
            .unwrap();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO calibration_projects(
                    profile_id, project_id, display_name, status, printer_id,
                    created_at, updated_at
                 ) VALUES('profile-a', 'project-a', 'Calibration', 'draft',
                          'printer-a', '1', '1')",
                [],
            )
            .unwrap();

        let summary = store.reset_catalog();

        assert_eq!(
            summary,
            CatalogResetSummary {
                models_removed: 1,
                source_roots_removed: 2,
            }
        );
        assert!(store.models().is_empty());
        assert!(store.favorite_hashes().is_empty());
        assert_eq!(store.all_tags()[0].name, "Keep tag");
        assert_eq!(store.all_collections()[0].name, "Keep collection");
        assert_eq!(store.all_collections()[0].member_count, 0);
        let thumbnail_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM thumbnails", [], |row| row.get(0))
            .unwrap();
        let calibration_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM calibration_projects", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(thumbnail_count, 0);
        assert_eq!(calibration_count, 1);
        store
            .validate_sync_profile_binding("profile-a", "binding-a")
            .unwrap();
        assert!(model_path.exists(), "reset must not delete source files");
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
    fn favorites_persist_for_known_models_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();

        assert!(store.add_favorite(&hash));
        assert_eq!(store.favorite_hashes(), vec![hash.clone()]);
        assert!(!store.add_favorite("missing"));

        store.remove_favorite(&hash);
        assert!(store.favorite_hashes().is_empty());
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
                    server_binding: "binding-a".to_string(),
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
        assert!(store
            .remote_model_link("p", "binding-a", &hash)
            .unwrap()
            .is_none());
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

    fn workspace_input(
        profile_id: &str,
        project_id: &str,
        operation_id: &str,
        idempotency_key: &str,
        updated_at: &str,
    ) -> SaveCalibrationWorkspaceStateParams {
        SaveCalibrationWorkspaceStateParams {
            profile_id: profile_id.to_string(),
            project_id: project_id.to_string(),
            display_name: "Flow calibration".to_string(),
            description: Some("Exact local draft".to_string()),
            printer_id: "printer-1".to_string(),
            status: "inProgress".to_string(),
            completed_step_count: 2,
            total_step_count: 5,
            printer_context_fresh: false,
            base_revision: None,
            operation_id: operation_id.to_string(),
            idempotency_key: idempotency_key.to_string(),
            workspace_state: serde_json::json!({
                "activeStepId": "step-2",
                "draft": {
                    "notes": "retain exactly",
                    "measurements": [0.1, null, 0.3]
                }
            }),
            created_at: "2026-07-26T15:00:00.000Z".to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn upgrades_v12_through_the_current_schema_additively() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v12-calibration.sqlite3");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V12).unwrap();
            conn.execute(
                "INSERT INTO calibration_projects(
                    profile_id, project_id, display_name, status, printer_id,
                    created_at, updated_at)
                 VALUES('profile-1', 'project-1', 'Existing', 'draft', 'printer-1', '1', '1')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 12).unwrap();
        }

        let store = SqliteCatalog::open(&db).unwrap();
        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let state_table_exists: bool = store
            .conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'calibration_workspace_states')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let existing_projects: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM calibration_projects", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            version, SCHEMA_VERSION,
            "the test must track the current schema; a version pinned in a \
             literal (and in this test's own name) goes stale silently on the \
             next migration"
        );
        assert!(state_table_exists);
        assert_eq!(existing_projects, 1);
        let photo_columns: Vec<String> = store
            .conn
            .prepare("PRAGMA table_info(staged_calibration_photos)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(photo_columns.contains(&"stage_id".to_string()));
        assert!(!photo_columns.contains(&"step_id".to_string()));
        assert!(photo_columns.contains(&"local_path".to_string()));
        assert!(photo_columns.contains(&"caption".to_string()));
        assert!(photo_columns.contains(&"photo_order".to_string()));

        // v15 columns: without these the resolution policy compiles and
        // enforces nothing, so a migration that skipped them would leave every
        // policy test below passing against an unenforceable schema.
        let conflict_columns: Vec<String> = store
            .conn
            .prepare("PRAGMA table_info(calibration_conflicts)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for column in [
            "conflict_kind",
            "resolution_revision_id",
            "resolution_payload",
        ] {
            assert!(
                conflict_columns.contains(&column.to_string()),
                "calibration_conflicts is missing {column} after migration"
            );
        }
        let revision_columns: Vec<String> = store
            .conn
            .prepare("PRAGMA table_info(calibration_profile_revisions)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(revision_columns.contains(&"supersedes_revision_id".to_string()));
        let observation_columns: Vec<String> = store
            .conn
            .prepare("PRAGMA table_info(calibration_observations)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(observation_columns.contains(&"bound_snapshot_revision".to_string()));
    }

    #[test]
    fn saves_lists_and_gets_exact_workspace_state_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("calibration-workspace.sqlite3");
        let input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"a".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        {
            let mut store = SqliteCatalog::open(&db).unwrap();
            let saved = store.save_calibration_workspace_state(&input).unwrap();
            assert_eq!(saved.workspace_state, input.workspace_state);
            assert_eq!(saved.completed_step_count, 2);
            assert_eq!(saved.total_step_count, 5);
            assert!(!saved.is_synced);
            assert!(!saved.is_printer_context_fresh);
        }

        let store = SqliteCatalog::open(&db).unwrap();
        let fetched = store
            .get_calibration_workspace_state("profile-1", "project-1")
            .unwrap()
            .unwrap();
        assert_eq!(fetched.workspace_state, input.workspace_state);
        assert_eq!(fetched.description, input.description);
        assert_eq!(fetched.created_at, input.created_at);
        assert_eq!(fetched.updated_at, input.updated_at);
        assert_eq!(
            store
                .list_calibration_workspace_states("profile-1")
                .unwrap(),
            vec![fetched]
        );
    }

    #[test]
    fn staged_calibration_photo_persists_private_path_and_replays_by_hash() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let workspace = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"a".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        store.save_calibration_workspace_state(&workspace).unwrap();
        let photo = StageCalibrationPhotoParams {
            photo_id: "photo-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            stage_id: CalibrationWorkspaceStageId::Temperature,
            project_id: "project-1".to_string(),
            profile_id: "profile-1".to_string(),
            content_hash: "b".repeat(64),
            mime_type: "image/png".to_string(),
            byte_size: 128,
            local_path: r"C:\private\photo-1.png".to_string(),
            staged_at: "2026-07-26T15:02:00.000Z".to_string(),
            caption: "Temperature result".to_string(),
            order: 1,
        };

        let saved = store.stage_calibration_photo(&photo).unwrap();
        assert_eq!(saved.content_hash, photo.content_hash);
        assert_eq!(saved.stage_id, CalibrationWorkspaceStageId::Temperature);
        assert_eq!(saved.caption, "Temperature result");
        assert_eq!(saved.order, 1);
        assert_eq!(store.stage_calibration_photo(&photo).unwrap(), saved);
        let private_path: String = store
            .conn
            .query_row(
                "SELECT local_path FROM staged_calibration_photos
                 WHERE profile_id = 'profile-1' AND photo_id = 'photo-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(private_path, photo.local_path);
        let renderer_json = serde_json::to_value(&saved).unwrap();
        assert!(renderer_json.get("localPath").is_none());

        let mut changed = photo;
        changed.content_hash = "c".repeat(64);
        assert!(store
            .stage_calibration_photo(&changed)
            .unwrap_err()
            .contains("different immutable metadata"));
    }

    #[test]
    fn calibration_workspace_save_preserves_projection_and_immutable_outbox_rows() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let first = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"b".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        store.save_calibration_workspace_state(&first).unwrap();
        store
            .conn
            .execute(
                "UPDATE calibration_projects
                 SET remote_project_id = 'remote-1', base_revision = 7,
                     has_conflicts = 1, is_synced = 1, is_printer_context_fresh = 1
                 WHERE profile_id = 'profile-1' AND project_id = 'project-1'",
                [],
            )
            .unwrap();

        let mut second = workspace_input(
            "profile-1",
            "project-1",
            "operation-2",
            &"c".repeat(64),
            "2026-07-26T15:02:00.000Z",
        );
        second.display_name = "Updated flow calibration".to_string();
        second.base_revision = Some(8);
        second.printer_context_fresh = true;
        second.workspace_state["activeStepId"] = serde_json::json!("step-3");
        let saved = store.save_calibration_workspace_state(&second).unwrap();

        assert_eq!(saved.remote_project_id.as_deref(), Some("remote-1"));
        assert_eq!(saved.base_revision, Some(8));
        assert!(saved.has_conflicts);
        assert!(!saved.is_synced);
        assert!(saved.is_printer_context_fresh);

        let operations = store
            .list_calibration_pending_ops("profile-1", Some("project-1"), 10)
            .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].sequence, 2);
        assert_eq!(operations[0].operation_kind, "Update");
        assert_eq!(operations[0].kind, "saveProjectDraft");
        assert_eq!(operations[0].entity_type, "CalibrationProject");
        assert_eq!(
            operations[0].payload,
            serde_json::json!({
                "displayName": second.display_name,
                "description": second.description,
                "printerId": second.printer_id,
                "status": second.status,
                "workspaceState": second.workspace_state,
            })
        );
        let superseded: String = store
            .conn
            .query_row(
                "SELECT state FROM calibration_outbox
                 WHERE profile_id = 'profile-1' AND operation_id = 'operation-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(superseded, "superseded");
    }

    #[test]
    fn three_queued_autosaves_coalesce_for_new_and_existing_projects() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        for index in 1..=3 {
            let mut input = workspace_input(
                "profile-1",
                "new-project",
                &format!("new-operation-{index}"),
                &format!("{index}").repeat(64),
                &format!("2026-07-26T15:0{index}:00.000Z"),
            );
            input.workspace_state["revision"] = serde_json::json!(index);
            store.save_calibration_workspace_state(&input).unwrap();
        }
        let new_pending = store
            .list_calibration_pending_ops("profile-1", Some("new-project"), 10)
            .unwrap();
        assert_eq!(new_pending.len(), 1);
        assert_eq!(new_pending[0].operation_id, "new-operation-3");
        assert_eq!(new_pending[0].operation_kind, "Create");
        assert_eq!(
            new_pending[0].payload["workspaceState"]["revision"],
            serde_json::json!(3)
        );

        for index in 1..=3 {
            let mut input = workspace_input(
                "profile-1",
                "existing-project",
                &format!("existing-operation-{index}"),
                &format!("{}", index + 3).repeat(64),
                &format!("2026-07-26T16:0{index}:00.000Z"),
            );
            input.base_revision = Some(9);
            input.workspace_state["revision"] = serde_json::json!(index);
            store.save_calibration_workspace_state(&input).unwrap();
        }
        let existing_pending = store
            .list_calibration_pending_ops("profile-1", Some("existing-project"), 10)
            .unwrap();
        assert_eq!(existing_pending.len(), 1);
        assert_eq!(existing_pending[0].operation_id, "existing-operation-3");
        assert_eq!(existing_pending[0].operation_kind, "Update");
        assert_eq!(existing_pending[0].base_revision, Some(9));
        assert_eq!(
            existing_pending[0].payload["workspaceState"]["revision"],
            serde_json::json!(3)
        );

        let states: Vec<(String, i64)> = store
            .conn
            .prepare(
                "SELECT state, COUNT(*) FROM calibration_outbox
                 GROUP BY state ORDER BY state",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            states,
            vec![("pending".to_string(), 2), ("superseded".to_string(), 4)]
        );

        let replay = workspace_input(
            "profile-1",
            "new-project",
            "new-operation-3",
            &"3".repeat(64),
            "2026-07-26T15:03:00.000Z",
        );
        let mut replay = replay;
        replay.workspace_state["revision"] = serde_json::json!(3);
        store.save_calibration_workspace_state(&replay).unwrap();
        assert_eq!(
            store
                .list_calibration_pending_ops("profile-1", Some("new-project"), 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn remote_workspace_needs_retest_is_unresolved() {
        let mut stages = serde_json::Map::new();
        for stage_id in [
            "temperature",
            "flowPass1",
            "flowPass2",
            "pressureAdvance",
            "flowVerification",
            "retraction",
            "maximumVolumetricSpeed",
            "shrinkage",
            "finalVerification",
        ] {
            stages.insert(
                stage_id.to_string(),
                serde_json::json!({
                    "stageId": stage_id,
                    "status": if stage_id == "temperature" {
                        "needsRetest"
                    } else {
                        "completed"
                    },
                }),
            );
        }
        let workspace = serde_json::json!({
            "domainState": {
                "stages": stages,
                "attempts": [],
                "history": [{ "type": "rebaseSnapshot" }],
            },
        });

        assert_eq!(
            calibration_workspace_projection(&workspace).unwrap(),
            (8, 9, "inProgress")
        );
    }

    #[test]
    fn workspace_save_uses_only_main_validated_freshness() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let mut input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"a".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        input.printer_context_fresh = true;
        assert!(
            store
                .save_calibration_workspace_state(&input)
                .unwrap()
                .is_printer_context_fresh
        );

        let mut mismatch = input.clone();
        mismatch.operation_id = "operation-2".to_string();
        mismatch.idempotency_key = "b".repeat(64);
        mismatch.updated_at = "2026-07-26T15:02:00.000Z".to_string();
        mismatch.printer_context_fresh = false;
        assert!(
            !store
                .save_calibration_workspace_state(&mismatch)
                .unwrap()
                .is_printer_context_fresh
        );

        let mut rebased = mismatch;
        rebased.operation_id = "operation-3".to_string();
        rebased.idempotency_key = "c".repeat(64);
        rebased.updated_at = "2026-07-26T15:03:00.000Z".to_string();
        rebased.printer_context_fresh = true;
        assert!(
            store
                .save_calibration_workspace_state(&rebased)
                .unwrap()
                .is_printer_context_fresh
        );
    }

    #[test]
    fn remote_only_project_remains_visible_as_unhydrated_recovery_state() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let snapshot = serde_json::json!({
            "id": "22222222-2222-4222-8222-222222222222",
            "displayName": "Remote-only calibration",
            "description": "Created on another desktop",
            "status": "inProgress",
            "printerId": "printer-remote",
            "revision": 4,
            "createdAt": "2026-07-26T15:00:00.000Z",
            "updatedAt": "2026-07-26T16:00:00.000Z"
        });
        store
            .apply_calibration_snapshot(
                "profile-1",
                CalibrationEntityType::CalibrationProject.as_db(),
                "22222222-2222-4222-8222-222222222222",
                Some(&snapshot),
                false,
                20,
            )
            .unwrap();
        store
            .apply_calibration_snapshot(
                "profile-1",
                CalibrationEntityType::CalibrationProject.as_db(),
                "22222222-2222-4222-8222-222222222222",
                Some(&snapshot),
                false,
                20,
            )
            .unwrap();

        assert!(store
            .list_calibration_workspace_states("profile-1")
            .unwrap()
            .is_empty());
        let projects = store
            .list_calibration_unhydrated_projects("profile-1")
            .unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "Remote-only calibration");
        assert_eq!(projects[0].base_revision, 4);
        assert_eq!(projects[0].recovery_state, "migrationRequired");
        assert!(projects[0].is_synced);
        assert!(!projects[0].is_printer_context_fresh);
    }

    /// Shape check for the UUID the IPC contract requires (`z.string().uuid()`
    /// on CalibrationConflict.conflictId in src/shared/ipc.ts). Written out here
    /// rather than pulling a uuid dependency into the test build.
    fn is_contract_uuid(value: &str) -> bool {
        let bytes = value.as_bytes();
        if bytes.len() != 36 {
            return false;
        }
        bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    }

    #[test]
    fn recorded_calibration_conflict_is_readable_through_the_ipc_contract() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"e".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        store.save_calibration_workspace_state(&input).unwrap();

        store
            .record_calibration_conflict(
                "profile-1",
                "operation-1",
                "CalibrationProject",
                "project-1",
                "server revision moved ahead",
                9,
                Some(CalibrationConflictKind::ProjectMetadata),
            )
            .unwrap();

        let conflicts = store
            .list_calibration_conflicts("profile-1", Some("project-1"))
            .unwrap();
        assert_eq!(
            conflicts.len(),
            1,
            "recording a conflict must persist a row the reader can find"
        );
        assert_eq!(conflicts[0].project_id, "project-1");
        assert_eq!(conflicts[0].entity_id, "project-1");
        assert_eq!(conflicts[0].server_revision, 9);
        assert!(
            is_contract_uuid(&conflicts[0].conflict_id),
            "conflictId {:?} is not a UUID, so the main process rejects the whole \
             list response (src/main/ipc.ts CalibrationListConflicts)",
            conflicts[0].conflict_id
        );

        let state: String = store
            .conn
            .query_row(
                "SELECT state FROM calibration_outbox
                 WHERE profile_id = 'profile-1' AND operation_id = 'operation-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "conflict");
    }

    #[test]
    fn calibration_conflict_without_an_owning_project_names_the_operation() {
        // Before the guard, this path did not lose the conflict -- SQLite raised
        // "catalog sync operation failed: FOREIGN KEY constraint failed", which
        // identifies neither the operation nor the missing project. The assertion
        // below is on the diagnostic, because that was the actual defect.
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"f".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        store.save_calibration_workspace_state(&input).unwrap();

        let error = store
            .record_calibration_conflict(
                "profile-1",
                "operation-missing",
                "CalibrationProject",
                "project-1",
                "server revision moved ahead",
                9,
                Some(CalibrationConflictKind::ProjectMetadata),
            )
            .expect_err("a conflict that cannot be stored must surface an error");
        assert!(
            error.contains("operation-missing"),
            "error {error:?} should name the operation it could not resolve"
        );
        assert!(store
            .list_calibration_conflicts("profile-1", None)
            .unwrap()
            .is_empty());
    }

    // ---- issue #216: the calibration conflict resolution write path ----------
    //
    // Every rejection below is paired with an injected counterfactual through
    // the same path. A rejection test whose harness never reaches the policy
    // passes by failing to arrive, and is indistinguishable from a policy that
    // works, so the negative must be shown capable of returning a positive in
    // the same spec before its negative result means anything.

    /// Seeds a project and one conflict, returning its store-generated id.
    fn seed_conflict(
        store: &mut SqliteCatalog,
        kind: Option<CalibrationConflictKind>,
        server_revision: i64,
    ) -> String {
        seed_conflict_for(store, "project-1", "operation-1", kind, server_revision)
    }

    fn seed_conflict_for(
        store: &mut SqliteCatalog,
        project_id: &str,
        operation_id: &str,
        kind: Option<CalibrationConflictKind>,
        server_revision: i64,
    ) -> String {
        let input = workspace_input(
            "profile-1",
            project_id,
            operation_id,
            &"f".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        store.save_calibration_workspace_state(&input).unwrap();
        store
            .record_calibration_conflict(
                "profile-1",
                operation_id,
                "CalibrationProject",
                project_id,
                "server revision moved ahead",
                server_revision,
                kind,
            )
            .unwrap();
        let conflicts = store
            .list_calibration_conflicts("profile-1", Some(project_id))
            .unwrap();
        assert_eq!(
            conflicts.len(),
            1,
            "the fixture must actually produce exactly one conflict; a silent \
             no-op here would give every test below a vacuous pass"
        );
        conflicts[0].conflict_id.clone()
    }

    fn resolve_params(
        conflict_id: &str,
        resolution: CalibrationConflictResolutionKind,
    ) -> ResolveCalibrationConflictParams {
        ResolveCalibrationConflictParams {
            profile_id: "profile-1".to_string(),
            conflict_id: conflict_id.to_string(),
            resolution,
            merged_fields: None,
        }
    }

    #[test]
    fn keeping_a_local_edit_names_its_deleted_predecessor_without_restoring_it() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );

        let resolved = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::KeepLocalAsNewRevision,
            ))
            .expect("keepLocalAsNewRevision is permitted for a deletionVsLocalEdit conflict");

        let revision_id = resolved
            .revision_id
            .clone()
            .expect("keeping a local edit must mint a new revision");
        assert_eq!(
            resolved.supersedes_revision_id.as_deref(),
            Some("project-1"),
            "the new revision must name the predecessor the server deleted; \
             without the link it is indistinguishable from an ordinary create \
             and the server's deletion becomes unobservable"
        );

        let stored: Option<String> = store
            .conn
            .query_row(
                "SELECT supersedes_revision_id FROM calibration_profile_revisions
                 WHERE profile_id = ?1 AND revision_id = ?2",
                params!["profile-1", revision_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some("project-1"),
            "the provenance link must be persisted, not merely returned; a DTO \
             field computed at the boundary is lost on the next read"
        );

        let resurrected: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM calibration_profile_revisions
                 WHERE profile_id = ?1 AND revision_id = ?2",
                params!["profile-1", "project-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            resurrected, 0,
            "the deleted predecessor must stay deleted; a new revision is a new \
             identity, not a resurrection"
        );
    }

    #[test]
    fn accepting_the_server_reports_superseded_observations_and_invalidates_nothing() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::StalePrinterSnapshot),
            9,
        );
        for (id, bound) in [
            ("obs-stale", Some(4_i64)),
            ("obs-current", Some(9_i64)),
            ("obs-unbound", None),
        ] {
            store
                .conn
                .execute(
                    "INSERT INTO calibration_observations
                         (profile_id, observation_id, attempt_id, step_id, project_id,
                          parameter_key, observed_at, bound_snapshot_revision)
                     VALUES ('profile-1', ?1, 'attempt-1', 'step-1', 'project-1',
                             'flow_ratio', '2026-07-26T15:02:00.000Z', ?2)",
                    params![id, bound],
                )
                .unwrap();
        }

        let resolved = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .expect("acceptServer is permitted for a stalePrinterSnapshot conflict");

        let reported: Vec<&str> = resolved
            .superseded_observations
            .iter()
            .map(|observation| observation.observation_id.as_str())
            .collect();
        assert_eq!(
            reported,
            vec!["obs-stale"],
            "only observations bound to a revision behind the accepted one are \
             superseded; an unbound observation has no answer and reporting it \
             would claim knowledge we do not have"
        );

        let survivors: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM calibration_observations WHERE profile_id = 'profile-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            survivors, 3,
            "acceptServer reports; it does not cascade. Deleting or rewriting \
             observations here destroys measurement work whose blast radius is \
             invisible at the moment of pressing"
        );
    }

    #[test]
    fn an_empty_supersession_report_is_not_the_same_response_as_no_report() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::StalePrinterSnapshot),
            9,
        );

        let resolved = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .unwrap();
        assert!(resolved.superseded_observations.is_empty());

        let wire = serde_json::to_value(&resolved).unwrap();
        assert_eq!(
            wire.get("supersededObservations"),
            Some(&serde_json::Value::Array(vec![])),
            "an examined-and-empty report must be on the wire as []; omitting \
             the field makes 'nothing was superseded' and 'nothing was examined' \
             the same response"
        );
    }

    #[test]
    fn replaying_the_same_resolution_is_a_no_op_that_does_not_move_resolved_at() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );

        let first = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::KeepLocalAsNewRevision,
            ))
            .unwrap();
        assert!(!first.replayed, "the first attempt is not a replay");

        let replay = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::KeepLocalAsNewRevision,
            ))
            .expect(
                "replay is normal outbox operation; erroring on it turns a \
                 transient failure into a permanent one",
            );
        assert!(replay.replayed, "the second attempt must report as a replay");
        assert_eq!(
            replay.resolved_at, first.resolved_at,
            "resolved_at must not move on replay"
        );
        assert_eq!(replay.revision_id, first.revision_id);

        let revisions: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM calibration_profile_revisions
                 WHERE profile_id = 'profile-1' AND supersedes_revision_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            revisions, 1,
            "a replay must not mint a second revision; keying on \
             (conflict_id, resolution_kind) is what makes the outbox safe to retry"
        );
    }

    #[test]
    fn a_resolved_conflict_cannot_be_re_resolved_differently() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );

        // Counterfactual first: the same path must be able to succeed, or the
        // rejection below could be a harness that never arrives.
        let first = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .expect("the permitted first resolution must succeed through this path");

        let error = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::KeepLocalAsNewRevision,
            ))
            .expect_err("a resolved conflict must not be re-resolved differently");
        assert!(
            error.starts_with(calibration_resolution_error::ALREADY_RESOLVED),
            "error {error:?} must carry the named code; matching on prose passes \
             when a different rejection fires"
        );

        let (resolved_at, resolution): (String, String) = store
            .conn
            .query_row(
                "SELECT resolved_at, resolution FROM calibration_conflicts
                 WHERE profile_id = 'profile-1' AND conflict_id = ?1",
                params![conflict_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            resolved_at, first.resolved_at,
            "the stored resolution must be untouched: resolved_at IS NULL is the \
             list filter, so mutating it changes what a past query would have returned"
        );
        assert_eq!(resolution, "acceptServer");
    }

    #[test]
    fn the_update_refuses_a_conflict_resolved_between_the_read_and_the_write() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );
        // Simulate the concurrent writer the pre-SELECT branch cannot see: the
        // row is resolved, but with the resolution this call is about to
        // request, so the equality branch lets it through and only the
        // `resolved_at IS NULL` predicate on the UPDATE can catch it.
        store
            .conn
            .execute(
                "UPDATE calibration_conflicts SET resolved_at = '2026-07-26T16:00:00.000Z',
                        resolution = 'acceptServer'
                 WHERE profile_id = 'profile-1' AND conflict_id = ?1",
                params![conflict_id],
            )
            .unwrap();

        let replay = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .expect("an identical resolution is a replay, not an error");
        assert!(replay.replayed);
        assert_eq!(replay.resolved_at, "2026-07-26T16:00:00.000Z");
    }

    #[test]
    fn a_resolution_the_kind_does_not_permit_is_rejected_by_name() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );

        let error = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::ManualFieldMerge,
            ))
            .expect_err("manualFieldMerge is not permitted for a deletionVsLocalEdit conflict");
        assert!(
            error.starts_with(calibration_resolution_error::NOT_PERMITTED),
            "error {error:?} must carry the named code"
        );
        assert!(
            error.contains("deletionVsLocalEdit"),
            "error {error:?} must name the kind whose policy rejected the request"
        );

        // Counterfactual through the same path: the harness does reach the
        // policy, so the rejection above is the policy speaking and not an
        // arrival failure.
        store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .expect("a permitted resolution must succeed through the same path");
    }

    #[test]
    fn an_unclassified_conflict_is_unresolvable_rather_than_permissively_resolvable() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(&mut store, None, 9);

        let error = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::ManualFieldMerge,
            ))
            .expect_err("a conflict with no ratified kind has no per-kind policy");
        assert!(
            error.starts_with(calibration_resolution_error::UNCLASSIFIED),
            "error {error:?} must carry the named code"
        );

        // Counterfactual: the identical conflict, classified, resolves. So the
        // refusal is about the missing classification and not about the fixture.
        let classified = seed_conflict_for(
            &mut store,
            "project-2",
            "operation-2",
            Some(CalibrationConflictKind::ProjectMetadata),
            9,
        );
        store
            .resolve_calibration_conflict(&ResolveCalibrationConflictParams {
                merged_fields: Some(serde_json::json!({ "flow_ratio": 0.98 })),
                ..resolve_params(
                    &classified,
                    CalibrationConflictResolutionKind::ManualFieldMerge,
                )
            })
            .expect("the same resolution on a classified conflict must succeed");
    }

    #[test]
    fn a_manual_field_merge_that_merges_nothing_is_rejected() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(&mut store, Some(CalibrationConflictKind::StepDraft), 9);

        let error = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::ManualFieldMerge,
            ))
            .expect_err("a manual merge carrying no fields records a merge that merged nothing");
        assert!(
            error.starts_with(calibration_resolution_error::MERGED_FIELDS_REQUIRED),
            "error {error:?} must carry the named code"
        );

        store
            .resolve_calibration_conflict(&ResolveCalibrationConflictParams {
                merged_fields: Some(serde_json::json!({ "flow_ratio": 0.98 })),
                ..resolve_params(
                    &conflict_id,
                    CalibrationConflictResolutionKind::ManualFieldMerge,
                )
            })
            .expect("the same call with merged fields must succeed through the same path");

        let payload: Option<String> = store
            .conn
            .query_row(
                "SELECT resolution_payload FROM calibration_conflicts
                 WHERE profile_id = 'profile-1' AND conflict_id = ?1",
                params![conflict_id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&payload.expect("the merged fields must be persisted")).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "flow_ratio": 0.98 }),
            "accepting merged fields and then discarding them records a merge \
             that merged nothing, which is what the required-fields check would \
             otherwise only appear to prevent"
        );
    }

    #[test]
    fn resolving_a_conflict_that_does_not_exist_names_the_conflict_it_could_not_find() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        // A real conflict exists, so the store is not merely empty: the refusal
        // is about this id and not about an unopened database.
        seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::ProjectMetadata),
            9,
        );

        let error = store
            .resolve_calibration_conflict(&resolve_params(
                "conflict-that-was-never-recorded",
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .expect_err("resolving an absent conflict must not silently succeed");
        assert!(
            error.starts_with(calibration_resolution_error::NOT_FOUND),
            "error {error:?} must carry the named code"
        );
        assert!(
            error.contains("conflict-that-was-never-recorded"),
            "error {error:?} must name the conflict it could not find"
        );
    }

    #[test]
    fn the_conflict_kind_is_read_from_the_store_and_not_taken_from_the_request() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let conflict_id = seed_conflict(
            &mut store,
            Some(CalibrationConflictKind::DeletionVsLocalEdit),
            9,
        );

        let resolved = store
            .resolve_calibration_conflict(&resolve_params(
                &conflict_id,
                CalibrationConflictResolutionKind::AcceptServer,
            ))
            .unwrap();
        assert!(
            resolved.kind == CalibrationConflictKind::DeletionVsLocalEdit,
            "the returned kind must be the stored classification, not an echo of \
             the request; a caller that supplied its own could pick the kind \
             whose policy permits what it wanted, making the policy advisory"
        );
    }

    #[test]
    fn exact_calibration_workspace_replay_does_not_duplicate_outbox() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"d".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        let first = store.save_calibration_workspace_state(&input).unwrap();
        let replay = store.save_calibration_workspace_state(&input).unwrap();
        assert_eq!(replay, first);
        assert_eq!(
            store
                .count_calibration_pending_ops("profile-1", Some("project-1"))
                .unwrap(),
            1
        );
    }

    #[test]
    fn calibration_workspace_replay_refuses_payload_or_key_changes_and_rolls_back() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let input = workspace_input(
            "profile-1",
            "project-1",
            "operation-1",
            &"e".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        let original = store.save_calibration_workspace_state(&input).unwrap();

        let mut changed_payload = input.clone();
        changed_payload.workspace_state["activeStepId"] = serde_json::json!("changed");
        assert!(store
            .save_calibration_workspace_state(&changed_payload)
            .unwrap_err()
            .contains("immutable"));

        let mut changed_key = input.clone();
        changed_key.idempotency_key = "f".repeat(64);
        assert!(store
            .save_calibration_workspace_state(&changed_key)
            .unwrap_err()
            .contains("different idempotencyKey"));

        assert_eq!(
            store
                .get_calibration_workspace_state("profile-1", "project-1")
                .unwrap()
                .unwrap(),
            original
        );
        assert_eq!(
            store
                .count_calibration_pending_ops("profile-1", Some("project-1"))
                .unwrap(),
            1
        );
    }

    #[test]
    fn calibration_workspace_states_are_profile_isolated_and_newest_first() {
        let mut store = SqliteCatalog::open_in_memory().unwrap();
        let profile_one_old = workspace_input(
            "profile-1",
            "shared-project",
            "operation-1",
            &"1".repeat(64),
            "2026-07-26T15:01:00.000Z",
        );
        let mut profile_one_new = workspace_input(
            "profile-1",
            "new-project",
            "operation-2",
            &"2".repeat(64),
            "2026-07-26T15:02:00.000Z",
        );
        profile_one_new.display_name = "Newest".to_string();
        let mut profile_two = workspace_input(
            "profile-2",
            "shared-project",
            "operation-1",
            &"3".repeat(64),
            "2026-07-26T15:03:00.000Z",
        );
        profile_two.display_name = "Other profile".to_string();

        store
            .save_calibration_workspace_state(&profile_one_old)
            .unwrap();
        store
            .save_calibration_workspace_state(&profile_one_new)
            .unwrap();
        store
            .save_calibration_workspace_state(&profile_two)
            .unwrap();

        let profile_one_states = store
            .list_calibration_workspace_states("profile-1")
            .unwrap();
        assert_eq!(profile_one_states.len(), 2);
        assert_eq!(profile_one_states[0].project_id, "new-project");
        assert_eq!(profile_one_states[1].project_id, "shared-project");
        assert_eq!(
            store
                .get_calibration_workspace_state("profile-2", "shared-project")
                .unwrap()
                .unwrap()
                .display_name,
            "Other profile"
        );
        assert!(store
            .get_calibration_workspace_state("profile-2", "new-project")
            .unwrap()
            .is_none());
    }
}
