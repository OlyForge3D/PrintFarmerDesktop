//! Folder-aware import preview and bulk organization.
//!
//! Previewing only inspects directory entries and cheap metadata. Importing
//! performs the normal reconciliation, then applies explicit folder-derived
//! collection/tag rules to every model location discovered under the root.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

use crate::catalog::{
    hash_changed_files, normalize_tag, reconcile_root_with_hashes, CatalogStore, ReconcileReport,
};
use crate::model::ModelFormat;
use crate::scan::ScanResult;

pub const MAX_IMPORT_FOLDERS: usize = 500;
pub const MAX_IMPORT_RULES: usize = 1_000;
pub const MAX_COMMON_TAGS: usize = 100;
pub const MAX_ORGANIZATION_NAME_CHARS: usize = 128;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportFormatCounts {
    pub stl: usize,
    pub three_mf: usize,
    pub obj: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFolder {
    pub relative_path: PathBuf,
    pub name: String,
    pub depth: usize,
    pub model_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportPreview {
    pub model_count: usize,
    pub total_bytes: u64,
    pub skipped_errors: usize,
    pub complete: bool,
    pub formats: ImportFormatCounts,
    pub folders: Vec<ImportFolder>,
    pub folders_truncated: bool,
}

pub fn preview_scan(scan: &ScanResult) -> ImportPreview {
    let mut folders = BTreeMap::<PathBuf, usize>::new();
    let mut preview = ImportPreview {
        model_count: scan.files.len(),
        skipped_errors: scan.skipped_errors,
        complete: !scan.cancelled && scan.skipped_errors == 0,
        ..ImportPreview::default()
    };

    for file in &scan.files {
        preview.total_bytes = preview.total_bytes.saturating_add(file.fingerprint.size);
        match file.format {
            ModelFormat::Stl => preview.formats.stl += 1,
            ModelFormat::ThreeMf => preview.formats.three_mf += 1,
            ModelFormat::Obj => preview.formats.obj += 1,
        }

        let mut current = file.root_relative.parent();
        while let Some(folder) = current {
            if folder.as_os_str().is_empty() {
                break;
            }
            *folders.entry(folder.to_path_buf()).or_default() += 1;
            current = folder.parent();
        }
    }

    preview.folders_truncated = folders.len() > MAX_IMPORT_FOLDERS;
    preview.folders = folders
        .into_iter()
        .take(MAX_IMPORT_FOLDERS)
        .filter_map(|(relative_path, model_count)| {
            let name = relative_path.file_name()?.to_string_lossy().into_owned();
            Some(ImportFolder {
                depth: relative_path.components().count(),
                relative_path,
                name,
                model_count,
            })
        })
        .collect();
    preview
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportRuleKind {
    Collection,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRule {
    pub relative_path: PathBuf,
    pub kind: ImportRuleKind,
    pub name: String,
    pub collection_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub rules: Vec<ImportRule>,
    pub common_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportResult {
    pub report: ReconcileReport,
    pub models_organized: usize,
    pub collections_created: usize,
    pub collection_assignments: usize,
    pub tag_assignments: usize,
    pub resolved_collections: Vec<ResolvedImportCollection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImportCollection {
    pub relative_path: PathBuf,
    pub name: String,
    pub collection_id: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImportError {
    #[error("import supports at most {MAX_IMPORT_RULES} folder rules")]
    TooManyRules,
    #[error("import supports at most {MAX_COMMON_TAGS} common tags")]
    TooManyCommonTags,
    #[error("organization names must contain 1 to {MAX_ORGANIZATION_NAME_CHARS} characters")]
    InvalidName,
    #[error("folder rule path must be relative and cannot contain '.' or '..' components")]
    InvalidRelativePath,
    #[error("collection id must contain 1 to 256 characters")]
    InvalidCollectionId,
    #[error(
        "import scan was incomplete ({skipped_errors} filesystem errors, cancelled: {cancelled})"
    )]
    IncompleteScan {
        skipped_errors: usize,
        cancelled: bool,
    },
    #[error("collection '{id}' no longer exists")]
    UnknownCollection { id: String },
    #[error("collection name '{name}' matches {matches} collections; select one by id")]
    AmbiguousCollectionName { name: String, matches: usize },
    #[error("failed to hash {errors} model files; the catalog was not changed")]
    HashFailures { errors: usize },
    #[error("catalog transaction failed: {0}")]
    CatalogTransaction(String),
    #[error("failed to assign model '{hash}' to collection '{collection}'")]
    CollectionAssignment { hash: String, collection: String },
    #[error("failed to assign tag '{tag}' to model '{hash}'")]
    TagAssignment { hash: String, tag: String },
}

impl ImportPlan {
    pub fn new(
        rules: impl IntoIterator<Item = (String, ImportRuleKind, String, Option<String>)>,
        common_tags: impl IntoIterator<Item = String>,
    ) -> Result<Self, ImportError> {
        let raw_rules: Vec<_> = rules.into_iter().collect();
        if raw_rules.len() > MAX_IMPORT_RULES {
            return Err(ImportError::TooManyRules);
        }
        let raw_tags: Vec<_> = common_tags.into_iter().collect();
        if raw_tags.len() > MAX_COMMON_TAGS {
            return Err(ImportError::TooManyCommonTags);
        }

        let mut normalized_rules = Vec::with_capacity(raw_rules.len());
        for (relative_path, kind, name, collection_id) in raw_rules {
            let collection_id = match (kind, collection_id) {
                (ImportRuleKind::Collection, Some(id)) => Some(checked_collection_id(&id)?),
                (ImportRuleKind::Collection, None) | (ImportRuleKind::Tag, None) => None,
                (ImportRuleKind::Tag, Some(_)) => return Err(ImportError::InvalidCollectionId),
            };
            normalized_rules.push(ImportRule {
                relative_path: checked_relative_path(&relative_path)?,
                kind,
                name: checked_name(&name)?,
                collection_id,
            });
        }

        fn checked_collection_id(value: &str) -> Result<String, ImportError> {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 256 {
                return Err(ImportError::InvalidCollectionId);
            }
            Ok(trimmed.to_string())
        }

        let mut normalized_tags = BTreeMap::new();
        for tag in raw_tags {
            let display = checked_name(&tag)?;
            normalized_tags
                .entry(display.to_lowercase())
                .or_insert(display);
        }

        Ok(Self {
            rules: normalized_rules,
            common_tags: normalized_tags.into_values().collect(),
        })
    }
}

fn checked_name(value: &str) -> Result<String, ImportError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_ORGANIZATION_NAME_CHARS {
        return Err(ImportError::InvalidName);
    }
    Ok(trimmed.to_string())
}

fn checked_relative_path(value: &str) -> Result<PathBuf, ImportError> {
    if value.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ImportError::InvalidRelativePath);
    }
    Ok(path.to_path_buf())
}

pub fn import_root(
    store: &mut dyn CatalogStore,
    root_id: &str,
    scan: &ScanResult,
    plan: &ImportPlan,
) -> Result<ImportResult, ImportError> {
    if scan.cancelled || scan.skipped_errors > 0 {
        return Err(ImportError::IncompleteScan {
            skipped_errors: scan.skipped_errors,
            cancelled: scan.cancelled,
        });
    }
    let resolved_rules = resolved_rules(store, &plan.rules)?;
    let (hashes, hash_errors) = hash_changed_files(store, root_id, scan);
    if hash_errors > 0 {
        return Err(ImportError::HashFailures {
            errors: hash_errors,
        });
    }
    store
        .begin_batch()
        .map_err(ImportError::CatalogTransaction)?;

    let outcome = (|| {
        let report = reconcile_root_with_hashes(store, root_id, scan, &hashes);
        if report.hash_errors > 0 {
            return Err(ImportError::HashFailures {
                errors: report.hash_errors,
            });
        }
        let models = store.models();
        let mut created_collection_ids = HashMap::<String, String>::new();

        let mut result = ImportResult {
            report,
            models_organized: 0,
            collections_created: 0,
            collection_assignments: 0,
            tag_assignments: 0,
            resolved_collections: Vec::new(),
        };

        for model in models {
            let relevant_locations: Vec<_> = model
                .locations
                .iter()
                .filter(|location| location.root_id == root_id && location.available)
                .collect();
            if relevant_locations.is_empty() {
                continue;
            }

            let mut collection_targets = BTreeMap::<String, ResolvedCollectionTarget>::new();
            let mut tag_names = BTreeMap::<String, String>::new();
            for tag in &plan.common_tags {
                tag_names
                    .entry(tag.to_lowercase())
                    .or_insert_with(|| tag.clone());
            }

            for location in relevant_locations {
                let mut folder = location.root_relative.parent();
                loop {
                    let current = folder.unwrap_or_else(|| Path::new(""));
                    if let Some(rules) = resolved_rules.by_path.get(current) {
                        for rule in rules {
                            match rule {
                                ResolvedRule::Collection(target) => {
                                    collection_targets
                                        .entry(target.key.clone())
                                        .or_insert_with(|| target.clone());
                                }
                                ResolvedRule::Tag(name) => {
                                    tag_names
                                        .entry(name.to_lowercase())
                                        .or_insert_with(|| name.clone());
                                }
                            }
                        }
                    }
                    if current.as_os_str().is_empty() {
                        break;
                    }
                    folder = current.parent();
                }
            }

            if collection_targets.is_empty() && tag_names.is_empty() {
                continue;
            }
            result.models_organized += 1;

            let existing_collection_ids: BTreeSet<String> = store
                .collections_for_model(&model.hash)
                .into_iter()
                .map(|collection| collection.id)
                .collect();
            for (key, target) in collection_targets {
                let collection_id = if let Some(id) = &target.id {
                    id.clone()
                } else if let Some(id) = created_collection_ids.get(&key) {
                    id.clone()
                } else {
                    let created = store
                        .create_collection(&target.name)
                        .ok_or(ImportError::InvalidName)?;
                    result.collections_created += 1;
                    created_collection_ids.insert(key, created.id.clone());
                    created.id
                };
                if !existing_collection_ids.contains(&collection_id) {
                    if !store.add_model_to_collection(&collection_id, &model.hash) {
                        return Err(ImportError::CollectionAssignment {
                            hash: model.hash,
                            collection: target.name,
                        });
                    }
                    result.collection_assignments += 1;
                }
            }

            let existing_tag_ids: BTreeSet<String> = store
                .tags_for_model(&model.hash)
                .into_iter()
                .map(|tag| tag.id)
                .collect();
            for (key, name) in tag_names {
                let tag_id = normalize_tag(&name).ok_or(ImportError::InvalidName)?.id;
                if !existing_tag_ids.contains(&tag_id) {
                    store.add_model_tag(&model.hash, &name).ok_or_else(|| {
                        ImportError::TagAssignment {
                            hash: model.hash.clone(),
                            tag: name.clone(),
                        }
                    })?;
                    result.tag_assignments += 1;
                }
                debug_assert_eq!(key, tag_id);
            }
        }

        result.resolved_collections = resolved_rules
            .collection_rules
            .iter()
            .filter_map(|(relative_path, target)| {
                let collection_id = target
                    .id
                    .clone()
                    .or_else(|| created_collection_ids.get(&target.key).cloned())?;
                Some(ResolvedImportCollection {
                    relative_path: relative_path.clone(),
                    name: target.name.clone(),
                    collection_id,
                })
            })
            .collect();
        Ok(result)
    })();

    match outcome {
        Ok(result) => {
            if let Err(error) = store.commit_batch() {
                store.rollback_batch();
                Err(ImportError::CatalogTransaction(error))
            } else {
                Ok(result)
            }
        }
        Err(error) => {
            store.rollback_batch();
            Err(error)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedCollectionTarget {
    key: String,
    id: Option<String>,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedRule {
    Collection(ResolvedCollectionTarget),
    Tag(String),
}

struct ResolvedRules {
    by_path: HashMap<PathBuf, Vec<ResolvedRule>>,
    collection_rules: Vec<(PathBuf, ResolvedCollectionTarget)>,
}

fn resolved_rules(
    store: &dyn CatalogStore,
    rules: &[ImportRule],
) -> Result<ResolvedRules, ImportError> {
    let collections = store.all_collections();
    let mut by_path: HashMap<PathBuf, Vec<ResolvedRule>> = HashMap::new();
    let mut collection_rules = Vec::new();
    for rule in rules {
        let resolved = match rule.kind {
            ImportRuleKind::Tag => ResolvedRule::Tag(rule.name.clone()),
            ImportRuleKind::Collection => {
                let target = if let Some(id) = &rule.collection_id {
                    let collection = collections
                        .iter()
                        .find(|collection| collection.id == *id)
                        .ok_or_else(|| ImportError::UnknownCollection { id: id.clone() })?;
                    ResolvedCollectionTarget {
                        key: format!("id:{}", collection.id),
                        id: Some(collection.id.clone()),
                        name: collection.name.clone(),
                    }
                } else {
                    let matches: Vec<_> = collections
                        .iter()
                        .filter(|collection| {
                            collection.name.to_lowercase() == rule.name.to_lowercase()
                        })
                        .collect();
                    match matches.as_slice() {
                        [] => ResolvedCollectionTarget {
                            key: format!("name:{}", rule.name.to_lowercase()),
                            id: None,
                            name: rule.name.clone(),
                        },
                        [collection] => ResolvedCollectionTarget {
                            key: format!("id:{}", collection.id),
                            id: Some(collection.id.clone()),
                            name: collection.name.clone(),
                        },
                        _ => {
                            return Err(ImportError::AmbiguousCollectionName {
                                name: rule.name.clone(),
                                matches: matches.len(),
                            });
                        }
                    }
                };
                collection_rules.push((rule.relative_path.clone(), target.clone()));
                ResolvedRule::Collection(target)
            }
        };
        by_path
            .entry(rule.relative_path.clone())
            .or_default()
            .push(resolved);
    }
    Ok(ResolvedRules {
        by_path,
        collection_rules,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::AtomicBool;

    use crate::catalog::InMemoryCatalog;
    use crate::scan::scan_root;

    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn previews_nested_folder_counts_without_hashing() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Animals/Cats/a.stl"), b"a");
        write(&dir.path().join("Animals/Dogs/b.3mf"), b"bb");
        write(&dir.path().join("Loose.obj"), b"ccc");

        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let preview = preview_scan(&scan);

        assert_eq!(preview.model_count, 3);
        assert_eq!(preview.total_bytes, 6);
        assert_eq!(preview.formats.stl, 1);
        assert_eq!(preview.formats.three_mf, 1);
        assert_eq!(preview.formats.obj, 1);
        assert!(preview.complete);
        assert_eq!(
            preview
                .folders
                .iter()
                .map(|folder| (
                    folder.relative_path.to_string_lossy().replace('\\', "/"),
                    folder.model_count
                ))
                .collect::<Vec<_>>(),
            vec![
                ("Animals".to_string(), 2),
                ("Animals/Cats".to_string(), 1),
                ("Animals/Dogs".to_string(), 1),
            ]
        );
    }

    #[test]
    fn preview_marks_traversal_errors_as_incomplete() {
        let preview = preview_scan(&ScanResult {
            skipped_errors: 1,
            ..Default::default()
        });

        assert!(!preview.complete);
        assert_eq!(preview.skipped_errors, 1);
    }

    #[test]
    fn imports_root_and_applies_folder_collections_and_tags() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Animals/Cats/a.stl"), b"a");
        write(&dir.path().join("Animals/Dogs/b.stl"), b"b");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let plan = ImportPlan::new(
            [
                (
                    "".to_string(),
                    ImportRuleKind::Collection,
                    "My Models".to_string(),
                    None,
                ),
                (
                    "Animals".to_string(),
                    ImportRuleKind::Collection,
                    "Animals".to_string(),
                    None,
                ),
                (
                    "Animals/Cats".to_string(),
                    ImportRuleKind::Tag,
                    "Cats".to_string(),
                    None,
                ),
            ],
            ["ready".to_string()],
        )
        .unwrap();
        let mut store = InMemoryCatalog::new();

        let result = import_root(&mut store, "root", &scan, &plan).unwrap();

        assert_eq!(result.report.added, 2);
        assert_eq!(result.models_organized, 2);
        assert_eq!(result.collections_created, 2);
        assert_eq!(result.collection_assignments, 4);
        assert_eq!(result.tag_assignments, 3);
        assert_eq!(result.resolved_collections.len(), 2);
        assert!(result
            .resolved_collections
            .iter()
            .all(|collection| collection.collection_id.starts_with("col-")));
        let models = store.models();
        let cat = models
            .iter()
            .find(|model| {
                model.locations[0]
                    .root_relative
                    .to_string_lossy()
                    .contains("Cats")
            })
            .unwrap();
        assert_eq!(store.collections_for_model(&cat.hash).len(), 2);
        assert_eq!(
            store
                .tags_for_model(&cat.hash)
                .into_iter()
                .map(|tag| tag.name)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["Cats".to_string(), "ready".to_string()])
        );
    }

    #[test]
    fn repeated_import_reuses_collections_and_memberships() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Parts/a.stl"), b"a");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let plan = ImportPlan::new(
            [(
                "Parts".to_string(),
                ImportRuleKind::Collection,
                "Parts".to_string(),
                None,
            )],
            ["reviewed".to_string()],
        )
        .unwrap();
        let mut store = InMemoryCatalog::new();

        let first = import_root(&mut store, "root", &scan, &plan).unwrap();
        let second = import_root(&mut store, "root", &scan, &plan).unwrap();

        assert_eq!(first.collections_created, 1);
        assert_eq!(second.collections_created, 0);
        assert_eq!(second.collection_assignments, 0);
        assert_eq!(second.tag_assignments, 0);
        assert_eq!(store.all_collections().len(), 1);
    }

    #[test]
    fn rejects_unsafe_rule_paths_before_import() {
        let result = ImportPlan::new(
            [(
                "../outside".to_string(),
                ImportRuleKind::Tag,
                "bad".to_string(),
                None,
            )],
            [],
        );
        assert_eq!(result, Err(ImportError::InvalidRelativePath));
    }

    #[test]
    fn incomplete_scan_cannot_mutate_or_reconcile_catalog() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("part.stl"), b"part");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        let empty_plan = ImportPlan::new([], []).unwrap();
        import_root(&mut store, "root", &scan, &empty_plan).unwrap();
        let incomplete = ScanResult {
            files: Vec::new(),
            cancelled: false,
            skipped_errors: 1,
        };

        let result = import_root(&mut store, "root", &incomplete, &empty_plan);

        assert_eq!(
            result,
            Err(ImportError::IncompleteScan {
                skipped_errors: 1,
                cancelled: false,
            })
        );
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn hash_failure_aborts_before_any_catalog_mutation() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("existing.stl"), b"existing");
        let initial_scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        let empty_plan = ImportPlan::new([], []).unwrap();
        import_root(&mut store, "root", &initial_scan, &empty_plan).unwrap();

        let disappearing = dir.path().join("new.stl");
        write(&disappearing, b"new");
        let next_scan = scan_root(dir.path(), &AtomicBool::new(false));
        fs::remove_file(disappearing).unwrap();
        let tagged_plan = ImportPlan::new([], ["should-not-apply".to_string()]).unwrap();

        assert_eq!(
            import_root(&mut store, "root", &next_scan, &tagged_plan),
            Err(ImportError::HashFailures { errors: 1 })
        );
        assert_eq!(store.models().len(), 1);
        assert!(store.models()[0].locations[0].available);
        assert!(store.all_tags().is_empty());
    }

    #[test]
    fn duplicate_collection_names_require_an_explicit_id() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Parts/a.stl"), b"a");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        let selected = store.create_collection("Parts").unwrap();
        store.create_collection("Parts").unwrap();
        let ambiguous = ImportPlan::new(
            [(
                "Parts".to_string(),
                ImportRuleKind::Collection,
                "Parts".to_string(),
                None,
            )],
            [],
        )
        .unwrap();

        assert_eq!(
            import_root(&mut store, "root", &scan, &ambiguous),
            Err(ImportError::AmbiguousCollectionName {
                name: "Parts".to_string(),
                matches: 2,
            })
        );
        assert!(store.models().is_empty());

        let explicit = ImportPlan::new(
            [(
                "Parts".to_string(),
                ImportRuleKind::Collection,
                "Parts".to_string(),
                Some(selected.id.clone()),
            )],
            [],
        )
        .unwrap();
        let result = import_root(&mut store, "root", &scan, &explicit).unwrap();
        let model = store.models().pop().unwrap();
        assert_eq!(store.collections_for_model(&model.hash)[0].id, selected.id);
        assert_eq!(result.resolved_collections[0].collection_id, selected.id);
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_import_persists_bulk_organization() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write(&source.join("Vehicles/Truck/truck.stl"), b"truck");
        let scan = scan_root(&source, &AtomicBool::new(false));
        let plan = ImportPlan::new(
            [
                (
                    "Vehicles".to_string(),
                    ImportRuleKind::Collection,
                    "Vehicles".to_string(),
                    None,
                ),
                (
                    "Vehicles/Truck".to_string(),
                    ImportRuleKind::Tag,
                    "Truck".to_string(),
                    None,
                ),
            ],
            ["functional".to_string()],
        )
        .unwrap();
        let db = dir.path().join("catalog.sqlite3");

        {
            let mut store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
            let result = import_root(&mut store, "vehicles", &scan, &plan).unwrap();
            assert_eq!(result.models_organized, 1);
            assert_eq!(result.collections_created, 1);
            assert_eq!(result.collection_assignments, 1);
            assert_eq!(result.tag_assignments, 2);
        }

        let store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
        let imported = store.models().pop().unwrap();
        assert_eq!(store.collections_for_model(&imported.hash).len(), 1);
        assert_eq!(store.tags_for_model(&imported.hash).len(), 2);
    }
}
