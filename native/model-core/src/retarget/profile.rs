use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::guardrails;
use super::project::ProjectInspection;
use super::report::{IssueCode, RankedTarget, TargetRecommendation};
use super::{RetargetError, RetargetLimits};

pub(crate) const BUNDLE_ID: &str = "snapmaker-u1-orca-presets";
pub(crate) const BUNDLE_COMMIT: &str = "0c2d17834b7820339c1cf4326fda7db9da4a766a";
pub(crate) const MACHINE_NAME: &str = "Snapmaker U1 (0.4 nozzle)";
const MACHINE_MODEL_NAME: &str = "Snapmaker U1";
const EXPECTED_FILES: usize = 82;
const EXPECTED_ROOTS: usize = 40;
const EXPECTED_PROCESS_ROOTS: usize = 15;
const EXPECTED_FILAMENT_ROOTS: usize = 23;
const EXPECTED_MANIFEST_SHA256: &str =
    "aaa7fb83f0ab84353607e3297b767cc5be3bea2d4576a94068f3067540da41a3";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingValue {
    Scalar(String),
    List(Vec<String>),
}

impl SettingValue {
    pub fn as_list(&self) -> Vec<&str> {
        match self {
            Self::Scalar(value) => vec![value],
            Self::List(values) => values.iter().map(String::as_str).collect(),
        }
    }

    pub fn first(&self) -> Option<&str> {
        match self {
            Self::Scalar(value) => Some(value),
            Self::List(values) => values.first().map(String::as_str),
        }
    }

    pub fn finite_positive(&self) -> Option<f64> {
        let value = self.first()?.trim().parse::<f64>().ok()?;
        (value.is_finite() && value > 0.0).then_some(value)
    }

    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Scalar(value) => Value::String(value.clone()),
            Self::List(values) => Value::Array(
                values
                    .iter()
                    .map(|value| Value::String(value.clone()))
                    .collect(),
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ProfileType {
    MachineModel,
    Machine,
    Process,
    Filament,
}

impl ProfileType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "machine_model" => Some(Self::MachineModel),
            "machine" => Some(Self::Machine),
            "process" => Some(Self::Process),
            "filament" => Some(Self::Filament),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct Profile {
    profile_type: ProfileType,
    name: String,
    inherits: Option<String>,
    settings: BTreeMap<String, SettingValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    bundle_id: String,
    target_printer: TargetPrinter,
    upstream: Upstream,
    selected_paths: Vec<String>,
    roots: Vec<String>,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Deserialize)]
struct TargetPrinter {
    model: String,
    preset: String,
    variant: String,
}

#[derive(Debug, Deserialize)]
struct Upstream {
    commit: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestFile {
    path: String,
    sha256: String,
    role: String,
    #[serde(rename = "type")]
    profile_type: String,
    name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedProfile {
    pub name: String,
    pub path: String,
    pub sha256: String,
    pub settings: BTreeMap<String, SettingValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilamentProfileSummary {
    pub name: String,
    pub root_path: String,
    pub sha256: String,
    pub material_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProfileSummary {
    pub profile_id: String,
    pub display_name: String,
    pub root_path: String,
    pub layer_height: f64,
    pub category: String,
    pub bundle_commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfileSummary {
    pub name: String,
    pub model: String,
    pub variant: String,
    pub nozzle_count: usize,
    pub printable_height: String,
    pub root_path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProfileDetails {
    #[serde(flatten)]
    pub summary: TargetProfileSummary,
    pub setting_count: usize,
    pub settings_summary: BTreeMap<String, Value>,
    pub machine: MachineProfileSummary,
    pub compatible_filaments: Vec<FilamentProfileSummary>,
    pub profile_hashes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTargetProfileDetails {
    pub profile_id: String,
    pub sha256: String,
    pub machine_name: String,
    pub process_name: String,
    pub filament_names: Vec<String>,
    pub layer_height: f64,
    pub setting_count: usize,
    pub capabilities: ImportedTargetCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTargetCapabilities {
    pub nozzle_count: usize,
    pub max_filament_slots: usize,
    pub object_exclusion: bool,
    pub motion_guardrails: bool,
}

#[derive(Debug)]
pub(crate) struct Bundle {
    machine: ResolvedProfile,
    processes: BTreeMap<String, ResolvedProfile>,
    filaments: Vec<ResolvedProfile>,
    filament_defaults: BTreeMap<String, SettingValue>,
    summaries: Vec<TargetProfileSummary>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedTarget {
    pub profile_id: String,
    pub display_name: String,
    pub machine: ResolvedProfile,
    pub process: ResolvedProfile,
    pub filaments: Vec<ResolvedProfile>,
    pub filament_defaults: BTreeMap<String, SettingValue>,
    imported: bool,
}

impl ResolvedTarget {
    pub(crate) fn map_materials(
        &self,
        materials: &[String],
    ) -> Result<Vec<&ResolvedProfile>, RetargetError> {
        if !self.imported {
            return map_bundled_materials(&self.filaments, &self.filament_defaults, materials);
        }
        let mut mapped = Vec::with_capacity(materials.len());
        for material in materials {
            let canonical = material_root_name(material).ok_or_else(|| {
                RetargetError::new(
                    IssueCode::UnsupportedMaterial,
                    format!("source material '{material}' is unsupported"),
                    "Use a supported U1 filament material.",
                )
                .with_setting("filament_type")
            })?;
            let matches = self
                .filaments
                .iter()
                .filter(|profile| {
                    profile
                        .settings
                        .get("filament_type")
                        .and_then(SettingValue::first)
                        .is_some_and(|value| material_root_name(value) == Some(canonical))
                })
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [profile] => mapped.push(*profile),
                [] => {
                    return Err(RetargetError::new(
                        IssueCode::UnsupportedMaterial,
                        format!(
                        "imported target has no filament profile for source material '{material}'"
                    ),
                        "Choose an imported U1 reference containing every source material.",
                    ))
                }
                _ => {
                    return Err(RetargetError::new(
                        IssueCode::ProfileValueInvalid,
                        format!("imported target has ambiguous profiles for material '{material}'"),
                        "Use an imported U1 reference with one profile per material type.",
                    )
                    .with_setting("filament_type"))
                }
            }
        }
        validate_material_defaults(&mapped, &self.filament_defaults)?;
        Ok(mapped)
    }

    pub(crate) fn is_filament_setting_key(&self, key: &str) -> bool {
        is_filament_identity_key(key)
            || self
                .filaments
                .iter()
                .any(|profile| is_filament_profile_setting(key, profile))
    }

    pub(crate) fn recommendation(&self, source_layer_height: f64) -> TargetRecommendation {
        let target_height = self
            .process
            .settings
            .get("layer_height")
            .and_then(SettingValue::finite_positive)
            .unwrap_or(source_layer_height);
        TargetRecommendation {
            recommended: RankedTarget {
                profile_id: self.profile_id.clone(),
                display_name: self.display_name.clone(),
                score: 1.0 / (1.0 + (source_layer_height - target_height).abs()),
                rationale: format!(
                    "Explicit target differs by {:.3} mm from the source layer height.",
                    (source_layer_height - target_height).abs()
                ),
            },
            alternatives: Vec::new(),
        }
    }
}

impl Bundle {
    pub(crate) fn load(root: &Path, limits: &RetargetLimits) -> Result<Self, RetargetError> {
        let manifest_path = root.join("manifest.json");
        let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
            RetargetError::new(
                IssueCode::ProfileManifestInvalid,
                format!("cannot read profile manifest: {error}"),
                "Install the complete pinned Snapmaker U1 profile bundle.",
            )
        })?;
        if !metadata.file_type().is_file() || metadata.len() > limits.max_manifest_bytes {
            return Err(manifest_error(
                "profile manifest is not a bounded regular file",
            ));
        }
        let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
            RetargetError::new(
                IssueCode::ProfileManifestInvalid,
                format!("cannot read profile manifest: {error}"),
                "Install the complete pinned Snapmaker U1 profile bundle.",
            )
        })?;
        let manifest_sha256 = crate::hash::hash_reader(manifest_bytes.as_slice())
            .map_err(|error| manifest_error(format!("cannot hash profile manifest: {error}")))?;
        if manifest_sha256 != EXPECTED_MANIFEST_SHA256 {
            return Err(RetargetError::new(
                IssueCode::ProfileHashMismatch,
                "profile manifest does not match the pinned Snapmaker U1 bundle",
                "Restore the exact bundled manifest from the application distribution.",
            ));
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| manifest_error(format!("invalid manifest JSON: {error}")))?;
        validate_manifest_shape(&manifest)?;

        let mut profiles = HashMap::<String, Profile>::new();
        let mut files_by_path = HashMap::<String, ManifestFile>::new();
        let mut case_paths = HashSet::new();
        let mut total_bytes = 0u64;
        for file in &manifest.files {
            validate_relative_path(&file.path)?;
            if !case_paths.insert(file.path.to_ascii_lowercase()) {
                return Err(manifest_error("manifest contains duplicate paths"));
            }
            let path = root.join(Path::new(&file.path));
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| manifest_error(format!("profile file '{}' is missing", file.path)))?;
            if !metadata.file_type().is_file() || metadata.len() > limits.max_profile_bytes {
                return Err(manifest_error(format!(
                    "profile file '{}' is not a bounded regular file",
                    file.path
                )));
            }
            let source = fs::File::open(&path).map_err(|error| {
                RetargetError::new(
                    IssueCode::Io,
                    format!("cannot open profile '{}': {error}", file.path),
                    "Check profile bundle permissions.",
                )
            })?;
            let opened_metadata = source.metadata().map_err(|error| {
                RetargetError::new(
                    IssueCode::Io,
                    format!("cannot inspect profile '{}': {error}", file.path),
                    "Check profile bundle permissions.",
                )
            })?;
            if !opened_metadata.file_type().is_file()
                || opened_metadata.len() > limits.max_profile_bytes
            {
                return Err(manifest_error(format!(
                    "profile file '{}' is not a bounded regular file",
                    file.path
                )));
            }
            let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
            source
                .take(limits.max_profile_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| {
                    RetargetError::new(
                        IssueCode::Io,
                        format!("cannot read profile '{}': {error}", file.path),
                        "Check profile bundle permissions.",
                    )
                })?;
            if bytes.len() as u64 > limits.max_profile_bytes {
                return Err(manifest_error(format!(
                    "profile file '{}' exceeds its byte limit",
                    file.path
                )));
            }
            total_bytes = total_bytes
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| manifest_error("profile byte total overflowed"))?;
            if total_bytes > limits.max_profile_total_bytes {
                return Err(manifest_error("profile bundle exceeds its byte limit"));
            }
            let actual_hash = crate::hash::hash_reader(bytes.as_slice())
                .map_err(|error| manifest_error(format!("cannot hash profile: {error}")))?;
            if actual_hash != file.sha256 {
                return Err(RetargetError::new(
                    IssueCode::ProfileHashMismatch,
                    format!("profile hash mismatch for '{}'", file.path),
                    "Restore the pinned profile bundle without modifications.",
                ));
            }
            let manifest_type = ProfileType::parse(&file.profile_type)
                .ok_or_else(|| manifest_error("manifest has an unsupported profile type"))?;
            let profile = parse_profile(&bytes, Some(manifest_type))?;
            if profile.profile_type != manifest_type || profile.name != file.name {
                return Err(RetargetError::new(
                    IssueCode::ProfileTypeMismatch,
                    format!(
                        "profile identity does not match manifest for '{}'",
                        file.path
                    ),
                    "Restore the pinned profile bundle.",
                ));
            }
            if profiles.insert(profile.name.clone(), profile).is_some() {
                return Err(manifest_error("profile names must be globally unique"));
            }
            files_by_path.insert(file.path.clone(), file.clone());
        }

        validate_inheritance(&profiles)?;
        let mut resolved = HashMap::new();
        for name in profiles.keys() {
            let mut chain = Vec::new();
            resolve_profile(name, &profiles, &mut resolved, &mut chain)?;
        }

        let machine_path = "profiles/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json";
        let machine = resolved_for_path(machine_path, &files_by_path, &resolved)?;
        let filament_defaults = resolved
            .get("fdm_filament_common")
            .cloned()
            .ok_or_else(|| manifest_error("canonical filament defaults are missing"))?;
        let mut processes = BTreeMap::new();
        let mut filaments = Vec::new();
        for root_path in &manifest.roots {
            let file = files_by_path
                .get(root_path)
                .ok_or_else(|| manifest_error(format!("unknown root '{root_path}'")))?;
            match ProfileType::parse(&file.profile_type) {
                Some(ProfileType::Process) => {
                    let profile = resolved_for_path(root_path, &files_by_path, &resolved)?;
                    let id = stable_id(root_path);
                    processes.insert(id, profile);
                }
                Some(ProfileType::Filament) => {
                    filaments.push(resolved_for_path(root_path, &files_by_path, &resolved)?);
                }
                _ => {}
            }
        }
        filaments.sort_by(|a, b| a.name.cmp(&b.name));
        validate_compatibility(&processes, &filaments)?;
        let mut summaries: Vec<_> = processes
            .iter()
            .map(|(id, profile)| summary(id, profile, &manifest.upstream.commit))
            .collect::<Result<_, _>>()?;
        summaries.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        Ok(Self {
            machine,
            processes,
            filaments,
            filament_defaults,
            summaries,
        })
    }

    pub(crate) fn list(&self) -> Vec<TargetProfileSummary> {
        self.summaries.clone()
    }

    pub(crate) fn process(&self, id: &str) -> Result<&ResolvedProfile, RetargetError> {
        self.processes.get(id).ok_or_else(|| {
            RetargetError::new(
                IssueCode::ProfileNotFound,
                format!("unknown retarget profile '{id}'"),
                "Choose a profile returned by listRetargetProfiles.",
            )
        })
    }

    pub(crate) fn resolve_bundled(&self, id: &str) -> Result<ResolvedTarget, RetargetError> {
        let process = self.process(id)?.clone();
        Ok(ResolvedTarget {
            profile_id: id.to_string(),
            display_name: process.name.clone(),
            machine: self.machine.clone(),
            process,
            filaments: self.filaments.clone(),
            filament_defaults: self.filament_defaults.clone(),
            imported: false,
        })
    }

    pub(crate) fn inspect(&self, id: &str) -> Result<TargetProfileDetails, RetargetError> {
        let process = self.process(id)?;
        let summary = self
            .summaries
            .iter()
            .find(|candidate| candidate.profile_id == id)
            .cloned()
            .ok_or_else(|| manifest_error("target summary index is inconsistent"))?;
        let settings_summary = [
            "layer_height",
            "initial_layer_print_height",
            "default_acceleration",
            "travel_speed",
            "outer_wall_speed",
            "sparse_infill_speed",
        ]
        .into_iter()
        .filter_map(|key| {
            process
                .settings
                .get(key)
                .map(|value| (key.to_string(), value.to_json()))
        })
        .collect();
        let nozzle_count = self
            .machine
            .settings
            .get("nozzle_diameter")
            .map(|value| value.as_list().len())
            .unwrap_or(0);
        let machine = MachineProfileSummary {
            name: self.machine.name.clone(),
            model: MACHINE_MODEL_NAME.to_string(),
            variant: "0.4".to_string(),
            nozzle_count,
            printable_height: self
                .machine
                .settings
                .get("printable_height")
                .and_then(SettingValue::first)
                .unwrap_or_default()
                .to_string(),
            root_path: self.machine.path.clone(),
            sha256: self.machine.sha256.clone(),
        };
        let compatible_filaments = self
            .filaments
            .iter()
            .map(filament_summary)
            .collect::<Result<Vec<_>, _>>()?;
        let mut profile_hashes = BTreeMap::new();
        profile_hashes.insert(self.machine.path.clone(), self.machine.sha256.clone());
        profile_hashes.insert(process.path.clone(), process.sha256.clone());
        for filament in &self.filaments {
            profile_hashes.insert(filament.path.clone(), filament.sha256.clone());
        }
        Ok(TargetProfileDetails {
            summary,
            setting_count: process.settings.len(),
            settings_summary,
            machine,
            compatible_filaments,
            profile_hashes,
        })
    }

    pub(crate) fn map_materials(
        &self,
        materials: &[String],
    ) -> Result<Vec<&ResolvedProfile>, RetargetError> {
        map_bundled_materials(&self.filaments, &self.filament_defaults, materials)
    }

    pub(crate) fn is_filament_setting_key(&self, key: &str) -> bool {
        is_filament_identity_key(key)
            || self
                .filaments
                .iter()
                .any(|profile| is_filament_profile_setting(key, profile))
    }

    pub(crate) fn recommend(
        &self,
        layer_height: f64,
        source_process: Option<&str>,
    ) -> TargetRecommendation {
        let tokens = source_process.unwrap_or_default().to_ascii_lowercase();
        let specialized = ["quality", "strength", "support", "benchy", "draft", "fine"]
            .into_iter()
            .find(|token| tokens.contains(token));
        let mut ranked: Vec<_> = self
            .summaries
            .iter()
            .filter(|summary| {
                specialized.is_some()
                    || !matches!(
                        summary.category.as_str(),
                        "quality" | "strength" | "support" | "benchy" | "draft" | "fine"
                    )
            })
            .map(|summary| {
                let category_bonus = specialized
                    .filter(|token| **token == summary.category)
                    .map_or(0.0, |_| 100.0);
                let distance = (summary.layer_height - layer_height).abs();
                RankedTarget {
                    profile_id: summary.profile_id.clone(),
                    display_name: summary.display_name.clone(),
                    score: category_bonus - distance * 100.0,
                    rationale: if category_bonus > 0.0 {
                        format!(
                            "Matches source '{}' intent and is {:.3} mm from its layer height.",
                            summary.category, distance
                        )
                    } else {
                        format!("Layer height differs by {:.3} mm.", distance)
                    },
                }
            })
            .collect();
        ranked.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.profile_id.cmp(&b.profile_id))
        });
        let recommended = ranked.remove(0);
        TargetRecommendation {
            recommended,
            alternatives: ranked,
        }
    }

    pub(crate) fn import_reference(
        &self,
        path: &Path,
        limits: &RetargetLimits,
    ) -> Result<ImportedTargetProfileDetails, RetargetError> {
        self.resolve_imported(path, None, limits)
            .map(|(_, details)| details)
    }

    pub(crate) fn resolve_imported(
        &self,
        path: &Path,
        expected_sha256: Option<&str>,
        limits: &RetargetLimits,
    ) -> Result<(ResolvedTarget, ImportedTargetProfileDetails), RetargetError> {
        if let Some(expected) = expected_sha256 {
            if expected.len() != 64
                || !expected
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(RetargetError::new(
                    IssueCode::ProfileHashMismatch,
                    "imported target expectedSha256 must be 64 lowercase hexadecimal characters",
                    "Inspect the imported target again and use its exact sha256.",
                ));
            }
        }
        let path_metadata =
            fs::symlink_metadata(path).map_err(|error| RetargetError::target_io(path, error))?;
        if !path_metadata.file_type().is_file() {
            return Err(RetargetError::new(
                IssueCode::TargetNotFound,
                "imported target path is not a regular file",
                "Choose a regular editable Snapmaker U1 3MF reference.",
            ));
        }
        let mut file =
            fs::File::open(path).map_err(|error| RetargetError::target_io(path, error))?;
        let metadata = file
            .metadata()
            .map_err(|error| RetargetError::target_io(path, error))?;
        if !metadata.is_file() {
            return Err(RetargetError::new(
                IssueCode::TargetNotFound,
                "imported target path is not a regular file",
                "Choose a regular editable Snapmaker U1 3MF reference.",
            ));
        }
        if metadata.len() > limits.max_source_bytes {
            return Err(RetargetError::new(
                IssueCode::ArchiveLimitExceeded,
                "imported target exceeds the compressed archive limit",
                "Choose a U1 reference smaller than 512 MiB.",
            ));
        }
        let capacity = usize::try_from(metadata.len()).unwrap_or_default();
        let mut snapshot = Vec::with_capacity(capacity);
        file.by_ref()
            .take(limits.max_source_bytes.saturating_add(1))
            .read_to_end(&mut snapshot)
            .map_err(|error| RetargetError::target_io(path, error))?;
        if snapshot.len() as u64 > limits.max_source_bytes {
            return Err(RetargetError::new(
                IssueCode::ArchiveLimitExceeded,
                "imported target exceeds the compressed archive limit",
                "Choose a U1 reference smaller than 512 MiB.",
            ));
        }
        let sha256_before = crate::hash::hash_reader(snapshot.as_slice())
            .map_err(|error| RetargetError::target_io(path, error))?;
        if expected_sha256.is_some_and(|expected| expected != sha256_before) {
            return Err(RetargetError::new(
                IssueCode::ProfileHashMismatch,
                "imported target hash does not match expectedSha256",
                "Inspect the imported target again and discard stale metadata.",
            ));
        }
        let archive = super::archive::ArchivePackage::from_bytes(&snapshot, limits)?;
        let project = ProjectInspection::inspect_snapshot(path, &archive, limits, &snapshot)?;
        if !project.blockers.is_empty() {
            return Err(RetargetError::new(
                IssueCode::IncompleteProject,
                "imported U1 reference is not a complete editable project",
                "Export a complete editable Snapmaker U1 Orca/Bambu 3MF.",
            ));
        }
        super::transform::validate_source_array_lengths(&project, |key| {
            self.is_filament_setting_key(key)
        })?;
        for key in super::transform::MACHINE_OWNED_KEYS.iter().chain(
            [
                "print_settings_id",
                "compatible_printers",
                "compatible_printers_condition",
                "layer_height",
                "initial_layer_print_height",
                "filament_settings_id",
                "filament_type",
            ]
            .iter(),
        ) {
            if !project.settings.contains_key(*key) {
                return Err(RetargetError::new(
                    IssueCode::IncompleteProject,
                    format!("imported reference lacks flattened target setting '{key}'"),
                    "Re-export the project with complete machine, process, and filament settings.",
                )
                .with_setting(*key));
            }
        }
        for key in super::transform::MACHINE_OWNED_KEYS {
            if let Some(expected) = self.machine.settings.get(*key) {
                require_imported_setting_shape(&project.settings, key, expected)?;
            }
        }
        for key in super::transform::PROCESS_OWNED_KEYS {
            if project.settings.contains_key(*key) {
                if let Some(expected) = self
                    .processes
                    .values()
                    .find_map(|process| process.settings.get(*key))
                {
                    require_imported_setting_shape(&project.settings, key, expected)?;
                }
            }
        }
        let machine_name =
            require_imported_scalar_exact(&project.settings, "printer_settings_id", MACHINE_NAME)?;
        require_imported_scalar_exact(&project.settings, "printer_model", MACHINE_MODEL_NAME)?;
        require_imported_scalar_exact(&project.settings, "printer_variant", "0.4")?;
        require_imported_scalar_exact(&project.settings, "printer_technology", "FFF")?;
        for key in [
            "gcode_flavor",
            "machine_start_gcode",
            "machine_end_gcode",
            "change_filament_gcode",
            "machine_pause_gcode",
            "before_layer_change_gcode",
            "layer_change_gcode",
            "bed_model",
            "bed_texture",
            "nozzle_type",
            "single_extruder_multi_material",
            "print_settings_id",
            "layer_height",
            "initial_layer_print_height",
        ] {
            require_imported_scalar(&project.settings, key)?;
        }
        for key in ["layer_height", "initial_layer_print_height"] {
            if project
                .settings
                .get(key)
                .and_then(SettingValue::finite_positive)
                .is_none()
            {
                return Err(RetargetError::new(
                    IssueCode::ProfileValueInvalid,
                    format!("imported reference setting '{key}' must be positive"),
                    "Use a complete sliced-settings reference with positive layer heights.",
                )
                .with_setting(key));
            }
        }
        let slot_count = project.materials.len();
        for (key, count) in [
            ("nozzle_diameter", 4),
            ("extruder_offset", 4),
            ("max_layer_height", 4),
            ("min_layer_height", 4),
            ("filament_settings_id", slot_count),
            ("filament_type", slot_count),
        ] {
            require_imported_list(&project.settings, key, count)?;
        }
        for key in [
            "deretraction_speed",
            "long_retractions_when_cut",
            "retract_before_wipe",
            "retract_length_toolchange",
            "retract_lift_above",
            "retract_lift_below",
            "retract_lift_enforce",
            "retract_restart_extra",
            "retract_restart_extra_toolchange",
            "retract_when_changing_layer",
            "retraction_distances_when_cut",
            "retraction_length",
            "retraction_minimum_travel",
            "retraction_speed",
            "travel_slope",
            "wipe",
            "wipe_distance",
            "z_hop",
            "z_hop_types",
            "z_hop_when_prime",
        ] {
            require_imported_list_shape(&project.settings, key, 4)?;
        }
        for key in [
            "printable_height",
            "nozzle_diameter",
            "machine_max_speed_x",
            "machine_max_speed_y",
            "machine_max_speed_z",
            "machine_max_speed_e",
            "machine_max_acceleration_extruding",
            "machine_max_acceleration_retracting",
            "machine_max_acceleration_travel",
            "machine_max_acceleration_x",
            "machine_max_acceleration_y",
            "machine_max_acceleration_z",
            "machine_max_acceleration_e",
            "machine_max_jerk_x",
            "machine_max_jerk_y",
            "machine_max_jerk_z",
            "machine_max_jerk_e",
            "max_layer_height",
            "min_layer_height",
        ] {
            require_imported_numeric_values(&project.settings, key, false)?;
        }
        for key in ["machine_min_extruding_rate", "machine_min_travel_rate"] {
            require_imported_numeric_values(&project.settings, key, true)?;
        }
        require_imported_bed_polygon(&project.settings)?;
        for key in [
            "filament_vendor",
            "filament_diameter",
            "filament_density",
            "filament_max_volumetric_speed",
            "nozzle_temperature",
            "nozzle_temperature_initial_layer",
            "hot_plate_temp",
            "hot_plate_temp_initial_layer",
        ] {
            require_imported_list(&project.settings, key, slot_count)?;
        }
        for key in ["filament_start_gcode", "filament_end_gcode"] {
            require_imported_list_shape(&project.settings, key, slot_count)?;
        }
        for key in [
            "filament_diameter",
            "filament_density",
            "filament_max_volumetric_speed",
            "nozzle_temperature",
            "nozzle_temperature_initial_layer",
            "hot_plate_temp",
            "hot_plate_temp_initial_layer",
        ] {
            require_imported_numeric_values(&project.settings, key, false)?;
        }
        for (key, value) in &project.settings {
            if let SettingValue::List(values) = value {
                if values.len() == slot_count
                    && !self.is_filament_setting_key(key)
                    && !is_imported_shared_array_key(key)
                {
                    return Err(RetargetError::new(
                        IssueCode::ProfileValueInvalid,
                        format!(
                            "imported reference array '{key}' is ambiguous across {slot_count} filament slots"
                        ),
                        "Remove imported-only slot arrays or use a normalized supported U1 reference.",
                    )
                    .with_setting(key));
                }
            }
        }
        let filament_names = project
            .settings
            .get("filament_settings_id")
            .map(SettingValue::as_list)
            .unwrap_or_default()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        if filament_names.len() != project.materials.len() {
            return Err(RetargetError::new(
                IssueCode::IncompleteProject,
                "imported reference filament identities do not match its material slots",
                "Re-export a flattened editable U1 project.",
            ));
        }
        let mut filaments = Vec::with_capacity(project.materials.len());
        let mut material_types = HashSet::new();
        for (slot, (name, material)) in filament_names
            .iter()
            .zip(project.materials.iter())
            .enumerate()
        {
            if name.trim().is_empty() || material.trim().is_empty() {
                return Err(RetargetError::new(
                    IssueCode::IncompleteProject,
                    "imported reference contains an empty filament identity",
                    "Assign one complete U1 filament profile per reference slot.",
                ));
            }
            let canonical_material = material_root_name(material).ok_or_else(|| {
                RetargetError::new(
                    IssueCode::UnsupportedMaterial,
                    format!("imported reference material '{material}' is unsupported"),
                    "Use a supported Snapmaker U1 filament material.",
                )
                .with_setting("filament_type")
            })?;
            if !material_types.insert(canonical_material) {
                return Err(RetargetError::new(
                    IssueCode::ProfileValueInvalid,
                    format!(
                        "imported reference has ambiguous duplicate material type '{material}'"
                    ),
                    "Use one imported filament profile per material type.",
                )
                .with_setting("filament_type"));
            }
            let mut settings = BTreeMap::new();
            for (key, value) in &project.settings {
                if !self.is_filament_setting_key(key) {
                    continue;
                }
                if let SettingValue::List(values) = value {
                    if values.len() == project.materials.len() {
                        settings.insert(key.clone(), SettingValue::Scalar(values[slot].clone()));
                    }
                }
            }
            settings.insert(
                "filament_settings_id".to_string(),
                SettingValue::Scalar(name.clone()),
            );
            settings.insert(
                "filament_type".to_string(),
                SettingValue::Scalar(material.clone()),
            );
            filaments.push(ResolvedProfile {
                name: name.clone(),
                path: path.display().to_string(),
                sha256: sha256_before.clone(),
                settings,
            });
        }
        let shared_settings = project
            .settings
            .iter()
            .filter(|(key, _)| !self.is_filament_setting_key(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        let process_name = project
            .settings
            .get("print_settings_id")
            .and_then(SettingValue::first)
            .unwrap_or_default()
            .to_string();
        let machine = ResolvedProfile {
            name: machine_name.to_string(),
            path: path.display().to_string(),
            sha256: sha256_before.clone(),
            settings: shared_settings.clone(),
        };
        let process = ResolvedProfile {
            name: process_name.clone(),
            path: path.display().to_string(),
            sha256: sha256_before.clone(),
            settings: shared_settings,
        };
        guardrails::validate(&project.settings, &machine, &process)?;
        let profile_id = format!("imported:{sha256_before}");
        let details = ImportedTargetProfileDetails {
            profile_id: profile_id.clone(),
            sha256: sha256_before.clone(),
            machine_name: machine_name.to_string(),
            process_name: process_name.clone(),
            filament_names,
            layer_height: project.layer_height.unwrap_or_default(),
            setting_count: project.settings.len(),
            capabilities: ImportedTargetCapabilities {
                nozzle_count: project
                    .settings
                    .get("nozzle_diameter")
                    .map(|value| value.as_list().len())
                    .unwrap_or_default(),
                max_filament_slots: project.materials.len(),
                object_exclusion: project.settings.contains_key("exclude_object"),
                motion_guardrails: guardrails::SPEED_KEYS
                    .iter()
                    .chain(guardrails::ACCELERATION_KEYS.iter())
                    .any(|key| project.settings.contains_key(*key)),
            },
        };
        Ok((
            ResolvedTarget {
                profile_id,
                display_name: format!("{process_name} (Imported U1)"),
                machine,
                process,
                filaments,
                filament_defaults: BTreeMap::new(),
                imported: true,
            },
            details,
        ))
    }
}

fn validate_manifest_shape(manifest: &Manifest) -> Result<(), RetargetError> {
    if manifest.schema_version != 1
        || manifest.bundle_id != BUNDLE_ID
        || manifest.upstream.commit != BUNDLE_COMMIT
        || manifest.target_printer.model != "U1"
        || manifest.target_printer.preset != MACHINE_NAME
        || manifest.target_printer.variant != "0.4"
    {
        return Err(manifest_error(
            "manifest does not identify the pinned Snapmaker U1 bundle",
        ));
    }
    if manifest.files.len() != EXPECTED_FILES
        || manifest.selected_paths.len() != EXPECTED_FILES
        || manifest.roots.len() != EXPECTED_ROOTS
    {
        return Err(manifest_error(format!(
            "bundle must contain exactly {EXPECTED_FILES} files and {EXPECTED_ROOTS} roots"
        )));
    }
    let mut file_types = HashMap::new();
    let mut root_types = HashMap::new();
    let mut root_paths = HashSet::new();
    for file in &manifest.files {
        *file_types
            .entry(file.profile_type.as_str())
            .or_insert(0usize) += 1;
        if file.role == "root" {
            *root_types
                .entry(file.profile_type.as_str())
                .or_insert(0usize) += 1;
            root_paths.insert(file.path.as_str());
        } else if file.role != "dependency" {
            return Err(manifest_error("manifest file has an invalid role"));
        }
    }
    if file_types.get("filament") != Some(&54)
        || file_types.get("machine") != Some(&4)
        || file_types.get("machine_model") != Some(&1)
        || file_types.get("process") != Some(&23)
        || root_types.get("filament") != Some(&EXPECTED_FILAMENT_ROOTS)
        || root_types.get("machine") != Some(&1)
        || root_types.get("machine_model") != Some(&1)
        || root_types.get("process") != Some(&EXPECTED_PROCESS_ROOTS)
    {
        return Err(manifest_error("manifest profile type counts are invalid"));
    }
    if manifest.roots.iter().collect::<HashSet<_>>().len() != EXPECTED_ROOTS
        || manifest
            .roots
            .iter()
            .any(|root| !root_paths.contains(root.as_str()))
    {
        return Err(manifest_error("manifest roots are invalid or duplicated"));
    }
    let file_paths: HashSet<_> = manifest
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    if manifest
        .selected_paths
        .iter()
        .any(|path| !file_paths.contains(format!("profiles/{path}").as_str()))
    {
        return Err(manifest_error(
            "selectedPaths does not match the verified profile files",
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), RetargetError> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') {
        return Err(manifest_error(format!("unsafe manifest path '{path}'")));
    }
    let parsed = Path::new(path);
    if parsed.is_absolute()
        || parsed
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(manifest_error(format!("unsafe manifest path '{path}'")));
    }
    Ok(())
}

fn parse_profile(
    bytes: &[u8],
    authenticated_type: Option<ProfileType>,
) -> Result<Profile, RetargetError> {
    let object: Map<String, Value> = serde_json::from_slice::<Value>(bytes)
        .map_err(|error| profile_value_error(format!("invalid profile JSON: {error}")))?
        .as_object()
        .cloned()
        .ok_or_else(|| profile_value_error("profile must be a JSON object"))?;
    let profile_type = match object.get("type") {
        Some(Value::String(value)) => ProfileType::parse(value)
            .ok_or_else(|| profile_value_error("profile has an invalid type"))?,
        None => {
            authenticated_type.ok_or_else(|| profile_value_error("profile has an invalid type"))?
        }
        Some(_) => return Err(profile_value_error("profile has an invalid type")),
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| profile_value_error("profile has an empty name"))?
        .to_string();
    let inherits = match object.get("inherits") {
        Some(Value::String(parent)) if !parent.trim().is_empty() => Some(parent.clone()),
        Some(_) => return Err(profile_value_error("inherits must be a non-empty string")),
        None => None,
    };
    let mut settings = BTreeMap::new();
    for (key, value) in object {
        if is_metadata_key(&key) {
            continue;
        }
        let value = match value {
            Value::String(value) => SettingValue::Scalar(value),
            Value::Array(values) => {
                let values = values
                    .into_iter()
                    .map(|value| match value {
                        Value::String(value) => Ok(value),
                        _ => Err(profile_value_error(
                            "profile arrays may contain strings only",
                        )),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                SettingValue::List(values)
            }
            _ => {
                return Err(profile_value_error(format!(
                    "setting '{key}' is not a string or string array"
                )))
            }
        };
        if key == "compatible_printers" && !matches!(value, SettingValue::List(_)) {
            return Err(profile_value_error(
                "compatible_printers must be a string array",
            ));
        }
        settings.insert(key, value);
    }
    Ok(Profile {
        profile_type,
        name,
        inherits,
        settings,
    })
}

pub(crate) fn is_metadata_key(key: &str) -> bool {
    matches!(
        key,
        "type" | "name" | "inherits" | "from" | "instantiation" | "setting_id" | "version"
    )
}

pub(crate) fn is_filament_identity_key(key: &str) -> bool {
    matches!(
        key,
        "filament_colour"
            | "default_filament_colour"
            | "filament_settings_id"
            | "filament_type"
            | "filament_vendor"
    )
}

pub(crate) fn is_filament_profile_setting(key: &str, profile: &ResolvedProfile) -> bool {
    !matches!(
        key,
        "compatible_printers"
            | "compatible_printers_condition"
            | "compatible_prints"
            | "compatible_prints_condition"
            | "is_custom_defined"
    ) && profile.settings.contains_key(key)
}

pub(crate) fn safe_filament_default(key: &str) -> Option<&'static str> {
    match key {
        "additional_cooling_fan_speed" => Some("0"),
        _ => None,
    }
}

fn is_imported_shared_array_key(key: &str) -> bool {
    super::transform::MACHINE_OWNED_KEYS.contains(&key)
        || super::transform::PROCESS_OWNED_KEYS.contains(&key)
        || matches!(
            key,
            "compatible_prints"
                | "extruder_colour"
                | "flush_volumes_matrix"
                | "flush_volumes_vector"
        )
}

fn require_imported_scalar<'a>(
    settings: &'a BTreeMap<String, SettingValue>,
    key: &str,
) -> Result<&'a str, RetargetError> {
    let Some(SettingValue::Scalar(value)) = settings.get(key) else {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must be a scalar"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    };
    if value.trim().is_empty() {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must not be empty"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    }

    Ok(value)
}

fn require_imported_setting_shape(
    settings: &BTreeMap<String, SettingValue>,
    key: &str,
    expected: &SettingValue,
) -> Result<(), RetargetError> {
    let valid = match (settings.get(key), expected) {
        (Some(SettingValue::Scalar(_)), SettingValue::Scalar(_)) => true,
        (Some(SettingValue::List(actual)), SettingValue::List(expected)) => {
            actual.len() == expected.len()
        }
        _ => false,
    };
    if !valid {
        let expected_shape = match expected {
            SettingValue::Scalar(_) => "a scalar".to_string(),
            SettingValue::List(values) => format!("an array of {} values", values.len()),
        };
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must be {expected_shape}"),
            "Use setting shapes from a complete official Snapmaker U1 reference.",
        )
        .with_setting(key));
    }
    Ok(())
}

fn require_imported_scalar_exact<'a>(
    settings: &'a BTreeMap<String, SettingValue>,
    key: &str,
    expected: &str,
) -> Result<&'a str, RetargetError> {
    let value = require_imported_scalar(settings, key)?;
    if value != expected {
        return Err(RetargetError::new(
            IssueCode::ProfileTypeMismatch,
            format!("imported reference setting '{key}' is not exactly '{expected}'"),
            "Use a complete Snapmaker U1 0.4 nozzle reference project.",
        )
        .with_setting(key));
    }
    Ok(value)
}

fn require_imported_list(
    settings: &BTreeMap<String, SettingValue>,
    key: &str,
    expected_len: usize,
) -> Result<(), RetargetError> {
    let Some(SettingValue::List(values)) = settings.get(key) else {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must be an array"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    };
    if values.len() != expected_len || values.iter().any(|value| value.trim().is_empty()) {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!(
                "imported reference setting '{key}' must contain {expected_len} non-empty values"
            ),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    }
    Ok(())
}

fn require_imported_list_shape(
    settings: &BTreeMap<String, SettingValue>,
    key: &str,
    expected_len: usize,
) -> Result<(), RetargetError> {
    let Some(SettingValue::List(values)) = settings.get(key) else {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must be an array"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    };
    if values.len() != expected_len {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' must contain {expected_len} values"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    }
    Ok(())
}

fn require_imported_numeric_values(
    settings: &BTreeMap<String, SettingValue>,
    key: &str,
    allow_zero: bool,
) -> Result<(), RetargetError> {
    let Some(value) = settings.get(key) else {
        return Err(RetargetError::new(
            IssueCode::IncompleteProject,
            format!("imported reference lacks numeric setting '{key}'"),
            "Use a complete flattened Snapmaker U1 reference project.",
        )
        .with_setting(key));
    };
    if value.as_list().iter().any(|value| {
        value.trim().parse::<f64>().map_or(true, |value| {
            !value.is_finite()
                || if allow_zero {
                    value < 0.0
                } else {
                    value <= 0.0
                }
        })
    }) {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            format!("imported reference setting '{key}' contains an invalid numeric value"),
            "Use finite target limits and dimensions from a complete U1 reference.",
        )
        .with_setting(key));
    }
    Ok(())
}

fn require_imported_bed_polygon(
    settings: &BTreeMap<String, SettingValue>,
) -> Result<(), RetargetError> {
    let key = "printable_area";
    let Some(SettingValue::List(points)) = settings.get(key) else {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            "imported reference printable_area must be a polygon array",
            "Use a complete Snapmaker U1 reference with printable bed geometry.",
        )
        .with_setting(key));
    };
    let valid = points.len() >= 3
        && points.iter().all(|point| {
            let Some((x, y)) = point.split_once('x') else {
                return false;
            };
            [x, y].iter().all(|value| {
                value
                    .trim()
                    .parse::<f64>()
                    .is_ok_and(|value| value.is_finite())
            })
        });
    if !valid {
        return Err(RetargetError::new(
            IssueCode::ProfileValueInvalid,
            "imported reference printable_area contains invalid bed coordinates",
            "Use a complete Snapmaker U1 reference with finite printable bed geometry.",
        )
        .with_setting(key));
    }
    Ok(())
}

fn validate_inheritance(profiles: &HashMap<String, Profile>) -> Result<(), RetargetError> {
    for profile in profiles.values() {
        if let Some(parent_name) = &profile.inherits {
            let parent = profiles.get(parent_name).ok_or_else(|| {
                RetargetError::new(
                    IssueCode::ProfileMissingParent,
                    format!(
                        "profile '{}' inherits missing parent '{}'",
                        profile.name, parent_name
                    ),
                    "Restore the complete pinned profile bundle.",
                )
            })?;
            if parent.profile_type != profile.profile_type {
                return Err(RetargetError::new(
                    IssueCode::ProfileTypeMismatch,
                    format!(
                        "profile '{}' inherits parent '{}' of another type",
                        profile.name, parent.name
                    ),
                    "Restore the pinned profile bundle.",
                ));
            }
        }
    }
    Ok(())
}

fn resolve_profile(
    name: &str,
    profiles: &HashMap<String, Profile>,
    resolved: &mut HashMap<String, BTreeMap<String, SettingValue>>,
    chain: &mut Vec<String>,
) -> Result<BTreeMap<String, SettingValue>, RetargetError> {
    if let Some(settings) = resolved.get(name) {
        return Ok(settings.clone());
    }
    if let Some(index) = chain.iter().position(|item| item == name) {
        let mut cycle = chain[index..].to_vec();
        cycle.push(name.to_string());
        return Err(RetargetError::new(
            IssueCode::ProfileInheritanceCycle,
            format!("profile inheritance cycle: {}", cycle.join(" -> ")),
            "Restore a bundle with acyclic inheritance.",
        ));
    }
    if chain.len() >= EXPECTED_FILES {
        return Err(RetargetError::new(
            IssueCode::ProfileInheritanceCycle,
            format!("profile inheritance exceeds {EXPECTED_FILES} levels"),
            "Restore a bundle with acyclic inheritance.",
        ));
    }
    let profile = profiles
        .get(name)
        .ok_or_else(|| manifest_error("profile index is inconsistent"))?;
    chain.push(name.to_string());
    let mut settings = if let Some(parent) = &profile.inherits {
        resolve_profile(parent, profiles, resolved, chain)?
    } else {
        BTreeMap::new()
    };
    settings.extend(profile.settings.clone());
    chain.pop();
    resolved.insert(name.to_string(), settings.clone());
    Ok(settings)
}

fn resolved_for_path(
    path: &str,
    files: &HashMap<String, ManifestFile>,
    resolved: &HashMap<String, BTreeMap<String, SettingValue>>,
) -> Result<ResolvedProfile, RetargetError> {
    let file = files
        .get(path)
        .ok_or_else(|| manifest_error(format!("missing manifest entry '{path}'")))?;
    Ok(ResolvedProfile {
        name: file.name.clone(),
        path: path.to_string(),
        sha256: file.sha256.clone(),
        settings: resolved
            .get(&file.name)
            .cloned()
            .ok_or_else(|| manifest_error("resolved profile index is inconsistent"))?,
    })
}

fn validate_compatibility(
    processes: &BTreeMap<String, ResolvedProfile>,
    filaments: &[ResolvedProfile],
) -> Result<(), RetargetError> {
    for profile in processes.values().chain(filaments.iter()) {
        let compatible = profile
            .settings
            .get("compatible_printers")
            .map(SettingValue::as_list)
            .unwrap_or_default();
        if !compatible.contains(&MACHINE_NAME) {
            return Err(RetargetError::new(
                IssueCode::ProfileTypeMismatch,
                format!("root profile '{}' is not compatible with U1", profile.name),
                "Restore the pinned U1 profile bundle.",
            ));
        }
    }
    Ok(())
}

fn stable_id(path: &str) -> String {
    format!("{BUNDLE_ID}:{path}")
}

fn category(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    for (token, category) in [
        ("benchy", "benchy"),
        ("support", "support"),
        ("strength", "strength"),
        ("quality", "quality"),
        ("draft", "draft"),
        ("fine", "fine"),
    ] {
        if lower.contains(token) {
            return category;
        }
    }
    "generic"
}

fn summary(
    id: &str,
    profile: &ResolvedProfile,
    commit: &str,
) -> Result<TargetProfileSummary, RetargetError> {
    let layer_height = profile
        .settings
        .get("layer_height")
        .and_then(SettingValue::finite_positive)
        .ok_or_else(|| profile_value_error(format!("'{}' has no layer_height", profile.name)))?;
    Ok(TargetProfileSummary {
        profile_id: id.to_string(),
        display_name: profile.name.clone(),
        root_path: profile.path.clone(),
        layer_height,
        category: category(&profile.name).to_string(),
        bundle_commit: commit.to_string(),
    })
}

fn filament_summary(profile: &ResolvedProfile) -> Result<FilamentProfileSummary, RetargetError> {
    let material_type = profile
        .settings
        .get("filament_type")
        .and_then(SettingValue::first)
        .ok_or_else(|| {
            profile_value_error(format!("filament '{}' has no filament_type", profile.name))
        })?
        .to_string();
    Ok(FilamentProfileSummary {
        name: profile.name.clone(),
        root_path: profile.path.clone(),
        sha256: profile.sha256.clone(),
        material_type,
    })
}

fn map_bundled_materials<'a>(
    filaments: &'a [ResolvedProfile],
    defaults: &BTreeMap<String, SettingValue>,
    materials: &[String],
) -> Result<Vec<&'a ResolvedProfile>, RetargetError> {
    let mapped = materials
        .iter()
        .map(|material| {
            let expected = material_root_name(material).ok_or_else(|| {
                RetargetError::new(
                    IssueCode::UnsupportedMaterial,
                    format!("material '{material}' has no verified Snapmaker U1 mapping"),
                    "Choose a supported material profile or change the source material.",
                )
            })?;
            filaments
                .iter()
                .find(|profile| profile.name == expected)
                .ok_or_else(|| {
                    manifest_error(format!(
                        "verified material root '{expected}' is absent from the bundle"
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_material_defaults(&mapped, defaults)?;
    Ok(mapped)
}

fn validate_material_defaults(
    mapped: &[&ResolvedProfile],
    defaults: &BTreeMap<String, SettingValue>,
) -> Result<(), RetargetError> {
    let keys: HashSet<_> = mapped
        .iter()
        .flat_map(|profile| {
            profile
                .settings
                .keys()
                .filter(|key| is_filament_profile_setting(key, profile))
        })
        .collect();
    for key in keys {
        for profile in mapped {
            if !profile.settings.contains_key(key)
                && !defaults.contains_key(key)
                && safe_filament_default(key).is_none()
            {
                return Err(RetargetError::new(
                    IssueCode::ProfileValueInvalid,
                    format!(
                        "filament combination has no verified default for '{key}' in '{}'",
                        profile.name
                    ),
                    "Choose a filament combination with complete compatible settings.",
                )
                .with_setting(key));
            }
        }
    }
    Ok(())
}

fn normalize_material(material: &str) -> String {
    material
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn material_root_name(material: &str) -> Option<&'static str> {
    let normalized = normalize_material(material);
    match normalized.as_str() {
        "pla" | "polylacticacid" => Some("Snapmaker PLA @U1"),
        "placf" | "carbonfiberpla" => Some("Snapmaker PLA-CF @U1"),
        "petg" => Some("Snapmaker PETG @U1"),
        "petgcf" | "carbonfiberpetg" => Some("Snapmaker PETG-CF @U1"),
        "pet" => Some("Snapmaker PET @U1"),
        "abs" => Some("Snapmaker ABS @U1"),
        "asa" => Some("Snapmaker ASA @U1"),
        "pacf" | "nyloncf" | "carbonfiberpa" => Some("Snapmaker PA-CF @U1"),
        "tpu" => Some("Snapmaker TPU @U1"),
        "tpu95a" | "tpu95" => Some("Snapmaker TPU 95A @U1"),
        "tpuhighflow" | "hightflowtpu" => Some("Snapmaker TPU High-Flow @U1"),
        "tpe" => Some("Snapmaker TPE @U1"),
        "pva" => Some("Snapmaker PVA @U1"),
        "breakawaysupport" | "breakawaysupportforpla" => {
            Some("Snapmaker Breakaway Support For PLA @U1")
        }
        _ => None,
    }
}

fn manifest_error(message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::ProfileManifestInvalid,
        message,
        "Restore the exact pinned Snapmaker U1 profile bundle.",
    )
}

fn profile_value_error(message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::ProfileValueInvalid,
        message,
        "Restore profiles containing only Orca string and string-array settings.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_aliases_are_specific() {
        assert_eq!(material_root_name("PLA-CF"), Some("Snapmaker PLA-CF @U1"));
        assert_eq!(material_root_name("TPU 95A"), Some("Snapmaker TPU 95A @U1"));
        assert_eq!(
            material_root_name("Breakaway Support"),
            Some("Snapmaker Breakaway Support For PLA @U1")
        );
        assert_eq!(material_root_name("mystery"), None);
    }

    #[test]
    fn profile_values_reject_non_strings() {
        let error = parse_profile(
            br#"{"type":"process","name":"bad","layer_height":0.2}"#,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    }

    #[test]
    fn setting_value_parses_finite_positive() {
        assert_eq!(
            SettingValue::Scalar("0.2".into()).finite_positive(),
            Some(0.2)
        );
        assert_eq!(SettingValue::Scalar("NaN".into()).finite_positive(), None);
    }

    fn test_profile(name: &str, parent: Option<&str>, profile_type: ProfileType) -> Profile {
        Profile {
            profile_type,
            name: name.to_string(),
            inherits: parent.map(str::to_string),
            settings: BTreeMap::from([(name.to_string(), SettingValue::Scalar(name.to_string()))]),
        }
    }

    #[test]
    fn inheritance_merges_parent_then_child() {
        let profiles = HashMap::from([
            (
                "base".to_string(),
                test_profile("base", None, ProfileType::Process),
            ),
            (
                "child".to_string(),
                test_profile("child", Some("base"), ProfileType::Process),
            ),
        ]);
        validate_inheritance(&profiles).unwrap();
        let resolved =
            resolve_profile("child", &profiles, &mut HashMap::new(), &mut Vec::new()).unwrap();
        assert!(resolved.contains_key("base"));
        assert!(resolved.contains_key("child"));
    }

    #[test]
    fn inheritance_rejects_missing_parent_wrong_type_and_cycle() {
        let missing = HashMap::from([(
            "child".to_string(),
            test_profile("child", Some("missing"), ProfileType::Process),
        )]);
        assert_eq!(
            validate_inheritance(&missing).unwrap_err().code,
            IssueCode::ProfileMissingParent
        );

        let wrong_type = HashMap::from([
            (
                "machine".to_string(),
                test_profile("machine", None, ProfileType::Machine),
            ),
            (
                "child".to_string(),
                test_profile("child", Some("machine"), ProfileType::Process),
            ),
        ]);
        assert_eq!(
            validate_inheritance(&wrong_type).unwrap_err().code,
            IssueCode::ProfileTypeMismatch
        );

        let cycle = HashMap::from([
            (
                "one".to_string(),
                test_profile("one", Some("two"), ProfileType::Process),
            ),
            (
                "two".to_string(),
                test_profile("two", Some("one"), ProfileType::Process),
            ),
        ]);
        validate_inheritance(&cycle).unwrap();
        assert_eq!(
            resolve_profile("one", &cycle, &mut HashMap::new(), &mut Vec::new())
                .unwrap_err()
                .code,
            IssueCode::ProfileInheritanceCycle
        );
    }
}
