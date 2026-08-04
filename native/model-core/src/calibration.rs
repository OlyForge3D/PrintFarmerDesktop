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
    pub kind: String,
    pub entity_id: String,
    pub operation_id: Option<String>,
    pub local_payload: Option<Value>,
    pub server_payload: Option<Value>,
    pub server_revision: i64,
    pub created_at: String,
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

/// Parameters for `resolveCalibrationConflict`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCalibrationConflictParams {
    pub profile_id: String,
    pub conflict_id: String,
    /// A `CalibrationConflictResolutionKind` name. Carried as a string so an
    /// unrecognised value reaches the store and is refused there by name,
    /// rather than being rejected as a malformed params object — the two mean
    /// different things to whoever reads the error.
    pub resolution: String,
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
