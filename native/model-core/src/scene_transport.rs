//! Bounded binary geometry frames. Metadata stays JSON; geometry never becomes
//! a giant JSON number array, and identical aggregate/object buffers travel once.

use std::collections::HashMap;
use std::io::Write;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::geometry::Aabb;
use crate::rpc::{
    BoundsDto, SceneMaterialDto, SceneMeshDto, SceneObjectDto, SceneObjectMeshDto, ScenePartDto,
    ScenePlateDto, SceneTransformDto,
};
use crate::scene::{SceneMesh, SceneObjectMesh};

pub const MAX_SCENE_BUFFER_BYTES: usize = 512 * 1024 * 1024;
pub const SCENE_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedArray {
    buffer: usize,
    length: usize,
    element_type: &'static str,
}

type PackedSceneDto = SceneMeshDto<PackedArray, PackedArray, PackedArray>;

pub struct PackedScene {
    scene: PackedSceneDto,
    buffers: Vec<Vec<u8>>,
}

#[derive(Default)]
struct BufferStore {
    buffers: Vec<Vec<u8>>,
    hashes: HashMap<[u8; 32], Vec<usize>>,
    bytes: usize,
}

impl BufferStore {
    fn add(
        &mut self,
        length: usize,
        element_type: &'static str,
        width: usize,
        bytes: impl Iterator<Item = u8>,
    ) -> Result<PackedArray, String> {
        let byte_length = length
            .checked_mul(width)
            .filter(|&n| n <= MAX_SCENE_BUFFER_BYTES)
            .ok_or("scene geometry exceeds the 512 MiB preview transport limit")?;
        let mut buffer = Vec::new();
        buffer
            .try_reserve_exact(byte_length)
            .map_err(|_| "not enough memory to transfer scene geometry")?;
        buffer.extend(bytes);
        let hash: [u8; 32] = Sha256::digest(&buffer).into();
        if let Some(candidates) = self.hashes.get(&hash) {
            for &index in candidates {
                if self.buffers[index] == buffer {
                    return Ok(PackedArray {
                        buffer: index,
                        length,
                        element_type,
                    });
                }
            }
        }
        self.bytes = self
            .bytes
            .checked_add(byte_length)
            .filter(|&n| n <= MAX_SCENE_BUFFER_BYTES)
            .ok_or("scene geometry exceeds the 512 MiB preview transport limit")?;
        let index = self.buffers.len();
        self.buffers.push(buffer);
        self.hashes.entry(hash).or_default().push(index);
        Ok(PackedArray {
            buffer: index,
            length,
            element_type,
        })
    }

    fn positions(&mut self, positions: &[[f32; 3]]) -> Result<PackedArray, String> {
        self.add(
            positions
                .len()
                .checked_mul(3)
                .ok_or("scene size overflow")?,
            "f32",
            4,
            positions.iter().flatten().flat_map(|n| n.to_le_bytes()),
        )
    }

    fn indices(&mut self, indices: &[u32]) -> Result<PackedArray, String> {
        self.add(
            indices.len(),
            "u32",
            4,
            indices.iter().flat_map(|n| n.to_le_bytes()),
        )
    }

    fn colors(&mut self, colors: &[[u8; 3]]) -> Result<PackedArray, String> {
        self.add(
            colors.len().checked_mul(3).ok_or("scene size overflow")?,
            "u8",
            1,
            colors.iter().flatten().copied(),
        )
    }

    fn mesh(
        &mut self,
        mesh: &SceneObjectMesh,
    ) -> Result<SceneObjectMeshDto<PackedArray, PackedArray>, String> {
        Ok(SceneObjectMeshDto {
            positions: self.positions(&mesh.positions)?,
            indices: self.indices(&mesh.indices)?,
            bounds: bounds(mesh.bounds),
        })
    }
}

fn bounds(bounds: Aabb) -> BoundsDto {
    BoundsDto {
        min: bounds.min,
        max: bounds.max,
    }
}

impl PackedScene {
    pub fn from_scene(scene: &SceneMesh) -> Result<Self, String> {
        let mut store = BufferStore::default();
        let dto = SceneMeshDto {
            scene_version: scene.scene_version,
            positions: store.positions(&scene.positions)?,
            indices: store.indices(&scene.indices)?,
            bounds: bounds(scene.bounds),
            source_format: scene.source_format,
            face_colors: scene
                .face_colors
                .as_ref()
                .map(|c| store.colors(c))
                .transpose()?,
            status: scene.status,
            status_messages: scene.status_messages.clone(),
            parts: scene
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
                .collect(),
            objects: scene
                .objects
                .iter()
                .map(|object| {
                    Ok(SceneObjectDto {
                        id: object.id.clone(),
                        source_id: object.source_id.clone(),
                        name: object.name.clone(),
                        parent_id: object.parent_id.clone(),
                        children: object.children.clone(),
                        transform: SceneTransformDto::from(&object.transform),
                        mesh: object.mesh.as_ref().map(|m| store.mesh(m)).transpose()?,
                        material: SceneMaterialDto {
                            base_color: object.material.base_color,
                            face_colors: object
                                .material
                                .face_colors
                                .as_ref()
                                .map(|c| store.colors(c))
                                .transpose()?,
                        },
                        plate_id: object.plate_id.clone(),
                        build_item_index: object.build_item_index,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            root_object_ids: scene.root_object_ids.clone(),
            plates: scene.plates.iter().map(ScenePlateDto::from).collect(),
        };
        Ok(Self {
            scene: dto,
            buffers: store.buffers,
        })
    }

    pub fn write_response(&self, id: u64, output: &mut impl Write) -> std::io::Result<()> {
        for (index, buffer) in self.buffers.iter().enumerate() {
            for offset in (0..buffer.len().max(1)).step_by(SCENE_CHUNK_BYTES) {
                let end = (offset + SCENE_CHUNK_BYTES).min(buffer.len());
                write_frame(
                    output,
                    &serde_json::json!({
                        "id": id,
                        "ok": true,
                        "sceneBuffer": {
                            "index": index,
                            "byteLength": buffer.len(),
                            "offset": offset,
                            "data": BASE64.encode(&buffer[offset..end]),
                        },
                    }),
                )?;
            }
        }
        write_frame(
            output,
            &serde_json::json!({
                "id": id,
                "ok": true,
                "result": { "encoding": "packed-v1", "scene": self.scene },
            }),
        )?;
        output.flush()
    }
}

fn write_frame(output: &mut impl Write, value: &impl Serialize) -> std::io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(std::io::Error::other)?;
    output.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::InMemoryCatalog;
    use serde_json::Value;
    use std::io::Cursor;

    fn sample_scene() -> SceneMesh {
        let mut file = tempfile::Builder::new().suffix(".stl").tempfile().unwrap();
        file.write_all(b"solid sample\nfacet normal 0 0 1\nouter loop\nvertex -0 -1.1234567 3\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid sample\n").unwrap();
        let mut scene = crate::scene::load_scene(file.path()).unwrap();
        scene.face_colors = Some(vec![[250, 127, 3]]);
        scene.objects[0].material.face_colors = scene.face_colors.clone();
        scene.status_messages.push("example warning".into());
        scene
    }

    #[test]
    fn transfers_identical_geometry_once_and_preserves_float_bits_and_metadata() {
        let scene = sample_scene();
        let packed = PackedScene::from_scene(&scene).unwrap();
        assert_eq!(packed.buffers.len(), 3);
        assert_eq!(
            packed.scene.positions.buffer,
            packed.scene.objects[0]
                .mesh
                .as_ref()
                .unwrap()
                .positions
                .buffer
        );
        assert_eq!(
            packed.buffers[0],
            scene
                .positions
                .iter()
                .flatten()
                .flat_map(|n| n.to_le_bytes())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            packed.buffers[1],
            scene
                .indices
                .iter()
                .flat_map(|n| n.to_le_bytes())
                .collect::<Vec<_>>()
        );
        assert_eq!(packed.buffers[2], vec![250, 127, 3]);
        let mut output = Vec::new();
        packed.write_response(42, &mut output).unwrap();
        let frames: Vec<Value> = std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(frames.len(), 4);
        assert!(frames.iter().all(|f| f["id"] == 42 && f["ok"] == true));
        let metadata = &frames.last().unwrap()["result"];
        assert_eq!(metadata["encoding"], "packed-v1");
        assert_eq!(metadata["scene"]["statusMessages"][0], "example warning");
        assert_eq!(
            metadata["scene"]["bounds"],
            serde_json::to_value(bounds(scene.bounds)).unwrap()
        );
        assert_eq!(
            metadata["scene"]["plates"].as_array().unwrap().len(),
            scene.plates.len()
        );
        assert_eq!(
            BASE64
                .decode(frames[0]["sceneBuffer"]["data"].as_str().unwrap())
                .unwrap(),
            packed.buffers[0]
        );
    }

    #[test]
    fn retains_distinct_local_meshes_instead_of_aliasing_by_source_id() {
        let mut scene = sample_scene();
        scene.objects[0].mesh.as_mut().unwrap().positions[0][0] = 15.0;
        let packed = PackedScene::from_scene(&scene).unwrap();
        assert_ne!(
            packed.scene.positions.buffer,
            packed.scene.objects[0]
                .mesh
                .as_ref()
                .unwrap()
                .positions
                .buffer
        );
        assert_eq!(packed.buffers.len(), 4);
    }

    #[test]
    fn chunks_large_buffers_and_reassembles_exact_bytes() {
        let mut scene = sample_scene();
        scene.positions = scene.positions.repeat(10_000);
        scene.objects[0].mesh.as_mut().unwrap().positions = scene.positions.clone();
        let packed = PackedScene::from_scene(&scene).unwrap();
        let mut output = Vec::new();
        packed.write_response(7, &mut output).unwrap();
        let mut reassembled = Vec::new();
        let mut chunks = 0;
        for line in std::str::from_utf8(&output).unwrap().lines() {
            assert!(line.len() < SCENE_CHUNK_BYTES * 2);
            let frame: Value = serde_json::from_str(line).unwrap();
            if frame["sceneBuffer"]["index"] != 0 {
                continue;
            }
            let chunk = &frame["sceneBuffer"];
            assert_eq!(
                chunk["offset"].as_u64().unwrap() as usize,
                reassembled.len()
            );
            let bytes = BASE64.decode(chunk["data"].as_str().unwrap()).unwrap();
            assert!(bytes.len() <= SCENE_CHUNK_BYTES);
            reassembled.extend(bytes);
            chunks += 1;
        }
        assert!(chunks > 1);
        assert_eq!(reassembled, packed.buffers[0]);
    }

    #[test]
    fn rejects_oversized_geometry_before_allocating() {
        let mut store = BufferStore::default();
        assert!(store
            .add(MAX_SCENE_BUFFER_BYTES / 4 + 1, "f32", 4, std::iter::empty())
            .is_err());
        assert!(store.buffers.is_empty());
    }

    #[test]
    fn streaming_server_reports_errors_and_serves_the_next_request() {
        let requests = b"{\"id\":1,\"method\":\"loadScenePacked\",\"params\":{\"path\":\"missing.stl\"}}\n{\"id\":2,\"method\":\"handshake\"}\n";
        let mut output = Vec::new();
        crate::serve::run(
            &mut InMemoryCatalog::new(),
            Cursor::new(requests),
            &mut output,
        )
        .unwrap();
        let frames: Vec<Value> = std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(frames[0]["ok"], false);
        assert!(frames[0]["error"].as_str().unwrap().contains("stl"));
        assert_eq!(
            frames[1]["result"]["protocolVersion"],
            crate::RPC_PROTOCOL_VERSION
        );
    }
}
