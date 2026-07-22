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

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::{extract_vendor_metadata_dto, load_scene_dto};
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

/// Handle one decoded request, producing the response value or an error message.
fn dispatch(method: &str, params: Value) -> Result<Value, String> {
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
        other => Err(format!("unknown method: {other}")),
    }
}

/// Turn one raw request line into a serialized response line. Returns `None` for
/// blank lines (which are ignored). Malformed envelopes yield a best-effort error
/// response with `id` 0 so the client can surface a protocol fault.
fn handle_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let response = match serde_json::from_str::<Request>(trimmed) {
        Ok(request) => match dispatch(&request.method, request.params) {
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
/// Each line read from `input` is dispatched and its response written to
/// `output`, flushed immediately so the client never waits on buffering.
pub fn run<R: BufRead, W: Write>(input: R, mut output: W) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if let Some(response) = handle_line(&line) {
            output.write_all(response.as_bytes())?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}

/// Serve on the process's own stdin/stdout. This is the sidecar's default mode.
pub fn run_stdio() -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run(stdin.lock(), stdout.lock())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_returns_versions() {
        let out = handle_line(r#"{"id":7,"method":"handshake","params":{}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["protocolVersion"], RPC_PROTOCOL_VERSION);
        assert_eq!(v["result"]["sidecarVersion"], sidecar_version());
    }

    #[test]
    fn handshake_tolerates_missing_params() {
        let out = handle_line(r#"{"id":1,"method":"handshake"}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
    }

    #[test]
    fn unknown_method_is_an_error_response() {
        let out = handle_line(r#"{"id":2,"method":"nope","params":{}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 2);
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown method"));
    }

    #[test]
    fn malformed_request_reports_id_zero() {
        let out = handle_line("not json").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 0);
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("malformed request"));
    }

    #[test]
    fn blank_lines_are_ignored() {
        assert!(handle_line("   ").is_none());
        assert!(handle_line("").is_none());
    }

    #[test]
    fn load_scene_reports_missing_file_as_error() {
        let out =
            handle_line(r#"{"id":3,"method":"loadScene","params":{"path":"does-not-exist.stl"}}"#)
                .unwrap();
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
        let out = handle_line(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 9);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(v["result"]["sourceFormat"], "stl");
        assert_eq!(v["result"]["positions"].as_array().unwrap().len(), 9);
        assert_eq!(v["result"]["indices"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn extract_vendor_metadata_reports_missing_file_as_error() {
        let out = handle_line(
            r#"{"id":4,"method":"extractVendorMetadata","params":{"path":"nope.3mf"}}"#,
        )
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
        let out = handle_line(&request.to_string()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 11);
        assert_eq!(v["ok"], true, "response was {v}");
        assert_eq!(v["result"]["slicer"], "bambuStudio");
        assert_eq!(v["result"]["core"]["title"], "Wire Widget");
        assert_eq!(v["result"]["thumbnails"][0], "Metadata/plate_1.png");
    }

    #[test]
    fn run_processes_a_stream_of_requests() {
        let input = concat!(
            "{\"id\":1,\"method\":\"handshake\"}\n",
            "\n",
            "{\"id\":2,\"method\":\"handshake\"}\n",
        );
        let mut output = Vec::new();
        run(input.as_bytes(), &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        // Two responses; the blank line produced none.
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(second["id"], 2);
    }
}
