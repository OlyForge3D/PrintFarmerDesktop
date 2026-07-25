//! STL parsing (binary and ASCII).
//!
//! STL is pure geometry: a flat list of triangles. This module detects the
//! encoding, parses triangles into a normalized in-memory mesh, computes the
//! axis-aligned bounds, and extracts the common binary per-facet color
//! convention when present. It is deliberately allocation-guarded so a
//! malformed or hostile header cannot request an unbounded allocation.
//!
//! 3MF (an XML-in-ZIP format) is handled separately in [`crate::threemf`].

use std::io;
use std::path::Path;

use thiserror::Error;

use crate::geometry::Aabb;

/// Hard ceiling on triangle count to bound memory for a single parse. A binary
/// header that declares more than this is rejected before allocating.
pub const MAX_TRIANGLES: u32 = 50_000_000;

const BINARY_HEADER_LEN: usize = 80;
const BINARY_COUNT_LEN: usize = 4;
const BINARY_TRIANGLE_LEN: usize = 50; // 12 floats + 2-byte attribute

#[derive(Debug, Error)]
pub enum StlError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("file is too small to be a valid STL")]
    TooSmall,
    #[error("declared triangle count {0} exceeds the maximum of {MAX_TRIANGLES}")]
    TooManyTriangles(u32),
    #[error("binary STL length does not match its declared triangle count")]
    LengthMismatch,
    #[error("malformed ASCII STL: {0}")]
    MalformedAscii(String),
    #[error("{context} contains a non-finite number")]
    NonFiniteNumber { context: &'static str },
}

impl StlError {
    /// A stable machine-readable code for the Electron layer's diagnostics.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::TooSmall => "too_small",
            Self::TooManyTriangles(_) => "too_many_triangles",
            Self::LengthMismatch => "length_mismatch",
            Self::MalformedAscii(_) => "malformed",
            Self::NonFiniteNumber { .. } => "non_finite_number",
        }
    }
}

/// Reject `NaN` and `±inf` coordinates. A non-finite vertex poisons the bounds,
/// serializes as JSON `null` over the RPC transport, and makes the viewer's
/// camera framing degenerate, so it never reaches a scene.
fn finite_vec3(v: [f32; 3], context: &'static str) -> Result<[f32; 3], StlError> {
    if v.iter().all(|c| c.is_finite()) {
        Ok(v)
    } else {
        Err(StlError::NonFiniteNumber { context })
    }
}

/// A single triangle: a facet normal and three vertices, plus an optional
/// per-facet color from the binary attribute convention.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Triangle {
    pub normal: [f32; 3],
    pub vertices: [[f32; 3]; 3],
    pub color: Option<[u8; 3]>,
}

/// A parsed STL mesh in a normalized form ready for scene/thumbnail use.
#[derive(Debug, Clone, PartialEq)]
pub struct StlMesh {
    pub is_binary: bool,
    pub triangles: Vec<Triangle>,
    pub bounds: Aabb,
    pub has_colors: bool,
}

impl StlMesh {
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }
}

/// Parse an STL from an in-memory byte buffer, auto-detecting the encoding.
pub fn parse_bytes(data: &[u8]) -> Result<StlMesh, StlError> {
    if is_binary(data) {
        parse_binary(data)
    } else {
        parse_ascii(data)
    }
}

/// Read and parse an STL file.
pub fn parse_file(path: &Path) -> Result<StlMesh, StlError> {
    let data = std::fs::read(path)?;
    parse_bytes(&data)
}

/// Heuristic encoding detection. A binary STL's length is exactly
/// `80 + 4 + 50 * count`; when that holds we treat it as binary even if the
/// header happens to begin with "solid" (some exporters do this).
fn is_binary(data: &[u8]) -> bool {
    if data.len() < BINARY_HEADER_LEN + BINARY_COUNT_LEN {
        // Too short for a binary header; fall back to ASCII parsing which will
        // surface a precise error.
        return false;
    }
    let count = u32::from_le_bytes([
        data[BINARY_HEADER_LEN],
        data[BINARY_HEADER_LEN + 1],
        data[BINARY_HEADER_LEN + 2],
        data[BINARY_HEADER_LEN + 3],
    ]) as usize;
    let expected = BINARY_HEADER_LEN + BINARY_COUNT_LEN + count * BINARY_TRIANGLE_LEN;
    data.len() == expected
}

fn parse_binary(data: &[u8]) -> Result<StlMesh, StlError> {
    if data.len() < BINARY_HEADER_LEN + BINARY_COUNT_LEN {
        return Err(StlError::TooSmall);
    }
    let count = u32::from_le_bytes([
        data[BINARY_HEADER_LEN],
        data[BINARY_HEADER_LEN + 1],
        data[BINARY_HEADER_LEN + 2],
        data[BINARY_HEADER_LEN + 3],
    ]);
    if count > MAX_TRIANGLES {
        return Err(StlError::TooManyTriangles(count));
    }
    let body = &data[BINARY_HEADER_LEN + BINARY_COUNT_LEN..];
    if body.len() != count as usize * BINARY_TRIANGLE_LEN {
        return Err(StlError::LengthMismatch);
    }

    let mut triangles = Vec::with_capacity(count as usize);
    let mut bounds = Aabb::empty();
    let mut has_colors = false;

    for chunk in body.chunks_exact(BINARY_TRIANGLE_LEN) {
        let normal = finite_vec3(read_vec3(&chunk[0..12]), "binary STL facet normal")?;
        let v0 = finite_vec3(read_vec3(&chunk[12..24]), "binary STL vertex")?;
        let v1 = finite_vec3(read_vec3(&chunk[24..36]), "binary STL vertex")?;
        let v2 = finite_vec3(read_vec3(&chunk[36..48]), "binary STL vertex")?;
        let attr = u16::from_le_bytes([chunk[48], chunk[49]]);
        let color = decode_attribute_color(attr);
        if color.is_some() {
            has_colors = true;
        }
        for v in [v0, v1, v2] {
            bounds.expand(v);
        }
        triangles.push(Triangle {
            normal,
            vertices: [v0, v1, v2],
            color,
        });
    }

    Ok(StlMesh {
        is_binary: true,
        triangles,
        bounds,
        has_colors,
    })
}

/// Decode the VisCAM/SolidView per-facet color convention: bit 15 marks a valid
/// color, with 5 bits each for red, green, and blue.
fn decode_attribute_color(attr: u16) -> Option<[u8; 3]> {
    if attr & 0x8000 == 0 {
        return None;
    }
    let r = ((attr & 0x001f) as u32 * 255 / 31) as u8;
    let g = (((attr >> 5) & 0x001f) as u32 * 255 / 31) as u8;
    let b = (((attr >> 10) & 0x001f) as u32 * 255 / 31) as u8;
    Some([r, g, b])
}

fn read_vec3(bytes: &[u8]) -> [f32; 3] {
    [
        f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        f32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        f32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
    ]
}

fn parse_ascii(data: &[u8]) -> Result<StlMesh, StlError> {
    let text = std::str::from_utf8(data)
        .map_err(|_| StlError::MalformedAscii("not valid UTF-8".into()))?;

    let mut triangles: Vec<Triangle> = Vec::new();
    let mut bounds = Aabb::empty();
    let mut current_normal = [0.0f32; 3];
    let mut current_vertices: Vec<[f32; 3]> = Vec::with_capacity(3);
    let mut saw_solid = false;

    for (line_no, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        let mut tokens = line.split_whitespace();
        match tokens.next() {
            Some("solid") => saw_solid = true,
            Some("facet") => {
                // `facet normal nx ny nz`
                if tokens.next() == Some("normal") {
                    current_normal = parse_vec3(&mut tokens, line_no)?;
                }
                current_vertices.clear();
            }
            Some("vertex") => {
                current_vertices.push(parse_vec3(&mut tokens, line_no)?);
            }
            Some("endfacet") => {
                if current_vertices.len() != 3 {
                    return Err(StlError::MalformedAscii(format!(
                        "facet ending on line {} has {} vertices",
                        line_no + 1,
                        current_vertices.len()
                    )));
                }
                let vertices = [
                    current_vertices[0],
                    current_vertices[1],
                    current_vertices[2],
                ];
                for v in vertices {
                    bounds.expand(v);
                }
                triangles.push(Triangle {
                    normal: current_normal,
                    vertices,
                    color: None,
                });
            }
            _ => {}
        }
    }

    if !saw_solid {
        return Err(StlError::MalformedAscii(
            "missing 'solid' header".to_string(),
        ));
    }

    Ok(StlMesh {
        is_binary: false,
        triangles,
        bounds,
        has_colors: false,
    })
}

fn parse_vec3<'a, I: Iterator<Item = &'a str>>(
    tokens: &mut I,
    line_no: usize,
) -> Result<[f32; 3], StlError> {
    let mut out = [0.0f32; 3];
    for slot in out.iter_mut() {
        let token = tokens.next().ok_or_else(|| {
            StlError::MalformedAscii(format!("missing coordinate on line {}", line_no + 1))
        })?;
        *slot = token.parse::<f32>().map_err(|_| {
            StlError::MalformedAscii(format!(
                "invalid number '{}' on line {}",
                token,
                line_no + 1
            ))
        })?;
        if !slot.is_finite() {
            return Err(StlError::NonFiniteNumber {
                context: "ASCII STL coordinate",
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (normal, three vertices, attribute word) for a synthetic binary facet.
    type BinTri = ([f32; 3], [[f32; 3]; 3], u16);

    fn binary_stl(triangles: &[BinTri]) -> Vec<u8> {
        let mut out = vec![0u8; BINARY_HEADER_LEN];
        out.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
        for (normal, verts, attr) in triangles {
            for c in normal {
                out.extend_from_slice(&c.to_le_bytes());
            }
            for v in verts {
                for c in v {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
            out.extend_from_slice(&attr.to_le_bytes());
        }
        out
    }

    #[test]
    fn rejects_non_finite_binary_vertices() {
        let data = binary_stl(&[(
            [0.0, 0.0, 1.0],
            [[0.0, 0.0, 0.0], [f32::NAN, 0.0, 0.0], [0.0, 1.0, 0.0]],
            0,
        )]);
        assert!(matches!(
            parse_bytes(&data),
            Err(StlError::NonFiniteNumber {
                context: "binary STL vertex"
            })
        ));
    }

    #[test]
    fn rejects_non_finite_binary_normals() {
        let data = binary_stl(&[(
            [f32::INFINITY, 0.0, 1.0],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            0,
        )]);
        assert!(matches!(
            parse_bytes(&data),
            Err(StlError::NonFiniteNumber {
                context: "binary STL facet normal"
            })
        ));
    }

    #[test]
    fn rejects_non_finite_ascii_coordinates() {
        // `1e999` parses to `Ok(inf)` rather than failing, so it must be caught
        // by the finiteness check and not by rejecting known spellings.
        for poison in ["NaN", "inf", "-inf", "1e999", "-1e999", "1E+400"] {
            let ascii = format!(
                "solid s\nfacet normal 0 0 1\nouter loop\nvertex {poison} 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid s\n"
            );
            assert!(
                matches!(
                    parse_bytes(ascii.as_bytes()),
                    Err(StlError::NonFiniteNumber { .. })
                ),
                "'{poison}' must be rejected"
            );
        }
    }

    #[test]
    fn parses_a_binary_triangle_with_bounds() {
        let data = binary_stl(&[(
            [0.0, 0.0, 1.0],
            [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]],
            0,
        )]);
        let mesh = parse_bytes(&data).unwrap();
        assert!(mesh.is_binary);
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.bounds.min, [0.0, 0.0, 0.0]);
        assert_eq!(mesh.bounds.max, [2.0, 3.0, 0.0]);
        assert_eq!(mesh.bounds.size(), [2.0, 3.0, 0.0]);
        assert!(!mesh.has_colors);
    }

    #[test]
    fn extracts_binary_facet_color() {
        // Valid bit set, full red in 5-bit channel (0x801f).
        let data = binary_stl(&[(
            [0.0, 0.0, 1.0],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            0x801f,
        )]);
        let mesh = parse_bytes(&data).unwrap();
        assert!(mesh.has_colors);
        assert_eq!(mesh.triangles[0].color, Some([255, 0, 0]));
    }

    #[test]
    fn rejects_truncated_binary() {
        let mut data = binary_stl(&[(
            [0.0, 0.0, 1.0],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            0,
        )]);
        data.truncate(data.len() - 10);
        // Truncation makes the length no longer match => treated as ASCII and
        // fails the solid-header check.
        assert!(parse_bytes(&data).is_err());
    }

    #[test]
    fn parses_ascii_triangle() {
        let ascii = "solid demo\n\
             facet normal 0 0 1\n\
               outer loop\n\
                 vertex 0 0 0\n\
                 vertex 1 0 0\n\
                 vertex 0 1 0\n\
               endloop\n\
             endfacet\n\
             endsolid demo\n";
        let mesh = parse_bytes(ascii.as_bytes()).unwrap();
        assert!(!mesh.is_binary);
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.triangles[0].normal, [0.0, 0.0, 1.0]);
        assert_eq!(mesh.bounds.max, [1.0, 1.0, 0.0]);
    }

    #[test]
    fn ascii_without_solid_header_is_rejected() {
        let bad = "facet normal 0 0 1\nendfacet\n";
        assert!(parse_bytes(bad.as_bytes()).is_err());
    }

    #[test]
    fn rejects_binary_header_declaring_too_many_triangles() {
        let mut data = vec![0u8; BINARY_HEADER_LEN];
        data.extend_from_slice(&(MAX_TRIANGLES + 1).to_le_bytes());
        // Pad so is_binary length check can't accidentally match.
        data.extend_from_slice(&[0u8; BINARY_TRIANGLE_LEN]);
        // Force the binary path regardless of the length heuristic.
        assert!(matches!(
            parse_binary(&data),
            Err(StlError::TooManyTriangles(_))
        ));
    }
}
