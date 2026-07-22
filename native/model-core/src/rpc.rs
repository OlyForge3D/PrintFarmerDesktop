//! RPC data-transfer objects: the wire shape the sidecar sends to the Electron
//! renderer, kept deliberately separate from the internal geometry types.
//!
//! The renderer's viewer expects flat arrays (xyz-interleaved positions,
//! triple-packed indices, and rgb-interleaved per-triangle colors), so this
//! module flattens [`crate::scene::SceneMesh`] and serializes with `camelCase`
//! field names to match the shared Zod contract in `src/shared/ipc.ts`
//! (`SceneMesh`: `positions`, `indices`, `bounds`, `sourceFormat`,
//! `faceColors`).

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::model::ModelFormat;
use crate::scene::{self, SceneError, SceneMesh};
use crate::threemf::ThreeMfError;
use crate::thumbnail::{self, ThumbnailError, DEFAULT_THUMBNAIL_SIZE};
use crate::vendor;

/// Axis-aligned bounds in wire form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundsDto {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// The renderer-facing scene mesh: a normalized, flattened, indexed triangle
/// mesh. Mirrors the `SceneMesh` Zod schema field-for-field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneMeshDto {
    /// Vertex positions, xyz-interleaved (`len % 3 == 0`).
    pub positions: Vec<f32>,
    /// Triangle vertex indices, triple-packed (`len % 3 == 0`).
    pub indices: Vec<u32>,
    pub bounds: BoundsDto,
    /// `"stl"` or `"threeMf"` (from `ModelFormat`'s camelCase serde names).
    pub source_format: ModelFormat,
    /// One rgb triple per triangle, rgb-interleaved, when the source carried
    /// per-facet colors. Omitted from JSON when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_colors: Option<Vec<u8>>,
}

impl From<&SceneMesh> for SceneMeshDto {
    fn from(mesh: &SceneMesh) -> Self {
        let positions = mesh.positions.iter().flat_map(|p| *p).collect();
        let indices = mesh.indices.clone();
        let face_colors = mesh
            .face_colors
            .as_ref()
            .map(|colors| colors.iter().flat_map(|rgb| *rgb).collect());
        Self {
            positions,
            indices,
            bounds: BoundsDto {
                min: mesh.bounds.min,
                max: mesh.bounds.max,
            },
            source_format: mesh.source_format,
            face_colors,
        }
    }
}

/// Load a model file and return the renderer-facing scene DTO.
pub fn load_scene_dto(path: &Path) -> Result<SceneMeshDto, SceneError> {
    Ok(SceneMeshDto::from(&scene::load_scene(path)?))
}

/// Core model metadata in wire form. Every field is optional; absent fields are
/// omitted from JSON rather than serialized as null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMetadataDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub designer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modification_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_terms: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copyright: Option<String>,
}

impl From<&vendor::CoreMetadata> for CoreMetadataDto {
    fn from(c: &vendor::CoreMetadata) -> Self {
        Self {
            title: c.title.clone(),
            designer: c.designer.clone(),
            description: c.description.clone(),
            application: c.application.clone(),
            creation_date: c.creation_date.clone(),
            modification_date: c.modification_date.clone(),
            license_terms: c.license_terms.clone(),
            copyright: c.copyright.clone(),
        }
    }
}

/// Per-plate slice statistics in wire form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSliceInfoDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prediction_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_grams: Option<f64>,
    pub filament_types: Vec<String>,
}

impl From<&vendor::PlateSliceInfo> for PlateSliceInfoDto {
    fn from(p: &vendor::PlateSliceInfo) -> Self {
        Self {
            index: p.index,
            prediction_seconds: p.prediction_seconds,
            weight_grams: p.weight_grams,
            filament_types: p.filament_types.clone(),
        }
    }
}

/// Vendor (slicer-project) metadata in renderer-facing wire form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorMetadataDto {
    /// Slicer identity as a camelCase string enum (e.g. `"bambuStudio"`).
    pub slicer: String,
    pub core: CoreMetadataDto,
    pub plates: Vec<PlateSliceInfoDto>,
    /// ZIP part names of embedded plate thumbnails, sorted for determinism.
    pub thumbnails: Vec<String>,
}

impl From<&vendor::VendorMetadata> for VendorMetadataDto {
    fn from(m: &vendor::VendorMetadata) -> Self {
        Self {
            slicer: m.slicer.as_str().to_string(),
            core: CoreMetadataDto::from(&m.core),
            plates: m.plates.iter().map(PlateSliceInfoDto::from).collect(),
            thumbnails: m.parts.thumbnails.clone(),
        }
    }
}

/// Extract slicer-project (vendor) metadata and return the wire DTO.
pub fn extract_vendor_metadata_dto(path: &Path) -> Result<VendorMetadataDto, ThreeMfError> {
    Ok(VendorMetadataDto::from(&vendor::extract_file(path)?))
}

/// A rendered thumbnail in wire form: PNG bytes carried as base64 so they fit
/// the JSON-RPC transport, plus the pixel dimensions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDto {
    pub width: u32,
    pub height: u32,
    /// Standard base64 (with padding) of the encoded PNG.
    pub png_base64: String,
}

/// Errors from the load-then-render thumbnail pipeline.
#[derive(Debug, thiserror::Error)]
pub enum ThumbnailPipelineError {
    #[error(transparent)]
    Scene(#[from] SceneError),
    #[error(transparent)]
    Thumbnail(#[from] ThumbnailError),
}

/// Load a model file and render a square PNG thumbnail, returned as a base64
/// wire DTO. `size` falls back to [`DEFAULT_THUMBNAIL_SIZE`] when `None`.
pub fn render_thumbnail_dto(
    path: &Path,
    size: Option<u32>,
) -> Result<ThumbnailDto, ThumbnailPipelineError> {
    let mesh = scene::load_scene(path)?;
    let edge = size.unwrap_or(DEFAULT_THUMBNAIL_SIZE);
    let png = thumbnail::render_png(&mesh, edge)?;
    Ok(ThumbnailDto {
        width: edge,
        height: edge,
        png_base64: BASE64.encode(png),
    })
}

/// A physical file backing a logical model, in wire form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLocationDto {
    pub root_id: String,
    /// Absolute path on disk.
    pub path: String,
    /// Path relative to its source root.
    pub root_relative: String,
    pub size: u64,
    /// Whether the file was present at the last reconciliation.
    pub available: bool,
}

impl From<&crate::catalog::ModelLocation> for ModelLocationDto {
    fn from(loc: &crate::catalog::ModelLocation) -> Self {
        Self {
            root_id: loc.root_id.clone(),
            path: loc.path.to_string_lossy().into_owned(),
            root_relative: loc.root_relative.to_string_lossy().into_owned(),
            size: loc.fingerprint.size,
            available: loc.available,
        }
    }
}

/// A logical model (content-hash identity) plus its physical locations, in wire
/// form. Mirrors the `LogicalModel` Zod schema in `src/shared/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalModelDto {
    /// Lowercase hex SHA-256 of the file bytes; the model's stable identity.
    pub hash: String,
    /// `"stl"` or `"threeMf"` (from `ModelFormat`'s camelCase serde names).
    pub format: ModelFormat,
    pub size: u64,
    pub locations: Vec<ModelLocationDto>,
}

impl From<&crate::catalog::LogicalModel> for LogicalModelDto {
    fn from(model: &crate::catalog::LogicalModel) -> Self {
        Self {
            hash: model.hash.clone(),
            format: model.format,
            size: model.size,
            locations: model.locations.iter().map(ModelLocationDto::from).collect(),
        }
    }
}

/// A user-defined organizational label, in wire form. Mirrors the `Tag` Zod
/// schema in `src/shared/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDto {
    pub id: String,
    pub name: String,
}

impl From<&crate::catalog::Tag> for TagDto {
    fn from(tag: &crate::catalog::Tag) -> Self {
        Self {
            id: tag.id.clone(),
            name: tag.name.clone(),
        }
    }
}

/// Summary of one reconciliation pass over a source root, in wire form. Mirrors
/// the `ReconcileReport` Zod schema in `src/shared/ipc.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReportDto {
    pub added: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub hash_errors: usize,
}

impl From<&crate::catalog::ReconcileReport> for ReconcileReportDto {
    fn from(r: &crate::catalog::ReconcileReport) -> Self {
        Self {
            added: r.added,
            changed: r.changed,
            unchanged: r.unchanged,
            missing: r.missing,
            hash_errors: r.hash_errors,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Aabb;
    use crate::scene::SceneMesh;

    fn sample_scene() -> SceneMesh {
        let mut bounds = Aabb::empty();
        for v in [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]] {
            bounds.expand(v);
        }
        SceneMesh {
            positions: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]],
            indices: vec![0, 1, 2],
            bounds,
            source_format: ModelFormat::ThreeMf,
            face_colors: None,
        }
    }

    #[test]
    fn flattens_indexed_mesh_into_wire_arrays() {
        let dto = SceneMeshDto::from(&sample_scene());
        assert_eq!(
            dto.positions,
            vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0, 0.0]
        );
        assert_eq!(dto.indices, vec![0, 1, 2]);
        assert_eq!(dto.bounds.max, [2.0, 3.0, 0.0]);
        assert!(dto.face_colors.is_none());
    }

    #[test]
    fn flattens_face_colors_when_present() {
        let mut scene = sample_scene();
        scene.source_format = ModelFormat::Stl;
        scene.face_colors = Some(vec![[255, 0, 0], [0, 255, 0]]);
        let dto = SceneMeshDto::from(&scene);
        assert_eq!(dto.face_colors, Some(vec![255, 0, 0, 0, 255, 0]));
    }

    #[test]
    fn serializes_with_camel_case_field_names() {
        let dto = SceneMeshDto::from(&sample_scene());
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"sourceFormat\":\"threeMf\""));
        assert!(json.contains("\"positions\""));
        assert!(json.contains("\"indices\""));
        // Absent colors are omitted, not serialized as null.
        assert!(!json.contains("faceColors"));
    }

    #[test]
    fn vendor_metadata_dto_serializes_camel_case_and_omits_empty() {
        let md = vendor::VendorMetadata {
            slicer: vendor::Slicer::OrcaSlicer,
            core: vendor::CoreMetadata {
                title: Some("Widget".to_string()),
                application: Some("OrcaSlicer-2.1.0".to_string()),
                ..Default::default()
            },
            plates: vec![vendor::PlateSliceInfo {
                index: Some(1),
                prediction_seconds: Some(3600),
                weight_grams: Some(12.5),
                filament_types: vec!["PLA".to_string()],
            }],
            parts: vendor::VendorParts {
                thumbnails: vec!["Metadata/plate_1.png".to_string()],
            },
        };
        let dto = VendorMetadataDto::from(&md);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"slicer\":\"orcaSlicer\""));
        assert!(json.contains("\"predictionSeconds\":3600"));
        assert!(json.contains("\"weightGrams\":12.5"));
        assert!(json.contains("\"filamentTypes\":[\"PLA\"]"));
        assert!(json.contains("\"thumbnails\":[\"Metadata/plate_1.png\"]"));
        // Absent core fields are omitted, not null.
        assert!(!json.contains("designer"));
        // Round-trips.
        let parsed: VendorMetadataDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, dto);
    }

    #[test]
    fn renders_a_thumbnail_dto_from_a_scene() {
        // Build a tiny binary STL on disk and run the load-then-render pipeline.
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

        let dto = render_thumbnail_dto(&path, Some(32)).unwrap();
        assert_eq!(dto.width, 32);
        assert_eq!(dto.height, 32);
        // Decodes to a PNG (8-byte signature).
        let png = BASE64.decode(dto.png_base64).unwrap();
        assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn thumbnail_pipeline_reports_unsupported_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.obj");
        std::fs::write(&path, b"nope").unwrap();
        assert!(render_thumbnail_dto(&path, None).is_err());
    }

    #[test]
    fn logical_model_dto_serializes_camel_case() {
        use crate::catalog::{LogicalModel, ModelLocation};
        use crate::model::FileFingerprint;
        use std::path::PathBuf;

        let model = LogicalModel {
            hash: "abc123".to_string(),
            format: ModelFormat::Stl,
            size: 2048,
            locations: vec![ModelLocation {
                root_id: "root1".to_string(),
                path: PathBuf::from("/models/part.stl"),
                root_relative: PathBuf::from("part.stl"),
                fingerprint: FileFingerprint::new(2048, None),
                available: true,
            }],
        };
        let dto = LogicalModelDto::from(&model);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"hash\":\"abc123\""));
        assert!(json.contains("\"format\":\"stl\""));
        assert!(json.contains("\"rootRelative\":\"part.stl\""));
        assert!(json.contains("\"available\":true"));
        let parsed: LogicalModelDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, dto);
    }

    #[test]
    fn reconcile_report_dto_round_trips() {
        let report = crate::catalog::ReconcileReport {
            added: 3,
            changed: 1,
            unchanged: 5,
            missing: 2,
            hash_errors: 0,
        };
        let dto = ReconcileReportDto::from(&report);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"hashErrors\":0"));
        let parsed: ReconcileReportDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, dto);
    }
}
