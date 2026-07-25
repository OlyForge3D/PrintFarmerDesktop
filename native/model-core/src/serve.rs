//! Newline-delimited JSON-RPC transport spoken by the sidecar over stdio.
//!
//! The Electron main process launches this binary and exchanges one JSON object
//! per line: requests on the sidecar's stdin, responses on its stdout. Framing
//! is line-delimited because every message serde_json emits is single-line, and
//! it needs no length bookkeeping. Diagnostics go to stderr so they never
//! corrupt the response stream.
//!
//! Envelope:
//! - request:  `{"id":<u64>,"method":<string>,"params":<value>}`
//! - response: `{"id":<u64>,"ok":true,"result":<value>}`
//!   or `{"id":<u64>,"ok":false,"error":<string>}`
//!
//! Supported methods:
//! - `handshake` — params ignored; returns `{protocolVersion, sidecarVersion}`.
//! - `loadScene` — params `{"path":<string>}`; returns a [`crate::rpc::SceneMeshDto`].
//! - `extractVendorMetadata` — params `{"path":<string>}`; returns a
//!   [`crate::rpc::VendorMetadataDto`] (slicer identity, core metadata, per-plate
//!   slice stats, embedded thumbnail part names).
//! - `extractVendorPlateThumbnails` — params `{"path":<string>}`; returns
//!   [`crate::rpc::VendorPlateThumbnailsDto`] (part-name enumeration plus
//!   base64-encoded embedded PNG bytes).
//! - `renderThumbnail` — params `{"path":<string>,"size":<u32?>}`; returns a
//!   [`crate::rpc::ThumbnailDto`] (base64 PNG + pixel dimensions).
//! - `scanRoot` — params `{"rootId":<string>,"path":<string>}`; scans the folder,
//!   reconciles it into the catalog, and returns a [`crate::rpc::ReconcileReportDto`].
//! - `previewImport` — params `{"path":<string>}`; scans cheap file metadata and
//!   returns folder/count suggestions without mutating the catalog.
//! - `importRoot` — scans, reconciles, and applies explicit folder organization
//!   rules in one sidecar request.
//! - `listModels` — params ignored; returns all catalogued logical models as
//!   [`crate::rpc::LogicalModelDto`]s.
//! - `listFavorites`/`addFavorite`/`removeFavorite` — persist local-only
//!   favorite hashes in the catalog without exposing any filesystem or sync
//!   primitive to the renderer.
//! - Sync methods persist profile-scoped checkpoints, materialized revisions,
//!   remote model links, leased outbound operations, and conflict records. They
//!   never receive or store server locations or credentials.
//!
//! Stateful catalog methods read and write a persistent
//! [`crate::catalog::CatalogStore`] threaded through the serve loop. The shipped
//! binary uses the SQLite store when given `--catalog-db <path>`; otherwise (and
//! in tests) an ephemeral in-memory store is used.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::{reconcile_root, CatalogStore, InMemoryCatalog};
use crate::retarget::{
    PreflightReport, RetargetEngine, RetargetError, RetargetOptions, RetargetRpcOutcome,
    TargetReference,
};
use crate::rpc::{
    extract_vendor_metadata_dto, extract_vendor_plate_thumbnails_dto, load_scene_dto,
    render_thumbnail_dto, ApplyPullBatchDto, CollectionDto, ConflictInputDto, ConflictResolution,
    DisposeFailedBatchDto, EnqueueOutboundOperationDto, FailOutboundBatchDto, ImportPreviewDto,
    ImportResultDto, LogicalModelDto, OutboundState, ReconcileReportDto,
    ReconcileUncertainBatchDto, RemoteModelLinkDto, SettleOutboundBatchDto, SyncEntityType, TagDto,
};
use crate::smart_import::{ImportPlan, ImportRuleKind};
use crate::{sidecar_version, RPC_PROTOCOL_VERSION};

/// A decoded request envelope.
#[derive(Debug, Clone, Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Response envelope. Exactly one of `result`/`error` is present, keyed by `ok`.
#[derive(Debug, Clone, Serialize)]
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn err(id: u64, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetargetProfileParams {
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetargetPreflightParams {
    source_path: String,
    target: TargetReference,
    #[serde(default)]
    object_exclusion: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetargetBuildParams {
    source_path: String,
    output_path: String,
    target: TargetReference,
    #[serde(default)]
    object_exclusion: bool,
}

#[derive(Debug, Deserialize)]
struct ThumbnailParams {
    path: String,
    #[serde(default)]
    size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRootParams {
    root_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ImportRuleKindParam {
    Collection,
    Tag,
}

impl From<ImportRuleKindParam> for ImportRuleKind {
    fn from(value: ImportRuleKindParam) -> Self {
        match value {
            ImportRuleKindParam::Collection => Self::Collection,
            ImportRuleKindParam::Tag => Self::Tag,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRuleParam {
    relative_path: String,
    kind: ImportRuleKindParam,
    name: String,
    #[serde(default)]
    collection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRootParams {
    root_id: String,
    path: String,
    #[serde(default)]
    rules: Vec<ImportRuleParam>,
    #[serde(default)]
    common_tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HashParams {
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelTagParams {
    hash: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    tag_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionParams {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionMembershipParams {
    collection_id: String,
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedCollectionParams {
    profile_id: String,
    profile_binding: String,
    now: i64,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    is_shared: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileParams {
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindProfileParams {
    profile_id: String,
    profile_binding: String,
    now: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceProfileBindingParams {
    profile_id: String,
    expected_binding: String,
    new_binding: String,
    now: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteModelParams {
    profile_id: String,
    server_binding: String,
    local_model_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRemoteModelsParams {
    profile_id: String,
    server_binding: String,
    #[serde(default = "default_sync_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundProfileParams {
    profile_id: String,
    server_binding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListEntityRevisionsParams {
    profile_id: String,
    #[serde(default)]
    entity_type: Option<SyncEntityType>,
    #[serde(default = "default_sync_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueOutboundParams {
    profile_id: String,
    batch_id: String,
    operations: Vec<EnqueueOutboundOperationDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityRevisionLookupParams {
    profile_id: String,
    entity_type: SyncEntityType,
    #[serde(default)]
    remote_id: Option<String>,
    #[serde(default)]
    local_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListOutboundParams {
    profile_id: String,
    #[serde(default)]
    states: Vec<OutboundState>,
    #[serde(default = "default_sync_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboundBatchParams {
    profile_id: String,
    batch_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimOutboundParams {
    profile_id: String,
    #[serde(default = "default_sync_limit")]
    limit: usize,
    now: i64,
    lease_seconds: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoverOutboundParams {
    profile_id: String,
    now: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteOutboundParams {
    profile_id: String,
    operation_id: String,
    batch_incarnation: String,
    lease_token: String,
    completed_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailOutboundParams {
    profile_id: String,
    operation_id: String,
    batch_incarnation: String,
    lease_token: String,
    error: String,
    failed_at: i64,
    #[serde(default)]
    retry_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneOutboundParams {
    profile_id: String,
    acked_before: i64,
    #[serde(default = "default_sync_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordConflictsParams {
    profile_id: String,
    conflicts: Vec<ConflictInputDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListConflictsParams {
    profile_id: String,
    #[serde(default)]
    include_resolved: bool,
    #[serde(default = "default_sync_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveConflictParams {
    profile_id: String,
    conflict_id: String,
    resolution: ConflictResolution,
    resolved_at: i64,
    #[serde(default)]
    failed_disposition: Option<DisposeFailedBatchDto>,
}

const fn default_sync_limit() -> usize {
    500
}

fn validate_profile_binding_param(store: &dyn CatalogStore, params: &Value) -> Result<(), String> {
    let Some(binding) = params.get("profileBinding").and_then(Value::as_str) else {
        return Ok(());
    };
    let profile_id = params
        .get("profileId")
        .and_then(Value::as_str)
        .ok_or_else(|| "bound sync mutation requires profileId".to_string())?;
    store.validate_sync_profile_binding(profile_id, binding)
}

/// Handle one decoded request, producing the response value or an error message.
/// `store` backs the stateful catalog methods; stateless methods ignore it.
fn dispatch(
    store: &mut dyn CatalogStore,
    retarget: Option<&RetargetEngine>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "handshake" => Ok(serde_json::json!({
            "protocolVersion": RPC_PROTOCOL_VERSION,
            "sidecarVersion": sidecar_version(),
        })),
        "listRetargetProfiles" => serialize_retarget_outcome(match retarget {
            Some(engine) => match engine.list_bundled_profiles() {
                Ok(value) => RetargetRpcOutcome::ok(value),
                Err(error) => RetargetRpcOutcome::error(error),
            },
            None => RetargetRpcOutcome::error(retarget_not_configured()),
        }),
        "inspectRetargetProfile" => {
            let params: RetargetProfileParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid inspectRetargetProfile params: {e}"))?;
            serialize_retarget_outcome(match retarget {
                Some(engine) => match engine.inspect_bundled_profile(&params.profile_id) {
                    Ok(value) => RetargetRpcOutcome::ok(value),
                    Err(error) => RetargetRpcOutcome::error(error),
                },
                None => RetargetRpcOutcome::error(retarget_not_configured()),
            })
        }
        "inspectImportedRetargetProfile" => {
            let params: PathParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid inspectImportedRetargetProfile params: {e}"))?;
            serialize_retarget_outcome(match retarget {
                Some(engine) => match engine.inspect_imported_profile(PathBuf::from(params.path)) {
                    Ok(value) => RetargetRpcOutcome::ok(value),
                    Err(error) => RetargetRpcOutcome::error(error),
                },
                None => RetargetRpcOutcome::error(retarget_not_configured()),
            })
        }
        "preflightRetarget" => {
            let params: RetargetPreflightParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid preflightRetarget params: {e}"))?;
            let outcome = match retarget {
                Some(engine) => match engine.preflight_target(
                    PathBuf::from(params.source_path),
                    params.target,
                    RetargetOptions {
                        object_exclusion: params.object_exclusion,
                    },
                ) {
                    Ok(report) => preflight_outcome(report),
                    Err(error) => RetargetRpcOutcome::error(error),
                },
                None => RetargetRpcOutcome::error(retarget_not_configured()),
            };
            serialize_retarget_outcome(outcome)
        }
        "buildRetarget" => {
            let params: RetargetBuildParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid buildRetarget params: {e}"))?;
            let outcome = match retarget {
                Some(engine) => {
                    let options = RetargetOptions {
                        object_exclusion: params.object_exclusion,
                    };
                    match engine.preflight_target(
                        &params.source_path,
                        params.target.clone(),
                        options.clone(),
                    ) {
                        Ok(report) if !report.blockers.is_empty() => RetargetRpcOutcome::Blocked {
                            blockers: report.blockers.clone(),
                            warnings: report.warnings.clone(),
                            value: None,
                        },
                        Ok(_) => match engine.build(
                            params.source_path,
                            params.output_path,
                            params.target,
                            options,
                        ) {
                            Ok(value) => RetargetRpcOutcome::ok(value),
                            Err(error) => RetargetRpcOutcome::error(error),
                        },
                        Err(error) => RetargetRpcOutcome::error(error),
                    }
                }
                None => RetargetRpcOutcome::error(retarget_not_configured()),
            };
            serialize_retarget_outcome(outcome)
        }
        "validateRetargetOutput" => {
            let params: RetargetBuildParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid validateRetargetOutput params: {e}"))?;
            let outcome = match retarget {
                Some(engine) => match engine.validate_output(
                    params.source_path,
                    params.output_path,
                    params.target,
                    RetargetOptions {
                        object_exclusion: params.object_exclusion,
                    },
                ) {
                    Ok(report) if !report.valid => RetargetRpcOutcome::Blocked {
                        blockers: report.errors.clone(),
                        warnings: report.warnings.clone(),
                        value: Some(report),
                    },
                    Ok(value) => RetargetRpcOutcome::ok(value),
                    Err(error) => RetargetRpcOutcome::error(error),
                },
                None => RetargetRpcOutcome::error(retarget_not_configured()),
            };
            serialize_retarget_outcome(outcome)
        }
        "getSyncStatus" => {
            let params: ProfileParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid getSyncStatus params: {e}"))?;
            serde_json::to_value(store.sync_status(&params.profile_id)?)
                .map_err(|e| format!("failed to serialize sync status: {e}"))
        }
        "bindSyncProfile" => {
            let params: BindProfileParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid bindSyncProfile params: {e}"))?;
            serde_json::to_value(store.bind_sync_profile(
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?)
            .map_err(|e| format!("failed to serialize bound sync profile: {e}"))
        }
        "replaceSyncProfileBinding" => {
            let params: ReplaceProfileBindingParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid replaceSyncProfileBinding params: {e}"))?;
            serde_json::to_value(store.replace_sync_profile_binding(
                &params.profile_id,
                &params.expected_binding,
                &params.new_binding,
                params.now,
            )?)
            .map_err(|e| format!("failed to serialize replaced sync profile: {e}"))
        }
        "applySyncPullBatch" => {
            validate_profile_binding_param(store, &params)?;
            let batch: ApplyPullBatchDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid applySyncPullBatch params: {e}"))?;
            serde_json::to_value(store.apply_pull_batch(batch)?)
                .map_err(|e| format!("failed to serialize sync status: {e}"))
        }
        "linkRemoteModel" => {
            validate_profile_binding_param(store, &params)?;
            let link: RemoteModelLinkDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid linkRemoteModel params: {e}"))?;
            serde_json::to_value(store.link_remote_model(link)?)
                .map_err(|e| format!("failed to serialize remote model link: {e}"))
        }
        "getRemoteModelLink" => {
            let params: RemoteModelParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid getRemoteModelLink params: {e}"))?;
            serde_json::to_value(store.remote_model_link(
                &params.profile_id,
                &params.server_binding,
                &params.local_model_hash,
            )?)
            .map_err(|e| format!("failed to serialize remote model link: {e}"))
        }
        "listRemoteModelLinks" => {
            let params: ListRemoteModelsParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid listRemoteModelLinks params: {e}"))?;
            serde_json::to_value(store.remote_model_links(
                &params.profile_id,
                &params.server_binding,
                params.limit,
            )?)
            .map_err(|e| format!("failed to serialize remote model links: {e}"))
        }
        "removeRemoteModelLink" => {
            let params: RemoteModelParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid removeRemoteModelLink params: {e}"))?;
            serde_json::to_value(store.remove_remote_model_link(
                &params.profile_id,
                &params.server_binding,
                &params.local_model_hash,
            )?)
            .map_err(|e| format!("failed to serialize remote model link removal: {e}"))
        }
        "purgeRemoteModelLinks" => {
            let params: BoundProfileParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid purgeRemoteModelLinks params: {e}"))?;
            serde_json::to_value(
                store.purge_remote_model_links(&params.profile_id, &params.server_binding)?,
            )
            .map_err(|e| format!("failed to serialize remote model link purge: {e}"))
        }
        "listEntityRevisions" => {
            let params: ListEntityRevisionsParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid listEntityRevisions params: {e}"))?;
            serde_json::to_value(store.entity_revisions(
                &params.profile_id,
                params.entity_type,
                params.limit,
            )?)
            .map_err(|e| format!("failed to serialize entity revisions: {e}"))
        }
        "getEntityRevision" => {
            let params: EntityRevisionLookupParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid getEntityRevision params: {e}"))?;
            let revision = match (params.remote_id, params.local_id) {
                (Some(remote_id), None) => store.entity_revision_by_remote(
                    &params.profile_id,
                    params.entity_type,
                    &remote_id,
                )?,
                (None, Some(local_id)) => store.entity_revision_by_local(
                    &params.profile_id,
                    params.entity_type,
                    &local_id,
                )?,
                _ => {
                    return Err(
                        "getEntityRevision requires exactly one of remoteId/localId".to_string()
                    )
                }
            };
            serde_json::to_value(revision)
                .map_err(|e| format!("failed to serialize entity revision: {e}"))
        }
        "enqueueOutboundOperations" => {
            validate_profile_binding_param(store, &params)?;
            let params: EnqueueOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid enqueueOutboundOperations params: {e}"))?;
            serde_json::to_value(store.enqueue_outbound_operations(
                &params.profile_id,
                &params.batch_id,
                params.operations,
            )?)
            .map_err(|e| format!("failed to serialize outbound operations: {e}"))
        }
        "listOutboundOperations" => {
            let params: ListOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid listOutboundOperations params: {e}"))?;
            serde_json::to_value(store.outbound_operations(
                &params.profile_id,
                &params.states,
                params.limit,
            )?)
            .map_err(|e| format!("failed to serialize outbound operations: {e}"))
        }
        "getOutboundBatch" => {
            let params: OutboundBatchParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid getOutboundBatch params: {e}"))?;
            serde_json::to_value(store.outbound_batch(&params.profile_id, &params.batch_id)?)
                .map_err(|e| format!("failed to serialize outbound batch: {e}"))
        }
        "claimOutboundOperations" => {
            validate_profile_binding_param(store, &params)?;
            let params: ClaimOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid claimOutboundOperations params: {e}"))?;
            serde_json::to_value(store.claim_outbound_operations(
                &params.profile_id,
                params.limit,
                params.now,
                params.lease_seconds,
            )?)
            .map_err(|e| format!("failed to serialize outbound operations: {e}"))
        }
        "recoverOutboundOperations" => {
            validate_profile_binding_param(store, &params)?;
            let params: RecoverOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid recoverOutboundOperations params: {e}"))?;
            Ok(serde_json::json!({
                "markedUncertain": store.recover_outbound_operations(&params.profile_id, params.now)?
            }))
        }
        "failOutboundBatch" => {
            validate_profile_binding_param(store, &params)?;
            let failure: FailOutboundBatchDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid failOutboundBatch params: {e}"))?;
            serde_json::to_value(store.fail_outbound_batch(failure)?)
                .map_err(|e| format!("failed to serialize outbound batch failure: {e}"))
        }
        "completeOutboundOperation" => {
            let params: CompleteOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid completeOutboundOperation params: {e}"))?;
            serde_json::to_value(store.complete_outbound_operation(
                &params.profile_id,
                &params.operation_id,
                &params.batch_incarnation,
                &params.lease_token,
                params.completed_at,
            )?)
            .map_err(|e| format!("failed to serialize outbound operation: {e}"))
        }
        "failOutboundOperation" => {
            let params: FailOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid failOutboundOperation params: {e}"))?;
            serde_json::to_value(store.fail_outbound_operation(
                &params.profile_id,
                &params.operation_id,
                &params.batch_incarnation,
                &params.lease_token,
                &params.error,
                params.failed_at,
                params.retry_at,
            )?)
            .map_err(|e| format!("failed to serialize outbound operation: {e}"))
        }
        "settleOutboundBatch" => {
            validate_profile_binding_param(store, &params)?;
            let settlement: SettleOutboundBatchDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid settleOutboundBatch params: {e}"))?;
            serde_json::to_value(store.settle_outbound_batch(settlement)?)
                .map_err(|e| format!("failed to serialize outbound settlement: {e}"))
        }
        "reconcileUncertainBatch" => {
            validate_profile_binding_param(store, &params)?;
            let reconciliation: ReconcileUncertainBatchDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid reconcileUncertainBatch params: {e}"))?;
            serde_json::to_value(store.reconcile_uncertain_batch(reconciliation)?)
                .map_err(|e| format!("failed to serialize reconciled batch: {e}"))
        }
        "disposeFailedBatch" => {
            let disposition: DisposeFailedBatchDto = serde_json::from_value(params)
                .map_err(|e| format!("invalid disposeFailedBatch params: {e}"))?;
            serde_json::to_value(store.dispose_failed_batch(disposition)?)
                .map_err(|e| format!("failed to serialize failed batch disposition: {e}"))
        }
        "pruneAckedOutboundOperations" => {
            let params: PruneOutboundParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid pruneAckedOutboundOperations params: {e}"))?;
            Ok(serde_json::json!({
                "pruned": store.prune_acked_outbound_operations(
                    &params.profile_id,
                    params.acked_before,
                    params.limit,
                )?
            }))
        }
        "recordSyncConflicts" => {
            let params: RecordConflictsParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid recordSyncConflicts params: {e}"))?;
            serde_json::to_value(store.record_sync_conflicts(&params.profile_id, params.conflicts)?)
                .map_err(|e| format!("failed to serialize sync conflicts: {e}"))
        }
        "listSyncConflicts" => {
            let params: ListConflictsParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid listSyncConflicts params: {e}"))?;
            serde_json::to_value(store.sync_conflicts(
                &params.profile_id,
                params.include_resolved,
                params.limit,
            )?)
            .map_err(|e| format!("failed to serialize sync conflicts: {e}"))
        }
        "resolveSyncConflict" => {
            let params: ResolveConflictParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid resolveSyncConflict params: {e}"))?;
            serde_json::to_value(store.resolve_sync_conflict(
                &params.profile_id,
                &params.conflict_id,
                params.resolution,
                params.resolved_at,
                params.failed_disposition,
            )?)
            .map_err(|e| format!("failed to serialize sync conflict: {e}"))
        }
        "loadScene" => {
            let params: PathParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid loadScene params: {e}"))?;
            let dto = load_scene_dto(&PathBuf::from(&params.path))
                .map_err(|e| format!("failed to load scene: {e}"))?;
            serde_json::to_value(dto).map_err(|e| format!("failed to serialize scene: {e}"))
        }
        "extractVendorMetadata" => {
            let params: PathParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid extractVendorMetadata params: {e}"))?;
            let dto = extract_vendor_metadata_dto(&PathBuf::from(&params.path))
                .map_err(|e| format!("failed to extract vendor metadata: {e}"))?;
            serde_json::to_value(dto)
                .map_err(|e| format!("failed to serialize vendor metadata: {e}"))
        }
        "extractVendorPlateThumbnails" => {
            let params: PathParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid extractVendorPlateThumbnails params: {e}"))?;
            let dto = extract_vendor_plate_thumbnails_dto(&PathBuf::from(&params.path))
                .map_err(|e| format!("failed to extract vendor plate thumbnails: {e}"))?;
            serde_json::to_value(dto)
                .map_err(|e| format!("failed to serialize vendor plate thumbnails: {e}"))
        }
        "renderThumbnail" => {
            let params: ThumbnailParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid renderThumbnail params: {e}"))?;
            let dto = render_thumbnail_dto(&PathBuf::from(&params.path), params.size)
                .map_err(|e| format!("failed to render thumbnail: {e}"))?;
            serde_json::to_value(dto).map_err(|e| format!("failed to serialize thumbnail: {e}"))
        }
        "scanRoot" => {
            let params: ScanRootParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid scanRoot params: {e}"))?;
            let scan =
                crate::scan::scan_root(&PathBuf::from(&params.path), &AtomicBool::new(false));
            let report = reconcile_root(store, &params.root_id, &scan);
            serde_json::to_value(ReconcileReportDto::from(&report))
                .map_err(|e| format!("failed to serialize reconcile report: {e}"))
        }
        "previewImport" => {
            let params: PathParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid previewImport params: {e}"))?;
            let scan =
                crate::scan::scan_root(&PathBuf::from(&params.path), &AtomicBool::new(false));
            let preview = crate::smart_import::preview_scan(&scan);
            serde_json::to_value(ImportPreviewDto::from(&preview))
                .map_err(|e| format!("failed to serialize import preview: {e}"))
        }
        "importRoot" => {
            let params: ImportRootParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid importRoot params: {e}"))?;
            let plan = ImportPlan::new(
                params.rules.into_iter().map(|rule| {
                    (
                        rule.relative_path,
                        ImportRuleKind::from(rule.kind),
                        rule.name,
                        rule.collection_id,
                    )
                }),
                params.common_tags,
            )
            .map_err(|e| format!("invalid import plan: {e}"))?;
            let scan =
                crate::scan::scan_root(&PathBuf::from(&params.path), &AtomicBool::new(false));
            let result = crate::smart_import::import_root(store, &params.root_id, &scan, &plan)
                .map_err(|e| format!("failed to import root: {e}"))?;
            serde_json::to_value(ImportResultDto::from(&result))
                .map_err(|e| format!("failed to serialize import result: {e}"))
        }
        "listModels" => {
            let models: Vec<LogicalModelDto> =
                store.models().iter().map(LogicalModelDto::from).collect();
            serde_json::to_value(models).map_err(|e| format!("failed to serialize models: {e}"))
        }
        "listFavorites" => serde_json::to_value(store.favorite_hashes())
            .map_err(|e| format!("failed to serialize favorites: {e}")),
        "addFavorite" => {
            let params: HashParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid addFavorite params: {e}"))?;
            store.add_favorite(&params.hash);
            serde_json::to_value(store.favorite_hashes())
                .map_err(|e| format!("failed to serialize favorites: {e}"))
        }
        "removeFavorite" => {
            let params: HashParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid removeFavorite params: {e}"))?;
            store.remove_favorite(&params.hash);
            serde_json::to_value(store.favorite_hashes())
                .map_err(|e| format!("failed to serialize favorites: {e}"))
        }
        "listTags" => {
            let tags: Vec<TagDto> = store.all_tags().iter().map(TagDto::from).collect();
            serde_json::to_value(tags).map_err(|e| format!("failed to serialize tags: {e}"))
        }
        "tagsForModel" => {
            let params: HashParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid tagsForModel params: {e}"))?;
            let tags: Vec<TagDto> = store
                .tags_for_model(&params.hash)
                .iter()
                .map(TagDto::from)
                .collect();
            serde_json::to_value(tags).map_err(|e| format!("failed to serialize tags: {e}"))
        }
        "addModelTag" => {
            let params: ModelTagParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid addModelTag params: {e}"))?;
            let name = params
                .name
                .ok_or_else(|| "addModelTag requires a name".to_string())?;
            store.add_model_tag(&params.hash, &name);
            let tags: Vec<TagDto> = store
                .tags_for_model(&params.hash)
                .iter()
                .map(TagDto::from)
                .collect();
            serde_json::to_value(tags).map_err(|e| format!("failed to serialize tags: {e}"))
        }
        "removeModelTag" => {
            let params: ModelTagParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid removeModelTag params: {e}"))?;
            let tag_id = params
                .tag_id
                .ok_or_else(|| "removeModelTag requires a tagId".to_string())?;
            store.remove_model_tag(&params.hash, &tag_id);
            let tags: Vec<TagDto> = store
                .tags_for_model(&params.hash)
                .iter()
                .map(TagDto::from)
                .collect();
            serde_json::to_value(tags).map_err(|e| format!("failed to serialize tags: {e}"))
        }
        "listCollections" => {
            let collections: Vec<CollectionDto> = store
                .all_collections()
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "collectionsForModel" => {
            let params: HashParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid collectionsForModel params: {e}"))?;
            let collections: Vec<CollectionDto> = store
                .collections_for_model(&params.hash)
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "createCollection" => {
            let params: CollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid createCollection params: {e}"))?;
            let name = params
                .name
                .ok_or_else(|| "createCollection requires a name".to_string())?;
            let created = store
                .create_collection(&name)
                .ok_or_else(|| "collection name must not be blank".to_string())?;
            serde_json::to_value(CollectionDto::from(&created))
                .map_err(|e| format!("failed to serialize collection: {e}"))
        }
        "createCollectionWithSync" => {
            let params: SyncedCollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid createCollectionWithSync params: {e}"))?;
            let created = store.create_collection_with_sync(
                params
                    .name
                    .as_deref()
                    .ok_or_else(|| "createCollectionWithSync requires name".to_string())?,
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?;
            serde_json::to_value(CollectionDto::from(&created))
                .map_err(|e| format!("failed to serialize collection: {e}"))
        }
        "updateCollectionWithSync" => {
            let params: SyncedCollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid updateCollectionWithSync params: {e}"))?;
            let updated = store.update_collection_with_sync(
                params
                    .id
                    .as_deref()
                    .ok_or_else(|| "updateCollectionWithSync requires id".to_string())?,
                params
                    .name
                    .as_deref()
                    .ok_or_else(|| "updateCollectionWithSync requires name".to_string())?,
                params.is_shared.unwrap_or(false),
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?;
            serde_json::to_value(CollectionDto::from(&updated))
                .map_err(|e| format!("failed to serialize collection: {e}"))
        }
        "deleteCollection" => {
            let params: CollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid deleteCollection params: {e}"))?;
            let id = params
                .id
                .ok_or_else(|| "deleteCollection requires an id".to_string())?;
            store.delete_collection(&id);
            let collections: Vec<CollectionDto> = store
                .all_collections()
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "deleteCollectionWithSync" => {
            let params: SyncedCollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid deleteCollectionWithSync params: {e}"))?;
            store.delete_collection_with_sync(
                params
                    .id
                    .as_deref()
                    .ok_or_else(|| "deleteCollectionWithSync requires id".to_string())?,
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?;
            let collections: Vec<CollectionDto> = store
                .all_collections()
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "addModelToCollection" => {
            let params: CollectionMembershipParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid addModelToCollection params: {e}"))?;
            store.add_model_to_collection(&params.collection_id, &params.hash);
            let collections: Vec<CollectionDto> = store
                .collections_for_model(&params.hash)
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "addModelToCollectionWithSync" => {
            let params: SyncedCollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid addModelToCollectionWithSync params: {e}"))?;
            let id = params
                .id
                .as_deref()
                .ok_or_else(|| "addModelToCollectionWithSync requires id".to_string())?;
            let hash = params
                .hash
                .as_deref()
                .ok_or_else(|| "addModelToCollectionWithSync requires hash".to_string())?;
            store.add_model_to_collection_with_sync(
                id,
                hash,
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?;
            let collections: Vec<CollectionDto> = store
                .collections_for_model(hash)
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "removeModelFromCollection" => {
            let params: CollectionMembershipParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid removeModelFromCollection params: {e}"))?;
            store.remove_model_from_collection(&params.collection_id, &params.hash);
            let collections: Vec<CollectionDto> = store
                .collections_for_model(&params.hash)
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        "removeModelFromCollectionWithSync" => {
            let params: SyncedCollectionParams = serde_json::from_value(params)
                .map_err(|e| format!("invalid removeModelFromCollectionWithSync params: {e}"))?;
            let id = params
                .id
                .as_deref()
                .ok_or_else(|| "removeModelFromCollectionWithSync requires id".to_string())?;
            let hash = params
                .hash
                .as_deref()
                .ok_or_else(|| "removeModelFromCollectionWithSync requires hash".to_string())?;
            store.remove_model_from_collection_with_sync(
                id,
                hash,
                &params.profile_id,
                &params.profile_binding,
                params.now,
            )?;
            let collections: Vec<CollectionDto> = store
                .collections_for_model(hash)
                .iter()
                .map(CollectionDto::from)
                .collect();
            serde_json::to_value(collections)
                .map_err(|e| format!("failed to serialize collections: {e}"))
        }
        other => Err(format!("unknown method: {other}")),
    }
}

/// Turn one raw request line into a serialized response line. Returns `None` for
/// blank lines (which are ignored). Malformed envelopes yield a best-effort error
/// response with `id` 0 so the client can surface a protocol fault.
#[cfg(test)]
fn handle_line(store: &mut dyn CatalogStore, line: &str) -> Option<String> {
    handle_line_with_retarget(store, None, line)
}

fn handle_line_with_retarget(
    store: &mut dyn CatalogStore,
    retarget: Option<&RetargetEngine>,
    line: &str,
) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let response = match serde_json::from_str::<Request>(trimmed) {
        Ok(request) => match dispatch(store, retarget, &request.method, request.params) {
            Ok(result) => Response::ok(request.id, result),
            Err(message) => Response::err(request.id, message),
        },
        Err(e) => Response::err(0, format!("malformed request: {e}")),
    };

    // Serialization of our own Response type cannot fail in practice; if it ever
    // did, fall back to a minimal hand-written error envelope.
    Some(serde_json::to_string(&response).unwrap_or_else(|_| {
        format!(
            "{{\"id\":{},\"ok\":false,\"error\":\"response serialization failed\"}}",
            response.id
        )
    }))
}

/// Run the blocking request/response loop until the input stream closes.
///
/// Each line read from `input` is dispatched against `store` and its response
/// written to `output`, flushed immediately so the client never waits on
/// buffering.
pub fn run<R: BufRead, W: Write>(
    store: &mut dyn CatalogStore,
    input: R,
    output: W,
) -> std::io::Result<()> {
    run_with_retarget(store, None, input, output)
}

pub fn run_with_retarget<R: BufRead, W: Write>(
    store: &mut dyn CatalogStore,
    retarget: Option<&RetargetEngine>,
    input: R,
    mut output: W,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if let Some(response) = handle_line_with_retarget(store, retarget, &line) {
            output.write_all(response.as_bytes())?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}

/// Build the catalog store the serve loop threads through dispatch. With the
/// `sqlite` feature and a `db_path`, this is the persistent on-disk store;
/// otherwise it uses the ephemeral in-memory store. A requested persistent
/// catalog is never silently replaced when opening or migrating it fails.
#[cfg(feature = "sqlite")]
fn build_store(db_path: Option<PathBuf>) -> std::io::Result<Box<dyn CatalogStore>> {
    match db_path {
        Some(path) => crate::sqlite_catalog::SqliteCatalog::open(&path)
            .map(|store| Box::new(store) as Box<dyn CatalogStore>)
            .map_err(|error| {
                std::io::Error::other(format!(
                    "failed to open catalog db at {}: {error}",
                    path.display()
                ))
            }),
        None => Ok(Box::new(InMemoryCatalog::new())),
    }
}

/// In-memory-only fallback for builds without the `sqlite` feature.
#[cfg(not(feature = "sqlite"))]
fn build_store(db_path: Option<PathBuf>) -> std::io::Result<Box<dyn CatalogStore>> {
    if db_path.is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "persistent catalog requested but SQLite support is not compiled in",
        ));
    }
    Ok(Box::new(InMemoryCatalog::new()))
}

/// Serve on the process's own stdin/stdout. This is the sidecar's default mode.
///
/// `db_path` selects the persistent SQLite catalog (when the `sqlite` feature is
/// compiled in); `None` uses an ephemeral in-memory catalog.
pub fn run_stdio(db_path: Option<PathBuf>) -> std::io::Result<()> {
    run_stdio_with_retarget(db_path, None)
}

pub fn run_stdio_with_retarget(
    db_path: Option<PathBuf>,
    target_profiles_dir: Option<PathBuf>,
) -> std::io::Result<()> {
    let mut store = build_store(db_path)?;
    let retarget = target_profiles_dir
        .map(|path| {
            RetargetEngine::open(&path, Default::default()).map_err(|error| {
                std::io::Error::other(format!(
                    "failed to open retarget profiles at {}: {error}",
                    path.display()
                ))
            })
        })
        .transpose()?;
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run_with_retarget(
        store.as_mut(),
        retarget.as_ref(),
        stdin.lock(),
        stdout.lock(),
    )
}

fn serialize_retarget_outcome<T: Serialize>(
    outcome: RetargetRpcOutcome<T>,
) -> Result<Value, String> {
    serde_json::to_value(outcome)
        .map_err(|error| format!("failed to serialize retarget outcome: {error}"))
}

fn preflight_outcome(report: PreflightReport) -> RetargetRpcOutcome<PreflightReport> {
    if report.blockers.is_empty() {
        RetargetRpcOutcome::ok(report)
    } else {
        RetargetRpcOutcome::Blocked {
            blockers: report.blockers.clone(),
            warnings: report.warnings.clone(),
            value: Some(report),
        }
    }
}

fn retarget_not_configured() -> RetargetError {
    RetargetError::new(
        crate::retarget::IssueCode::ProfileManifestInvalid,
        "retarget profile bundle was not configured at startup",
        "Launch the sidecar with --target-profiles-dir <bundle-root>.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convenience wrapper: dispatch a single line against a throwaway in-memory
    /// catalog. Stateful methods that need a shared store across calls construct
    /// their own store and call `handle_line` directly.
    fn hl(line: &str) -> Option<String> {
        let mut store = InMemoryCatalog::new();
        handle_line(&mut store, line)
    }

    #[test]
    fn handshake_returns_versions() {
        let out = hl(r#"{"id":7,"method":"handshake","params":{}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["protocolVersion"], RPC_PROTOCOL_VERSION);
        assert_eq!(v["result"]["sidecarVersion"], sidecar_version());
    }

    #[test]
    fn handshake_tolerates_missing_params() {
        let out = hl(r#"{"id":1,"method":"handshake"}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
    }

    #[test]
    fn unknown_method_is_an_error_response() {
        let out = hl(r#"{"id":2,"method":"nope","params":{}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 2);
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown method"));
    }

    #[test]
    fn malformed_request_reports_id_zero() {
        let out = hl("not json").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 0);
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("malformed request"));
    }

    #[test]
    fn blank_lines_are_ignored() {
        assert!(hl("   ").is_none());
        assert!(hl("").is_none());
    }

    #[test]
    fn load_scene_reports_missing_file_as_error() {
        let out =
            hl(r#"{"id":3,"method":"loadScene","params":{"path":"does-not-exist.stl"}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 3);
        assert_eq!(v["ok"], false);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .contains("failed to load scene"));
    }

    #[test]
    fn load_scene_parses_a_binary_stl_over_the_wire() {
        // Minimal binary STL: 80-byte header, u32 triangle count, one triangle.
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        // normal
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&1f32.to_le_bytes());
        // three vertices
        for v in [[0f32, 0f32, 0f32], [1f32, 0f32, 0f32], [0f32, 1f32, 0f32]] {
            for c in v {
                bytes.extend_from_slice(&c.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&0u16.to_le_bytes()); // attribute byte count

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tri.stl");
        std::fs::write(&path, &bytes).unwrap();

        let request = serde_json::json!({
            "id": 9,
            "method": "loadScene",
            "params": { "path": path.to_string_lossy() },
        });
        let out = hl(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 9);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(v["result"]["sourceFormat"], "stl");
        assert_eq!(v["result"]["positions"].as_array().unwrap().len(), 9);
        assert_eq!(v["result"]["indices"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn extract_vendor_metadata_reports_missing_file_as_error() {
        let out = hl(r#"{"id":4,"method":"extractVendorMetadata","params":{"path":"nope.3mf"}}"#)
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 4);
        assert_eq!(v["ok"], false);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .contains("failed to extract vendor metadata"));
    }

    #[test]
    fn extract_vendor_plate_thumbnails_reports_missing_file_as_error() {
        let out =
            hl(r#"{"id":5,"method":"extractVendorPlateThumbnails","params":{"path":"nope.3mf"}}"#)
                .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 5);
        assert_eq!(v["ok"], false);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .contains("failed to extract vendor plate thumbnails"));
    }

    #[test]
    fn extract_vendor_metadata_over_the_wire() {
        use std::io::Write;
        use zip::write::{SimpleFileOptions, ZipWriter};
        use zip::CompressionMethod;

        let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>"#;
        let model = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Wire Widget</metadata>
  <metadata name="Application">BambuStudio-01.08.00.55</metadata>
  <resources><object id="1" type="model"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object></resources>
  <build><item objectid="1"/></build>
</model>"#;

        let mut buf = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, bytes) in [
                ("_rels/.rels", rels.as_bytes()),
                ("3D/3dmodel.model", model.as_bytes()),
                ("Metadata/plate_1.png", b"\x89PNG\r\n\x1a\nx" as &[u8]),
            ] {
                writer.start_file(name, opts).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.3mf");
        std::fs::write(&path, &buf).unwrap();

        let request = serde_json::json!({
            "id": 11,
            "method": "extractVendorMetadata",
            "params": { "path": path.to_string_lossy() },
        });
        let out = hl(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 11);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(v["result"]["slicer"], "bambuStudio");
        assert_eq!(v["result"]["core"]["title"], "Wire Widget");
        assert_eq!(v["result"]["thumbnails"][0], "Metadata/plate_1.png");
    }

    #[test]
    fn extract_vendor_plate_thumbnails_over_the_wire() {
        use std::io::Write;
        use zip::write::{SimpleFileOptions, ZipWriter};
        use zip::CompressionMethod;

        let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>"#;
        let model = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Wire Widget</metadata>
  <metadata name="Application">BambuStudio-01.08.00.55</metadata>
  <resources><object id="1" type="model"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object></resources>
  <build><item objectid="1"/></build>
</model>"#;

        let mut buf = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, bytes) in [
                ("_rels/.rels", rels.as_bytes()),
                ("3D/3dmodel.model", model.as_bytes()),
                ("Metadata/plate_1.png", b"\x89PNG\r\n\x1a\nx" as &[u8]),
            ] {
                writer.start_file(name, opts).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.3mf");
        std::fs::write(&path, &buf).unwrap();

        let request = serde_json::json!({
            "id": 12,
            "method": "extractVendorPlateThumbnails",
            "params": { "path": path.to_string_lossy() },
        });
        let out = hl(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 12);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(
            v["result"]["thumbnails"][0]["partName"],
            "Metadata/plate_1.png"
        );
        assert_eq!(v["result"]["thumbnails"][0]["plateIndex"], 1);
        assert_eq!(v["result"]["thumbnails"][0]["pngBase64"], "iVBORw0KGgp4");
    }

    #[test]
    fn render_thumbnail_over_the_wire() {
        // Minimal binary STL: header, count, one triangle.
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&1f32.to_le_bytes());
        for v in [[0f32, 0f32, 0f32], [1f32, 0f32, 0f32], [0f32, 1f32, 0f32]] {
            for c in v {
                bytes.extend_from_slice(&c.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tri.stl");
        std::fs::write(&path, &bytes).unwrap();

        let request = serde_json::json!({
            "id": 13,
            "method": "renderThumbnail",
            "params": { "path": path.to_string_lossy(), "size": 32 },
        });
        let out = hl(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 13);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(v["result"]["width"], 32);
        assert!(!v["result"]["pngBase64"].as_str().unwrap().is_empty());
    }

    #[test]
    fn run_processes_a_stream_of_requests() {
        let input = concat!(
            "{\"id\":1,\"method\":\"handshake\"}\n",
            "\n",
            "{\"id\":2,\"method\":\"handshake\"}\n",
        );
        let mut output = Vec::new();
        let mut store = InMemoryCatalog::new();
        run(&mut store, input.as_bytes(), &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        // Two responses; the blank line produced none.
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(second["id"], 2);
    }

    #[test]
    fn scan_root_then_list_models_over_the_wire() {
        // A folder with one binary STL should reconcile into one logical model
        // that a subsequent listModels call returns — proving shared state.
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes.extend_from_slice(&1f32.to_le_bytes());
        for v in [[0f32, 0f32, 0f32], [1f32, 0f32, 0f32], [0f32, 1f32, 0f32]] {
            for c in v {
                bytes.extend_from_slice(&c.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("part.stl"), &bytes).unwrap();

        let mut store = InMemoryCatalog::new();

        let scan_req = serde_json::json!({
            "id": 1,
            "method": "scanRoot",
            "params": { "rootId": "root1", "path": dir.path().to_string_lossy() },
        });
        let out = handle_line(&mut store, &scan_req.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true, "scan response was {v}");
        assert_eq!(v["result"]["added"], 1);

        let list_req = serde_json::json!({ "id": 2, "method": "listModels" });
        let out = handle_line(&mut store, &list_req.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true, "list response was {v}");
        let models = v["result"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["format"], "stl");
        assert_eq!(models[0]["locations"].as_array().unwrap().len(), 1);
        assert_eq!(models[0]["locations"][0]["available"], true);
    }

    #[test]
    fn favorite_rpc_round_trips_hashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("part.stl"), b"stl").unwrap();
        let mut store = InMemoryCatalog::new();
        let scan_req = serde_json::json!({
            "id": 1,
            "method": "scanRoot",
            "params": { "rootId": "root1", "path": dir.path().to_string_lossy() },
        });
        let _ = handle_line(&mut store, &scan_req.to_string()).unwrap();
        let hash = store.models()[0].hash.clone();

        let add_req = serde_json::json!({
            "id": 2,
            "method": "addFavorite",
            "params": { "hash": hash },
        });
        let add_value: Value =
            serde_json::from_str(&handle_line(&mut store, &add_req.to_string()).unwrap()).unwrap();
        assert_eq!(add_value["ok"], true);
        assert_eq!(add_value["result"][0], hash);

        let list_req = serde_json::json!({ "id": 3, "method": "listFavorites" });
        let list_value: Value =
            serde_json::from_str(&handle_line(&mut store, &list_req.to_string()).unwrap()).unwrap();
        assert_eq!(list_value["result"][0], hash);
    }

    #[test]
    fn scan_root_rejects_malformed_params() {
        let mut store = InMemoryCatalog::new();
        let out = handle_line(
            &mut store,
            r#"{"id":5,"method":"scanRoot","params":{"path":"/tmp"}}"#,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .contains("invalid scanRoot params"));
    }

    #[test]
    fn previews_import_without_mutating_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Animals/Cats")).unwrap();
        std::fs::write(dir.path().join("Animals/Cats/cat.stl"), b"cat").unwrap();
        std::fs::write(dir.path().join("Animals/dog.3mf"), b"dog").unwrap();
        let mut store = InMemoryCatalog::new();

        let request = serde_json::json!({
            "id": 20,
            "method": "previewImport",
            "params": { "path": dir.path().to_string_lossy() },
        });
        let out = handle_line(&mut store, &request.to_string()).unwrap();
        let value: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(value["ok"], true, "preview response was {value}");
        assert_eq!(value["result"]["modelCount"], 2);
        assert_eq!(value["result"]["complete"], true);
        assert_eq!(value["result"]["formats"]["stl"], 1);
        assert_eq!(value["result"]["formats"]["threeMf"], 1);
        assert_eq!(value["result"]["folders"][0]["relativePath"], "Animals");
        assert!(store.models().is_empty());
    }

    #[test]
    fn imports_and_organizes_folder_rules_over_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Animals/Cats")).unwrap();
        std::fs::write(dir.path().join("Animals/Cats/cat.stl"), b"cat").unwrap();
        let mut store = InMemoryCatalog::new();

        let request = serde_json::json!({
            "id": 21,
            "method": "importRoot",
            "params": {
                "rootId": "pets",
                "path": dir.path().to_string_lossy(),
                "rules": [
                    { "relativePath": "", "kind": "collection", "name": "My Models" },
                    { "relativePath": "Animals/Cats", "kind": "tag", "name": "cat" }
                ],
                "commonTags": ["printable"]
            },
        });
        let out = handle_line(&mut store, &request.to_string()).unwrap();
        let value: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(value["ok"], true, "import response was {value}");
        assert_eq!(value["result"]["report"]["added"], 1);
        assert_eq!(value["result"]["modelsOrganized"], 1);
        assert_eq!(value["result"]["collectionsCreated"], 1);
        assert_eq!(value["result"]["collectionAssignments"], 1);
        assert_eq!(value["result"]["tagAssignments"], 2);
        assert_eq!(
            value["result"]["resolvedCollections"][0]["relativePath"],
            ""
        );
        assert!(value["result"]["resolvedCollections"][0]["collectionId"]
            .as_str()
            .unwrap()
            .starts_with("col-"));
        let imported = store.models().pop().unwrap();
        assert_eq!(store.collections_for_model(&imported.hash).len(), 1);
        assert_eq!(store.tags_for_model(&imported.hash).len(), 2);
    }

    #[test]
    fn rejects_unsafe_import_rules_before_scanning() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("part.stl"), b"part").unwrap();
        let mut store = InMemoryCatalog::new();
        let request = serde_json::json!({
            "id": 22,
            "method": "importRoot",
            "params": {
                "rootId": "root",
                "path": dir.path().to_string_lossy(),
                "rules": [
                    { "relativePath": "../outside", "kind": "tag", "name": "bad" }
                ]
            },
        });

        let out = handle_line(&mut store, &request.to_string()).unwrap();
        let value: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(value["ok"], false);
        assert!(value["error"]
            .as_str()
            .unwrap()
            .contains("invalid import plan"));
        assert!(store.models().is_empty());
    }

    #[test]
    fn sync_rpc_applies_profile_scoped_pull_and_outbox_operations() {
        let mut store = InMemoryCatalog::new();
        let pull = serde_json::json!({
            "id": 30,
            "method": "applySyncPullBatch",
            "params": {
                "profileId": "profile-a",
                "expectedCheckpointGeneration": 0,
                "cursor": "opaque",
                "serverRevision": 4,
                "appliedAt": 10,
                "entities": [{
                    "entityType": "Tag",
                    "remoteId": "tag-1",
                    "revision": 4,
                    "tombstone": true,
                    "visibility": "Shared"
                }]
            }
        });
        let value: Value =
            serde_json::from_str(&handle_line(&mut store, &pull.to_string()).unwrap()).unwrap();
        assert_eq!(value["ok"], true, "{value}");
        assert_eq!(value["result"]["cursor"], "opaque");

        let lookup = serde_json::json!({
            "id": 34,
            "method": "getEntityRevision",
            "params": {
                "profileId": "profile-a",
                "entityType": "Tag",
                "remoteId": "tag-1"
            }
        });
        let value: Value =
            serde_json::from_str(&handle_line(&mut store, &lookup.to_string()).unwrap()).unwrap();
        assert_eq!(value["result"]["remoteId"], "tag-1");

        let other = serde_json::json!({
            "id": 31,
            "method": "getSyncStatus",
            "params": { "profileId": "profile-b" }
        });
        let value: Value =
            serde_json::from_str(&handle_line(&mut store, &other.to_string()).unwrap()).unwrap();
        assert_eq!(value["result"]["serverRevision"], 0);

        let enqueue = serde_json::json!({
            "id": 32,
            "method": "enqueueOutboundOperations",
            "params": {
                "profileId": "profile-a",
                "batchId": "batch-1",
                "operations": [{
                    "operationId": "op-1",
                    "entityType": "ModelCollection",
                    "operation": "Create",
                    "entityId": "local-1",
                    "payload": {"name": "Dragons"},
                    "createdAt": 10
                }]
            }
        });
        let value: Value =
            serde_json::from_str(&handle_line(&mut store, &enqueue.to_string()).unwrap()).unwrap();
        assert_eq!(value["result"][0]["state"], "pending");
        assert_eq!(value["result"][0]["operationId"], "op-1");
    }

    #[test]
    fn sync_rpc_rejects_pull_only_tag_pushes() {
        let mut store = InMemoryCatalog::new();
        let request = serde_json::json!({
            "id": 33,
            "method": "enqueueOutboundOperations",
            "params": {
                "profileId": "profile-a",
                "batchId": "tag-batch",
                "operations": [{
                    "operationId": "tag-op",
                    "entityType": "Tag",
                    "operation": "Update",
                    "entityId": "tag-1",
                    "payload": {},
                    "createdAt": 10
                }]
            }
        });
        let value: Value =
            serde_json::from_str(&handle_line(&mut store, &request.to_string()).unwrap()).unwrap();
        assert_eq!(value["ok"], false);
        assert!(value["error"].as_str().unwrap().contains("pull-only"));
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn persistent_store_open_failures_are_not_silently_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.sqlite3");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", crate::schema::SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(build_store(Some(path)).is_err());
    }
}
