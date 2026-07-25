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
use crate::scene::{
    self, SceneError, SceneMaterial, SceneMesh, SceneObject, SceneObjectMesh, ScenePlate,
    SceneTransform,
};
use crate::scene_status::SceneLoadStatus;
use crate::threemf::ThreeMfError;
use crate::thumbnail::{self, ThumbnailError, DEFAULT_THUMBNAIL_SIZE};
use crate::vendor;

pub use crate::sync::{
    AppliedOutboundResultDto, ApplyPullBatchDto, ClaimedOutboundBatchDto, CollectionSnapshotDto,
    ConflictInputDto, ConflictResolution, DisposeFailedBatchDto, EnqueueOutboundOperationDto,
    EntityRevisionDto, FailOutboundBatchDto, FailedBatchDisposition, MembershipSnapshotDto,
    OutboundFailureOutcome, OutboundOperationDto, OutboundState, PullEntityDto,
    ReconcileOperationDto, ReconcileUncertainBatchDto, RemoteModelLinkDto, RemoteUploadStatus,
    SettleOutboundBatchDto, SettledOutboundBatchDto, SettlementConflictDto, SyncConflictDto,
    SyncEntityType, SyncOperationKind, SyncStatusDto, SyncVisibility, TagSnapshotDto,
    UnknownOutcomeResolution,
};

/// Axis-aligned bounds in wire form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundsDto {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// A named triangle range in wire form. Mirrors the `ScenePart` Zod schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePartDto {
    pub name: String,
    pub triangle_start: usize,
    pub triangle_count: usize,
    pub status: SceneLoadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransformDto {
    pub matrix: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneMaterialDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_color: Option<[u8; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_colors: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneObjectMeshDto {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub bounds: BoundsDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneObjectDto {
    pub id: String,
    pub source_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub transform: SceneTransformDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh: Option<SceneObjectMeshDto>,
    pub material: SceneMaterialDto,
    pub plate_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_item_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePlateDto {
    pub id: String,
    pub name: String,
    pub index: usize,
    pub root_object_ids: Vec<String>,
}

/// The renderer-facing scene mesh: a normalized, flattened, indexed triangle
/// mesh. Mirrors the `SceneMesh` Zod schema field-for-field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneMeshDto {
    /// Independent schema version for the scene payload carried over JSON-RPC.
    pub scene_version: u32,
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
    pub status: SceneLoadStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub status_messages: Vec<String>,
    /// Named triangle ranges backing the viewer's part tree.
    pub parts: Vec<ScenePartDto>,
    /// Hierarchical object instances. Each object owns its local transform and,
    /// when renderable, its local mesh/material payload.
    pub objects: Vec<SceneObjectDto>,
    /// Stable ids of the scene graph roots, in display order.
    pub root_object_ids: Vec<String>,
    /// Plate groupings for root objects.
    pub plates: Vec<ScenePlateDto>,
}

impl From<&SceneMesh> for SceneMeshDto {
    fn from(mesh: &SceneMesh) -> Self {
        let positions = mesh.positions.iter().flat_map(|p| *p).collect();
        let indices = mesh.indices.clone();
        let face_colors = mesh
            .face_colors
            .as_ref()
            .map(|colors| colors.iter().flat_map(|rgb| *rgb).collect());
        let parts = mesh
            .parts
            .iter()
            .map(|p| ScenePartDto {
                name: p.name.clone(),
                triangle_start: p.triangle_start,
                triangle_count: p.triangle_count,
                status: p.status,
                status_detail: p.status_detail.clone(),
                part_number: p.part_number.clone(),
                material_label: p.material_label.clone(),
            })
            .collect();
        let objects = mesh.objects.iter().map(SceneObjectDto::from).collect();
        let plates = mesh.plates.iter().map(ScenePlateDto::from).collect();
        Self {
            scene_version: mesh.scene_version,
            positions,
            indices,
            bounds: BoundsDto {
                min: mesh.bounds.min,
                max: mesh.bounds.max,
            },
            source_format: mesh.source_format,
            face_colors,
            status: mesh.status,
            status_messages: mesh.status_messages.clone(),
            parts,
            objects,
            root_object_ids: mesh.root_object_ids.clone(),
            plates,
        }
    }
}

impl From<&SceneTransform> for SceneTransformDto {
    fn from(transform: &SceneTransform) -> Self {
        Self {
            matrix: transform.matrix.to_vec(),
        }
    }
}

impl From<&SceneMaterial> for SceneMaterialDto {
    fn from(material: &SceneMaterial) -> Self {
        Self {
            base_color: material.base_color,
            face_colors: material
                .face_colors
                .as_ref()
                .map(|colors| colors.iter().flat_map(|rgb| *rgb).collect()),
        }
    }
}

impl From<&SceneObjectMesh> for SceneObjectMeshDto {
    fn from(mesh: &SceneObjectMesh) -> Self {
        Self {
            positions: mesh.positions.iter().flat_map(|p| *p).collect(),
            indices: mesh.indices.clone(),
            bounds: BoundsDto {
                min: mesh.bounds.min,
                max: mesh.bounds.max,
            },
        }
    }
}

impl From<&SceneObject> for SceneObjectDto {
    fn from(object: &SceneObject) -> Self {
        Self {
            id: object.id.clone(),
            source_id: object.source_id.clone(),
            name: object.name.clone(),
            parent_id: object.parent_id.clone(),
            children: object.children.clone(),
            transform: SceneTransformDto::from(&object.transform),
            mesh: object.mesh.as_ref().map(SceneObjectMeshDto::from),
            material: SceneMaterialDto::from(&object.material),
            plate_id: object.plate_id.clone(),
            build_item_index: object.build_item_index,
        }
    }
}

impl From<&ScenePlate> for ScenePlateDto {
    fn from(plate: &ScenePlate) -> Self {
        Self {
            id: plate.id.clone(),
            name: plate.name.clone(),
            index: plate.index,
            root_object_ids: plate.root_object_ids.clone(),
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

/// One embedded vendor plate thumbnail in wire form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorPlateThumbnailDto {
    /// ZIP part name inside the 3MF package, e.g. `Metadata/plate_1.png`.
    pub part_name: String,
    /// Parsed from the conventional `plate_<n>.png` filename when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plate_index: Option<u32>,
    /// Standard base64 (with padding) of the embedded PNG bytes.
    pub png_base64: String,
}

impl From<&vendor::PlateThumbnail> for VendorPlateThumbnailDto {
    fn from(thumbnail: &vendor::PlateThumbnail) -> Self {
        Self {
            part_name: thumbnail.part_name.clone(),
            plate_index: thumbnail.plate_index,
            png_base64: BASE64.encode(&thumbnail.png_bytes),
        }
    }
}

/// Embedded vendor plate thumbnails in renderer-facing wire form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorPlateThumbnailsDto {
    pub thumbnails: Vec<VendorPlateThumbnailDto>,
}

/// Extract embedded plate thumbnails from a vendor 3MF and return them as base64
/// PNG wire DTOs suitable for the JSON-RPC boundary.
pub fn extract_vendor_plate_thumbnails_dto(
    path: &Path,
) -> Result<VendorPlateThumbnailsDto, ThreeMfError> {
    Ok(VendorPlateThumbnailsDto {
        thumbnails: vendor::read_plate_thumbnails_file(path)?
            .iter()
            .map(VendorPlateThumbnailDto::from)
            .collect(),
    })
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
    pub modified_unix_seconds: Option<i64>,
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
            modified_unix_seconds: loc.fingerprint.modified_unix_secs,
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

/// A user-owned grouping of models, in wire form. Mirrors the `Collection` Zod
/// schema in `src/shared/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDto {
    pub id: String,
    pub name: String,
    pub shared_to_farm: bool,
    pub member_count: u64,
}

impl From<&crate::catalog::Collection> for CollectionDto {
    fn from(c: &crate::catalog::Collection) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            shared_to_farm: c.shared_to_farm,
            member_count: c.member_count as u64,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFormatCountsDto {
    pub stl: usize,
    pub three_mf: usize,
    pub obj: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFolderDto {
    pub relative_path: String,
    pub name: String,
    pub depth: usize,
    pub model_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewDto {
    pub model_count: usize,
    pub total_bytes: u64,
    pub skipped_errors: usize,
    pub complete: bool,
    pub formats: ImportFormatCountsDto,
    pub folders: Vec<ImportFolderDto>,
    pub folders_truncated: bool,
}

impl From<&crate::smart_import::ImportPreview> for ImportPreviewDto {
    fn from(preview: &crate::smart_import::ImportPreview) -> Self {
        Self {
            model_count: preview.model_count,
            total_bytes: preview.total_bytes,
            skipped_errors: preview.skipped_errors,
            complete: preview.complete,
            formats: ImportFormatCountsDto {
                stl: preview.formats.stl,
                three_mf: preview.formats.three_mf,
                obj: preview.formats.obj,
            },
            folders: preview
                .folders
                .iter()
                .map(|folder| ImportFolderDto {
                    relative_path: folder
                        .relative_path
                        .components()
                        .map(|component| component.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/"),
                    name: folder.name.clone(),
                    depth: folder.depth,
                    model_count: folder.model_count,
                })
                .collect(),
            folders_truncated: preview.folders_truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResultDto {
    pub report: ReconcileReportDto,
    pub models_organized: usize,
    pub collections_created: usize,
    pub collection_assignments: usize,
    pub tag_assignments: usize,
    pub resolved_collections: Vec<ResolvedImportCollectionDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedImportCollectionDto {
    pub relative_path: String,
    pub name: String,
    pub collection_id: String,
}

impl From<&crate::smart_import::ImportResult> for ImportResultDto {
    fn from(result: &crate::smart_import::ImportResult) -> Self {
        Self {
            report: ReconcileReportDto::from(&result.report),
            models_organized: result.models_organized,
            collections_created: result.collections_created,
            collection_assignments: result.collection_assignments,
            tag_assignments: result.tag_assignments,
            resolved_collections: result
                .resolved_collections
                .iter()
                .map(|collection| ResolvedImportCollectionDto {
                    relative_path: collection
                        .relative_path
                        .components()
                        .map(|component| component.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/"),
                    name: collection.name.clone(),
                    collection_id: collection.collection_id.clone(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Aabb;
    use crate::scene::{
        SceneMaterial, SceneMesh, SceneObject, SceneObjectMesh, ScenePlate, SceneTransform,
        SCENE_DTO_VERSION,
    };
    use crate::scene_status::SceneLoadStatus;

    fn sample_scene() -> SceneMesh {
        let mut bounds = Aabb::empty();
        for v in [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]] {
            bounds.expand(v);
        }
        SceneMesh {
            scene_version: SCENE_DTO_VERSION,
            positions: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]],
            indices: vec![0, 1, 2],
            bounds,
            source_format: ModelFormat::ThreeMf,
            face_colors: None,
            status: SceneLoadStatus::Complete,
            status_messages: Vec::new(),
            parts: vec![crate::scene::ScenePart {
                name: "Object 1".to_string(),
                triangle_start: 0,
                triangle_count: 1,
                status: SceneLoadStatus::Complete,
                status_detail: None,
                part_number: None,
                material_label: None,
            }],
            objects: vec![SceneObject {
                id: "plate-0/item-0/object-1".to_string(),
                source_id: "3d/3dmodel.model#object-1".to_string(),
                name: "Object 1".to_string(),
                parent_id: None,
                children: Vec::new(),
                transform: SceneTransform::identity(),
                mesh: Some(SceneObjectMesh {
                    positions: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]],
                    indices: vec![0, 1, 2],
                    bounds,
                }),
                material: SceneMaterial::default(),
                plate_id: "plate-0".to_string(),
                build_item_index: Some(0),
            }],
            root_object_ids: vec!["plate-0/item-0/object-1".to_string()],
            plates: vec![ScenePlate {
                id: "plate-0".to_string(),
                name: "Plate 1".to_string(),
                index: 0,
                root_object_ids: vec!["plate-0/item-0/object-1".to_string()],
            }],
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
        assert_eq!(dto.scene_version, SCENE_DTO_VERSION);
        assert_eq!(dto.objects.len(), 1);
        assert_eq!(dto.root_object_ids, vec!["plate-0/item-0/object-1"]);
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
        assert!(json.contains("\"parts\""));
        assert!(json.contains("\"sceneVersion\":2"));
        assert!(json.contains("\"objects\""));
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
    fn vendor_plate_thumbnails_dto_serializes_camel_case() {
        let dto = VendorPlateThumbnailsDto {
            thumbnails: vec![VendorPlateThumbnailDto {
                part_name: "Metadata/plate_1.png".to_string(),
                plate_index: Some(1),
                png_base64: BASE64.encode(b"\x89PNG\r\n\x1a\nwire"),
            }],
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"partName\":\"Metadata/plate_1.png\""));
        assert!(json.contains("\"plateIndex\":1"));
        assert!(json.contains("\"pngBase64\""));
        let parsed: VendorPlateThumbnailsDto = serde_json::from_str(&json).unwrap();
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
                fingerprint: FileFingerprint::new(
                    2048,
                    Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42)),
                ),
                available: true,
            }],
        };
        let dto = LogicalModelDto::from(&model);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"hash\":\"abc123\""));
        assert!(json.contains("\"format\":\"stl\""));
        assert!(json.contains("\"rootRelative\":\"part.stl\""));
        assert!(json.contains("\"modifiedUnixSeconds\":42"));
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
