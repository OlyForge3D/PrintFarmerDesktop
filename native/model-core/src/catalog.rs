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

use crate::calibration::{
    CalibrationConflictDto, CalibrationCursorStateDto, CalibrationPendingOpDto,
    CalibrationUnhydratedProjectDto, CalibrationWorkspaceStateDto,
    SaveCalibrationWorkspaceStateParams,
};
use crate::hash::{hash_file, ContentHash};
use crate::model::{FileFingerprint, ModelFormat};
use crate::scan::ScanResult;
use crate::sync::{
    self, ApplyPullBatchDto, ClaimedOutboundBatchDto, CollectionSnapshotDto, ConflictInputDto,
    ConflictResolution, DisposeFailedBatchDto, EnqueueOutboundOperationDto, EntityRevisionDto,
    FailOutboundBatchDto, MembershipSnapshotDto, OutboundFailureOutcome, OutboundOperationDto,
    OutboundState, ReconcileUncertainBatchDto, RemoteModelLinkDto, SettleOutboundBatchDto,
    SettledOutboundBatchDto, SyncConflictDto, SyncEntityType, SyncStatusDto, SyncVisibility,
    TagSnapshotDto, UnknownOutcomeResolution,
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

/// Result of clearing local indexed content. Organization definitions and
/// server-backed state are deliberately outside this operation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CatalogResetSummary {
    pub models_removed: usize,
    pub source_roots_removed: usize,
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

    /// Clear local models, locations, roots, favorites, and memberships while
    /// preserving source files, tags, collections, and server-backed state.
    fn reset_catalog(&mut self) -> CatalogResetSummary;

    /// Logical models with more than one physical location.
    fn duplicate_groups(&self) -> Vec<LogicalModel> {
        self.models()
            .into_iter()
            .filter(LogicalModel::is_duplicate_group)
            .collect()
    }

    /// Every favorited model hash, sorted. Default: none.
    fn favorite_hashes(&self) -> Vec<ContentHash> {
        Vec::new()
    }

    /// Mark a model as a local favorite. Returns whether the favorite now holds.
    fn add_favorite(&mut self, _hash: &str) -> bool {
        false
    }

    /// Remove a model from local favorites. Default: no-op.
    fn remove_favorite(&mut self, _hash: &str) {}

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

    fn update_collection(
        &mut self,
        _id: &str,
        _name: &str,
        _shared_to_farm: bool,
    ) -> Option<Collection> {
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

    fn create_collection_with_sync(
        &mut self,
        name: &str,
        profile_id: &str,
        profile_binding: &str,
        now: i64,
    ) -> Result<Collection, String> {
        self.validate_sync_profile_binding(profile_id, profile_binding)?;
        self.begin_batch()?;
        let result = (|| -> Result<Collection, String> {
            let collection = self
                .create_collection(name)
                .ok_or_else(|| "collection name must not be blank".to_string())?;
            let remote_id = sync::new_remote_guid();
            self.enqueue_outbound_operations(
                profile_id,
                &sync::new_operation_token("local-batch"),
                vec![EnqueueOutboundOperationDto {
                    operation_id: sync::new_operation_token("local-create-collection"),
                    entity_type: SyncEntityType::ModelCollection,
                    operation: sync::SyncOperationKind::Create,
                    entity_id: collection.id.clone(),
                    payload: serde_json::json!({
                        "remoteId": remote_id,
                        "name": collection.name,
                        "description": null,
                        "isShared": collection.shared_to_farm
                    }),
                    base_revision: None,
                    concurrency_token: None,
                    created_at: now,
                }],
            )?;
            self.provision_entity_mapping(EntityRevisionDto {
                profile_id: profile_id.to_string(),
                entity_type: SyncEntityType::ModelCollection,
                local_id: Some(collection.id.clone()),
                remote_id,
                revision: 0,
                concurrency_token: None,
                tombstone: false,
                visibility: SyncVisibility::Private,
                snapshot: None,
                updated_at: now,
            })?;
            Ok(collection)
        })();
        finish_catalog_batch(self, result)
    }

    fn delete_collection_with_sync(
        &mut self,
        id: &str,
        profile_id: &str,
        profile_binding: &str,
        now: i64,
    ) -> Result<(), String> {
        self.validate_sync_profile_binding(profile_id, profile_binding)?;
        let mapping =
            self.entity_revision_by_local(profile_id, SyncEntityType::ModelCollection, id)?;
        let has_pending_create = self
            .outbound_operations(profile_id, &[], sync::MAX_SYNC_BATCH)?
            .iter()
            .any(|operation| {
                operation.entity_type == SyncEntityType::ModelCollection
                    && operation.operation == sync::SyncOperationKind::Create
                    && operation.entity_id == id
            });
        if mapping
            .as_ref()
            .is_some_and(|value| value.visibility == SyncVisibility::Shared)
        {
            return Err("shared remote collections are read-only".to_string());
        }
        self.begin_batch()?;
        let result = (|| {
            self.delete_collection(id);
            if mapping.is_some() || has_pending_create {
                self.enqueue_outbound_operations(
                    profile_id,
                    &sync::new_operation_token("local-batch"),
                    vec![EnqueueOutboundOperationDto {
                        operation_id: sync::new_operation_token("local-delete-collection"),
                        entity_type: SyncEntityType::ModelCollection,
                        operation: sync::SyncOperationKind::Delete,
                        entity_id: id.to_string(),
                        payload: serde_json::json!({}),
                        base_revision: mapping.as_ref().map(|value| value.revision),
                        concurrency_token: mapping.and_then(|value| value.concurrency_token),
                        created_at: now,
                    }],
                )?;
            }

            Ok(())
        })();
        finish_catalog_batch(self, result)
    }

    fn update_collection_with_sync(
        &mut self,
        id: &str,
        name: &str,
        shared_to_farm: bool,
        profile_id: &str,
        profile_binding: &str,
        now: i64,
    ) -> Result<Collection, String> {
        self.validate_sync_profile_binding(profile_id, profile_binding)?;
        let mapping =
            self.entity_revision_by_local(profile_id, SyncEntityType::ModelCollection, id)?;
        let has_pending_create = self
            .outbound_operations(profile_id, &[], sync::MAX_SYNC_BATCH)?
            .iter()
            .any(|operation| {
                operation.entity_type == SyncEntityType::ModelCollection
                    && operation.operation == sync::SyncOperationKind::Create
                    && operation.entity_id == id
            });
        if mapping
            .as_ref()
            .is_some_and(|value| value.visibility == SyncVisibility::Shared)
        {
            return Err("shared remote collections are read-only".to_string());
        }
        self.begin_batch()?;
        let result = (|| {
            let collection = self
                .update_collection(id, name, shared_to_farm)
                .ok_or_else(|| "collection not found or name is blank".to_string())?;
            if mapping.is_some() || has_pending_create {
                self.enqueue_outbound_operations(
                    profile_id,
                    &sync::new_operation_token("local-batch"),
                    vec![EnqueueOutboundOperationDto {
                        operation_id: sync::new_operation_token("local-update-collection"),
                        entity_type: SyncEntityType::ModelCollection,
                        operation: sync::SyncOperationKind::Update,
                        entity_id: id.to_string(),
                        payload: serde_json::json!({
                            "name": collection.name,
                            "description": null,
                            "isShared": collection.shared_to_farm
                        }),
                        base_revision: mapping.as_ref().map(|value| value.revision),
                        concurrency_token: mapping.and_then(|value| value.concurrency_token),
                        created_at: now,
                    }],
                )?;
            }
            Ok(collection)
        })();
        finish_catalog_batch(self, result)
    }

    fn add_model_to_collection_with_sync(
        &mut self,
        id: &str,
        hash: &str,
        profile_id: &str,
        profile_binding: &str,
        now: i64,
    ) -> Result<bool, String> {
        self.validate_sync_profile_binding(profile_id, profile_binding)?;
        if self
            .entity_revision_by_local(profile_id, SyncEntityType::ModelCollection, id)?
            .is_some_and(|value| value.visibility == SyncVisibility::Shared)
        {
            return Err("shared remote collections are read-only".to_string());
        }
        let already_present = self
            .collections_for_model(hash)
            .iter()
            .any(|collection| collection.id == id);
        self.begin_batch()?;
        let result = (|| {
            let pending_delete = self.pending_membership_delete(profile_id, id, hash)?;
            let added = self.add_model_to_collection(id, hash);
            // Coalesce a rapid remove-then-add toggle: if the compensating
            // Delete never left the outbox, the server was never told the
            // membership went away, so cancelling it nets to zero outbound
            // operations instead of sending a redundant Create. If the
            // Delete already left `Pending` (claimed, in flight, or
            // otherwise unsettled), cancellation is a safe no-op and we fall
            // back to the original behaviour of queuing a fresh Create.
            let cancelled_pending_delete = if let Some(pending) = &pending_delete {
                self.cancel_pending_outbound_operation(profile_id, &pending.operation_id)?
            } else {
                false
            };
            if added && !already_present && !cancelled_pending_delete {
                let remote_id = sync::new_remote_guid();
                self.enqueue_outbound_operations(
                    profile_id,
                    &sync::new_operation_token("local-batch"),
                    vec![EnqueueOutboundOperationDto {
                        operation_id: sync::new_operation_token("local-create-membership"),
                        entity_type: SyncEntityType::ModelCollectionMembership,
                        operation: sync::SyncOperationKind::Create,
                        entity_id: format!("membership-{remote_id}"),
                        payload: serde_json::json!({
                            "remoteId": remote_id,
                            "collectionId": id,
                            "modelHash": hash
                        }),
                        base_revision: None,
                        concurrency_token: None,
                        created_at: now,
                    }],
                )?;
            }
            Ok(added)
        })();
        finish_catalog_batch(self, result)
    }

    fn remove_model_from_collection_with_sync(
        &mut self,
        id: &str,
        hash: &str,
        profile_id: &str,
        profile_binding: &str,
        now: i64,
    ) -> Result<(), String> {
        self.validate_sync_profile_binding(profile_id, profile_binding)?;
        if self
            .entity_revision_by_local(profile_id, SyncEntityType::ModelCollection, id)?
            .is_some_and(|value| value.visibility == SyncVisibility::Shared)
        {
            return Err("shared remote collections are read-only".to_string());
        }
        let existed = self
            .collections_for_model(hash)
            .iter()
            .any(|collection| collection.id == id);
        self.begin_batch()?;
        let result = (|| {
            let collection_remote = self
                .entity_revision_by_local(profile_id, SyncEntityType::ModelCollection, id)?
                .map(|mapping| mapping.remote_id);
            let model_remote = self
                .remote_model_link(profile_id, profile_binding, hash)?
                .map(|link| link.remote_model_id);
            let membership = match (collection_remote, model_remote) {
                (Some(collection_remote), Some(model_remote)) => {
                    self.membership_revision(profile_id, &collection_remote, &model_remote)?
                }
                _ => None,
            };
            let pending_membership = self.pending_membership_create(profile_id, id, hash)?;
            self.remove_model_from_collection(id, hash);
            // Coalesce a rapid add-then-remove toggle: if the compensating
            // Create never left the outbox, the server was never told about
            // this membership, so cancelling it nets to zero outbound
            // operations instead of queuing a Delete for something the
            // server doesn't know exists. If the Create already left
            // `Pending`, cancellation is a safe no-op and we fall back to
            // the original behaviour below.
            let cancelled_pending_create = if let Some(pending) = &pending_membership {
                self.cancel_pending_outbound_operation(profile_id, &pending.operation_id)?
            } else {
                false
            };
            let still_pending = pending_membership.is_some() && !cancelled_pending_create;
            if existed && (membership.is_some() || still_pending) {
                let entity_id = membership
                    .as_ref()
                    .and_then(|value| value.local_id.clone())
                    .or_else(|| {
                        pending_membership
                            .as_ref()
                            .map(|value| value.entity_id.clone())
                    })
                    .or_else(|| membership.as_ref().map(|value| value.remote_id.clone()))
                    .expect("membership deletion has a durable identity");
                self.enqueue_outbound_operations(
                    profile_id,
                    &sync::new_operation_token("local-batch"),
                    vec![EnqueueOutboundOperationDto {
                        operation_id: sync::new_operation_token("local-delete-membership"),
                        entity_type: SyncEntityType::ModelCollectionMembership,
                        operation: sync::SyncOperationKind::Delete,
                        entity_id,
                        payload: serde_json::json!({
                            "collectionId": id,
                            "modelHash": hash
                        }),
                        base_revision: membership.as_ref().map(|value| value.revision),
                        concurrency_token: membership.and_then(|value| value.concurrency_token),
                        created_at: now,
                    }],
                )?;
            }
            Ok(())
        })();
        finish_catalog_batch(self, result)
    }

    /// Read the opaque, profile-scoped synchronization checkpoint.
    fn sync_status(&self, profile_id: &str) -> Result<SyncStatusDto, String>;

    fn bind_sync_profile(
        &mut self,
        profile_id: &str,
        binding: &str,
        now: i64,
    ) -> Result<SyncStatusDto, String>;

    fn replace_sync_profile_binding(
        &mut self,
        profile_id: &str,
        expected_binding: &str,
        new_binding: &str,
        now: i64,
    ) -> Result<SyncStatusDto, String>;

    fn validate_sync_profile_binding(&self, profile_id: &str, binding: &str) -> Result<(), String>;

    /// Atomically materialize a pull and advance its checkpoint.
    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String>;

    /// Create or refresh an idempotent local-hash to remote-model link.
    fn link_remote_model(&mut self, link: RemoteModelLinkDto)
        -> Result<RemoteModelLinkDto, String>;

    fn remote_model_link(
        &self,
        profile_id: &str,
        server_binding: &str,
        local_model_hash: &str,
    ) -> Result<Option<RemoteModelLinkDto>, String>;

    fn remote_model_links(
        &self,
        profile_id: &str,
        server_binding: &str,
        limit: usize,
    ) -> Result<Vec<RemoteModelLinkDto>, String>;

    fn remove_remote_model_link(
        &mut self,
        profile_id: &str,
        server_binding: &str,
        local_model_hash: &str,
    ) -> Result<bool, String>;

    fn purge_remote_model_links(
        &mut self,
        profile_id: &str,
        server_binding: &str,
    ) -> Result<usize, String>;

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

    fn provision_entity_mapping(&mut self, mapping: EntityRevisionDto) -> Result<(), String>;

    fn pending_membership_create(
        &self,
        profile_id: &str,
        collection_local_id: &str,
        model_hash: &str,
    ) -> Result<Option<OutboundOperationDto>, String>;

    /// Mirrors [`Self::pending_membership_create`] but looks for a still
    /// unsettled Delete instead, used to coalesce a rapid remove-then-add
    /// toggle back to zero outbound operations.
    fn pending_membership_delete(
        &self,
        profile_id: &str,
        collection_local_id: &str,
        model_hash: &str,
    ) -> Result<Option<OutboundOperationDto>, String>;

    /// Cancels an outbound operation outright, but only while it is still in
    /// `Pending` state (never claimed for an in-flight attempt). Returns
    /// `true` if a pending row was removed, `false` if the operation no
    /// longer exists or has already left `Pending` -- in which case it is
    /// already in flight (or settled) and must be allowed to run to
    /// completion rather than being torn out from under a live lease.
    fn cancel_pending_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<bool, String>;

    fn entity_revision_by_local(
        &self,
        profile_id: &str,
        entity_type: SyncEntityType,
        local_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String>;

    fn membership_revision(
        &self,
        profile_id: &str,
        collection_remote_id: &str,
        model_remote_id: &str,
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

    fn outbound_batch(
        &self,
        profile_id: &str,
        batch_id: &str,
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

    /// Atomically release or quarantine every operation in one leased batch.
    fn fail_outbound_batch(
        &mut self,
        failure: FailOutboundBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String>;

    fn complete_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        batch_incarnation: &str,
        lease_token: &str,
        completed_at: i64,
    ) -> Result<OutboundOperationDto, String>;

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
    ) -> Result<OutboundOperationDto, String>;

    fn settle_outbound_batch(
        &mut self,
        settlement: SettleOutboundBatchDto,
    ) -> Result<SettledOutboundBatchDto, String>;

    fn reconcile_uncertain_batch(
        &mut self,
        reconciliation: ReconcileUncertainBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String>;

    fn dispose_failed_batch(
        &mut self,
        disposition: DisposeFailedBatchDto,
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
        failed_disposition: Option<DisposeFailedBatchDto>,
    ) -> Result<SyncConflictDto, String>;

    // --- Calibration persistence (issue #52) ---------------------------------

    /// Save the exact local workspace state and enqueue its immutable draft
    /// mutation. Non-persistent stores conservatively return an unsynced
    /// projection without retaining it.
    fn save_calibration_workspace_state(
        &mut self,
        params: &SaveCalibrationWorkspaceStateParams,
    ) -> Result<CalibrationWorkspaceStateDto, String> {
        Ok(params.unsynced_dto())
    }

    /// List all locally persisted workspace states for a profile, newest first.
    fn list_calibration_workspace_states(
        &self,
        profile_id: &str,
    ) -> Result<Vec<CalibrationWorkspaceStateDto>, String> {
        let _ = profile_id;
        Ok(vec![])
    }

    /// List authoritative remote project summaries that cannot yet be hydrated
    /// as exact local workspace state.
    fn list_calibration_unhydrated_projects(
        &self,
        profile_id: &str,
    ) -> Result<Vec<CalibrationUnhydratedProjectDto>, String> {
        let _ = profile_id;
        Ok(vec![])
    }

    /// Fetch one profile-scoped local workspace state.
    fn get_calibration_workspace_state(
        &self,
        profile_id: &str,
        project_id: &str,
    ) -> Result<Option<CalibrationWorkspaceStateDto>, String> {
        let _ = (profile_id, project_id);
        Ok(None)
    }

    /// Persist metadata for a securely staged calibration photo. The local
    /// filesystem path is accepted from Electron main but never returned.
    fn stage_calibration_photo(
        &mut self,
        params: &crate::calibration::StageCalibrationPhotoParams,
    ) -> Result<crate::calibration::StagedCalibrationPhotoDto, String> {
        let _ = params;
        Err("staged calibration photos require a persistent catalog".to_string())
    }

    /// List pending calibration outbox operations in stable sequence order.
    /// Returns at most `limit` operations that are dependency-ready.
    fn list_calibration_pending_ops(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CalibrationPendingOpDto>, String> {
        let _ = (profile_id, project_id, limit);
        Ok(vec![])
    }

    /// Mark a calibration outbox operation as settled (server accepted it).
    fn settle_calibration_op(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        server_revision: i64,
    ) -> Result<(), String> {
        let _ = (profile_id, operation_id, server_revision);
        Ok(())
    }

    /// Mark a calibration outbox operation as exact-replay success (idempotent re-send).
    fn replay_calibration_op(
        &mut self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        let _ = (profile_id, operation_id);
        Ok(())
    }

    /// Record a calibration conflict for an outbox operation.
    fn record_calibration_conflict(
        &mut self,
        profile_id: &str,
        operation_id: &str,
        entity_type: &str,
        entity_id: &str,
        reason: &str,
        server_revision: i64,
    ) -> Result<(), String> {
        let _ = (
            profile_id,
            operation_id,
            entity_type,
            entity_id,
            reason,
            server_revision,
        );
        Ok(())
    }

    /// Mark a calibration conflict resolved with the given strategy.
    ///
    /// The default refuses rather than returning `Ok(())`. A no-op default
    /// would report success to a caller whose conflict is still unresolved,
    /// and the list query filters on `resolved_at IS NULL`, so the conflict
    /// would reappear with nothing having gone wrong anywhere a caller can see.
    fn resolve_calibration_conflict(
        &mut self,
        profile_id: &str,
        conflict_id: &str,
        resolution: &str,
    ) -> Result<(), String> {
        let _ = (profile_id, resolution);
        Err(format!(
            "cannot resolve calibration conflict {conflict_id}: \
             this catalog store has no calibration conflict storage",
        ))
    }

    /// Get the current cursor/checkpoint state for a profile+project pair.
    fn get_calibration_cursor_state(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<CalibrationCursorStateDto, String> {
        let _ = (profile_id, project_id);
        Ok(CalibrationCursorStateDto {
            cursor: None,
            server_revision: 0,
            checkpoint_generation: 0,
        })
    }

    /// Atomically commit a new cursor after a successful pull page.
    fn commit_calibration_cursor(
        &mut self,
        profile_id: &str,
        project_id: Option<&str>,
        cursor: Option<&str>,
        server_revision: i64,
        checkpoint_generation: i64,
    ) -> Result<(), String> {
        let _ = (
            profile_id,
            project_id,
            cursor,
            server_revision,
            checkpoint_generation,
        );
        Ok(())
    }

    /// Store a hydrated remote aggregate snapshot (or tombstone).
    fn apply_calibration_snapshot(
        &mut self,
        profile_id: &str,
        entity_type: &str,
        entity_id: &str,
        snapshot: Option<&serde_json::Value>,
        tombstone: bool,
        server_revision: i64,
    ) -> Result<(), String> {
        let _ = (
            profile_id,
            entity_type,
            entity_id,
            snapshot,
            tombstone,
            server_revision,
        );
        Ok(())
    }

    /// List unresolved calibration conflicts for a profile+project.
    fn list_calibration_conflicts(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<Vec<CalibrationConflictDto>, String> {
        let _ = (profile_id, project_id);
        Ok(vec![])
    }

    /// Count pending outbox operations that are not yet settled.
    fn count_calibration_pending_ops(
        &self,
        profile_id: &str,
        project_id: Option<&str>,
    ) -> Result<i64, String> {
        let _ = (profile_id, project_id);
        Ok(0)
    }

    /// Check whether the printer context for a project is freshly validated.
    fn is_printer_context_fresh(&self, profile_id: &str, project_id: &str) -> Result<bool, String> {
        let _ = (profile_id, project_id);
        Ok(false)
    }
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

fn finish_catalog_batch<S: CatalogStore + ?Sized, T>(
    store: &mut S,
    result: Result<T, String>,
) -> Result<T, String> {
    match result {
        Ok(value) => match store.commit_batch() {
            Ok(()) => Ok(value),
            Err(error) => {
                store.rollback_batch();
                Err(error)
            }
        },
        Err(error) => {
            store.rollback_batch();
            Err(error)
        }
    }
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
    /// Favorited logical model hashes.
    favorites: std::collections::BTreeSet<ContentHash>,
    /// Tag id -> display name.
    tags: HashMap<String, String>,
    /// Content hash -> assigned tag ids.
    model_tags: HashMap<ContentHash, std::collections::BTreeSet<String>>,
    /// Collection id -> (display name, shared_to_farm).
    collections: HashMap<String, (String, bool)>,
    /// Collection id -> member content hashes.
    collection_members: HashMap<String, std::collections::BTreeSet<ContentHash>>,
    sync_statuses: HashMap<String, SyncStatusDto>,
    sync_profile_bindings: HashMap<String, String>,
    remote_model_links: HashMap<(String, String, ContentHash), RemoteModelLinkDto>,
    sync_entities: HashMap<(String, SyncEntityType, String), EntityRevisionDto>,
    sync_journal_revisions: HashMap<(String, SyncEntityType, String), u64>,
    sync_materialized: HashMap<(String, SyncEntityType, String), String>,
    sync_outbox: HashMap<(String, String), OutboundOperationDto>,
    next_outbox_sequence: HashMap<String, u64>,
    sync_conflicts: HashMap<(String, String), SyncConflictDto>,
    transaction_snapshot: Option<Box<InMemoryCatalog>>,
}

impl InMemoryCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    fn remove_model_metadata(&mut self, hash: &str) {
        self.favorites.remove(hash);
        self.model_tags.remove(hash);

        let mut empty_collections = Vec::new();
        for (collection_id, members) in &mut self.collection_members {
            members.remove(hash);
            if members.is_empty() {
                empty_collections.push(collection_id.clone());
            }
        }
        for collection_id in empty_collections {
            self.collection_members.remove(&collection_id);
        }

        let used_tag_ids: std::collections::BTreeSet<_> = self
            .model_tags
            .values()
            .flat_map(|ids| ids.iter().cloned())
            .collect();
        self.tags.retain(|id, _| used_tag_ids.contains(id));
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
            favorites: self.favorites.clone(),
            tags: self.tags.clone(),
            model_tags: self.model_tags.clone(),
            collections: self.collections.clone(),
            collection_members: self.collection_members.clone(),
            sync_statuses: self.sync_statuses.clone(),
            sync_profile_bindings: self.sync_profile_bindings.clone(),
            remote_model_links: self.remote_model_links.clone(),
            sync_entities: self.sync_entities.clone(),
            sync_journal_revisions: self.sync_journal_revisions.clone(),
            sync_materialized: self.sync_materialized.clone(),
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
                        let removed_hash = prev_hash.clone();
                        self.models.remove(prev_hash);
                        self.remove_model_metadata(&removed_hash);
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

    fn reset_catalog(&mut self) -> CatalogResetSummary {
        let source_roots_removed = self
            .index
            .keys()
            .map(|(root_id, _)| root_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let summary = CatalogResetSummary {
            models_removed: self.models.len(),
            source_roots_removed,
        };
        self.models.clear();
        self.index.clear();
        self.favorites.clear();
        self.model_tags.clear();
        self.collection_members.clear();
        summary
    }

    fn favorite_hashes(&self) -> Vec<ContentHash> {
        self.favorites.iter().cloned().collect()
    }

    fn add_favorite(&mut self, hash: &str) -> bool {
        if !self.models.contains_key(hash) {
            return false;
        }
        self.favorites.insert(hash.to_string());
        true
    }

    fn remove_favorite(&mut self, hash: &str) {
        self.favorites.remove(hash);
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

    fn update_collection(
        &mut self,
        id: &str,
        name: &str,
        shared_to_farm: bool,
    ) -> Option<Collection> {
        let display = name.trim();
        if display.is_empty() || !self.collections.contains_key(id) {
            return None;
        }
        self.collections
            .insert(id.to_string(), (display.to_string(), shared_to_farm));
        Some(Collection {
            id: id.to_string(),
            name: display.to_string(),
            shared_to_farm,
            member_count: self
                .collection_members
                .get(id)
                .map_or(0, std::collections::BTreeSet::len),
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

    fn bind_sync_profile(
        &mut self,
        profile_id: &str,
        binding: &str,
        now: i64,
    ) -> Result<SyncStatusDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("profileBinding", binding)?;
        sync::validate_timestamp("now", now)?;
        if self
            .sync_profile_bindings
            .get(profile_id)
            .is_some_and(|current| {
                current != binding
                    && !(current.len() == 66 && current.ends_with(":1") && binding.ends_with(":1"))
            })
        {
            return Err("sync profile binding replacement requires CAS".to_string());
        }
        self.sync_profile_bindings
            .insert(profile_id.to_string(), binding.to_string());
        let status = self
            .sync_statuses
            .entry(profile_id.to_string())
            .or_insert_with(|| SyncStatusDto::empty(profile_id));
        status.updated_at = now;
        Ok(status.clone())
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
        // Idempotent replay: mirrors the SqliteCatalog short-circuit so a
        // retried transition (expected_binding now stale because a prior
        // attempt already committed) is treated as already-applied instead
        // of failing CAS and re-running the destructive profile-scoped wipe.
        if self
            .sync_profile_bindings
            .get(profile_id)
            .map(String::as_str)
            == Some(new_binding)
        {
            return Ok(self
                .sync_statuses
                .get(profile_id)
                .cloned()
                .unwrap_or_else(|| SyncStatusDto::empty(profile_id)));
        }
        self.validate_sync_profile_binding(profile_id, expected_binding)?;
        self.begin_batch()?;
        let result: Result<SyncStatusDto, String> = {
            let materialized: Vec<_> = self
                .sync_materialized
                .keys()
                .filter(|(profile, _, _)| profile == profile_id)
                .map(|(_, entity_type, local_id)| (*entity_type, local_id.clone()))
                .collect();
            for (entity_type, local_id) in materialized {
                match entity_type {
                    SyncEntityType::ModelCollection => {
                        self.collections.remove(&local_id);
                        self.collection_members.remove(&local_id);
                    }
                    SyncEntityType::Tag => {
                        self.tags.remove(&local_id);
                        for tags in self.model_tags.values_mut() {
                            tags.remove(&local_id);
                        }
                    }
                    SyncEntityType::ModelCollectionMembership => {}
                }
            }
            self.sync_statuses.remove(profile_id);
            self.remote_model_links
                .retain(|(profile, _, _), _| profile != profile_id);
            self.sync_entities
                .retain(|(profile, _, _), _| profile != profile_id);
            self.sync_journal_revisions
                .retain(|(profile, _, _), _| profile != profile_id);
            self.sync_materialized
                .retain(|(profile, _, _), _| profile != profile_id);
            self.sync_outbox
                .retain(|(profile, _), _| profile != profile_id);
            self.sync_conflicts
                .retain(|(profile, _), _| profile != profile_id);
            self.next_outbox_sequence.remove(profile_id);
            self.sync_profile_bindings
                .insert(profile_id.to_string(), new_binding.to_string());
            let mut status = SyncStatusDto::empty(profile_id);
            status.updated_at = now;
            self.sync_statuses
                .insert(profile_id.to_string(), status.clone());
            Ok(status)
        };
        finish_catalog_batch(self, result)
    }

    fn validate_sync_profile_binding(&self, profile_id: &str, binding: &str) -> Result<(), String> {
        if self
            .sync_profile_bindings
            .get(profile_id)
            .map(String::as_str)
            == Some(binding)
        {
            Ok(())
        } else {
            Err("stale or unbound sync profile binding".to_string())
        }
    }

    fn apply_pull_batch(&mut self, batch: ApplyPullBatchDto) -> Result<SyncStatusDto, String> {
        sync::validate_pull_batch(&batch)?;
        let current = self.sync_status(&batch.profile_id)?;
        if current.checkpoint_generation != batch.expected_checkpoint_generation {
            return Err(
                "stale pull checkpoint: expectedCheckpointGeneration does not match".to_string(),
            );
        }
        if current.cursor != batch.expected_previous_cursor {
            return Err("stale pull cursor: expectedPreviousCursor does not match".to_string());
        }
        if batch.server_revision < current.server_revision {
            return Err("serverRevision must not move backwards".to_string());
        }
        let mut previous_entities = Vec::with_capacity(batch.entities.len());
        for entity in &batch.entities {
            let journal_key = (
                batch.profile_id.clone(),
                entity.entity_type,
                entity.remote_id.clone(),
            );
            if self
                .sync_journal_revisions
                .get(&journal_key)
                .is_some_and(|revision| *revision >= entity.journal_revision)
            {
                continue;
            }
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
        }

        self.begin_batch()?;
        let result = (|| {
            let mut accepted_entities = Vec::new();
            for entity in &batch.entities {
                let journal_key = (
                    batch.profile_id.clone(),
                    entity.entity_type,
                    entity.remote_id.clone(),
                );
                if self
                    .sync_journal_revisions
                    .get(&journal_key)
                    .is_some_and(|revision| *revision >= entity.journal_revision)
                {
                    continue;
                }
                if let Some(local_id) = entity.local_id.as_deref() {
                    let pending = self
                        .sync_outbox
                        .values()
                        .find(|operation| {
                            operation.profile_id == batch.profile_id
                                && operation.entity_id == local_id
                                && operation.state != OutboundState::Acked
                        })
                        .cloned();
                    if let Some(pending) = pending {
                        insert_memory_conflict(
                            self,
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
                let key = (
                    batch.profile_id.clone(),
                    entity.entity_type,
                    entity.remote_id.clone(),
                );
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
                let previous = self.sync_entities.get(&key).cloned();
                let merge_base = previous
                    .as_ref()
                    .filter(|mapping| !(mapping.tombstone && !entity.tombstone));
                let revision = sync::merge_entity_revision(merge_base, incoming)?;
                self.sync_entities.insert(key, revision);
                self.sync_journal_revisions.insert(
                    (
                        batch.profile_id.clone(),
                        entity.entity_type,
                        entity.remote_id.clone(),
                    ),
                    entity.journal_revision,
                );
                previous_entities.push(previous);
                accepted_entities.push(entity.clone());
            }
            let mut effective_batch = batch.clone();
            effective_batch.entities = accepted_entities;
            materialize_memory_pull(self, &effective_batch, &previous_entities)?;
            for conflict in &batch.conflicts {
                insert_memory_conflict(self, &batch.profile_id, conflict)?;
            }
            let status = SyncStatusDto {
                profile_id: batch.profile_id.clone(),
                cursor: batch.cursor.clone(),
                server_revision: batch.server_revision,
                checkpoint_generation: current
                    .checkpoint_generation
                    .checked_add(1)
                    .ok_or_else(|| "checkpoint generation overflow".to_string())?,
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
        let key = (
            link.profile_id.clone(),
            link.server_binding.clone(),
            link.local_model_hash.clone(),
        );
        let link = self.remote_model_links.get(&key).map_or_else(
            || Ok(link.clone()),
            |existing| sync::merge_remote_link(existing, &link),
        )?;
        if link.upload_status == sync::RemoteUploadStatus::Uploaded && link.uploaded_at.is_none() {
            return Err("uploaded status requires uploadedAt".to_string());
        }
        if self.remote_model_links.values().any(|existing| {
            existing.profile_id == link.profile_id
                && existing.server_binding == link.server_binding
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
        materialize_memory_memberships(self, &link.profile_id)?;
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
        Ok(self
            .remote_model_links
            .get(&(
                profile_id.to_string(),
                server_binding.to_string(),
                local_model_hash.to_string(),
            ))
            .cloned())
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
        let mut links: Vec<_> = self
            .remote_model_links
            .values()
            .filter(|link| link.profile_id == profile_id && link.server_binding == server_binding)
            .cloned()
            .collect();
        links.sort_by(|a, b| a.local_model_hash.cmp(&b.local_model_hash));
        links.truncate(limit);
        Ok(links)
    }

    fn remove_remote_model_link(
        &mut self,
        profile_id: &str,
        server_binding: &str,
        local_model_hash: &str,
    ) -> Result<bool, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("serverBinding", server_binding)?;
        sync::validate_local_hash(local_model_hash)?;
        Ok(self
            .remote_model_links
            .remove(&(
                profile_id.to_string(),
                server_binding.to_string(),
                local_model_hash.to_string(),
            ))
            .is_some())
    }

    fn purge_remote_model_links(
        &mut self,
        profile_id: &str,
        server_binding: &str,
    ) -> Result<usize, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("serverBinding", server_binding)?;
        let before = self.remote_model_links.len();
        self.remote_model_links
            .retain(|(stored_profile, stored_binding, _), _| {
                stored_profile != profile_id || stored_binding != server_binding
            });
        Ok(before - self.remote_model_links.len())
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

    fn membership_revision(
        &self,
        profile_id: &str,
        collection_remote_id: &str,
        model_remote_id: &str,
    ) -> Result<Option<EntityRevisionDto>, String> {
        sync::validate_profile(profile_id)?;
        Ok(self
            .sync_entities
            .values()
            .filter(|mapping| {
                mapping.profile_id == profile_id
                    && mapping.entity_type == SyncEntityType::ModelCollectionMembership
            })
            .find(|mapping| {
                mapping.snapshot.as_ref().is_some_and(|snapshot| {
                    serde_json::from_value::<sync::MembershipSnapshotDto>(snapshot.clone())
                        .is_ok_and(|value| {
                            value.collection_id == collection_remote_id
                                && value.model_id == model_remote_id
                        })
                })
            })
            .cloned())
    }

    fn provision_entity_mapping(&mut self, mapping: EntityRevisionDto) -> Result<(), String> {
        self.sync_entities.insert(
            (
                mapping.profile_id.clone(),
                mapping.entity_type,
                mapping.remote_id.clone(),
            ),
            mapping,
        );
        Ok(())
    }

    fn pending_membership_create(
        &self,
        profile_id: &str,
        collection_local_id: &str,
        model_hash: &str,
    ) -> Result<Option<OutboundOperationDto>, String> {
        Ok(self
            .sync_outbox
            .values()
            .find(|operation| {
                operation.profile_id == profile_id
                    && operation.entity_type == SyncEntityType::ModelCollectionMembership
                    && operation.operation == sync::SyncOperationKind::Create
                    && operation.state != OutboundState::Acked
                    && operation.payload["collectionId"].as_str() == Some(collection_local_id)
                    && operation.payload["modelHash"].as_str() == Some(model_hash)
            })
            .cloned())
    }

    fn pending_membership_delete(
        &self,
        profile_id: &str,
        collection_local_id: &str,
        model_hash: &str,
    ) -> Result<Option<OutboundOperationDto>, String> {
        Ok(self
            .sync_outbox
            .values()
            .find(|operation| {
                operation.profile_id == profile_id
                    && operation.entity_type == SyncEntityType::ModelCollectionMembership
                    && operation.operation == sync::SyncOperationKind::Delete
                    && operation.state != OutboundState::Acked
                    && operation.payload["collectionId"].as_str() == Some(collection_local_id)
                    && operation.payload["modelHash"].as_str() == Some(model_hash)
            })
            .cloned())
    }

    fn cancel_pending_outbound_operation(
        &mut self,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        let key = (profile_id.to_string(), operation_id.to_string());
        if self
            .sync_outbox
            .get(&key)
            .is_some_and(|operation| operation.state == OutboundState::Pending)
        {
            self.sync_outbox.remove(&key);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn enqueue_outbound_operations(
        &mut self,
        profile_id: &str,
        batch_id: &str,
        operations: Vec<EnqueueOutboundOperationDto>,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_enqueue_batch(profile_id, &operations)?;
        sync::validate_identifier("batchId", batch_id)?;
        let owns_batch = self.transaction_snapshot.is_none();
        if owns_batch {
            self.begin_batch()?;
        }
        let result = (|| {
            let mut existing_batch: Vec<_> = self
                .sync_outbox
                .values()
                .filter(|operation| {
                    operation.profile_id == profile_id && operation.batch_id == batch_id
                })
                .cloned()
                .collect();
            existing_batch.sort_by_key(|operation| operation.batch_ordinal);
            if !existing_batch.is_empty() {
                if existing_batch.len() != operations.len()
                    || operations.iter().enumerate().any(|(ordinal, operation)| {
                        !outbound_matches_input(
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
            if operations.iter().any(|operation| {
                self.sync_outbox
                    .contains_key(&(profile_id.to_string(), operation.operation_id.clone()))
            }) {
                return Err("operationId already belongs to another logical batch".to_string());
            }
            if self.sync_conflicts.values().any(|conflict| {
                conflict.profile_id == profile_id
                    && conflict.batch_id.as_deref() == Some(batch_id)
                    && conflict.resolved_at.is_none()
            }) {
                return Err("batchId is still referenced by unresolved conflicts".to_string());
            }
            let batch_incarnation = sync::new_batch_incarnation();
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
                    batch_incarnation: batch_incarnation.clone(),
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
                    attempt_token: None,
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
                if owns_batch {
                    self.commit_batch()?;
                }
                Ok(queued)
            }
            Err(error) => {
                if owns_batch {
                    self.rollback_batch();
                }
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

    fn outbound_batch(
        &self,
        profile_id: &str,
        batch_id: &str,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("batchId", batch_id)?;
        let mut operations: Vec<_> = self
            .sync_outbox
            .values()
            .filter(|operation| {
                operation.profile_id == profile_id && operation.batch_id == batch_id
            })
            .cloned()
            .collect();
        operations.sort_by_key(|operation| operation.batch_ordinal);
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
                operation.attempt_token = Some(lease_token.clone());
                operation.updated_at = now;
                claimed.push(operation.clone());
            }
            Ok(Some(ClaimedOutboundBatchDto {
                profile_id: profile_id.to_string(),
                batch_id,
                batch_incarnation: claimed[0].batch_incarnation.clone(),
                lease_token,
                attempt_token: claimed[0]
                    .attempt_token
                    .clone()
                    .expect("claimed operations have an attempt token"),
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

    fn fail_outbound_batch(
        &mut self,
        failure: FailOutboundBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_batch_failure(&failure)?;
        self.begin_batch()?;
        let result = (|| {
            let mut keys: Vec<_> = self
                .sync_outbox
                .iter()
                .filter(|(_, operation)| {
                    operation.profile_id == failure.profile_id
                        && operation.batch_id == failure.batch_id
                })
                .map(|(key, operation)| (operation.batch_ordinal, key.clone()))
                .collect();
            keys.sort();
            if keys.is_empty()
                || keys.iter().any(|(_, key)| {
                    let operation = &self.sync_outbox[key];
                    operation.batch_incarnation != failure.batch_incarnation
                        || operation.state != OutboundState::InFlight
                        || operation.lease_token.as_deref() != Some(&failure.lease_token)
                })
            {
                return Err("outbound batch is not owned by the active lease".to_string());
            }
            let mut failed = Vec::with_capacity(keys.len());
            for (_, key) in keys {
                let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
                operation.state = match failure.outcome {
                    OutboundFailureOutcome::DefiniteTransient => OutboundState::Failed,
                    OutboundFailureOutcome::DefinitePermanent => OutboundState::Failed,
                    OutboundFailureOutcome::Ambiguous => OutboundState::Uncertain,
                };
                operation.retry_eligible =
                    failure.outcome == OutboundFailureOutcome::DefiniteTransient;
                operation.retry_at = failure.retry_at;
                operation.lease_until = None;
                operation.lease_token = None;
                operation.last_error = Some(failure.error.clone());
                operation.updated_at = failure.failed_at;
                failed.push(operation.clone());
            }
            Ok(failed)
        })();
        match result {
            Ok(failed) => {
                self.commit_batch()?;
                Ok(failed)
            }
            Err(error) => {
                self.rollback_batch();
                Err(error)
            }
        }
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
        if operation.batch_incarnation != batch_incarnation
            || operation.state != OutboundState::InFlight
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
        if operation.batch_incarnation != batch_incarnation
            || operation.state != OutboundState::InFlight
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
            operation.batch_incarnation != settlement.batch_incarnation
                || operation.state != OutboundState::InFlight
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
        let mapping_plan = if settlement.conflicts.is_empty() {
            let incoming: Vec<_> = settlement
                .applied
                .iter()
                .map(|applied| {
                    let operation = keys
                        .iter()
                        .map(|(_, key)| &self.sync_outbox[key])
                        .find(|operation| operation.operation_id == applied.operation_id)
                        .expect("settlement operation was preflighted");
                    EntityRevisionDto {
                        profile_id: settlement.profile_id.clone(),
                        entity_type: operation.entity_type,
                        local_id: Some(operation.entity_id.clone()),
                        remote_id: applied.remote_id.clone(),
                        revision: applied.revision,
                        concurrency_token: applied.concurrency_token.clone(),
                        tombstone: operation.operation == sync::SyncOperationKind::Delete,
                        visibility: SyncVisibility::Private,
                        snapshot: if operation.entity_type
                            == SyncEntityType::ModelCollectionMembership
                        {
                            let collection_id = operation.payload["collectionId"]
                                .as_str()
                                .and_then(|local_id| {
                                    self.sync_entities.values().find(|mapping| {
                                        mapping.profile_id == settlement.profile_id
                                            && mapping.entity_type
                                                == SyncEntityType::ModelCollection
                                            && mapping.local_id.as_deref() == Some(local_id)
                                    })
                                })
                                .map(|mapping| mapping.remote_id.clone());
                            let profile_binding = self
                                .sync_profile_bindings
                                .get(&settlement.profile_id)
                                .map(String::as_str)
                                .unwrap_or("legacy-unbound");
                            let model_id = operation.payload["modelHash"]
                                .as_str()
                                .and_then(|hash| {
                                    self.remote_model_links.values().find(|link| {
                                        link.profile_id == settlement.profile_id
                                            && link.server_binding == profile_binding
                                            && link.local_model_hash == hash
                                    })
                                })
                                .map(|link| link.remote_model_id.clone());
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
                        },
                        updated_at: settlement.settled_at,
                    }
                })
                .collect();
            let existing: Vec<_> = self
                .sync_entities
                .values()
                .filter(|mapping| mapping.profile_id == settlement.profile_id)
                .cloned()
                .collect();
            sync::preflight_entity_revision_set(&existing, incoming)?
        } else {
            Vec::new()
        };

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
                }
                for mapping in mapping_plan {
                    if mapping.entity_type == SyncEntityType::ModelCollection && !mapping.tombstone
                    {
                        if let Some(local_id) = mapping.local_id.as_ref() {
                            self.sync_materialized.insert(
                                (
                                    mapping.profile_id.clone(),
                                    mapping.entity_type,
                                    local_id.clone(),
                                ),
                                mapping.remote_id.clone(),
                            );
                        }
                    }
                    if let Some(local_id) = mapping.local_id.as_deref() {
                        for queued in self.sync_outbox.values_mut().filter(|queued| {
                            queued.profile_id == mapping.profile_id
                                && queued.entity_type == mapping.entity_type
                                && queued.entity_id == local_id
                                && queued.state == OutboundState::Pending
                        }) {
                            queued.base_revision = Some(mapping.revision);
                            queued
                                .concurrency_token
                                .clone_from(&mapping.concurrency_token);
                        }
                    }
                    self.sync_entities.insert(
                        (
                            mapping.profile_id.clone(),
                            mapping.entity_type,
                            mapping.remote_id.clone(),
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
                    conflict_records.push(insert_memory_conflict_associated(
                        self,
                        &settlement.profile_id,
                        &conflict.conflict,
                        Some(&settlement.batch_id),
                        Some(&conflict.operation_id),
                        Some(&settlement.batch_incarnation),
                        Some(&settlement.lease_token),
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
            || keys.iter().any(|(_, key)| {
                let operation = &self.sync_outbox[key];
                operation.batch_incarnation != reconciliation.batch_incarnation
                    || operation.attempt_token.as_deref()
                        != Some(&reconciliation.expected_attempt_token)
                    || operation.state != OutboundState::Uncertain
            })
        {
            return Err("only a wholly uncertain batch can be reconciled".to_string());
        }
        if reconciliation.operations.len() != keys.len() {
            return Err("reconciliation must cover every operation in the batch".to_string());
        }
        let replacements: HashMap<_, _> = reconciliation
            .operations
            .iter()
            .map(|entry| (entry.operation_id.as_str(), entry))
            .collect();
        if keys
            .iter()
            .any(|(_, key)| !replacements.contains_key(self.sync_outbox[key].operation_id.as_str()))
        {
            return Err("reconciliation contains a missing or foreign operationId".to_string());
        }
        let mut operations = Vec::with_capacity(keys.len());
        for (_, key) in keys {
            let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
            let replacement = replacements[operation.operation_id.as_str()];
            operation.state = match reconciliation.resolution {
                UnknownOutcomeResolution::Acked => OutboundState::Acked,
                UnknownOutcomeResolution::Requeue => OutboundState::Pending,
            };
            operation.retry_eligible =
                reconciliation.resolution == UnknownOutcomeResolution::Requeue;
            if let Some(revision) = replacement.base_revision {
                operation.base_revision = Some(revision);
            }
            if let Some(token) = &replacement.concurrency_token {
                operation.concurrency_token = Some(token.clone());
            }
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

    fn dispose_failed_batch(
        &mut self,
        disposition: DisposeFailedBatchDto,
    ) -> Result<Vec<OutboundOperationDto>, String> {
        sync::validate_failed_disposition(&disposition)?;
        let mut keys: Vec<_> = self
            .sync_outbox
            .iter()
            .filter(|(_, operation)| {
                operation.profile_id == disposition.profile_id
                    && operation.batch_id == disposition.batch_id
            })
            .map(|(key, operation)| (operation.batch_ordinal, key.clone()))
            .collect();
        keys.sort();
        if keys.is_empty()
            || keys.iter().any(|(_, key)| {
                let operation = &self.sync_outbox[key];
                operation.batch_incarnation != disposition.batch_incarnation
                    || operation.attempt_token.as_deref()
                        != Some(&disposition.expected_attempt_token)
                    || operation.state != OutboundState::Failed
            })
        {
            return Err("only a wholly failed batch can be disposed".to_string());
        }
        if self.sync_conflicts.values().any(|conflict| {
            conflict.profile_id == disposition.profile_id
                && conflict.batch_id.as_deref() == Some(&disposition.batch_id)
                && conflict.batch_incarnation.as_deref() == Some(&disposition.batch_incarnation)
                && conflict.resolved_at.is_none()
        }) {
            return Err("failed batch still has unresolved conflicts".to_string());
        }
        let replacements: HashMap<_, _> = disposition
            .operations
            .iter()
            .map(|entry| (entry.operation_id.as_str(), entry))
            .collect();
        if disposition.disposition == sync::FailedBatchDisposition::Requeue
            && (replacements.len() != keys.len()
                || keys.iter().any(|(_, key)| {
                    !replacements.contains_key(self.sync_outbox[key].operation_id.as_str())
                }))
        {
            return Err("requeue disposition must cover every operation in the batch".to_string());
        }
        let mut operations = Vec::with_capacity(keys.len());
        for (_, key) in keys {
            let operation = self.sync_outbox.get_mut(&key).expect("outbox key exists");
            match disposition.disposition {
                sync::FailedBatchDisposition::Requeue => {
                    let replacement = replacements[operation.operation_id.as_str()];
                    if let Some(revision) = replacement.base_revision {
                        operation.base_revision = Some(revision);
                    }
                    if let Some(token) = &replacement.concurrency_token {
                        operation.concurrency_token = Some(token.clone());
                    }
                    operation.state = OutboundState::Pending;
                    operation.retry_eligible = true;
                    operation.acked_at = None;
                    operation.last_error = None;
                }
                sync::FailedBatchDisposition::Discard | sync::FailedBatchDisposition::Acked => {
                    operation.state = OutboundState::Acked;
                    operation.retry_eligible = false;
                    operation.acked_at = Some(disposition.disposed_at);
                    operation.last_error = (disposition.disposition
                        == sync::FailedBatchDisposition::Discard)
                        .then(|| "discarded after conflict resolution".to_string());
                }
            }
            operation.retry_at = None;
            operation.lease_until = None;
            operation.lease_token = None;
            operation.updated_at = disposition.disposed_at;
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
        type BatchRows = Vec<((String, String), OutboundOperationDto)>;
        let mut batches: HashMap<String, BatchRows> = HashMap::new();
        for (key, operation) in &self.sync_outbox {
            if operation.profile_id == profile_id {
                batches
                    .entry(operation.batch_id.clone())
                    .or_default()
                    .push((key.clone(), operation.clone()));
            }
        }
        let mut candidates: Vec<_> = batches
            .into_iter()
            .filter(|(_, operations)| {
                operations.iter().all(|(_, operation)| {
                    operation.state == OutboundState::Acked
                        && operation
                            .acked_at
                            .is_some_and(|acked_at| acked_at < acked_before)
                }) && !self.sync_conflicts.values().any(|conflict| {
                    conflict.profile_id == profile_id
                        && conflict.batch_id.as_deref() == Some(&operations[0].1.batch_id)
                        && conflict.batch_incarnation.as_deref()
                            == Some(&operations[0].1.batch_incarnation)
                        && conflict.resolved_at.is_none()
                })
            })
            .map(|(batch_id, operations)| {
                let sequence = operations
                    .iter()
                    .map(|(_, operation)| operation.sequence)
                    .min()
                    .unwrap_or(u64::MAX);
                (sequence, batch_id, operations)
            })
            .collect();
        candidates.sort_by_key(|(sequence, _, _)| *sequence);
        let mut pruned = 0;
        for (_, _, operations) in candidates {
            if pruned + operations.len() > limit {
                break;
            }
            for (key, _) in operations {
                self.sync_outbox.remove(&key);
                pruned += 1;
            }
        }
        Ok(pruned)
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
        failed_disposition: Option<DisposeFailedBatchDto>,
    ) -> Result<SyncConflictDto, String> {
        sync::validate_profile(profile_id)?;
        sync::validate_identifier("conflictId", conflict_id)?;
        sync::validate_timestamp("resolvedAt", resolved_at)?;
        let existing = self
            .sync_conflicts
            .get(&(profile_id.to_string(), conflict_id.to_string()))
            .ok_or_else(|| "sync conflict not found".to_string())?;
        if existing.resolved_at.is_some() {
            return Err("sync conflict is already resolved".to_string());
        }
        if resolved_at < existing.created_at {
            return Err("resolvedAt must not precede createdAt".to_string());
        }
        if let Some(disposition) = &failed_disposition {
            if disposition.profile_id != profile_id
                || existing.batch_id.as_deref() != Some(&disposition.batch_id)
                || existing.batch_incarnation.as_deref() != Some(&disposition.batch_incarnation)
                || existing.attempt_token.as_deref() != Some(&disposition.expected_attempt_token)
            {
                return Err("conflict disposition does not match the associated batch".to_string());
            }
            if self.sync_conflicts.values().any(|conflict| {
                conflict.profile_id == profile_id
                    && conflict.conflict_id != conflict_id
                    && conflict.batch_incarnation == existing.batch_incarnation
                    && conflict.resolved_at.is_none()
            }) {
                return Err(
                    "all sibling conflicts must be resolved before batch disposition".to_string(),
                );
            }
        }
        self.begin_batch()?;
        let conflict = self
            .sync_conflicts
            .get_mut(&(profile_id.to_string(), conflict_id.to_string()))
            .expect("conflict was preflighted");
        conflict.resolved_at = Some(resolved_at);
        conflict.resolution = Some(resolution);
        if let Some(disposition) = failed_disposition {
            if let Err(error) = self.dispose_failed_batch(disposition) {
                self.rollback_batch();
                return Err(error);
            }
        }
        let result =
            self.sync_conflicts[&(profile_id.to_string(), conflict_id.to_string())].clone();
        self.commit_batch()?;
        Ok(result)
    }
}

fn materialize_memory_pull(
    store: &mut InMemoryCatalog,
    batch: &ApplyPullBatchDto,
    previous: &[Option<EntityRevisionDto>],
) -> Result<(), String> {
    for entity in &batch.entities {
        let key = (
            batch.profile_id.clone(),
            entity.entity_type,
            entity.remote_id.clone(),
        );
        let mapping = store
            .sync_entities
            .get(&key)
            .cloned()
            .ok_or_else(|| "materialized sync entity is missing".to_string())?;
        match entity.entity_type {
            SyncEntityType::ModelCollection => {
                let Some(local_id) = mapping.local_id.as_deref() else {
                    continue;
                };
                if mapping.tombstone {
                    let provenance = (
                        batch.profile_id.clone(),
                        mapping.entity_type,
                        local_id.to_string(),
                    );
                    if store.sync_materialized.get(&provenance) == Some(&mapping.remote_id) {
                        store.collections.remove(local_id);
                        store.collection_members.remove(local_id);
                        store.sync_materialized.remove(&provenance);
                    }
                } else {
                    let provenance = (
                        batch.profile_id.clone(),
                        mapping.entity_type,
                        local_id.to_string(),
                    );
                    if store.collections.contains_key(local_id)
                        && !store.sync_materialized.contains_key(&provenance)
                    {
                        continue;
                    }
                    let snapshot: CollectionSnapshotDto = serde_json::from_value(
                        mapping
                            .snapshot
                            .clone()
                            .ok_or_else(|| "collection snapshot is missing".to_string())?,
                    )
                    .map_err(|error| format!("invalid collection snapshot: {error}"))?;
                    store
                        .collections
                        .insert(local_id.to_string(), (snapshot.name, snapshot.is_shared));
                    store
                        .sync_materialized
                        .insert(provenance, mapping.remote_id);
                }
            }
            SyncEntityType::Tag => {
                let Some(local_id) = mapping.local_id.as_deref() else {
                    continue;
                };
                if mapping.tombstone {
                    let provenance = (
                        batch.profile_id.clone(),
                        mapping.entity_type,
                        local_id.to_string(),
                    );
                    if store.sync_materialized.get(&provenance) == Some(&mapping.remote_id) {
                        store.tags.remove(local_id);
                        for tags in store.model_tags.values_mut() {
                            tags.remove(local_id);
                        }
                        store.sync_materialized.remove(&provenance);
                    }
                } else {
                    let provenance = (
                        batch.profile_id.clone(),
                        mapping.entity_type,
                        local_id.to_string(),
                    );
                    if store.tags.contains_key(local_id)
                        && !store.sync_materialized.contains_key(&provenance)
                    {
                        continue;
                    }
                    let snapshot: TagSnapshotDto = serde_json::from_value(
                        mapping
                            .snapshot
                            .clone()
                            .ok_or_else(|| "tag snapshot is missing".to_string())?,
                    )
                    .map_err(|error| format!("invalid tag snapshot: {error}"))?;
                    store.tags.insert(local_id.to_string(), snapshot.name);
                    store
                        .sync_materialized
                        .insert(provenance, mapping.remote_id);
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
        remove_memory_membership(store, &batch.profile_id, old)?;
    }
    let changed_memberships: Vec<_> = batch
        .entities
        .iter()
        .filter(|entity| {
            entity.entity_type == SyncEntityType::ModelCollectionMembership && !entity.tombstone
        })
        .filter_map(|entity| {
            store
                .sync_entities
                .get(&(
                    batch.profile_id.clone(),
                    entity.entity_type,
                    entity.remote_id.clone(),
                ))
                .cloned()
        })
        .collect();
    for membership in changed_memberships {
        materialize_memory_membership(store, &batch.profile_id, membership)?;
    }
    Ok(())
}

fn remove_memory_membership(
    store: &mut InMemoryCatalog,
    profile_id: &str,
    mapping: &EntityRevisionDto,
) -> Result<(), String> {
    let Some(snapshot) = mapping.snapshot.clone() else {
        return Ok(());
    };
    let snapshot: MembershipSnapshotDto = serde_json::from_value(snapshot)
        .map_err(|error| format!("invalid membership snapshot: {error}"))?;
    let collection_id = store
        .sync_entities
        .get(&(
            profile_id.to_string(),
            SyncEntityType::ModelCollection,
            snapshot.collection_id,
        ))
        .and_then(|collection| collection.local_id.as_deref())
        .map(str::to_string);
    let model_hash = store
        .remote_model_links
        .values()
        .find(|link| link.profile_id == profile_id && link.remote_model_id == snapshot.model_id)
        .map(|link| link.local_model_hash.clone());
    if let (Some(collection_id), Some(model_hash)) = (collection_id, model_hash) {
        if let Some(members) = store.collection_members.get_mut(&collection_id) {
            members.remove(&model_hash);
        }
    }
    Ok(())
}

fn materialize_memory_memberships(
    store: &mut InMemoryCatalog,
    profile_id: &str,
) -> Result<(), String> {
    let memberships: Vec<_> = store
        .sync_entities
        .values()
        .filter(|mapping| {
            mapping.profile_id == profile_id
                && mapping.entity_type == SyncEntityType::ModelCollectionMembership
                && !mapping.tombstone
        })
        .cloned()
        .collect();
    for mapping in memberships {
        materialize_memory_membership(store, profile_id, mapping)?;
    }
    Ok(())
}

fn materialize_memory_membership(
    store: &mut InMemoryCatalog,
    profile_id: &str,
    mapping: EntityRevisionDto,
) -> Result<(), String> {
    let snapshot: MembershipSnapshotDto = serde_json::from_value(
        mapping
            .snapshot
            .ok_or_else(|| "membership snapshot is missing".to_string())?,
    )
    .map_err(|error| format!("invalid membership snapshot: {error}"))?;
    let collection_id = store
        .sync_entities
        .get(&(
            profile_id.to_string(),
            SyncEntityType::ModelCollection,
            snapshot.collection_id,
        ))
        .filter(|collection| !collection.tombstone)
        .and_then(|collection| collection.local_id.clone());
    let model_hash = store
        .remote_model_links
        .values()
        .find(|link| link.profile_id == profile_id && link.remote_model_id == snapshot.model_id)
        .map(|link| link.local_model_hash.clone());
    if let (Some(collection_id), Some(model_hash)) = (collection_id, model_hash) {
        if store.models.contains_key(&model_hash) {
            store
                .collection_members
                .entry(collection_id)
                .or_default()
                .insert(model_hash);
        }
    }
    Ok(())
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
    insert_memory_conflict_associated(store, profile_id, input, None, None, None, None)
}

fn insert_memory_conflict_associated(
    store: &mut InMemoryCatalog,
    profile_id: &str,
    input: &ConflictInputDto,
    batch_id: Option<&str>,
    operation_id: Option<&str>,
    batch_incarnation: Option<&str>,
    attempt_token: Option<&str>,
) -> Result<SyncConflictDto, String> {
    let key = (profile_id.to_string(), input.conflict_id.clone());
    if let Some(existing) = store.sync_conflicts.get(&key) {
        let matches = existing.entity_type == input.entity_type
            && existing.entity_id == input.entity_id
            && existing.batch_id.as_deref() == batch_id
            && existing.operation_id.as_deref() == operation_id
            && existing.batch_incarnation.as_deref() == batch_incarnation
            && existing.attempt_token.as_deref() == attempt_token
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
    fn reset_catalog_clears_indexed_content_but_preserves_organization_definitions() {
        let dir = tempfile::tempdir().unwrap();
        let model_path = dir.path().join("m.stl");
        write(&model_path, b"bytes");
        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(dir.path()));
        let hash = store.models()[0].hash.clone();
        store.add_favorite(&hash);
        store.add_model_tag(&hash, "Keep tag").unwrap();
        let collection = store.create_collection("Keep collection").unwrap();
        store.add_model_to_collection(&collection.id, &hash);

        let summary = store.reset_catalog();

        assert_eq!(
            summary,
            CatalogResetSummary {
                models_removed: 1,
                source_roots_removed: 1,
            }
        );
        assert!(store.models().is_empty());
        assert!(store.favorite_hashes().is_empty());
        assert_eq!(store.all_tags()[0].name, "Keep tag");
        assert_eq!(store.all_collections()[0].name, "Keep collection");
        assert_eq!(store.all_collections()[0].member_count, 0);
        assert!(model_path.exists(), "reset must not delete source files");
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

    #[test]
    fn pull_materializes_profile_scoped_entities_and_reconciles_late_model_links() {
        let (mut store, hash) = one_model_store();
        store.add_model_tag(&hash, "Shared name").unwrap();
        let timestamp = "2026-07-23T12:00:00Z";
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "profile-a".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("cursor-1".to_string()),
                server_revision: 3,
                applied_at: 1,
                entities: vec![
                    crate::sync::PullEntityDto {
                        entity_type: SyncEntityType::ModelCollection,
                        local_id: Some("pf-sync-collection-a".to_string()),
                        remote_id: "remote-collection".to_string(),
                        revision: 1,
                        journal_revision: 1,
                        concurrency_token: Some("collection-token".to_string()),
                        tombstone: false,
                        visibility: SyncVisibility::Shared,
                        snapshot: Some(serde_json::json!({
                            "id": "remote-collection",
                            "name": "Shared name",
                            "description": null,
                            "ownerUserId": "owner",
                            "isShared": true,
                            "createdAt": timestamp,
                            "updatedAt": timestamp,
                            "memberCount": 1,
                            "modelIds": ["remote-model"],
                            "revision": 1,
                            "concurrencyToken": "collection-token"
                        })),
                    },
                    crate::sync::PullEntityDto {
                        entity_type: SyncEntityType::ModelCollectionMembership,
                        local_id: Some("pf-sync-membership-a".to_string()),
                        remote_id: "remote-membership".to_string(),
                        revision: 2,
                        journal_revision: 2,
                        concurrency_token: None,
                        tombstone: false,
                        visibility: SyncVisibility::Shared,
                        snapshot: Some(serde_json::json!({
                            "id": "remote-membership",
                            "collectionId": "remote-collection",
                            "modelId": "remote-model",
                            "createdAt": timestamp,
                            "updatedAt": timestamp,
                            "revision": 2
                        })),
                    },
                    crate::sync::PullEntityDto {
                        entity_type: SyncEntityType::Tag,
                        local_id: Some("pf-sync-tag-a".to_string()),
                        remote_id: "remote-tag".to_string(),
                        revision: 3,
                        journal_revision: 3,
                        concurrency_token: Some("tag-token".to_string()),
                        tombstone: false,
                        visibility: SyncVisibility::Shared,
                        snapshot: Some(serde_json::json!({
                            "id": "remote-tag",
                            "name": "Shared name",
                            "category": null,
                            "isAutoGenerated": false,
                            "color": null,
                            "description": null,
                            "revision": 3,
                            "concurrencyToken": "tag-token"
                        })),
                    },
                ],
                conflicts: vec![],
            })
            .unwrap();

        assert_eq!(store.all_collections()[0].id, "pf-sync-collection-a");
        assert_eq!(store.all_collections()[0].member_count, 0);
        assert_eq!(store.all_tags().len(), 2);
        assert!(store
            .collections_for_model(&hash)
            .iter()
            .all(|collection| collection.id != "pf-sync-collection-a"));

        store
            .link_remote_model(RemoteModelLinkDto {
                profile_id: "profile-a".to_string(),
                server_binding: "legacy-unbound".to_string(),
                local_model_hash: hash.clone(),
                remote_model_id: "remote-model".to_string(),
                client_upload_id: "upload-a".to_string(),
                etag: None,
                upload_status: crate::sync::RemoteUploadStatus::Pending,
                created_at: 2,
                updated_at: 2,
                uploaded_at: None,
            })
            .unwrap();

        assert_eq!(
            store.collections_for_model(&hash)[0].id,
            "pf-sync-collection-a"
        );
        assert_eq!(store.all_collections()[0].member_count, 1);
    }

    #[test]
    fn ambiguous_batch_failure_atomically_quarantines_every_operation() {
        let mut store = InMemoryCatalog::new();
        let operation = |id: &str| EnqueueOutboundOperationDto {
            operation_id: id.to_string(),
            entity_type: SyncEntityType::ModelCollection,
            operation: crate::sync::SyncOperationKind::Create,
            entity_id: format!("local-{id}"),
            payload: serde_json::json!({"name": id}),
            base_revision: None,
            concurrency_token: None,
            created_at: 1,
        };
        store
            .enqueue_outbound_operations(
                "profile-a",
                "batch-a",
                vec![operation("one"), operation("two")],
            )
            .unwrap();
        let claimed = store
            .claim_outbound_operations("profile-a", 500, 2, 60)
            .unwrap()
            .unwrap();

        let failed = store
            .fail_outbound_batch(FailOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: claimed.batch_id,
                batch_incarnation: claimed.batch_incarnation,
                lease_token: claimed.lease_token,
                outcome: OutboundFailureOutcome::Ambiguous,
                error: "unknown result".to_string(),
                failed_at: 3,
                retry_at: None,
            })
            .unwrap();

        assert_eq!(failed.len(), 2);
        assert!(failed.iter().all(|operation| {
            operation.state == OutboundState::Uncertain
                && !operation.retry_eligible
                && operation.lease_token.is_none()
        }));
    }

    #[test]
    fn connected_collection_mutations_atomically_produce_ordered_outbox_work() {
        let (mut store, hash) = one_model_store();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();

        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        let create = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(create.len(), 1);
        assert_eq!(create[0].operation, crate::sync::SyncOperationKind::Create);
        let remote_id = create[0].payload["remoteId"].as_str().unwrap();
        assert_eq!(remote_id.len(), 36);

        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 3,)
            .unwrap());
        let queued = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(queued.len(), 2);
        assert!(queued[0].sequence < queued[1].sequence);
        assert_eq!(
            queued[1].entity_type,
            SyncEntityType::ModelCollectionMembership
        );

        assert!(store
            .create_collection_with_sync("Rejected", "profile-a", "old-binding", 4)
            .is_err());
        assert!(store
            .all_collections()
            .iter()
            .all(|value| value.name != "Rejected"));
    }

    #[test]
    fn toggling_membership_rapidly_coalesces_to_zero_pending_operations() {
        let (mut store, hash) = one_model_store();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        let create = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(create.len(), 1);

        // Add then immediately remove, before either the collection create
        // or the membership create ever left the outbox: the compensating
        // Delete must cancel the still-pending Create instead of appending a
        // redundant Delete the server was never told about.
        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 3)
            .unwrap());
        store
            .remove_model_from_collection_with_sync(
                &collection.id,
                &hash,
                "profile-a",
                "binding-a",
                4,
            )
            .unwrap();
        let after_add_remove = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(
            after_add_remove.len(),
            1,
            "only the unrelated collection create should remain queued"
        );
        assert!(store
            .collections_for_model(&hash)
            .iter()
            .all(|value| value.id != collection.id));

        // Add it back: this is a fresh Create toggle (the prior add/remove
        // already coalesced away, so there is nothing pending to cancel) and
        // must queue exactly one new membership Create.
        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 5)
            .unwrap());
        let after_second_add = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(after_second_add.len(), 2);
        assert!(after_second_add.iter().any(|op| {
            op.entity_type == SyncEntityType::ModelCollectionMembership
                && op.operation == crate::sync::SyncOperationKind::Create
        }));
    }

    #[test]
    fn remove_then_add_coalesces_a_pending_membership_delete_to_zero_operations() {
        let (mut store, hash) = one_model_store();
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
            .link_remote_model(RemoteModelLinkDto {
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
            "re-adding before the delete is claimed should cancel the pending delete instead of queuing a compensating create"
        );
        assert!(store
            .collections_for_model(&hash)
            .iter()
            .any(|value| value.id == collection.id));
    }

    #[test]
    fn remove_then_add_falls_back_once_the_pending_delete_is_claimed() {
        let (mut store, hash) = one_model_store();
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
            .link_remote_model(RemoteModelLinkDto {
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
    fn toggle_coalescing_falls_back_once_the_opposing_operation_is_claimed() {
        let (mut store, hash) = one_model_store();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        let collection = store
            .create_collection_with_sync("Synced", "profile-a", "binding-a", 2)
            .unwrap();
        // `create_collection_with_sync` and `add_model_to_collection_with_sync`
        // each enqueue their own logical batch, and `claim_outbound_operations`
        // only ever claims the single oldest still-open batch. Settle the
        // collection-create batch first so the membership-create batch
        // becomes claimable on its own.
        let create_claim = store
            .claim_outbound_operations("profile-a", 10, 2, 30)
            .unwrap()
            .unwrap();
        // Settlement must confirm the same client-generated remote id that
        // was optimistically provisioned at create time -- the server
        // accepts the client-supplied guid rather than minting a new one --
        // otherwise the same local id would end up mapped to two different
        // remote ids, which `preflight_entity_revision_set` correctly
        // rejects as a sibling-mapping conflict.
        let remote_id = create_claim.operations[0].payload["remoteId"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "profile-a".to_string(),
                batch_id: create_claim.batch_id,
                batch_incarnation: create_claim.batch_incarnation,
                lease_token: create_claim.lease_token,
                settled_at: 3,
                server_revision: 1,
                applied: vec![crate::sync::AppliedOutboundResultDto {
                    operation_id: create_claim.operations[0].operation_id.clone(),
                    remote_id,
                    revision: 1,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        assert!(store
            .add_model_to_collection_with_sync(&collection.id, &hash, "profile-a", "binding-a", 4)
            .unwrap());

        // Claim the membership-create batch as if a scheduler tick already
        // picked it up for delivery.
        store
            .claim_outbound_operations("profile-a", 10, 5, 30)
            .unwrap();

        // Removing now finds the compensating Create already `InFlight`
        // (no longer `Pending`), so cancellation is a safe no-op and the
        // original behaviour -- queuing a Delete -- must still apply.
        store
            .remove_model_from_collection_with_sync(
                &collection.id,
                &hash,
                "profile-a",
                "binding-a",
                6,
            )
            .unwrap();
        let pending = store
            .outbound_operations("profile-a", &[OutboundState::Pending], 500)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].entity_type,
            SyncEntityType::ModelCollectionMembership
        );
        assert_eq!(pending[0].operation, crate::sync::SyncOperationKind::Delete);
    }

    #[test]
    fn settle_outbound_batch_uses_the_current_profile_binding_for_membership_snapshots() {
        // InMemoryCatalog stores links in a randomized HashMap; exercise fresh
        // stores so an unfiltered lookup cannot accidentally keep choosing the
        // current binding's row by chance.
        for _ in 0..32 {
            let (mut store, hash) = one_model_store();
            store
                .bind_sync_profile("profile-a", "binding-current", 1)
                .unwrap();
            let collection = store
                .create_collection_with_sync("Synced", "profile-a", "binding-current", 2)
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
                .link_remote_model(RemoteModelLinkDto {
                    profile_id: "profile-a".to_string(),
                    server_binding: "binding-stale".to_string(),
                    local_model_hash: hash.clone(),
                    remote_model_id: "remote-model-stale".to_string(),
                    client_upload_id: "upload-stale".to_string(),
                    etag: None,
                    upload_status: crate::sync::RemoteUploadStatus::Pending,
                    created_at: 5,
                    updated_at: 5,
                    uploaded_at: None,
                })
                .unwrap();
            store
                .link_remote_model(RemoteModelLinkDto {
                    profile_id: "profile-a".to_string(),
                    server_binding: "binding-current".to_string(),
                    local_model_hash: hash.clone(),
                    remote_model_id: "remote-model-current".to_string(),
                    client_upload_id: "upload-current".to_string(),
                    etag: None,
                    upload_status: crate::sync::RemoteUploadStatus::Pending,
                    created_at: 6,
                    updated_at: 6,
                    uploaded_at: None,
                })
                .unwrap();
            assert!(store
                .add_model_to_collection_with_sync(
                    &collection.id,
                    &hash,
                    "profile-a",
                    "binding-current",
                    7,
                )
                .unwrap());
            let membership_claim = store
                .claim_outbound_operations("profile-a", 10, 8, 30)
                .unwrap()
                .unwrap();
            let membership_remote_id = membership_claim.operations[0].payload["remoteId"]
                .as_str()
                .unwrap()
                .to_string();
            let membership_local_id = membership_claim.operations[0].entity_id.clone();
            store
                .settle_outbound_batch(SettleOutboundBatchDto {
                    profile_id: "profile-a".to_string(),
                    batch_id: membership_claim.batch_id,
                    batch_incarnation: membership_claim.batch_incarnation,
                    lease_token: membership_claim.lease_token,
                    settled_at: 9,
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

            let snapshot = store
                .entity_revision_by_local(
                    "profile-a",
                    SyncEntityType::ModelCollectionMembership,
                    &membership_local_id,
                )
                .unwrap()
                .unwrap()
                .snapshot
                .unwrap();
            assert_eq!(snapshot["modelId"].as_str(), Some("remote-model-current"));
        }
    }

    #[test]
    fn replace_sync_profile_binding_replay_is_idempotent_in_memory() {
        let mut store = InMemoryCatalog::new();
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
        // to two different remote ids.
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
        assert!(store.all_collections().is_empty());

        let survivor = store
            .create_collection_with_sync("Survivor", "profile-a", "new-binding", 6)
            .unwrap();

        // Replaying the same transition after it already committed (e.g. a
        // scheduler tick retry racing an unacknowledged prior attempt) must
        // succeed as a no-op instead of failing CAS or re-wiping data that
        // already belongs to the new binding.
        store
            .replace_sync_profile_binding("profile-a", "old-binding", "new-binding", 5)
            .unwrap();
        assert!(store
            .all_collections()
            .iter()
            .any(|collection| collection.id == survivor.id));
    }

    #[test]
    fn profile_rebinding_purges_only_explicit_remote_materialization() {
        let mut store = InMemoryCatalog::new();
        store
            .bind_sync_profile("profile-a", "binding-a", 1)
            .unwrap();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "profile-a".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("cursor-a".to_string()),
                server_revision: 1,
                applied_at: 2,
                entities: vec![crate::sync::PullEntityDto {
                    entity_type: SyncEntityType::ModelCollection,
                    local_id: Some("remote-local".to_string()),
                    remote_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                    revision: 1,
                    journal_revision: 1,
                    concurrency_token: Some("token".to_string()),
                    tombstone: false,
                    visibility: SyncVisibility::Shared,
                    snapshot: Some(serde_json::json!({
                        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "name": "Remote",
                        "description": null,
                        "ownerUserId": "owner",
                        "isShared": true,
                        "createdAt": "2026-07-23T12:00:00Z",
                        "updatedAt": "2026-07-23T12:00:00Z",
                        "memberCount": 0,
                        "modelIds": [],
                        "revision": 1,
                        "concurrencyToken": "token"
                    })),
                }],
                conflicts: vec![],
            })
            .unwrap();
        let local = store.create_collection("Local").unwrap();

        let reset = store
            .replace_sync_profile_binding("profile-a", "binding-a", "binding-b", 3)
            .unwrap();
        assert!(store
            .bind_sync_profile("profile-a", "binding-a", 4)
            .is_err());
        assert_eq!(reset.cursor, None);
        assert!(store
            .all_collections()
            .iter()
            .all(|collection| collection.id != "remote-local"));
        assert!(store
            .all_collections()
            .iter()
            .any(|collection| collection.id == local.id));
    }

    #[test]
    fn favorites_track_known_models_only() {
        let (mut store, hash) = one_model_store();

        assert!(store.add_favorite(&hash));
        assert_eq!(store.favorite_hashes(), vec![hash.clone()]);
        assert!(!store.add_favorite("nope"));

        store.remove_favorite(&hash);
        assert!(store.favorite_hashes().is_empty());
    }
}
