//! A format-agnostic scene: the normalized, indexed mesh handed to the 3D
//! viewer and the thumbnail renderer, regardless of whether it originated as an
//! STL triangle soup or an indexed 3MF build.
//!
//! Both parsers converge here so downstream code never branches on file format.
//! [`load_scene`] is the single entry point: it dispatches on the file
//! extension, parses with the appropriate pure-Rust parser, and returns a
//! uniform [`SceneMesh`].

use std::path::Path;

use thiserror::Error;

use crate::geometry::Aabb;
use crate::model::ModelFormat;
use crate::stl::{self, StlError, StlMesh};
use crate::threemf::{self, ThreeMfError, ThreeMfMesh};

#[derive(Debug, Error)]
pub enum SceneError {
    #[error("unsupported or unrecognized model file")]
    UnsupportedFormat,
    #[error("stl parse error: {0}")]
    Stl(#[from] StlError),
    #[error("3mf parse error: {0}")]
    ThreeMf(#[from] ThreeMfError),
}

/// A normalized, indexed triangle mesh ready for rendering.
///
/// `positions` holds unique-per-source vertices and `indices` references them in
/// triples (its length is always a multiple of three). `face_colors`, when
/// present, carries one RGB triple per triangle (currently only STL supplies
/// per-facet colors); it is either `None` or exactly `triangle_count` long.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneMesh {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub bounds: Aabb,
    pub source_format: ModelFormat,
    pub face_colors: Option<Vec<[u8; 3]>>,
}

impl SceneMesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len()
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Build a scene from a parsed STL mesh. STL is a triangle soup, so each
    /// facet contributes three fresh vertices and sequential indices. Per-facet
    /// colors are carried through when the source declared any.
    pub fn from_stl(mesh: &StlMesh) -> Self {
        let mut positions = Vec::with_capacity(mesh.triangles.len() * 3);
        let mut indices = Vec::with_capacity(mesh.triangles.len() * 3);
        for triangle in &mesh.triangles {
            for vertex in triangle.vertices {
                indices.push(positions.len() as u32);
                positions.push(vertex);
            }
        }

        let face_colors = mesh.has_colors.then(|| {
            mesh.triangles
                .iter()
                .map(|t| t.color.unwrap_or([200, 200, 200]))
                .collect()
        });

        Self {
            positions,
            indices,
            bounds: mesh.bounds,
            source_format: ModelFormat::Stl,
            face_colors,
        }
    }

    /// Build a scene from a flattened 3MF mesh, which is already indexed.
    pub fn from_threemf(mesh: &ThreeMfMesh) -> Self {
        let mut indices = Vec::with_capacity(mesh.triangles.len() * 3);
        for triangle in &mesh.triangles {
            indices.extend_from_slice(triangle);
        }
        Self {
            positions: mesh.vertices.clone(),
            indices,
            bounds: mesh.bounds,
            source_format: ModelFormat::ThreeMf,
            face_colors: None,
        }
    }
}

/// Load and normalize a model file, dispatching on its extension.
pub fn load_scene(path: &Path) -> Result<SceneMesh, SceneError> {
    match ModelFormat::from_path(path) {
        Some(ModelFormat::Stl) => Ok(SceneMesh::from_stl(&stl::parse_file(path)?)),
        Some(ModelFormat::ThreeMf) => Ok(SceneMesh::from_threemf(&threemf::parse_file(path)?)),
        None => Err(SceneError::UnsupportedFormat),
    }
}

/// Normalize an already-parsed STL mesh into a scene (bytes path, no file IO).
pub fn scene_from_stl_bytes(data: &[u8]) -> Result<SceneMesh, SceneError> {
    Ok(SceneMesh::from_stl(&stl::parse_bytes(data)?))
}

/// Normalize an already-parsed 3MF package into a scene (bytes path).
pub fn scene_from_threemf_bytes(data: &[u8]) -> Result<SceneMesh, SceneError> {
    Ok(SceneMesh::from_threemf(&threemf::parse_bytes(data)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stl::Triangle;
    use std::fs;

    fn stl_mesh_with_colors() -> StlMesh {
        let mut bounds = Aabb::empty();
        for v in [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            bounds.expand(v);
        }
        StlMesh {
            is_binary: true,
            triangles: vec![Triangle {
                normal: [0.0, 0.0, 1.0],
                vertices: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                color: Some([255, 0, 0]),
            }],
            bounds,
            has_colors: true,
        }
    }

    #[test]
    fn stl_triangle_becomes_three_positions_and_sequential_indices() {
        let scene = SceneMesh::from_stl(&stl_mesh_with_colors());
        assert_eq!(scene.source_format, ModelFormat::Stl);
        assert_eq!(scene.vertex_count(), 3);
        assert_eq!(scene.triangle_count(), 1);
        assert_eq!(scene.indices, vec![0, 1, 2]);
        assert_eq!(scene.face_colors, Some(vec![[255, 0, 0]]));
    }

    #[test]
    fn stl_without_colors_has_no_face_colors() {
        let mut mesh = stl_mesh_with_colors();
        mesh.has_colors = false;
        mesh.triangles[0].color = None;
        let scene = SceneMesh::from_stl(&mesh);
        assert!(scene.face_colors.is_none());
    }

    #[test]
    fn threemf_mesh_keeps_indices_and_positions() {
        let mut bounds = Aabb::empty();
        for v in [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]] {
            bounds.expand(v);
        }
        let mesh = ThreeMfMesh {
            vertices: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]],
            triangles: vec![[0, 1, 2]],
            bounds,
            unit: "millimeter".to_string(),
            object_count: 1,
            build_item_count: 1,
        };
        let scene = SceneMesh::from_threemf(&mesh);
        assert_eq!(scene.source_format, ModelFormat::ThreeMf);
        assert_eq!(scene.vertex_count(), 3);
        assert_eq!(scene.indices, vec![0, 1, 2]);
        assert!(scene.face_colors.is_none());
    }

    #[test]
    fn load_scene_reads_an_stl_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.stl");
        let ascii = "solid demo\n\
             facet normal 0 0 1\n\
               outer loop\n\
                 vertex 0 0 0\n\
                 vertex 1 0 0\n\
                 vertex 0 1 0\n\
               endloop\n\
             endfacet\n\
             endsolid demo\n";
        fs::write(&path, ascii).unwrap();

        let scene = load_scene(&path).unwrap();
        assert_eq!(scene.source_format, ModelFormat::Stl);
        assert_eq!(scene.triangle_count(), 1);
        assert_eq!(scene.bounds.max, [1.0, 1.0, 0.0]);
    }

    #[test]
    fn load_scene_rejects_unknown_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, b"not a model").unwrap();
        assert!(matches!(
            load_scene(&path),
            Err(SceneError::UnsupportedFormat)
        ));
    }
}
