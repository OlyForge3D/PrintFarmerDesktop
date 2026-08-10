//! Calibration-specific sidecar data-transfer objects (issue #52).
//!
//! These types describe the wire shape for calibration persistence operations
//! spoken over the sidecar RPC. They are deliberately separate from the sync
//! types so calibration schema evolution does not require touching library sync.
//!
//! Security contract:
//! - No server URLs, JWT tokens, API keys, or password material is stored.
//! - Profile identities are opaque Electron-owned UUIDs.
//! - Client-generated UUIDs are used for project/step/attempt IDs.
//! - Server-assigned remote IDs are cached projections only.
//! - PrintFarmer is authoritative for completed attempts, profile revisions,
//!   and uploaded photos.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sync::{CalibrationConflictKind, CalibrationConflictResolutionKind};

/// Exact local calibration workspace state returned by save/list/get RPCs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationWorkspaceStateDto {
    pub profile_id: String,
    pub project_id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub printer_id: String,
    pub status: String,
    pub completed_step_count: i64,
    pub total_step_count: i64,
    pub is_synced: bool,
    pub is_printer_context_fresh: bool,
    pub has_conflicts: bool,
    pub remote_project_id: Option<String>,
    pub base_revision: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub workspace_state: Value,
}

/// Parameters for `saveCalibrationWorkspaceState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCalibrationWorkspaceStateParams {
    pub profile_id: String,
    pub project_id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub printer_id: String,
    pub status: String,
    pub completed_step_count: i64,
    pub total_step_count: i64,
    /// Authoritative freshness decision made by Electron main after comparing
    /// the current PrintFarmer context with the persisted binding.
    pub printer_context_fresh: bool,
    pub base_revision: Option<i64>,
    pub operation_id: String,
    pub idempotency_key: String,
    pub workspace_state: Value,
    pub created_at: String,
    pub updated_at: String,
}

impl SaveCalibrationWorkspaceStateParams {
    pub(crate) fn unsynced_dto(&self) -> CalibrationWorkspaceStateDto {
        CalibrationWorkspaceStateDto {
            profile_id: self.profile_id.clone(),
            project_id: self.project_id.clone(),
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            printer_id: self.printer_id.clone(),
            status: self.status.clone(),
            completed_step_count: self.completed_step_count,
            total_step_count: self.total_step_count,
            is_synced: false,
            is_printer_context_fresh: self.printer_context_fresh,
            has_conflicts: false,
            remote_project_id: None,
            base_revision: self.base_revision,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            workspace_state: self.workspace_state.clone(),
        }
    }
}

/// A remote project summary that has no exact calibration workspace payload.
/// It remains visible and recoverable without inventing local observations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationUnhydratedProjectDto {
    pub profile_id: String,
    pub project_id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub printer_id: String,
    pub status: String,
    pub is_synced: bool,
    pub is_printer_context_fresh: bool,
    pub has_conflicts: bool,
    pub remote_project_id: String,
    pub base_revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub recovery_state: String,
}

/// Parameters for `listCalibrationWorkspaceStates`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCalibrationWorkspaceStatesParams {
    pub profile_id: String,
}

/// Parameters for `getCalibrationWorkspaceState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCalibrationWorkspaceStateParams {
    pub profile_id: String,
    pub project_id: String,
}

/// Exact stage identity shared by calibration workspace and photo records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalibrationWorkspaceStageId {
    Temperature,
    FlowPass1,
    FlowPass2,
    PressureAdvance,
    FlowVerification,
    Retraction,
    MaximumVolumetricSpeed,
    Shrinkage,
    FinalVerification,
}

impl CalibrationWorkspaceStageId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Temperature => "temperature",
            Self::FlowPass1 => "flowPass1",
            Self::FlowPass2 => "flowPass2",
            Self::PressureAdvance => "pressureAdvance",
            Self::FlowVerification => "flowVerification",
            Self::Retraction => "retraction",
            Self::MaximumVolumetricSpeed => "maximumVolumetricSpeed",
            Self::Shrinkage => "shrinkage",
            Self::FinalVerification => "finalVerification",
        }
    }
}

impl TryFrom<&str> for CalibrationWorkspaceStageId {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "temperature" => Ok(Self::Temperature),
            "flowPass1" => Ok(Self::FlowPass1),
            "flowPass2" => Ok(Self::FlowPass2),
            "pressureAdvance" => Ok(Self::PressureAdvance),
            "flowVerification" => Ok(Self::FlowVerification),
            "retraction" => Ok(Self::Retraction),
            "maximumVolumetricSpeed" => Ok(Self::MaximumVolumetricSpeed),
            "shrinkage" => Ok(Self::Shrinkage),
            "finalVerification" => Ok(Self::FinalVerification),
            _ => Err(format!("invalid calibration workspace stageId: {value}")),
        }
    }
}

/// Renderer-safe metadata for a calibration photo staged by Electron main.
/// `local_path` is intentionally present only on the write parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedCalibrationPhotoDto {
    pub photo_id: String,
    pub attempt_id: String,
    pub stage_id: CalibrationWorkspaceStageId,
    pub project_id: String,
    pub profile_id: String,
    pub content_hash: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub status: String,
    pub upload_attempts: i64,
    pub remote_photo_id: Option<String>,
    pub remote_url: Option<String>,
    pub staged_at: String,
    pub uploaded_at: Option<String>,
    pub caption: String,
    pub order: i64,
}

/// Parameters for the dedicated `stageCalibrationPhoto` persistence RPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCalibrationPhotoParams {
    pub photo_id: String,
    pub attempt_id: String,
    pub stage_id: CalibrationWorkspaceStageId,
    pub project_id: String,
    pub profile_id: String,
    pub content_hash: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub local_path: String,
    pub staged_at: String,
    pub caption: String,
    pub order: i64,
}

/// A single pending calibration outbox operation ready to push.
/// Loaded by `listCalibrationPendingOperations` in sequence order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPendingOpDto {
    pub operation_id: String,
    pub profile_id: String,
    pub project_id: String,
    pub kind: String,
    pub sequence: i64,
    pub base_revision: Option<i64>,
    pub idempotency_key: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_kind: String,
    pub payload: Value,
    /// IDs of operations this one depends on (must be settled first).
    pub depends_on: Vec<String>,
}

/// Cursor/checkpoint state for a profile+project pair.
/// Returned by `getCalibrationCursorState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationCursorStateDto {
    pub cursor: Option<String>,
    pub server_revision: i64,
    pub checkpoint_generation: i64,
}

/// An unresolved calibration conflict record.
/// Returned by `listCalibrationConflicts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationConflictDto {
    pub conflict_id: String,
    pub profile_id: String,
    pub project_id: String,
    /// The entity type of the conflicted row (e.g. `CalibrationProject`).
    ///
    /// Renamed from `kind` (issue #365): this column never held a conflict
    /// kind, and naming it `kind` invited the renderer to parse it against
    /// the six-value `CalibrationConflictKind` enum, which no entity type is
    /// ever a member of.
    pub entity_type: String,
    pub entity_id: String,
    pub operation_id: Option<String>,
    pub local_payload: Option<Value>,
    pub server_payload: Option<Value>,
    pub server_revision: i64,
    pub created_at: String,
    /// The ratified conflict kind, when the conflict has been classified.
    ///
    /// This is the column the IPC contract must read for `kind` (issue #365).
    /// `None` means unclassified, not "guess from `entity_type`" -- a caller
    /// that guesses reintroduces the defect this field exists to end.
    pub conflict_kind: Option<CalibrationConflictKind>,
    /// The resolutions permitted for `conflict_kind`, per
    /// `CalibrationConflictKind::available_resolutions` -- the same function
    /// `resolve_calibration_conflict` enforces against (issue #304).
    ///
    /// Carried on the wire rather than re-derived on the TypeScript side: the
    /// desktop adapter used to hold its own copy of this table
    /// (`conflictResolutionsFor` in `calibrationService.ts`), which agreed
    /// with this one only because both authors were careful. Populating this
    /// field from `available_resolutions()` and nothing else makes the store
    /// the only place the policy is written down; the adapter now reads this
    /// field instead of transcribing it. Empty when `conflict_kind` is `None`
    /// -- an unclassified conflict has no ratified policy to report, and the
    /// store already refuses to resolve it.
    pub available_resolutions: Vec<CalibrationConflictResolutionKind>,
}

/// Parameters for `settleCalibrationOperation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleCalibrationOpParams {
    pub profile_id: String,
    pub operation_id: String,
    pub server_revision: i64,
}

/// Parameters for `replayCalibrationOperation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCalibrationOpParams {
    pub profile_id: String,
    pub operation_id: String,
}

/// Parameters for `recordCalibrationConflict`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCalibrationConflictParams {
    pub profile_id: String,
    pub operation_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub reason: String,
    pub server_revision: i64,
    /// The ratified conflict kind, when the recorder knows it.
    ///
    /// Optional so existing recorders keep working, but a conflict recorded
    /// without it cannot be resolved: the resolution policy is kind-specific and
    /// the store will not infer a kind from `entity_type` (issue #219).
    #[serde(default)]
    pub conflict_kind: Option<CalibrationConflictKind>,
}

/// Named failure codes for `resolveCalibrationConflict`.
///
/// The store returns `"<CODE>: <explanation>"`. A code is not decoration: a
/// rejection test that matches on prose passes when a *different* rejection
/// fires, so the assertion has to name the policy it is checking.
pub mod calibration_resolution_error {
    /// No conflict with that id exists for the profile.
    pub const NOT_FOUND: &str = "CALIBRATION_CONFLICT_NOT_FOUND";
    /// The conflict record does not name a ratified conflict kind.
    pub const UNCLASSIFIED: &str = "CALIBRATION_CONFLICT_KIND_UNCLASSIFIED";
    /// The requested resolution is not permitted for this conflict kind.
    pub const NOT_PERMITTED: &str = "CALIBRATION_RESOLUTION_NOT_PERMITTED_FOR_KIND";
    /// The conflict is already resolved with a different resolution.
    pub const ALREADY_RESOLVED: &str = "CALIBRATION_CONFLICT_ALREADY_RESOLVED";
    /// `manualFieldMerge` was requested without the fields to merge.
    pub const MERGED_FIELDS_REQUIRED: &str = "CALIBRATION_MERGED_FIELDS_REQUIRED";
}

/// Parameters for `resolveCalibrationConflict`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCalibrationConflictParams {
    pub profile_id: String,
    pub conflict_id: String,
    pub resolution: CalibrationConflictResolutionKind,
    #[serde(default)]
    pub merged_fields: Option<Value>,
}

/// An observation whose binding printer-snapshot revision is behind the
/// revision that a resolution accepted.
///
/// Reported, never invalidated: cascading would destroy measurement work whose
/// blast radius is invisible at the moment of pressing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersededObservationDto {
    pub observation_id: String,
    pub attempt_id: String,
    pub step_id: String,
    pub parameter_key: String,
    pub bound_snapshot_revision: i64,
}

/// The outcome of `resolveCalibrationConflict`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationConflictResolutionDto {
    pub conflict_id: String,
    pub profile_id: String,
    pub project_id: String,
    pub kind: CalibrationConflictKind,
    pub resolution: CalibrationConflictResolutionKind,
    pub resolved_at: String,
    /// The instant the conflict was recorded (`calibration_conflicts.created_at`),
    /// read back from the row rather than derived from `resolved_at`.
    ///
    /// Issue #525: this field used to not exist on this DTO at all, so the
    /// adapter filled the IPC contract's `createdAt` by reusing `resolvedAt` --
    /// the two are different instants (detection vs. resolution) whenever a
    /// conflict sits unresolved for any length of time. Threading the real
    /// value through here is what lets the adapter stop fabricating it.
    pub created_at: String,
    /// The revision a `keepLocalAsNewRevision` resolution created.
    pub revision_id: Option<String>,
    /// The deleted predecessor that revision descends from.
    pub supersedes_revision_id: Option<String>,
    /// Observations whose binding revision no longer matches.
    ///
    /// Deliberately **not** `skip_serializing_if`: an empty set and an absent
    /// field are different answers. "Nothing was superseded" is a measurement;
    /// "this resolution does not report supersession" is not, and a caller that
    /// cannot tell them apart will render a snapshot as clean when it is only
    /// unexamined.
    pub superseded_observations: Vec<SupersededObservationDto>,
    /// True when this call replayed an already-recorded resolution.
    pub replayed: bool,
    /// The resolutions permitted for `kind`, per
    /// `CalibrationConflictKind::available_resolutions` -- see the field of
    /// the same name on [`CalibrationConflictDto`] for why this is carried
    /// rather than re-derived on the TypeScript side (issue #304).
    pub available_resolutions: Vec<CalibrationConflictResolutionKind>,
}

/// Parameters for `getCalibrationCursorState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCalibrationCursorParams {
    pub profile_id: String,
    pub project_id: Option<String>,
}

/// Parameters for `commitCalibrationCursor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCalibrationCursorParams {
    pub profile_id: String,
    pub project_id: Option<String>,
    pub cursor: Option<String>,
    pub server_revision: i64,
    pub checkpoint_generation: i64,
}

/// Parameters for `applyCalibrationSnapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCalibrationSnapshotParams {
    pub profile_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub snapshot: Option<Value>,
    pub tombstone: bool,
    pub server_revision: i64,
}

/// Parameters for `listCalibrationPendingOperations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCalibrationPendingOpsParams {
    pub profile_id: String,
    pub project_id: Option<String>,
    pub limit: usize,
}

/// Parameters for `listCalibrationConflicts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCalibrationConflictsParams {
    pub profile_id: String,
    pub project_id: Option<String>,
}

/// Parameters for `countCalibrationPendingOperations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountCalibrationPendingOpsParams {
    pub profile_id: String,
    pub project_id: Option<String>,
}

/// Parameters for `isPrinterContextFresh`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsPrinterContextFreshParams {
    pub profile_id: String,
    pub project_id: String,
}
