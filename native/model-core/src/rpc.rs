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

use serde::{Deserialize, Serialize};

use crate::model::ModelFormat;
use crate::scene::{self, SceneError, SceneMesh};

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
    fn round_trips_through_json() {
        let dto = SceneMeshDto::from(&sample_scene());
        let json = serde_json::to_string(&dto).unwrap();
        let parsed: SceneMeshDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, dto);
    }
}
