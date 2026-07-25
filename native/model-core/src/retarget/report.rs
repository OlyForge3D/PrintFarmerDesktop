use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::rpc::SceneMeshDto;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueCode {
    SourceNotFound,
    TargetNotFound,
    OutputPathConflict,
    InvalidArchive,
    ArchiveLimitExceeded,
    UnsafeArchivePath,
    ExternalRelationship,
    MissingModel,
    EmptyBuild,
    GeometryOnly,
    PreSlicedOnly,
    UnsupportedPrusa,
    UnsupportedCura,
    UnsupportedSlicer,
    UnknownOrcaFamilyProducer,
    MissingProjectSettings,
    InvalidProjectSettings,
    MissingModelSettings,
    InvalidModelSettings,
    IncompleteProject,
    TooManyFilamentSlots,
    UnsupportedMaterial,
    UnsafeSettingValue,
    ProfileNotFound,
    ProfileManifestInvalid,
    ProfileHashMismatch,
    ProfileTypeMismatch,
    ProfileMissingParent,
    ProfileInheritanceCycle,
    ProfileValueInvalid,
    TargetSourceConflict,
    StaleSliceArtifactsRemoved,
    CustomGcodeRemoved,
    DigitalSignaturesRemoved,
    UnsupportedSourceSettingsOmitted,
    PaintMetadataPreservedUnverified,
    ProfileRecommendationAmbiguous,
    SourceSettingReplaced,
    SettingClamped,
    FilamentProfileMapped,
    SceneIncompatible,
    SourceChanged,
    OutputValidationFailed,
    Io,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueSeverity {
    Blocker,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetargetIssue {
    pub code: IssueCode,
    pub severity: IssueSeverity,
    pub title: String,
    pub message: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
}

impl RetargetIssue {
    pub(crate) fn blocker(
        code: IssueCode,
        title: impl Into<String>,
        message: impl Into<String>,
        action: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity: IssueSeverity::Blocker,
            title: title.into(),
            message: message.into(),
            action: action.into(),
            part: None,
            setting: None,
        }
    }

    pub(crate) fn warning(
        code: IssueCode,
        title: impl Into<String>,
        message: impl Into<String>,
        action: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity: IssueSeverity::Warning,
            title: title.into(),
            message: message.into(),
            action: action.into(),
            part: None,
            setting: None,
        }
    }

    pub(crate) fn with_part(mut self, part: impl Into<String>) -> Self {
        self.part = Some(part.into());
        self
    }

    pub(crate) fn with_setting(mut self, setting: impl Into<String>) -> Self {
        self.setting = Some(setting.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub file_name: String,
    pub byte_size: u64,
    pub sha256: String,
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_height: Option<f64>,
    pub object_count: usize,
    pub build_item_count: usize,
    pub plate_count: usize,
    pub materials: Vec<String>,
    pub colors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub code: IssueCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

pub type GroupedChanges = BTreeMap<String, Vec<ChangeRecord>>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedTarget {
    pub profile_id: String,
    pub display_name: String,
    pub score: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRecommendation {
    pub recommended: RankedTarget,
    pub alternatives: Vec<RankedTarget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub accepted: bool,
    pub source: SourceSummary,
    pub recommendation: Option<TargetRecommendation>,
    pub blockers: Vec<RetargetIssue>,
    pub warnings: Vec<RetargetIssue>,
    pub proposed_changes: GroupedChanges,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_scene: Option<SceneMeshDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCompatibility {
    pub compatible: bool,
    pub differences: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub source_sha256: String,
    pub output_sha256: String,
    pub source_preserved: bool,
    pub scene_compatibility: SceneCompatibility,
    pub invariants: BTreeMap<String, bool>,
    pub warnings: Vec<RetargetIssue>,
    pub errors: Vec<RetargetIssue>,
    pub before_scene: SceneMeshDto,
    pub after_scene: SceneMeshDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub source_sha256: String,
    pub output_sha256: String,
    pub output_file_name: String,
    pub target_profile_id: String,
    pub removed_part_count: usize,
    pub preserved_part_count: usize,
    pub applied_changes: GroupedChanges,
    pub warnings: Vec<RetargetIssue>,
    pub validation: ValidationReport,
}
