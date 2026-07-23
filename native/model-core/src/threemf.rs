//! Pure-Rust 3MF (3D Manufacturing Format) reading.
//!
//! A 3MF file is an OPC package — a ZIP archive whose primary part is an XML
//! model (located through the package relationships, conventionally at
//! `3D/3dmodel.model`). The model declares reusable *objects* that are either a
//! `mesh` or a set of transformed `components`, and a *build* that lists the
//! object instances placed on the plate.
//!
//! This module reads standard 3MF geometry with **no native dependencies**:
//! `zip` (pure-Rust miniz_oxide deflate) unpacks the archive and `quick-xml`
//! streams the model. It flattens the build into a single indexed triangle mesh
//! ready for the viewer and thumbnails. Vendor extensions (Bambu/Orca/Prusa
//! multi-plate metadata, painted seams, beam lattices) are intentionally out of
//! scope and handled elsewhere.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use thiserror::Error;
use zip::result::ZipError;
use zip::ZipArchive;

use crate::geometry::Aabb;

/// Upper bounds so a malformed or hostile package cannot exhaust memory.
pub const MAX_VERTICES: usize = 20_000_000;
pub const MAX_TRIANGLES: usize = 40_000_000;
pub const MAX_MODEL_PARTS: usize = 10_000;
/// Maximum component nesting depth; also breaks any reference cycle.
pub const MAX_COMPONENT_DEPTH: usize = 50;

/// Conventional location of the model part when relationships are absent.
const DEFAULT_MODEL_PART: &str = "3D/3dmodel.model";
const RELATIONSHIPS_PART: &str = "_rels/.rels";

#[derive(Debug, Error)]
pub enum ThreeMfError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip error: {0}")]
    Zip(#[from] ZipError),
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("package has no 3D model part")]
    MissingModelPart,
    #[error("malformed 3MF model: {0}")]
    Malformed(String),
    #[error("model exceeds the maximum supported size")]
    TooLarge,
}

/// An affine transform stored as four rows of three: rows 0..2 are the linear
/// basis for x, y, z and row 3 is the translation. This mirrors the 3MF `3x4`
/// row-major matrix, where a point maps as `p * linear + translation`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    rows: [[f32; 3]; 4],
}

impl Transform {
    pub fn identity() -> Self {
        Self {
            rows: [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 0.0],
            ],
        }
    }

    /// Parse the 3MF `transform` attribute: twelve space-separated numbers in
    /// row-major order (`m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`).
    pub fn parse(s: &str) -> Result<Self, ThreeMfError> {
        let mut values = [0.0f32; 12];
        let mut count = 0;
        for token in s.split_whitespace() {
            if count == 12 {
                return Err(ThreeMfError::Malformed(
                    "transform has more than 12 values".into(),
                ));
            }
            values[count] = token.parse::<f32>().map_err(|_| {
                ThreeMfError::Malformed(format!("invalid transform value '{token}'"))
            })?;
            count += 1;
        }
        if count != 12 {
            return Err(ThreeMfError::Malformed(format!(
                "transform needs 12 values, found {count}"
            )));
        }
        Ok(Self {
            rows: [
                [values[0], values[1], values[2]],
                [values[3], values[4], values[5]],
                [values[6], values[7], values[8]],
                [values[9], values[10], values[11]],
            ],
        })
    }

    /// Apply the transform to a point.
    pub fn apply(&self, p: [f32; 3]) -> [f32; 3] {
        let [x, y, z] = p;
        [
            x * self.rows[0][0] + y * self.rows[1][0] + z * self.rows[2][0] + self.rows[3][0],
            x * self.rows[0][1] + y * self.rows[1][1] + z * self.rows[2][1] + self.rows[3][1],
            x * self.rows[0][2] + y * self.rows[1][2] + z * self.rows[2][2] + self.rows[3][2],
        ]
    }

    /// Compose so that a point is transformed by `self` first and then by
    /// `then`: `result.apply(p) == then.apply(self.apply(p))`. Used to fold a
    /// component's local transform into its parent's accumulated transform.
    pub fn compose(&self, then: &Transform) -> Transform {
        let mut rows = [[0.0f32; 3]; 4];
        for (i, row) in rows.iter_mut().enumerate().take(3) {
            for (k, cell) in row.iter_mut().enumerate() {
                *cell = self.rows[i][0] * then.rows[0][k]
                    + self.rows[i][1] * then.rows[1][k]
                    + self.rows[i][2] * then.rows[2][k];
            }
        }
        for (k, cell) in rows[3].iter_mut().enumerate() {
            *cell = self.rows[3][0] * then.rows[0][k]
                + self.rows[3][1] * then.rows[1][k]
                + self.rows[3][2] * then.rows[2][k]
                + then.rows[3][k];
        }
        Transform { rows }
    }
}

/// A single component reference: another object placed with a transform.
#[derive(Debug, Clone)]
struct Component {
    object_id: u32,
    model_part: Option<String>,
    transform: Transform,
}

/// The geometry an object carries: raw mesh data or an assembly of components.
#[derive(Debug, Clone)]
enum ObjectGeometry {
    Mesh {
        vertices: Vec<[f32; 3]>,
        triangles: Vec<[u32; 3]>,
    },
    Components(Vec<Component>),
}

/// A parsed but not-yet-flattened object keyed later by its id.
#[derive(Debug, Clone)]
struct RawObject {
    geometry: ObjectGeometry,
    /// The object's declared `name` attribute, when present.
    name: Option<String>,
}

/// The model document: reusable objects plus the build's placed instances.
#[derive(Debug, Clone)]
struct RawModel {
    objects: HashMap<u32, RawObject>,
    build: Vec<Component>,
    unit: String,
}

/// All model documents needed to resolve the root model's local and Production
/// Extension object references. Object IDs are scoped to each model part.
#[derive(Debug)]
struct RawPackage {
    models: HashMap<String, RawModel>,
    root_part: String,
}

/// One placed build instance, retained as a selectable "part" of the flattened
/// scene. `triangle_start`/`triangle_count` index into [`ThreeMfMesh::triangles`]
/// so the viewer can isolate or hide an instance without a second parse.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfPart {
    pub name: String,
    pub triangle_start: usize,
    pub triangle_count: usize,
}

/// A flattened 3MF model: one indexed triangle mesh with every build instance
/// baked into world space, ready for rendering.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfMesh {
    pub vertices: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub bounds: Aabb,
    /// Declared model unit (e.g. `"millimeter"`); defaults to `"millimeter"`.
    pub unit: String,
    /// Distinct objects declared in the document.
    pub object_count: usize,
    /// Instances placed by the build.
    pub build_item_count: usize,
    /// One entry per build item, in build order, mapping to triangle ranges.
    pub parts: Vec<ThreeMfPart>,
}

impl ThreeMfMesh {
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    pub fn vertex_count(&self) -> usize {
        self.vertices.len()
    }
}

/// Parse a 3MF file from disk.
pub fn parse_file(path: &Path) -> Result<ThreeMfMesh, ThreeMfError> {
    let data = std::fs::read(path)?;
    parse_bytes(&data)
}

/// Parse a 3MF package from an in-memory byte buffer.
pub fn parse_bytes(data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
    let mut archive = ZipArchive::new(Cursor::new(data))?;
    let root_part = locate_model_part(&mut archive)?;
    let root_xml = read_entry(&mut archive, &root_part)?.ok_or(ThreeMfError::MissingModelPart)?;
    let root_model = parse_model_xml(&root_xml, true)?;

    let mut referenced_parts = referenced_model_parts(&root_model);
    referenced_parts.remove(&root_part);
    if referenced_parts.len() > MAX_MODEL_PARTS {
        return Err(ThreeMfError::TooLarge);
    }
    let mut external_parts: Vec<String> = referenced_parts.into_iter().collect();
    external_parts.sort();

    let mut models = HashMap::with_capacity(external_parts.len() + 1);
    for model_part in external_parts {
        let xml = read_entry(&mut archive, &model_part)?.ok_or_else(|| {
            ThreeMfError::Malformed(format!("referenced model part '/{model_part}' is missing"))
        })?;
        let model = parse_model_xml(&xml, false)?;
        models.insert(model_part, model);
    }
    models.insert(root_part.clone(), root_model);

    flatten(&RawPackage { models, root_part })
}

/// Resolve the model part path, preferring the package relationships and
/// falling back to the conventional `3D/3dmodel.model`.
pub(crate) fn locate_model_part<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<String, ThreeMfError> {
    if let Some(rels) = read_entry(archive, RELATIONSHIPS_PART)? {
        if let Some(target) = model_target_from_rels(&rels)? {
            let cleaned = target.trim_start_matches('/').to_string();
            if archive.by_name(&cleaned).is_ok() {
                return Ok(cleaned);
            }
        }
    }
    if archive.by_name(DEFAULT_MODEL_PART).is_ok() {
        return Ok(DEFAULT_MODEL_PART.to_string());
    }
    Err(ThreeMfError::MissingModelPart)
}

/// Read a named entry to a string, returning `None` if it is absent.
pub(crate) fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<String>, ThreeMfError> {
    match archive.by_name(name) {
        Ok(mut file) => {
            let mut contents = String::new();
            file.read_to_string(&mut contents)?;
            Ok(Some(contents))
        }
        Err(ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Read a named entry to raw bytes, returning `None` if it is absent.
pub(crate) fn read_entry_bytes<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, ThreeMfError> {
    match archive.by_name(name) {
        Ok(mut file) => {
            let mut contents = Vec::new();
            file.read_to_end(&mut contents)?;
            Ok(Some(contents))
        }
        Err(ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Find the target of the relationship whose type marks the 3D model part.
fn model_target_from_rels(xml: &str) -> Result<Option<String>, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event()? {
            Event::Empty(e) | Event::Start(e) if e.name().as_ref() == b"Relationship" => {
                let rel_type = get_attr(&e, b"Type").unwrap_or_default();
                if rel_type.ends_with("3dmodel") {
                    return Ok(get_attr(&e, b"Target"));
                }
            }
            Event::Eof => return Ok(None),
            _ => {}
        }
    }
}

/// Stream the model XML into reusable objects and the build's instance list.
fn parse_model_xml(xml: &str, is_root_model: bool) -> Result<RawModel, ThreeMfError> {
    let mut reader = Reader::from_str(xml);

    let mut objects: HashMap<u32, RawObject> = HashMap::new();
    let mut build: Vec<Component> = Vec::new();
    let mut unit = String::from("millimeter");

    let mut current_id: Option<u32> = None;
    let mut current_geometry: Option<ObjectGeometry> = None;
    let mut current_name: Option<String> = None;
    let mut in_build = false;

    loop {
        match reader.read_event()? {
            Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                b"model" => {
                    if let Some(u) = get_attr(&e, b"unit") {
                        unit = u;
                    }
                }
                b"object" => {
                    current_id = Some(attr_u32(&e, b"id")?);
                    current_geometry = None;
                    current_name = get_attr(&e, b"name").filter(|n| !n.trim().is_empty());
                }
                b"mesh" => {
                    current_geometry = Some(ObjectGeometry::Mesh {
                        vertices: Vec::new(),
                        triangles: Vec::new(),
                    });
                }
                b"vertex" => {
                    if let Some(ObjectGeometry::Mesh { vertices, .. }) = current_geometry.as_mut() {
                        vertices.push([
                            attr_f32(&e, b"x")?,
                            attr_f32(&e, b"y")?,
                            attr_f32(&e, b"z")?,
                        ]);
                    }
                }
                b"triangle" => {
                    if let Some(ObjectGeometry::Mesh { triangles, .. }) = current_geometry.as_mut()
                    {
                        triangles.push([
                            attr_u32(&e, b"v1")?,
                            attr_u32(&e, b"v2")?,
                            attr_u32(&e, b"v3")?,
                        ]);
                    }
                }
                b"components" => {
                    current_geometry = Some(ObjectGeometry::Components(Vec::new()));
                }
                b"component" => {
                    if let Some(ObjectGeometry::Components(list)) = current_geometry.as_mut() {
                        list.push(Component {
                            object_id: attr_u32(&e, b"objectid")?,
                            model_part: optional_model_part(&e, is_root_model)?,
                            transform: optional_transform(&e)?,
                        });
                    }
                }
                b"build" => in_build = is_root_model,
                b"item" if in_build => {
                    build.push(Component {
                        object_id: attr_u32(&e, b"objectid")?,
                        model_part: optional_model_part(&e, is_root_model)?,
                        transform: optional_transform(&e)?,
                    });
                }
                _ => {}
            },
            Event::End(e) => match e.name().as_ref() {
                b"object" => {
                    if let Some(id) = current_id.take() {
                        let geometry = current_geometry.take().unwrap_or(ObjectGeometry::Mesh {
                            vertices: Vec::new(),
                            triangles: Vec::new(),
                        });
                        objects.insert(
                            id,
                            RawObject {
                                geometry,
                                name: current_name.take(),
                            },
                        );
                    }
                }
                b"build" => in_build = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(RawModel {
        objects,
        build,
        unit,
    })
}

fn referenced_model_parts(model: &RawModel) -> HashSet<String> {
    let mut parts = HashSet::new();
    for item in &model.build {
        if let Some(model_part) = &item.model_part {
            parts.insert(model_part.clone());
        }
    }
    for object in model.objects.values() {
        if let ObjectGeometry::Components(components) = &object.geometry {
            for component in components {
                if let Some(model_part) = &component.model_part {
                    parts.insert(model_part.clone());
                }
            }
        }
    }
    parts
}

/// Expand the build into a single indexed mesh, baking every transform. Each
/// build item is recorded as a [`ThreeMfPart`] spanning the triangles it added.
fn flatten(package: &RawPackage) -> Result<ThreeMfMesh, ThreeMfError> {
    let root_model = package.models.get(&package.root_part).ok_or_else(|| {
        ThreeMfError::Malformed("resolved root model part is missing".to_string())
    })?;
    let mut vertices: Vec<[f32; 3]> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::new();
    let mut parts: Vec<ThreeMfPart> = Vec::with_capacity(root_model.build.len());

    for item in &root_model.build {
        let model_part = item.model_part.as_deref().unwrap_or(&package.root_part);
        let triangle_start = triangles.len();
        expand(
            package,
            model_part,
            item.object_id,
            item.transform,
            &mut vertices,
            &mut triangles,
            0,
        )?;
        parts.push(ThreeMfPart {
            name: part_name(package, model_part, item.object_id),
            triangle_start,
            triangle_count: triangles.len() - triangle_start,
        });
    }

    let mut bounds = Aabb::empty();
    for v in &vertices {
        bounds.expand(*v);
    }

    Ok(ThreeMfMesh {
        vertices,
        triangles,
        bounds,
        unit: root_model.unit.clone(),
        object_count: package
            .models
            .values()
            .map(|model| model.objects.len())
            .sum(),
        build_item_count: root_model.build.len(),
        parts,
    })
}

/// A human-readable label for a build item: the object's `name` when declared,
/// otherwise a stable `Object {id}` fallback.
fn part_name(package: &RawPackage, model_part: &str, object_id: u32) -> String {
    package
        .models
        .get(model_part)
        .and_then(|model| model.objects.get(&object_id))
        .and_then(|object| object.name.clone())
        .unwrap_or_else(|| format!("Object {object_id}"))
}

/// Recursively bake an object under `transform` into the output buffers.
fn expand(
    package: &RawPackage,
    model_part: &str,
    object_id: u32,
    transform: Transform,
    out_vertices: &mut Vec<[f32; 3]>,
    out_triangles: &mut Vec<[u32; 3]>,
    depth: usize,
) -> Result<(), ThreeMfError> {
    if depth > MAX_COMPONENT_DEPTH {
        return Err(ThreeMfError::Malformed(
            "component nesting too deep (possible reference cycle)".into(),
        ));
    }

    let model = package.models.get(model_part).ok_or_else(|| {
        ThreeMfError::Malformed(format!("referenced model part '/{model_part}' is missing"))
    })?;
    let object = model.objects.get(&object_id).ok_or_else(|| {
        ThreeMfError::Malformed(format!(
            "reference to unknown object {object_id} in model part '/{model_part}'"
        ))
    })?;

    match &object.geometry {
        ObjectGeometry::Mesh {
            vertices,
            triangles,
        } => {
            if out_vertices.len() + vertices.len() > MAX_VERTICES
                || out_triangles.len() + triangles.len() > MAX_TRIANGLES
            {
                return Err(ThreeMfError::TooLarge);
            }
            let base = out_vertices.len() as u32;
            let local_count = vertices.len() as u32;
            for v in vertices {
                out_vertices.push(transform.apply(*v));
            }
            for t in triangles {
                for &index in t {
                    if index >= local_count {
                        return Err(ThreeMfError::Malformed(format!(
                            "triangle index {index} out of range in object {object_id}"
                        )));
                    }
                }
                out_triangles.push([base + t[0], base + t[1], base + t[2]]);
            }
            Ok(())
        }
        ObjectGeometry::Components(components) => {
            for component in components {
                // Apply the component's local transform, then the accumulated one.
                let composed = component.transform.compose(&transform);
                let component_part = component.model_part.as_deref().unwrap_or(model_part);
                expand(
                    package,
                    component_part,
                    component.object_id,
                    composed,
                    out_vertices,
                    out_triangles,
                    depth + 1,
                )?;
            }
            Ok(())
        }
    }
}

/// Fetch an attribute's raw string value by name.
pub(crate) fn get_attr(e: &BytesStart, name: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
}

fn get_attr_by_local_name(e: &BytesStart, name: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref().rsplit(|byte| *byte == b':').next() == Some(name))
        .map(|attribute| String::from_utf8_lossy(&attribute.value).into_owned())
}

fn optional_model_part(
    e: &BytesStart,
    is_root_model: bool,
) -> Result<Option<String>, ThreeMfError> {
    let Some(path) = get_attr_by_local_name(e, b"path") else {
        return Ok(None);
    };
    if !is_root_model {
        return Err(ThreeMfError::Malformed(
            "Production Extension paths are only valid in the root model part".to_string(),
        ));
    }
    normalize_model_part_path(&path).map(Some)
}

fn normalize_model_part_path(path: &str) -> Result<String, ThreeMfError> {
    let path = path.trim();
    if path.is_empty() || path.contains('\\') {
        return Err(ThreeMfError::Malformed(format!(
            "invalid Production Extension model path '{path}'"
        )));
    }

    let path = path.trim_start_matches('/');
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ThreeMfError::Malformed(format!(
            "invalid Production Extension model path '{path}'"
        )));
    }
    Ok(path.to_string())
}

fn attr_u32(e: &BytesStart, name: &[u8]) -> Result<u32, ThreeMfError> {
    let raw = get_attr(e, name).ok_or_else(|| {
        ThreeMfError::Malformed(format!(
            "missing '{}' attribute",
            String::from_utf8_lossy(name)
        ))
    })?;
    raw.trim().parse::<u32>().map_err(|_| {
        ThreeMfError::Malformed(format!(
            "invalid '{}' value '{raw}'",
            String::from_utf8_lossy(name)
        ))
    })
}

fn attr_f32(e: &BytesStart, name: &[u8]) -> Result<f32, ThreeMfError> {
    let raw = get_attr(e, name).ok_or_else(|| {
        ThreeMfError::Malformed(format!(
            "missing '{}' attribute",
            String::from_utf8_lossy(name)
        ))
    })?;
    raw.trim().parse::<f32>().map_err(|_| {
        ThreeMfError::Malformed(format!(
            "invalid '{}' value '{raw}'",
            String::from_utf8_lossy(name)
        ))
    })
}

/// Parse an optional `transform` attribute, defaulting to the identity.
fn optional_transform(e: &BytesStart) -> Result<Transform, ThreeMfError> {
    match get_attr(e, b"transform") {
        Some(s) => Transform::parse(&s),
        None => Ok(Transform::identity()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    const RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;

    /// Build a minimal 3MF package around a model XML document.
    fn package(model_xml: &str, include_rels: bool, model_part: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            if include_rels {
                writer.start_file(RELATIONSHIPS_PART, options).unwrap();
                writer.write_all(RELS_XML.as_bytes()).unwrap();
            }
            writer.start_file(model_part, options).unwrap();
            writer.write_all(model_xml.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    fn production_package(root_xml: &str, model_parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(RELATIONSHIPS_PART, options).unwrap();
            writer.write_all(RELS_XML.as_bytes()).unwrap();
            writer.start_file(DEFAULT_MODEL_PART, options).unwrap();
            writer.write_all(root_xml.as_bytes()).unwrap();

            let mut model_rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
            );
            for (index, (path, _)) in model_parts.iter().enumerate() {
                model_rels.push_str(&format!(
                    r#"<Relationship Id="rel{index}" Target="/{}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>"#,
                    path.trim_start_matches('/')
                ));
            }
            model_rels.push_str("</Relationships>");
            writer
                .start_file("3D/_rels/3dmodel.model.rels", options)
                .unwrap();
            writer.write_all(model_rels.as_bytes()).unwrap();

            for (path, xml) in model_parts {
                writer
                    .start_file(path.trim_start_matches('/'), options)
                    .unwrap();
                writer.write_all(xml.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    /// A single-triangle mesh object placed by one build item.
    fn single_triangle_model() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
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
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>"#
            .to_string()
    }

    #[test]
    fn parses_a_single_triangle_with_bounds() {
        let data = package(&single_triangle_model(), true, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&data).unwrap();
        assert_eq!(mesh.vertex_count(), 3);
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.triangles[0], [0, 1, 2]);
        assert_eq!(mesh.bounds.min, [0.0, 0.0, 0.0]);
        assert_eq!(mesh.bounds.max, [2.0, 3.0, 0.0]);
        assert_eq!(mesh.unit, "millimeter");
        assert_eq!(mesh.object_count, 1);
        assert_eq!(mesh.build_item_count, 1);
        assert_eq!(mesh.parts.len(), 1);
        assert_eq!(mesh.parts[0].name, "Object 1");
        assert_eq!(mesh.parts[0].triangle_start, 0);
        assert_eq!(mesh.parts[0].triangle_count, 1);
    }

    #[test]
    fn records_named_parts_per_build_item() {
        let model = r#"<?xml version="1.0"?>
<model unit="millimeter">
  <resources>
    <object id="1" type="model" name="Body">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
    <item objectid="2"/>
  </build>
</model>"#;
        let data = package(model, false, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&data).unwrap();
        assert_eq!(mesh.parts.len(), 2);
        assert_eq!(mesh.parts[0].name, "Body");
        assert_eq!(mesh.parts[0].triangle_start, 0);
        assert_eq!(mesh.parts[0].triangle_count, 1);
        // The unnamed object falls back to "Object {id}" and begins where the
        // first part ended.
        assert_eq!(mesh.parts[1].name, "Object 2");
        assert_eq!(mesh.parts[1].triangle_start, 1);
        assert_eq!(mesh.parts[1].triangle_count, 2);
    }

    #[test]
    fn falls_back_to_conventional_model_part_without_relationships() {
        let data = package(&single_triangle_model(), false, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&data).unwrap();
        assert_eq!(mesh.triangle_count(), 1);
    }

    #[test]
    fn resolves_model_part_from_relationships() {
        // Put the model at a non-conventional path only discoverable via rels.
        let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/custom.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(RELATIONSHIPS_PART, options).unwrap();
            writer.write_all(rels.as_bytes()).unwrap();
            writer.start_file("3D/custom.model", options).unwrap();
            writer
                .write_all(single_triangle_model().as_bytes())
                .unwrap();
            writer.finish().unwrap();
        }
        let mesh = parse_bytes(&buf).unwrap();
        assert_eq!(mesh.triangle_count(), 1);
    }

    #[test]
    fn applies_build_item_transform() {
        let model = r#"<?xml version="1.0"?>
<model unit="millimeter">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/>
  </build>
</model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&data).unwrap();
        assert_eq!(mesh.bounds.min, [10.0, 20.0, 30.0]);
        assert_eq!(mesh.bounds.max, [11.0, 21.0, 30.0]);
    }

    #[test]
    fn flattens_components_with_composed_transforms() {
        // Object 2 is a unit triangle; object 1 assembles it with a translation;
        // the build places object 1 with a further translation. Offsets add.
        let model = r#"<?xml version="1.0"?>
<model unit="millimeter">
  <resources>
    <object id="2" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
    <object id="1" type="model">
      <components>
        <component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 7 0"/>
  </build>
</model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&data).unwrap();
        assert_eq!(mesh.object_count, 2);
        assert_eq!(mesh.triangle_count(), 1);
        // Vertex (0,0,0) -> component +x5 -> build +y7 = (5,7,0).
        assert_eq!(mesh.bounds.min, [5.0, 7.0, 0.0]);
        assert_eq!(mesh.bounds.max, [6.0, 8.0, 0.0]);
    }

    #[test]
    fn resolves_production_extension_component_paths() {
        let root = r#"<?xml version="1.0"?>
<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="2" type="model" name="Assembly">
      <components>
        <component p:path="/3D/Objects/body.model" objectid="1"
          transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 7 0"/>
  </build>
</model>"#;
        let body = r#"<?xml version="1.0"?>
<model unit="millimeter">
  <resources>
    <object id="1" type="model" name="Body">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="999"/></build>
</model>"#;
        let data = production_package(root, &[("3D/Objects/body.model", body)]);
        let mesh = parse_bytes(&data).unwrap();

        assert_eq!(mesh.object_count, 2);
        assert_eq!(mesh.build_item_count, 1);
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.bounds.min, [5.0, 7.0, 0.0]);
        assert_eq!(mesh.bounds.max, [6.0, 8.0, 0.0]);
        assert_eq!(mesh.parts[0].name, "Assembly");
    }

    #[test]
    fn resolves_production_extension_build_item_paths() {
        let root = r#"<?xml version="1.0"?>
<model unit="millimeter" xmlns:prod="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources/>
  <build>
    <item prod:path="/3D/Objects/body.model" objectid="1"
      transform="1 0 0 0 1 0 0 0 1 2 3 4"/>
  </build>
</model>"#;
        let body = r#"<?xml version="1.0"?>
<model unit="millimeter">
  <resources>
    <object id="1" type="model" name="External body">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
</model>"#;
        let data = production_package(root, &[("3D/Objects/body.model", body)]);
        let mesh = parse_bytes(&data).unwrap();

        assert_eq!(mesh.bounds.min, [2.0, 3.0, 4.0]);
        assert_eq!(mesh.bounds.max, [3.0, 4.0, 4.0]);
        assert_eq!(mesh.parts[0].name, "External body");
    }

    #[test]
    fn rejects_production_paths_in_non_root_components() {
        let root = r#"<model xmlns:p="urn:production"><resources/><build>
  <item p:path="/3D/Objects/body.model" objectid="1"/>
</build></model>"#;
        let body = r#"<model xmlns:p="urn:production"><resources>
  <object id="1"><components>
    <component p:path="/3D/Objects/nested.model" objectid="2"/>
  </components></object>
</resources></model>"#;
        let nested = single_triangle_model();
        let data = production_package(
            root,
            &[
                ("3D/Objects/body.model", body),
                ("3D/Objects/nested.model", &nested),
            ],
        );

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("only valid in the root model part"));
    }

    #[test]
    fn reports_missing_production_model_parts() {
        let root = r#"<model xmlns:p="urn:production"><resources/><build>
  <item p:path="/3D/Objects/missing.model" objectid="1"/>
</build></model>"#;
        let data = package(root, true, DEFAULT_MODEL_PART);

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("referenced model part '/3D/Objects/missing.model' is missing"));
    }

    #[test]
    fn rejects_unsafe_production_model_paths() {
        let root = r#"<model xmlns:p="urn:production"><resources/><build>
  <item p:path="/3D/../outside.model" objectid="1"/>
</build></model>"#;
        let data = package(root, true, DEFAULT_MODEL_PART);

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("invalid Production Extension model path"));
    }

    #[test]
    fn build_referencing_unknown_object_errors() {
        let model = r#"<model><resources></resources><build><item objectid="99"/></build></model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);
        assert!(matches!(
            parse_bytes(&data),
            Err(ThreeMfError::Malformed(_))
        ));
    }

    #[test]
    fn triangle_index_out_of_range_errors() {
        let model = r#"<model><resources>
    <object id="1" type="model"><mesh>
      <vertices><vertex x="0" y="0" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
  </resources><build><item objectid="1"/></build></model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);
        assert!(matches!(
            parse_bytes(&data),
            Err(ThreeMfError::Malformed(_))
        ));
    }

    #[test]
    fn component_cycle_is_rejected() {
        // Object 1 -> object 2 -> object 1 ... depth guard must stop it.
        let model = r#"<model><resources>
    <object id="1" type="model"><components><component objectid="2"/></components></object>
    <object id="2" type="model"><components><component objectid="1"/></components></object>
  </resources><build><item objectid="1"/></build></model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);
        assert!(matches!(
            parse_bytes(&data),
            Err(ThreeMfError::Malformed(_))
        ));
    }

    #[test]
    fn non_zip_data_is_an_error() {
        assert!(parse_bytes(b"definitely not a zip archive").is_err());
    }

    #[test]
    fn transform_parse_requires_twelve_values() {
        assert!(Transform::parse("1 0 0 0 1 0 0 0 1").is_err());
        assert!(Transform::parse("1 0 0 0 1 0 0 0 1 0 0 0").is_ok());
    }

    #[test]
    fn transform_compose_matches_sequential_application() {
        let a = Transform::parse("1 0 0 0 1 0 0 0 1 1 2 3").unwrap();
        let b = Transform::parse("2 0 0 0 2 0 0 0 2 0 0 0").unwrap();
        let composed = a.compose(&b);
        let p = [1.0, 1.0, 1.0];
        assert_eq!(composed.apply(p), b.apply(a.apply(p)));
    }
}
