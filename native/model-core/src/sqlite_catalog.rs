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
use crate::schema::{SCHEMA_V1, SCHEMA_V2, SCHEMA_VERSION};
use crate::sync::{
    self, ApplyPullBatchDto, ConflictInputDto, ConflictResolution, EnqueueOutboundOperationDto,
    EntityRevisionDto, OutboundOperationDto, OutboundState, RemoteModelLinkDto, RemoteUploadStatus,
    SyncConflictDto, SyncEntityType, SyncStatusDto, SyncVisibility,
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
                        updated_at, acked_at
                 FROM sync_outbox WHERE profile_id = ?1 AND operation_id = ?2",
                params![profile_id, operation_id],
                outbound_from_row,
            )
            .optional()
            .map_err(sql_error)
    }

    fn insert_conflict(
        &self,
        profile_id: &str,
        input: &ConflictInputDto,
    ) -> Result<SyncConflictDto, String> {
        let incoming = SyncConflictDto {
            profile_id: profile_id.to_string(),
            conflict_id: input.conflict_id.clone(),
            entity_type: input.entity_type,
            entity_id: input.entity_id.clone(),
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
                        reason, server_revision, created_at, resolved_at, resolution
                 FROM sync_conflicts WHERE profile_id = ?1 AND conflict_id = ?2",
                params![profile_id, input.conflict_id],
                conflict_from_row,
            )
            .optional()
            .map_err(sql_error)?
        {
            let same_content = existing.entity_type == incoming.entity_type
                && existing.entity_id == incoming.entity_id
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
                    created_at, resolved_at, resolution)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)",
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
                "SELECT profile_id, cursor, server_revision, last_pulled_at,
                        last_pushed_at, updated_at
                 FROM sync_profiles WHERE profile_id = ?1",
                params![profile_id],
                |row| {
                    Ok(SyncStatusDto {
                        profile_id: row.get(0)?,
                        cursor: row.get(1)?,
                        server_revision: row.get::<_, i64>(2)? as u64,
                        last_pulled_at: row.get(3)?,
                        last_pushed_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map(|status| status.unwrap_or_else(|| SyncStatusDto::empty(profile_id)))
            .map_err(sql_error)
    }

    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String> {
        sync::validate_pull_batch(&batch)?;
        let current = self.sync_status(&batch.profile_id)?;
        if batch.server_revision < current.server_revision {
            return Err("serverRevision must not move backwards".to_string());
        }
        self.begin_batch()?;
        let result = (|| {
            self.ensure_sync_profile(&batch.profile_id)?;
            for entity in &batch.entities {
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
                let old_revision: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT revision FROM sync_entities
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
                if old_revision.is_some_and(|revision| entity.revision < revision as u64) {
                    return Err("entity revision must not move backwards".to_string());
                }
                self.conn
                    .execute(
                        "INSERT INTO sync_entities(
                            profile_id, entity_type, local_id, remote_id, revision,
                            concurrency_token, tombstone, visibility, snapshot_json, updated_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                         ON CONFLICT(profile_id, entity_type, remote_id) DO UPDATE SET
                            local_id = excluded.local_id,
                            revision = excluded.revision,
                            concurrency_token = excluded.concurrency_token,
                            tombstone = excluded.tombstone,
                            visibility = excluded.visibility,
                            snapshot_json = excluded.snapshot_json,
                            updated_at = excluded.updated_at",
                        params![
                            batch.profile_id,
                            entity.entity_type.as_db(),
                            entity.local_id,
                            entity.remote_id,
                            entity.revision as i64,
                            entity.concurrency_token,
                            i64::from(entity.tombstone),
                            entity.visibility.as_db(),
                            optional_json(&entity.snapshot)?,
                            batch.applied_at,
                        ],
                    )
                    .map_err(sql_error)?;
            }
            for conflict in &batch.conflicts {
                self.insert_conflict(&batch.profile_id, conflict)?;
            }
            self.conn
                .execute(
                    "UPDATE sync_profiles SET cursor = ?2, server_revision = ?3,
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
        match result {
            Ok(status) => {
                self.commit_batch()?;
                Ok(status)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
    }

    fn link_remote_model(
        &mut self,
        link: RemoteModelLinkDto,
    ) -> Result<RemoteModelLinkDto, String> {
        sync::validate_remote_link(&link)?;
        self.ensure_sync_profile(&link.profile_id)?;
        if let Some(existing) = self.remote_model_link(&link.profile_id, &link.local_model_hash)? {
            if existing.remote_model_id != link.remote_model_id
                || existing.client_upload_id != link.client_upload_id
                || existing.created_at != link.created_at
            {
                return Err("remote model link content does not match existing link".to_string());
            }
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

    fn enqueue_outbound_operations(
        &mut self,
        profile_id: &str,
        operations: Vec<EnqueueOutboundOperationDto>,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_enqueue_batch(profile_id, &operations)?;
        self.begin_batch()?;
        let result = (|| {
            self.ensure_sync_profile(profile_id)?;
            let mut queued = Vec::with_capacity(operations.len());
            for operation in operations {
                if let Some(existing) = self.outbound_by_id(profile_id, &operation.operation_id)? {
                    if !sqlite_outbound_matches_input(&existing, &operation) {
                        return Err(format!(
                            "operationId {} has different persisted content",
                            operation.operation_id
                        ));
                    }
                    queued.push(existing);
                    continue;
                }
                self.conn
                    .execute(
                        "INSERT INTO sync_outbox(
                            profile_id, operation_id, entity_type, operation_kind, entity_id,
                            payload_json, base_revision, concurrency_token, state, attempt_count,
                            retry_eligible, retry_at, lease_until, last_error, created_at,
                            updated_at, acked_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0,
                                1, NULL, NULL, NULL, ?9, ?9, NULL)",
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
                        ],
                    )
                    .map_err(sql_error)?;
                queued.push(
                    self.outbound_by_id(profile_id, &operation.operation_id)?
                        .expect("inserted outbox row exists"),
                );
            }
            Ok(queued)
        })();
        match result {
            Ok(queued) => {
                self.commit_batch()?;
                Ok(queued)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
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
        let mut stmt = self
            .conn
            .prepare(
                "SELECT profile_id, operation_id, entity_type, operation_kind, entity_id,
                        payload_json, base_revision, concurrency_token, state, attempt_count,
                        retry_eligible, retry_at, lease_until, last_error, created_at,
                        updated_at, acked_at
                 FROM sync_outbox WHERE profile_id = ?1 ORDER BY created_at, operation_id",
            )
            .map_err(sql_error)?;
        let mut operations: Vec<_> = stmt
            .query_map(params![profile_id], outbound_from_row)
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        operations.retain(|operation| states.is_empty() || states.contains(&operation.state));
        operations.truncate(limit);
        Ok(operations)
    }

    fn claim_outbound_operations(
        &mut self,
        profile_id: &str,
        limit: usize,
        now: i64,
        lease_seconds: i64,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let lease_until = sync::validate_lease(now, lease_seconds)?;
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = 'pending', lease_until = NULL,
                        retry_at = NULL, updated_at = ?2
                     WHERE profile_id = ?1 AND state = 'inFlight' AND retry_eligible = 1
                       AND lease_until <= ?2",
                    params![profile_id, now],
                )
                .map_err(sql_error)?;
            let ids: Vec<String> = {
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT operation_id FROM sync_outbox
                         WHERE profile_id = ?1 AND retry_eligible = 1
                           AND (state = 'pending'
                                OR (state = 'failed' AND retry_at IS NOT NULL AND retry_at <= ?2))
                         ORDER BY created_at, operation_id LIMIT ?3",
                    )
                    .map_err(sql_error)?;
                let result = stmt
                    .query_map(params![profile_id, now, limit as i64], |row| row.get(0))
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)?;
                result
            };
            let mut claimed = Vec::with_capacity(ids.len());
            for operation_id in ids {
                self.conn
                    .execute(
                        "UPDATE sync_outbox SET state = 'inFlight',
                            attempt_count = attempt_count + 1, retry_at = NULL,
                            lease_until = ?3, updated_at = ?4
                         WHERE profile_id = ?1 AND operation_id = ?2",
                        params![profile_id, operation_id, lease_until, now],
                    )
                    .map_err(sql_error)?;
                claimed.push(
                    self.outbound_by_id(profile_id, &operation_id)?
                        .expect("claimed outbox row exists"),
                );
            }
            Ok(claimed)
        })();
        match result {
            Ok(claimed) => {
                self.commit_batch()?;
                Ok(claimed)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
    }

    fn recover_outbound_operations(&mut self, profile_id: &str, now: i64) -> Result<usize, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_timestamp("now", now)?;
        self.conn
            .execute(
                "UPDATE sync_outbox SET state = 'pending', lease_until = NULL,
                    retry_at = NULL, updated_at = ?2
                 WHERE profile_id = ?1 AND state = 'inFlight' AND retry_eligible = 1
                   AND lease_until <= ?2",
                params![profile_id, now],
            )
            .map_err(sql_error)
    }

    fn complete_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        completed_at: i64,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
        sync::validate_timestamp("completedAt", completed_at)?;
        let existing = self
            .outbound_by_id(profile_id, operation_id)?
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if existing.state != OutboundState::InFlight {
            return Err("only in-flight operations can be completed".to_string());
        }
        if completed_at < existing.updated_at {
            return Err("completedAt must not precede the claim timestamp".to_string());
        }
        self.begin_batch()?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE sync_outbox SET state = 'acked', retry_eligible = 0,
                        retry_at = NULL, lease_until = NULL, last_error = NULL,
                        updated_at = ?3, acked_at = ?3
                     WHERE profile_id = ?1 AND operation_id = ?2 AND state = 'inFlight'",
                    params![profile_id, operation_id, completed_at],
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
        match result {
            Ok(operation) => {
                self.commit_batch()?;
                Ok(operation)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
    }

    fn fail_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        error: &str,
        failed_at: i64,
        retry_at: Option<i64>,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
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
        if existing.state != OutboundState::InFlight {
            return Err("only in-flight operations can be failed".to_string());
        }
        if failed_at < existing.updated_at {
            return Err("failedAt must not precede the claim timestamp".to_string());
        }
        self.conn
            .execute(
                "UPDATE sync_outbox SET state = 'failed', retry_eligible = ?3,
                    retry_at = ?4, lease_until = NULL, last_error = ?5, updated_at = ?6
                 WHERE profile_id = ?1 AND operation_id = ?2 AND state = 'inFlight'",
                params![
                    profile_id,
                    operation_id,
                    i64::from(retry_at.is_some()),
                    retry_at,
                    error,
                    failed_at
                ],
            )
            .map_err(sql_error)?;
        self.outbound_by_id(profile_id, operation_id)?
            .ok_or_else(|| "outbound operation not found".to_string())
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
        match result {
            Ok(records) => {
                self.commit_batch()?;
                Ok(records)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
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
                        reason, server_revision, created_at, resolved_at, resolution
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
    ) -> Result<SyncConflictDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("conflictId", conflict_id)?;
        sync::validate_timestamp("resolvedAt", resolved_at)?;
        let existing = self
            .conn
            .query_row(
                "SELECT profile_id, conflict_id, entity_type, entity_id,
                        local_payload_json, server_payload_json, submitted_payload_json,
                        reason, server_revision, created_at, resolved_at, resolution
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
        self.conn
            .execute(
                "UPDATE sync_conflicts SET resolved_at = ?3, resolution = ?4
                 WHERE profile_id = ?1 AND conflict_id = ?2 AND resolved_at IS NULL",
                params![profile_id, conflict_id, resolved_at, resolution.as_db()],
            )
            .map_err(sql_error)?;
        self.conn
            .query_row(
                "SELECT profile_id, conflict_id, entity_type, entity_id,
                        local_payload_json, server_payload_json, submitted_payload_json,
                        reason, server_revision, created_at, resolved_at, resolution
                 FROM sync_conflicts WHERE profile_id = ?1 AND conflict_id = ?2",
                params![profile_id, conflict_id],
                conflict_from_row,
            )
            .map_err(sql_error)
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
    input: &EnqueueOutboundOperationDto,
) -> bool {
    existing.operation_id == input.operation_id
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
}
