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
use crate::obj::{self, ObjError, ObjMesh};
use crate::stl::{self, StlError, StlMesh};
use crate::threemf::{self, ThreeMfError, ThreeMfMesh};

pub const SCENE_DTO_VERSION: u32 = 2;
const DEFAULT_PLATE_ID: &str = "plate-0";
const DEFAULT_PLATE_NAME: &str = "Plate 1";

#[derive(Debug, Error)]
pub enum SceneError {
    #[error("unsupported or unrecognized model file")]
    UnsupportedFormat,
    #[error("stl parse error: {0}")]
    Stl(#[from] StlError),
    #[error("3mf parse error: {0}")]
    ThreeMf(#[from] ThreeMfError),
    #[error("obj parse error: {0}")]
    Obj(#[from] ObjError),
}

/// A named, selectable region of the flattened scene. `triangle_start` and
/// `triangle_count` index into the mesh's triangles (each triangle is three
/// consecutive [`SceneMesh::indices`]), letting the viewer isolate or hide a
/// part. STL yields a single part; 3MF yields one part per build item.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePart {
    pub name: String,
    pub triangle_start: usize,
    pub triangle_count: usize,
}

/// A local transform matrix for one scene object instance.
///
/// The matrix is serialized in the row-major argument order expected by
/// `THREE.Matrix4.set(n11..n44)`: translation lives in slots 3/7/11 and the
/// last row is always `[0, 0, 0, 1]`. For 3MF this is the transpose of the
/// source format's row-vector `p' = p·R + T` transform, so the renderer can
/// feed it straight into Three.js after parenting under `parent_id`.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneTransform {
    pub matrix: [f32; 16],
}

impl SceneTransform {
    pub fn identity() -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0, //
                0.0, 1.0, 0.0, 0.0, //
                0.0, 0.0, 1.0, 0.0, //
                0.0, 0.0, 0.0, 1.0,
            ],
        }
    }
}

/// A renderable mesh owned by one scene object.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneObjectMesh {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub bounds: Aabb,
}

/// Per-object material/color payload carried over the sidecar boundary.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SceneMaterial {
    pub base_color: Option<[u8; 3]>,
    pub face_colors: Option<Vec<[u8; 3]>>,
}

/// One object instance in the normalized scene graph.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneObject {
    pub id: String,
    /// Stable identity of the source object definition, distinct from `id` when
    /// the scene instantiates the same source object multiple times.
    pub source_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub transform: SceneTransform,
    pub mesh: Option<SceneObjectMesh>,
    pub material: SceneMaterial,
    pub plate_id: String,
    pub build_item_index: Option<usize>,
}

/// One logical build plate grouping root scene objects.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePlate {
    pub id: String,
    pub name: String,
    pub index: usize,
    pub root_object_ids: Vec<String>,
}

/// A normalized, indexed triangle mesh ready for rendering.
///
/// `positions` holds unique-per-source vertices and `indices` references them in
/// triples (its length is always a multiple of three). `face_colors`, when
/// present, carries one RGB triple per triangle (currently only STL supplies
/// per-facet colors); it is either `None` or exactly `triangle_count` long.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneMesh {
    pub scene_version: u32,
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub bounds: Aabb,
    pub source_format: ModelFormat,
    pub face_colors: Option<Vec<[u8; 3]>>,
    /// Named triangle ranges for the part tree; always at least one entry when
    /// the mesh is non-empty.
    pub parts: Vec<ScenePart>,
    /// Hierarchical object instances for the renderer-facing scene contract.
    pub objects: Vec<SceneObject>,
    pub root_object_ids: Vec<String>,
    pub plates: Vec<ScenePlate>,
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

        let triangle_count = mesh.triangles.len();
        let parts = if triangle_count == 0 {
            Vec::new()
        } else {
            vec![ScenePart {
                name: "Model".to_string(),
                triangle_start: 0,
                triangle_count,
            }]
        };
        let object_positions = positions.clone();
        let object_indices = indices.clone();
        let object_bounds = mesh.bounds;
        let object_face_colors = face_colors.clone();

        Self {
            scene_version: SCENE_DTO_VERSION,
            positions,
            indices,
            bounds: mesh.bounds,
            source_format: ModelFormat::Stl,
            face_colors,
            parts,
            objects: vec![single_object(
                "object-0",
                "stl:model",
                "Model",
                object_positions,
                object_indices,
                object_bounds,
                object_face_colors,
            )],
            root_object_ids: vec!["object-0".to_string()],
            plates: vec![default_plate(vec!["object-0".to_string()])],
        }
    }

    /// Build a scene from a parsed OBJ mesh, which is already indexed.
    pub fn from_obj(mesh: &ObjMesh) -> Self {
        let mut indices = Vec::with_capacity(mesh.triangles.len() * 3);
        for triangle in &mesh.triangles {
            indices.extend_from_slice(triangle);
        }
        let triangle_count = mesh.triangles.len();
        let parts = if triangle_count == 0 {
            Vec::new()
        } else {
            vec![ScenePart {
                name: "Model".to_string(),
                triangle_start: 0,
                triangle_count,
            }]
        };
        Self {
            scene_version: SCENE_DTO_VERSION,
            positions: mesh.vertices.clone(),
            indices,
            bounds: mesh.bounds,
            source_format: ModelFormat::Obj,
            face_colors: None,
            parts,
            objects: vec![single_object(
                "object-0",
                "obj:model",
                "Model",
                mesh.vertices.clone(),
                mesh.triangles
                    .iter()
                    .flat_map(|triangle| *triangle)
                    .collect(),
                mesh.bounds,
                None,
            )],
            root_object_ids: vec!["object-0".to_string()],
            plates: vec![default_plate(vec!["object-0".to_string()])],
        }
    }

    /// Build a scene from a flattened 3MF mesh, which is already indexed.
    pub fn from_threemf(mesh: &ThreeMfMesh) -> Self {
        let mut indices = Vec::with_capacity(mesh.triangles.len() * 3);
        for triangle in &mesh.triangles {
            indices.extend_from_slice(triangle);
        }
        let parts = mesh
            .parts
            .iter()
            .map(|p| ScenePart {
                name: p.name.clone(),
                triangle_start: p.triangle_start,
                triangle_count: p.triangle_count,
            })
            .collect();
        Self {
            scene_version: SCENE_DTO_VERSION,
            positions: mesh.vertices.clone(),
            indices,
            bounds: mesh.bounds,
            source_format: ModelFormat::ThreeMf,
            face_colors: None,
            parts,
            objects: mesh
                .objects
                .iter()
                .map(|object| SceneObject {
                    id: object.id.clone(),
                    source_id: object.source_id.clone(),
                    name: object.name.clone(),
                    parent_id: object.parent_id.clone(),
                    children: object.children.clone(),
                    transform: SceneTransform {
                        matrix: object.transform.to_row_major_4x4(),
                    },
                    mesh: object.mesh.as_ref().map(|mesh| SceneObjectMesh {
                        positions: mesh.positions.clone(),
                        indices: mesh.indices.clone(),
                        bounds: mesh.bounds,
                    }),
                    material: SceneMaterial {
                        base_color: object.material.base_color,
                        face_colors: object.material.face_colors.clone(),
                    },
                    plate_id: object.plate_id.clone(),
                    build_item_index: Some(object.build_item_index),
                })
                .collect(),
            root_object_ids: mesh.root_object_ids.clone(),
            plates: mesh
                .plates
                .iter()
                .map(|plate| ScenePlate {
                    id: plate.id.clone(),
                    name: plate.name.clone(),
                    index: plate.index,
                    root_object_ids: plate.root_object_ids.clone(),
                })
                .collect(),
        }
    }
}

fn single_object(
    id: &str,
    source_id: &str,
    name: &str,
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
    bounds: Aabb,
    face_colors: Option<Vec<[u8; 3]>>,
) -> SceneObject {
    SceneObject {
        id: id.to_string(),
        source_id: source_id.to_string(),
        name: name.to_string(),
        parent_id: None,
        children: Vec::new(),
        transform: SceneTransform::identity(),
        mesh: Some(SceneObjectMesh {
            positions,
            indices,
            bounds,
        }),
        material: SceneMaterial {
            base_color: None,
            face_colors,
        },
        plate_id: DEFAULT_PLATE_ID.to_string(),
        build_item_index: Some(0),
    }
}

fn default_plate(root_object_ids: Vec<String>) -> ScenePlate {
    ScenePlate {
        id: DEFAULT_PLATE_ID.to_string(),
        name: DEFAULT_PLATE_NAME.to_string(),
        index: 0,
        root_object_ids,
    }
}

/// Load and normalize a model file, dispatching on its extension.
pub fn load_scene(path: &Path) -> Result<SceneMesh, SceneError> {
    match ModelFormat::from_path(path) {
        Some(ModelFormat::Stl) => Ok(SceneMesh::from_stl(&stl::parse_file(path)?)),
        Some(ModelFormat::ThreeMf) => Ok(SceneMesh::from_threemf(&threemf::parse_file(path)?)),
        Some(ModelFormat::Obj) => Ok(SceneMesh::from_obj(&obj::parse_file(path)?)),
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

/// Normalize an already-parsed OBJ mesh into a scene (bytes path).
pub fn scene_from_obj_bytes(data: &[u8]) -> Result<SceneMesh, SceneError> {
    Ok(SceneMesh::from_obj(&obj::parse_bytes(data)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stl::Triangle;
    use std::fs;

    fn expected_three_row_major_matrix(transform: &threemf::Transform) -> [f32; 16] {
        let origin = transform.apply([0.0, 0.0, 0.0]);
        let x_axis = subtract(transform.apply([1.0, 0.0, 0.0]), origin);
        let y_axis = subtract(transform.apply([0.0, 1.0, 0.0]), origin);
        let z_axis = subtract(transform.apply([0.0, 0.0, 1.0]), origin);
        [
            x_axis[0], y_axis[0], z_axis[0], origin[0], x_axis[1], y_axis[1], z_axis[1], origin[1],
            x_axis[2], y_axis[2], z_axis[2], origin[2], 0.0, 0.0, 0.0, 1.0,
        ]
    }

    fn subtract(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    }

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
        assert_eq!(scene.parts.len(), 1);
        assert_eq!(scene.parts[0].name, "Model");
        assert_eq!(scene.parts[0].triangle_count, 1);
        assert_eq!(scene.scene_version, SCENE_DTO_VERSION);
        assert_eq!(scene.objects.len(), 1);
        assert_eq!(scene.root_object_ids, vec!["object-0"]);
        assert_eq!(scene.plates[0].root_object_ids, vec!["object-0"]);
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
            parts: vec![threemf::ThreeMfPart {
                name: "Widget".to_string(),
                triangle_start: 0,
                triangle_count: 1,
            }],
            objects: vec![threemf::ThreeMfSceneObject {
                id: "plate-0/item-0/object-1".to_string(),
                source_id: "3d/3dmodel.model#object-1".to_string(),
                name: "Widget".to_string(),
                parent_id: None,
                children: Vec::new(),
                transform: threemf::Transform::parse("0 1 0 -1 0 0 0 0 1 10 20 30").unwrap(),
                mesh: Some(threemf::ThreeMfObjectMesh {
                    positions: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]],
                    indices: vec![0, 1, 2],
                    bounds,
                }),
                material: threemf::ThreeMfMaterial::default(),
                plate_id: "plate-0".to_string(),
                build_item_index: 0,
            }],
            root_object_ids: vec!["plate-0/item-0/object-1".to_string()],
            plates: vec![threemf::ThreeMfPlate {
                id: "plate-0".to_string(),
                name: "Plate 1".to_string(),
                index: 0,
                root_object_ids: vec!["plate-0/item-0/object-1".to_string()],
            }],
        };
        let scene = SceneMesh::from_threemf(&mesh);
        let expected_matrix = expected_three_row_major_matrix(&mesh.objects[0].transform);
        assert_eq!(scene.source_format, ModelFormat::ThreeMf);
        assert_eq!(scene.vertex_count(), 3);
        assert_eq!(scene.indices, vec![0, 1, 2]);
        assert!(scene.face_colors.is_none());
        assert_eq!(scene.parts.len(), 1);
        assert_eq!(scene.parts[0].name, "Widget");
        assert_eq!(scene.parts[0].triangle_count, 1);
        assert_eq!(scene.objects.len(), 1);
        assert_eq!(scene.objects[0].transform.matrix, expected_matrix);
        assert_eq!(scene.root_object_ids, vec!["plate-0/item-0/object-1"]);
        assert_eq!(
            scene.plates[0].root_object_ids,
            vec!["plate-0/item-0/object-1"]
        );
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

    #[test]
    fn obj_mesh_keeps_indices_positions_and_model_part() {
        let mut bounds = Aabb::empty();
        for v in [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]] {
            bounds.expand(v);
        }
        let mesh = ObjMesh {
            vertices: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]],
            triangles: vec![[0, 1, 2]],
            bounds,
        };
        let scene = SceneMesh::from_obj(&mesh);
        assert_eq!(scene.source_format, ModelFormat::Obj);
        assert_eq!(scene.vertex_count(), 3);
        assert_eq!(scene.indices, vec![0, 1, 2]);
        assert!(scene.face_colors.is_none());
        assert_eq!(scene.parts.len(), 1);
        assert_eq!(scene.parts[0].name, "Model");
        assert_eq!(scene.parts[0].triangle_count, 1);
        assert_eq!(scene.objects[0].source_id, "obj:model");
    }

    #[test]
    fn load_scene_reads_an_obj_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.obj");
        let obj = "v 0 0 0\n\
                   v 1 0 0\n\
                   v 0 1 0\n\
                   f 1 2 3\n";
        fs::write(&path, obj).unwrap();

        let scene = load_scene(&path).unwrap();
        assert_eq!(scene.source_format, ModelFormat::Obj);
        assert_eq!(scene.triangle_count(), 1);
        assert_eq!(scene.bounds.max, [1.0, 1.0, 0.0]);
    }

    #[test]
    fn scene_from_obj_bytes_rejects_malformed_input() {
        assert!(matches!(
            scene_from_obj_bytes(b"v 0 0 0\nf 1 nope 1\n"),
            Err(SceneError::Obj(_))
        ));
    }
}
