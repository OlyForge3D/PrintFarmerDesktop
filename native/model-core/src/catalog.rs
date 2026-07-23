//! The local model catalog: logical model identity, physical locations, a
//! storage-agnostic [`CatalogStore`] trait, an in-memory implementation, and
//! the reconciliation that turns a filesystem scan into catalog updates.
//!
//! A *logical model* is identified by its SHA-256 content hash. The same bytes
//! appearing under several names, folders, or roots collapse into one logical
//! model with multiple *locations* — this is the exact-byte duplicate grouping.
//!
//! The trait boundary lets a SQLite-backed store (compiled where a C toolchain
//! is available) and the in-memory store used in tests share identical
//! reconciliation logic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::hash::{hash_file, ContentHash};
use crate::model::{FileFingerprint, ModelFormat};
use crate::scan::ScanResult;
use crate::sync::{
    self, ApplyPullBatchDto, ClaimedOutboundBatchDto, ConflictInputDto, ConflictResolution,
    EnqueueOutboundOperationDto, EntityRevisionDto, OutboundOperationDto, OutboundState,
    ReconcileUncertainBatchDto, RemoteModelLinkDto, SettleOutboundBatchDto,
    SettledOutboundBatchDto, SyncConflictDto, SyncEntityType, SyncStatusDto, SyncVisibility,
    UnknownOutcomeResolution,
};

/// Stable identifier for a source root (a user-selected folder).
pub type RootId = String;

/// A physical file backing a logical model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelLocation {
    pub root_id: RootId,
    pub path: PathBuf,
    pub root_relative: PathBuf,
    pub fingerprint: FileFingerprint,
    /// Whether the file was present at the last reconciliation.
    pub available: bool,
}

/// A logical model plus every physical location that carries its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogicalModel {
    pub hash: ContentHash,
    pub format: ModelFormat,
    pub size: u64,
    pub locations: Vec<ModelLocation>,
}

impl LogicalModel {
    /// A model is a duplicate group when more than one physical file resolves
    /// to the same content hash.
    pub fn is_duplicate_group(&self) -> bool {
        self.locations.len() > 1
    }
}

/// What the store already knows about a path at a given root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLocation {
    pub hash: ContentHash,
    pub fingerprint: FileFingerprint,
    pub available: bool,
}

/// Everything needed to record (or refresh) a location under its model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationUpsert {
    pub hash: ContentHash,
    pub format: ModelFormat,
    pub size: u64,
    pub root_id: RootId,
    pub path: PathBuf,
    pub root_relative: PathBuf,
    pub fingerprint: FileFingerprint,
}

/// Storage abstraction for the catalog. Implementations must keep logical model
/// identity and physical locations consistent: a location belongs to exactly
/// one model at a time (its current content hash).
/// A user-defined organizational label. `id` is the normalized (lowercased,
/// trimmed) name and doubles as a stable identity so the same label typed in
/// different cases collapses to one tag.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

/// Normalizes a raw tag name into `(id, display)`. Returns `None` when the
/// name is empty after trimming.
pub fn normalize_tag(name: &str) -> Option<Tag> {
    let display = name.trim();
    if display.is_empty() {
        return None;
    }
    Some(Tag {
        id: display.to_lowercase(),
        name: display.to_string(),
    })
}

/// A user-owned, many-to-many grouping of models. Unlike tags, collections
/// have opaque ids so two collections may share a display name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub shared_to_farm: bool,
    pub member_count: usize,
}

/// Generates a process-unique, sortable-ish collection id from the wall clock
/// plus a monotonic counter (so ids stay unique even within the same tick).
pub fn new_collection_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("col-{nanos:x}-{seq:x}")
}

pub trait CatalogStore {
    /// Begin an atomic batch of catalog mutations. Persistent stores should keep
    /// the batch uncommitted until `commit_batch`; dropping the store must roll it
    /// back. The default is a no-op for read-only/test implementations.
    fn begin_batch(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Commit the active mutation batch.
    fn commit_batch(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Roll back the active mutation batch.
    fn rollback_batch(&mut self) {}

    /// Look up what is currently recorded for a path under a root.
    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation>;

    /// Insert or replace a location, attaching it to `upsert.hash`'s model and
    /// detaching it from any previous model. Marks the location available.
    fn upsert_location(&mut self, upsert: LocationUpsert);

    /// Set the availability flag for a known location.
    fn set_available(&mut self, root_id: &str, path: &Path, available: bool);

    /// Absolute paths of all locations currently recorded under a root.
    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf>;

    /// Fetch a single logical model by content hash.
    fn model(&self, hash: &str) -> Option<LogicalModel>;

    /// All logical models known to the catalog.
    fn models(&self) -> Vec<LogicalModel>;

    /// Logical models with more than one physical location.
    fn duplicate_groups(&self) -> Vec<LogicalModel> {
        self.models()
            .into_iter()
            .filter(LogicalModel::is_duplicate_group)
            .collect()
    }

    /// Every tag known to the catalog, sorted by display name. Default: none.
    fn all_tags(&self) -> Vec<Tag> {
        Vec::new()
    }

    /// Tags assigned to one model, sorted by display name. Default: none.
    fn tags_for_model(&self, _hash: &str) -> Vec<Tag> {
        Vec::new()
    }

    /// Assign a (possibly new) tag to a model, creating the tag if needed.
    /// Returns the normalized tag, or `None` if the name was blank. Default:
    /// no-op returning `None`.
    fn add_model_tag(&mut self, _hash: &str, _name: &str) -> Option<Tag> {
        None
    }

    /// Remove a tag assignment from a model. Default: no-op.
    fn remove_model_tag(&mut self, _hash: &str, _tag_id: &str) {}

    /// Every collection known to the catalog, sorted by display name. Default:
    /// none.
    fn all_collections(&self) -> Vec<Collection> {
        Vec::new()
    }

    /// Collections a model belongs to, sorted by display name. Default: none.
    fn collections_for_model(&self, _hash: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// Create a new collection with the given display name, returning it. `None`
    /// if the name is blank. Default: no-op returning `None`.
    fn create_collection(&mut self, _name: &str) -> Option<Collection> {
        None
    }

    /// Delete a collection and all of its memberships. Default: no-op.
    fn delete_collection(&mut self, _id: &str) {}

    /// Add a model to a collection. Returns `true` if both exist and the
    /// membership now holds. Default: `false`.
    fn add_model_to_collection(&mut self, _id: &str, _hash: &str) -> bool {
        false
    }

    /// Remove a model from a collection. Default: no-op.
    fn remove_model_from_collection(&mut self, _id: &str, _hash: &str) {}

    /// Read the opaque, profile-scoped synchronization checkpoint.
    fn sync_status(&self, profile_id: &str) -> Result<SyncStatusDto, String>;

    /// Atomically materialize a pull and advance its checkpoint.
    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String>;

    /// Create or refresh an idempotent local-hash to remote-model link.
    fn link_remote_model(&mut self, link: RemoteModelLinkDto)
        -> Result<RemoteModelLinkDto, String>;

    fn remote_model_link(
        &self,
        profile_id: &str,
        local_model_hash: &str,
    ) -> Result<Option<RemoteModelLinkDto>, String>;

    fn remote_model_links(
        &self,
        profile_id: &str,
        limit: usize,
    ) -> Result<Vec<RemoteModelLinkDto>, String>;

    fn entity_revisions(
        &self,
        profile_id: &str,
        entity_type: Option<SyncEntityType>,
        limit: usize,
    ) -> Result<Vec<EntityRevisionDto>, String>;

    fn entity_revision_by_remote(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        remote_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String>;

    fn entity_revision_by_local(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        local_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String>;

    /// Transactionally enqueue an outbound batch, preserving caller-supplied ids.
    fn enqueue_outbound_operations(
        &mut self,
        profile_id: &str,
        batch_id: &str,
        operations: Vec<EnqueueOutboundOperationDto>,
    ) -> Result<Vec<OutboundOperationDto>, String>;

    fn outbound_operations(
        &self,
        profile_id: &str,
        states: &[OutboundState],
        limit: usize,
    ) -> Result<Vec<OutboundOperationDto>, String>;

    /// Recover expired leases and claim eligible operations in one transaction.
    fn claim_outbound_operations(
        &mut self,
        profile_id: &str,
        limit: usize,
        now: i64,
        lease_seconds: i64,
    ) -> Result<Option<ClaimedOutboundBatchDto>, String>;

    fn recover_outbound_operations(&mut self, profile_id: &str, now: i64) -> Result<usize, String>;

    fn complete_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        lease_token: &str,
        completed_at: i64,
    ) -> Result<OutboundOperationDto, String>;

    fn fail_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        lease_token: &str,
        error: &str,
        failed_at: i64,
        retry_at: Option<i64>,
    ) -> Result<OutboundOperationDto, String>;

    fn settle_outbound_batch(
        &mut self,
        settlement: SettleOutboundBatchDto,
    ) -> Result<SettledOutboundBatchDto, String>;

    fn reconcile_uncertain_batch(
        &mut self,
        reconciliation: ReconcileUncertainBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String>;

    fn prune_acked_outbound_operations(
        &mut self,
        profile_id: &str,
        acked_before: i64,
        limit: usize,
    ) -> Result<usize, String>;

    fn record_sync_conflicts(
        &mut self,
        profile_id: &str,
        conflicts: Vec<ConflictInputDto>,
    ) -> Result<Vec<SyncConflictDto>, String>;

    fn sync_conflicts(
        &self,
        profile_id: &str,
        include_resolved: bool,
        limit: usize,
    ) -> Result<Vec<SyncConflictDto>, String>;

    fn resolve_sync_conflict(
        &mut self,
        profile_id: &str,
        conflict_id: &str,
        resolution: ConflictResolution,
        resolved_at: i64,
    ) -> Result<SyncConflictDto, String>;
}

/// Summary of a reconciliation pass over one root.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Newly cataloged locations.
    pub added: usize,
    /// Locations whose bytes changed (re-hashed to a new content hash).
    pub changed: usize,
    /// Locations seen again with an unchanged fingerprint (not re-hashed).
    pub unchanged: usize,
    /// Previously known locations no longer present under the root.
    pub missing: usize,
    /// Files that could not be hashed (IO/permission errors).
    pub hash_errors: usize,
}

/// Reconcile a root's scan against the store, hashing only new or changed
/// files. Locations that disappeared are marked unavailable rather than
/// deleted, so a reconnecting drive restores them without a re-hash.
pub fn reconcile_root<S: CatalogStore + ?Sized>(
    store: &mut S,
    root_id: &str,
    scan: &ScanResult,
) -> ReconcileReport {
    let (hashes, _) = hash_changed_files(store, root_id, scan);
    reconcile_root_with_hashes(store, root_id, scan, &hashes)
}

/// Hash every new, changed, or previously unavailable file without mutating the
/// catalog. Callers that require all-or-nothing behavior can reject any error
/// before opening a mutation batch.
pub(crate) fn hash_changed_files<S: CatalogStore + ?Sized>(
    store: &S,
    root_id: &str,
    scan: &ScanResult,
) -> (HashMap<PathBuf, ContentHash>, usize) {
    let mut hashes = HashMap::new();
    let mut errors = 0;
    for file in &scan.files {
        let unchanged = store
            .get_location(root_id, &file.path)
            .is_some_and(|existing| existing.fingerprint == file.fingerprint && existing.available);
        if unchanged {
            continue;
        }
        match hash_file(&file.path) {
            Ok(hash) => {
                hashes.insert(file.path.clone(), hash);
            }
            Err(_) => errors += 1,
        }
    }
    (hashes, errors)
}

/// Reconcile using hashes staged before mutation. A missing staged hash is
/// reported as a hash error and leaves that location untouched.
pub(crate) fn reconcile_root_with_hashes<S: CatalogStore + ?Sized>(
    store: &mut S,
    root_id: &str,
    scan: &ScanResult,
    hashes: &HashMap<PathBuf, ContentHash>,
) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let mut seen: Vec<PathBuf> = Vec::with_capacity(scan.files.len());

    for file in &scan.files {
        seen.push(file.path.clone());
        let existing = store.get_location(root_id, &file.path);

        let unchanged = existing
            .as_ref()
            .is_some_and(|e| e.fingerprint == file.fingerprint && e.available);
        if unchanged {
            report.unchanged += 1;
            continue;
        }

        let hash = match hashes.get(&file.path) {
            Some(hash) => hash.clone(),
            None => {
                report.hash_errors += 1;
                continue;
            }
        };

        match &existing {
            Some(prev) if prev.hash == hash => report.unchanged += 1,
            Some(_) => report.changed += 1,
            None => report.added += 1,
        }

        store.upsert_location(LocationUpsert {
            hash,
            format: file.format,
            size: file.fingerprint.size,
            root_id: root_id.to_string(),
            path: file.path.clone(),
            root_relative: file.root_relative.clone(),
            fingerprint: file.fingerprint.clone(),
        });
    }

    // Anything previously known under this root but not seen this pass is now
    // missing. Only meaningful when traversal completed without cancellation or
    // filesystem errors; otherwise unseen paths may still exist.
    if !scan.cancelled && scan.skipped_errors == 0 {
        let seen_set: std::collections::HashSet<&PathBuf> = seen.iter().collect();
        for known in store.paths_for_root(root_id) {
            if !seen_set.contains(&known) {
                store.set_available(root_id, &known, false);
                report.missing += 1;
            }
        }
    }

    report
}

// --- In-memory implementation --------------------------------------------

#[derive(Debug, Clone)]
struct LocationRecord {
    root_relative: PathBuf,
    fingerprint: FileFingerprint,
    available: bool,
}

#[derive(Debug, Clone)]
struct ModelRecord {
    format: ModelFormat,
    size: u64,
    locations: HashMap<(RootId, PathBuf), LocationRecord>,
}

/// A non-persistent [`CatalogStore`] used for tests and as the reference
/// implementation of catalog semantics.
#[derive(Debug, Default)]
pub struct InMemoryCatalog {
    models: HashMap<ContentHash, ModelRecord>,
    /// Maps a physical location to the content hash it currently belongs to.
    index: HashMap<(RootId, PathBuf), ContentHash>,
    /// Tag id -> display name.
    tags: HashMap<String, String>,
    /// Content hash -> assigned tag ids.
    model_tags: HashMap<ContentHash, std::collections::BTreeSet<String>>,
    /// Collection id -> (display name, shared_to_farm).
    collections: HashMap<String, (String, bool)>,
    /// Collection id -> member content hashes.
    collection_members: HashMap<String, std::collections::BTreeSet<ContentHash>>,
    sync_statuses: HashMap<String, SyncStatusDto>,
    remote_model_links: HashMap<(String, ContentHash), RemoteModelLinkDto>,
    sync_entities: HashMap<(String, SyncEntityType, String), EntityRevisionDto>,
    sync_outbox: HashMap<(String, String), OutboundOperationDto>,
    next_outbox_sequence: HashMap<String, u64>,
    sync_conflicts: HashMap<(String, String), SyncConflictDto>,
    transaction_snapshot: Option<Box<InMemoryCatalog>>,
}

impl InMemoryCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    fn build_model(&self, hash: &str, record: &ModelRecord) -> LogicalModel {
        let mut locations: Vec<ModelLocation> = record
            .locations
            .iter()
            .map(|((root_id, path), loc)| ModelLocation {
                root_id: root_id.clone(),
                path: path.clone(),
                root_relative: loc.root_relative.clone(),
                fingerprint: loc.fingerprint.clone(),
                available: loc.available,
            })
            .collect();
        locations.sort_by(|a, b| a.path.cmp(&b.path));
        LogicalModel {
            hash: hash.to_string(),
            format: record.format,
            size: record.size,
            locations,
        }
    }
}

impl CatalogStore for InMemoryCatalog {
    fn begin_batch(&mut self) -> Result<(), String> {
        if self.transaction_snapshot.is_some() {
            return Err("catalog batch already active".to_string());
        }
        let snapshot = Self {
            models: self.models.clone(),
            index: self.index.clone(),
            tags: self.tags.clone(),
            model_tags: self.model_tags.clone(),
            collections: self.collections.clone(),
            collection_members: self.collection_members.clone(),
            sync_statuses: self.sync_statuses.clone(),
            remote_model_links: self.remote_model_links.clone(),
            sync_entities: self.sync_entities.clone(),
            sync_outbox: self.sync_outbox.clone(),
            next_outbox_sequence: self.next_outbox_sequence.clone(),
            sync_conflicts: self.sync_conflicts.clone(),
            transaction_snapshot: None,
        };
        self.transaction_snapshot = Some(Box::new(snapshot));
        Ok(())
    }

    fn commit_batch(&mut self) -> Result<(), String> {
        self.transaction_snapshot = None;
        Ok(())
    }

    fn rollback_batch(&mut self) {
        if let Some(snapshot) = self.transaction_snapshot.take() {
            *self = *snapshot;
        }
    }

    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation> {
        let key = (root_id.to_string(), path.to_path_buf());
        let hash = self.index.get(&key)?;
        let record = self.models.get(hash)?;
        let loc = record.locations.get(&key)?;
        Some(StoredLocation {
            hash: hash.clone(),
            fingerprint: loc.fingerprint.clone(),
            available: loc.available,
        })
    }

    fn upsert_location(&mut self, upsert: LocationUpsert) {
        let key = (upsert.root_id.clone(), upsert.path.clone());

        // Detach from any previous model if the hash changed.
        if let Some(prev_hash) = self.index.get(&key) {
            if prev_hash != &upsert.hash {
                if let Some(prev) = self.models.get_mut(prev_hash) {
                    prev.locations.remove(&key);
                    if prev.locations.is_empty() {
                        self.models.remove(prev_hash);
                    }
                }
            }
        }

        let record = self
            .models
            .entry(upsert.hash.clone())
            .or_insert_with(|| ModelRecord {
                format: upsert.format,
                size: upsert.size,
                locations: HashMap::new(),
            });
        record.locations.insert(
            key.clone(),
            LocationRecord {
                root_relative: upsert.root_relative,
                fingerprint: upsert.fingerprint,
                available: true,
            },
        );
        self.index.insert(key, upsert.hash);
    }

    fn set_available(&mut self, root_id: &str, path: &Path, available: bool) {
        let key = (root_id.to_string(), path.to_path_buf());
        if let Some(hash) = self.index.get(&key) {
            if let Some(record) = self.models.get_mut(hash) {
                if let Some(loc) = record.locations.get_mut(&key) {
                    loc.available = available;
                }
            }
        }
    }

    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf> {
        self.index
            .keys()
            .filter(|(r, _)| r == root_id)
            .map(|(_, p)| p.clone())
            .collect()
    }

    fn model(&self, hash: &str) -> Option<LogicalModel> {
        self.models.get(hash).map(|r| self.build_model(hash, r))
    }

    fn models(&self) -> Vec<LogicalModel> {
        let mut out: Vec<LogicalModel> = self
            .models
            .iter()
            .map(|(hash, record)| self.build_model(hash, record))
            .collect();
        out.sort_by(|a, b| a.hash.cmp(&b.hash));
        out
    }

    fn all_tags(&self) -> Vec<Tag> {
        let mut out: Vec<Tag> = self
            .tags
            .iter()
            .map(|(id, name)| Tag {
                id: id.clone(),
                name: name.clone(),
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    fn tags_for_model(&self, hash: &str) -> Vec<Tag> {
        let Some(ids) = self.model_tags.get(hash) else {
            return Vec::new();
        };
        let mut out: Vec<Tag> = ids
            .iter()
            .filter_map(|id| {
                self.tags.get(id).map(|name| Tag {
                    id: id.clone(),
                    name: name.clone(),
                })
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    fn add_model_tag(&mut self, hash: &str, name: &str) -> Option<Tag> {
        // Only tag models the catalog actually knows about.
        if !self.models.contains_key(hash) {
            return None;
        }
        let tag = normalize_tag(name)?;
        self.tags.insert(tag.id.clone(), tag.name.clone());
        self.model_tags
            .entry(hash.to_string())
            .or_default()
            .insert(tag.id.clone());
        Some(tag)
    }

    fn remove_model_tag(&mut self, hash: &str, tag_id: &str) {
        if let Some(ids) = self.model_tags.get_mut(hash) {
            ids.remove(tag_id);
            if ids.is_empty() {
                self.model_tags.remove(hash);
            }
        }
        // Prune the tag entirely if no model references it anymore.
        let still_used = self.model_tags.values().any(|ids| ids.contains(tag_id));
        if !still_used {
            self.tags.remove(tag_id);
        }
    }

    fn all_collections(&self) -> Vec<Collection> {
        let mut out: Vec<Collection> = self
            .collections
            .iter()
            .map(|(id, (name, shared))| Collection {
                id: id.clone(),
                name: name.clone(),
                shared_to_farm: *shared,
                member_count: self
                    .collection_members
                    .get(id)
                    .map_or(0, std::collections::BTreeSet::len),
            })
            .collect();
        out.sort_by_key(|c| c.name.to_lowercase());
        out
    }

    fn collections_for_model(&self, hash: &str) -> Vec<Collection> {
        let mut out: Vec<Collection> = self
            .collections
            .iter()
            .filter(|(id, _)| {
                self.collection_members
                    .get(*id)
                    .is_some_and(|members| members.contains(hash))
            })
            .map(|(id, (name, shared))| Collection {
                id: id.clone(),
                name: name.clone(),
                shared_to_farm: *shared,
                member_count: self
                    .collection_members
                    .get(id)
                    .map_or(0, std::collections::BTreeSet::len),
            })
            .collect();
        out.sort_by_key(|c| c.name.to_lowercase());
        out
    }

    fn create_collection(&mut self, name: &str) -> Option<Collection> {
        let display = name.trim();
        if display.is_empty() {
            return None;
        }
        let id = new_collection_id();
        self.collections
            .insert(id.clone(), (display.to_string(), false));
        Some(Collection {
            id,
            name: display.to_string(),
            shared_to_farm: false,
            member_count: 0,
        })
    }

    fn delete_collection(&mut self, id: &str) {
        self.collections.remove(id);
        self.collection_members.remove(id);
    }

    fn add_model_to_collection(&mut self, id: &str, hash: &str) -> bool {
        if !self.collections.contains_key(id) || !self.models.contains_key(hash) {
            return false;
        }
        self.collection_members
            .entry(id.to_string())
            .or_default()
            .insert(hash.to_string());
        true
    }

    fn remove_model_from_collection(&mut self, id: &str, hash: &str) {
        if let Some(members) = self.collection_members.get_mut(id) {
            members.remove(hash);
            if members.is_empty() {
                self.collection_members.remove(id);
            }
        }
    }

    fn sync_status(&self, profile_id: &str) -> Result<SyncStatusDto, String> {
        sync::validate_profile(profile_id)?;
        Ok(self
            .sync_statuses
            .get(profile_id)
            .cloned()
            .unwrap_or_else(|| SyncStatusDto::empty(profile_id)))
    }

    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String> {
        sync::validate_pull_batch(&batch)?;
        let current = self.sync_status(&batch.profile_id)?;
        if current.cursor != batch.expected_previous_cursor {
            return Err("stale pull cursor: expectedPreviousCursor does not match".to_string());
        }
        if batch.server_revision < current.server_revision {
            return Err("serverRevision must not move backwards".to_string());
        }
        for entity in &batch.entities {
            if let Some(local_id) = &entity.local_id {
                if self.sync_entities.values().any(|existing| {
                    existing.profile_id == batch.profile_id
                        && existing.entity_type == entity.entity_type
                        && existing.local_id.as_ref() == Some(local_id)
                        && existing.remote_id != entity.remote_id
                }) {
                    return Err(format!(
                        "localId {local_id} is already mapped to another remote entity"
                    ));
                }
            }
            if let Some(existing) = self.sync_entities.get(&(
                batch.profile_id.clone(),
                entity.entity_type,
                entity.remote_id.clone(),
            )) {
                if entity.revision < existing.revision {
                    return Err("entity revision must not move backwards".to_string());
                }
            }
        }

        self.begin_batch()?;
        let result = (|| {
            for entity in &batch.entities {
                let revision = EntityRevisionDto {
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
                self.sync_entities.insert(
                    (
                        batch.profile_id.clone(),
                        entity.entity_type,
                        entity.remote_id.clone(),
                    ),
                    revision,
                );
            }
            for conflict in &batch.conflicts {
                insert_memory_conflict(self, &batch.profile_id, conflict)?;
            }
            let status = SyncStatusDto {
                profile_id: batch.profile_id.clone(),
                cursor: batch.cursor.clone(),
                server_revision: batch.server_revision,
                last_pulled_at: Some(batch.applied_at),
                last_pushed_at: current.last_pushed_at,
                updated_at: batch.applied_at,
            };
            self.sync_statuses
                .insert(batch.profile_id.clone(), status.clone());
            Ok(status)
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
        let key = (link.profile_id.clone(), link.local_model_hash.clone());
        let link = self.remote_model_links.get(&key).map_or_else(
            || Ok(link.clone()),
            |existing| sync::merge_remote_link(existing, &link),
        )?;
        if link.upload_status == sync::RemoteUploadStatus::Uploaded && link.uploaded_at.is_none() {
            return Err("uploaded status requires uploadedAt".to_string());
        }
        if self.remote_model_links.values().any(|existing| {
            existing.profile_id == link.profile_id
                && existing.local_model_hash != link.local_model_hash
                && (existing.remote_model_id == link.remote_model_id
                    || existing.client_upload_id == link.client_upload_id)
        }) {
            return Err(
                "remoteModelId/clientUploadId is already linked in this profile".to_string(),
            );
        }
        self.remote_model_links.insert(key, link.clone());
        self.sync_statuses
            .entry(link.profile_id.clone())
            .or_insert_with(|| SyncStatusDto::empty(&link.profile_id));
        Ok(link)
    }

    fn remote_model_link(
        &self,
        profile_id: &str,
        local_model_hash: &str,
    ) -> Result<Option<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_local_hash(local_model_hash)?;
        Ok(self
            .remote_model_links
            .get(&(profile_id.to_string(), local_model_hash.to_string()))
            .cloned())
    }

    fn remote_model_links(
        &self,
        profile_id: &str,
        limit: usize,
    ) -> Result<Vec<RemoteModelLinkDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_limit(limit)?;
        let mut links: Vec<_> = self
            .remote_model_links
            .values()
            .filter(|link| link.profile_id == profile_id)
            .cloned()
            .collect();
        links.sort_by(|a, b| a.local_model_hash.cmp(&b.local_model_hash));
        links.truncate(limit);
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
        let mut entities: Vec<_> = self
            .sync_entities
            .values()
            .filter(|entity| {
                entity.profile_id == profile_id
                    && entity_type.is_none_or(|kind| entity.entity_type == kind)
            })
            .cloned()
            .collect();
        entities.sort_by(|a, b| {
            a.entity_type
                .as_db()
                .cmp(b.entity_type.as_db())
                .then(a.remote_id.cmp(&b.remote_id))
        });
        entities.truncate(limit);
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
        Ok(self
            .sync_entities
            .get(&(profile_id.to_string(), entity_type, remote_id.to_string()))
            .cloned())
    }

    fn entity_revision_by_local(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        local_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("localId", local_id)?;
        Ok(self
            .sync_entities
            .values()
            .find(|entity| {
                entity.profile_id == profile_id
                    && entity.entity_type == entity_type
                    && entity.local_id.as_deref() == Some(local_id)
            })
            .cloned())
    }

    fn enqueue_outbound_operations(
        &mut self,
        profile_id: &str,
        batch_id: &str,
        operations: Vec<EnqueueOutboundOperationDto>,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_enqueue_batch(profile_id, &operations)?;
        sync::validate_identifier("batchId", batch_id)?;
        self.begin_batch()?;
        let result = (|| {
            let mut queued = Vec::with_capacity(operations.len());
            for (ordinal, operation) in operations.into_iter().enumerate() {
                let key = (profile_id.to_string(), operation.operation_id.clone());
                if let Some(existing) = self.sync_outbox.get(&key) {
                    if !outbound_matches_input(existing, batch_id, ordinal as u32, &operation) {
                        return Err(format!(
                            "operationId {} has different persisted content",
                            operation.operation_id
                        ));
                    }
                    queued.push(existing.clone());
                    continue;
                }
                if self.sync_outbox.values().any(|existing| {
                    existing.profile_id == profile_id
                        && existing.batch_id == batch_id
                        && existing.batch_ordinal == ordinal as u32
                }) {
                    return Err("batchId/ordinal already has a different operation".to_string());
                }
                let sequence = self
                    .next_outbox_sequence
                    .entry(profile_id.to_string())
                    .or_insert(1);
                let record = OutboundOperationDto {
                    profile_id: profile_id.to_string(),
                    operation_id: operation.operation_id,
                    sequence: *sequence,
                    batch_id: batch_id.to_string(),
                    batch_ordinal: ordinal as u32,
                    entity_type: operation.entity_type,
                    operation: operation.operation,
                    entity_id: operation.entity_id,
                    payload: operation.payload,
                    base_revision: operation.base_revision,
                    concurrency_token: operation.concurrency_token,
                    state: OutboundState::Pending,
                    attempt_count: 0,
                    retry_eligible: true,
                    retry_at: None,
                    lease_until: None,
                    lease_token: None,
                    last_error: None,
                    created_at: operation.created_at,
                    updated_at: operation.created_at,
                    acked_at: None,
                };
                *sequence = sequence
                    .checked_add(1)
                    .ok_or_else(|| "outbound sequence overflow".to_string())?;
                self.sync_outbox.insert(key, record.clone());
                queued.push(record);
            }
            let persisted_count = self
                .sync_outbox
                .values()
                .filter(|operation| {
                    operation.profile_id == profile_id && operation.batch_id == batch_id
                })
                .count();
            if persisted_count != queued.len() {
                return Err("batchId has different persisted operation count".to_string());
            }
            self.sync_statuses
                .entry(profile_id.to_string())
                .or_insert_with(|| SyncStatusDto::empty(profile_id));
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
        let mut operations: Vec<_> = self
            .sync_outbox
            .values()
            .filter(|operation| {
                operation.profile_id == profile_id
                    && (if states.is_empty() {
                        operation.state != OutboundState::Acked
                    } else {
                        states.contains(&operation.state)
                    })
            })
            .cloned()
            .collect();
        operations.sort_by_key(|operation| operation.sequence);
        operations.truncate(limit);
        Ok(operations)
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
            recover_memory_outbox(self, profile_id, now);
            let batch_id = self
                .sync_outbox
                .values()
                .filter(|operation| {
                    operation.profile_id == profile_id && operation.state != OutboundState::Acked
                })
                .min_by_key(|operation| operation.sequence)
                .map(|operation| operation.batch_id.clone());
            let Some(batch_id) = batch_id else {
                return Ok(None);
            };
            let mut keys: Vec<_> = self
                .sync_outbox
                .iter()
                .filter(|(_, operation)| {
                    operation.profile_id == profile_id && operation.batch_id == batch_id
                })
                .map(|(key, operation)| (operation.batch_ordinal, key.clone()))
                .collect();
            keys.sort();
            if keys.iter().any(|(_, key)| {
                let operation = &self.sync_outbox[key];
                !operation.retry_eligible
                    || !(operation.state == OutboundState::Pending
                        || (operation.state == OutboundState::Failed
                            && operation.retry_at.is_some_and(|retry_at| retry_at <= now)))
            }) {
                return Ok(None);
            }
            if keys.len() > limit || keys.len() > sync::MAX_SYNC_BATCH {
                return Err("claim limit would split the next logical batch".to_string());
            }
            let lease_token = sync::new_lease_token();
            let mut claimed = Vec::with_capacity(keys.len());
            for (_, key) in keys {
                let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
                operation.state = OutboundState::InFlight;
                operation.attempt_count = operation
                    .attempt_count
                    .checked_add(1)
                    .ok_or_else(|| "attempt count overflow".to_string())?;
                operation.retry_at = None;
                operation.lease_until = Some(lease_until);
                operation.lease_token = Some(lease_token.clone());
                operation.updated_at = now;
                claimed.push(operation.clone());
            }
            Ok(Some(ClaimedOutboundBatchDto {
                profile_id: profile_id.to_string(),
                batch_id,
                lease_token,
                lease_until,
                operations: claimed,
            }))
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
        Ok(recover_memory_outbox(self, profile_id, now))
    }

    fn complete_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        lease_token: &str,
        completed_at: i64,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
        sync::validate_identifier("leaseToken", lease_token)?;
        sync::validate_timestamp("completedAt", completed_at)?;
        let batch_id = self
            .sync_outbox
            .get(&(profile_id.to_string(), operation_id.to_string()))
            .map(|operation| operation.batch_id.clone())
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if self
            .sync_outbox
            .values()
            .filter(|operation| {
                operation.profile_id == profile_id && operation.batch_id == batch_id
            })
            .count()
            != 1
        {
            return Err("multi-operation batches require transactional settlement".to_string());
        }
        let operation = self
            .sync_outbox
            .get_mut(&(profile_id.to_string(), operation_id.to_string()))
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if operation.state != OutboundState::InFlight
            || operation.lease_token.as_deref() != Some(lease_token)
        {
            return Err("operation is not owned by the active lease".to_string());
        }
        if completed_at < operation.updated_at {
            return Err("completedAt must not precede the claim timestamp".to_string());
        }
        operation.state = OutboundState::Acked;
        operation.retry_eligible = false;
        operation.lease_until = None;
        operation.lease_token = None;
        operation.retry_at = None;
        operation.last_error = None;
        operation.updated_at = completed_at;
        operation.acked_at = Some(completed_at);
        let result = operation.clone();
        let status = self
            .sync_statuses
            .entry(profile_id.to_string())
            .or_insert_with(|| SyncStatusDto::empty(profile_id));
        status.last_pushed_at = Some(completed_at);
        status.updated_at = completed_at;
        Ok(result)
    }

    fn fail_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        lease_token: &str,
        error: &str,
        failed_at: i64,
        retry_at: Option<i64>,
    ) -> Result<OutboundOperationDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("operationId", operation_id)?;
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
        let batch_id = self
            .sync_outbox
            .get(&(profile_id.to_string(), operation_id.to_string()))
            .map(|operation| operation.batch_id.clone())
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if self
            .sync_outbox
            .values()
            .filter(|operation| {
                operation.profile_id == profile_id && operation.batch_id == batch_id
            })
            .count()
            != 1
        {
            return Err("multi-operation batches require transactional settlement".to_string());
        }
        let operation = self
            .sync_outbox
            .get_mut(&(profile_id.to_string(), operation_id.to_string()))
            .ok_or_else(|| "outbound operation not found".to_string())?;
        if operation.state != OutboundState::InFlight
            || operation.lease_token.as_deref() != Some(lease_token)
        {
            return Err("operation is not owned by the active lease".to_string());
        }
        if failed_at < operation.updated_at {
            return Err("failedAt must not precede the claim timestamp".to_string());
        }
        operation.state = OutboundState::Failed;
        operation.retry_eligible = retry_at.is_some();
        operation.retry_at = retry_at;
        operation.lease_until = None;
        operation.lease_token = None;
        operation.last_error = Some(error.to_string());
        operation.updated_at = failed_at;
        Ok(operation.clone())
    }

    fn settle_outbound_batch(
        &mut self,
        settlement: SettleOutboundBatchDto,
    ) -> Result<SettledOutboundBatchDto, String> {
        sync::validate_settlement(&settlement)?;
        let mut keys: Vec<_> = self
            .sync_outbox
            .iter()
            .filter(|(_, operation)| {
                operation.profile_id == settlement.profile_id
                    && operation.batch_id == settlement.batch_id
            })
            .map(|(key, operation)| (operation.batch_ordinal, key.clone()))
            .collect();
        keys.sort();
        if keys.is_empty() {
            return Err("outbound batch not found".to_string());
        }
        if keys.iter().any(|(_, key)| {
            let operation = &self.sync_outbox[key];
            operation.state != OutboundState::InFlight
                || operation.lease_token.as_deref() != Some(&settlement.lease_token)
        }) {
            return Err("outbound batch is not owned by the active lease".to_string());
        }
        let operation_ids: std::collections::HashSet<_> = keys
            .iter()
            .map(|(_, key)| self.sync_outbox[key].operation_id.as_str())
            .collect();
        if !settlement.applied.is_empty()
            && (settlement.applied.len() != keys.len()
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

        self.begin_batch()?;
        let result = (|| {
            let mut conflict_records = Vec::new();
            if settlement.conflicts.is_empty() {
                for applied in &settlement.applied {
                    let key = keys
                        .iter()
                        .find(|(_, key)| self.sync_outbox[key].operation_id == applied.operation_id)
                        .map(|(_, key)| key.clone())
                        .expect("settlement operation was preflighted");
                    let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
                    operation.state = OutboundState::Acked;
                    operation.retry_eligible = false;
                    operation.retry_at = None;
                    operation.lease_until = None;
                    operation.lease_token = None;
                    operation.last_error = None;
                    operation.updated_at = settlement.settled_at;
                    operation.acked_at = Some(settlement.settled_at);
                    let mapping = EntityRevisionDto {
                        profile_id: settlement.profile_id.clone(),
                        entity_type: operation.entity_type,
                        local_id: Some(operation.entity_id.clone()),
                        remote_id: applied.remote_id.clone(),
                        revision: applied.revision,
                        concurrency_token: applied.concurrency_token.clone(),
                        tombstone: operation.operation == sync::SyncOperationKind::Delete,
                        visibility: SyncVisibility::Private,
                        snapshot: None,
                        updated_at: settlement.settled_at,
                    };
                    self.sync_entities.insert(
                        (
                            settlement.profile_id.clone(),
                            operation.entity_type,
                            applied.remote_id.clone(),
                        ),
                        mapping,
                    );
                }
            } else {
                for (_, key) in &keys {
                    let operation = self.sync_outbox.get_mut(key).expect("outbox key exists");
                    operation.state = OutboundState::Failed;
                    operation.retry_eligible = false;
                    operation.retry_at = None;
                    operation.lease_until = None;
                    operation.lease_token = None;
                    operation.last_error = Some("server conflict".to_string());
                    operation.updated_at = settlement.settled_at;
                }
                for conflict in &settlement.conflicts {
                    conflict_records.push(insert_memory_conflict(
                        self,
                        &settlement.profile_id,
                        &conflict.conflict,
                    )?);
                }
            }
            let status = self
                .sync_statuses
                .entry(settlement.profile_id.clone())
                .or_insert_with(|| SyncStatusDto::empty(&settlement.profile_id));
            status.server_revision = status.server_revision.max(settlement.server_revision);
            status.last_pushed_at = Some(settlement.settled_at);
            status.updated_at = settlement.settled_at;
            let operations = keys
                .iter()
                .map(|(_, key)| self.sync_outbox[key].clone())
                .collect();
            Ok(SettledOutboundBatchDto {
                operations,
                conflicts: conflict_records,
            })
        })();
        match result {
            Ok(settled) => {
                self.commit_batch()?;
                Ok(settled)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
    }

    fn reconcile_uncertain_batch(
        &mut self,
        reconciliation: ReconcileUncertainBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_reconciliation(&reconciliation)?;
        let mut keys: Vec<_> = self
            .sync_outbox
            .iter()
            .filter(|(_, operation)| {
                operation.profile_id == reconciliation.profile_id
                    && operation.batch_id == reconciliation.batch_id
            })
            .map(|(key, operation)| (operation.batch_ordinal, key.clone()))
            .collect();
        keys.sort();
        if keys.is_empty()
            || keys
                .iter()
                .any(|(_, key)| self.sync_outbox[key].state != OutboundState::Uncertain)
        {
            return Err("only a wholly uncertain batch can be reconciled".to_string());
        }
        let mut operations = Vec::with_capacity(keys.len());
        for (_, key) in keys {
            let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
            operation.state = match reconciliation.resolution {
                UnknownOutcomeResolution::Acked => OutboundState::Acked,
                UnknownOutcomeResolution::Requeue => OutboundState::Pending,
            };
            operation.retry_eligible =
                reconciliation.resolution == UnknownOutcomeResolution::Requeue;
            operation.base_revision = reconciliation.base_revision;
            operation
                .concurrency_token
                .clone_from(&reconciliation.concurrency_token);
            operation.lease_until = None;
            operation.lease_token = None;
            operation.retry_at = None;
            operation.updated_at = reconciliation.reconciled_at;
            operation.acked_at = (reconciliation.resolution == UnknownOutcomeResolution::Acked)
                .then_some(reconciliation.reconciled_at);
            operations.push(operation.clone());
        }
        Ok(operations)
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
        let mut keys: Vec<_> = self
            .sync_outbox
            .iter()
            .filter(|(_, operation)| {
                operation.profile_id == profile_id
                    && operation.state == OutboundState::Acked
                    && operation
                        .acked_at
                        .is_some_and(|acked_at| acked_at < acked_before)
            })
            .map(|(key, operation)| (operation.sequence, key.clone()))
            .collect();
        keys.sort();
        keys.truncate(limit);
        for (_, key) in &keys {
            self.sync_outbox.remove(key);
        }
        Ok(keys.len())
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
            let mut records = Vec::with_capacity(conflicts.len());
            for conflict in &conflicts {
                records.push(insert_memory_conflict(self, profile_id, conflict)?);
            }
            self.sync_statuses
                .entry(profile_id.to_string())
                .or_insert_with(|| SyncStatusDto::empty(profile_id));
            Ok(records)
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
        let mut conflicts: Vec<_> = self
            .sync_conflicts
            .values()
            .filter(|conflict| {
                conflict.profile_id == profile_id
                    && (include_resolved || conflict.resolved_at.is_none())
            })
            .cloned()
            .collect();
        conflicts.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then(a.conflict_id.cmp(&b.conflict_id))
        });
        conflicts.truncate(limit);
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
        let conflict = self
            .sync_conflicts
            .get_mut(&(profile_id.to_string(), conflict_id.to_string()))
            .ok_or_else(|| "sync conflict not found".to_string())?;
        if conflict.resolved_at.is_some() {
            return Err("sync conflict is already resolved".to_string());
        }
        if resolved_at < conflict.created_at {
            return Err("resolvedAt must not precede createdAt".to_string());
        }
        conflict.resolved_at = Some(resolved_at);
        conflict.resolution = Some(resolution);
        Ok(conflict.clone())
    }
}

fn outbound_matches_input(
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

fn insert_memory_conflict(
    store: &mut InMemoryCatalog,
    profile_id: &str,
    input: &ConflictInputDto,
) -> Result<SyncConflictDto, String> {
    let key = (profile_id.to_string(), input.conflict_id.clone());
    if let Some(existing) = store.sync_conflicts.get(&key) {
        let matches = existing.entity_type == input.entity_type
            && existing.entity_id == input.entity_id
            && existing.local_payload == input.local_payload
            && existing.server_payload == input.server_payload
            && existing.submitted_payload == input.submitted_payload
            && existing.reason == input.reason
            && existing.server_revision == input.server_revision
            && existing.created_at == input.created_at;
        return if matches {
            Ok(existing.clone())
        } else {
            Err(format!(
                "conflictId {} has different persisted content",
                input.conflict_id
            ))
        };
    }
    let record = SyncConflictDto {
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
    store.sync_conflicts.insert(key, record.clone());
    Ok(record)
}

fn recover_memory_outbox(store: &mut InMemoryCatalog, profile_id: &str, now: i64) -> usize {
    let mut recovered = 0;
    for operation in store.sync_outbox.values_mut().filter(|operation| {
        operation.profile_id == profile_id
            && operation.state == OutboundState::InFlight
            && operation
                .lease_until
                .is_some_and(|lease_until| lease_until <= now)
    }) {
        operation.state = OutboundState::Uncertain;
        operation.retry_eligible = false;
        operation.lease_until = None;
        operation.lease_token = None;
        operation.retry_at = None;
        operation.updated_at = now;
        recovered += 1;
    }
    recovered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_root;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn scan(root: &Path) -> ScanResult {
        scan_root(root, &AtomicBool::new(false))
    }

    #[test]
    fn identical_bytes_across_paths_form_one_duplicate_group() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"same-bytes");
        write(&root.join("nested/copy.stl"), b"same-bytes");
        write(&root.join("other.stl"), b"different");

        let mut store = InMemoryCatalog::new();
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

        let mut store = InMemoryCatalog::new();
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

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        let first_hash = store.models()[0].hash.clone();

        // Rewrite with different bytes; fingerprint (size) changes.
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

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        fs::remove_file(&file).unwrap();
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.missing, 1);
        // The model still exists, but its location is unavailable.
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert!(!models[0].locations[0].available);
    }

    #[test]
    fn reappearing_file_becomes_available_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("m.stl");
        write(&file, b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        fs::remove_file(&file).unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        write(&file, b"bytes");
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.added + report.unchanged + report.changed, 1);
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn cancelled_scan_does_not_mark_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        let cancelled = ScanResult {
            cancelled: true,
            ..Default::default()
        };
        let report = reconcile_root(&mut store, "r", &cancelled);
        assert_eq!(report.missing, 0);
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn scan_with_traversal_errors_does_not_mark_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        let incomplete = ScanResult {
            skipped_errors: 1,
            ..Default::default()
        };
        let report = reconcile_root(&mut store, "r", &incomplete);
        assert_eq!(report.missing, 0);
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn in_memory_batch_can_roll_back_catalog_mutations() {
        let mut store = InMemoryCatalog::new();
        store.begin_batch().unwrap();
        store.create_collection("Temporary").unwrap();

        store.rollback_batch();

        assert!(store.all_collections().is_empty());
    }

    fn one_model_store() -> (InMemoryCatalog, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");
        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();
        (store, hash)
    }

    #[test]
    fn tags_are_normalized_deduped_and_assigned() {
        let (mut store, hash) = one_model_store();

        let tag = store.add_model_tag(&hash, "  Miniatures ").unwrap();
        assert_eq!(tag.id, "miniatures");
        assert_eq!(tag.name, "Miniatures");

        // Different casing collapses to the same tag id.
        store.add_model_tag(&hash, "MINIATURES");
        assert_eq!(store.tags_for_model(&hash).len(), 1);
        assert_eq!(store.all_tags().len(), 1);

        // Blank names are rejected.
        assert!(store.add_model_tag(&hash, "   ").is_none());
        // Unknown models cannot be tagged.
        assert!(store.add_model_tag("nope", "x").is_none());
    }

    #[test]
    fn removing_the_last_assignment_prunes_the_tag() {
        let (mut store, hash) = one_model_store();
        let tag = store.add_model_tag(&hash, "wip").unwrap();
        assert_eq!(store.all_tags().len(), 1);

        store.remove_model_tag(&hash, &tag.id);
        assert!(store.tags_for_model(&hash).is_empty());
        assert!(store.all_tags().is_empty());
    }

    #[test]
    fn collections_track_membership_and_counts() {
        let (mut store, hash) = one_model_store();

        assert!(store.create_collection("  ").is_none());
        let coll = store.create_collection(" Dragons ").unwrap();
        assert_eq!(coll.name, "Dragons");
        assert_eq!(coll.member_count, 0);

        assert!(store.add_model_to_collection(&coll.id, &hash));
        // Unknown collection or model cannot form a membership.
        assert!(!store.add_model_to_collection("nope", &hash));
        assert!(!store.add_model_to_collection(&coll.id, "nope"));

        let for_model = store.collections_for_model(&hash);
        assert_eq!(for_model.len(), 1);
        assert_eq!(for_model[0].member_count, 1);

        store.remove_model_from_collection(&coll.id, &hash);
        assert!(store.collections_for_model(&hash).is_empty());
        // The collection itself survives losing its last member.
        assert_eq!(store.all_collections().len(), 1);

        store.delete_collection(&coll.id);
        assert!(store.all_collections().is_empty());
    }
}
