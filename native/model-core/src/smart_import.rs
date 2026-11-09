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
pub const MAX_IMPORT_POLICIES: usize = 1_000;
pub const MAX_COMMON_TAGS: usize = 100;
pub const MAX_ORGANIZATION_NAME_CHARS: usize = 128;
pub const MAX_IMPORT_PATH_CHARS: usize = 4_096;
pub const MAX_POLICY_PATTERN_SEGMENTS: usize = 32;
pub const MAX_PREVIEW_ORGANIZATION_NAMES: usize = 10_000;
pub const MAX_ORGANIZATION_ERRORS: usize = 20;
pub const MAX_ORGANIZATION_SAMPLES: usize = 10;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportFormatCounts {
    pub stl: usize,
    pub three_mf: usize,
    pub obj: usize,
    pub step: usize,
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
    pub cloud_files_skipped: usize,
    pub cloud_directories_skipped: usize,
    pub skipped_entries: crate::scan::SkippedEntryCounts,
    pub scan_issues: Vec<crate::scan::ScanIssue>,
    pub scan_issues_truncated: bool,
    pub failure: Option<String>,
    pub archive_warnings: Vec<String>,
    pub complete: bool,
    pub formats: ImportFormatCounts,
    pub folders: Vec<ImportFolder>,
    pub folders_total: usize,
    pub folders_truncated: bool,
    pub next_folder_offset: Option<usize>,
    pub preview_id: Option<String>,
    pub organization: Option<ImportOrganizationPreview>,
}

pub fn preview_scan(scan: &ScanResult) -> ImportPreview {
    preview_scan_page(scan, 0)
}

pub fn preview_scan_page(scan: &ScanResult, folder_offset: usize) -> ImportPreview {
    let folders = preview_folders(scan);
    preview_scan_page_from_folders(scan, folder_offset, &folders)
}

pub fn preview_scan_page_from_folders(
    scan: &ScanResult,
    folder_offset: usize,
    folders: &[ImportFolder],
) -> ImportPreview {
    let mut preview = ImportPreview {
        model_count: scan.files.len(),
        skipped_errors: scan.skipped_errors,
        cloud_files_skipped: scan.cloud_files.len(),
        cloud_directories_skipped: scan.cloud_directories.len(),
        skipped_entries: scan.skipped_entries.clone(),
        scan_issues: scan.scan_issues.clone(),
        scan_issues_truncated: scan.scan_issues_truncated,
        failure: scan.failure.clone(),
        archive_warnings: scan.archive_warnings.clone(),
        complete: !scan.cancelled && scan.failure.is_none(),
        folders_total: folders.len(),
        folders_truncated: folders.len().saturating_sub(folder_offset) > MAX_IMPORT_FOLDERS,
        next_folder_offset: None,
        folders: Vec::new(),
        organization: None,
        ..ImportPreview::default()
    };
    for file in &scan.files {
        preview.total_bytes = preview.total_bytes.saturating_add(file.fingerprint.size);
        match file.format {
            ModelFormat::Stl => preview.formats.stl += 1,
            ModelFormat::ThreeMf => preview.formats.three_mf += 1,
            ModelFormat::Obj => preview.formats.obj += 1,
            ModelFormat::Step => preview.formats.step += 1,
        }
    }
    preview.next_folder_offset = preview
        .folders_truncated
        .then_some(folder_offset.saturating_add(MAX_IMPORT_FOLDERS));
    preview.folders = folders
        .iter()
        .skip(folder_offset)
        .take(MAX_IMPORT_FOLDERS)
        .cloned()
        .collect();
    preview
}

pub fn preview_snapshot_page(
    base: &ImportPreview,
    folder_offset: usize,
    folders: &[ImportFolder],
) -> ImportPreview {
    let mut preview = base.clone();
    preview.folders_total = folders.len();
    preview.folders_truncated = folders.len().saturating_sub(folder_offset) > MAX_IMPORT_FOLDERS;
    preview.next_folder_offset = preview
        .folders_truncated
        .then_some(folder_offset.saturating_add(MAX_IMPORT_FOLDERS));
    preview.folders = folders
        .iter()
        .skip(folder_offset)
        .take(MAX_IMPORT_FOLDERS)
        .cloned()
        .collect();
    preview
}

pub fn preview_folders(scan: &ScanResult) -> Vec<ImportFolder> {
    let mut folders = BTreeMap::<PathBuf, usize>::new();

    for file in &scan.files {
        let mut current = file.root_relative.parent();
        while let Some(folder) = current {
            if folder.as_os_str().is_empty() {
                break;
            }
            *folders.entry(folder.to_path_buf()).or_default() += 1;
            current = folder.parent();
        }
    }

    folders
        .into_iter()
        .filter_map(|(relative_path, model_count)| {
            let name = relative_path.file_name()?.to_string_lossy().into_owned();
            Some(ImportFolder {
                depth: relative_path.components().count(),
                relative_path,
                name,
                model_count,
            })
        })
        .collect()
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
    pub policies: Vec<ImportPolicy>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportPolicyMode {
    Organize,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPolicy {
    pub relative_path: PathBuf,
    pub mode: ImportPolicyMode,
    pub collection_name: Option<String>,
    pub collection_id: Option<String>,
    pub tags: Vec<String>,
    pattern: Option<PolicyPattern>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPolicyInput {
    pub relative_path: String,
    pub mode: ImportPolicyMode,
    pub collection_name: Option<String>,
    pub collection_id: Option<String>,
    pub tags: Vec<String>,
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PolicyPattern {
    segments: Vec<PatternSegment>,
    descendants: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatternSegment {
    Literal(String),
    Capture(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOrganizationPreview {
    pub affected_models: usize,
    pub new_collections: Vec<String>,
    pub reused_collections: Vec<String>,
    pub new_tags: Vec<String>,
    pub reused_tags: Vec<String>,
    pub unmatched_models: usize,
    pub samples: Vec<OrganizationSample>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizationSample {
    pub relative_path: String,
    pub collections: Vec<String>,
    pub tags: Vec<String>,
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
    #[error("import supports at most {MAX_IMPORT_POLICIES} folder policies")]
    TooManyPolicies,
    #[error("folder policy paths must be unique")]
    DuplicatePolicyPath,
    #[error("policy path or pattern exceeds {MAX_IMPORT_PATH_CHARS} characters")]
    PathTooLong,
    #[error("policy pattern is invalid: {0}")]
    InvalidPattern(String),
    #[error("policy output refers to an unknown capture '{0}'")]
    UnknownCapture(String),
    #[error("disabled policies cannot define organization outputs or a pattern")]
    DisabledPolicyOutputs,
    #[error("explicit collection ids require a fixed collection name")]
    CollectionIdRequiresFixedName,
    #[error("collection id must contain 1 to 256 characters")]
    InvalidCollectionId,
    #[error("import was cancelled; the catalog was not changed")]
    Cancelled,
    #[error("collection '{id}' no longer exists")]
    UnknownCollection { id: String },
    #[error("collection name '{name}' matches {matches} collections; select one by id")]
    AmbiguousCollectionName { name: String, matches: usize },
    #[error("failed to protect scan from cloud downloads: {0}")]
    AvailabilityPolicy(String),
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
            policies: Vec::new(),
        })
    }

    pub fn with_policies(
        mut self,
        policies: impl IntoIterator<Item = ImportPolicyInput>,
    ) -> Result<Self, ImportError> {
        let inputs: Vec<_> = policies.into_iter().collect();
        if inputs.len() > MAX_IMPORT_POLICIES {
            return Err(ImportError::TooManyPolicies);
        }
        let mut paths = BTreeSet::new();
        let mut compiled = Vec::with_capacity(inputs.len());
        for policy in inputs {
            let relative_path = checked_policy_path(&policy.relative_path)?;
            if !paths.insert(relative_path.clone()) {
                return Err(ImportError::DuplicatePolicyPath);
            }
            if policy.tags.len() > MAX_COMMON_TAGS {
                return Err(ImportError::TooManyCommonTags);
            }
            if policy.mode == ImportPolicyMode::Disabled
                && (policy.collection_name.is_some()
                    || policy.collection_id.is_some()
                    || !policy.tags.is_empty()
                    || policy.pattern.is_some())
            {
                return Err(ImportError::DisabledPolicyOutputs);
            }

            let pattern = policy.pattern.as_deref().map(compile_pattern).transpose()?;
            let captures: BTreeSet<_> = pattern
                .as_ref()
                .into_iter()
                .flat_map(|pattern| pattern.segments.iter())
                .filter_map(|segment| match segment {
                    PatternSegment::Capture(name) => Some(name.as_str()),
                    PatternSegment::Literal(_) => None,
                })
                .collect();
            let collection_name = policy
                .collection_name
                .as_deref()
                .map(|name| {
                    validate_template(name, &captures)?;
                    checked_name(name)
                })
                .transpose()?;
            let collection_id = policy
                .collection_id
                .as_deref()
                .map(checked_collection_id)
                .transpose()?;
            if collection_id.is_some()
                && (collection_name.is_none()
                    || collection_name
                        .as_deref()
                        .is_some_and(|name| name.contains('{')))
            {
                return Err(ImportError::CollectionIdRequiresFixedName);
            }
            let mut tags = BTreeMap::new();
            for tag in policy.tags {
                validate_template(&tag, &captures)?;
                let display = checked_name(&tag)?;
                tags.entry(display.to_lowercase()).or_insert(display);
            }
            compiled.push(ImportPolicy {
                relative_path,
                mode: policy.mode,
                collection_name,
                collection_id,
                tags: tags.into_values().collect(),
                pattern,
            });
        }
        compiled.sort_by(|left, right| {
            relative_depth(&left.relative_path)
                .cmp(&relative_depth(&right.relative_path))
                .then(left.relative_path.cmp(&right.relative_path))
        });
        self.policies = compiled;
        Ok(self)
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
    if value.chars().count() > MAX_IMPORT_PATH_CHARS {
        return Err(ImportError::PathTooLong);
    }
    if value.is_empty() {
        return Ok(PathBuf::new());
    }
    let canonical = value.replace('\\', "/");
    let path = Path::new(&canonical);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ImportError::InvalidRelativePath);
    }
    Ok(path.to_path_buf())
}

fn checked_collection_id(value: &str) -> Result<String, ImportError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 256 {
        return Err(ImportError::InvalidCollectionId);
    }
    Ok(trimmed.to_string())
}

fn checked_policy_path(value: &str) -> Result<PathBuf, ImportError> {
    if value.chars().count() > MAX_IMPORT_PATH_CHARS {
        return Err(ImportError::PathTooLong);
    }
    if value.is_empty() {
        return Ok(PathBuf::new());
    }
    if value.starts_with('/') || value.contains('\\') {
        return Err(ImportError::InvalidRelativePath);
    }
    let segments: Vec<_> = value.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(ImportError::InvalidRelativePath);
    }
    Ok(segments.iter().collect())
}

fn compile_pattern(value: &str) -> Result<PolicyPattern, ImportError> {
    if value.is_empty() || value.chars().count() > MAX_IMPORT_PATH_CHARS {
        return Err(if value.is_empty() {
            ImportError::InvalidPattern("pattern cannot be empty".into())
        } else {
            ImportError::PathTooLong
        });
    }
    if value.starts_with('/') || value.contains('\\') {
        return Err(ImportError::InvalidPattern(
            "pattern must be relative and slash-separated".into(),
        ));
    }
    let raw_segments: Vec<_> = value.split('/').collect();
    let descendants = raw_segments.last() == Some(&"**");
    if raw_segments.len() > MAX_POLICY_PATTERN_SEGMENTS
        || raw_segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(ImportError::InvalidPattern(
            "pattern has invalid or too many path segments".into(),
        ));
    }
    let pattern_segments = if descendants {
        &raw_segments[..raw_segments.len() - 1]
    } else {
        &raw_segments[..]
    };
    let mut captures = BTreeSet::new();
    let mut segments = Vec::with_capacity(pattern_segments.len());
    for segment in pattern_segments {
        if *segment == "**" || segment.contains('*') {
            return Err(ImportError::InvalidPattern(
                "'**' is allowed only as the final segment".into(),
            ));
        }
        if segment.starts_with('{') && segment.ends_with('}') && segment.len() >= 3 {
            let name = &segment[1..segment.len() - 1];
            if !valid_capture_name(name) {
                return Err(ImportError::InvalidPattern(
                    "capture names must be ASCII identifiers".into(),
                ));
            }
            if !captures.insert(name.to_string()) {
                return Err(ImportError::InvalidPattern(format!(
                    "capture '{name}' is repeated"
                )));
            }
            segments.push(PatternSegment::Capture(name.to_string()));
        } else if segment.contains('{') || segment.contains('}') {
            return Err(ImportError::InvalidPattern(
                "captures must occupy one complete path segment".into(),
            ));
        } else {
            segments.push(PatternSegment::Literal((*segment).to_string()));
        }
    }
    Ok(PolicyPattern {
        segments,
        descendants,
    })
}

fn valid_capture_name(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn validate_template(value: &str, captures: &BTreeSet<&str>) -> Result<(), ImportError> {
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        let after_open = &rest[open + 1..];
        let close = after_open
            .find('}')
            .ok_or_else(|| ImportError::InvalidPattern("unclosed output placeholder".into()))?;
        let name = &after_open[..close];
        if !valid_capture_name(name) {
            return Err(ImportError::InvalidPattern(
                "output placeholders must be ASCII identifiers".into(),
            ));
        }
        if !captures.contains(name) {
            return Err(ImportError::UnknownCapture(name.to_string()));
        }
        rest = &after_open[close + 1..];
    }
    if rest.contains('}') {
        return Err(ImportError::InvalidPattern(
            "unmatched output placeholder delimiter".into(),
        ));
    }
    Ok(())
}

fn relative_depth(path: &Path) -> usize {
    path.components().count()
}

fn display_relative(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn import_root(
    store: &mut dyn CatalogStore,
    root_id: &str,
    scan: &ScanResult,
    plan: &ImportPlan,
) -> Result<ImportResult, ImportError> {
    if let Some(error) = &scan.failure {
        return Err(ImportError::AvailabilityPolicy(error.clone()));
    }
    if scan.cancelled {
        return Err(ImportError::Cancelled);
    }
    let evaluated = evaluate_plan(store, scan, plan)?;
    let staged = hash_changed_files(store, root_id, scan)
        .map_err(|error| ImportError::AvailabilityPolicy(error.to_string()))?;
    let scan = &staged.scan;
    let hashes = &staged.hashes;
    store
        .begin_batch()
        .map_err(ImportError::CatalogTransaction)?;

    let outcome = (|| {
        let mut report = reconcile_root_with_hashes(store, root_id, scan, hashes);
        report.hash_errors = staged.errors;
        let imported_paths: BTreeSet<_> = scan
            .files
            .iter()
            .filter_map(|file| {
                let known = store.get_location(root_id, &file.path)?;
                (known.available
                    && known.fingerprint == file.fingerprint
                    && (hashes.contains_key(&file.path)
                        || !crate::archive::requires_content_revalidation(&file.path)))
                .then_some(&file.path)
            })
            .collect();
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
                .filter(|location| {
                    location.root_id == root_id
                        && location.available
                        && imported_paths.contains(&location.path)
                })
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
                if let Some(organization) = evaluated.by_file.get(&location.path) {
                    for target in organization.collections.values() {
                        collection_targets
                            .entry(target.key.clone())
                            .or_insert_with(|| target.clone());
                    }
                    for name in organization.tags.values() {
                        tag_names
                            .entry(name.to_lowercase())
                            .or_insert_with(|| name.clone());
                    }
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

        result.resolved_collections = evaluated
            .resolved_collections
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

#[derive(Debug, Clone, Default)]
struct FileOrganization {
    collections: BTreeMap<String, ResolvedCollectionTarget>,
    tags: BTreeMap<String, String>,
}

struct EvaluatedPlan {
    by_file: HashMap<PathBuf, FileOrganization>,
    resolved_collections: Vec<(PathBuf, ResolvedCollectionTarget)>,
    unmatched_models: usize,
}

fn evaluate_plan(
    store: &dyn CatalogStore,
    scan: &ScanResult,
    plan: &ImportPlan,
) -> Result<EvaluatedPlan, ImportError> {
    let resolved_rules = resolved_rules(store, &plan.rules)?;
    let collections = store.all_collections();
    let mut resolved_collections = resolved_rules.collection_rules;
    for policy in &plan.policies {
        if policy.mode != ImportPolicyMode::Organize {
            continue;
        }
        if let Some(name) = policy
            .collection_name
            .as_deref()
            .filter(|name| !name.contains('{'))
        {
            resolved_collections.push((
                policy.relative_path.clone(),
                resolve_collection_target(&collections, name, policy.collection_id.as_deref())?,
            ));
        } else if policy.collection_id.is_some() {
            return Err(ImportError::CollectionIdRequiresFixedName);
        }
    }

    let mut by_file = HashMap::with_capacity(scan.files.len());
    let mut unmatched_models = 0;
    for file in &scan.files {
        let mut organization = FileOrganization::default();
        for tag in &plan.common_tags {
            organization
                .tags
                .entry(tag.to_lowercase())
                .or_insert_with(|| tag.clone());
        }
        apply_resolved_rules(&mut organization, resolved_rules.by_path.get(Path::new("")));

        let file_folder = file.root_relative.parent().unwrap_or_else(|| Path::new(""));
        let selected_policy = plan
            .policies
            .iter()
            .filter(|policy| file_folder.starts_with(&policy.relative_path))
            .max_by_key(|policy| relative_depth(&policy.relative_path));
        if let Some(policy) = selected_policy {
            if policy.mode == ImportPolicyMode::Organize {
                let captures = if let Some(pattern) = &policy.pattern {
                    let relative_folder = file_folder
                        .strip_prefix(&policy.relative_path)
                        .unwrap_or_else(|_| Path::new(""));
                    match pattern.match_path(relative_folder) {
                        Some(captures) => captures,
                        None => {
                            unmatched_models += 1;
                            by_file.insert(file.path.clone(), organization);
                            continue;
                        }
                    }
                } else {
                    HashMap::new()
                };
                if let Some(name) = policy.collection_name.as_deref() {
                    let name = expand_template(name, &captures)?;
                    let target = resolve_collection_target(
                        &collections,
                        &name,
                        policy.collection_id.as_deref(),
                    )?;
                    organization
                        .collections
                        .entry(target.key.clone())
                        .or_insert(target);
                }
                for tag in &policy.tags {
                    let name = checked_name(&expand_template(tag, &captures)?)?;
                    organization.tags.entry(name.to_lowercase()).or_insert(name);
                }
            }
        } else {
            let mut folder = Some(file_folder);
            while let Some(current) = folder {
                if let Some(rules) = resolved_rules.by_path.get(current) {
                    if !current.as_os_str().is_empty() {
                        apply_resolved_rules(&mut organization, Some(rules));
                    }
                }

                if current.as_os_str().is_empty() {
                    break;
                }
                folder = current.parent();
            }
        }
        by_file.insert(file.path.clone(), organization);
    }
    Ok(EvaluatedPlan {
        by_file,
        resolved_collections,
        unmatched_models,
    })
}

fn apply_resolved_rules(organization: &mut FileOrganization, rules: Option<&Vec<ResolvedRule>>) {
    if let Some(rules) = rules {
        for rule in rules {
            match rule {
                ResolvedRule::Collection(target) => {
                    organization
                        .collections
                        .entry(target.key.clone())
                        .or_insert_with(|| target.clone());
                }
                ResolvedRule::Tag(name) => {
                    organization
                        .tags
                        .entry(name.to_lowercase())
                        .or_insert_with(|| name.clone());
                }
            }
        }
    }
}

fn resolve_collection_target(
    collections: &[crate::catalog::Collection],
    name: &str,
    id: Option<&str>,
) -> Result<ResolvedCollectionTarget, ImportError> {
    if let Some(id) = id {
        let collection = collections
            .iter()
            .find(|collection| collection.id == id)
            .ok_or_else(|| ImportError::UnknownCollection { id: id.into() })?;
        return Ok(ResolvedCollectionTarget {
            key: format!("id:{}", collection.id),
            id: Some(collection.id.clone()),
            name: collection.name.clone(),
        });
    }
    let matches: Vec<_> = collections
        .iter()
        .filter(|collection| collection.name.to_lowercase() == name.to_lowercase())
        .collect();
    match matches.as_slice() {
        [] => Ok(ResolvedCollectionTarget {
            key: format!("name:{}", name.to_lowercase()),
            id: None,
            name: name.into(),
        }),
        [collection] => Ok(ResolvedCollectionTarget {
            key: format!("id:{}", collection.id),
            id: Some(collection.id.clone()),
            name: collection.name.clone(),
        }),
        _ => Err(ImportError::AmbiguousCollectionName {
            name: name.into(),
            matches: matches.len(),
        }),
    }
}

impl PolicyPattern {
    fn match_path(&self, path: &Path) -> Option<HashMap<String, String>> {
        let segments: Vec<_> = path
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if (!self.descendants && segments.len() != self.segments.len())
            || (self.descendants && segments.len() < self.segments.len())
        {
            return None;
        }
        let mut captures = HashMap::new();
        for (pattern, value) in self.segments.iter().zip(segments) {
            match pattern {
                PatternSegment::Literal(expected) if expected != &value => return None,
                PatternSegment::Literal(_) => {}
                PatternSegment::Capture(name) => {
                    captures.insert(name.clone(), value);
                }
            }
        }
        Some(captures)
    }
}

fn expand_template(value: &str, captures: &HashMap<String, String>) -> Result<String, ImportError> {
    let mut output = String::new();
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        output.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let close = after_open
            .find('}')
            .ok_or_else(|| ImportError::InvalidPattern("unclosed output placeholder".into()))?;
        let name = &after_open[..close];
        let capture = captures
            .get(name)
            .ok_or_else(|| ImportError::UnknownCapture(name.to_string()))?;
        output.push_str(capture);
        rest = &after_open[close + 1..];
    }
    output.push_str(rest);
    checked_name(&output)
}

pub fn preview_organization(
    store: &dyn CatalogStore,
    scan: &ScanResult,
    plan: &ImportPlan,
) -> Result<ImportOrganizationPreview, ImportError> {
    let evaluated = evaluate_plan(store, scan, plan)?;
    let existing_tags: BTreeSet<_> = store.all_tags().into_iter().map(|tag| tag.id).collect();
    let mut affected_models = 0;
    let mut new_collections = BTreeMap::new();
    let mut reused_collections = BTreeMap::new();
    let mut new_tags = BTreeMap::new();
    let mut reused_tags = BTreeMap::new();
    let mut samples = Vec::new();
    for file in &scan.files {
        let Some(organization) = evaluated.by_file.get(&file.path) else {
            continue;
        };
        if organization.collections.is_empty() && organization.tags.is_empty() {
            continue;
        }
        affected_models += 1;
        let collection_names: Vec<_> = organization
            .collections
            .values()
            .map(|target| {
                if target.id.is_some() {
                    reused_collections
                        .entry(target.name.to_lowercase())
                        .or_insert_with(|| target.name.clone());
                } else {
                    new_collections
                        .entry(target.name.to_lowercase())
                        .or_insert_with(|| target.name.clone());
                }
                target.name.clone()
            })
            .collect();
        let tag_names: Vec<_> = organization.tags.values().cloned().collect();
        for tag in &tag_names {
            let id = crate::catalog::normalize_tag(tag)
                .map(|normalized| normalized.id)
                .ok_or(ImportError::InvalidName)?;
            if existing_tags.contains(&id) {
                reused_tags.entry(id).or_insert_with(|| tag.clone());
            } else {
                new_tags.entry(id).or_insert_with(|| tag.clone());
            }
        }
        if samples.len() < MAX_ORGANIZATION_SAMPLES {
            samples.push(OrganizationSample {
                relative_path: display_relative(&file.root_relative),
                collections: collection_names,
                tags: tag_names,
            });
        }
    }
    let mut errors = Vec::new();
    let mut bounded = |names: BTreeMap<String, String>| {
        if names.len() > MAX_PREVIEW_ORGANIZATION_NAMES {
            errors.push(format!(
                "organization preview exceeds {MAX_PREVIEW_ORGANIZATION_NAMES} distinct names"
            ));
        }
        names
            .into_values()
            .take(MAX_PREVIEW_ORGANIZATION_NAMES)
            .collect::<Vec<_>>()
    };
    Ok(ImportOrganizationPreview {
        affected_models,
        new_collections: bounded(new_collections),
        reused_collections: bounded(reused_collections),
        new_tags: bounded(new_tags),
        reused_tags: bounded(reused_tags),
        unmatched_models: evaluated.unmatched_models,
        samples,
        errors: errors.into_iter().take(MAX_ORGANIZATION_ERRORS).collect(),
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

    fn policy(
        relative_path: &str,
        mode: ImportPolicyMode,
        collection_name: Option<&str>,
        tags: &[&str],
        pattern: Option<&str>,
    ) -> ImportPolicyInput {
        ImportPolicyInput {
            relative_path: relative_path.into(),
            mode,
            collection_name: collection_name.map(str::to_string),
            collection_id: None,
            tags: tags.iter().map(|tag| (*tag).into()).collect(),
            pattern: pattern.map(str::to_string),
        }
    }

    fn synthetic_scan(paths: &[String]) -> ScanResult {
        ScanResult {
            files: paths
                .iter()
                .map(|relative| crate::scan::DiscoveredFile {
                    path: PathBuf::from("/virtual").join(relative),
                    root_relative: PathBuf::from(relative),
                    format: ModelFormat::Stl,
                    fingerprint: crate::model::FileFingerprint {
                        size: 1,
                        modified_unix_secs: Some(1),
                        source_revision: None,
                    },
                })
                .collect(),
            ..ScanResult::default()
        }
    }

    #[test]
    fn previews_nested_folder_counts_without_hashing() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Animals/Cats/a.stl"), b"a");
        write(&dir.path().join("Animals/Dogs/b.3mf"), b"bb");
        write(&dir.path().join("Loose.obj"), b"ccc");
        write(&dir.path().join("CAD/widget.step"), b"dddd");

        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let preview = preview_scan(&scan);

        assert_eq!(preview.model_count, 4);
        assert_eq!(preview.total_bytes, 10);
        assert_eq!(preview.formats.stl, 1);
        assert_eq!(preview.formats.three_mf, 1);
        assert_eq!(preview.formats.obj, 1);
        assert_eq!(preview.formats.step, 1);
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
                ("CAD".to_string(), 1),
            ]
        );
    }

    #[test]
    fn preview_allows_partial_traversal_and_reports_errors() {
        let preview = preview_scan(&ScanResult {
            skipped_errors: 1,
            ..Default::default()
        });

        assert!(preview.complete);
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
    fn legacy_rule_paths_normalize_saved_windows_separators() {
        assert_eq!(
            checked_relative_path("Animals\\Cats").unwrap(),
            PathBuf::from("Animals/Cats")
        );
    }

    #[test]
    fn nearest_policy_replaces_legacy_folder_rules_but_keeps_common_tags() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Root/kept.stl"), b"kept");
        write(&dir.path().join("Root/Disabled/hidden.stl"), b"hidden");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let plan = ImportPlan::new(
            [
                (
                    "Root".to_string(),
                    ImportRuleKind::Collection,
                    "Legacy".to_string(),
                    None,
                ),
                (
                    "".to_string(),
                    ImportRuleKind::Collection,
                    "Whole import".to_string(),
                    None,
                ),
            ],
            ["whole-import".to_string()],
        )
        .unwrap()
        .with_policies([
            policy(
                "Root",
                ImportPolicyMode::Organize,
                Some("Scoped"),
                &["scoped"],
                None,
            ),
            policy("Root/Disabled", ImportPolicyMode::Disabled, None, &[], None),
        ])
        .unwrap();
        let mut store = InMemoryCatalog::new();

        import_root(&mut store, "root", &scan, &plan).unwrap();

        for model in store.models() {
            let path = model.locations[0].root_relative.to_string_lossy();
            let collections: BTreeSet<_> = store
                .collections_for_model(&model.hash)
                .into_iter()
                .map(|collection| collection.name)
                .collect();
            let tags: BTreeSet<_> = store
                .tags_for_model(&model.hash)
                .into_iter()
                .map(|tag| tag.name)
                .collect();
            assert!(tags.contains("whole-import"));
            assert!(collections.contains("Whole import"));
            if path.contains("Disabled") {
                assert_eq!(collections, BTreeSet::from(["Whole import".to_string()]));
                assert_eq!(tags, BTreeSet::from(["whole-import".to_string()]));
            } else {
                assert_eq!(
                    collections,
                    BTreeSet::from(["Scoped".to_string(), "Whole import".to_string()])
                );
                assert_eq!(
                    tags,
                    BTreeSet::from(["scoped".to_string(), "whole-import".to_string()])
                );
            }
        }
    }

    #[test]
    fn capture_templates_and_trailing_double_star_match_directories_only() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Shelf/GroupA/part.stl"), b"a");
        write(&dir.path().join("Shelf/GroupA/sub/part.stl"), b"b");
        write(&dir.path().join("Shelf/direct.stl"), b"c");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let plan = ImportPlan::new([], ["common".into()])
            .unwrap()
            .with_policies([policy(
                "Shelf",
                ImportPolicyMode::Organize,
                Some("Collection {group}"),
                &["tag-{group}"],
                Some("{group}/**"),
            )])
            .unwrap();
        let mut store = InMemoryCatalog::new();

        let preview = preview_organization(&store, &scan, &plan).unwrap();
        assert_eq!(preview.affected_models, 3);
        assert_eq!(preview.unmatched_models, 1);
        assert_eq!(
            preview.new_collections,
            vec!["Collection GroupA".to_string()]
        );
        assert_eq!(
            preview.new_tags,
            vec!["common".to_string(), "tag-GroupA".to_string()]
        );

        import_root(&mut store, "root", &scan, &plan).unwrap();
        for model in store.models() {
            let path = model.locations[0].root_relative.to_string_lossy();
            let tags: BTreeSet<_> = store
                .tags_for_model(&model.hash)
                .into_iter()
                .map(|tag| tag.name)
                .collect();
            assert!(tags.contains("common"));
            assert_eq!(tags.contains("tag-GroupA"), path.contains("GroupA"));
            assert_eq!(
                store.collections_for_model(&model.hash).len(),
                usize::from(path.contains("GroupA"))
            );
        }
    }

    #[test]
    fn invalid_patterns_and_unknown_placeholders_are_rejected() {
        for pattern in ["a/**/b", "{part}/{part}", "parts//"] {
            let result = ImportPlan::new([], []).unwrap().with_policies([policy(
                "",
                ImportPolicyMode::Organize,
                None,
                &[],
                Some(pattern),
            )]);
            assert!(matches!(result, Err(ImportError::InvalidPattern(_))));
        }
        let unknown = ImportPlan::new([], []).unwrap().with_policies([policy(
            "",
            ImportPolicyMode::Organize,
            Some("collection-{unknown}"),
            &[],
            Some("{part}"),
        )]);
        assert_eq!(unknown, Err(ImportError::UnknownCapture("unknown".into())));
    }

    #[test]
    fn oversized_resolved_capture_fails_before_catalog_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let segment = "x".repeat(MAX_ORGANIZATION_NAME_CHARS + 1);
        write(&dir.path().join(format!("{segment}/part.stl")), b"part");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let plan = ImportPlan::new([], [])
            .unwrap()
            .with_policies([policy(
                "",
                ImportPolicyMode::Organize,
                None,
                &["{part}"],
                Some("{part}"),
            )])
            .unwrap();
        let mut store = InMemoryCatalog::new();

        assert_eq!(
            import_root(&mut store, "root", &scan, &plan),
            Err(ImportError::InvalidName)
        );
        assert!(store.models().is_empty());
        assert!(store.all_tags().is_empty());
    }

    #[test]
    fn policy_collection_ids_are_returned_by_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Parts/part.stl"), b"part");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        let collection = store.create_collection("Parts").unwrap();
        let plan = ImportPlan::new([], [])
            .unwrap()
            .with_policies([ImportPolicyInput {
                relative_path: "Parts".into(),
                mode: ImportPolicyMode::Organize,
                collection_name: Some("Parts".into()),
                collection_id: Some(collection.id.clone()),
                tags: Vec::new(),
                pattern: None,
            }])
            .unwrap();

        let result = import_root(&mut store, "root", &scan, &plan).unwrap();

        assert!(result.resolved_collections.iter().any(|resolved| {
            resolved.relative_path == Path::new("Parts") && resolved.collection_id == collection.id
        }));
    }

    #[test]
    fn policy_collection_resolution_failure_does_not_mutate_catalog() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Parts/part.stl"), b"part");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        store.create_collection("Parts").unwrap();
        store.create_collection("parts").unwrap();
        let plan = ImportPlan::new([], [])
            .unwrap()
            .with_policies([policy(
                "Parts",
                ImportPolicyMode::Organize,
                Some("PARTS"),
                &[],
                None,
            )])
            .unwrap();

        assert!(matches!(
            import_root(&mut store, "root", &scan, &plan),
            Err(ImportError::AmbiguousCollectionName { .. })
        ));
        assert!(store.models().is_empty());
        assert_eq!(store.all_collections().len(), 2);
    }

    #[test]
    fn folder_pages_are_bounded_while_organization_preview_uses_full_scan() {
        let paths: Vec<_> = (0..501)
            .map(|index| format!("folder-{index:04}/part.stl"))
            .collect();
        let scan = synthetic_scan(&paths);
        let first = preview_scan_page(&scan, 0);
        let second = preview_scan_page(&scan, 500);
        assert_eq!(first.folders.len(), 500);
        assert_eq!(first.folders_total, 501);
        assert!(first.folders_truncated);
        assert_eq!(first.next_folder_offset, Some(500));
        assert_eq!(second.folders.len(), 1);
        assert_eq!(second.folders_total, 501);
        assert!(!second.folders_truncated);
        assert_eq!(second.next_folder_offset, None);

        let plan = ImportPlan::new([], [])
            .unwrap()
            .with_policies([policy(
                "folder-0500",
                ImportPolicyMode::Organize,
                None,
                &["late"],
                None,
            )])
            .unwrap();
        let organization = preview_organization(&InMemoryCatalog::new(), &scan, &plan).unwrap();
        assert_eq!(organization.affected_models, 1);
        assert_eq!(organization.samples[0].relative_path, paths[500]);
        assert_eq!(organization.new_tags, vec!["late"]);
    }

    #[test]
    fn snapshot_paging_preserves_incomplete_scan_status() {
        let folders: Vec<_> = (0..501)
            .map(|index| ImportFolder {
                relative_path: PathBuf::from(format!("folder-{index:04}")),
                name: format!("folder-{index:04}"),
                depth: 1,
                model_count: 1,
            })
            .collect();
        let base = ImportPreview {
            complete: false,
            skipped_errors: 1,
            folders_total: folders.len(),
            folders_truncated: true,
            next_folder_offset: Some(MAX_IMPORT_FOLDERS),
            ..ImportPreview::default()
        };

        let second_page = preview_snapshot_page(&base, MAX_IMPORT_FOLDERS, &folders);

        assert!(!second_page.complete);
        assert_eq!(second_page.skipped_errors, 1);
        assert_eq!(second_page.folders.len(), 1);
        assert_eq!(second_page.folders_total, 501);
        assert!(!second_page.folders_truncated);
    }

    #[test]
    fn cancelled_scan_cannot_mutate_or_reconcile_catalog() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("part.stl"), b"part");
        let scan = scan_root(dir.path(), &AtomicBool::new(false));
        let mut store = InMemoryCatalog::new();
        let empty_plan = ImportPlan::new([], []).unwrap();
        import_root(&mut store, "root", &scan, &empty_plan).unwrap();
        let incomplete = ScanResult {
            max_archive_bytes: scan.max_archive_bytes,
            files: Vec::new(),
            cancelled: true,
            skipped_errors: 1,
            archive_warnings: Vec::new(),
            ..ScanResult::default()
        };

        let result = import_root(&mut store, "root", &incomplete, &empty_plan);

        assert_eq!(result, Err(ImportError::Cancelled));
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn hash_failure_is_reported_while_readable_files_are_organized() {
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

        let result = import_root(&mut store, "root", &next_scan, &tagged_plan).unwrap();
        assert_eq!(result.report.hash_errors, 1);
        assert_eq!(result.report.unchanged, 1);
        assert_eq!(store.models().len(), 1);
        assert!(store.models()[0].locations[0].available);
        assert_eq!(store.all_tags()[0].name, "should-not-apply");
    }

    #[test]
    fn mixed_cloud_and_readable_models_import_and_report_skips() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("local.stl"), b"local");
        write(&dir.path().join("cloud.stl"), b"cloud");
        write(&dir.path().join("cloud.zip"), b"not a local archive");
        let scan =
            crate::scan::scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
                let cloud = path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("cloud");
                Ok((fs::symlink_metadata(path)?, cloud))
            });
        let preview = preview_scan(&scan);
        assert!(preview.complete);
        assert_eq!(preview.model_count, 1);
        assert_eq!(preview.cloud_files_skipped, 2);
        let mut store = InMemoryCatalog::new();
        let result = import_root(&mut store, "root", &scan, &ImportPlan::default()).unwrap();
        assert_eq!(result.report.added, 1);
        assert_eq!(result.report.cloud_files_skipped, 2);
        assert_eq!(result.report.hash_errors, 0);
        assert_eq!(
            store.models()[0].hash,
            crate::hash::hash_reader(&b"local"[..]).unwrap()
        );
    }

    #[test]
    fn all_cloud_folder_is_complete_and_marks_known_files_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("part.stl");
        write(&path, b"part");
        let mut store = InMemoryCatalog::new();
        let initial = scan_root(dir.path(), &AtomicBool::new(false));
        import_root(&mut store, "root", &initial, &ImportPlan::default()).unwrap();
        let cloud =
            crate::scan::scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
                Ok((fs::symlink_metadata(path)?, path.is_file()))
            });
        let preview = preview_scan(&cloud);
        assert!(preview.complete);
        assert_eq!(preview.model_count, 0);
        assert_eq!(preview.cloud_files_skipped, 1);
        let result = import_root(&mut store, "root", &cloud, &ImportPlan::default()).unwrap();
        assert_eq!(result.report.cloud_files_skipped, 1);
        assert!(!store.models()[0].locations[0].available);
        let restored = import_root(&mut store, "root", &initial, &ImportPlan::default()).unwrap();
        assert_eq!(restored.report.unchanged, 1);
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn file_metadata_errors_allow_partial_import_without_marking_other_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("denied.stl"), b"denied");
        let mut store = InMemoryCatalog::new();
        let initial = scan_root(dir.path(), &AtomicBool::new(false));
        import_root(&mut store, "root", &initial, &ImportPlan::default()).unwrap();
        write(&dir.path().join("local.stl"), b"local");
        let scan =
            crate::scan::scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
                if path.ends_with("denied.stl") {
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
                Ok((fs::symlink_metadata(path)?, false))
            });
        assert!(preview_scan(&scan).complete);
        let result = import_root(&mut store, "root", &scan, &ImportPlan::default()).unwrap();
        assert_eq!(result.report.added, 1);
        assert_eq!(result.report.scan_errors, 1);
        assert_eq!(result.report.missing, 0);
        assert_eq!(store.models().len(), 2);
        assert!(store
            .models()
            .iter()
            .all(|model| model.locations[0].available));
    }

    #[test]
    fn failed_subtree_is_preserved_while_healthy_subtree_imports_and_reconciles() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join("denied/old.stl");
        let missing = dir.path().join("healthy/missing.stl");
        write(&hidden, b"hidden");
        write(&missing, b"missing");
        let mut store = InMemoryCatalog::new();
        let initial = scan_root(dir.path(), &AtomicBool::new(false));
        import_root(&mut store, "root", &initial, &ImportPlan::default()).unwrap();
        fs::remove_file(&missing).unwrap();
        write(&dir.path().join("healthy/new.stl"), b"new");
        let scan =
            crate::scan::scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
                if path.ends_with("denied") {
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
                assert_ne!(path, hidden);
                Ok((fs::symlink_metadata(path)?, false))
            });
        assert!(preview_scan(&scan).complete);
        let plan = ImportPlan::new([], ["readable-only".to_string()]).unwrap();
        let result = import_root(&mut store, "root", &scan, &plan).unwrap();
        assert_eq!(result.report.added, 1);
        assert_eq!(result.report.missing, 1);
        assert_eq!(result.report.scan_errors, 1);
        assert_eq!(result.report.skipped_entries.permission_denied, 1);
        assert_eq!(
            result.report.scan_issues[0].kind,
            crate::scan::ScanEntryKind::Folder
        );
        assert_eq!(
            result.report.scan_issues[0].path,
            dir.path().join("denied").to_string_lossy()
        );
        assert!(store.get_location("root", &hidden).unwrap().available);
        assert!(!store.get_location("root", &missing).unwrap().available);
        assert_eq!(result.models_organized, 1);
        let hidden_hash = store.get_location("root", &hidden).unwrap().hash;
        assert!(store.tags_for_model(&hidden_hash).is_empty());
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
