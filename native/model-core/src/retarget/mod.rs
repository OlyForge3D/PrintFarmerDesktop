mod archive;
mod guardrails;
mod preflight;
mod profile;
mod project;
mod report;
mod transform;
mod validate;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use profile::{
    FilamentProfileSummary, ImportedTargetCapabilities, ImportedTargetProfileDetails,
    MachineProfileSummary, TargetProfileDetails, TargetProfileSummary,
};
pub use report::{
    BuildReport, ChangeRecord, GroupedChanges, IssueCode, IssueSeverity, PreflightReport,
    RetargetIssue, SceneCompatibility, SourceSummary, TargetRecommendation, ValidationReport,
};

use archive::ArchivePackage;
use profile::Bundle;
use project::ProjectInspection;

#[derive(Debug, Clone)]
pub struct RetargetLimits {
    pub max_source_bytes: u64,
    pub max_archive_parts: usize,
    pub max_uncompressed_bytes: u64,
    pub max_part_bytes: u64,
    pub max_project_settings_bytes: u64,
    pub max_model_settings_bytes: u64,
    pub max_manifest_bytes: u64,
    pub max_profile_bytes: u64,
    pub max_profile_total_bytes: u64,
    pub max_settings: usize,
    pub max_plates: usize,
    pub max_changes: usize,
}

impl Default for RetargetLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: 512 * 1024 * 1024,
            max_archive_parts: 100_000,
            max_uncompressed_bytes: 2 * 1024 * 1024 * 1024,
            max_part_bytes: 512 * 1024 * 1024,
            max_project_settings_bytes: 16 * 1024 * 1024,
            max_model_settings_bytes: 16 * 1024 * 1024,
            max_manifest_bytes: 16 * 1024 * 1024,
            max_profile_bytes: 4 * 1024 * 1024,
            max_profile_total_bytes: 16 * 1024 * 1024,
            max_settings: 10_000,
            max_plates: 1_000,
            max_changes: 20_000,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetargetOptions {
    #[serde(default)]
    pub object_exclusion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TargetReference {
    Bundled {
        #[serde(rename = "targetProfileId")]
        target_profile_id: String,
    },
    Imported {
        path: PathBuf,
        #[serde(rename = "expectedSha256")]
        expected_sha256: String,
    },
}

impl TargetReference {
    pub fn bundled(target_profile_id: impl Into<String>) -> Self {
        Self::Bundled {
            target_profile_id: target_profile_id.into(),
        }
    }

    pub fn imported(path: impl Into<PathBuf>, expected_sha256: impl Into<String>) -> Self {
        Self::Imported {
            path: path.into(),
            expected_sha256: expected_sha256.into(),
        }
    }
}

impl From<&str> for TargetReference {
    fn from(value: &str) -> Self {
        Self::bundled(value)
    }
}

impl From<&String> for TargetReference {
    fn from(value: &String) -> Self {
        Self::bundled(value.clone())
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct RetargetError {
    pub code: IssueCode,
    pub message: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
}

impl RetargetError {
    pub fn new(code: IssueCode, message: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            action: action.into(),
            part: None,
            setting: None,
        }
    }

    pub(crate) fn io(error: std::io::Error) -> Self {
        Self::new(
            IssueCode::Io,
            format!("I/O error: {error}"),
            "Check file paths, permissions, and available disk space.",
        )
    }

    pub(crate) fn source_io(path: &Path, error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::new(
                IssueCode::SourceNotFound,
                format!("source file does not exist: {}", path.display()),
                "Choose an existing editable 3MF project.",
            )
        } else {
            Self::io(error)
        }
    }

    pub(crate) fn target_io(path: &Path, error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::new(
                IssueCode::TargetNotFound,
                format!("imported target file does not exist: {}", path.display()),
                "Inspect an existing imported U1 reference again.",
            )
        } else {
            Self::io(error)
        }
    }

    pub(crate) fn with_setting(mut self, setting: impl Into<String>) -> Self {
        self.setting = Some(setting.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RetargetRpcOutcome<T> {
    Ok {
        value: T,
    },
    Blocked {
        blockers: Vec<RetargetIssue>,
        warnings: Vec<RetargetIssue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<T>,
    },
    Error {
        error: RetargetError,
    },
}

impl<T> RetargetRpcOutcome<T> {
    pub fn ok(value: T) -> Self {
        Self::Ok { value }
    }

    pub fn error(error: RetargetError) -> Self {
        Self::Error { error }
    }
}

#[derive(Debug)]
pub struct RetargetEngine {
    bundle: Bundle,
    limits: RetargetLimits,
}

impl RetargetEngine {
    pub fn open(
        bundle_root: impl AsRef<Path>,
        limits: RetargetLimits,
    ) -> Result<Self, RetargetError> {
        Ok(Self {
            bundle: Bundle::load(bundle_root.as_ref(), &limits)?,
            limits,
        })
    }

    pub fn list_bundled_profiles(&self) -> Result<Vec<TargetProfileSummary>, RetargetError> {
        Ok(self.bundle.list())
    }

    pub fn inspect_bundled_profile(
        &self,
        profile_id: &str,
    ) -> Result<TargetProfileDetails, RetargetError> {
        self.bundle.inspect(profile_id)
    }

    pub fn inspect_imported_profile(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<ImportedTargetProfileDetails, RetargetError> {
        self.bundle.import_reference(path.as_ref(), &self.limits)
    }

    pub fn preflight(
        &self,
        source_path: impl AsRef<Path>,
        options: RetargetOptions,
    ) -> Result<PreflightReport, RetargetError> {
        preflight::run(&self.bundle, source_path.as_ref(), &options, &self.limits)
    }

    pub fn preflight_target(
        &self,
        source_path: impl AsRef<Path>,
        target: impl Into<TargetReference>,
        options: RetargetOptions,
    ) -> Result<PreflightReport, RetargetError> {
        let source_path = source_path.as_ref();
        let target = target.into();
        validate_source_target_distinct(source_path, &target)?;
        let resolved = self.resolve_target(&target)?;
        preflight::run_target(source_path, &resolved, &options, &self.limits)
    }

    pub fn build(
        &self,
        source_path: impl AsRef<Path>,
        output_path: impl AsRef<Path>,
        target: impl Into<TargetReference>,
        options: RetargetOptions,
    ) -> Result<BuildReport, RetargetError> {
        let source_path = source_path.as_ref();
        let output_path = output_path.as_ref();
        let target = target.into();
        validate_source_target_distinct(source_path, &target)?;
        validate_output_path(source_path, output_path)?;
        let source_snapshot = ArchivePackage::read_bounded(source_path, &self.limits)?;
        let source_hash_before = crate::hash::hash_reader(source_snapshot.as_slice())
            .map_err(|error| RetargetError::source_io(source_path, error))?;
        let archive = ArchivePackage::from_bytes(&source_snapshot, &self.limits)?;
        let project = ProjectInspection::inspect_snapshot(
            source_path,
            &archive,
            &self.limits,
            &source_snapshot,
        )?;
        let resolved = self.resolve_target(&target)?;
        let preflight = preflight::report_from_target_inspection(
            source_path,
            &archive,
            &project,
            &resolved,
            &options,
            source_hash_before.clone(),
        )?;
        if let Some(blocker) = preflight.blockers.first() {
            return Err(RetargetError::new(
                blocker.code,
                blocker.message.clone(),
                blocker.action.clone(),
            ));
        }
        let filaments = resolved.map_materials(&project.materials)?;
        let transformed = transform::build_settings(
            &project,
            &resolved.machine,
            &resolved.process,
            &filaments,
            &resolved.filament_defaults,
            options.object_exclusion,
        )?;
        let change_count: usize = transformed.changes.values().map(Vec::len).sum();
        if change_count > self.limits.max_changes {
            return Err(RetargetError::new(
                IssueCode::ArchiveLimitExceeded,
                format!(
                    "retarget operation produced more than {} change records",
                    self.limits.max_changes
                ),
                "Reduce project configuration complexity.",
            ));
        }
        let stale = archive.stale_plan();
        let write = archive.write_transformed(
            output_path,
            &transformed.json,
            &transformed.model_settings,
            &stale,
        );
        let write = match write {
            Ok(write) => write,
            Err(error) => {
                if error.code != IssueCode::OutputPathConflict {
                    let _ = fs::remove_file(output_path);
                }
                return Err(error);
            }
        };
        let result = (|| {
            let source_hash_after = crate::hash::hash_file(source_path)
                .map_err(|error| RetargetError::source_io(source_path, error))?;
            if source_hash_after != source_hash_before {
                return Err(RetargetError::new(
                    IssueCode::SourceChanged,
                    "source file changed during conversion",
                    "Discard the output and retry with a stable source file.",
                ));
            }
            let output_snapshot = ArchivePackage::read_bounded(output_path, &self.limits)?;
            let validation = validate::run_snapshots(
                source_path,
                output_path,
                &source_snapshot,
                &output_snapshot,
                &resolved,
                &options,
                &self.limits,
            )?;
            if !validation.valid {
                return Err(RetargetError::new(
                    IssueCode::OutputValidationFailed,
                    "generated output failed post-build validation",
                    "Discard the output and retry.",
                ));
            }
            let mut warnings = preflight.warnings;
            warnings.extend(transformed.warnings);
            Ok(BuildReport {
                source_sha256: source_hash_before,
                output_sha256: validation.output_sha256.clone(),
                output_file_name: output_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                target_profile_id: resolved.profile_id.clone(),
                removed_part_count: write.removed_part_count,
                preserved_part_count: write.preserved_part_count,
                applied_changes: transformed.changes,
                warnings,
                validation,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(output_path);
        }
        result
    }

    pub fn validate_output(
        &self,
        source_path: impl AsRef<Path>,
        output_path: impl AsRef<Path>,
        target: impl Into<TargetReference>,
        options: RetargetOptions,
    ) -> Result<ValidationReport, RetargetError> {
        let target = target.into();
        validate_source_target_distinct(source_path.as_ref(), &target)?;
        let resolved = self.resolve_target(&target)?;
        validate::run(
            source_path.as_ref(),
            output_path.as_ref(),
            &resolved,
            &options,
            &self.limits,
        )
    }

    fn resolve_target(
        &self,
        target: &TargetReference,
    ) -> Result<profile::ResolvedTarget, RetargetError> {
        match target {
            TargetReference::Bundled { target_profile_id } => {
                self.bundle.resolve_bundled(target_profile_id)
            }
            TargetReference::Imported {
                path,
                expected_sha256,
            } => self
                .bundle
                .resolve_imported(path, Some(expected_sha256), &self.limits)
                .map(|(target, _)| target),
        }
    }
}

fn validate_source_target_distinct(
    source: &Path,
    target: &TargetReference,
) -> Result<(), RetargetError> {
    let TargetReference::Imported { path, .. } = target else {
        return Ok(());
    };
    let source = source
        .canonicalize()
        .map_err(|error| RetargetError::source_io(source, error))?;
    let target = path
        .canonicalize()
        .map_err(|error| RetargetError::target_io(path, error))?;
    if source == target || same_file_identity(&source, &target).map_err(RetargetError::io)? {
        return Err(RetargetError::new(
            IssueCode::TargetSourceConflict,
            "source project and imported target reference resolve to the same file",
            "Choose a distinct imported U1 reference project.",
        ));
    }
    Ok(())
}

fn same_file_identity(left: &Path, right: &Path) -> std::io::Result<bool> {
    same_file::is_same_file(left, right)
}

fn validate_output_path(source: &Path, output: &Path) -> Result<(), RetargetError> {
    let source = source
        .canonicalize()
        .map_err(|error| RetargetError::source_io(source, error))?;
    if output
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("3mf"))
    {
        return Err(RetargetError::new(
            IssueCode::OutputPathConflict,
            "output path must end in .3mf",
            "Choose a distinct, new .3mf temporary output path.",
        ));
    }
    if output.exists() {
        return Err(RetargetError::new(
            IssueCode::OutputPathConflict,
            "output path already exists",
            "Choose a non-existing temporary output path.",
        ));
    }
    let parent = output.parent().ok_or_else(|| {
        RetargetError::new(
            IssueCode::OutputPathConflict,
            "output path has no parent directory",
            "Choose an output under an existing directory.",
        )
    })?;
    let parent = parent.canonicalize().map_err(|error| {
        RetargetError::new(
            IssueCode::OutputPathConflict,
            format!("output parent is unavailable: {error}"),
            "Choose an output under an existing directory.",
        )
    })?;
    let name = output.file_name().ok_or_else(|| {
        RetargetError::new(
            IssueCode::OutputPathConflict,
            "output path has no file name",
            "Choose a named .3mf output file.",
        )
    })?;
    let candidate = normalize_platform_path(parent.join(name));
    if normalize_platform_path(source) == candidate {
        return Err(RetargetError::new(
            IssueCode::OutputPathConflict,
            "source and output paths resolve to the same file",
            "Choose a distinct non-existing output path.",
        ));
    }
    Ok(())
}

fn normalize_platform_path(path: PathBuf) -> String {
    let value = path.to_string_lossy().to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}
