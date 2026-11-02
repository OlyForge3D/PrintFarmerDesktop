//! Explicit, snapshot-checked collection membership changes without hydrating the library.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::{finish_catalog_batch, CatalogStore, Collection};
use crate::catalog_query::ModelQuery;
use crate::organization::{self, DeleteScope, OrganizationEntry, OrganizationKind};

const MAX_MEMBERSHIP_CHANGES: usize = 100_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOperation {
    Add,
    Remove,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ChangeTarget {
    Selected { hashes: Vec<String> },
    Query { query: ModelQuery },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncContext {
    pub profile_id: String,
    pub profile_binding: String,
    pub now: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionChangeRequest {
    pub operation: ChangeOperation,
    pub target: ChangeTarget,
    pub collection_ids: Vec<String>,
    #[serde(default)]
    pub sync_context: Option<SyncContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyCollectionChangeRequest {
    pub change: CollectionChangeRequest,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameCollectionRequest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub sync_context: Option<SyncContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPreview {
    pub collection_id: String,
    pub name: String,
    pub change_count: usize,
    pub unchanged_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionChangePreview {
    pub operation: ChangeOperation,
    pub fingerprint: String,
    pub model_count: usize,
    pub change_count: usize,
    pub unchanged_count: usize,
    pub targets: Vec<TargetPreview>,
}

#[derive(Debug)]
pub struct CollectionChangeResult {
    pub operation: ChangeOperation,
    pub model_count: usize,
    pub changed_memberships: usize,
    pub unchanged_memberships: usize,
    pub collections: Vec<Collection>,
}

struct Selection {
    hashes: Vec<String>,
    collection_ids: Vec<String>,
    synced_collection_ids: BTreeSet<String>,
    preview: CollectionChangePreview,
}

fn feed(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn editable_collection(entries: &[OrganizationEntry], id: &str) -> Result<DeleteScope, String> {
    let entry = entries
        .iter()
        .find(|entry| entry.kind == OrganizationKind::Collection && entry.id == id)
        .ok_or("the collection no longer exists")?;
    if entry.delete_scope == DeleteScope::ReadOnly {
        return Err(
            "a selected collection is shared or belongs to another server profile; no changes were applied"
                .into(),
        );
    }
    Ok(entry.delete_scope)
}

fn selection<S: CatalogStore + ?Sized>(
    store: &S,
    request: &CollectionChangeRequest,
) -> Result<Selection, String> {
    if request.collection_ids.is_empty()
        || request.collection_ids.len() > 64
        || request
            .collection_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 4096)
    {
        return Err("choose between 1 and 64 destination collections".into());
    }
    let collection_ids: Vec<_> = request
        .collection_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if collection_ids.len() != request.collection_ids.len() {
        return Err("duplicate destination collections".into());
    }
    let entries = organization::list(store, request.sync_context.as_ref())?;
    let hashes = match &request.target {
        ChangeTarget::Selected { hashes } => {
            if hashes.is_empty()
                || hashes.len() > 500
                || hashes
                    .iter()
                    .any(|hash| hash.is_empty() || hash.len() > 256)
            {
                return Err("choose between 1 and 500 selected models".into());
            }
            let sorted: Vec<_> = hashes
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            if sorted.len() != hashes.len() {
                return Err("duplicate selected models".into());
            }
            for hash in &sorted {
                if !store.model_exists(hash)? {
                    return Err("a selected model is no longer in the catalog; refresh and review the selection".into());
                }
            }
            sorted
        }
        ChangeTarget::Query { query } => {
            store.matching_model_hashes(query, MAX_MEMBERSHIP_CHANGES + 1)?
        }
    };
    if hashes.is_empty() {
        return Err("no models match this selection".into());
    }
    if hashes.len() > MAX_MEMBERSHIP_CHANGES / collection_ids.len() {
        return Err("this change exceeds 100,000 model/collection pairs; narrow the filters or choose fewer collections".into());
    }
    let collections = store.all_collections();
    let mut hasher = Sha256::new();
    feed(&mut hasher, "collection-change-v1");
    feed(
        &mut hasher,
        if request.operation == ChangeOperation::Add {
            "add"
        } else {
            "remove"
        },
    );
    match &request.sync_context {
        Some(context) => {
            hasher.update([1]);
            feed(&mut hasher, &context.profile_id);
            feed(&mut hasher, &context.profile_binding);
        }
        None => hasher.update([0]),
    }
    let mut targets = Vec::with_capacity(collection_ids.len());
    let mut synced_collection_ids = BTreeSet::new();
    for id in &collection_ids {
        let collection = collections
            .iter()
            .find(|collection| &collection.id == id)
            .ok_or("a destination collection no longer exists; reload and review the change")?;
        let scope = editable_collection(&entries, id)?;
        if scope == DeleteScope::Sync {
            synced_collection_ids.insert(id.clone());
        }
        feed(&mut hasher, id);
        feed(&mut hasher, &collection.name);
        hasher.update([u8::from(collection.shared_to_farm)]);
        hasher.update([u8::from(scope == DeleteScope::Sync)]);
        targets.push(TargetPreview {
            collection_id: id.clone(),
            name: collection.name.clone(),
            change_count: 0,
            unchanged_count: 0,
        });
    }
    for hash in &hashes {
        feed(&mut hasher, hash);
        for target in &mut targets {
            let present = store.collection_contains_model(&target.collection_id, hash)?;
            hasher.update([u8::from(present)]);
            let changes = present == (request.operation == ChangeOperation::Remove);
            target.change_count += usize::from(changes);
            target.unchanged_count += usize::from(!changes);
        }
    }
    let preview = CollectionChangePreview {
        operation: request.operation,
        fingerprint: format!("{:x}", hasher.finalize()),
        model_count: hashes.len(),
        change_count: targets.iter().map(|target| target.change_count).sum(),
        unchanged_count: targets.iter().map(|target| target.unchanged_count).sum(),
        targets,
    };
    Ok(Selection {
        hashes,
        collection_ids,
        synced_collection_ids,
        preview,
    })
}

pub fn preview<S: CatalogStore + ?Sized>(
    store: &mut S,
    request: &CollectionChangeRequest,
) -> Result<CollectionChangePreview, String> {
    store.begin_batch()?;
    let result = selection(store, request).map(|selection| selection.preview);
    finish_catalog_batch(store, result)
}

pub fn apply<S: CatalogStore + ?Sized>(
    store: &mut S,
    request: &ApplyCollectionChangeRequest,
) -> Result<CollectionChangeResult, String> {
    if request.fingerprint.len() != 64
        || !request
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("invalid collection change fingerprint".into());
    }
    store.begin_batch()?;
    let result = (|| {
        let selected = selection(store, &request.change)?;
        if selected.preview.fingerprint != request.fingerprint {
            return Err("the matching models, destination collections, or memberships changed; review a fresh preview before applying".into());
        }
        for id in &selected.collection_ids {
            let context = request
                .change
                .sync_context
                .as_ref()
                .filter(|_| selected.synced_collection_ids.contains(id));
            for hash in &selected.hashes {
                let present = store.collection_contains_model(id, hash)?;
                if context.is_none()
                    && present != (request.change.operation == ChangeOperation::Remove)
                {
                    continue;
                }
                match (request.change.operation, context) {
                    (ChangeOperation::Add, Some(context)) => {
                        if !store.add_model_to_collection_with_sync_in_batch(
                            id,
                            hash,
                            &context.profile_id,
                            &context.profile_binding,
                            context.now,
                        )? {
                            return Err("could not add a selected model to its collection; no changes were applied".into());
                        }
                    }
                    (ChangeOperation::Remove, Some(context)) => {
                        store.remove_model_from_collection_with_sync_in_batch(
                            id,
                            hash,
                            &context.profile_id,
                            &context.profile_binding,
                            context.now,
                        )?;
                    }
                    (ChangeOperation::Add, None) => {
                        if !store.add_model_to_collection_checked(id, hash)? {
                            return Err("could not add a selected model to its collection; no changes were applied".into());
                        }
                    }
                    (ChangeOperation::Remove, None) => {
                        store.remove_model_from_collection_checked(id, hash)?
                    }
                }
                if store.collection_contains_model(id, hash)?
                    != (request.change.operation == ChangeOperation::Add)
                {
                    return Err(
                        "the collection membership could not be changed; no changes were applied"
                            .into(),
                    );
                }
            }
        }
        Ok(CollectionChangeResult {
            operation: request.change.operation,
            model_count: selected.hashes.len(),
            changed_memberships: selected.preview.change_count,
            unchanged_memberships: selected.preview.unchanged_count,
            collections: store.all_collections(),
        })
    })();
    finish_catalog_batch(store, result)
}

pub fn rename<S: CatalogStore + ?Sized>(
    store: &mut S,
    request: &RenameCollectionRequest,
) -> Result<Collection, String> {
    let name = request.name.trim();
    if request.id.is_empty()
        || request.id.len() > 4096
        || name.is_empty()
        || name.encode_utf16().count() > 128
    {
        return Err("a collection name must contain 1 to 128 characters".into());
    }
    store.begin_batch()?;
    let result = (|| {
        let entries = organization::list(store, request.sync_context.as_ref())?;
        let current = store
            .all_collections()
            .into_iter()
            .find(|collection| collection.id == request.id)
            .ok_or("the collection no longer exists")?;
        let scope = editable_collection(&entries, &request.id)?;
        if current.name == name {
            return Ok(current);
        }
        match request
            .sync_context
            .as_ref()
            .filter(|_| scope == DeleteScope::Sync)
        {
            Some(context) => store.update_collection_with_sync_in_batch(
                &request.id,
                name,
                current.shared_to_farm,
                &context.profile_id,
                &context.profile_binding,
                context.now,
            ),
            None => store
                .update_collection(&request.id, name, current.shared_to_farm)
                .ok_or_else(|| "could not rename the collection".into()),
        }
    })();
    finish_catalog_batch(store, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{InMemoryCatalog, LocationUpsert};
    use crate::model::{FileFingerprint, ModelFormat};
    use crate::sync::{EntityRevisionDto, SyncEntityType, SyncOperationKind, SyncVisibility};
    use std::path::PathBuf;

    fn seed(store: &mut dyn CatalogStore, count: usize) -> (String, String) {
        store.begin_batch().unwrap();
        let a = store.create_collection("Dragons").unwrap();
        let b = store.create_collection("Terrain").unwrap();
        for i in 0..count {
            let hash = format!("h{i:03}");
            store.upsert_location(LocationUpsert {
                hash: hash.clone(),
                format: ModelFormat::Stl,
                size: 1,
                root_id: "r".into(),
                path: PathBuf::from(format!("/m/model{i}.stl")),
                root_relative: PathBuf::from(format!("model{i}.stl")),
                fingerprint: FileFingerprint {
                    size: 1,
                    modified_unix_secs: Some(1),
                },
            });
            if i % 2 == 0 {
                store.add_model_tag(&hash, "Even");
            }
        }
        store.add_model_to_collection(&a.id, "h000");
        store.add_model_to_collection(&b.id, "h000");
        store.commit_batch().unwrap();
        (a.id, b.id)
    }

    fn change(
        operation: ChangeOperation,
        target: ChangeTarget,
        ids: &[&str],
    ) -> CollectionChangeRequest {
        CollectionChangeRequest {
            operation,
            target,
            collection_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            sync_context: None,
        }
    }

    fn selected(hashes: &[&str]) -> ChangeTarget {
        ChangeTarget::Selected {
            hashes: hashes.iter().map(|hash| (*hash).to_string()).collect(),
        }
    }

    fn members(store: &dyn CatalogStore, id: &str) -> usize {
        store
            .all_collections()
            .into_iter()
            .find(|collection| collection.id == id)
            .unwrap()
            .member_count
    }

    fn preview_then_apply(
        store: &mut dyn CatalogStore,
        request: CollectionChangeRequest,
    ) -> (CollectionChangePreview, CollectionChangeResult) {
        let shown = preview(store, &request).unwrap();
        let fingerprint = shown.fingerprint.clone();
        let result = apply(
            store,
            &ApplyCollectionChangeRequest {
                change: request,
                fingerprint,
            },
        )
        .unwrap();
        (shown, result)
    }

    fn selected_add_is_additive_and_idempotent(store: &mut dyn CatalogStore) {
        let (a, b) = seed(store, 3);
        let (shown, result) = preview_then_apply(
            store,
            change(ChangeOperation::Add, selected(&["h000", "h001"]), &[&a]),
        );
        assert_eq!(shown.model_count, 2);
        assert_eq!(shown.change_count, 1);
        assert_eq!(shown.unchanged_count, 1);
        assert_eq!(result.changed_memberships, 1);
        assert_eq!(members(store, &a), 2);
        assert_eq!(members(store, &b), 1, "other collections are untouched");
        let again = preview(
            store,
            &change(ChangeOperation::Add, selected(&["h000", "h001"]), &[&a]),
        )
        .unwrap();
        assert_eq!(again.change_count, 0);
    }

    fn query_targets_every_matching_model_beyond_one_page(store: &mut dyn CatalogStore) {
        let (a, b) = seed(store, 120);
        let even = store
            .all_tags()
            .into_iter()
            .find(|tag| tag.name == "Even")
            .unwrap();
        let query = ModelQuery {
            tag_ids: vec![even.id.clone()],
            page_size: 24,
            page: 3,
            ..Default::default()
        };
        let (shown, _) = preview_then_apply(
            store,
            change(
                ChangeOperation::Add,
                ChangeTarget::Query {
                    query: query.clone(),
                },
                &[&b],
            ),
        );
        assert_eq!(shown.model_count, 60);
        assert_eq!(shown.change_count, 59);
        assert_eq!(members(store, &b), 60);
        assert!(!store.collection_contains_model(&b, "h001").unwrap());

        let (removed, result) = preview_then_apply(
            store,
            change(
                ChangeOperation::Remove,
                ChangeTarget::Query { query },
                &[&b],
            ),
        );
        assert_eq!(removed.change_count, 60);
        assert_eq!(result.changed_memberships, 60);
        assert_eq!(members(store, &b), 0);
        assert!(
            store.collection_contains_model(&a, "h000").unwrap(),
            "removal only affects the chosen collection"
        );
    }

    fn stale_fingerprint_rejects_without_writes(store: &mut dyn CatalogStore) {
        let (a, _) = seed(store, 3);
        let request = change(ChangeOperation::Add, selected(&["h001", "h002"]), &[&a]);
        let shown = preview(store, &request).unwrap();
        store.add_model_to_collection(&a, "h001");
        let error = apply(
            store,
            &ApplyCollectionChangeRequest {
                change: request,
                fingerprint: shown.fingerprint,
            },
        )
        .unwrap_err();
        assert!(error.contains("fresh preview"), "{error}");
        assert!(!store.collection_contains_model(&a, "h002").unwrap());
        assert!(apply(
            store,
            &ApplyCollectionChangeRequest {
                change: change(ChangeOperation::Add, selected(&["h002"]), &[&a]),
                fingerprint: "A".repeat(64),
            },
        )
        .is_err());
    }

    fn rename_keeps_identity_and_memberships(store: &mut dyn CatalogStore) {
        let (a, _) = seed(store, 2);
        let renamed = rename(
            store,
            &RenameCollectionRequest {
                id: a.clone(),
                name: "  Wyrms ".into(),
                sync_context: None,
            },
        )
        .unwrap();
        assert_eq!(renamed.id, a);
        assert_eq!(renamed.name, "Wyrms");
        assert_eq!(members(store, &a), 1);
        for name in ["   ".to_string(), "x".repeat(129)] {
            assert!(rename(
                store,
                &RenameCollectionRequest {
                    id: a.clone(),
                    name,
                    sync_context: None,
                },
            )
            .is_err());
        }
        assert!(rename(
            store,
            &RenameCollectionRequest {
                id: "missing".into(),
                name: "Name".into(),
                sync_context: None,
            },
        )
        .is_err());
    }

    fn invalid_requests_are_rejected(store: &mut dyn CatalogStore) {
        let (a, _) = seed(store, 2);
        assert!(preview(
            store,
            &change(ChangeOperation::Add, selected(&["h000"]), &[])
        )
        .is_err());
        assert!(preview(
            store,
            &change(ChangeOperation::Add, selected(&["h000", "h000"]), &[&a])
        )
        .is_err());
        assert!(preview(
            store,
            &change(ChangeOperation::Add, selected(&["gone"]), &[&a])
        )
        .is_err());
        assert!(preview(
            store,
            &change(ChangeOperation::Add, selected(&["h000"]), &["gone"])
        )
        .is_err());
        let none = ModelQuery {
            query: "nothing matches".into(),
            ..Default::default()
        };
        assert!(preview(
            store,
            &change(
                ChangeOperation::Add,
                ChangeTarget::Query { query: none },
                &[&a]
            )
        )
        .is_err());
    }

    fn sync_context(profile: &str) -> SyncContext {
        SyncContext {
            profile_id: profile.into(),
            profile_binding: format!("binding-{profile}"),
            now: 3,
        }
    }

    fn map_collection(store: &mut dyn CatalogStore, id: &str, visibility: SyncVisibility) {
        store
            .provision_entity_mapping(EntityRevisionDto {
                profile_id: "a".into(),
                entity_type: SyncEntityType::ModelCollection,
                local_id: Some(id.into()),
                remote_id: format!("remote-{id}"),
                revision: 1,
                concurrency_token: None,
                tombstone: false,
                visibility,
                snapshot: None,
                updated_at: 1,
            })
            .unwrap();
    }

    fn foreign_disconnected_and_shared_destinations_reject_all_changes(
        store: &mut dyn CatalogStore,
    ) {
        let (local, foreign) = seed(store, 2);
        store.bind_sync_profile("a", "binding-a", 1).unwrap();
        store.bind_sync_profile("b", "binding-b", 1).unwrap();
        let active = store
            .create_collection_with_sync("Active", "b", "binding-b", 1)
            .unwrap();
        store.add_model_to_collection(&active.id, "h000");
        for visibility in [SyncVisibility::Private, SyncVisibility::Shared] {
            map_collection(store, &foreign, visibility);
            for profile in [None, Some("b"), Some("a")] {
                if visibility == SyncVisibility::Private && profile == Some("a") {
                    continue;
                }
                let before_a = store.outbound_operations("a", &[], 100).unwrap();
                let before_b = store.outbound_operations("b", &[], 100).unwrap();
                let before = store.all_collections();
                for operation in [ChangeOperation::Add, ChangeOperation::Remove] {
                    let mut request = change(
                        operation,
                        selected(&[if operation == ChangeOperation::Add {
                            "h001"
                        } else {
                            "h000"
                        }]),
                        &[&local, &active.id, &foreign],
                    );
                    request.sync_context = profile.map(sync_context);
                    assert!(preview(store, &request).is_err());
                    assert!(apply(
                        store,
                        &ApplyCollectionChangeRequest {
                            change: request,
                            fingerprint: "0".repeat(64),
                        },
                    )
                    .is_err());
                }
                assert!(rename(
                    store,
                    &RenameCollectionRequest {
                        id: foreign.clone(),
                        name: "Changed".into(),
                        sync_context: profile.map(sync_context),
                    },
                )
                .is_err());
                assert_eq!(store.all_collections(), before);
                assert_eq!(store.outbound_operations("a", &[], 100).unwrap(), before_a);
                assert_eq!(store.outbound_operations("b", &[], 100).unwrap(), before_b);
                for id in [&local, &foreign, &active.id] {
                    assert!(store.collection_contains_model(id, "h000").unwrap());
                    assert!(!store.collection_contains_model(id, "h001").unwrap());
                }
            }
        }
    }

    fn mixed_local_and_owned_changes_only_sync_owned_destinations(store: &mut dyn CatalogStore) {
        let (local, _) = seed(store, 2);
        let hash = "a".repeat(64);
        store.upsert_location(LocationUpsert {
            hash: hash.clone(),
            format: ModelFormat::Stl,
            size: 1,
            root_id: "r".into(),
            path: PathBuf::from("/m/synced.stl"),
            root_relative: PathBuf::from("synced.stl"),
            fingerprint: FileFingerprint {
                size: 1,
                modified_unix_secs: Some(1),
            },
        });
        store.bind_sync_profile("a", "binding-a", 1).unwrap();
        let owned = store
            .create_collection_with_sync("Owned", "a", "binding-a", 1)
            .unwrap();
        let before = store.outbound_operations("a", &[], 100).unwrap();
        let mut request = change(
            ChangeOperation::Add,
            selected(&[&hash]),
            &[&local, &owned.id],
        );
        request.sync_context = Some(sync_context("a"));
        let (_, result) = preview_then_apply(store, request);
        assert_eq!(result.changed_memberships, 2);
        let after = store.outbound_operations("a", &[], 100).unwrap();
        assert_eq!(after.len(), before.len() + 1);
        let membership = after
            .iter()
            .find(|operation| operation.entity_type == SyncEntityType::ModelCollectionMembership)
            .unwrap();
        assert_eq!(membership.payload["collectionId"], owned.id);
        assert_eq!(membership.operation, SyncOperationKind::Create);

        for operation in [ChangeOperation::Add, ChangeOperation::Remove] {
            let mut request = change(operation, selected(&[&hash]), &[&local, &owned.id]);
            request.sync_context = Some(sync_context("a"));
            preview_then_apply(store, request);
        }
        assert_eq!(store.outbound_operations("a", &[], 100).unwrap(), before);
        rename(
            store,
            &RenameCollectionRequest {
                id: local,
                name: "Local renamed".into(),
                sync_context: Some(sync_context("a")),
            },
        )
        .unwrap();
        assert_eq!(store.outbound_operations("a", &[], 100).unwrap(), before);
        rename(
            store,
            &RenameCollectionRequest {
                id: owned.id.clone(),
                name: "Owned renamed".into(),
                sync_context: Some(sync_context("a")),
            },
        )
        .unwrap();
        assert!(store
            .outbound_operations("a", &[], 100)
            .unwrap()
            .iter()
            .any(|operation| operation.operation == SyncOperationKind::Update
                && operation.entity_id == owned.id));
    }

    fn changing_local_destination_to_synced_invalidates_preview(store: &mut dyn CatalogStore) {
        let (local, _) = seed(store, 2);
        store.bind_sync_profile("a", "binding-a", 1).unwrap();
        let mut request = change(ChangeOperation::Add, selected(&["h001"]), &[&local]);
        request.sync_context = Some(sync_context("a"));
        let fingerprint = preview(store, &request).unwrap().fingerprint;
        map_collection(store, &local, SyncVisibility::Private);
        let error = apply(
            store,
            &ApplyCollectionChangeRequest {
                change: request,
                fingerprint,
            },
        )
        .unwrap_err();
        assert!(error.contains("fresh preview"), "{error}");
        assert!(!store.collection_contains_model(&local, "h001").unwrap());
        assert!(store.outbound_operations("a", &[], 100).unwrap().is_empty());
    }

    macro_rules! both_stores {
        ($($name:ident),* $(,)?) => {
            mod memory {
                $(#[test] fn $name() { super::$name(&mut super::InMemoryCatalog::new()); })*
            }
            #[cfg(feature = "sqlite")]
            mod sqlite {
                $(#[test] fn $name() {
                    super::$name(&mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap());
                })*
            }
        };
    }

    both_stores!(
        selected_add_is_additive_and_idempotent,
        query_targets_every_matching_model_beyond_one_page,
        stale_fingerprint_rejects_without_writes,
        rename_keeps_identity_and_memberships,
        invalid_requests_are_rejected,
        foreign_disconnected_and_shared_destinations_reject_all_changes,
        mixed_local_and_owned_changes_only_sync_owned_destinations,
        changing_local_destination_to_synced_invalidates_preview,
    );
}
