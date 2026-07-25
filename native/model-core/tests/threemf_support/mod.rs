//! Shared 3MF package-authoring helpers for the fixture and security suites.
//!
//! These are deliberately *independent* of the reader under test: packages are
//! assembled from raw parts with `zip` and hand-written XML, so a bug in the
//! reader cannot silently define its own expectations.

#![allow(dead_code)]

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

pub const CONTENT_TYPES_PART: &str = "[Content_Types].xml";
pub const RELATIONSHIPS_PART: &str = "_rels/.rels";
pub const DEFAULT_MODEL_PART: &str = "3D/3dmodel.model";

pub const CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="config" ContentType="application/xml"/>
</Types>"#;

pub const RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;

/// One ZIP entry. `stored` forces no compression, which keeps the compression
/// ratio of benign fixtures trivially below the security limit.
pub struct Part {
    pub name: String,
    pub data: Vec<u8>,
    pub stored: bool,
}

impl Part {
    pub fn text(name: &str, xml: &str) -> Self {
        Self {
            name: name.to_string(),
            data: xml.as_bytes().to_vec(),
            stored: false,
        }
    }

    pub fn bytes(name: &str, data: Vec<u8>) -> Self {
        Self {
            name: name.to_string(),
            data,
            stored: false,
        }
    }

    pub fn stored(mut self) -> Self {
        self.stored = true;
        self
    }
}

/// Assemble an arbitrary set of parts into a ZIP container.
///
/// The deflate level is pinned so regenerated fixtures stay byte-stable for a
/// given `zip`/`miniz_oxide` version; the manifest records the digest.
pub fn zip_parts(parts: &[Part]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        for part in parts {
            let options = if part.stored {
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
            } else {
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .compression_level(Some(6))
            };
            writer.start_file(part.name.clone(), options).unwrap();
            writer.write_all(&part.data).unwrap();
        }
        writer.finish().unwrap();
    }
    buf
}

/// A well-formed OPC package: content types, root relationships, the model
/// part, plus any extra parts (vendor config, thumbnails, ...).
pub fn package(model_xml: &str, extra: Vec<Part>) -> Vec<u8> {
    let mut parts = vec![
        Part::text(CONTENT_TYPES_PART, CONTENT_TYPES_XML),
        Part::text(RELATIONSHIPS_PART, RELS_XML),
        Part::text(DEFAULT_MODEL_PART, model_xml),
    ];
    parts.extend(extra);
    zip_parts(&parts)
}

/// Wrap `resources` and `build` fragments in a 3MF core-namespace document.
pub fn model_document(unit: &str, resources: &str, build: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="{unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">PrintFarmer fixture author</metadata>
  <resources>
{resources}
  </resources>
  <build>
{build}
  </build>
</model>"#
    )
}

/// An axis-aligned box mesh as `<object>` XML: 8 vertices, 12 triangles, with a
/// consistent outward winding so the result is a closed manifold.
pub fn box_object(id: &str, name: &str, size: [f32; 3], extra_attrs: &str) -> String {
    let [sx, sy, sz] = size;
    let corners = [
        [0.0, 0.0, 0.0],
        [sx, 0.0, 0.0],
        [sx, sy, 0.0],
        [0.0, sy, 0.0],
        [0.0, 0.0, sz],
        [sx, 0.0, sz],
        [sx, sy, sz],
        [0.0, sy, sz],
    ];
    let faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];

    let vertices: String = corners
        .iter()
        .map(|[x, y, z]| format!("          <vertex x=\"{x}\" y=\"{y}\" z=\"{z}\"/>\n"))
        .collect();
    let triangles: String = faces
        .iter()
        .map(|[a, b, c]| format!("          <triangle v1=\"{a}\" v2=\"{b}\" v3=\"{c}\"/>\n"))
        .collect();

    format!(
        r#"    <object id="{id}" name="{name}" type="model"{extra_attrs}>
      <mesh>
        <vertices>
{vertices}        </vertices>
        <triangles>
{triangles}        </triangles>
      </mesh>
    </object>"#
    )
}

/// A single triangle mesh object, for cases where geometry is incidental.
pub fn triangle_object(id: &str, name: &str) -> String {
    format!(
        r#"    <object id="{id}" name="{name}" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="2" y="0" z="0"/>
          <vertex x="0" y="3" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>"#
    )
}

/// A Production Extension package: the root model references `external_parts`
/// via `p:path`, so the reader must consult `[Content_Types].xml` and the model
/// relationships to resolve them.
pub fn production_package(
    root_model: &str,
    external_parts: &[(&str, &str)],
    content_types_xml: &str,
) -> Vec<u8> {
    let mut model_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (index, (path, _)) in external_parts.iter().enumerate() {
        model_rels.push_str(&format!(
            r#"<Relationship Id="ext{index}" Target="/{}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>"#,
            path.trim_start_matches('/')
        ));
    }
    model_rels.push_str("</Relationships>");

    let mut parts = vec![
        Part::text(CONTENT_TYPES_PART, content_types_xml),
        Part::text(RELATIONSHIPS_PART, RELS_XML),
        Part::text(DEFAULT_MODEL_PART, root_model),
        Part::text("3D/_rels/3dmodel.model.rels", &model_rels),
    ];
    for (path, xml) in external_parts {
        parts.push(Part::text(path.trim_start_matches('/'), xml));
    }
    zip_parts(&parts)
}

/// Lowercase hex SHA-256, used for fixture provenance in the manifest.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A 1x1 PNG, small enough to embed inline as a plate thumbnail.
pub fn tiny_png() -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0x2a, 0x7f, 0xd0]).unwrap();
    }
    out
}
