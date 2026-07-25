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
use std::io::{self, Cursor, Read, Seek};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, Reader};
use thiserror::Error;
use zip::result::ZipError;
use zip::ZipArchive;

use crate::geometry::Aabb;
use crate::limits::{LimitViolation, ParseGuard, ParseLimits};
use crate::scene_status::SceneLoadStatus;

/// Upper bounds so a malformed or hostile package cannot exhaust memory.
pub const MAX_VERTICES: usize = 20_000_000;
pub const MAX_TRIANGLES: usize = 40_000_000;
pub const MAX_OBJECTS: usize = 1_000_000;
pub const MAX_COMPONENTS: usize = 1_000_000;
pub const MAX_MODEL_PARTS: usize = 10_000;
pub const MAX_EXPANSION_STEPS: usize = 1_000_000;
/// Renderer GPU budget: each mesh-bearing object becomes a live
/// Group+BufferGeometry+Material+Mesh on the renderer side, so cap them well
/// below the parser's structural safety ceiling.
pub const MAX_RENDERABLE_SCENE_OBJECTS: usize = 5_000;
const MAX_ARCHIVE_PARTS: usize = 100_000;
pub const MAX_MODEL_XML_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_MODEL_XML_BYTES: u64 = 1024 * 1024 * 1024;
/// Maximum component nesting depth; also breaks any reference cycle.
pub const MAX_COMPONENT_DEPTH: usize = 50;
/// Ceiling on `<base>`/`<color>` entries across every appearance resource in a
/// model part. Each entry is attacker-controlled and carries an owned name, so
/// an unbounded table is a cheap memory-amplification primitive.
pub const MAX_APPEARANCE_ENTRIES: usize = 1_000_000;
/// Longest accepted `<base name="...">`. Material labels are display strings,
/// not payloads.
const MAX_MATERIAL_NAME_BYTES: usize = 256;

/// Conventional location of the model part when relationships are absent.
const DEFAULT_MODEL_PART: &str = "3D/3dmodel.model";
const RELATIONSHIPS_PART: &str = "_rels/.rels";
const CONTENT_TYPES_PART: &str = "[Content_Types].xml";
const MAX_METADATA_XML_BYTES: u64 = 8 * 1024 * 1024;
const MODEL_CONTENT_TYPE: &str = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
const MODEL_RELATIONSHIP_TYPE: &str =
    "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const PRODUCTION_NAMESPACE: &[u8] =
    b"http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const RELATIONSHIPS_NAMESPACE: &[u8] =
    b"http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NAMESPACE: &[u8] =
    b"http://schemas.openxmlformats.org/package/2006/content-types";

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
    #[error("lib3mf error: {0}")]
    Lib3Mf(String),
    #[error("model exceeds the maximum supported size")]
    TooLarge,
    #[error(
        "model expands to {mesh_objects} mesh-bearing scene objects, exceeding the renderer budget of {max_mesh_objects}"
    )]
    RenderBudgetExceeded {
        mesh_objects: usize,
        max_mesh_objects: usize,
    },
    #[error("{resource} exceeds the maximum supported size of {limit} bytes")]
    DataTooLarge { resource: &'static str, limit: u64 },
    #[error("{resource} exceeds the maximum supported count of {limit}")]
    TooManyParts {
        resource: &'static str,
        limit: usize,
    },
    #[error("{0}")]
    Limit(#[from] LimitViolation),
    #[error("{context} contains a non-finite number ('{value}')")]
    NonFiniteNumber {
        context: &'static str,
        value: String,
    },
}

impl ThreeMfError {
    /// A stable machine-readable code for the Electron layer's diagnostics. All
    /// structural corruption collapses to `malformed`; security-budget
    /// rejections keep their specific [`LimitViolation`] code so a hostile
    /// package can be distinguished from a merely broken one.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Zip(_) => "zip",
            Self::Xml(_) => "xml",
            Self::MissingModelPart => "missing_model_part",
            Self::Malformed(_) => "malformed",
            Self::Lib3Mf(_) => "lib3mf",
            Self::TooLarge => "too_large",
            Self::RenderBudgetExceeded { .. } => "render_budget_exceeded",
            Self::DataTooLarge { .. } => "data_too_large",
            Self::TooManyParts { .. } => "too_many_parts",
            Self::Limit(violation) => violation.code(),
            Self::NonFiniteNumber { .. } => "non_finite_number",
        }
    }
}

/// Reject `NaN` and `±inf`. Non-finite coordinates poison every downstream
/// bound, serialize as JSON `null` over the RPC transport, and make the
/// renderer's camera framing degenerate, so they never reach a scene.
fn finite(value: f32, context: &'static str, raw: &str) -> Result<f32, ThreeMfError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(ThreeMfError::NonFiniteNumber {
            context,
            value: raw.to_string(),
        })
    }
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
            values[count] = finite(values[count], "transform", token)?;
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

    fn scale_translation(&mut self, factor: f32) {
        for coordinate in &mut self.rows[3] {
            *coordinate *= factor;
        }
    }

    pub fn to_row_major_4x4(&self) -> [f32; 16] {
        [
            self.rows[0][0],
            self.rows[1][0],
            self.rows[2][0],
            self.rows[3][0],
            self.rows[0][1],
            self.rows[1][1],
            self.rows[2][1],
            self.rows[3][1],
            self.rows[0][2],
            self.rows[1][2],
            self.rows[2][2],
            self.rows[3][2],
            0.0,
            0.0,
            0.0,
            1.0,
        ]
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
        /// Per-triangle `(pid, index)` appearance reference.
        ///
        /// Left empty when no triangle declares one, so an uncoloured mesh
        /// pays nothing; once any triangle does, this is backfilled and stays
        /// exactly `triangles.len()` long.
        triangle_appearance: Vec<Option<(u32, u32)>>,
    },
    Components(Vec<Component>),
}

/// One `<basematerials>` or `<colorgroup>` resource: a positional table that
/// `pindex`/`p1` attributes index into.
#[derive(Debug, Clone, Default)]
struct AppearanceGroup {
    colors: Vec<[u8; 3]>,
    /// Material names, parallel to `colors`. Only `<basematerials>` supplies
    /// them; a `<colorgroup>` leaves them `None`.
    names: Vec<Option<String>>,
}

impl AppearanceGroup {
    fn color_at(&self, index: u32) -> Option<[u8; 3]> {
        self.colors.get(usize::try_from(index).ok()?).copied()
    }

    fn name_at(&self, index: u32) -> Option<&str> {
        self.names.get(usize::try_from(index).ok()?)?.as_deref()
    }
}

/// A parsed but not-yet-flattened object keyed later by its id.
#[derive(Debug, Clone)]
struct RawObject {
    geometry: ObjectGeometry,
    /// The object's declared `name` attribute, when present.
    name: Option<String>,
    /// The object-level `(pid, pindex)` appearance reference, when declared.
    appearance: Option<(u32, u32)>,
}

/// The model document: reusable objects plus the build's placed instances.
#[derive(Debug, Clone)]
struct RawModel {
    objects: HashMap<u32, RawObject>,
    build: Vec<Component>,
    unit: String,
    /// `<basematerials>` / `<colorgroup>` resources, keyed by resource id.
    appearances: HashMap<u32, AppearanceGroup>,
}

impl RawModel {
    fn scale_to_unit(&mut self, factor: f32, target_unit: &str) {
        if factor != 1.0 {
            for object in self.objects.values_mut() {
                match &mut object.geometry {
                    ObjectGeometry::Mesh { vertices, .. } => {
                        for vertex in vertices {
                            for coordinate in vertex {
                                *coordinate *= factor;
                            }
                        }
                    }
                    ObjectGeometry::Components(components) => {
                        for component in components {
                            component.transform.scale_translation(factor);
                        }
                    }
                }
            }
            for item in &mut self.build {
                item.transform.scale_translation(factor);
            }
        }
        self.unit = target_unit.to_string();
    }
}

/// All model documents needed to resolve the root model's local and Production
/// Extension object references. Object IDs are scoped to each model part.
#[derive(Debug)]
struct RawPackage {
    models: HashMap<String, RawModel>,
    root_part: String,
}

#[derive(Debug, Default)]
struct ParseBudget {
    vertices: usize,
    triangles: usize,
    objects: usize,
    components: usize,
    appearances: usize,
}

impl ParseBudget {
    fn add(current: &mut usize, limit: usize) -> Result<(), ThreeMfError> {
        *current = current.checked_add(1).ok_or(ThreeMfError::TooLarge)?;
        if *current > limit {
            return Err(ThreeMfError::TooLarge);
        }
        Ok(())
    }

    fn add_vertex(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.vertices, MAX_VERTICES)
    }

    fn add_triangle(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.triangles, MAX_TRIANGLES)
    }

    fn add_object(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.objects, MAX_OBJECTS)
    }

    fn add_component(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.components, MAX_COMPONENTS)
    }

    fn add_appearance(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.appearances, MAX_APPEARANCE_ENTRIES)
    }
}

#[derive(Debug, Default)]
struct ContentTypes {
    defaults: HashMap<String, String>,
    overrides: HashMap<String, String>,
}

#[derive(Debug)]
pub(crate) struct PackageIndex {
    actual_names: HashMap<String, String>,
}

impl PackageIndex {
    fn actual_name(&self, part_name: &str) -> Option<&str> {
        self.actual_names
            .get(&opc_part_key(part_name))
            .map(String::as_str)
    }

    fn len(&self) -> usize {
        self.actual_names.len()
    }
}

impl ContentTypes {
    fn content_type_for(&self, model_part: &str) -> Option<&str> {
        self.overrides
            .get(model_part)
            .map(String::as_str)
            .or_else(|| {
                let extension = model_part.rsplit_once('.')?.1.to_ascii_lowercase();
                self.defaults.get(&extension).map(String::as_str)
            })
    }
}

/// One placed build instance, retained as a selectable "part" of the flattened
/// scene. `triangle_start`/`triangle_count` index into [`ThreeMfMesh::triangles`]
/// so the viewer can isolate or hide an instance without a second parse.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfPart {
    pub name: String,
    pub triangle_start: usize,
    pub triangle_count: usize,
    pub status: SceneLoadStatus,
    pub status_detail: Option<String>,
    pub part_number: Option<String>,
    pub material_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ThreeMfMaterial {
    pub base_color: Option<[u8; 3]>,
    pub face_colors: Option<Vec<[u8; 3]>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfObjectMesh {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub bounds: Aabb,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfSceneObject {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub transform: Transform,
    pub mesh: Option<ThreeMfObjectMesh>,
    pub material: ThreeMfMaterial,
    pub plate_id: String,
    pub build_item_index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreeMfPlate {
    pub id: String,
    pub name: String,
    pub index: usize,
    pub root_object_ids: Vec<String>,
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
    /// Overall validation status for the normalized scene representation.
    pub status: SceneLoadStatus,
    /// Human-readable validation notes in deterministic order.
    pub status_messages: Vec<String>,
    /// One entry per build item, in build order, mapping to triangle ranges.
    pub parts: Vec<ThreeMfPart>,
    /// Hierarchical object instances in build order.
    pub objects: Vec<ThreeMfSceneObject>,
    pub root_object_ids: Vec<String>,
    pub plates: Vec<ThreeMfPlate>,
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

/// Parse a 3MF file with the native lib3mf validator/reader when the feature is
/// enabled.
#[cfg(feature = "lib3mf")]
pub fn parse_file_with_lib3mf(path: &Path) -> Result<ThreeMfMesh, ThreeMfError> {
    crate::threemf_lib3mf::parse_file(path)
}

/// Stage the pinned lib3mf shared library next to the current test executable.
#[cfg(feature = "lib3mf")]
#[doc(hidden)]
pub fn stage_lib3mf_test_library() -> Result<(), String> {
    crate::threemf_lib3mf::stage_test_library_for_current_exe()
}

/// Parse a 3MF package from an in-memory byte buffer using the default
/// security budget ([`ParseLimits::default`]).
pub fn parse_bytes(data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
    parse_bytes_with_limits(data, ParseLimits::default())
}

/// Parse a 3MF package under an explicit security budget, so a caller can
/// impose a tighter deadline or supply a cancellation token.
pub fn parse_bytes_with_limits(
    data: &[u8],
    limits: ParseLimits,
) -> Result<ThreeMfMesh, ThreeMfError> {
    let mut guard = ParseGuard::new(limits);
    let (mut archive, package_index) = open_package(data, &mut guard)?;

    let mut model_xml_bytes = 0u64;
    let mut parse_budget = ParseBudget::default();
    let root_part = locate_model_part_indexed(&mut archive, &package_index, &mut guard)?;
    let root_part_key = opc_part_key(&root_part);
    let root_xml = read_model_entry(&mut archive, &root_part, &mut model_xml_bytes, &mut guard)?
        .ok_or(ThreeMfError::MissingModelPart)?;
    let root_model = parse_model_xml(&root_xml, true, &mut parse_budget, &mut guard)?;
    let root_unit = root_model.unit.clone();
    let root_unit_scale = unit_scale_millimeters(&root_unit)?;

    let mut referenced_parts = referenced_model_parts(&root_model);
    referenced_parts.remove(&root_part_key);
    if referenced_parts.len() > MAX_MODEL_PARTS {
        return Err(ThreeMfError::TooLarge);
    }
    let mut external_parts: Vec<String> = referenced_parts.into_iter().collect();
    external_parts.sort();
    validate_external_model_parts(
        &mut archive,
        &package_index,
        &root_part,
        &external_parts,
        &mut guard,
    )?;

    let mut models = HashMap::with_capacity(external_parts.len() + 1);
    for model_part in external_parts {
        guard.check_now()?;
        let actual_name = package_index.actual_name(&model_part).ok_or_else(|| {
            ThreeMfError::Malformed(format!("referenced model part '/{model_part}' is missing"))
        })?;
        let xml = read_model_entry(&mut archive, actual_name, &mut model_xml_bytes, &mut guard)?
            .ok_or_else(|| {
                ThreeMfError::Malformed(format!("referenced model part '/{model_part}' is missing"))
            })?;
        let mut model = parse_model_xml(&xml, false, &mut parse_budget, &mut guard)?;
        let model_unit_scale = unit_scale_millimeters(&model.unit)?;
        model.scale_to_unit(model_unit_scale / root_unit_scale, &root_unit);
        models.insert(model_part, model);
    }
    models.insert(root_part_key.clone(), root_model);

    flatten(
        &RawPackage {
            models,
            root_part: root_part_key,
        },
        &mut guard,
    )
}

/// Parse a 3MF package with the native lib3mf validator/reader when the feature
/// is enabled.
#[cfg(feature = "lib3mf")]
pub fn parse_bytes_with_lib3mf(data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
    crate::threemf_lib3mf::parse_bytes(data)
}

/// Resolve the model part path, preferring the package relationships and
/// falling back to the conventional `3D/3dmodel.model`.
pub(crate) fn locate_model_part<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    guard: &mut ParseGuard,
) -> Result<String, ThreeMfError> {
    if let Some(relationships_name) = archive_part_name(archive, RELATIONSHIPS_PART)? {
        if let Some(relationships) =
            read_text_entry_limited(archive, &relationships_name, MAX_METADATA_XML_BYTES, guard)?
        {
            if let Some(target) = model_target_from_rels(&relationships, guard)? {
                if let Some(actual_name) = archive_part_name(archive, &target)? {
                    return Ok(actual_name);
                }
            }
        }
    }
    archive_part_name(archive, DEFAULT_MODEL_PART)?.ok_or(ThreeMfError::MissingModelPart)
}

fn archive_part_name<R: Read + Seek>(
    archive: &ZipArchive<R>,
    part_name: &str,
) -> Result<Option<String>, ThreeMfError> {
    let key = opc_part_key(part_name);
    let mut actual_name = None;
    for name in archive.file_names() {
        if opc_part_key(name) != key {
            continue;
        }
        if actual_name.replace(name.to_string()).is_some() {
            return Err(ThreeMfError::Malformed(
                "archive contains case-equivalent duplicate package parts".to_string(),
            ));
        }
    }
    Ok(actual_name)
}

fn locate_model_part_indexed<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_index: &PackageIndex,
    guard: &mut ParseGuard,
) -> Result<String, ThreeMfError> {
    if let Some(relationships_name) = package_index.actual_name(RELATIONSHIPS_PART) {
        let relationships_name = relationships_name.to_string();
        if let Some(relationships) =
            read_text_entry_limited(archive, &relationships_name, MAX_METADATA_XML_BYTES, guard)?
        {
            if let Some(target) = model_target_from_rels(&relationships, guard)? {
                if let Some(actual_name) = package_index.actual_name(&target) {
                    return Ok(actual_name.to_string());
                }
            }
        }
    }
    package_index
        .actual_name(DEFAULT_MODEL_PART)
        .map(str::to_string)
        .ok_or(ThreeMfError::MissingModelPart)
}

/// Read a named entry to a string, returning `None` if it is absent.
pub(crate) fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    guard: &mut ParseGuard,
) -> Result<Option<String>, ThreeMfError> {
    read_text_entry_limited(archive, name, MAX_MODEL_XML_BYTES, guard)
}

fn read_model_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    total_bytes: &mut u64,
    guard: &mut ParseGuard,
) -> Result<Option<String>, ThreeMfError> {
    let remaining = MAX_TOTAL_MODEL_XML_BYTES
        .checked_sub(*total_bytes)
        .ok_or(ThreeMfError::TooLarge)?;
    let limit = remaining.min(MAX_MODEL_XML_BYTES);
    let contents = read_text_entry_limited(archive, name, limit, guard)?;
    if let Some(contents) = &contents {
        *total_bytes = total_bytes
            .checked_add(contents.len() as u64)
            .ok_or(ThreeMfError::TooLarge)?;
    }
    Ok(contents)
}

fn read_text_entry_limited<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
    guard: &mut ParseGuard,
) -> Result<Option<String>, ThreeMfError> {
    guard.check_now()?;
    match archive.by_name(name) {
        Ok(mut file) => {
            if file.size() > max_bytes {
                return Err(ThreeMfError::TooLarge);
            }
            guard.charge_entry(name, file.compressed_size(), file.size())?;
            let bytes = read_entry_guarded(&mut file, max_bytes, 0, guard)?;
            if bytes.len() as u64 > max_bytes {
                return Err(ThreeMfError::TooLarge);
            }
            // Matches what `read_to_string` would have produced for non-UTF-8.
            let contents = String::from_utf8(bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            // The declared size is attacker-controlled, so charge whatever the
            // entry actually produced beyond what was already budgeted.
            let actual = contents.len() as u64;
            guard.charge_decompressed(actual.saturating_sub(file.size()))?;
            Ok(Some(contents))
        }
        Err(ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Read an entry to completion with the deadline observed *during* the read.
///
/// A single `read_to_end` is one uninterruptible blocking call: decompressing a
/// large entry can consume the entire time budget inside it and still return
/// success, because the surrounding checkpoints only sample the clock every so
/// many calls and an entry with few XML events may never reach another sample.
/// Chunking gives the guard a checkpoint per chunk, and the unsampled check
/// after the loop means an expiry is never reported as a successful parse.
fn read_entry_guarded(
    reader: &mut impl Read,
    max_bytes: u64,
    capacity: usize,
    guard: &mut ParseGuard,
) -> Result<Vec<u8>, ThreeMfError> {
    // Small enough that one chunk cannot outlast a sane deadline, large enough
    // that clock reads do not dominate an ordinary parse.
    const CHUNK_BYTES: usize = 64 * 1024;

    // One byte past the ceiling so the caller can still tell "exactly at the
    // limit" from "overran it", exactly as `take(max_bytes + 1)` did.
    let ceiling = max_bytes.saturating_add(1);
    let mut contents = Vec::with_capacity(capacity);
    let mut chunk = vec![0u8; CHUNK_BYTES];
    loop {
        guard.check_now()?;
        let remaining = ceiling.saturating_sub(contents.len() as u64);
        if remaining == 0 {
            break;
        }
        let want = usize::try_from(remaining)
            .unwrap_or(CHUNK_BYTES)
            .min(CHUNK_BYTES);
        match reader.read(&mut chunk[..want]) {
            Ok(0) => break,
            Ok(read) => contents.extend_from_slice(&chunk[..read]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    // Unsampled: the final chunk may have consumed what was left of the budget,
    // and a deadline that expires on the last read must not return success.
    guard.check_now()?;
    Ok(contents)
}

fn validate_archive_parts<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_index: &PackageIndex,
    guard: &mut ParseGuard,
) -> Result<(), ThreeMfError> {
    if archive.len() != package_index.len() {
        return Err(ThreeMfError::Malformed(
            "ZIP reader and central directory disagree on package parts".to_string(),
        ));
    }

    let mut seen = HashSet::with_capacity(archive.len());
    let mut declared_total = 0u64;
    for index in 0..archive.len() {
        guard.checkpoint()?;
        let file = archive.by_index(index)?;
        let name = file.name();
        let key = opc_part_key(name);
        if !seen.insert(key.clone())
            || package_index.actual_names.get(&key).map(String::as_str) != Some(name)
        {
            return Err(ThreeMfError::Malformed(
                "ZIP reader and central directory disagree on package parts".to_string(),
            ));
        }
        // Reject decompression bombs from the central directory before any
        // entry is opened, so a bomb parked in an unread part still fails the
        // package rather than lying in wait for a later feature to read it.
        guard.check_ratio(name, file.compressed_size(), file.size())?;
        declared_total = declared_total.saturating_add(file.size());
    }
    // Many entries can each sit under the ratio floor and still promise an
    // aggregate expansion past the budget.
    guard.check_declared_archive_total(declared_total)?;
    Ok(())
}

/// Open an in-memory package for reading, applying the archive-wide preflight
/// that every entry point must share: entry count, central-directory/reader
/// agreement, OPC part-name validation, per-entry decompression ratio, and
/// declared aggregate expansion.
///
/// An archive opened over borrowed package bytes, paired with its validated
/// central-directory index.
pub(crate) type OpenPackage<'a> = (ZipArchive<Cursor<&'a [u8]>>, PackageIndex);

/// **Every** public reader goes through here — scene *and* vendor. A path that
/// constructs [`ZipArchive`] directly is a second door into the same package
/// with none of these limits applied, which is exactly the bypass this
/// function exists to make structurally impossible.
pub(crate) fn open_package<'a>(
    data: &'a [u8],
    guard: &mut ParseGuard,
) -> Result<OpenPackage<'a>, ThreeMfError> {
    let package_index = package_index_from_zip(data)?;
    let mut archive = ZipArchive::new(Cursor::new(data))?;
    validate_archive_parts(&mut archive, &package_index, guard)?;
    Ok((archive, package_index))
}

fn package_index_from_zip(data: &[u8]) -> Result<PackageIndex, ThreeMfError> {
    const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const EOCD_MIN_SIZE: usize = 22;
    const MAX_COMMENT_SIZE: usize = u16::MAX as usize;

    if data.len() < EOCD_MIN_SIZE {
        return Err(ThreeMfError::Malformed(
            "ZIP end-of-central-directory record is missing".to_string(),
        ));
    }
    let search_start = data.len().saturating_sub(EOCD_MIN_SIZE + MAX_COMMENT_SIZE);
    let mut candidate_error = None;
    for eocd in (search_start..=data.len() - EOCD_MIN_SIZE).rev() {
        if data.get(eocd..eocd + 4) != Some(EOCD_SIGNATURE) {
            continue;
        }
        let Some(comment_size) = read_u16(data, eocd + 20) else {
            continue;
        };
        if eocd + EOCD_MIN_SIZE + comment_size as usize != data.len() {
            continue;
        }
        match package_index_from_eocd(data, eocd) {
            Ok(index) => return Ok(index),
            Err(error) if candidate_error.is_none() => candidate_error = Some(error),
            Err(_) => {}
        }
    }
    Err(candidate_error.unwrap_or_else(|| {
        ThreeMfError::Malformed(
            "ZIP end-of-central-directory record is missing or invalid".to_string(),
        )
    }))
}

fn package_index_from_eocd(data: &[u8], eocd: usize) -> Result<PackageIndex, ThreeMfError> {
    const ZIP64_EOCD_SIGNATURE: &[u8; 4] = b"PK\x06\x06";
    const ZIP64_LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";

    let disk = read_u16(data, eocd + 4).ok_or_else(invalid_central_directory)?;
    let central_disk = read_u16(data, eocd + 6).ok_or_else(invalid_central_directory)?;
    let entries_on_disk = read_u16(data, eocd + 8).ok_or_else(invalid_central_directory)?;
    let total_entries = read_u16(data, eocd + 10).ok_or_else(invalid_central_directory)?;
    let central_size = read_u32(data, eocd + 12).ok_or_else(invalid_central_directory)?;
    let central_offset = read_u32(data, eocd + 16).ok_or_else(invalid_central_directory)?;
    if disk != 0 || central_disk != 0 || entries_on_disk != total_entries {
        return Err(ThreeMfError::Malformed(
            "multi-disk ZIP packages are not supported".to_string(),
        ));
    }

    if total_entries != u16::MAX && central_size != u32::MAX && central_offset != u32::MAX {
        let start = central_offset as usize;
        let end = start
            .checked_add(central_size as usize)
            .ok_or_else(invalid_central_directory)?;
        if end != eocd {
            return Err(invalid_central_directory());
        }
        return parse_central_directory(data, start, end, total_entries as usize);
    }

    let locator = eocd.checked_sub(20).ok_or_else(invalid_central_directory)?;
    if data.get(locator..locator + 4) != Some(ZIP64_LOCATOR_SIGNATURE)
        || read_u32(data, locator + 4) != Some(0)
        || read_u32(data, locator + 16) != Some(1)
    {
        return Err(invalid_central_directory());
    }
    let zip64_eocd =
        usize::try_from(read_u64(data, locator + 8).ok_or_else(invalid_central_directory)?)
            .map_err(|_| ThreeMfError::TooLarge)?;
    let zip64_signature_end = zip64_eocd
        .checked_add(4)
        .ok_or_else(invalid_central_directory)?;
    if data.get(zip64_eocd..zip64_signature_end) != Some(ZIP64_EOCD_SIGNATURE) {
        return Err(invalid_central_directory());
    }
    let record_size =
        usize::try_from(read_u64(data, zip64_eocd + 4).ok_or_else(invalid_central_directory)?)
            .map_err(|_| ThreeMfError::TooLarge)?;
    if record_size < 44
        || zip64_eocd
            .checked_add(12)
            .and_then(|offset| offset.checked_add(record_size))
            != Some(locator)
    {
        return Err(invalid_central_directory());
    }

    let zip64_disk = read_u32(data, zip64_eocd + 16).ok_or_else(invalid_central_directory)?;
    let zip64_central_disk =
        read_u32(data, zip64_eocd + 20).ok_or_else(invalid_central_directory)?;
    let zip64_entries_on_disk =
        read_u64(data, zip64_eocd + 24).ok_or_else(invalid_central_directory)?;
    let zip64_total_entries =
        read_u64(data, zip64_eocd + 32).ok_or_else(invalid_central_directory)?;
    let zip64_central_size =
        usize::try_from(read_u64(data, zip64_eocd + 40).ok_or_else(invalid_central_directory)?)
            .map_err(|_| ThreeMfError::TooLarge)?;
    let zip64_central_offset =
        usize::try_from(read_u64(data, zip64_eocd + 48).ok_or_else(invalid_central_directory)?)
            .map_err(|_| ThreeMfError::TooLarge)?;
    if zip64_disk != 0 || zip64_central_disk != 0 || zip64_entries_on_disk != zip64_total_entries {
        return Err(ThreeMfError::Malformed(
            "multi-disk ZIP packages are not supported".to_string(),
        ));
    }
    let central_end = zip64_central_offset
        .checked_add(zip64_central_size)
        .ok_or_else(invalid_central_directory)?;
    if central_end != zip64_eocd {
        return Err(invalid_central_directory());
    }
    parse_central_directory(
        data,
        zip64_central_offset,
        central_end,
        usize::try_from(zip64_total_entries).map_err(|_| ThreeMfError::TooLarge)?,
    )
}

fn parse_central_directory(
    data: &[u8],
    start: usize,
    end: usize,
    entry_count: usize,
) -> Result<PackageIndex, ThreeMfError> {
    const CENTRAL_HEADER_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
    const CENTRAL_HEADER_SIZE: usize = 46;
    const DIGITAL_SIGNATURE: &[u8; 4] = b"PK\x05\x05";

    if entry_count > MAX_ARCHIVE_PARTS
        || entry_count > end.saturating_sub(start) / CENTRAL_HEADER_SIZE
    {
        return Err(ThreeMfError::TooLarge);
    }
    let mut actual_names = HashMap::with_capacity(entry_count);
    let mut offset = start;
    for _ in 0..entry_count {
        if data.get(offset..offset + 4) != Some(CENTRAL_HEADER_SIGNATURE)
            || offset + CENTRAL_HEADER_SIZE > end
        {
            return Err(invalid_central_directory());
        }
        let name_length =
            read_u16(data, offset + 28).ok_or_else(invalid_central_directory)? as usize;
        let extra_length =
            read_u16(data, offset + 30).ok_or_else(invalid_central_directory)? as usize;
        let comment_length =
            read_u16(data, offset + 32).ok_or_else(invalid_central_directory)? as usize;
        let name_start = offset + CENTRAL_HEADER_SIZE;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(invalid_central_directory)?;
        let next = name_end
            .checked_add(extra_length)
            .and_then(|value| value.checked_add(comment_length))
            .ok_or_else(invalid_central_directory)?;
        if next > end {
            return Err(invalid_central_directory());
        }
        let name = std::str::from_utf8(
            data.get(name_start..name_end)
                .ok_or_else(invalid_central_directory)?,
        )
        .map_err(|_| ThreeMfError::Malformed("package part names must be UTF-8".to_string()))?;
        validate_package_part_name(name)?;
        let key = opc_part_key(name);
        if actual_names.insert(key, name.to_string()).is_some() {
            return Err(ThreeMfError::Malformed(
                "archive contains case-equivalent duplicate package parts".to_string(),
            ));
        }
        offset = next;
    }

    if offset < end {
        if data.get(offset..offset + 4) != Some(DIGITAL_SIGNATURE) {
            return Err(invalid_central_directory());
        }
        let signature_size =
            read_u16(data, offset + 4).ok_or_else(invalid_central_directory)? as usize;
        offset = offset
            .checked_add(6)
            .and_then(|value| value.checked_add(signature_size))
            .ok_or_else(invalid_central_directory)?;
    }
    if offset != end {
        return Err(invalid_central_directory());
    }
    Ok(PackageIndex { actual_names })
}

fn validate_package_part_name(name: &str) -> Result<(), ThreeMfError> {
    let part_name = name.strip_suffix('/').unwrap_or(name);
    if part_name.is_empty()
        || part_name.starts_with('/')
        || part_name.contains('\\')
        || part_name
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ThreeMfError::Malformed(format!(
            "invalid package part name '{name}'"
        )));
    }
    Ok(())
}

fn opc_part_key(part_name: &str) -> String {
    part_name.to_ascii_lowercase()
}

fn invalid_central_directory() -> ThreeMfError {
    ThreeMfError::Malformed("invalid ZIP central directory".to_string())
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    Some(u16::from_le_bytes(data.get(offset..end)?.try_into().ok()?))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    Some(u32::from_le_bytes(data.get(offset..end)?.try_into().ok()?))
}

fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    Some(u64::from_le_bytes(data.get(offset..end)?.try_into().ok()?))
}

/// Read a named binary entry to raw bytes, returning `None` if it is absent.
pub(crate) fn read_entry_bytes<R: Read + Seek, F: Fn() -> ThreeMfError>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
    too_large: F,
    guard: &mut ParseGuard,
) -> Result<Option<Vec<u8>>, ThreeMfError> {
    guard.check_now()?;
    match archive.by_name(name) {
        Ok(mut file) => {
            if file.size() > max_bytes {
                return Err(too_large());
            }
            guard.charge_entry(name, file.compressed_size(), file.size())?;
            // Preallocate from the *declared* size only up to a modest cap: the
            // declaration is attacker-controlled, so trusting it would let a
            // few hundred bytes of archive reserve gigabytes. Beyond the cap the
            // Vec grows against real bytes, which `take` already bounds.
            const MAX_PREALLOCATED_BYTES: u64 = 1024 * 1024;
            let capacity = usize::try_from(file.size().min(MAX_PREALLOCATED_BYTES))
                .map_err(|_| too_large())?;
            let contents = read_entry_guarded(&mut file, max_bytes, capacity, guard)?;
            if contents.len() as u64 > max_bytes {
                return Err(too_large());
            }
            let actual = contents.len() as u64;
            guard.charge_decompressed(actual.saturating_sub(file.size()))?;
            Ok(Some(contents))
        }
        Err(ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Find the target of the relationship whose type marks the 3D model part.
fn model_target_from_rels(
    xml: &str,
    guard: &mut ParseGuard,
) -> Result<Option<String>, ThreeMfError> {
    let mut targets = model_relationship_targets(xml, "", guard)?;
    if targets.len() > 1 {
        return Err(ThreeMfError::Malformed(
            "package declares more than one root 3D model relationship".to_string(),
        ));
    }
    Ok(targets.pop())
}

fn model_relationship_targets(
    xml: &str,
    source_part: &str,
    guard: &mut ParseGuard,
) -> Result<Vec<String>, ThreeMfError> {
    let mut reader = NsReader::from_reader(xml.as_bytes());
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut targets = Vec::new();
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut xml_guard = guard.xml_guard();

    loop {
        guard.checkpoint()?;
        let event = reader.read_event_into(&mut buffer)?;
        xml_guard.observe(&event)?;
        match event {
            Event::Start(element) => {
                if depth == 0 {
                    require_opc_root(
                        &reader,
                        element.name(),
                        b"Relationships",
                        RELATIONSHIPS_NAMESPACE,
                    )?;
                    root_seen = true;
                } else if depth == 1
                    && is_element_in_namespace(
                        &reader,
                        element.name(),
                        b"Relationship",
                        RELATIONSHIPS_NAMESPACE,
                    )
                {
                    if let Some(target) = model_relationship_target(&reader, &element, source_part)?
                    {
                        targets.push(target);
                    }
                }
                depth = depth.checked_add(1).ok_or(ThreeMfError::TooLarge)?;
            }
            Event::Empty(element) => {
                if depth == 0 {
                    require_opc_root(
                        &reader,
                        element.name(),
                        b"Relationships",
                        RELATIONSHIPS_NAMESPACE,
                    )?;
                    root_seen = true;
                } else if depth == 1
                    && is_element_in_namespace(
                        &reader,
                        element.name(),
                        b"Relationship",
                        RELATIONSHIPS_NAMESPACE,
                    )
                {
                    if let Some(target) = model_relationship_target(&reader, &element, source_part)?
                    {
                        targets.push(target);
                    }
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(|| {
                    ThreeMfError::Malformed("invalid OPC relationships XML".to_string())
                })?;
            }
            Event::Eof => {
                if !root_seen || depth != 0 {
                    return Err(ThreeMfError::Malformed(
                        "invalid OPC relationships XML".to_string(),
                    ));
                }
                return Ok(targets);
            }
            _ => {}
        }
        buffer.clear();
    }
}

fn model_relationship_target(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
    source_part: &str,
) -> Result<Option<String>, ThreeMfError> {
    let target_mode = decoded_ns_attr(reader, element, b"TargetMode")?;
    if target_mode
        .as_deref()
        .is_some_and(|mode| mode.eq_ignore_ascii_case("External"))
    {
        return Err(ThreeMfError::Malformed(
            "external OPC relationships are not supported".to_string(),
        ));
    }
    if target_mode
        .as_deref()
        .is_some_and(|mode| !mode.eq_ignore_ascii_case("Internal"))
    {
        return Err(ThreeMfError::Malformed(format!(
            "invalid OPC relationship TargetMode '{}'",
            target_mode.as_deref().unwrap_or_default()
        )));
    }

    let relationship_type = decoded_ns_attr(reader, element, b"Type")?.unwrap_or_default();
    if relationship_type != MODEL_RELATIONSHIP_TYPE {
        return Ok(None);
    }
    let target = decoded_ns_attr(reader, element, b"Target")?.ok_or_else(|| {
        ThreeMfError::Malformed("3D model relationship is missing its Target".to_string())
    })?;
    Ok(Some(resolve_relationship_target(source_part, &target)?))
}

fn validate_external_model_parts<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_index: &PackageIndex,
    root_part: &str,
    model_parts: &[String],
    guard: &mut ParseGuard,
) -> Result<(), ThreeMfError> {
    if model_parts.is_empty() {
        return Ok(());
    }

    let relationships_part_key = relationships_part_for(root_part);
    let relationships_part = package_index
        .actual_name(&relationships_part_key)
        .ok_or_else(|| {
            ThreeMfError::Malformed(format!(
                "root model part '/{root_part}' has Production Extension references but no relationship part"
            ))
        })?
        .to_string();
    let relationships = read_text_entry_limited(
        archive,
        &relationships_part,
        MAX_METADATA_XML_BYTES,
        guard,
    )?
    .ok_or_else(|| {
        ThreeMfError::Malformed(format!(
            "root model part '/{root_part}' has Production Extension references but no relationship part"
        ))
    })?;
    let relationship_targets = model_relationship_targets(&relationships, root_part, guard)?;

    let content_types_part = package_index
        .actual_name(CONTENT_TYPES_PART)
        .ok_or_else(|| {
            ThreeMfError::Malformed(
                "Production Extension package is missing [Content_Types].xml".to_string(),
            )
        })?
        .to_string();
    let content_types_xml =
        read_text_entry_limited(archive, &content_types_part, MAX_METADATA_XML_BYTES, guard)?
            .ok_or_else(|| {
                ThreeMfError::Malformed(
                    "Production Extension package is missing [Content_Types].xml".to_string(),
                )
            })?;
    let content_types = parse_content_types(&content_types_xml, guard)?;

    for model_part in model_parts {
        let relationship_count = relationship_targets
            .iter()
            .filter(|target| *target == model_part)
            .count();
        if relationship_count != 1 {
            return Err(ThreeMfError::Malformed(format!(
                "referenced model part '/{model_part}' must have exactly one 3D model relationship"
            )));
        }
        if content_types.content_type_for(model_part) != Some(MODEL_CONTENT_TYPE) {
            return Err(ThreeMfError::Malformed(format!(
                "referenced model part '/{model_part}' does not declare the 3D model content type"
            )));
        }
    }
    Ok(())
}

fn relationships_part_for(model_part: &str) -> String {
    match model_part.rsplit_once('/') {
        Some((directory, filename)) => format!("{directory}/_rels/{filename}.rels"),
        None => format!("_rels/{model_part}.rels"),
    }
}

fn parse_content_types(xml: &str, guard: &mut ParseGuard) -> Result<ContentTypes, ThreeMfError> {
    let mut reader = NsReader::from_reader(xml.as_bytes());
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut content_types = ContentTypes::default();
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut xml_guard = guard.xml_guard();

    loop {
        guard.checkpoint()?;
        let event = reader.read_event_into(&mut buffer)?;
        xml_guard.observe(&event)?;
        match event {
            Event::Start(element) => {
                if depth == 0 {
                    require_opc_root(&reader, element.name(), b"Types", CONTENT_TYPES_NAMESPACE)?;
                    root_seen = true;
                } else if depth == 1
                    && is_element_in_namespace(
                        &reader,
                        element.name(),
                        element.name().local_name().as_ref(),
                        CONTENT_TYPES_NAMESPACE,
                    )
                {
                    parse_content_type_element(&reader, &element, &mut content_types)?;
                }
                depth = depth.checked_add(1).ok_or(ThreeMfError::TooLarge)?;
            }
            Event::Empty(element) => {
                if depth == 0 {
                    require_opc_root(&reader, element.name(), b"Types", CONTENT_TYPES_NAMESPACE)?;
                    root_seen = true;
                } else if depth == 1
                    && is_element_in_namespace(
                        &reader,
                        element.name(),
                        element.name().local_name().as_ref(),
                        CONTENT_TYPES_NAMESPACE,
                    )
                {
                    parse_content_type_element(&reader, &element, &mut content_types)?;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(|| {
                    ThreeMfError::Malformed("invalid OPC content-types XML".to_string())
                })?;
            }
            Event::Eof => {
                if !root_seen || depth != 0 {
                    return Err(ThreeMfError::Malformed(
                        "invalid OPC content-types XML".to_string(),
                    ));
                }
                return Ok(content_types);
            }
            _ => {}
        }
        buffer.clear();
    }
}

fn parse_content_type_element(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
    content_types: &mut ContentTypes,
) -> Result<(), ThreeMfError> {
    match element.name().local_name().as_ref() {
        b"Default" => {
            let extension = decoded_ns_attr(reader, element, b"Extension")?
                .ok_or_else(|| {
                    ThreeMfError::Malformed("content type Default is missing Extension".to_string())
                })?
                .to_ascii_lowercase();
            let content_type =
                decoded_ns_attr(reader, element, b"ContentType")?.ok_or_else(|| {
                    ThreeMfError::Malformed(
                        "content type Default is missing ContentType".to_string(),
                    )
                })?;
            if content_types
                .defaults
                .insert(extension.clone(), content_type)
                .is_some()
            {
                return Err(ThreeMfError::Malformed(format!(
                    "duplicate default content type for extension '{extension}'"
                )));
            }
        }
        b"Override" => {
            let part_name = decoded_ns_attr(reader, element, b"PartName")?.ok_or_else(|| {
                ThreeMfError::Malformed("content type Override is missing PartName".to_string())
            })?;
            let part_name = normalize_model_part_path(&part_name)?;
            let content_type =
                decoded_ns_attr(reader, element, b"ContentType")?.ok_or_else(|| {
                    ThreeMfError::Malformed(
                        "content type Override is missing ContentType".to_string(),
                    )
                })?;
            if content_types
                .overrides
                .insert(part_name.clone(), content_type)
                .is_some()
            {
                return Err(ThreeMfError::Malformed(format!(
                    "duplicate content type override for '/{part_name}'"
                )));
            }
        }
        _ => {}
    }
    Ok(())
}

fn require_opc_root(
    reader: &NsReader<&[u8]>,
    name: quick_xml::name::QName<'_>,
    local_name: &[u8],
    namespace: &[u8],
) -> Result<(), ThreeMfError> {
    if is_element_in_namespace(reader, name, local_name, namespace) {
        Ok(())
    } else {
        Err(ThreeMfError::Malformed(
            "OPC metadata uses an invalid root element or namespace".to_string(),
        ))
    }
}

fn is_element_in_namespace(
    reader: &NsReader<&[u8]>,
    name: quick_xml::name::QName<'_>,
    local_name: &[u8],
    namespace: &[u8],
) -> bool {
    name.local_name().as_ref() == local_name
        && matches!(
            reader.resolve_element(name),
            (ResolveResult::Bound(resolved), _) if resolved.as_ref() == namespace
        )
}

pub(crate) fn resolve_relationship_target(
    source_part: &str,
    target: &str,
) -> Result<String, ThreeMfError> {
    let target = target.trim();
    if target.is_empty() || target.contains('\\') || target.contains('?') || target.contains('#') {
        return Err(ThreeMfError::Malformed(format!(
            "invalid model relationship target '{target}'"
        )));
    }

    let mut segments: Vec<&str> = if target.starts_with('/') || source_part.is_empty() {
        Vec::new()
    } else {
        source_part
            .rsplit_once('/')
            .map(|(directory, _)| directory.split('/').collect())
            .unwrap_or_default()
    };
    for segment in target.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(ThreeMfError::Malformed(format!(
                        "model relationship target escapes the package root: '{target}'"
                    )));
                }
            }
            _ => segments.push(segment),
        }
    }
    if segments.is_empty() {
        return Err(ThreeMfError::Malformed(format!(
            "invalid model relationship target '{target}'"
        )));
    }
    Ok(opc_part_key(&segments.join("/")))
}

fn decoded_attr<R>(
    reader: &Reader<R>,
    element: &BytesStart,
    name: &[u8],
) -> Result<Option<String>, ThreeMfError> {
    for attribute in element.attributes() {
        let attribute = attribute
            .map_err(|error| ThreeMfError::Malformed(format!("invalid XML attribute: {error}")))?;
        if attribute.key.as_ref() == name {
            return Ok(Some(
                attribute
                    .decode_and_unescape_value(reader.decoder())?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

fn decoded_ns_attr(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
    name: &[u8],
) -> Result<Option<String>, ThreeMfError> {
    for attribute in element.attributes() {
        let attribute = attribute
            .map_err(|error| ThreeMfError::Malformed(format!("invalid XML attribute: {error}")))?;
        if attribute.key.as_ref() == name {
            return Ok(Some(
                attribute
                    .decode_and_unescape_value(reader.decoder())?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

/// Stream the model XML into reusable objects and the build's instance list.
fn parse_model_xml(
    xml: &str,
    is_root_model: bool,
    budget: &mut ParseBudget,
    guard: &mut ParseGuard,
) -> Result<RawModel, ThreeMfError> {
    let mut reader = NsReader::from_str(xml);

    let mut objects: HashMap<u32, RawObject> = HashMap::new();
    let mut build: Vec<Component> = Vec::new();
    let mut unit = String::from("millimeter");
    let mut appearances: HashMap<u32, AppearanceGroup> = HashMap::new();

    let mut current_id: Option<u32> = None;
    let mut current_geometry: Option<ObjectGeometry> = None;
    let mut current_name: Option<String> = None;
    let mut current_appearance: Option<(u32, u32)> = None;
    let mut current_group: Option<(u32, AppearanceGroup)> = None;
    let mut in_build = false;
    let mut xml_guard = guard.xml_guard();

    loop {
        guard.checkpoint()?;
        let event = reader.read_event()?;
        xml_guard.observe(&event)?;
        match event {
            Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                b"model" => {
                    if let Some(u) = decoded_attr(&reader, &e, b"unit")? {
                        unit = u;
                    }
                }
                // Both resource kinds are positional tables indexed by
                // `pindex`/`p1`; they differ only in carrying material names.
                // Matched by local name in the fallback arm below, because the
                // material extension is conventionally namespace-prefixed
                // (`<m:colorgroup>`) while the core elements are not.
                b"object" => {
                    current_id = Some(attr_u32(&e, b"id")?);
                    current_geometry = None;
                    current_name =
                        decoded_attr(&reader, &e, b"name")?.filter(|name| !name.trim().is_empty());
                    current_appearance = match optional_attr_u32(&e, b"pid")? {
                        Some(pid) => {
                            Some((pid, optional_attr_u32(&e, b"pindex")?.unwrap_or_default()))
                        }
                        None => None,
                    };
                }
                b"mesh" => {
                    current_geometry = Some(ObjectGeometry::Mesh {
                        vertices: Vec::new(),
                        triangles: Vec::new(),
                        triangle_appearance: Vec::new(),
                    });
                }
                b"vertex" => {
                    if let Some(ObjectGeometry::Mesh { vertices, .. }) = current_geometry.as_mut() {
                        budget.add_vertex()?;
                        vertices.push([
                            attr_f32(&e, b"x")?,
                            attr_f32(&e, b"y")?,
                            attr_f32(&e, b"z")?,
                        ]);
                    }
                }
                b"triangle" => {
                    if let Some(ObjectGeometry::Mesh {
                        triangles,
                        triangle_appearance,
                        ..
                    }) = current_geometry.as_mut()
                    {
                        budget.add_triangle()?;
                        triangles.push([
                            attr_u32(&e, b"v1")?,
                            attr_u32(&e, b"v2")?,
                            attr_u32(&e, b"v3")?,
                        ]);
                        // 3MF allows a per-vertex gradient across a triangle;
                        // the scene DTO carries one colour per face, so the
                        // first corner wins and the rest are ignored.
                        let face = match optional_attr_u32(&e, b"pid")? {
                            Some(pid) => optional_attr_u32(&e, b"p1")?.map(|p1| (pid, p1)),
                            None => None,
                        };
                        // Start tracking at the first coloured face and stay on.
                        // The resize backfills the plain triangles that came
                        // before it and is a no-op once tracking is under way,
                        // so this stays exactly `triangles.len()` long.
                        if !triangle_appearance.is_empty() || face.is_some() {
                            triangle_appearance.resize(triangles.len() - 1, None);
                            triangle_appearance.push(face);
                        }
                    }
                }
                b"components" => {
                    current_geometry = Some(ObjectGeometry::Components(Vec::new()));
                }
                b"component" => {
                    if let Some(ObjectGeometry::Components(list)) = current_geometry.as_mut() {
                        budget.add_component()?;
                        list.push(Component {
                            object_id: attr_u32(&e, b"objectid")?,
                            model_part: optional_model_part(&reader, &e, is_root_model)?,
                            transform: optional_transform(&e)?,
                        });
                    }
                }
                b"build" => in_build = is_root_model,
                b"item" if in_build => {
                    budget.add_component()?;
                    build.push(Component {
                        object_id: attr_u32(&e, b"objectid")?,
                        model_part: optional_model_part(&reader, &e, is_root_model)?,
                        transform: optional_transform(&e)?,
                    });
                }
                _ => match e.local_name().as_ref() {
                    b"basematerials" | b"colorgroup" => {
                        current_group = Some((attr_u32(&e, b"id")?, AppearanceGroup::default()));
                    }
                    b"base" => {
                        if let Some((_, group)) = current_group.as_mut() {
                            budget.add_appearance()?;
                            group.colors.push(
                                parse_appearance_color(&e, b"displaycolor")?.unwrap_or([0; 3]),
                            );
                            let label = decoded_attr(&reader, &e, b"name")?;
                            if label
                                .as_ref()
                                .is_some_and(|l| l.len() > MAX_MATERIAL_NAME_BYTES)
                            {
                                return Err(ThreeMfError::TooLarge);
                            }
                            group
                                .names
                                .push(label.filter(|name| !name.trim().is_empty()));
                        }
                    }
                    b"color" => {
                        if let Some((_, group)) = current_group.as_mut() {
                            budget.add_appearance()?;
                            group
                                .colors
                                .push(parse_appearance_color(&e, b"color")?.unwrap_or([0; 3]));
                            group.names.push(None);
                        }
                    }
                    _ => {}
                },
            },
            Event::End(e) => match e.name().as_ref() {
                b"object" => {
                    if let Some(id) = current_id.take() {
                        let geometry = current_geometry.take().unwrap_or(ObjectGeometry::Mesh {
                            vertices: Vec::new(),
                            triangles: Vec::new(),
                            triangle_appearance: Vec::new(),
                        });
                        budget.add_object()?;
                        if objects
                            .insert(
                                id,
                                RawObject {
                                    geometry,
                                    name: current_name.take(),
                                    appearance: current_appearance.take(),
                                },
                            )
                            .is_some()
                        {
                            return Err(ThreeMfError::Malformed(format!(
                                "duplicate object id {id}"
                            )));
                        }
                    }
                }
                b"build" => in_build = false,
                _ => {
                    if matches!(e.local_name().as_ref(), b"basematerials" | b"colorgroup") {
                        if let Some((id, group)) = current_group.take() {
                            // Last writer wins rather than erroring: a duplicate
                            // resource id is not a memory-safety problem and
                            // real exporters occasionally emit one.
                            appearances.insert(id, group);
                        }
                    }
                }
            },
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(RawModel {
        objects,
        build,
        unit,
        appearances,
    })
}

/// Parse a 3MF `sRGB` hex colour attribute (`#RRGGBB` or `#RRGGBBAA`).
///
/// Alpha is accepted and discarded: the scene DTO carries opaque RGB. An
/// unparseable value is treated as absent rather than fatal, because a bad
/// colour must not cost the user their geometry.
fn parse_appearance_color(
    element: &BytesStart<'_>,
    name: &[u8],
) -> Result<Option<[u8; 3]>, ThreeMfError> {
    let Some(raw) = get_attr(element, name) else {
        return Ok(None);
    };
    let text = raw.trim();
    let hex = text.strip_prefix('#').unwrap_or(text);
    if hex.len() != 6 && hex.len() != 8 {
        return Ok(None);
    }
    let mut rgb = [0u8; 3];
    for (index, slot) in rgb.iter_mut().enumerate() {
        let Some(pair) = hex.get(index * 2..index * 2 + 2) else {
            return Ok(None);
        };
        match u8::from_str_radix(pair, 16) {
            Ok(value) => *slot = value,
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(rgb))
}

/// Resolve an object's `<basematerials>`/`<colorgroup>` references into the
/// concrete colours the scene DTO carries.
///
/// Dangling references resolve to `None` rather than an error: an exporter that
/// emits a `pid` for a resource it never wrote should cost the user a colour,
/// not the whole model.
fn resolve_material(model: &RawModel, object: &RawObject) -> ThreeMfMaterial {
    let base_color = object
        .appearance
        .and_then(|(pid, index)| model.appearances.get(&pid)?.color_at(index));

    let face_colors = match &object.geometry {
        ObjectGeometry::Mesh {
            triangles,
            triangle_appearance,
            ..
        } if !triangle_appearance.is_empty() => {
            let resolved: Vec<[u8; 3]> = triangle_appearance
                .iter()
                .map(|face| {
                    face.and_then(|(pid, index)| model.appearances.get(&pid)?.color_at(index))
                        // A face without its own colour inherits the object's.
                        .or(base_color)
                        .unwrap_or([0; 3])
                })
                .collect();
            // The DTO contract is "either absent or exactly one per triangle".
            (resolved.len() == triangles.len()).then_some(resolved)
        }
        _ => None,
    };

    ThreeMfMaterial {
        base_color,
        face_colors,
    }
}

/// The material name an object's `pid`/`pindex` names, when it resolves to a
/// `<basematerials>` entry that carries one.
fn resolve_material_label(model: &RawModel, object: &RawObject) -> Option<String> {
    let (pid, index) = object.appearance?;
    model
        .appearances
        .get(&pid)?
        .name_at(index)
        .map(str::to_string)
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

fn unit_scale_millimeters(unit: &str) -> Result<f32, ThreeMfError> {
    match unit.trim().to_ascii_lowercase().as_str() {
        "micron" => Ok(0.001),
        "millimeter" => Ok(1.0),
        "centimeter" => Ok(10.0),
        "inch" => Ok(25.4),
        "foot" => Ok(304.8),
        "meter" => Ok(1_000.0),
        _ => Err(ThreeMfError::Malformed(format!(
            "unsupported 3MF model unit '{unit}'"
        ))),
    }
}

#[derive(Default)]
struct FlattenOutput {
    vertices: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    expansion_steps: usize,
    mesh_object_count: usize,
    #[cfg(test)]
    mesh_builds_started: usize,
}

impl FlattenOutput {
    fn record_mesh_object(&mut self) -> Result<(), ThreeMfError> {
        self.mesh_object_count = self
            .mesh_object_count
            .checked_add(1)
            .ok_or(ThreeMfError::TooLarge)?;
        if self.mesh_object_count > MAX_RENDERABLE_SCENE_OBJECTS {
            return Err(ThreeMfError::RenderBudgetExceeded {
                mesh_objects: self.mesh_object_count,
                max_mesh_objects: MAX_RENDERABLE_SCENE_OBJECTS,
            });
        }
        Ok(())
    }

    #[cfg(test)]
    fn record_mesh_build_start(&mut self) {
        self.mesh_builds_started += 1;
    }
}

/// Expand the build into a single indexed mesh, baking every transform. Each
/// build item is recorded as a [`ThreeMfPart`] spanning the triangles it added.
fn flatten(package: &RawPackage, guard: &mut ParseGuard) -> Result<ThreeMfMesh, ThreeMfError> {
    let root_model = package.models.get(&package.root_part).ok_or_else(|| {
        ThreeMfError::Malformed("resolved root model part is missing".to_string())
    })?;
    let mut output = FlattenOutput::default();
    let mut parts: Vec<ThreeMfPart> = Vec::with_capacity(root_model.build.len());
    let mut objects: Vec<ThreeMfSceneObject> = Vec::new();
    let mut root_object_ids = Vec::with_capacity(root_model.build.len());
    let plate_id = plate_id(0);
    let mut plates = vec![ThreeMfPlate {
        id: plate_id.clone(),
        name: "Plate 1".to_string(),
        index: 0,
        root_object_ids: Vec::with_capacity(root_model.build.len()),
    }];

    for (build_item_index, item) in root_model.build.iter().enumerate() {
        let model_part = item.model_part.as_deref().unwrap_or(&package.root_part);
        let triangle_start = output.triangles.len();
        let root_id = scene_object_id(build_item_index, item.object_id);
        expand(
            package,
            model_part,
            item.object_id,
            item.transform,
            item.transform,
            root_id.clone(),
            None,
            build_item_index,
            &plate_id,
            &mut output,
            &mut objects,
            0,
            guard,
        )?;
        root_object_ids.push(root_id.clone());
        plates[0].root_object_ids.push(root_id);
        parts.push(ThreeMfPart {
            name: part_name(package, model_part, item.object_id),
            triangle_start,
            triangle_count: output.triangles.len() - triangle_start,
            status: SceneLoadStatus::Complete,
            status_detail: None,
            part_number: None,
            material_label: package
                .models
                .get(model_part)
                .and_then(|model| Some((model, model.objects.get(&item.object_id)?)))
                .and_then(|(model, object)| resolve_material_label(model, object)),
        });
    }

    let mut bounds = Aabb::empty();
    for v in &output.vertices {
        bounds.expand(*v);
    }
    Ok(ThreeMfMesh {
        vertices: output.vertices,
        triangles: output.triangles,
        bounds,
        unit: root_model.unit.clone(),
        object_count: package
            .models
            .values()
            .map(|model| model.objects.len())
            .sum(),
        build_item_count: root_model.build.len(),
        status: SceneLoadStatus::Complete,
        status_messages: Vec::new(),
        parts,
        objects,
        root_object_ids,
        plates,
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
#[allow(clippy::too_many_arguments)]
fn expand(
    package: &RawPackage,
    model_part: &str,
    object_id: u32,
    local_transform: Transform,
    transform: Transform,
    instance_id: String,
    parent_id: Option<String>,
    build_item_index: usize,
    plate_id: &str,
    output: &mut FlattenOutput,
    scene_objects: &mut Vec<ThreeMfSceneObject>,
    depth: usize,
    guard: &mut ParseGuard,
) -> Result<(), ThreeMfError> {
    guard.checkpoint()?;
    output.expansion_steps = output
        .expansion_steps
        .checked_add(1)
        .ok_or(ThreeMfError::TooLarge)?;
    if output.expansion_steps > MAX_EXPANSION_STEPS {
        return Err(ThreeMfError::TooLarge);
    }
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

    let name = part_name(package, model_part, object_id);
    let material = resolve_material(model, object);
    let mesh = match &object.geometry {
        ObjectGeometry::Mesh {
            vertices,
            triangles,
            ..
        } => {
            output.record_mesh_object()?;
            #[cfg(test)]
            output.record_mesh_build_start();
            let mut bounds = Aabb::empty();
            for vertex in vertices {
                bounds.expand(*vertex);
            }
            Some(ThreeMfObjectMesh {
                positions: vertices.clone(),
                indices: triangles.iter().flat_map(|triangle| *triangle).collect(),
                bounds,
            })
        }
        ObjectGeometry::Components(_) => None,
    };
    let scene_object_index = scene_objects.len();
    scene_objects.push(ThreeMfSceneObject {
        id: instance_id.clone(),
        source_id: source_object_id(model_part, object_id),
        name,
        parent_id: parent_id.clone(),
        children: Vec::new(),
        transform: local_transform,
        mesh,
        material,
        plate_id: plate_id.to_string(),
        build_item_index,
    });

    match &object.geometry {
        ObjectGeometry::Mesh {
            vertices,
            triangles,
            ..
        } => {
            if output.vertices.len() + vertices.len() > MAX_VERTICES
                || output.triangles.len() + triangles.len() > MAX_TRIANGLES
            {
                return Err(ThreeMfError::TooLarge);
            }
            let base = output.vertices.len() as u32;
            let local_count = vertices.len() as u32;
            for v in vertices {
                guard.checkpoint()?;
                let transformed = transform.apply(*v);
                for coordinate in transformed {
                    // A finite input can still overflow to infinity once a
                    // hostile transform is applied.
                    finite(coordinate, "transformed vertex", "overflow")?;
                }
                output.vertices.push(transformed);
            }
            for t in triangles {
                guard.checkpoint()?;
                for &index in t {
                    if index >= local_count {
                        return Err(ThreeMfError::Malformed(format!(
                            "triangle index {index} out of range in object {object_id}"
                        )));
                    }
                }
                output
                    .triangles
                    .push([base + t[0], base + t[1], base + t[2]]);
            }
            Ok(())
        }
        ObjectGeometry::Components(components) => {
            let mut child_ids = Vec::with_capacity(components.len());
            for component in components {
                // Apply the component's local transform, then the accumulated one.
                let composed = component.transform.compose(&transform);
                let component_part = component.model_part.as_deref().unwrap_or(model_part);
                let component_index = child_ids.len();
                let child_id = format!(
                    "{instance_id}/component-{component_index}/object-{}",
                    component.object_id
                );
                expand(
                    package,
                    component_part,
                    component.object_id,
                    component.transform,
                    composed,
                    child_id.clone(),
                    Some(instance_id.clone()),
                    build_item_index,
                    plate_id,
                    output,
                    scene_objects,
                    depth + 1,
                    guard,
                )?;
                child_ids.push(child_id);
            }
            scene_objects[scene_object_index].children = child_ids;
            Ok(())
        }
    }
}

fn source_object_id(model_part: &str, object_id: u32) -> String {
    format!("{model_part}#object-{object_id}")
}

fn scene_object_id(build_item_index: usize, object_id: u32) -> String {
    format!("plate-0/item-{build_item_index}/object-{object_id}")
}

fn plate_id(index: usize) -> String {
    format!("plate-{index}")
}

/// Fetch an attribute's raw string value by name.
pub(crate) fn get_attr(e: &BytesStart, name: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
}

fn optional_model_part<R>(
    reader: &NsReader<R>,
    e: &BytesStart,
    is_root_model: bool,
) -> Result<Option<String>, ThreeMfError> {
    let mut path = None;
    for attribute in e.attributes() {
        let attribute = attribute
            .map_err(|error| ThreeMfError::Malformed(format!("invalid XML attribute: {error}")))?;
        let (namespace, local_name) = reader.resolve_attribute(attribute.key);
        if local_name.as_ref() != b"path"
            || !matches!(
                namespace,
                ResolveResult::Bound(namespace)
                    if namespace.as_ref() == PRODUCTION_NAMESPACE
            )
        {
            continue;
        }
        if path.is_some() {
            return Err(ThreeMfError::Malformed(
                "element declares more than one Production Extension path".to_string(),
            ));
        }
        path = Some(
            attribute
                .decode_and_unescape_value(reader.decoder())?
                .into_owned(),
        );
    }

    let Some(path) = path else {
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
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('?')
        || path.contains('#')
    {
        return Err(ThreeMfError::Malformed(format!(
            "invalid Production Extension model path '{path}'"
        )));
    }

    let path = &path[1..];
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ThreeMfError::Malformed(format!(
            "invalid Production Extension model path '{path}'"
        )));
    }
    Ok(opc_part_key(path))
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

/// Like [`attr_u32`] but absent is `None` rather than an error. A malformed
/// value is still rejected: silently dropping a bad `pid` would attach the
/// wrong material to a face instead of reporting the corruption.
fn optional_attr_u32(e: &BytesStart, name: &[u8]) -> Result<Option<u32>, ThreeMfError> {
    match get_attr(e, name) {
        Some(raw) => raw.trim().parse::<u32>().map(Some).map_err(|_| {
            ThreeMfError::Malformed(format!(
                "invalid '{}' value '{raw}'",
                String::from_utf8_lossy(name)
            ))
        }),
        None => Ok(None),
    }
}

fn attr_f32(e: &BytesStart, name: &[u8]) -> Result<f32, ThreeMfError> {
    let raw = get_attr(e, name).ok_or_else(|| {
        ThreeMfError::Malformed(format!(
            "missing '{}' attribute",
            String::from_utf8_lossy(name)
        ))
    })?;
    let value = raw.trim().parse::<f32>().map_err(|_| {
        ThreeMfError::Malformed(format!(
            "invalid '{}' value '{raw}'",
            String::from_utf8_lossy(name)
        ))
    })?;
    finite(value, "vertex coordinate", raw.trim())
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

    /// A guard with the wall-clock deadline removed so unit tests never depend
    /// on machine speed.
    fn test_guard() -> ParseGuard {
        ParseGuard::new(ParseLimits::default().without_timeout())
    }

    /// A reader that is slow *by construction* rather than by racing the clock,
    /// so a mid-read expiry is deterministic instead of machine-dependent.
    struct SlowReader {
        remaining: usize,
        delay: std::time::Duration,
    }

    impl Read for SlowReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Ok(0);
            }
            std::thread::sleep(self.delay);
            let n = buf.len().min(self.remaining);
            buf[..n].fill(b'x');
            self.remaining -= n;
            Ok(n)
        }
    }

    #[test]
    fn a_deadline_expiring_mid_read_is_an_error_not_a_success() {
        let mut guard = ParseGuard::new(
            ParseLimits::default().with_timeout(std::time::Duration::from_millis(60)),
        );
        // Twenty chunks at 20 ms: the budget runs out partway through the read,
        // never at a boundary before it starts.
        let mut reader = SlowReader {
            remaining: 20 * 64 * 1024,
            delay: std::time::Duration::from_millis(20),
        };
        let error = read_entry_guarded(&mut reader, 64 * 1024 * 1024, 0, &mut guard)
            .expect_err("expiry during a read must not be reported as success");
        assert_eq!(error.code(), "limit.timeout", "{error}");
        assert!(
            reader.remaining > 0,
            "the read must have been abandoned in flight, not after completing"
        );
    }

    #[test]
    fn a_deadline_expiring_on_the_final_read_is_still_an_error() {
        let mut guard = ParseGuard::new(
            ParseLimits::default().with_timeout(std::time::Duration::from_millis(30)),
        );
        // A single chunk that outlasts the budget: the loop's own check passes
        // on entry, so only the unsampled check afterwards can catch this.
        let mut reader = SlowReader {
            remaining: 8,
            delay: std::time::Duration::from_millis(60),
        };
        let error = read_entry_guarded(&mut reader, 1024, 0, &mut guard)
            .expect_err("a budget consumed by the last read must not return success");
        assert_eq!(error.code(), "limit.timeout", "{error}");
    }

    #[test]
    fn chunked_reads_return_the_whole_entry() {
        let mut guard = test_guard();
        // Deliberately not a chunk multiple, so a boundary bug truncates.
        let payload = vec![b'x'; 3 * 64 * 1024 + 17];
        let contents = read_entry_guarded(&mut payload.as_slice(), u64::MAX, 0, &mut guard)
            .expect("a benign entry must read in full");
        assert_eq!(contents, payload);
    }

    #[test]
    fn chunked_reads_stop_one_byte_past_the_ceiling() {
        let mut guard = test_guard();
        let payload = vec![b'x'; 4096];
        let contents = read_entry_guarded(&mut payload.as_slice(), 8, 0, &mut guard)
            .expect("overrun detection belongs to the caller");
        // Exactly max_bytes + 1, so the caller can distinguish "at the limit"
        // from "over it" without buffering the whole hostile entry.
        assert_eq!(contents.len(), 9);
    }

    fn expected_three_row_major_matrix(transform: &Transform) -> [f32; 16] {
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
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    const RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;
    const CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"#;
    const DUPLICATE_PACKAGE_BASE64: &str =
        "UEsDBBQAAAAIAOCo9lxX7nGSDQAAAAUAAAAQAAAAM0QvM2Rtb2RlbC5tb2RlbErLLCouAQAAAP//AwBQSwMEFAAAAAgA4Kj2XGkRH7YOAAAABgAAABAAAAAzRC8zZG1vZGVsLm1vZGVsKk5Nzs9LAQAAAP//AwBQSwECFAAUAAAACADgqPZcV+5xkg0AAAAFAAAAEAAAAAAAAAAAAAAAAAAAAAAAM0QvM2Rtb2RlbC5tb2RlbFBLAQIUABQAAAAIAOCo9lxpER+2DgAAAAYAAAAQAAAAAAAAAAAAAAAAADsAAAAzRC8zZG1vZGVsLm1vZGVsUEsFBgAAAAACAAIAfAAAAHcAAAAAAA==";

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
        let relationship_paths: Vec<&str> = model_parts.iter().map(|(path, _)| *path).collect();
        production_package_with_relationships(
            root_xml,
            &relationship_paths,
            model_parts,
            CONTENT_TYPES_XML,
        )
    }

    fn production_package_with_relationships(
        root_xml: &str,
        relationship_paths: &[&str],
        model_parts: &[(&str, &str)],
        content_types_xml: &str,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(CONTENT_TYPES_PART, options).unwrap();
            writer.write_all(content_types_xml.as_bytes()).unwrap();
            writer.start_file(RELATIONSHIPS_PART, options).unwrap();
            writer.write_all(RELS_XML.as_bytes()).unwrap();
            writer.start_file(DEFAULT_MODEL_PART, options).unwrap();
            writer.write_all(root_xml.as_bytes()).unwrap();

            let mut model_rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
            );
            for (index, path) in relationship_paths.iter().enumerate() {
                model_rels.push_str(&format!(
                    r#"<Relationship Id="rel{index}" Target="/{}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>"#,
                    escape_xml_attribute(path.trim_start_matches('/'))
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

    fn escape_xml_attribute(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
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
        assert_eq!(mesh.root_object_ids.len(), 2);
        assert_eq!(mesh.plates[0].root_object_ids, mesh.root_object_ids);
        assert_eq!(mesh.objects.len(), 2);
        assert!(mesh.objects.iter().all(|object| object.parent_id.is_none()));
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
        assert_eq!(mesh.objects.len(), 2);
        assert_eq!(
            mesh.objects[0].children,
            vec!["plate-0/item-0/object-1/component-0/object-2"]
        );
        assert_eq!(
            mesh.objects[1].parent_id.as_deref(),
            Some("plate-0/item-0/object-1")
        );
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
      <components>
        <component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 3"/>
      </components>
    </object>
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
  </resources>
  <build><item objectid="999"/></build>
</model>"#;
        let data = production_package(root, &[("3D/Objects/body.model", body)]);
        let mesh = parse_bytes(&data).unwrap();

        assert_eq!(mesh.object_count, 3);
        assert_eq!(mesh.build_item_count, 1);
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.bounds.min, [5.0, 7.0, 3.0]);
        assert_eq!(mesh.bounds.max, [6.0, 8.0, 3.0]);
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
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/body.model" objectid="1"/>
</build></model>"#;
        let body = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
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
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/missing.model" objectid="1"/>
</build></model>"#;
        let data = production_package_with_relationships(
            root,
            &["3D/Objects/missing.model"],
            &[],
            CONTENT_TYPES_XML,
        );

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(
            error
                .to_ascii_lowercase()
                .contains("referenced model part '/3d/objects/missing.model' is missing"),
            "{error}"
        );
    }

    #[test]
    fn rejects_unsafe_production_model_paths() {
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/../outside.model" objectid="1"/>
</build></model>"#;
        let data = package(root, true, DEFAULT_MODEL_PART);

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("invalid Production Extension model path"));
    }

    #[test]
    fn ignores_path_attributes_from_other_namespaces() {
        let model = r#"<model xmlns:vendor="urn:vendor"><resources>
  <object id="1"><mesh>
    <vertices>
      <vertex x="0" y="0" z="0"/>
      <vertex x="1" y="0" z="0"/>
      <vertex x="0" y="1" z="0"/>
    </vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object>
</resources><build>
  <item vendor:path="/3D/Objects/missing.model" objectid="1"/>
</build></model>"#;
        let data = package(model, true, DEFAULT_MODEL_PART);

        assert_eq!(parse_bytes(&data).unwrap().triangle_count(), 1);
    }

    #[test]
    fn unescapes_production_model_paths() {
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/A&amp;B.model" objectid="1"/>
</build></model>"#;
        let body = single_triangle_model();
        let data = production_package(root, &[("3D/Objects/A&B.model", &body)]);

        assert_eq!(parse_bytes(&data).unwrap().triangle_count(), 1);
    }

    #[test]
    fn resolves_opc_part_names_case_insensitively() {
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources/><build><item p:path="/3d/objects/body.model" objectid="1"/></build>
</model>"#;
        let model_relationships = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="body" Target="/3D/Objects/BODY.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;
        let body = single_triangle_model();
        let mut data = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut data));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (name, contents) in [
                ("[CONTENT_TYPES].XML", CONTENT_TYPES_XML),
                ("_RELS/.RELS", RELS_XML),
                ("3d/3DMODEL.MODEL", root),
                ("3D/_RELS/3dmodel.model.RELS", model_relationships),
                ("3D/OBJECTS/BODY.MODEL", body.as_str()),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(contents.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }

        assert_eq!(parse_bytes(&data).unwrap().triangle_count(), 1);
    }

    #[test]
    fn rejects_foreign_opc_metadata_namespaces() {
        let relationships = r#"<Relationships xmlns="urn:not-opc">
  <Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;
        let relationship_error = model_relationship_targets(relationships, "", &mut test_guard())
            .unwrap_err()
            .to_string();
        assert!(relationship_error.contains("invalid root element or namespace"));

        let content_types =
            r#"<Types xmlns="urn:not-opc"><Default Extension="model" ContentType="x"/></Types>"#;
        let content_type_error = parse_content_types(content_types, &mut test_guard())
            .unwrap_err()
            .to_string();
        assert!(content_type_error.contains("invalid root element or namespace"));
    }

    #[test]
    fn rejects_external_opc_relationships() {
        let relationships = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="https://example.invalid/model" TargetMode="External"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;

        let error = model_relationship_targets(relationships, "", &mut test_guard())
            .unwrap_err()
            .to_string();
        assert!(error.contains("external OPC relationships"), "{error}");
    }

    #[test]
    fn converts_external_model_units_without_scaling_root_transforms() {
        let root = r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/body.model" objectid="1"
    transform="1 0 0 0 1 0 0 0 1 10 20 0"/>
</build></model>"#;
        let body = r#"<model unit="inch"><resources>
  <object id="1"><components>
    <component objectid="2" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>
  </components></object>
  <object id="2"><mesh>
    <vertices>
      <vertex x="0" y="0" z="0"/>
      <vertex x="1" y="0" z="0"/>
      <vertex x="0" y="1" z="0"/>
    </vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object>
</resources></model>"#;
        let data = production_package(root, &[("3D/Objects/body.model", body)]);

        let mesh = parse_bytes(&data).unwrap();
        assert!((mesh.bounds.min[0] - 35.4).abs() < 0.0001);
        assert!((mesh.bounds.min[1] - 20.0).abs() < 0.0001);
        assert!((mesh.bounds.max[0] - 60.8).abs() < 0.0001);
        assert!((mesh.bounds.max[1] - 45.4).abs() < 0.0001);
        assert_eq!(mesh.unit, "millimeter");
    }

    #[test]
    fn requires_relationships_for_production_model_parts() {
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/body.model" objectid="1"/>
</build></model>"#;
        let body = single_triangle_model();
        let data = production_package_with_relationships(
            root,
            &[],
            &[("3D/Objects/body.model", &body)],
            CONTENT_TYPES_XML,
        );

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("must have exactly one 3D model relationship"));
    }

    #[test]
    fn requires_model_content_type_for_production_parts() {
        let root = r#"<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources/><build>
  <item p:path="/3D/Objects/body.model" objectid="1"/>
</build></model>"#;
        let body = single_triangle_model();
        let content_types = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="model" ContentType="application/octet-stream"/>
</Types>"#;
        let data = production_package_with_relationships(
            root,
            &["3D/Objects/body.model"],
            &[("3D/Objects/body.model", &body)],
            content_types,
        );

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("does not declare the 3D model content type"));
    }

    #[test]
    fn rejects_duplicate_package_parts() {
        let data = BASE64.decode(DUPLICATE_PACKAGE_BASE64).unwrap();

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("duplicate package part"), "{error}");
    }

    #[test]
    fn rejects_case_equivalent_package_parts() {
        let mut data = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut data));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(DEFAULT_MODEL_PART, options).unwrap();
            writer
                .write_all(single_triangle_model().as_bytes())
                .unwrap();
            writer.start_file("3d/3DMODEL.MODEL", options).unwrap();
            writer
                .write_all(single_triangle_model().as_bytes())
                .unwrap();
            writer.finish().unwrap();
        }

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("case-equivalent duplicate"), "{error}");
    }

    #[test]
    fn rejects_spoofed_eocd_entry_counts() {
        let mut data = BASE64.decode(DUPLICATE_PACKAGE_BASE64).unwrap();
        let eocd = data
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        data[eocd + 8..eocd + 12].copy_from_slice(&[1, 0, 1, 0]);

        let error = parse_bytes(&data).unwrap_err().to_string();
        assert!(error.contains("central directory"), "{error}");
    }

    #[test]
    fn enforces_model_xml_and_parse_budgets_before_flattening() {
        let data = package(&single_triangle_model(), true, DEFAULT_MODEL_PART);
        let mut archive = ZipArchive::new(Cursor::new(data)).unwrap();
        assert!(matches!(
            read_text_entry_limited(&mut archive, DEFAULT_MODEL_PART, 8, &mut test_guard()),
            Err(ThreeMfError::TooLarge)
        ));

        let mut budget = ParseBudget {
            vertices: MAX_VERTICES,
            ..ParseBudget::default()
        };
        let model = r#"<model><resources><object id="1"><mesh><vertices>
  <vertex x="0" y="0" z="0"/>
</vertices></mesh></object></resources></model>"#;
        assert!(matches!(
            parse_model_xml(model, true, &mut budget, &mut test_guard()),
            Err(ThreeMfError::TooLarge)
        ));
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
    fn limits_expansion_work_for_branching_component_dags() {
        let levels = 20u32;
        let mut model = String::from("<model><resources>");
        for object_id in 1..=levels {
            model.push_str(&format!(
                "<object id=\"{object_id}\"><components>\
                 <component objectid=\"{}\"/><component objectid=\"{}\"/>\
                 </components></object>",
                object_id + 1,
                object_id + 1
            ));
        }
        model.push_str(&format!(
            "<object id=\"{}\"><components/></object>\
             </resources><build><item objectid=\"1\"/></build></model>",
            levels + 1
        ));
        let data = package(&model, false, DEFAULT_MODEL_PART);

        assert!(matches!(parse_bytes(&data), Err(ThreeMfError::TooLarge)));
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

    #[test]
    fn transform_to_row_major_4x4_matches_three_matrix_layout() {
        let transform = Transform::parse("0 1 0 -1 0 0 0 0 1 10 20 30").unwrap();
        assert_eq!(
            transform.to_row_major_4x4(),
            expected_three_row_major_matrix(&transform)
        );
    }

    #[test]
    fn rejects_models_that_exceed_renderer_mesh_object_budget() {
        let triangle_vertices = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let sentinel_vertices = vec![
            [10_000.0, 0.0, 0.0],
            [10_001.0, 0.0, 0.0],
            [10_000.0, 1.0, 0.0],
        ];
        let sentinel_object_id = MAX_RENDERABLE_SCENE_OBJECTS as u32 + 1;
        let mut objects = HashMap::new();
        let mut build = Vec::new();
        for object_id in 1..=sentinel_object_id {
            objects.insert(
                object_id,
                RawObject {
                    geometry: ObjectGeometry::Mesh {
                        vertices: if object_id < sentinel_object_id {
                            triangle_vertices.clone()
                        } else {
                            sentinel_vertices.clone()
                        },
                        triangles: vec![[0, 1, 2]],
                        triangle_appearance: Vec::new(),
                    },
                    name: None,
                    appearance: None,
                },
            );
            build.push(Component {
                object_id,
                model_part: None,
                transform: Transform::identity(),
            });
        }

        let package = RawPackage {
            models: HashMap::from([(
                DEFAULT_MODEL_PART.to_string(),
                RawModel {
                    objects,
                    build,
                    unit: "millimeter".to_string(),
                    appearances: HashMap::new(),
                },
            )]),
            root_part: DEFAULT_MODEL_PART.to_string(),
        };
        let root_model = package.models.get(DEFAULT_MODEL_PART).unwrap();
        let mut output = FlattenOutput::default();
        let mut scene_objects = Vec::new();
        let plate_id = plate_id(0);

        for (build_item_index, item) in root_model
            .build
            .iter()
            .take(MAX_RENDERABLE_SCENE_OBJECTS)
            .enumerate()
        {
            expand(
                &package,
                DEFAULT_MODEL_PART,
                item.object_id,
                item.transform,
                item.transform,
                scene_object_id(build_item_index, item.object_id),
                None,
                build_item_index,
                &plate_id,
                &mut output,
                &mut scene_objects,
                0,
                &mut test_guard(),
            )
            .unwrap();
        }

        assert_eq!(output.vertices.len(), MAX_RENDERABLE_SCENE_OBJECTS * 3);
        assert_eq!(output.triangles.len(), MAX_RENDERABLE_SCENE_OBJECTS);
        assert_eq!(scene_objects.len(), MAX_RENDERABLE_SCENE_OBJECTS);
        assert_eq!(output.mesh_builds_started, MAX_RENDERABLE_SCENE_OBJECTS);
        assert!(!output
            .vertices
            .iter()
            .any(|vertex| sentinel_vertices.contains(vertex)));

        let over_budget_item = &root_model.build[MAX_RENDERABLE_SCENE_OBJECTS];
        let mesh = expand(
            &package,
            DEFAULT_MODEL_PART,
            over_budget_item.object_id,
            over_budget_item.transform,
            over_budget_item.transform,
            scene_object_id(MAX_RENDERABLE_SCENE_OBJECTS, over_budget_item.object_id),
            None,
            MAX_RENDERABLE_SCENE_OBJECTS,
            &plate_id,
            &mut output,
            &mut scene_objects,
            0,
            &mut test_guard(),
        );

        assert!(matches!(
            mesh,
            Err(ThreeMfError::RenderBudgetExceeded {
                mesh_objects,
                max_mesh_objects,
            }) if mesh_objects == MAX_RENDERABLE_SCENE_OBJECTS + 1
                && max_mesh_objects == MAX_RENDERABLE_SCENE_OBJECTS
        ));
        assert_eq!(output.vertices.len(), MAX_RENDERABLE_SCENE_OBJECTS * 3);
        assert_eq!(output.triangles.len(), MAX_RENDERABLE_SCENE_OBJECTS);
        assert_eq!(scene_objects.len(), MAX_RENDERABLE_SCENE_OBJECTS);
        assert_eq!(output.mesh_builds_started, MAX_RENDERABLE_SCENE_OBJECTS);
        assert!(!output
            .vertices
            .iter()
            .any(|vertex| sentinel_vertices.contains(vertex)));
        assert!(scene_objects
            .iter()
            .all(|object| object.id
                != scene_object_id(MAX_RENDERABLE_SCENE_OBJECTS, sentinel_object_id)));
        assert!(scene_objects
            .iter()
            .all(|object| object.source_id
                != source_object_id(DEFAULT_MODEL_PART, sentinel_object_id)));
    }
}
