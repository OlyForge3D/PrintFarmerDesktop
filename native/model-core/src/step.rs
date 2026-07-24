//! STEP parsing and tessellation via the pure-Rust truck CAD kernel.

use std::io;
use std::path::Path;
use std::result::Result as StdResult;

use thiserror::Error;
use truck_meshalgo::prelude::*;
use truck_stepio::r#in::alias::*;
use truck_stepio::r#in::*;
use truck_topology::compress::CompressedShell;

use crate::geometry::Aabb;

const MAX_VERTICES: usize = 20_000_000;
const MAX_TRIANGLES: usize = 40_000_000;
const BASE_TESSELLATION_TOLERANCE: f64 = 0.01;
const RELATIVE_TESSELLATION_TOLERANCE: f64 = 0.001;

type StepShell = CompressedShell<Point3, Curve3D, Surface>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepPart {
    pub name: String,
    pub triangle_start: usize,
    pub triangle_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepMesh {
    pub vertices: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub bounds: Aabb,
    pub parts: Vec<StepPart>,
}

#[derive(Debug, Error)]
pub enum StepError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("STEP data is not valid UTF-8")]
    InvalidUtf8,
    #[error("STEP parse failed")]
    InvalidStep,
    #[error("STEP conversion failed: {0}")]
    Convert(String),
    #[error("STEP file contains no tessellatable geometry")]
    NoGeometry,
    #[error("tessellated mesh exceeds the maximum of {MAX_VERTICES} vertices")]
    TooManyVertices,
    #[error("tessellated mesh exceeds the maximum of {MAX_TRIANGLES} triangles")]
    TooManyTriangles,
    #[error("tessellation produced a non-triangle face")]
    NonTriangleFace,
    #[error("tessellated coordinate is not finite")]
    NonFiniteCoordinate,
}

#[derive(Debug, Clone)]
struct RawStepPart {
    name: String,
    shells: Vec<StepShell>,
}

pub fn parse_file(path: &Path) -> StdResult<StepMesh, StepError> {
    let data = std::fs::read(path)?;
    parse_bytes(&data)
}

pub fn parse_bytes(data: &[u8]) -> StdResult<StepMesh, StepError> {
    let text = std::str::from_utf8(data).map_err(|_| StepError::InvalidUtf8)?;
    let table = Table::from_step(text).ok_or(StepError::InvalidStep)?;
    let parts = collect_shell_parts(&table)?;
    tessellate_parts(parts)
}

fn collect_shell_parts(table: &Table) -> StdResult<Vec<RawStepPart>, StepError> {
    let mut parts = Vec::new();
    for (index, shell) in table.shell.values().enumerate() {
        let shell = table
            .to_compressed_shell(shell)
            .map_err(|err| StepError::Convert(err.to_string()))?;
        parts.push(RawStepPart {
            name: part_name("", index),
            shells: vec![shell],
        });
    }
    Ok(parts)
}

fn tessellate_parts(parts: Vec<RawStepPart>) -> StdResult<StepMesh, StepError> {
    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    let mut bounds = Aabb::empty();
    let mut scene_parts = Vec::new();

    for part in parts {
        let triangle_start = triangles.len();
        for shell in part.shells {
            append_tessellated_shell(&mut vertices, &mut triangles, &mut bounds, shell)?;
        }
        let triangle_count = triangles.len().saturating_sub(triangle_start);
        if triangle_count > 0 {
            scene_parts.push(StepPart {
                name: part.name,
                triangle_start,
                triangle_count,
            });
        }
    }

    if vertices.is_empty() || triangles.is_empty() {
        return Err(StepError::NoGeometry);
    }

    Ok(StepMesh {
        vertices,
        triangles,
        bounds,
        parts: scene_parts,
    })
}

fn append_tessellated_shell(
    vertices: &mut Vec<[f32; 3]>,
    triangles: &mut Vec<[u32; 3]>,
    bounds: &mut Aabb,
    shell: StepShell,
) -> StdResult<(), StepError> {
    let tolerance = shell_tessellation_tolerance(&shell);
    let mut polygon = shell.robust_triangulation(tolerance).to_polygon();
    polygon
        .put_together_same_attrs(TOLERANCE * 50.0)
        .remove_degenerate_faces()
        .remove_unused_attrs();
    if !polygon.quad_faces().is_empty() || !polygon.other_faces().is_empty() {
        return Err(StepError::NonTriangleFace);
    }

    let position_mesh = polygon.to_positions_mesh();
    let shell_positions = position_mesh.attributes();
    let vertex_offset = u32::try_from(vertices.len()).map_err(|_| StepError::TooManyVertices)?;
    let new_vertex_total = vertices
        .len()
        .checked_add(shell_positions.len())
        .ok_or(StepError::TooManyVertices)?;
    if new_vertex_total > MAX_VERTICES {
        return Err(StepError::TooManyVertices);
    }

    for position in shell_positions {
        let vertex = point3_to_f32(*position)?;
        bounds.expand(vertex);
        vertices.push(vertex);
    }

    let new_triangle_total = triangles
        .len()
        .checked_add(position_mesh.tri_faces().len())
        .ok_or(StepError::TooManyTriangles)?;
    if new_triangle_total > MAX_TRIANGLES {
        return Err(StepError::TooManyTriangles);
    }

    for face in position_mesh.tri_faces() {
        triangles.push([
            vertex_offset
                .checked_add(u32::try_from(face[0]).map_err(|_| StepError::TooManyVertices)?)
                .ok_or(StepError::TooManyVertices)?,
            vertex_offset
                .checked_add(u32::try_from(face[1]).map_err(|_| StepError::TooManyVertices)?)
                .ok_or(StepError::TooManyVertices)?,
            vertex_offset
                .checked_add(u32::try_from(face[2]).map_err(|_| StepError::TooManyVertices)?)
                .ok_or(StepError::TooManyVertices)?,
        ]);
    }

    Ok(())
}

fn shell_tessellation_tolerance(shell: &StepShell) -> f64 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for vertex in &shell.vertices {
        min[0] = min[0].min(vertex.x);
        min[1] = min[1].min(vertex.y);
        min[2] = min[2].min(vertex.z);
        max[0] = max[0].max(vertex.x);
        max[1] = max[1].max(vertex.y);
        max[2] = max[2].max(vertex.z);
    }

    let dx = max[0] - min[0];
    let dy = max[1] - min[1];
    let dz = max[2] - min[2];
    let diagonal = (dx * dx + dy * dy + dz * dz).sqrt();
    if diagonal.is_finite() && diagonal > 0.0 {
        diagonal * RELATIVE_TESSELLATION_TOLERANCE
    } else {
        BASE_TESSELLATION_TOLERANCE
    }
}

fn point3_to_f32(point: Point3) -> StdResult<[f32; 3], StepError> {
    let x = point.x as f32;
    let y = point.y as f32;
    let z = point.z as f32;
    if x.is_finite() && y.is_finite() && z.is_finite() {
        Ok([x, y, z])
    } else {
        Err(StepError::NonFiniteCoordinate)
    }
}

fn part_name(raw: &str, index: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        format!("Part {}", index + 1)
    } else {
        trimmed.to_string()
    }
}
