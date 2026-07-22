//! Deterministic, GPU-free thumbnail rendering.
//!
//! The library needs preview images for every model, generated identically on a
//! developer laptop and a headless CI runner. A GPU/WebGL renderer cannot make
//! that guarantee, so this module is a small pure-Rust software rasterizer: it
//! projects a [`SceneMesh`] with a fixed orthographic isometric camera, fills
//! triangles through a z-buffer, and shades them with a fixed directional light.
//! The result is an RGBA framebuffer, encoded to PNG with the pure-Rust `png`
//! crate. No native dependencies, no platform GPU, fully reproducible.
//!
//! Shading uses `abs(N·L)` so a model with inconsistent triangle winding (common
//! in STL "triangle soup") never renders as unlit black faces.

use thiserror::Error;

use crate::scene::SceneMesh;

/// Default square thumbnail edge length in pixels.
pub const DEFAULT_THUMBNAIL_SIZE: u32 = 512;

/// Smallest and largest edge lengths we will render, to bound work and memory.
pub const MIN_THUMBNAIL_SIZE: u32 = 16;
pub const MAX_THUMBNAIL_SIZE: u32 = 4096;

/// Fraction of the image reserved as empty margin around the model.
const MARGIN_FRACTION: f32 = 0.08;

/// Base surface color (light steel gray) used when the mesh has no face colors.
const BASE_COLOR: [f32; 3] = [0.78, 0.80, 0.85];
/// Ambient light floor so faces perpendicular to the light are not pure black.
const AMBIENT: f32 = 0.35;
/// Diffuse light contribution scaled by the surface/light angle.
const DIFFUSE: f32 = 0.65;

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("thumbnail size {0} out of range [{MIN_THUMBNAIL_SIZE}, {MAX_THUMBNAIL_SIZE}]")]
    InvalidSize(u32),
    #[error("png encode error: {0}")]
    Encode(#[from] png::EncodingError),
}

/// A rendered thumbnail as a tightly packed RGBA8 framebuffer, row-major from
/// the top-left. Transparent (alpha 0) where the model does not cover a pixel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Render a mesh to an RGBA thumbnail of `size`×`size` pixels.
///
/// Returns an all-transparent image for an empty mesh rather than failing, so
/// callers get a valid (if blank) preview for degenerate inputs.
pub fn render(mesh: &SceneMesh, size: u32) -> Result<Thumbnail, ThumbnailError> {
    if !(MIN_THUMBNAIL_SIZE..=MAX_THUMBNAIL_SIZE).contains(&size) {
        return Err(ThumbnailError::InvalidSize(size));
    }
    let n = size as usize;
    let mut rgba = vec![0u8; n * n * 4];
    let mut depth = vec![f32::INFINITY; n * n];

    if mesh.indices.len() < 3 || mesh.positions.is_empty() {
        return Ok(Thumbnail {
            width: size,
            height: size,
            rgba,
        });
    }

    let camera = Camera::for_bounds(mesh);
    let light = normalize([-0.3, 0.4, 0.85]);
    let fsize = size as f32;
    let margin = fsize * MARGIN_FRACTION;

    // Project every vertex once into screen space (x, y down, depth into screen).
    let projected: Vec<[f32; 3]> = mesh.positions.iter().map(|p| camera.project(*p)).collect();

    // Fit the projected 2D extent into the square with a uniform margin.
    let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
    let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for p in &projected {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
    }
    let span = (max_x - min_x).max(max_y - min_y).max(f32::EPSILON);
    let scale = (fsize - 2.0 * margin) / span;
    let off_x = (fsize - (max_x - min_x) * scale) * 0.5;
    let off_y = (fsize - (max_y - min_y) * scale) * 0.5;

    let to_pixel = |p: [f32; 3]| -> [f32; 3] {
        [
            off_x + (p[0] - min_x) * scale,
            off_y + (p[1] - min_y) * scale,
            p[2],
        ]
    };

    for (tri_index, tri) in mesh.indices.chunks_exact(3).enumerate() {
        let (ia, ib, ic) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        let (Some(&wa), Some(&wb), Some(&wc)) = (
            mesh.positions.get(ia),
            mesh.positions.get(ib),
            mesh.positions.get(ic),
        ) else {
            continue;
        };

        // Flat shade from the world-space face normal.
        let normal = normalize(cross(sub(wb, wa), sub(wc, wa)));
        let intensity = (AMBIENT + DIFFUSE * dot(normal, light).abs()).clamp(0.0, 1.0);
        let base = face_color(mesh, tri_index);
        let color = [
            (base[0] * intensity * 255.0).round() as u8,
            (base[1] * intensity * 255.0).round() as u8,
            (base[2] * intensity * 255.0).round() as u8,
        ];

        let a = to_pixel(projected[ia]);
        let b = to_pixel(projected[ib]);
        let c = to_pixel(projected[ic]);
        fill_triangle(&mut rgba, &mut depth, size, a, b, c, color);
    }

    Ok(Thumbnail {
        width: size,
        height: size,
        rgba,
    })
}

/// Render a mesh straight to encoded PNG bytes.
pub fn render_png(mesh: &SceneMesh, size: u32) -> Result<Vec<u8>, ThumbnailError> {
    let thumb = render(mesh, size)?;
    encode_png(&thumb)
}

/// Encode an RGBA thumbnail as PNG bytes.
pub fn encode_png(thumb: &Thumbnail) -> Result<Vec<u8>, ThumbnailError> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, thumb.width, thumb.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&thumb.rgba)?;
    }
    Ok(out)
}

/// Base surface color for a triangle: its per-facet color (normalized to 0..1)
/// when the source carried one, otherwise the neutral base color.
fn face_color(mesh: &SceneMesh, tri_index: usize) -> [f32; 3] {
    if let Some(colors) = &mesh.face_colors {
        if let Some(rgb) = colors.get(tri_index) {
            return [
                rgb[0] as f32 / 255.0,
                rgb[1] as f32 / 255.0,
                rgb[2] as f32 / 255.0,
            ];
        }
    }
    BASE_COLOR
}

/// A fixed orthographic isometric camera fitted to a mesh's center.
struct Camera {
    center: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

impl Camera {
    /// Build a camera that frames the mesh from a front-right, slightly-elevated
    /// angle with +Z treated as up (the print-bed convention).
    fn for_bounds(mesh: &SceneMesh) -> Self {
        let center = mesh.bounds.center();
        // Direction from camera into the scene.
        let forward = normalize([-1.0, 1.0, -0.7]);
        let world_up = [0.0, 0.0, 1.0];
        let right = normalize(cross(forward, world_up));
        let up = cross(right, forward);
        Self {
            center,
            right,
            up,
            forward,
        }
    }

    /// Project a world point to screen space: x right, y down, z depth (larger =
    /// farther from the camera).
    fn project(&self, p: [f32; 3]) -> [f32; 3] {
        let rel = sub(p, self.center);
        [
            dot(rel, self.right),
            -dot(rel, self.up),
            dot(rel, self.forward),
        ]
    }
}

/// Rasterize one screen-space triangle into the RGBA buffer with z-testing.
/// Vertices are `[x, y, depth]` in pixel coordinates.
fn fill_triangle(
    rgba: &mut [u8],
    depth: &mut [f32],
    size: u32,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    color: [u8; 3],
) {
    let n = size as f32;
    let min_x = a[0].min(b[0]).min(c[0]).floor().max(0.0) as u32;
    let max_x = a[0].max(b[0]).max(c[0]).ceil().min(n - 1.0) as u32;
    let min_y = a[1].min(b[1]).min(c[1]).floor().max(0.0) as u32;
    let max_y = a[1].max(b[1]).max(c[1]).ceil().min(n - 1.0) as u32;
    if min_x > max_x || min_y > max_y {
        return;
    }

    let area = edge(a, b, c);
    if area.abs() < f32::EPSILON {
        return;
    }
    let inv_area = 1.0 / area;

    for py in min_y..=max_y {
        for px in min_x..=max_x {
            let p = [px as f32 + 0.5, py as f32 + 0.5, 0.0];
            let w0 = edge(b, c, p) * inv_area;
            let w1 = edge(c, a, p) * inv_area;
            let w2 = edge(a, b, p) * inv_area;
            // Inside test tolerant of either winding.
            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                continue;
            }
            let z = w0 * a[2] + w1 * b[2] + w2 * c[2];
            let idx = (py * size + px) as usize;
            if z < depth[idx] {
                depth[idx] = z;
                let o = idx * 4;
                rgba[o] = color[0];
                rgba[o + 1] = color[1];
                rgba[o + 2] = color[2];
                rgba[o + 3] = 255;
            }
        }
    }
}

/// Signed area (×2) of the triangle a-b-c in screen space.
fn edge(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len = dot(v, v).sqrt();
    if len <= f32::EPSILON {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Aabb;
    use crate::model::ModelFormat;

    /// A unit cube centered at the origin as an indexed triangle mesh.
    fn cube() -> SceneMesh {
        let positions = vec![
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
        ];
        // 12 triangles (two per face).
        let indices = vec![
            0, 1, 2, 0, 2, 3, // bottom
            4, 6, 5, 4, 7, 6, // top
            0, 4, 5, 0, 5, 1, // front
            1, 5, 6, 1, 6, 2, // right
            2, 6, 7, 2, 7, 3, // back
            3, 7, 4, 3, 4, 0, // left
        ];
        let mut bounds = Aabb::empty();
        for p in &positions {
            bounds.expand(*p);
        }
        SceneMesh {
            positions,
            indices,
            bounds,
            source_format: ModelFormat::Stl,
            face_colors: None,
            parts: Vec::new(),
        }
    }

    fn count_opaque(thumb: &Thumbnail) -> usize {
        thumb.rgba.chunks_exact(4).filter(|px| px[3] == 255).count()
    }

    #[test]
    fn rejects_out_of_range_sizes() {
        assert!(matches!(
            render(&cube(), 4),
            Err(ThumbnailError::InvalidSize(4))
        ));
        assert!(matches!(
            render(&cube(), 8192),
            Err(ThumbnailError::InvalidSize(8192))
        ));
    }

    #[test]
    fn renders_expected_dimensions_and_covers_pixels() {
        let thumb = render(&cube(), 64).unwrap();
        assert_eq!(thumb.width, 64);
        assert_eq!(thumb.height, 64);
        assert_eq!(thumb.rgba.len(), 64 * 64 * 4);
        // A cube should cover a large, central fraction of the frame.
        let opaque = count_opaque(&thumb);
        assert!(opaque > 64 * 64 / 5, "cube covered only {opaque} pixels");
        // The exact center pixel must be on the model.
        let center = (32 * 64 + 32) * 4;
        assert_eq!(thumb.rgba[center + 3], 255);
        // A corner stays transparent background.
        assert_eq!(thumb.rgba[3], 0);
    }

    #[test]
    fn rendering_is_deterministic() {
        let a = render(&cube(), 48).unwrap();
        let b = render(&cube(), 48).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn empty_mesh_yields_a_blank_but_valid_image() {
        let mut mesh = cube();
        mesh.indices.clear();
        let thumb = render(&mesh, 32).unwrap();
        assert_eq!(thumb.rgba.len(), 32 * 32 * 4);
        assert_eq!(count_opaque(&thumb), 0);
    }

    #[test]
    fn encodes_a_valid_png() {
        let png = render_png(&cube(), 32).unwrap();
        // PNG 8-byte signature.
        assert_eq!(
            &png[..8],
            &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']
        );
        assert!(png.len() > 8);
    }
}
