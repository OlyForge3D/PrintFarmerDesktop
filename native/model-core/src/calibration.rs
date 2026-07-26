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
