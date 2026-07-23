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
use crate::rpc::{
    extract_vendor_metadata_dto, load_scene_dto, render_thumbnail_dto, CollectionDto,
    ImportPreviewDto, ImportResultDto, LogicalModelDto, ReconcileReportDto, TagDto,
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

/// Handle one decoded request, producing the response value or an error message.
/// `store` backs the stateful catalog methods; stateless methods ignore it.
fn dispatch(store: &mut dyn CatalogStore, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "handshake" => Ok(serde_json::json!({
            "protocolVersion": RPC_PROTOCOL_VERSION,
            "sidecarVersion": sidecar_version(),
        })),
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
        other => Err(format!("unknown method: {other}")),
    }
}

/// Turn one raw request line into a serialized response line. Returns `None` for
/// blank lines (which are ignored). Malformed envelopes yield a best-effort error
/// response with `id` 0 so the client can surface a protocol fault.
fn handle_line(store: &mut dyn CatalogStore, line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let response = match serde_json::from_str::<Request>(trimmed) {
        Ok(request) => match dispatch(store, &request.method, request.params) {
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
    mut output: W,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if let Some(response) = handle_line(store, &line) {
            output.write_all(response.as_bytes())?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}

/// Build the catalog store the serve loop threads through dispatch. With the
/// `sqlite` feature and a `db_path`, this is the persistent on-disk store;
/// otherwise it falls back to the ephemeral in-memory store.
#[cfg(feature = "sqlite")]
fn build_store(db_path: Option<PathBuf>) -> Box<dyn CatalogStore> {
    match db_path {
        Some(path) => match crate::sqlite_catalog::SqliteCatalog::open(&path) {
            Ok(store) => Box::new(store),
            Err(e) => {
                eprintln!(
                    "model-core: failed to open catalog db at {}: {e}; using in-memory catalog",
                    path.display()
                );
                Box::new(InMemoryCatalog::new())
            }
        },
        None => Box::new(InMemoryCatalog::new()),
    }
}

/// In-memory-only fallback for builds without the `sqlite` feature.
#[cfg(not(feature = "sqlite"))]
fn build_store(_db_path: Option<PathBuf>) -> Box<dyn CatalogStore> {
    Box::new(InMemoryCatalog::new())
}

/// Serve on the process's own stdin/stdout. This is the sidecar's default mode.
///
/// `db_path` selects the persistent SQLite catalog (when the `sqlite` feature is
/// compiled in); `None` uses an ephemeral in-memory catalog.
pub fn run_stdio(db_path: Option<PathBuf>) -> std::io::Result<()> {
    let mut store = build_store(db_path);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run(store.as_mut(), stdin.lock(), stdout.lock())
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
}
