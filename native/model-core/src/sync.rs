//! Durable, profile-isolated library synchronization domain types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SYNC_BATCH: usize = 500;
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
pub const MAX_CURSOR_BYTES: usize = 4096;
pub const MAX_IDENTIFIER_BYTES: usize = 256;
pub const MAX_ERROR_BYTES: usize = 4096;
pub const MAX_LEASE_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SyncEntityType {
    ModelCollection,
    ModelCollectionMembership,
    Tag,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl SyncEntityType {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::ModelCollection => "ModelCollection",
            Self::ModelCollectionMembership => "ModelCollectionMembership",
            Self::Tag => "Tag",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "ModelCollection" => Ok(Self::ModelCollection),
            "ModelCollectionMembership" => Ok(Self::ModelCollectionMembership),
            "Tag" => Ok(Self::Tag),
            _ => Err(format!("invalid persisted sync entity type: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SyncOperationKind {
    Create,
    Update,
    Delete,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl SyncOperationKind {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Create => "Create",
            Self::Update => "Update",
            Self::Delete => "Delete",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "Create" => Ok(Self::Create),
            "Update" => Ok(Self::Update),
            "Delete" => Ok(Self::Delete),
            _ => Err(format!("invalid persisted sync operation: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SyncVisibility {
    Private,
    Shared,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl SyncVisibility {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Private => "Private",
            Self::Shared => "Shared",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "Private" => Ok(Self::Private),
            "Shared" => Ok(Self::Shared),
            _ => Err(format!("invalid persisted sync visibility: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteUploadStatus {
    Pending,
    Uploading,
    Uploaded,
    Failed,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl RemoteUploadStatus {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Uploading => "uploading",
            Self::Uploaded => "uploaded",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "uploading" => Ok(Self::Uploading),
            "uploaded" => Ok(Self::Uploaded),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("invalid persisted upload status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutboundState {
    Pending,
    InFlight,
    Uncertain,
    Failed,
    Acked,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl OutboundState {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InFlight => "inFlight",
            Self::Uncertain => "uncertain",
            Self::Failed => "failed",
            Self::Acked => "acked",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "inFlight" => Ok(Self::InFlight),
            "uncertain" => Ok(Self::Uncertain),
            "failed" => Ok(Self::Failed),
            "acked" => Ok(Self::Acked),
            _ => Err(format!("invalid persisted outbound state: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    KeepLocal,
    AcceptServer,
    Merge,
    Discard,
}

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
impl ConflictResolution {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::KeepLocal => "keepLocal",
            Self::AcceptServer => "acceptServer",
            Self::Merge => "merge",
            Self::Discard => "discard",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "keepLocal" => Ok(Self::KeepLocal),
            "acceptServer" => Ok(Self::AcceptServer),
            "merge" => Ok(Self::Merge),
            "discard" => Ok(Self::Discard),
            _ => Err(format!("invalid persisted conflict resolution: {value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSnapshotDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub owner_user_id: Option<String>,
    pub is_shared: bool,
    pub created_at: String,
    pub updated_at: String,
    pub member_count: u64,
    pub model_ids: Vec<String>,
    pub revision: u64,
    pub concurrency_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipSnapshotDto {
    pub id: String,
    pub collection_id: String,
    pub model_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshotDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    pub is_auto_generated: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub revision: u64,
    pub concurrency_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub profile_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    pub server_revision: u64,
    pub checkpoint_generation: u64,
    #[serde(default)]
    pub last_pulled_at: Option<i64>,
    #[serde(default)]
    pub last_pushed_at: Option<i64>,
    pub updated_at: i64,
}

impl SyncStatusDto {
    pub(crate) fn empty(profile_id: &str) -> Self {
        Self {
            profile_id: profile_id.to_string(),
            cursor: None,
            server_revision: 0,
            checkpoint_generation: 0,
            last_pulled_at: None,
            last_pushed_at: None,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelLinkDto {
    pub profile_id: String,
    #[serde(default = "legacy_unbound")]
    pub server_binding: String,
    pub local_model_hash: String,
    pub remote_model_id: String,
    pub client_upload_id: String,
    #[serde(default)]
    pub etag: Option<String>,
    pub upload_status: RemoteUploadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub uploaded_at: Option<i64>,
}

fn legacy_unbound() -> String {
    "legacy-unbound".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRevisionDto {
    pub profile_id: String,
    pub entity_type: SyncEntityType,
    #[serde(default)]
    pub local_id: Option<String>,
    pub remote_id: String,
    pub revision: u64,
    #[serde(default)]
    pub concurrency_token: Option<String>,
    pub tombstone: bool,
    pub visibility: SyncVisibility,
    #[serde(default)]
    pub snapshot: Option<Value>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullEntityDto {
    pub entity_type: SyncEntityType,
    #[serde(default)]
    pub local_id: Option<String>,
    pub remote_id: String,
    pub revision: u64,
    #[serde(default)]
    pub journal_revision: u64,
    #[serde(default)]
    pub concurrency_token: Option<String>,
    pub tombstone: bool,
    pub visibility: SyncVisibility,
    #[serde(default)]
    pub snapshot: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInputDto {
    pub conflict_id: String,
    pub entity_type: SyncEntityType,
    pub entity_id: String,
    #[serde(default)]
    pub local_payload: Option<Value>,
    #[serde(default)]
    pub server_payload: Option<Value>,
    #[serde(default)]
    pub submitted_payload: Option<Value>,
    pub reason: String,
    pub server_revision: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPullBatchDto {
    pub profile_id: String,
    pub expected_checkpoint_generation: u64,
    #[serde(default)]
    pub expected_previous_cursor: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    pub server_revision: u64,
    pub applied_at: i64,
    #[serde(default)]
    pub entities: Vec<PullEntityDto>,
    #[serde(default)]
    pub conflicts: Vec<ConflictInputDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueOutboundOperationDto {
    pub operation_id: String,
    pub entity_type: SyncEntityType,
    pub operation: SyncOperationKind,
    pub entity_id: String,
    pub payload: Value,
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default)]
    pub concurrency_token: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundOperationDto {
    pub profile_id: String,
    pub operation_id: String,
    pub sequence: u64,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub batch_ordinal: u32,
    pub entity_type: SyncEntityType,
    pub operation: SyncOperationKind,
    pub entity_id: String,
    pub payload: Value,
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default)]
    pub concurrency_token: Option<String>,
    pub state: OutboundState,
    pub attempt_count: u32,
    pub retry_eligible: bool,
    #[serde(default)]
    pub retry_at: Option<i64>,
    #[serde(default)]
    pub lease_until: Option<i64>,
    #[serde(default)]
    pub lease_token: Option<String>,
    #[serde(default)]
    pub attempt_token: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub acked_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedOutboundBatchDto {
    pub profile_id: String,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub lease_token: String,
    pub attempt_token: String,
    pub lease_until: i64,
    pub operations: Vec<OutboundOperationDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutboundFailureOutcome {
    DefiniteTransient,
    DefinitePermanent,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailOutboundBatchDto {
    pub profile_id: String,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub lease_token: String,
    pub outcome: OutboundFailureOutcome,
    pub error: String,
    pub failed_at: i64,
    #[serde(default)]
    pub retry_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedOutboundResultDto {
    pub operation_id: String,
    pub remote_id: String,
    pub revision: u64,
    #[serde(default)]
    pub concurrency_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementConflictDto {
    pub operation_id: String,
    pub conflict: ConflictInputDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleOutboundBatchDto {
    pub profile_id: String,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub lease_token: String,
    pub settled_at: i64,
    pub server_revision: u64,
    #[serde(default)]
    pub applied: Vec<AppliedOutboundResultDto>,
    #[serde(default)]
    pub conflicts: Vec<SettlementConflictDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledOutboundBatchDto {
    pub operations: Vec<OutboundOperationDto>,
    pub conflicts: Vec<SyncConflictDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnknownOutcomeResolution {
    Acked,
    Requeue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileOperationDto {
    pub operation_id: String,
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default)]
    pub concurrency_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileUncertainBatchDto {
    pub profile_id: String,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub expected_attempt_token: String,
    pub resolution: UnknownOutcomeResolution,
    pub reconciled_at: i64,
    #[serde(default)]
    pub operations: Vec<ReconcileOperationDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailedBatchDisposition {
    Discard,
    Acked,
    Requeue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisposeFailedBatchDto {
    pub profile_id: String,
    pub batch_id: String,
    pub batch_incarnation: String,
    pub expected_attempt_token: String,
    pub disposition: FailedBatchDisposition,
    pub disposed_at: i64,
    #[serde(default)]
    pub operations: Vec<ReconcileOperationDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictDto {
    pub profile_id: String,
    pub conflict_id: String,
    pub entity_type: SyncEntityType,
    pub entity_id: String,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub batch_incarnation: Option<String>,
    #[serde(default)]
    pub attempt_token: Option<String>,
    #[serde(default)]
    pub local_payload: Option<Value>,
    #[serde(default)]
    pub server_payload: Option<Value>,
    #[serde(default)]
    pub submitted_payload: Option<Value>,
    pub reason: String,
    pub server_revision: u64,
    pub created_at: i64,
    #[serde(default)]
    pub resolved_at: Option<i64>,
    #[serde(default)]
    pub resolution: Option<ConflictResolution>,
}

pub(crate) fn validate_profile(profile_id: &str) -> Result<(), String> {
    validate_identifier("profileId", profile_id)
}

pub(crate) fn validate_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(format!("{name} must be 1..={MAX_IDENTIFIER_BYTES} bytes"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{name} must not contain control characters"));
    }
    Ok(())
}

pub(crate) fn validate_optional_identifier(name: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        validate_identifier(name, value)?;
    }
    Ok(())
}

pub(crate) fn validate_timestamp(name: &str, value: i64) -> Result<(), String> {
    if value < 0 {
        return Err(format!("{name} must be a non-negative Unix timestamp"));
    }
    Ok(())
}

fn validate_revision(name: &str, value: u64) -> Result<(), String> {
    if value > i64::MAX as u64 {
        return Err(format!("{name} exceeds the supported range"));
    }
    Ok(())
}

fn validate_wire_timestamp(name: &str, value: &str) -> Result<(), String> {
    let has_zone = value.ends_with('Z')
        || value.get(10..).is_some_and(|time| {
            time.contains('+') || time.get(1..).is_some_and(|v| v.contains('-'))
        });
    if !(20..=64).contains(&value.len()) || !value.contains('T') || !has_zone {
        return Err(format!("{name} must be an RFC 3339 timestamp"));
    }
    Ok(())
}

pub(crate) fn validate_payload(name: &str, value: &Value) -> Result<(), String> {
    let size = serde_json::to_vec(value)
        .map_err(|error| format!("{name} is not serializable: {error}"))?
        .len();
    if size > MAX_PAYLOAD_BYTES {
        return Err(format!("{name} exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
    Ok(())
}

pub(crate) fn validate_local_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("localModelHash must be a lowercase hexadecimal SHA-256".to_string());
    }
    Ok(())
}

pub(crate) fn validate_remote_link(link: &RemoteModelLinkDto) -> Result<(), String> {
    validate_profile(&link.profile_id)?;
    validate_identifier("serverBinding", &link.server_binding)?;
    validate_local_hash(&link.local_model_hash)?;
    validate_identifier("remoteModelId", &link.remote_model_id)?;
    validate_identifier("clientUploadId", &link.client_upload_id)?;
    validate_optional_identifier("etag", link.etag.as_deref())?;
    validate_timestamp("createdAt", link.created_at)?;
    validate_timestamp("updatedAt", link.updated_at)?;
    if link.updated_at < link.created_at {
        return Err("updatedAt must not precede createdAt".to_string());
    }
    if let Some(uploaded_at) = link.uploaded_at {
        validate_timestamp("uploadedAt", uploaded_at)?;
        if uploaded_at < link.created_at {
            return Err("uploadedAt must not precede createdAt".to_string());
        }
    }
    Ok(())
}

pub(crate) fn merge_remote_link(
    existing: &RemoteModelLinkDto,
    incoming: &RemoteModelLinkDto,
) -> Result<RemoteModelLinkDto, String> {
    if existing.profile_id != incoming.profile_id
        || existing.local_model_hash != incoming.local_model_hash
        || existing.server_binding != incoming.server_binding
        || existing.remote_model_id != incoming.remote_model_id
        || existing.client_upload_id != incoming.client_upload_id
        || existing.created_at != incoming.created_at
    {
        return Err("remote model link content does not match existing link".to_string());
    }
    if incoming.updated_at < existing.updated_at {
        return Ok(existing.clone());
    }
    if incoming.updated_at == existing.updated_at {
        return if incoming == existing {
            Ok(existing.clone())
        } else {
            Err("equal updatedAt requires identical remote model link content".to_string())
        };
    }
    let legal = match existing.upload_status {
        RemoteUploadStatus::Pending => true,
        RemoteUploadStatus::Uploading => incoming.upload_status != RemoteUploadStatus::Pending,
        RemoteUploadStatus::Failed => true,
        RemoteUploadStatus::Uploaded => incoming.upload_status == RemoteUploadStatus::Uploaded,
    };
    if !legal {
        return Err("remote model upload status cannot move backwards".to_string());
    }
    if existing.upload_status == RemoteUploadStatus::Uploaded
        && incoming.uploaded_at.is_some()
        && incoming.uploaded_at != existing.uploaded_at
    {
        return Err("uploadedAt is immutable after upload".to_string());
    }
    let mut merged = incoming.clone();
    if merged.etag.is_none() {
        merged.etag.clone_from(&existing.etag);
    }
    if merged.uploaded_at.is_none() {
        merged.uploaded_at = existing.uploaded_at;
    }
    Ok(merged)
}

fn validate_cursor(name: &str, cursor: Option<&str>) -> Result<(), String> {
    if let Some(cursor) = cursor {
        if cursor.len() > MAX_CURSOR_BYTES {
            return Err(format!("{name} exceeds {MAX_CURSOR_BYTES} bytes"));
        }
        if cursor.chars().any(char::is_control) {
            return Err(format!("{name} must not contain control characters"));
        }
    }
    Ok(())
}

fn validate_snapshot(entity: &PullEntityDto) -> Result<(), String> {
    if entity.tombstone {
        if entity.snapshot.is_some() {
            return Err("tombstones must not contain a snapshot".to_string());
        }
        return Ok(());
    }
    let snapshot = entity
        .snapshot
        .as_ref()
        .ok_or_else(|| "non-tombstone entities require a snapshot".to_string())?;
    validate_payload("snapshot", snapshot)?;
    match entity.entity_type {
        SyncEntityType::ModelCollection => {
            let value: CollectionSnapshotDto = serde_json::from_value(snapshot.clone())
                .map_err(|error| format!("invalid collection snapshot: {error}"))?;
            validate_identifier("snapshot.id", &value.id)?;
            validate_optional_identifier("snapshot.ownerUserId", value.owner_user_id.as_deref())?;
            validate_identifier("snapshot.concurrencyToken", &value.concurrency_token)?;
            validate_wire_timestamp("snapshot.createdAt", &value.created_at)?;
            validate_wire_timestamp("snapshot.updatedAt", &value.updated_at)?;
            if value.id != entity.remote_id || value.revision != entity.revision {
                return Err("collection snapshot identity/revision mismatch".to_string());
            }
        }
        SyncEntityType::ModelCollectionMembership => {
            let value: MembershipSnapshotDto = serde_json::from_value(snapshot.clone())
                .map_err(|error| format!("invalid membership snapshot: {error}"))?;
            validate_identifier("snapshot.collectionId", &value.collection_id)?;
            validate_identifier("snapshot.modelId", &value.model_id)?;
            validate_wire_timestamp("snapshot.createdAt", &value.created_at)?;
            validate_wire_timestamp("snapshot.updatedAt", &value.updated_at)?;
            if value.id != entity.remote_id || value.revision != entity.revision {
                return Err("membership snapshot identity/revision mismatch".to_string());
            }
        }
        SyncEntityType::Tag => {
            let value: TagSnapshotDto = serde_json::from_value(snapshot.clone())
                .map_err(|error| format!("invalid tag snapshot: {error}"))?;
            validate_identifier("snapshot.concurrencyToken", &value.concurrency_token)?;
            if value.id != entity.remote_id || value.revision != entity.revision {
                return Err("tag snapshot identity/revision mismatch".to_string());
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_conflict_input(conflict: &ConflictInputDto) -> Result<(), String> {
    validate_identifier("conflictId", &conflict.conflict_id)?;
    validate_identifier("entityId", &conflict.entity_id)?;
    validate_identifier("reason", &conflict.reason)?;
    validate_timestamp("createdAt", conflict.created_at)?;
    validate_revision("serverRevision", conflict.server_revision)?;
    for (name, payload) in [
        ("localPayload", conflict.local_payload.as_ref()),
        ("serverPayload", conflict.server_payload.as_ref()),
        ("submittedPayload", conflict.submitted_payload.as_ref()),
    ] {
        if let Some(payload) = payload {
            validate_payload(name, payload)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_pull_batch(batch: &ApplyPullBatchDto) -> Result<(), String> {
    validate_profile(&batch.profile_id)?;
    validate_revision(
        "expectedCheckpointGeneration",
        batch.expected_checkpoint_generation,
    )?;
    validate_timestamp("appliedAt", batch.applied_at)?;
    validate_revision("serverRevision", batch.server_revision)?;
    if batch.entities.len().saturating_add(batch.conflicts.len()) > MAX_SYNC_BATCH {
        return Err(format!(
            "pull batches are limited to {MAX_SYNC_BATCH} items"
        ));
    }
    validate_cursor(
        "expectedPreviousCursor",
        batch.expected_previous_cursor.as_deref(),
    )?;
    validate_cursor("cursor", batch.cursor.as_deref())?;
    let mut remote_keys = std::collections::HashSet::new();
    let mut local_keys = std::collections::HashSet::new();
    for entity in &batch.entities {
        validate_identifier("remoteId", &entity.remote_id)?;
        validate_optional_identifier("localId", entity.local_id.as_deref())?;
        validate_optional_identifier("concurrencyToken", entity.concurrency_token.as_deref())?;
        validate_revision("entity.revision", entity.revision)?;
        validate_revision("entity.journalRevision", entity.journal_revision)?;
        if !remote_keys.insert((entity.entity_type, entity.remote_id.as_str())) {
            return Err("pull batch contains a duplicate entity".to_string());
        }
        if let Some(local_id) = entity.local_id.as_deref() {
            if !local_keys.insert((entity.entity_type, local_id)) {
                return Err("pull batch contains duplicate local entity mappings".to_string());
            }
        }
        validate_snapshot(entity)?;
    }
    for conflict in &batch.conflicts {
        validate_conflict_input(conflict)?;
    }
    Ok(())
}

pub(crate) fn validate_enqueue(operation: &EnqueueOutboundOperationDto) -> Result<(), String> {
    validate_identifier("operationId", &operation.operation_id)?;
    validate_identifier("entityId", &operation.entity_id)?;
    validate_optional_identifier("concurrencyToken", operation.concurrency_token.as_deref())?;
    validate_timestamp("createdAt", operation.created_at)?;
    if let Some(revision) = operation.base_revision {
        validate_revision("baseRevision", revision)?;
    }
    validate_payload("payload", &operation.payload)?;
    match (operation.entity_type, operation.operation) {
        (SyncEntityType::Tag, _) => Err("tags are pull-only and cannot be enqueued".to_string()),
        (SyncEntityType::ModelCollectionMembership, SyncOperationKind::Update) => {
            Err("membership updates are not supported by the server".to_string())
        }
        _ => Ok(()),
    }
}

pub(crate) fn validate_enqueue_batch(
    profile_id: &str,
    operations: &[EnqueueOutboundOperationDto],
) -> Result<(), String> {
    validate_profile(profile_id)?;
    if operations.is_empty() || operations.len() > MAX_SYNC_BATCH {
        return Err(format!(
            "outbound batches must contain 1..={MAX_SYNC_BATCH} operations"
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for operation in operations {
        validate_enqueue(operation)?;
        if !ids.insert(operation.operation_id.as_str()) {
            return Err("outbound batch contains a duplicate operationId".to_string());
        }
    }
    Ok(())
}

pub(crate) fn validate_limit(limit: usize) -> Result<(), String> {
    if !(1..=MAX_SYNC_BATCH).contains(&limit) {
        return Err(format!("limit must be 1..={MAX_SYNC_BATCH}"));
    }
    Ok(())
}

pub(crate) fn validate_lease(now: i64, lease_seconds: i64) -> Result<i64, String> {
    validate_timestamp("now", now)?;
    if !(1..=MAX_LEASE_SECONDS).contains(&lease_seconds) {
        return Err(format!("leaseSeconds must be 1..={MAX_LEASE_SECONDS}"));
    }
    now.checked_add(lease_seconds)
        .ok_or_else(|| "lease expiration overflows timestamp".to_string())
}

pub(crate) fn validate_settlement(settlement: &SettleOutboundBatchDto) -> Result<(), String> {
    validate_profile(&settlement.profile_id)?;
    validate_identifier("batchId", &settlement.batch_id)?;
    validate_identifier("batchIncarnation", &settlement.batch_incarnation)?;
    validate_identifier("leaseToken", &settlement.lease_token)?;
    validate_timestamp("settledAt", settlement.settled_at)?;
    validate_revision("serverRevision", settlement.server_revision)?;
    if settlement
        .applied
        .len()
        .saturating_add(settlement.conflicts.len())
        > MAX_SYNC_BATCH
    {
        return Err(format!(
            "settlement batches are limited to {MAX_SYNC_BATCH} items"
        ));
    }

    if !settlement.applied.is_empty() && !settlement.conflicts.is_empty() {
        return Err("a server batch cannot be both applied and conflicted".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for applied in &settlement.applied {
        validate_identifier("operationId", &applied.operation_id)?;
        validate_identifier("remoteId", &applied.remote_id)?;
        validate_optional_identifier("concurrencyToken", applied.concurrency_token.as_deref())?;
        validate_revision("revision", applied.revision)?;
        if !ids.insert(applied.operation_id.as_str()) {
            return Err("settlement contains duplicate operationId".to_string());
        }
    }
    for conflict in &settlement.conflicts {
        validate_identifier("operationId", &conflict.operation_id)?;
        validate_conflict_input(&conflict.conflict)?;
        if !ids.insert(conflict.operation_id.as_str()) {
            return Err("settlement contains duplicate operationId".to_string());
        }
    }
    Ok(())
}

pub(crate) fn validate_batch_failure(failure: &FailOutboundBatchDto) -> Result<(), String> {
    validate_profile(&failure.profile_id)?;
    validate_identifier("batchId", &failure.batch_id)?;
    validate_identifier("batchIncarnation", &failure.batch_incarnation)?;
    validate_identifier("leaseToken", &failure.lease_token)?;
    validate_timestamp("failedAt", failure.failed_at)?;
    if failure.error.is_empty() || failure.error.len() > MAX_ERROR_BYTES {
        return Err(format!("error must be 1..={MAX_ERROR_BYTES} bytes"));
    }
    match (failure.outcome, failure.retry_at) {
        (OutboundFailureOutcome::DefiniteTransient, Some(retry_at)) => {
            validate_timestamp("retryAt", retry_at)?;
            if retry_at < failure.failed_at {
                return Err("retryAt must not precede failedAt".to_string());
            }
        }
        (OutboundFailureOutcome::DefiniteTransient, None) => {
            return Err("definite transient failures require retryAt".to_string());
        }
        (OutboundFailureOutcome::DefinitePermanent, Some(_)) => {
            return Err("definite permanent failures cannot have retryAt".to_string());
        }
        (OutboundFailureOutcome::DefinitePermanent, None) => {}
        (OutboundFailureOutcome::Ambiguous, Some(_)) => {
            return Err("ambiguous failures cannot have retryAt".to_string());
        }
        (OutboundFailureOutcome::Ambiguous, None) => {}
    }
    Ok(())
}

pub(crate) fn validate_reconciliation(
    reconciliation: &ReconcileUncertainBatchDto,
) -> Result<(), String> {
    validate_profile(&reconciliation.profile_id)?;
    validate_identifier("batchId", &reconciliation.batch_id)?;
    validate_identifier("batchIncarnation", &reconciliation.batch_incarnation)?;
    validate_identifier(
        "expectedAttemptToken",
        &reconciliation.expected_attempt_token,
    )?;
    validate_timestamp("reconciledAt", reconciliation.reconciled_at)?;
    validate_reconciliation_entries(&reconciliation.operations)
}

pub(crate) fn validate_failed_disposition(
    disposition: &DisposeFailedBatchDto,
) -> Result<(), String> {
    validate_profile(&disposition.profile_id)?;
    validate_identifier("batchId", &disposition.batch_id)?;
    validate_identifier("batchIncarnation", &disposition.batch_incarnation)?;
    validate_identifier("expectedAttemptToken", &disposition.expected_attempt_token)?;
    validate_timestamp("disposedAt", disposition.disposed_at)?;
    if disposition.disposition == FailedBatchDisposition::Requeue {
        validate_reconciliation_entries(&disposition.operations)?;
    } else if !disposition.operations.is_empty() {
        return Err("only requeue dispositions accept operation replacements".to_string());
    }
    Ok(())
}

fn validate_reconciliation_entries(entries: &[ReconcileOperationDto]) -> Result<(), String> {
    if entries.is_empty() || entries.len() > MAX_SYNC_BATCH {
        return Err(format!(
            "reconciliation must contain 1..={MAX_SYNC_BATCH} operations"
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for entry in entries {
        validate_identifier("operationId", &entry.operation_id)?;
        if let Some(revision) = entry.base_revision {
            validate_revision("baseRevision", revision)?;
        }
        validate_optional_identifier("concurrencyToken", entry.concurrency_token.as_deref())?;
        if !ids.insert(entry.operation_id.as_str()) {
            return Err("reconciliation contains duplicate operationId".to_string());
        }
    }
    Ok(())
}

pub(crate) fn merge_entity_revision(
    existing: Option<&EntityRevisionDto>,
    mut incoming: EntityRevisionDto,
) -> Result<EntityRevisionDto, String> {
    if incoming.tombstone {
        incoming.snapshot = None;
        incoming.visibility = SyncVisibility::Private;
    } else if let Some(snapshot_revision) = incoming
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.get("revision"))
        .and_then(Value::as_u64)
    {
        if snapshot_revision != incoming.revision {
            return Err("entity snapshot revision does not match mapping revision".to_string());
        }
    }
    let Some(existing) = existing else {
        return Ok(incoming);
    };
    if existing.profile_id != incoming.profile_id
        || existing.entity_type != incoming.entity_type
        || existing.remote_id != incoming.remote_id
    {
        return Err("entity merge identity mismatch".to_string());
    }
    if incoming.local_id.is_none() {
        incoming.local_id.clone_from(&existing.local_id);
    }
    if existing.local_id.is_some()
        && incoming.local_id.is_some()
        && existing.local_id != incoming.local_id
    {
        return Err("remote entity cannot be rebound to a different localId".to_string());
    }
    if existing.revision > incoming.revision {
        return Ok(existing.clone());
    }
    if existing.revision == incoming.revision {
        if existing.tombstone {
            return Ok(existing.clone());
        }
        if incoming.tombstone {
            return Ok(incoming);
        }
        if incoming.snapshot.is_none() {
            return Ok(existing.clone());
        }
        if existing.snapshot.is_some() && existing.snapshot != incoming.snapshot {
            return Err("equal entity revisions have different snapshots".to_string());
        }
    }
    Ok(incoming)
}

pub(crate) fn preflight_entity_revision_set(
    existing: &[EntityRevisionDto],
    incoming: Vec<EntityRevisionDto>,
) -> Result<Vec<EntityRevisionDto>, String> {
    let mut by_remote = std::collections::HashMap::new();
    let mut by_local = std::collections::HashMap::new();
    for mapping in existing {
        let remote_key = (mapping.entity_type, mapping.remote_id.clone());
        if let Some(previous) = by_remote.insert(remote_key, mapping.clone()) {
            if previous != *mapping {
                return Err("existing remote mapping index is inconsistent".to_string());
            }
        }
        if let Some(local_id) = &mapping.local_id {
            let local_key = (mapping.entity_type, local_id.clone());
            if let Some(previous_remote) = by_local.insert(local_key, mapping.remote_id.clone()) {
                if previous_remote != mapping.remote_id {
                    return Err("existing local mapping index is inconsistent".to_string());
                }
            }
        }
    }

    let mut sibling_results = std::collections::HashMap::new();
    let mut output_keys = Vec::new();
    for incoming_mapping in incoming {
        let normalized = merge_entity_revision(None, incoming_mapping)?;
        let remote_key = (normalized.entity_type, normalized.remote_id.clone());
        if let Some(previous) = sibling_results.get(&remote_key) {
            if previous != &normalized {
                return Err("sibling results conflict for the same remote mapping".to_string());
            }
            continue;
        }
        if let Some(local_id) = &normalized.local_id {
            let local_key = (normalized.entity_type, local_id.clone());
            if let Some(previous_remote) = by_local.get(&local_key) {
                if previous_remote != &normalized.remote_id {
                    return Err("sibling results map one localId to two remoteIds".to_string());
                }
            }
            by_local.insert(local_key, normalized.remote_id.clone());
        }
        let merged = merge_entity_revision(by_remote.get(&remote_key), normalized.clone())?;
        by_remote.insert(remote_key.clone(), merged);
        sibling_results.insert(remote_key.clone(), normalized);
        output_keys.push(remote_key);
    }

    Ok(output_keys
        .into_iter()
        .filter_map(|key| by_remote.remove(&key))
        .collect())
}

pub(crate) fn new_lease_token() -> String {
    new_collision_resistant_token("lease")
}

pub(crate) fn new_batch_incarnation() -> String {
    new_collision_resistant_token("batch")
}

pub(crate) fn new_operation_token(prefix: &str) -> String {
    new_collision_resistant_token(prefix)
}

pub(crate) fn new_remote_guid() -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(new_collision_resistant_token("remote").as_bytes());
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-4{:x}{:02x}-{:x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0],
        digest[1],
        digest[2],
        digest[3],
        digest[4],
        digest[5],
        digest[6] & 0x0f,
        digest[7],
        (digest[8] & 0x3f) | 0x80,
        digest[9],
        digest[10],
        digest[11],
        digest[12],
        digest[13],
        digest[14],
        digest[15]
    )
}

fn new_collision_resistant_token(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos:x}-{sequence:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogStore, InMemoryCatalog};
    use serde_json::json;

    fn hash(letter: char) -> String {
        std::iter::repeat_n(letter, 64).collect()
    }

    fn link(profile: &str, letter: char) -> RemoteModelLinkDto {
        RemoteModelLinkDto {
            profile_id: profile.to_string(),
            server_binding: "binding-a".to_string(),
            local_model_hash: hash(letter),
            remote_model_id: format!("remote-{letter}"),
            client_upload_id: format!("upload-{letter}"),
            etag: None,
            upload_status: RemoteUploadStatus::Pending,
            created_at: 10,
            updated_at: 10,
            uploaded_at: None,
        }
    }

    #[test]
    fn remote_links_are_isolated_by_server_binding_in_memory() {
        let mut store = InMemoryCatalog::new();
        let first = link("p", 'a');
        store.link_remote_model(first.clone()).unwrap();
        let mut second = first;
        second.server_binding = "binding-b".to_string();
        store.link_remote_model(second).unwrap();
        assert!(store
            .remote_model_link("p", "binding-a", &hash('a'))
            .unwrap()
            .is_some());
        assert!(store
            .remote_model_link("p", "binding-b", &hash('a'))
            .unwrap()
            .is_some());
    }

    fn collection_entity(remote_id: &str, local_id: Option<&str>, revision: u64) -> PullEntityDto {
        PullEntityDto {
            entity_type: SyncEntityType::ModelCollection,
            local_id: local_id.map(str::to_string),
            remote_id: remote_id.to_string(),
            revision,
            journal_revision: revision,
            concurrency_token: Some(format!("token-{revision}")),
            tombstone: false,
            visibility: SyncVisibility::Private,
            snapshot: Some(json!({
                "id": remote_id,
                "name": "Dragons",
                "description": "",
                "ownerUserId": "owner-1",
                "isShared": false,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "memberCount": 0,
                "modelIds": [],
                "revision": revision,
                "concurrencyToken": format!("token-{revision}")
            })),
        }
    }

    fn conflict(id: &str, reason: &str) -> ConflictInputDto {
        ConflictInputDto {
            conflict_id: id.to_string(),
            entity_type: SyncEntityType::ModelCollection,
            entity_id: "remote-c".to_string(),
            local_payload: Some(json!({"name": "Local"})),
            server_payload: Some(json!({"name": "Server"})),
            submitted_payload: Some(json!({"name": "Submitted"})),
            reason: reason.to_string(),
            server_revision: 8,
            created_at: 10,
        }
    }

    fn operation(id: &str) -> EnqueueOutboundOperationDto {
        EnqueueOutboundOperationDto {
            operation_id: id.to_string(),
            entity_type: SyncEntityType::ModelCollection,
            operation: SyncOperationKind::Create,
            entity_id: "local-c".to_string(),
            payload: json!({"name": "Dragons"}),
            base_revision: None,
            concurrency_token: None,
            created_at: 10,
        }
    }

    fn tombstone(
        entity_type: SyncEntityType,
        remote_id: &str,
        local_id: &str,
        revision: u64,
    ) -> PullEntityDto {
        PullEntityDto {
            entity_type,
            local_id: Some(local_id.to_string()),
            remote_id: remote_id.to_string(),
            revision,
            journal_revision: revision,
            concurrency_token: None,
            tombstone: true,
            visibility: SyncVisibility::Private,
            snapshot: None,
        }
    }

    fn exercise_store(store: &mut dyn CatalogStore) {
        assert_eq!(store.sync_status("p1").unwrap().server_revision, 0);
        let local_collection = store.create_collection("Local Dragons").unwrap();
        assert_eq!(
            store.link_remote_model(link("p1", 'a')).unwrap(),
            link("p1", 'a')
        );
        assert_eq!(
            store.link_remote_model(link("p1", 'a')).unwrap(),
            link("p1", 'a')
        );
        let mut mismatch = link("p1", 'a');
        mismatch.remote_model_id = "different".to_string();
        assert!(store.link_remote_model(mismatch).is_err());
        assert!(store
            .remote_model_link("p2", "binding-a", &hash('a'))
            .unwrap()
            .is_none());

        let status = store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "p1".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("opaque:cursor".to_string()),
                server_revision: 7,
                applied_at: 20,
                entities: vec![collection_entity("remote-c", Some(&local_collection.id), 7)],
                conflicts: vec![],
            })
            .unwrap();
        assert_eq!(status.cursor.as_deref(), Some("opaque:cursor"));
        assert_eq!(store.entity_revisions("p1", None, 500).unwrap().len(), 1);
        assert!(store.entity_revisions("p2", None, 500).unwrap().is_empty());
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "p1".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some("opaque:cursor".to_string()),
                cursor: None,
                server_revision: 8,
                applied_at: 21,
                entities: vec![PullEntityDto {
                    entity_type: SyncEntityType::ModelCollection,
                    local_id: Some(local_collection.id.clone()),
                    remote_id: "remote-c".to_string(),
                    revision: 8,
                    journal_revision: 8,
                    concurrency_token: None,
                    tombstone: true,
                    visibility: SyncVisibility::Private,
                    snapshot: None,
                }],
                conflicts: vec![],
            })
            .unwrap();

        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "aba".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("page-1".to_string()),
                server_revision: 30,
                applied_at: 1,
                entities: vec![],
                conflicts: vec![],
            })
            .unwrap();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "aba".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some("page-1".to_string()),
                cursor: None,
                server_revision: 30,
                applied_at: 2,
                entities: vec![],
                conflicts: vec![],
            })
            .unwrap();
        assert!(store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "aba".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("page-1".to_string()),
                server_revision: 30,
                applied_at: 3,
                entities: vec![],
                conflicts: vec![],
            })
            .is_err());
        assert_eq!(store.sync_status("aba").unwrap().checkpoint_generation, 2);
        assert!(store.entity_revisions("p1", None, 500).unwrap()[0].tombstone);
        assert_eq!(store.all_collections()[0].id, local_collection.id);

        let queued = store
            .enqueue_outbound_operations("p1", "batch-1", vec![operation("op-1")])
            .unwrap();
        assert_eq!(queued[0].state, OutboundState::Pending);
        let first_claim = store
            .claim_outbound_operations("p1", 10, 30, 10)
            .unwrap()
            .unwrap();
        assert_eq!(first_claim.operations[0].attempt_count, 1);
        assert!(store
            .claim_outbound_operations("p1", 10, 39, 10)
            .unwrap()
            .is_none());
        assert_eq!(store.recover_outbound_operations("p1", 40).unwrap(), 1);
        assert_eq!(
            store.outbound_operations("p1", &[], 10).unwrap()[0].state,
            OutboundState::Uncertain
        );
        assert!(store
            .claim_outbound_operations("p1", 10, 40, 10)
            .unwrap()
            .is_none());
        store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "p1".to_string(),
                batch_id: "batch-1".to_string(),
                batch_incarnation: first_claim.batch_incarnation.clone(),
                expected_attempt_token: first_claim.attempt_token.clone(),
                resolution: UnknownOutcomeResolution::Requeue,
                reconciled_at: 41,
                operations: vec![ReconcileOperationDto {
                    operation_id: "op-1".to_string(),
                    base_revision: Some(8),
                    concurrency_token: Some("fresh".to_string()),
                }],
            })
            .unwrap();
        let second_claim = store
            .claim_outbound_operations("p1", 10, 42, 10)
            .unwrap()
            .unwrap();
        assert_ne!(first_claim.lease_token, second_claim.lease_token);
        assert!(store
            .complete_outbound_operation(
                "p1",
                "op-1",
                &first_claim.batch_incarnation,
                &first_claim.lease_token,
                43,
            )
            .is_err());
        assert!(store
            .fail_outbound_operation(
                "p1",
                "op-1",
                &first_claim.batch_incarnation,
                &first_claim.lease_token,
                "stale",
                43,
                None,
            )
            .is_err());
        let settled = store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "p1".to_string(),
                batch_id: "batch-1".to_string(),
                batch_incarnation: second_claim.batch_incarnation.clone(),
                lease_token: second_claim.lease_token,
                settled_at: 43,
                server_revision: 9,
                applied: vec![AppliedOutboundResultDto {
                    operation_id: "op-1".to_string(),
                    remote_id: "server-c".to_string(),
                    revision: 9,
                    concurrency_token: Some("server-token".to_string()),
                }],
                conflicts: vec![],
            })
            .unwrap();
        assert_eq!(settled.operations[0].state, OutboundState::Acked);
        assert_eq!(store.sync_status("p1").unwrap().last_pushed_at, Some(43));

        store
            .record_sync_conflicts("p1", vec![conflict("conflict-1", "stale")])
            .unwrap();
        let resolved = store
            .resolve_sync_conflict(
                "p1",
                "conflict-1",
                ConflictResolution::AcceptServer,
                60,
                None,
            )
            .unwrap();
        assert_eq!(resolved.resolution, Some(ConflictResolution::AcceptServer));
        assert!(store.sync_conflicts("p1", false, 500).unwrap().is_empty());
        assert_eq!(store.sync_conflicts("p1", true, 500).unwrap().len(), 1);
    }

    #[test]
    fn in_memory_store_covers_profile_isolated_sync_lifecycle() {
        exercise_store(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_store_has_sync_lifecycle_parity() {
        exercise_store(&mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap());
    }

    #[test]
    fn remote_link_is_idempotent_but_rejects_content_mismatch() {
        let mut store = InMemoryCatalog::new();
        store.link_remote_model(link("p", 'a')).unwrap();
        let mut mismatch = link("p", 'a');
        mismatch.remote_model_id = "different".to_string();
        assert!(store.link_remote_model(mismatch).is_err());
        assert_eq!(
            store
                .remote_model_link("p", "binding-a", &hash('a'))
                .unwrap()
                .unwrap(),
            link("p", 'a')
        );
    }

    fn assert_pull_failure_rolls_back(store: &mut dyn CatalogStore) {
        store
            .record_sync_conflicts("p", vec![conflict("same", "first")])
            .unwrap();
        let failed = store.apply_pull_batch(ApplyPullBatchDto {
            profile_id: "p".to_string(),
            expected_checkpoint_generation: 0,
            expected_previous_cursor: None,
            cursor: Some("must-not-stick".to_string()),
            server_revision: 10,
            applied_at: 20,
            entities: vec![collection_entity("new-remote", Some("new-local"), 10)],
            conflicts: vec![conflict("same", "different")],
        });
        assert!(failed.is_err());
        assert!(store.entity_revisions("p", None, 500).unwrap().is_empty());
        assert_eq!(store.sync_status("p").unwrap().cursor, None);
    }

    #[test]
    fn in_memory_pull_failure_rolls_back_entities_and_cursor() {
        assert_pull_failure_rolls_back(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_pull_failure_rolls_back_entities_and_cursor() {
        assert_pull_failure_rolls_back(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    #[test]
    fn pull_persists_tombstones_without_deleting_local_catalog_data() {
        let mut store = InMemoryCatalog::new();
        let local = store.create_collection("Local Dragons").unwrap();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "p".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: None,
                server_revision: 11,
                applied_at: 20,
                entities: vec![PullEntityDto {
                    entity_type: SyncEntityType::ModelCollection,
                    local_id: Some(local.id.clone()),
                    remote_id: "deleted-remote".to_string(),
                    revision: 11,
                    journal_revision: 11,
                    concurrency_token: None,
                    tombstone: true,
                    visibility: SyncVisibility::Private,
                    snapshot: None,
                }],
                conflicts: vec![],
            })
            .unwrap();
        assert!(store.entity_revisions("p", None, 500).unwrap()[0].tombstone);
        assert_eq!(store.all_collections()[0].id, local.id);
    }

    #[test]
    fn rejects_unsupported_pushes_bounds_and_invalid_transitions() {
        let mut store = InMemoryCatalog::new();
        let mut tag = operation("tag-op");
        tag.entity_type = SyncEntityType::Tag;
        assert!(store
            .enqueue_outbound_operations("p", "tag-batch", vec![tag])
            .is_err());
        assert!(store
            .enqueue_outbound_operations("p", "batch", vec![operation("op")])
            .is_ok());
        assert!(store
            .complete_outbound_operation("p", "op", "not-an-incarnation", "not-a-lease", 20)
            .is_err());
        assert!(store.claim_outbound_operations("p", 0, 20, 10).is_err());
        assert!(store.claim_outbound_operations("p", 1, 20, 0).is_err());

        let mut oversized = operation("big");
        oversized.payload = Value::String("x".repeat(MAX_PAYLOAD_BYTES + 1));
        assert!(store
            .enqueue_outbound_operations("p", "big-batch", vec![oversized])
            .is_err());
        let too_many: Vec<_> = (0..=MAX_SYNC_BATCH)
            .map(|index| operation(&format!("op-{index}")))
            .collect();
        assert!(store
            .enqueue_outbound_operations("p", "too-many", too_many)
            .is_err());
    }

    #[test]
    fn sync_dtos_use_contract_enums_and_camel_case_fields() {
        let value = serde_json::to_value(collection_entity("remote", None, 1)).unwrap();
        assert_eq!(value["entityType"], "ModelCollection");
        assert_eq!(value["concurrencyToken"], "token-1");
        assert!(serde_json::from_value::<PullEntityDto>(json!({
            "entityType": "Unknown",
            "remoteId": "r",
            "revision": 1,
            "tombstone": true,
            "visibility": "Private"
        }))
        .is_err());
    }

    fn assert_cursor_fencing(store: &mut dyn CatalogStore) {
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "cursor-profile".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("page-1".to_string()),
                server_revision: 20,
                applied_at: 1,
                entities: vec![tombstone(SyncEntityType::Tag, "tag-1", "local-tag-1", 1)],
                conflicts: vec![],
            })
            .unwrap();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "cursor-profile".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some("page-1".to_string()),
                cursor: Some("page-2".to_string()),
                server_revision: 20,
                applied_at: 2,
                entities: vec![tombstone(SyncEntityType::Tag, "tag-2", "local-tag-2", 2)],
                conflicts: vec![],
            })
            .unwrap();
        let replay = store.apply_pull_batch(ApplyPullBatchDto {
            profile_id: "cursor-profile".to_string(),
            expected_checkpoint_generation: 0,
            expected_previous_cursor: None,
            cursor: Some("page-1".to_string()),
            server_revision: 20,
            applied_at: 3,
            entities: vec![],
            conflicts: vec![],
        });
        assert!(replay.is_err());
        assert_eq!(
            store
                .sync_status("cursor-profile")
                .unwrap()
                .cursor
                .as_deref(),
            Some("page-2")
        );
        assert!(store
            .entity_revision_by_remote("cursor-profile", SyncEntityType::Tag, "tag-2")
            .unwrap()
            .is_some());

        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "empty-cursor".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some(String::new()),
                server_revision: 0,
                applied_at: 1,
                entities: vec![],
                conflicts: vec![],
            })
            .unwrap();
        assert!(store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "empty-cursor".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: None,
                cursor: None,
                server_revision: 0,
                applied_at: 2,
                entities: vec![],
                conflicts: vec![],
            })
            .is_err());
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "empty-cursor".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some(String::new()),
                cursor: None,
                server_revision: 0,
                applied_at: 2,
                entities: vec![],
                conflicts: vec![],
            })
            .unwrap();
    }

    #[test]
    fn in_memory_cursor_compare_and_set_fences_replays() {
        assert_cursor_fencing(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_cursor_compare_and_set_fences_replays() {
        assert_cursor_fencing(&mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap());
    }

    fn assert_nullable_snapshots_and_duplicate_preflight(store: &mut dyn CatalogStore) {
        let collection = PullEntityDto {
            entity_type: SyncEntityType::ModelCollection,
            local_id: Some("local-c".to_string()),
            remote_id: "remote-c".to_string(),
            revision: 1,
            journal_revision: 1,
            concurrency_token: Some("ct".to_string()),
            tombstone: false,
            visibility: SyncVisibility::Private,
            snapshot: Some(json!({
                "id": "remote-c",
                "name": "No description",
                "description": null,
                "ownerUserId": "owner",
                "isShared": false,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "memberCount": 0,
                "modelIds": [],
                "revision": 1,
                "concurrencyToken": "ct"
            })),
        };
        let tag = PullEntityDto {
            entity_type: SyncEntityType::Tag,
            local_id: Some("local-tag".to_string()),
            remote_id: "remote-tag".to_string(),
            revision: 1,
            journal_revision: 1,
            concurrency_token: Some("tt".to_string()),
            tombstone: false,
            visibility: SyncVisibility::Private,
            snapshot: Some(json!({
                "id": "remote-tag",
                "name": "Tag",
                "isAutoGenerated": false,
                "revision": 1,
                "concurrencyToken": "tt"
            })),
        };
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "nullable".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("done".to_string()),
                server_revision: 1,
                applied_at: 1,
                entities: vec![collection, tag],
                conflicts: vec![],
            })
            .unwrap();
        assert_eq!(
            store.entity_revisions("nullable", None, 10).unwrap().len(),
            2
        );

        let duplicate = store.apply_pull_batch(ApplyPullBatchDto {
            profile_id: "duplicates".to_string(),
            expected_checkpoint_generation: 0,
            expected_previous_cursor: None,
            cursor: Some("bad".to_string()),
            server_revision: 1,
            applied_at: 1,
            entities: vec![
                tombstone(SyncEntityType::ModelCollection, "remote-1", "same-local", 1),
                tombstone(SyncEntityType::ModelCollection, "remote-2", "same-local", 1),
            ],
            conflicts: vec![],
        });
        assert!(duplicate.is_err());
        assert_eq!(store.sync_status("duplicates").unwrap().cursor, None);
    }

    #[test]
    fn in_memory_accepts_nullable_snapshots_and_preflights_duplicate_mappings() {
        assert_nullable_snapshots_and_duplicate_preflight(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_accepts_nullable_snapshots_and_preflights_duplicate_mappings() {
        assert_nullable_snapshots_and_duplicate_preflight(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_remote_link_monotonicity(store: &mut dyn CatalogStore) {
        let pending = link("upload-profile", 'b');
        store.link_remote_model(pending.clone()).unwrap();
        let mut uploading = pending.clone();
        uploading.upload_status = RemoteUploadStatus::Uploading;
        uploading.updated_at = 20;
        uploading.etag = Some("etag".to_string());
        store.link_remote_model(uploading.clone()).unwrap();
        let mut uploaded = uploading.clone();
        uploaded.upload_status = RemoteUploadStatus::Uploaded;
        uploaded.updated_at = 30;
        uploaded.uploaded_at = Some(30);
        store.link_remote_model(uploaded.clone()).unwrap();

        let mut stale = pending;
        stale.updated_at = 15;
        assert_eq!(store.link_remote_model(stale).unwrap(), uploaded);

        let mut replay = uploaded.clone();
        replay.updated_at = 40;
        replay.etag = None;
        replay.uploaded_at = None;
        let merged = store.link_remote_model(replay).unwrap();
        assert_eq!(merged.etag.as_deref(), Some("etag"));
        assert_eq!(merged.uploaded_at, Some(30));

        let mut equal_mismatch = merged.clone();
        equal_mismatch.etag = Some("changed".to_string());
        assert!(store.link_remote_model(equal_mismatch).is_err());
        let mut regression = merged;
        regression.updated_at = 50;
        regression.upload_status = RemoteUploadStatus::Pending;
        assert!(store.link_remote_model(regression).is_err());
    }

    #[test]
    fn in_memory_remote_links_are_monotonic() {
        assert_remote_link_monotonicity(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_remote_links_are_monotonic() {
        assert_remote_link_monotonicity(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_ordered_batches_and_point_lookup(store: &mut dyn CatalogStore) {
        let create = operation("create");
        let mut membership = operation("membership");
        membership.entity_type = SyncEntityType::ModelCollectionMembership;
        membership.entity_id = "membership-local".to_string();
        store
            .enqueue_outbound_operations("ordered", "logical", vec![create, membership])
            .unwrap();
        store
            .enqueue_outbound_operations("ordered", "later", vec![operation("later")])
            .unwrap();
        assert!(store
            .claim_outbound_operations("ordered", 1, 10, 10)
            .is_err());
        let claimed = store
            .claim_outbound_operations("ordered", 2, 10, 10)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.batch_id, "logical");
        assert_eq!(claimed.operations[0].operation_id, "create");
        assert_eq!(claimed.operations[1].operation_id, "membership");
        assert!(claimed.operations[0].sequence < claimed.operations[1].sequence);
        assert!(store
            .claim_outbound_operations("ordered", 1, 11, 10)
            .unwrap()
            .is_none());

        let first_page: Vec<_> = (0..500)
            .map(|index| {
                tombstone(
                    SyncEntityType::Tag,
                    &format!("remote-{index:03}"),
                    &format!("local-{index:03}"),
                    1,
                )
            })
            .collect();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "mappings".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("first".to_string()),
                server_revision: 7,
                applied_at: 1,
                entities: first_page,
                conflicts: vec![],
            })
            .unwrap();
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "mappings".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some("first".to_string()),
                cursor: Some("second".to_string()),
                server_revision: 7,
                applied_at: 2,
                entities: vec![tombstone(SyncEntityType::Tag, "remote-500", "local-500", 2)],
                conflicts: vec![],
            })
            .unwrap();
        assert!(store
            .entity_revision_by_remote("mappings", SyncEntityType::Tag, "remote-500")
            .unwrap()
            .is_some());
        assert!(store
            .entity_revision_by_local("mappings", SyncEntityType::Tag, "local-500")
            .unwrap()
            .is_some());
    }

    #[test]
    fn in_memory_preserves_logical_batch_order_and_supports_mapping_lookup() {
        assert_ordered_batches_and_point_lookup(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_preserves_logical_batch_order_and_supports_mapping_lookup() {
        assert_ordered_batches_and_point_lookup(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_failed_settlement_is_atomic(store: &mut dyn CatalogStore) {
        store
            .record_sync_conflicts("atomic", vec![conflict("existing", "original")])
            .unwrap();
        store
            .enqueue_outbound_operations(
                "atomic",
                "batch",
                vec![operation("atomic-1"), operation("atomic-2")],
            )
            .unwrap();
        let claim = store
            .claim_outbound_operations("atomic", 2, 10, 10)
            .unwrap()
            .unwrap();
        let failed = store.settle_outbound_batch(SettleOutboundBatchDto {
            profile_id: "atomic".to_string(),
            batch_id: "batch".to_string(),
            batch_incarnation: claim.batch_incarnation.clone(),
            lease_token: claim.lease_token.clone(),
            settled_at: 11,
            server_revision: 1,
            applied: vec![],
            conflicts: vec![SettlementConflictDto {
                operation_id: "atomic-1".to_string(),
                conflict: conflict("existing", "different"),
            }],
        });
        assert!(failed.is_err());
        let operations = store
            .outbound_operations("atomic", &[OutboundState::InFlight], 10)
            .unwrap();
        assert_eq!(operations.len(), 2);
        assert!(operations
            .iter()
            .all(|operation| operation.lease_token.as_deref() == Some(&claim.lease_token)));
        assert_eq!(store.sync_conflicts("atomic", true, 10).unwrap().len(), 1);
    }

    #[test]
    fn in_memory_failed_batch_settlement_rolls_back_every_operation() {
        assert_failed_settlement_is_atomic(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_failed_batch_settlement_rolls_back_every_operation() {
        assert_failed_settlement_is_atomic(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_committed_unknown_outcome_can_be_reconciled(store: &mut dyn CatalogStore) {
        store
            .enqueue_outbound_operations(
                "unknown",
                "create-batch",
                vec![operation("unknown-create")],
            )
            .unwrap();
        store
            .enqueue_outbound_operations("unknown", "later", vec![operation("must-wait")])
            .unwrap();
        let claim = store
            .claim_outbound_operations("unknown", 1, 10, 5)
            .unwrap()
            .unwrap();
        assert_eq!(store.recover_outbound_operations("unknown", 15).unwrap(), 1);
        assert!(store
            .claim_outbound_operations("unknown", 1, 16, 5)
            .unwrap()
            .is_none());
        let reconciled = store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "unknown".to_string(),
                batch_id: "create-batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                expected_attempt_token: claim.attempt_token,
                resolution: UnknownOutcomeResolution::Acked,
                reconciled_at: 17,
                operations: vec![ReconcileOperationDto {
                    operation_id: "unknown-create".to_string(),
                    base_revision: Some(12),
                    concurrency_token: Some("proved-by-pull".to_string()),
                }],
            })
            .unwrap();
        assert_eq!(reconciled[0].state, OutboundState::Acked);
        assert!(!reconciled[0].retry_eligible);
        assert_eq!(
            store
                .claim_outbound_operations("unknown", 1, 18, 5)
                .unwrap()
                .unwrap()
                .batch_id,
            "later"
        );
    }

    #[test]
    fn in_memory_unknown_committed_create_requires_pull_reconciliation() {
        assert_committed_unknown_outcome_can_be_reconciled(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_unknown_committed_create_requires_pull_reconciliation() {
        assert_committed_unknown_outcome_can_be_reconciled(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_batches_are_immutable(store: &mut dyn CatalogStore) {
        let first = operation("immutable-1");
        store
            .enqueue_outbound_operations("immutable", "batch", vec![first.clone()])
            .unwrap();
        assert!(store
            .enqueue_outbound_operations(
                "immutable",
                "batch",
                vec![first.clone(), operation("immutable-2")],
            )
            .is_err());
        assert_eq!(
            store
                .outbound_operations("immutable", &[OutboundState::Pending], 10)
                .unwrap()
                .len(),
            1
        );
        let claim = store
            .claim_outbound_operations("immutable", 1, 10, 10)
            .unwrap()
            .unwrap();
        let replay = store
            .enqueue_outbound_operations("immutable", "batch", vec![first])
            .unwrap();
        assert_eq!(replay[0].state, OutboundState::InFlight);
        assert_eq!(
            replay[0].lease_token.as_deref(),
            Some(claim.lease_token.as_str())
        );
    }

    #[test]
    fn in_memory_batches_are_immutable() {
        assert_batches_are_immutable(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_batches_are_immutable() {
        assert_batches_are_immutable(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn settle_conflicted_batch(
        store: &mut dyn CatalogStore,
        profile: &str,
        batch_id: &str,
        operation_id: &str,
        conflict_id: &str,
    ) {
        store
            .enqueue_outbound_operations(profile, batch_id, vec![operation(operation_id)])
            .unwrap();
        let claim = store
            .claim_outbound_operations(profile, 1, 10, 10)
            .unwrap()
            .unwrap();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: profile.to_string(),
                batch_id: batch_id.to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![],
                conflicts: vec![SettlementConflictDto {
                    operation_id: operation_id.to_string(),
                    conflict: conflict(conflict_id, "server conflict"),
                }],
            })
            .unwrap();
    }

    fn assert_failed_batch_dispositions(store: &mut dyn CatalogStore) {
        settle_conflicted_batch(store, "discard", "failed", "failed-op", "discard-conflict");
        store
            .enqueue_outbound_operations("discard", "later", vec![operation("later-op")])
            .unwrap();
        let conflict = store
            .sync_conflicts("discard", false, 10)
            .unwrap()
            .remove(0);
        assert_eq!(conflict.batch_id.as_deref(), Some("failed"));
        store
            .resolve_sync_conflict(
                "discard",
                "discard-conflict",
                ConflictResolution::AcceptServer,
                12,
                Some(DisposeFailedBatchDto {
                    profile_id: "discard".to_string(),
                    batch_id: "failed".to_string(),
                    batch_incarnation: conflict.batch_incarnation.clone().unwrap(),
                    expected_attempt_token: conflict.attempt_token.clone().unwrap(),
                    disposition: FailedBatchDisposition::Discard,
                    disposed_at: 12,
                    operations: vec![],
                }),
            )
            .unwrap();
        assert_eq!(
            store
                .claim_outbound_operations("discard", 1, 13, 10)
                .unwrap()
                .unwrap()
                .batch_id,
            "later"
        );

        settle_conflicted_batch(store, "correct", "failed", "correct-op", "correct-conflict");
        let conflict = store
            .sync_conflicts("correct", false, 10)
            .unwrap()
            .remove(0);
        store
            .resolve_sync_conflict(
                "correct",
                "correct-conflict",
                ConflictResolution::KeepLocal,
                12,
                Some(DisposeFailedBatchDto {
                    profile_id: "correct".to_string(),
                    batch_id: "failed".to_string(),
                    batch_incarnation: conflict.batch_incarnation.unwrap(),
                    expected_attempt_token: conflict.attempt_token.unwrap(),
                    disposition: FailedBatchDisposition::Requeue,
                    disposed_at: 12,
                    operations: vec![ReconcileOperationDto {
                        operation_id: "correct-op".to_string(),
                        base_revision: Some(44),
                        concurrency_token: Some("corrected".to_string()),
                    }],
                }),
            )
            .unwrap();
        let corrected = store
            .claim_outbound_operations("correct", 1, 13, 10)
            .unwrap()
            .unwrap();
        assert_eq!(corrected.operations[0].base_revision, Some(44));
        assert_eq!(
            corrected.operations[0].concurrency_token.as_deref(),
            Some("corrected")
        );
    }

    #[test]
    fn in_memory_failed_batches_can_be_discarded_or_corrected() {
        assert_failed_batch_dispositions(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_failed_batches_can_be_discarded_or_corrected() {
        assert_failed_batch_dispositions(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_per_operation_reconciliation(store: &mut dyn CatalogStore) {
        let mut first = operation("cas-1");
        first.base_revision = Some(1);
        first.concurrency_token = Some("one".to_string());
        let mut second = operation("cas-2");
        second.entity_id = "other".to_string();
        second.base_revision = Some(2);
        second.concurrency_token = Some("two".to_string());
        store
            .enqueue_outbound_operations("cas", "batch", vec![first, second])
            .unwrap();
        let claim = store
            .claim_outbound_operations("cas", 2, 10, 5)
            .unwrap()
            .unwrap();
        store.recover_outbound_operations("cas", 15).unwrap();
        assert!(store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "cas".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                expected_attempt_token: claim.attempt_token.clone(),
                resolution: UnknownOutcomeResolution::Requeue,
                reconciled_at: 16,
                operations: vec![ReconcileOperationDto {
                    operation_id: "cas-1".to_string(),
                    base_revision: Some(10),
                    concurrency_token: None,
                }],
            })
            .is_err());
        assert!(store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "cas".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                expected_attempt_token: claim.attempt_token.clone(),
                resolution: UnknownOutcomeResolution::Requeue,
                reconciled_at: 16,
                operations: vec![
                    ReconcileOperationDto {
                        operation_id: "cas-1".to_string(),
                        base_revision: None,
                        concurrency_token: None,
                    },
                    ReconcileOperationDto {
                        operation_id: "foreign".to_string(),
                        base_revision: None,
                        concurrency_token: None,
                    },
                ],
            })
            .is_err());
        let reconciled = store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "cas".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                expected_attempt_token: claim.attempt_token,
                resolution: UnknownOutcomeResolution::Requeue,
                reconciled_at: 16,
                operations: vec![
                    ReconcileOperationDto {
                        operation_id: "cas-1".to_string(),
                        base_revision: Some(10),
                        concurrency_token: None,
                    },
                    ReconcileOperationDto {
                        operation_id: "cas-2".to_string(),
                        base_revision: None,
                        concurrency_token: Some("updated-two".to_string()),
                    },
                ],
            })
            .unwrap();
        assert_eq!(reconciled[0].base_revision, Some(10));
        assert_eq!(reconciled[0].concurrency_token.as_deref(), Some("one"));
        assert_eq!(reconciled[1].base_revision, Some(2));
        assert_eq!(
            reconciled[1].concurrency_token.as_deref(),
            Some("updated-two")
        );
    }

    #[test]
    fn in_memory_reconciles_uncertain_operations_individually() {
        assert_per_operation_reconciliation(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_reconciles_uncertain_operations_individually() {
        assert_per_operation_reconciliation(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_delayed_settlement_does_not_regress_mapping(store: &mut dyn CatalogStore) {
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "merge".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("one".to_string()),
                server_revision: 10,
                applied_at: 10,
                entities: vec![collection_entity("remote-c", Some("local-c"), 10)],
                conflicts: vec![],
            })
            .unwrap();
        let mut update = operation("delayed");
        update.operation = SyncOperationKind::Update;
        store
            .enqueue_outbound_operations("merge", "delayed", vec![update.clone()])
            .unwrap();
        let claim = store
            .claim_outbound_operations("merge", 1, 11, 10)
            .unwrap()
            .unwrap();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "merge".to_string(),
                batch_id: "delayed".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token,
                settled_at: 12,
                server_revision: 10,
                applied: vec![AppliedOutboundResultDto {
                    operation_id: "delayed".to_string(),
                    remote_id: "remote-c".to_string(),
                    revision: 9,
                    concurrency_token: Some("old".to_string()),
                }],
                conflicts: vec![],
            })
            .unwrap();
        let mapping = store
            .entity_revision_by_remote("merge", SyncEntityType::ModelCollection, "remote-c")
            .unwrap()
            .unwrap();
        assert_eq!(mapping.revision, 10);
        assert!(mapping.snapshot.is_some());

        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "merge".to_string(),
                expected_checkpoint_generation: 1,
                expected_previous_cursor: Some("one".to_string()),
                cursor: Some("two".to_string()),
                server_revision: 12,
                applied_at: 13,
                entities: vec![tombstone(
                    SyncEntityType::ModelCollection,
                    "remote-c",
                    "local-c",
                    12,
                )],
                conflicts: vec![],
            })
            .unwrap();
        let mut equal = update;
        equal.operation_id = "equal".to_string();
        store
            .enqueue_outbound_operations("merge", "equal", vec![equal])
            .unwrap();
        let claim = store
            .claim_outbound_operations("merge", 1, 14, 10)
            .unwrap()
            .unwrap();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "merge".to_string(),
                batch_id: "equal".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token,
                settled_at: 15,
                server_revision: 12,
                applied: vec![AppliedOutboundResultDto {
                    operation_id: "equal".to_string(),
                    remote_id: "remote-c".to_string(),
                    revision: 12,
                    concurrency_token: Some("equal".to_string()),
                }],
                conflicts: vec![],
            })
            .unwrap();
        let mapping = store
            .entity_revision_by_remote("merge", SyncEntityType::ModelCollection, "remote-c")
            .unwrap()
            .unwrap();
        assert_eq!(mapping.revision, 12);
        assert!(mapping.tombstone);
        assert_eq!(mapping.visibility, SyncVisibility::Private);
        assert!(mapping.snapshot.is_none());
    }

    #[test]
    fn in_memory_mapping_merge_ignores_delayed_settlement() {
        assert_delayed_settlement_does_not_regress_mapping(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_mapping_merge_ignores_delayed_settlement() {
        assert_delayed_settlement_does_not_regress_mapping(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_pruning_respects_batch_boundaries(store: &mut dyn CatalogStore) {
        let first = operation("prune-1");
        let mut second = operation("prune-2");
        second.entity_id = "prune-local-2".to_string();
        store
            .enqueue_outbound_operations("prune", "batch", vec![first.clone(), second.clone()])
            .unwrap();
        let claim = store
            .claim_outbound_operations("prune", 2, 10, 10)
            .unwrap()
            .unwrap();
        let old_incarnation = claim.batch_incarnation.clone();
        let old_lease = claim.lease_token.clone();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "prune".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "prune-1".to_string(),
                        remote_id: "remote-prune-1".to_string(),
                        revision: 1,
                        concurrency_token: None,
                    },
                    AppliedOutboundResultDto {
                        operation_id: "prune-2".to_string(),
                        remote_id: "remote-prune-2".to_string(),
                        revision: 1,
                        concurrency_token: None,
                    },
                ],
                conflicts: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .prune_acked_outbound_operations("prune", 12, 1)
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .enqueue_outbound_operations("prune", "batch", vec![first.clone(), second.clone()],)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .prune_acked_outbound_operations("prune", 12, 2)
                .unwrap(),
            2
        );
        store
            .enqueue_outbound_operations("prune", "batch", vec![first, second])
            .unwrap();
        let recreated = store
            .claim_outbound_operations("prune", 2, 13, 10)
            .unwrap()
            .unwrap();
        assert_eq!(recreated.operations.len(), 2);
        assert_ne!(recreated.batch_incarnation, old_incarnation);
        assert!(store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "prune".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: old_incarnation,
                lease_token: old_lease,
                settled_at: 14,
                server_revision: 2,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "prune-1".to_string(),
                        remote_id: "stale-1".to_string(),
                        revision: 2,
                        concurrency_token: None,
                    },
                    AppliedOutboundResultDto {
                        operation_id: "prune-2".to_string(),
                        remote_id: "stale-2".to_string(),
                        revision: 2,
                        concurrency_token: None,
                    },
                ],
                conflicts: vec![],
            })
            .is_err());
    }

    #[test]
    fn in_memory_pruning_respects_batch_boundaries() {
        assert_pruning_respects_batch_boundaries(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_pruning_respects_batch_boundaries() {
        assert_pruning_respects_batch_boundaries(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_attempt_and_sibling_conflict_fencing(store: &mut dyn CatalogStore) {
        let mut sibling = operation("sibling-2");
        sibling.entity_id = "sibling-local-2".to_string();
        store
            .enqueue_outbound_operations("siblings", "batch", vec![operation("sibling-1"), sibling])
            .unwrap();
        let claim = store
            .claim_outbound_operations("siblings", 2, 10, 5)
            .unwrap()
            .unwrap();
        store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "siblings".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![],
                conflicts: vec![
                    SettlementConflictDto {
                        operation_id: "sibling-1".to_string(),
                        conflict: conflict("sibling-conflict-1", "first"),
                    },
                    SettlementConflictDto {
                        operation_id: "sibling-2".to_string(),
                        conflict: conflict("sibling-conflict-2", "second"),
                    },
                ],
            })
            .unwrap();
        let conflicts = store.sync_conflicts("siblings", false, 10).unwrap();
        let first = conflicts
            .iter()
            .find(|conflict| conflict.conflict_id == "sibling-conflict-1")
            .unwrap();
        let disposition = DisposeFailedBatchDto {
            profile_id: "siblings".to_string(),
            batch_id: "batch".to_string(),
            batch_incarnation: first.batch_incarnation.clone().unwrap(),
            expected_attempt_token: first.attempt_token.clone().unwrap(),
            disposition: FailedBatchDisposition::Discard,
            disposed_at: 12,
            operations: vec![],
        };
        assert!(store
            .resolve_sync_conflict(
                "siblings",
                "sibling-conflict-1",
                ConflictResolution::AcceptServer,
                12,
                Some(disposition.clone()),
            )
            .is_err());
        store
            .resolve_sync_conflict(
                "siblings",
                "sibling-conflict-1",
                ConflictResolution::AcceptServer,
                12,
                None,
            )
            .unwrap();
        store
            .resolve_sync_conflict(
                "siblings",
                "sibling-conflict-2",
                ConflictResolution::AcceptServer,
                13,
                Some(DisposeFailedBatchDto {
                    disposed_at: 13,
                    ..disposition
                }),
            )
            .unwrap();
        assert!(store
            .sync_conflicts("siblings", false, 10)
            .unwrap()
            .is_empty());

        store
            .enqueue_outbound_operations("attempts", "batch", vec![operation("attempt")])
            .unwrap();
        let attempt_a = store
            .claim_outbound_operations("attempts", 1, 20, 5)
            .unwrap()
            .unwrap();
        store.recover_outbound_operations("attempts", 25).unwrap();
        store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "attempts".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: attempt_a.batch_incarnation.clone(),
                expected_attempt_token: attempt_a.attempt_token.clone(),
                resolution: UnknownOutcomeResolution::Requeue,
                reconciled_at: 26,
                operations: vec![ReconcileOperationDto {
                    operation_id: "attempt".to_string(),
                    base_revision: None,
                    concurrency_token: None,
                }],
            })
            .unwrap();
        let attempt_b = store
            .claim_outbound_operations("attempts", 1, 27, 5)
            .unwrap()
            .unwrap();
        store.recover_outbound_operations("attempts", 32).unwrap();
        assert!(store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "attempts".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: attempt_a.batch_incarnation,
                expected_attempt_token: attempt_a.attempt_token,
                resolution: UnknownOutcomeResolution::Acked,
                reconciled_at: 33,
                operations: vec![ReconcileOperationDto {
                    operation_id: "attempt".to_string(),
                    base_revision: None,
                    concurrency_token: None,
                }],
            })
            .is_err());
        store
            .reconcile_uncertain_batch(ReconcileUncertainBatchDto {
                profile_id: "attempts".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: attempt_b.batch_incarnation,
                expected_attempt_token: attempt_b.attempt_token,
                resolution: UnknownOutcomeResolution::Acked,
                reconciled_at: 33,
                operations: vec![ReconcileOperationDto {
                    operation_id: "attempt".to_string(),
                    base_revision: None,
                    concurrency_token: None,
                }],
            })
            .unwrap();
    }

    #[test]
    fn in_memory_fences_attempts_and_sibling_conflicts() {
        assert_attempt_and_sibling_conflict_fencing(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_fences_attempts_and_sibling_conflicts() {
        assert_attempt_and_sibling_conflict_fencing(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn assert_conflicting_remote_settlement_rolls_back(store: &mut dyn CatalogStore) {
        store
            .apply_pull_batch(ApplyPullBatchDto {
                profile_id: "remote-conflict".to_string(),
                expected_checkpoint_generation: 0,
                expected_previous_cursor: None,
                cursor: Some("pulled".to_string()),
                server_revision: 300,
                applied_at: 1,
                entities: vec![tombstone(
                    SyncEntityType::ModelCollection,
                    "remote-old",
                    "local-c",
                    300,
                )],
                conflicts: vec![],
            })
            .unwrap();
        store
            .enqueue_outbound_operations(
                "remote-conflict",
                "batch",
                vec![operation("conflicting-result")],
            )
            .unwrap();
        let claim = store
            .claim_outbound_operations("remote-conflict", 1, 2, 10)
            .unwrap()
            .unwrap();
        assert!(store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "remote-conflict".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation.clone(),
                lease_token: claim.lease_token.clone(),
                settled_at: 3,
                server_revision: 300,
                applied: vec![AppliedOutboundResultDto {
                    operation_id: "conflicting-result".to_string(),
                    remote_id: "remote-new".to_string(),
                    revision: 200,
                    concurrency_token: None,
                }],
                conflicts: vec![],
            })
            .is_err());
        let operations = store
            .outbound_operations("remote-conflict", &[OutboundState::InFlight], 10)
            .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(
            operations[0].lease_token.as_deref(),
            Some(claim.lease_token.as_str())
        );
        assert!(store
            .entity_revision_by_remote(
                "remote-conflict",
                SyncEntityType::ModelCollection,
                "remote-new",
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn in_memory_rejects_conflicting_remote_settlement_before_ack() {
        assert_conflicting_remote_settlement_rolls_back(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_rejects_conflicting_remote_settlement_before_ack() {
        assert_conflicting_remote_settlement_rolls_back(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }

    fn claim_pair(
        store: &mut dyn CatalogStore,
        profile: &str,
        second_local_id: &str,
    ) -> ClaimedOutboundBatchDto {
        let first = operation(&format!("{profile}-1"));
        let mut second = operation(&format!("{profile}-2"));
        second.entity_id = second_local_id.to_string();
        store
            .enqueue_outbound_operations(profile, "batch", vec![first, second])
            .unwrap();
        store
            .claim_outbound_operations(profile, 2, 10, 10)
            .unwrap()
            .unwrap()
    }

    fn assert_staged_settlement_collisions(store: &mut dyn CatalogStore) {
        let claim = claim_pair(store, "two-locals", "local-other");
        assert!(store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "two-locals".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "two-locals-1".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 1,
                        concurrency_token: Some("same".to_string()),
                    },
                    AppliedOutboundResultDto {
                        operation_id: "two-locals-2".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 1,
                        concurrency_token: Some("same".to_string()),
                    },
                ],
                conflicts: vec![],
            })
            .is_err());
        assert_eq!(
            store
                .outbound_operations("two-locals", &[OutboundState::InFlight], 10)
                .unwrap()
                .len(),
            2
        );

        let claim = claim_pair(store, "two-remotes", "local-c");
        assert!(store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "two-remotes".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "two-remotes-1".to_string(),
                        remote_id: "remote-1".to_string(),
                        revision: 1,
                        concurrency_token: None,
                    },
                    AppliedOutboundResultDto {
                        operation_id: "two-remotes-2".to_string(),
                        remote_id: "remote-2".to_string(),
                        revision: 1,
                        concurrency_token: None,
                    },
                ],
                conflicts: vec![],
            })
            .is_err());
        assert_eq!(
            store
                .outbound_operations("two-remotes", &[OutboundState::InFlight], 10)
                .unwrap()
                .len(),
            2
        );

        let claim = claim_pair(store, "revision-conflict", "local-c");
        assert!(store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "revision-conflict".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 2,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "revision-conflict-1".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 1,
                        concurrency_token: None,
                    },
                    AppliedOutboundResultDto {
                        operation_id: "revision-conflict-2".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 2,
                        concurrency_token: None,
                    },
                ],
                conflicts: vec![],
            })
            .is_err());

        let claim = claim_pair(store, "compatible", "local-c");
        let settled = store
            .settle_outbound_batch(SettleOutboundBatchDto {
                profile_id: "compatible".to_string(),
                batch_id: "batch".to_string(),
                batch_incarnation: claim.batch_incarnation,
                lease_token: claim.lease_token,
                settled_at: 11,
                server_revision: 1,
                applied: vec![
                    AppliedOutboundResultDto {
                        operation_id: "compatible-1".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 1,
                        concurrency_token: Some("same".to_string()),
                    },
                    AppliedOutboundResultDto {
                        operation_id: "compatible-2".to_string(),
                        remote_id: "same-remote".to_string(),
                        revision: 1,
                        concurrency_token: Some("same".to_string()),
                    },
                ],
                conflicts: vec![],
            })
            .unwrap();
        assert!(settled
            .operations
            .iter()
            .all(|operation| operation.state == OutboundState::Acked));
        assert_eq!(
            store
                .entity_revisions("compatible", Some(SyncEntityType::ModelCollection), 10,)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn in_memory_stages_all_settlement_mapping_collisions() {
        assert_staged_settlement_collisions(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_stages_all_settlement_mapping_collisions() {
        assert_staged_settlement_collisions(
            &mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap(),
        );
    }
}
