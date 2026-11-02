//! Counted organization management and snapshot-checked, atomic definition deletion.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::{finish_catalog_batch, CatalogStore};
use crate::collection_change::SyncContext;

const MAX_DEFINITIONS: usize = 500;
const MAX_ASSIGNMENTS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationKind {
    Tag,
    Collection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteScope {
    Local,
    Sync,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationEntry {
    pub kind: OrganizationKind,
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub synced: bool,
    pub delete_scope: DeleteScope,
}

pub struct OrganizationRecord {
    pub kind: OrganizationKind,
    pub id: String,
    pub name: String,
    pub model_count: usize,
    /// Profile id and whether that profile exposes a read-only entity.
    pub bindings: Vec<(String, bool)>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListOrganizationRequest {
    #[serde(default)]
    pub sync_context: Option<SyncContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteOrganizationRequest {
    pub kind: OrganizationKind,
    pub ids: Vec<String>,
    pub empty_only: bool,
    #[serde(default)]
    pub sync_context: Option<SyncContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyOrganizationDeletionRequest {
    pub selection: DeleteOrganizationRequest,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationDeletionPreview {
    pub kind: OrganizationKind,
    pub entries: Vec<OrganizationEntry>,
    pub assignments_removed: usize,
    pub server_deletions: usize,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationDeletionResult {
    pub kind: OrganizationKind,
    pub deleted_ids: Vec<String>,
    pub assignments_removed: usize,
}

pub fn list<S: CatalogStore + ?Sized>(
    store: &S,
    context: Option<&SyncContext>,
) -> Result<Vec<OrganizationEntry>, String> {
    if let Some(context) = context {
        store.validate_sync_profile_binding(&context.profile_id, &context.profile_binding)?;
    }
    let active_profile = context.map(|context| context.profile_id.as_str());
    let mut entries: Vec<_> = store
        .organization_records()?
        .into_iter()
        .map(|record| {
            let synced = !record.bindings.is_empty();
            let delete_scope =
                if record.kind == OrganizationKind::Tag || !synced {
                    DeleteScope::Local
                } else if record.bindings.iter().any(|(profile, read_only)| {
                    *read_only || Some(profile.as_str()) != active_profile
                }) {
                    DeleteScope::ReadOnly
                } else {
                    DeleteScope::Sync
                };
            OrganizationEntry {
                kind: record.kind,
                id: record.id,
                name: record.name,
                model_count: record.model_count,
                synced,
                delete_scope,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    Ok(entries)
}

fn selection<S: CatalogStore + ?Sized>(
    store: &S,
    request: &DeleteOrganizationRequest,
) -> Result<OrganizationDeletionPreview, String> {
    let ids: BTreeSet<_> = request.ids.iter().collect();
    if ids.is_empty()
        || ids.len() > MAX_DEFINITIONS
        || ids.len() != request.ids.len()
        || ids.iter().any(|id| id.is_empty() || id.len() > 4096)
    {
        return Err("select between 1 and 500 distinct tags or collections".into());
    }
    let available = list(store, request.sync_context.as_ref())?;
    let mut entries = Vec::with_capacity(ids.len());
    let mut memberships = Vec::with_capacity(ids.len());
    let mut assignments_removed = 0;
    for id in ids {
        let entry = available
            .iter()
            .find(|entry| entry.kind == request.kind && entry.id == *id)
            .ok_or("a selected item no longer exists; refresh and review the selection")?;
        if entry.delete_scope == DeleteScope::ReadOnly {
            return Err(
                "a selected collection is shared or belongs to another server profile; no changes were applied"
                    .into(),
            );
        }
        if request.empty_only && entry.model_count != 0 {
            return Err(
                "a selected item is no longer empty; refresh and review the selection".into(),
            );
        }
        if entry.model_count > MAX_ASSIGNMENTS - assignments_removed {
            return Err("this deletion exceeds 100,000 assignments; select fewer items".into());
        }
        let hashes = store.organization_member_hashes(
            request.kind,
            id,
            MAX_ASSIGNMENTS - assignments_removed + 1,
        )?;
        if hashes.len() != entry.model_count {
            return Err("organization membership changed; refresh and review the selection".into());
        }
        assignments_removed += hashes.len();
        entries.push(entry.clone());
        memberships.push(hashes);
    }
    let context = request
        .sync_context
        .as_ref()
        .map(|value| (&value.profile_id, &value.profile_binding));
    let snapshot = serde_json::to_vec(&(
        "organization-deletion-v1",
        request.kind,
        request.empty_only,
        context,
        &entries,
        memberships,
    ))
    .map_err(|error| format!("failed to fingerprint organization deletion: {error}"))?;
    Ok(OrganizationDeletionPreview {
        kind: request.kind,
        server_deletions: entries
            .iter()
            .filter(|entry| entry.delete_scope == DeleteScope::Sync)
            .count(),
        entries,
        assignments_removed,
        fingerprint: format!("{:x}", Sha256::digest(snapshot)),
    })
}

pub fn preview<S: CatalogStore + ?Sized>(
    store: &mut S,
    request: &DeleteOrganizationRequest,
) -> Result<OrganizationDeletionPreview, String> {
    store.begin_batch()?;
    let result = selection(store, request);
    finish_catalog_batch(store, result)
}

pub fn apply<S: CatalogStore + ?Sized>(
    store: &mut S,
    request: &ApplyOrganizationDeletionRequest,
) -> Result<OrganizationDeletionResult, String> {
    store.begin_batch()?;
    let result = (|| {
        let preview = selection(store, &request.selection)?;
        if preview.fingerprint != request.fingerprint {
            return Err(
                "the deletion preview is out of date; preview again before deleting".into(),
            );
        }
        for entry in &preview.entries {
            match entry.kind {
                OrganizationKind::Tag => store.delete_tag_checked(&entry.id)?,
                OrganizationKind::Collection => {
                    if let Some(context) = request.selection.sync_context.as_ref() {
                        store.delete_collection_with_sync_in_batch(
                            &entry.id,
                            &context.profile_id,
                            &context.profile_binding,
                            context.now,
                        )?;
                    } else {
                        store.delete_collection_checked(&entry.id)?;
                    }
                }
            }
        }
        Ok(OrganizationDeletionResult {
            kind: preview.kind,
            deleted_ids: preview.entries.into_iter().map(|entry| entry.id).collect(),
            assignments_removed: preview.assignments_removed,
        })
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

    fn seed(store: &mut dyn CatalogStore) -> (String, String) {
        for i in 0..3 {
            store.upsert_location(LocationUpsert {
                hash: format!("h{i}"),
                format: ModelFormat::Stl,
                size: 1,
                root_id: "root".into(),
                path: PathBuf::from("models").join(format!("{i}.stl")),
                root_relative: PathBuf::from(format!("{i}.stl")),
                fingerprint: FileFingerprint {
                    size: 1,
                    modified_unix_secs: Some(1),
                },
            });
        }
        store.add_model_tag("h0", "Active");
        store.add_model_tag("h1", "Active");
        store.add_model_tag("h2", "Keep");
        let used = store.create_collection("Used").unwrap();
        let empty = store.create_collection("Empty").unwrap();
        store.add_model_to_collection(&used.id, "h0");
        (used.id, empty.id)
    }

    fn request(
        kind: OrganizationKind,
        ids: &[&str],
        empty_only: bool,
    ) -> DeleteOrganizationRequest {
        DeleteOrganizationRequest {
            kind,
            ids: ids.iter().map(|id| (*id).into()).collect(),
            empty_only,
            sync_context: None,
        }
    }

    fn context() -> SyncContext {
        SyncContext {
            profile_id: "p".into(),
            profile_binding: "binding".into(),
            now: 2,
        }
    }

    fn commit(
        store: &mut dyn CatalogStore,
        selection: DeleteOrganizationRequest,
    ) -> OrganizationDeletionResult {
        let fingerprint = preview(store, &selection).unwrap().fingerprint;
        apply(
            store,
            &ApplyOrganizationDeletionRequest {
                selection,
                fingerprint,
            },
        )
        .unwrap()
    }

    fn lists_counts_and_empty_definitions(store: &mut dyn CatalogStore) {
        let (_, empty) = seed(store);
        let entries = list(store, None).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.id == "active")
                .unwrap()
                .model_count,
            2
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.id == empty)
                .unwrap()
                .model_count,
            0
        );
        assert!(entries
            .iter()
            .all(|entry| entry.delete_scope == DeleteScope::Local));
    }

    fn deletes_tags_without_deleting_models_or_other_organization(store: &mut dyn CatalogStore) {
        let (used, _) = seed(store);
        let result = commit(store, request(OrganizationKind::Tag, &["active"], false));
        assert_eq!(result.assignments_removed, 2);
        assert_eq!(result.deleted_ids, ["active"]);
        assert!(store.tags_for_model("h0").is_empty());
        assert_eq!(store.tags_for_model("h2")[0].id, "keep");
        assert_eq!(store.models().len(), 3);
        assert!(store.collection_contains_model(&used, "h0").unwrap());
    }

    fn deletes_multiple_collections_and_keeps_tags_and_models(store: &mut dyn CatalogStore) {
        let (used, empty) = seed(store);
        let result = commit(
            store,
            request(OrganizationKind::Collection, &[&empty, &used], false),
        );
        assert_eq!(result.assignments_removed, 1);
        assert_eq!(result.deleted_ids.len(), 2);
        assert!(store.all_collections().is_empty());
        assert_eq!(store.models().len(), 3);
        assert_eq!(store.all_tags().len(), 2);
    }

    fn empty_cleanup_rechecks_usage_before_deleting(store: &mut dyn CatalogStore) {
        let (_, empty) = seed(store);
        let selection = request(OrganizationKind::Collection, &[&empty], true);
        let fingerprint = preview(store, &selection).unwrap().fingerprint;
        store.add_model_to_collection(&empty, "h0");
        assert!(apply(
            store,
            &ApplyOrganizationDeletionRequest {
                selection,
                fingerprint
            }
        )
        .is_err());
        assert!(store.collection_contains_model(&empty, "h0").unwrap());
    }

    fn membership_swap_with_same_count_invalidates_preview(store: &mut dyn CatalogStore) {
        let (used, _) = seed(store);
        let selection = request(OrganizationKind::Collection, &[&used], false);
        let fingerprint = preview(store, &selection).unwrap().fingerprint;
        store.remove_model_from_collection(&used, "h0");
        store.add_model_to_collection(&used, "h1");
        assert!(apply(
            store,
            &ApplyOrganizationDeletionRequest {
                selection,
                fingerprint
            }
        )
        .is_err());
        assert!(store.collection_contains_model(&used, "h1").unwrap());
    }

    fn rejects_invalid_and_missing_targets_without_writes(store: &mut dyn CatalogStore) {
        let (used, _) = seed(store);
        for ids in [
            vec![],
            vec![used.as_str(), used.as_str()],
            vec![used.as_str(), "missing"],
        ] {
            assert!(preview(store, &request(OrganizationKind::Collection, &ids, false)).is_err());
        }
        assert_eq!(store.all_collections().len(), 2);
    }

    fn synced_deletion_requires_the_owning_profile(store: &mut dyn CatalogStore) {
        store.bind_sync_profile("p", "binding", 1).unwrap();
        let collection = store
            .create_collection_with_sync("Owned", "p", "binding", 1)
            .unwrap();
        assert_eq!(
            list(store, None).unwrap()[0].delete_scope,
            DeleteScope::ReadOnly
        );
        let mut selection = request(OrganizationKind::Collection, &[&collection.id], true);
        assert!(preview(store, &selection).is_err());
        selection.sync_context = Some(context());
        let shown = preview(store, &selection).unwrap();
        assert_eq!(shown.server_deletions, 1);
        commit(store, selection);
        assert!(store.all_collections().is_empty());
        assert!(store
            .outbound_operations("p", &[], 10)
            .unwrap()
            .iter()
            .any(|operation| operation.operation == SyncOperationKind::Delete));
    }

    fn shared_collections_are_not_bulk_deleted(store: &mut dyn CatalogStore) {
        store.bind_sync_profile("p", "binding", 1).unwrap();
        let collection = store.create_collection("Shared").unwrap();
        store
            .provision_entity_mapping(EntityRevisionDto {
                profile_id: "p".into(),
                entity_type: SyncEntityType::ModelCollection,
                local_id: Some(collection.id.clone()),
                remote_id: "remote".into(),
                revision: 1,
                concurrency_token: None,
                tombstone: false,
                visibility: SyncVisibility::Shared,
                snapshot: None,
                updated_at: 1,
            })
            .unwrap();
        let mut selection = request(OrganizationKind::Collection, &[&collection.id], true);
        selection.sync_context = Some(context());
        assert_eq!(
            list(store, selection.sync_context.as_ref()).unwrap()[0].delete_scope,
            DeleteScope::ReadOnly
        );
        assert!(preview(store, &selection).is_err());
        assert_eq!(store.all_collections().len(), 1);
    }

    fn reset_clears_organization_but_does_not_queue_server_deletes(store: &mut dyn CatalogStore) {
        seed(store);
        store.bind_sync_profile("p", "binding", 1).unwrap();
        store
            .create_collection_with_sync("Owned", "p", "binding", 1)
            .unwrap();
        let before = store.outbound_operations("p", &[], 10).unwrap();
        let summary = store.reset_catalog().unwrap();
        assert_eq!(summary.tags_removed, 2);
        assert_eq!(summary.collections_removed, 3);
        assert!(list(store, Some(&context())).unwrap().is_empty());
        assert_eq!(store.outbound_operations("p", &[], 10).unwrap(), before);
        store.validate_sync_profile_binding("p", "binding").unwrap();
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
        lists_counts_and_empty_definitions,
        deletes_tags_without_deleting_models_or_other_organization,
        deletes_multiple_collections_and_keeps_tags_and_models,
        empty_cleanup_rechecks_usage_before_deleting,
        membership_swap_with_same_count_invalidates_preview,
        rejects_invalid_and_missing_targets_without_writes,
        synced_deletion_requires_the_owning_profile,
        shared_collections_are_not_bulk_deleted,
        reset_clears_organization_but_does_not_queue_server_deletes,
    );
}
