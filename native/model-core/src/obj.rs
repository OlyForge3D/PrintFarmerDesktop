//! Wavefront OBJ parsing.
//!
//! OBJ stores shared vertices plus faces that can reference position, texture,
//! and normal indices. This parser keeps only positions, resolves absolute and
//! relative vertex indices, triangulates polygon faces with a fan, and returns an
//! indexed triangle mesh ready to normalize into a scene.

use std::io;
use std::path::Path;

use thiserror::Error;

use crate::geometry::Aabb;

/// Upper bounds so malformed or hostile files cannot exhaust memory.
pub const MAX_VERTICES: usize = 20_000_000;
pub const MAX_FACES: usize = 40_000_000;

#[derive(Debug, Error)]
pub enum ObjError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("OBJ contains no triangle geometry")]
    NoGeometry,
    #[error("vertex count exceeds the maximum of {MAX_VERTICES}")]
    TooManyVertices,
    #[error("face count exceeds the maximum of {MAX_FACES}")]
    TooManyFaces,
    #[error("malformed OBJ vertex on line {line}: {reason}")]
    MalformedVertex { line: usize, reason: String },
    #[error("malformed OBJ face on line {line}: {reason}")]
    MalformedFace { line: usize, reason: String },
    #[error("OBJ face index {index} on line {line} is out of range for {vertex_count} vertices")]
    IndexOutOfRange {
        line: usize,
        index: i64,
        vertex_count: usize,
    },
}

/// A parsed Wavefront OBJ mesh in indexed triangle form.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjMesh {
    pub vertices: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub bounds: Aabb,
}

impl ObjMesh {
    pub fn vertex_count(&self) -> usize {
        self.vertices.len()
    }

    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }
}

/// Parse an OBJ file from disk.
pub fn parse_file(path: &Path) -> Result<ObjMesh, ObjError> {
    let data = std::fs::read(path)?;
    parse_bytes(&data)
}

/// Parse a Wavefront OBJ from an in-memory byte buffer.
pub fn parse_bytes(data: &[u8]) -> Result<ObjMesh, ObjError> {
    let text = std::str::from_utf8(data).map_err(|_| ObjError::MalformedVertex {
        line: 1,
        reason: "input is not valid UTF-8".into(),
    })?;

    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    let mut bounds = Aabb::empty();

    for (line_no, raw_line) in text.lines().enumerate() {
        let line_number = line_no + 1;
        let line = raw_line
            .split_once('#')
            .map_or(raw_line, |(before, _)| before)
            .trim();
        if line.is_empty() {
            continue;
        }

        let mut tokens = line.split_whitespace();
        match tokens.next() {
            Some("v") => {
                if vertices.len() >= MAX_VERTICES {
                    return Err(ObjError::TooManyVertices);
                }
                let vertex = parse_vertex(&mut tokens, line_number)?;
                bounds.expand(vertex);
                vertices.push(vertex);
            }
            Some("f") => {
                let face = parse_face(&mut tokens, vertices.len(), line_number)?;
                if triangles.len() + face.len() - 2 > MAX_FACES {
                    return Err(ObjError::TooManyFaces);
                }
                for i in 1..face.len() - 1 {
                    triangles.push([face[0], face[i], face[i + 1]]);
                }
            }
            Some("vn" | "vt" | "vp" | "o" | "g" | "s" | "usemtl" | "mtllib") => {}
            Some(_) | None => {}
        }
    }

    if vertices.is_empty() || triangles.is_empty() {
        return Err(ObjError::NoGeometry);
    }

    Ok(ObjMesh {
        vertices,
        triangles,
        bounds,
    })
}

fn parse_vertex<'a, I: Iterator<Item = &'a str>>(
    tokens: &mut I,
    line: usize,
) -> Result<[f32; 3], ObjError> {
    let mut out = [0.0f32; 3];
    for slot in out.iter_mut() {
        let token = tokens.next().ok_or_else(|| ObjError::MalformedVertex {
            line,
            reason: "missing coordinate".into(),
        })?;
        *slot = token
            .parse::<f32>()
            .map_err(|_| ObjError::MalformedVertex {
                line,
                reason: format!("invalid coordinate '{token}'"),
            })?;
        if !slot.is_finite() {
            return Err(ObjError::MalformedVertex {
                line,
                reason: format!("coordinate '{token}' is not finite"),
            });
        }
    }
    if let Some(extra) = tokens.next() {
        return Err(ObjError::MalformedVertex {
            line,
            reason: format!("unexpected coordinate '{extra}'"),
        });
    }
    Ok(out)
}

fn parse_face<'a, I: Iterator<Item = &'a str>>(
    tokens: &mut I,
    vertex_count: usize,
    line: usize,
) -> Result<Vec<u32>, ObjError> {
    let mut indices = Vec::new();
    for token in tokens {
        indices.push(parse_face_index(token, vertex_count, line)?);
    }
    if indices.len() < 3 {
        return Err(ObjError::MalformedFace {
            line,
            reason: format!("expected at least 3 vertices, found {}", indices.len()),
        });
    }
    Ok(indices)
}

fn parse_face_index(token: &str, vertex_count: usize, line: usize) -> Result<u32, ObjError> {
    let parts: Vec<&str> = token.split('/').collect();
    if parts.len() > 3 || parts.first().is_none_or(|part| part.is_empty()) {
        return Err(ObjError::MalformedFace {
            line,
            reason: format!("invalid face vertex '{token}'"),
        });
    }

    let raw_index = parts[0]
        .parse::<i64>()
        .map_err(|_| ObjError::MalformedFace {
            line,
            reason: format!("invalid vertex index '{}'; expected an integer", parts[0]),
        })?;
    resolve_index(raw_index, vertex_count, line)
}

fn resolve_index(index: i64, vertex_count: usize, line: usize) -> Result<u32, ObjError> {
    if index == 0 {
        return Err(ObjError::MalformedFace {
            line,
            reason: "OBJ vertex indices are 1-based; 0 is invalid".into(),
        });
    }

    let resolved = if index > 0 {
        index - 1
    } else {
        vertex_count as i64 + index
    };

    if resolved < 0 || resolved >= vertex_count as i64 {
        return Err(ObjError::IndexOutOfRange {
            line,
            index,
            vertex_count,
        });
    }

    Ok(resolved as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_triangles_quads_negative_indices_and_bounds() {
        let obj = b"# comments and common OBJ records are ignored\n\
            mtllib demo.mtl\n\
            o Demo\n\
            v 0 0 0\n\
            v 1 0 0\n\
            v 0 1 0\n\
            v 1 1 0\n\
            v 0 0 1\n\
            vt 0 0\n\
            vn 0 0 1\n\
            usemtl plastic\n\
            f 1 2 3\n\
            f 1/1 2/1 4/1 3/1\n\
            f -3//1 -2//1 -1//1\n";

        let mesh = parse_bytes(obj).unwrap();
        assert_eq!(mesh.vertex_count(), 5);
        assert_eq!(mesh.triangle_count(), 4);
        assert_eq!(mesh.triangles[0], [0, 1, 2]);
        assert_eq!(mesh.triangles[1], [0, 1, 3]);
        assert_eq!(mesh.triangles[2], [0, 3, 2]);
        assert_eq!(mesh.triangles[3], [2, 3, 4]);
        assert_eq!(mesh.bounds.min, [0.0, 0.0, 0.0]);
        assert_eq!(mesh.bounds.max, [1.0, 1.0, 1.0]);
    }

    #[test]
    fn rejects_malformed_face_without_panicking() {
        let bad = b"v 0 0 0\nv 1 0 0\nf 1 nope 2\n";
        assert!(matches!(
            parse_bytes(bad),
            Err(ObjError::MalformedFace { .. })
        ));
    }

    #[test]
    fn rejects_out_of_range_indices() {
        let bad = b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n";
        assert!(matches!(
            parse_bytes(bad),
            Err(ObjError::IndexOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_empty_geometry() {
        assert!(matches!(
            parse_bytes(b"# empty\n"),
            Err(ObjError::NoGeometry)
        ));
    }
}
