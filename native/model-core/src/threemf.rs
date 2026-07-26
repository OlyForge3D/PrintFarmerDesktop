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
/// Ceiling on `<base>`/`<color>` entries across every appearance resource in
/// the package. Each entry is attacker-controlled and carries an owned name, so
/// an unbounded table is a cheap memory-amplification primitive.
///
/// This caps the entries *inside* groups. The number of groups is capped
/// separately by [`MAX_APPEARANCE_GROUPS`]; neither bounds the other.
pub const MAX_APPEARANCE_ENTRIES: usize = 1_000_000;
/// Ceiling on `<basematerials>`/`<colorgroup>` resources across the package.
///
/// A group with no children charges nothing against [`MAX_APPEARANCE_ENTRIES`]
/// while still costing a retained map entry, so capping entries alone leaves
/// the group dimension bounded only by the XML size caps — three orders of
/// magnitude looser, and enough for a hostile package to retain gigabytes.
pub const MAX_APPEARANCE_GROUPS: usize = 1_000_000;
/// Longest accepted `<base name="...">`. Material labels are display strings,
/// not payloads.
const MAX_MATERIAL_NAME_BYTES: usize = 256;

/// Conventional location of the model part when relationships are absent.
const DEFAULT_MODEL_PART: &str = "3D/3dmodel.model";
const RELATIONSHIPS_PART: &str = "_rels/.rels";
const CONTENT_TYPES_PART: &str = "[Content_Types].xml";
const MAX_METADATA_XML_BYTES: u64 = 8 * 1024 * 1024;
/// Vendor part in which Bambu Studio and OrcaSlicer record the plate layout.
const MODEL_SETTINGS_PART: &str = "Metadata/model_settings.config";
/// Upper bound on declared plates, so a hostile package cannot make us allocate
/// unbounded plate records. Matches both `vendor::MAX_PLATES` and the scene-DTO
/// `plates` cap the IPC layer enforces (`src/shared/ipc.ts`), which would reject
/// the whole scene if we emitted more. This caps the plate *names* we retain;
/// the per-instance assignment map is instead bounded by
/// `MAX_METADATA_XML_BYTES`, since each entry needs its own XML element.
const MAX_SCENE_PLATES: usize = 1_000;

// The vendor parser caps the plate list it builds and this module caps the
// names it retains from that list; if the two ever disagreed, one of the caps
// would be dead code and the surviving one would silently become the real
// limit. Asserting it here costs nothing at runtime and cannot rot.
const _: () = assert!(MAX_SCENE_PLATES == crate::vendor::MAX_PLATES);
// `src/shared/ipc.ts` gates `scene.plates` at the same 1,000 and would reject
// the whole scene if we emitted more. That one cannot be linked from Rust
// without codegen, so it is named here instead: change one, change both.
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
    /// `None` where the entry declared a colour we could not parse.
    ///
    /// Optional on purpose. A non-optional slot forces the parser to invent a
    /// value for a malformed entry, and the only available invention is black -
    /// which is indistinguishable from a legitimately black material. Keeping
    /// the absence representable is what lets an unreadable colour stay absent
    /// all the way to the DTO instead of being laundered into a real colour.
    colors: Vec<Option<[u8; 3]>>,
    /// Material names, parallel to `colors`. Only `<basematerials>` supplies
    /// them; a `<colorgroup>` leaves them `None`.
    names: Vec<Option<String>>,
}

impl AppearanceGroup {
    /// The colour at `index`, or `None` when the index is out of range or the
    /// entry there was unreadable. Both are the same thing to a caller: this
    /// reference does not name a colour we can show.
    fn color_at(&self, index: u32) -> Option<[u8; 3]> {
        self.colors.get(usize::try_from(index).ok()?).copied()?
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
    /// Whether any cosmetic `pid`/`pindex`/`p1` in this part was unreadable.
    ///
    /// A flag rather than a count on purpose: an object placed by several build
    /// items is resolved once per instance, so a count would multiply, and a
    /// hostile part carrying a million junk attributes must not be able to
    /// amplify itself into a million diagnostics. Boolean `or` is idempotent,
    /// which makes both problems structurally impossible instead of merely
    /// handled.
    malformed_appearance: bool,
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
    plate_layout: PlateLayout,
}

/// Which plate each build instance sits on, as declared by Bambu Studio and
/// OrcaSlicer in `Metadata/model_settings.config`.
///
/// This part is advisory: it is vendor metadata rather than 3MF core, so any
/// problem reading or parsing it degrades to "one implicit plate" instead of
/// failing a model that otherwise parsed cleanly.
#[derive(Debug, Default)]
struct PlateLayout {
    /// Declared plate names, in declaration order. Empty entries are resolved
    /// to a positional fallback once parsing finishes.
    names: Vec<String>,
    /// `(object id, instance index)` -> index into [`PlateLayout::names`].
    assignments: HashMap<(u32, u32), usize>,
}

#[derive(Debug, Default)]
struct ParseBudget {
    vertices: usize,
    triangles: usize,
    objects: usize,
    components: usize,
    appearances: usize,
    appearance_groups: usize,
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

    fn add_appearance_group(&mut self) -> Result<(), ThreeMfError> {
        Self::add(&mut self.appearance_groups, MAX_APPEARANCE_GROUPS)
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

/// A resolved material plus whether any declared appearance reference failed to
/// resolve, so the caller can degrade the load status instead of guessing.
struct ResolvedMaterial {
    material: ThreeMfMaterial,
    unresolved: bool,
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

    let plate_layout = read_plate_layout(&mut archive, &package_index, &mut guard)?;

    flatten(
        &RawPackage {
            models,
            root_part: root_part_key,
            plate_layout,
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
    let mut malformed_appearance = false;
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
                    current_appearance =
                        match optional_cosmetic_u32(&e, b"pid", &mut malformed_appearance) {
                            Some(pid) => {
                                // An *absent* `pindex` legitimately means entry 0.
                                // An *unreadable* one must clear the whole
                                // reference instead, because entry 0 is a real
                                // material: defaulting there would silently paint
                                // the object in some other entry's colour, which is
                                // the mis-attribution this leniency exists to
                                // avoid.
                                let mut pindex_unreadable = false;
                                let pindex =
                                    optional_cosmetic_u32(&e, b"pindex", &mut pindex_unreadable);
                                if pindex_unreadable {
                                    malformed_appearance = true;
                                    None
                                } else {
                                    Some((pid, pindex.unwrap_or_default()))
                                }
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
                        // `zip` rather than `and_then` deliberately: it
                        // evaluates both, so an unreadable `p1` is flagged even
                        // when `pid` is absent and the pair can never resolve.
                        // Short-circuiting there would let a junk attribute go
                        // unreported purely because its partner was missing.
                        let face = optional_cosmetic_u32(&e, b"pid", &mut malformed_appearance)
                            .zip(optional_cosmetic_u32(&e, b"p1", &mut malformed_appearance));
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
                        // Charged where the group opens, not where it is
                        // inserted: a flood of unterminated or self-closing
                        // groups never reaches the insert at all, so charging
                        // there would leave the commonest shape uncharged.
                        budget.add_appearance_group()?;
                        current_group = Some((attr_u32(&e, b"id")?, AppearanceGroup::default()));
                    }
                    b"base" => {
                        if let Some((_, group)) = current_group.as_mut() {
                            budget.add_appearance()?;
                            group
                                .colors
                                .push(parse_appearance_color(&e, b"displaycolor")?);
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
                            group.colors.push(parse_appearance_color(&e, b"color")?);
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
        malformed_appearance,
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
/// Every way of failing to determine a colour converges on the same outcome:
/// the appearance is **absent**, the geometry is untouched, and the caller is
/// told. Dangling `pid`, out-of-range `pindex`/`p1` and an entry whose colour
/// would not parse are indistinguishable to a viewer - each one means "this
/// reference does not name a colour we can show" - so handling them differently
/// only produces inconsistency, not safety.
///
/// The two outcomes this must never produce are black and a neighbour's colour.
/// Both are lies a renderer cannot detect: they arrive as ordinary values, so
/// the user sees a confidently wrong model rather than an uncoloured one.
fn resolve_material(model: &RawModel, object: &RawObject) -> ResolvedMaterial {
    let base_color = object
        .appearance
        .and_then(|(pid, index)| model.appearances.get(&pid)?.color_at(index));
    // A declared reference that resolved to nothing is the corruption; having
    // no reference at all is simply an uncoloured object.
    let mut unresolved = object.appearance.is_some() && base_color.is_none();

    let face_colors = match &object.geometry {
        ObjectGeometry::Mesh {
            triangles,
            triangle_appearance,
            ..
        } if !triangle_appearance.is_empty() => {
            let resolved: Option<Vec<[u8; 3]>> = triangle_appearance
                .iter()
                .map(|face| match face {
                    Some((pid, index)) => {
                        let color = model
                            .appearances
                            .get(pid)
                            .and_then(|group| group.color_at(*index));
                        // Note the absent `.or(base_color)`: a face that asked
                        // for a specific entry and did not get one must not
                        // quietly fall back to the object's material. That is
                        // the neighbour's-value case, and it is worse than no
                        // colour because it looks deliberate.
                        unresolved |= color.is_none();
                        color
                    }
                    // A face that declared no reference of its own legitimately
                    // inherits the object's material, per the 3MF spec. Not a
                    // defect, so it is not reported as one.
                    None => base_color,
                })
                .collect();
            // `collect` into `Option` yields `None` if any single face did.
            // All-or-nothing is forced by the DTO, which carries one colour per
            // triangle or none at all, and dropping the array is the only
            // honest way to say "some of these faces have no colour we can
            // vouch for" without inventing values for them.
            //
            // Dropping it is still a loss the caller has to hear about, so
            // every path that drops it reports through `unresolved`. The length
            // arm is unreachable while the array is grown in lockstep with the
            // triangles above, which is what the assert pins - but the assert
            // cannot be the defence: `debug_assert` compiles out in release and
            // the packaged sidecar is a release build, so in every binary a
            // user runs the colours would vanish with a clean status. The
            // assert tells the developer; `unresolved` tells the user.
            debug_assert_eq!(
                triangle_appearance.len(),
                triangles.len(),
                "per-face appearance must be grown in lockstep with the triangles"
            );
            match resolved {
                Some(colors) if colors.len() == triangles.len() => Some(colors),
                _ => {
                    unresolved = true;
                    None
                }
            }
        }
        _ => None,
    };

    ResolvedMaterial {
        material: ThreeMfMaterial {
            base_color,
            face_colors,
        },
        unresolved,
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
    /// Set when any object's declared appearance reference failed to resolve.
    /// Accumulated with `or`, so re-resolving the same object for each build
    /// instance cannot inflate it.
    unresolved_appearance: bool,
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

/// Map each build item to the plate index the vendor layout declares for it.
///
/// `instance_id` in `model_settings.config` counts a given object's build items
/// in document order, so replaying that counter here is what links the two
/// files. Anything the layout does not mention falls back to plate 0.
fn assign_build_items_to_plates(root_model: &RawModel, layout: &PlateLayout) -> Vec<usize> {
    let mut instance_counts: HashMap<u32, u32> = HashMap::new();
    root_model
        .build
        .iter()
        .map(|item| {
            let counter = instance_counts.entry(item.object_id).or_insert(0);
            let instance_id = *counter;
            *counter += 1;
            layout
                .assignments
                .get(&(item.object_id, instance_id))
                .copied()
                .unwrap_or(0)
        })
        .collect()
}

/// Whether the vendor plate layout can be applied to this build without
/// ambiguity.
///
/// The layout keys on `object_id` alone, and so does the instance counter that
/// replays it. But 3MF object ids are scoped to each model part (see
/// [`RawPackage`]), so two build items referencing id `1` in different parts
/// share a counter and one of them can be assigned the other's plate - geometry
/// that renders on the wrong plate, looks plausible, and reports no error.
///
/// No shipping slicer is known to emit Production Extension `p:path` build items
/// alongside `model_settings.config`, and in that combination the vendor's own
/// key space is ambiguous anyway, so there is no correct assignment to compute.
/// Rather than rest correctness on a negative claim about input we do not
/// control, the layout is discarded whenever any build item names a model part.
/// The scene then degrades to the implicit single plate - the same fallback the
/// vendor file being absent already produces - which makes the collision
/// unreachable by construction rather than by assumption.
fn plate_layout_is_unambiguous(root_model: &RawModel) -> bool {
    root_model
        .build
        .iter()
        .all(|item| item.model_part.is_none())
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

    // Resolve plate membership up front: the plate index is baked into every
    // scene object id, so it has to be known before the first id is minted.
    // Discarding the layout wholesale - rather than only its assignments - is
    // what keeps a degraded scene from being labelled with the vendor's first
    // plate name while actually holding every build item.
    let no_layout = PlateLayout::default();
    let plate_layout = if plate_layout_is_unambiguous(root_model) {
        &package.plate_layout
    } else {
        &no_layout
    };
    let item_plates = assign_build_items_to_plates(root_model, plate_layout);
    let mut used_plates = item_plates.clone();
    used_plates.sort_unstable();
    used_plates.dedup();
    // An empty build still gets one plate, so the scene always has somewhere to
    // hang a selector entry.
    if used_plates.is_empty() {
        used_plates.push(0);
    }
    // Only plates that actually receive geometry become scene plates, so a
    // declared-but-empty plate never shows up as a dead entry in the selector.
    let plate_slots: HashMap<usize, usize> = used_plates
        .iter()
        .enumerate()
        .map(|(slot, declared)| (*declared, slot))
        .collect();
    let mut plates: Vec<ThreeMfPlate> = used_plates
        .iter()
        .enumerate()
        .map(|(slot, declared)| ThreeMfPlate {
            id: plate_id(slot),
            name: plate_layout
                .names
                .get(*declared)
                .filter(|name| !name.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("Plate {}", slot + 1)),
            index: slot,
            root_object_ids: Vec::new(),
        })
        .collect();

    for (build_item_index, item) in root_model.build.iter().enumerate() {
        let model_part = item.model_part.as_deref().unwrap_or(&package.root_part);
        let triangle_start = output.triangles.len();
        let plate_slot = plate_slots[&item_plates[build_item_index]];
        let plate_id = plates[plate_slot].id.clone();
        let root_id = scene_object_id(plate_slot, build_item_index, item.object_id);
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
        plates[plate_slot].root_object_ids.push(root_id);
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

    let mut status = SceneLoadStatus::Complete;
    let mut status_messages = Vec::new();
    // Fixed order, and at most one message per defect kind, so the diagnostic
    // is deterministic and a hostile package cannot turn a million bad
    // attributes into a million strings.
    if package
        .models
        .values()
        .any(|model| model.malformed_appearance)
    {
        status = status.combine(SceneLoadStatus::Partial);
        status_messages.push(
            "some appearance references could not be read and were ignored; the objects \
             using them are shown without their declared colours"
                .to_string(),
        );
    }
    if output.unresolved_appearance {
        status = status.combine(SceneLoadStatus::Partial);
        status_messages.push(
            "some appearance references could not be resolved to a colour; the objects \
             using them are shown without their declared colours"
                .to_string(),
        );
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
        status,
        status_messages,
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
    output.unresolved_appearance |= material.unresolved;
    let material = material.material;
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

fn scene_object_id(plate_index: usize, build_item_index: usize, object_id: u32) -> String {
    format!("plate-{plate_index}/item-{build_item_index}/object-{object_id}")
}

fn plate_id(index: usize) -> String {
    format!("plate-{index}")
}

/// Read the vendor plate layout, if the package declares one.
///
/// Missing, oversized, unreadable, or malformed advisory metadata degrades to
/// an empty layout, which puts every build item on the single implicit plate
/// that this parser has always emitted. Security-budget violations still abort
/// the package parse.
fn read_plate_layout<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_index: &PackageIndex,
    guard: &mut ParseGuard,
) -> Result<PlateLayout, ThreeMfError> {
    let Some(part_name) = package_index
        .actual_name(MODEL_SETTINGS_PART)
        .map(str::to_owned)
    else {
        return Ok(PlateLayout::default());
    };
    match read_text_entry_limited(archive, &part_name, MAX_METADATA_XML_BYTES, guard) {
        Ok(Some(xml)) => parse_plate_layout(&xml, guard),
        Ok(None)
        | Err(ThreeMfError::Io(_))
        | Err(ThreeMfError::Zip(_))
        | Err(ThreeMfError::TooLarge) => Ok(PlateLayout::default()),
        Err(error) => Err(error),
    }
}

/// Parse `Metadata/model_settings.config` into a plate layout.
///
/// The shape written by Bambu Studio and OrcaSlicer is:
///
/// ```xml
/// <config>
///   <plate>
///     <metadata key="plater_id" value="1"/>
///     <metadata key="plater_name" value="Left"/>
///     <model_instance>
///       <metadata key="object_id" value="2"/>
///       <metadata key="instance_id" value="0"/>
///     </model_instance>
///   </plate>
/// </config>
/// ```
///
/// `object_id` is the 3MF resource id and `instance_id` counts that object's
/// build items in document order, which is what [`flatten`] replays.
fn parse_plate_layout(xml: &str, guard: &mut ParseGuard) -> Result<PlateLayout, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut layout = PlateLayout::default();
    let mut xml_guard = guard.xml_guard();
    // `Some(slot)` while inside a plate we still have room to record.
    let mut current_plate: Option<usize> = None;
    let mut in_plate = false;
    let mut in_instance = false;
    let mut plater_id: Option<u32> = None;
    let mut object_id: Option<u32> = None;
    let mut instance_id: Option<u32> = None;

    loop {
        guard.checkpoint()?;
        let event = match reader.read_event() {
            Ok(event) => event,
            // Advisory metadata never fails the model, so a malformed part just
            // means "no layout".
            Err(_) => return Ok(PlateLayout::default()),
        };
        xml_guard.observe(&event)?;
        match event {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => match local_name(e.name().as_ref()) {
                b"plate" => {
                    in_plate = true;
                    in_instance = false;
                    plater_id = None;
                    current_plate = if layout.names.len() < MAX_SCENE_PLATES {
                        layout.names.push(String::new());
                        Some(layout.names.len() - 1)
                    } else {
                        None
                    };
                }
                b"model_instance" if in_plate => {
                    in_instance = true;
                    object_id = None;
                    instance_id = None;
                }
                b"metadata" => {
                    let Some(key) = get_attr(e, b"key") else {
                        continue;
                    };
                    let value = get_attr(e, b"value").unwrap_or_default();
                    match (in_instance, key.as_str()) {
                        (true, "object_id") => object_id = value.trim().parse().ok(),
                        (true, "instance_id") => instance_id = value.trim().parse().ok(),
                        (false, "plater_id") if in_plate => plater_id = value.trim().parse().ok(),
                        (false, "plater_name") if in_plate => {
                            if let Some(slot) = current_plate {
                                layout.names[slot] = value.trim().to_owned();
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            },
            Event::End(ref e) => match local_name(e.name().as_ref()) {
                b"model_instance" if in_instance => {
                    in_instance = false;
                    if let (Some(slot), Some(object), Some(instance)) =
                        (current_plate, object_id, instance_id)
                    {
                        // First declaration wins, so a duplicated instance
                        // cannot silently move geometry to a later plate.
                        layout.assignments.entry((object, instance)).or_insert(slot);
                    }
                }
                b"plate" if in_plate => {
                    if let Some(slot) = current_plate {
                        if layout.names[slot].is_empty() {
                            let label = plater_id.map(|id| id as usize).unwrap_or(slot + 1);
                            layout.names[slot] = format!("Plate {label}");
                        }
                    }
                    in_plate = false;
                    in_instance = false;
                    current_plate = None;
                }
                _ => {}
            },
            _ => {}
        }
    }

    // A truncated part can leave the final plate unnamed.
    for (index, name) in layout.names.iter_mut().enumerate() {
        if name.is_empty() {
            *name = format!("Plate {}", index + 1);
        }
    }
    Ok(layout)
}

/// Strip an XML namespace prefix, so `<p:plate>` matches `<plate>`.
fn local_name(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|byte| *byte == b':') {
        Some(index) => &name[index + 1..],
        None => name,
    }
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

/// Parse an optional **cosmetic** `u32` attribute (`pid`, `pindex`, `p1`),
/// treating an unreadable value as absent and flagging that it was unreadable.
///
/// Deliberately not a general-purpose helper, and the name says so, because the
/// hazard in a leniency change is leniency leaking to the wrong attributes.
/// Geometry keeps [`attr_u32`] and stays fatal: a `v1` we cannot read means we
/// do not know the shape, and guessing there would put wrong triangles on a
/// print plate. A `pid` we cannot read only means we do not know a colour.
///
/// Refusing to open the whole file over an unreadable colour reference is an
/// availability bug rather than a safety measure - it is also attacker
/// triggerable, since one junk attribute anywhere in a model part would deny
/// display of everything in it.
fn optional_cosmetic_u32(e: &BytesStart, name: &[u8], unreadable: &mut bool) -> Option<u32> {
    let raw = get_attr(e, name)?;
    match raw.trim().parse::<u32>() {
        Ok(value) => Some(value),
        Err(_) => {
            *unreadable = true;
            None
        }
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
                    malformed_appearance: false,
                },
            )]),
            root_part: DEFAULT_MODEL_PART.to_string(),
            plate_layout: PlateLayout::default(),
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
                scene_object_id(0, build_item_index, item.object_id),
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
            scene_object_id(0, MAX_RENDERABLE_SCENE_OBJECTS, over_budget_item.object_id),
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
        assert!(scene_objects.iter().all(|object| object.id
            != scene_object_id(0, MAX_RENDERABLE_SCENE_OBJECTS, sentinel_object_id)));
        assert!(scene_objects
            .iter()
            .all(|object| object.source_id
                != source_object_id(DEFAULT_MODEL_PART, sentinel_object_id)));
    }

    /// Two objects, each built twice, so instance counting is exercised.
    fn four_instance_model() -> String {
        let object = |id: u32, x: f32| {
            format!(
                r#"    <object id="{id}" type="model">
      <mesh>
        <vertices>
          <vertex x="{x}" y="0" z="0"/>
          <vertex x="{}" y="0" z="0"/>
          <vertex x="{x}" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
"#,
                x + 1.0
            )
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
{}{}  </resources>
  <build>
    <item objectid="1"/>
    <item objectid="2"/>
    <item objectid="1"/>
    <item objectid="2"/>
  </build>
</model>"#,
            object(1, 0.0),
            object(2, 5.0)
        )
    }

    /// Build a package that also carries the Bambu/Orca plate layout part.
    fn package_with_model_settings(model_xml: &str, settings_xml: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(RELATIONSHIPS_PART, options).unwrap();
            writer.write_all(RELS_XML.as_bytes()).unwrap();
            writer.start_file(DEFAULT_MODEL_PART, options).unwrap();
            writer.write_all(model_xml.as_bytes()).unwrap();
            writer.start_file(MODEL_SETTINGS_PART, options).unwrap();
            writer.write_all(settings_xml.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    fn plate_block(plater_id: u32, name: Option<&str>, instances: &[(u32, u32)]) -> String {
        let name_row = match name {
            Some(name) => format!("    <metadata key=\"plater_name\" value=\"{name}\"/>\n"),
            None => String::new(),
        };
        let rows: String = instances
            .iter()
            .map(|(object_id, instance_id)| {
                format!(
                    r#"    <model_instance>
      <metadata key="object_id" value="{object_id}"/>
      <metadata key="instance_id" value="{instance_id}"/>
    </model_instance>
"#
                )
            })
            .collect();
        format!(
            "  <plate>\n    <metadata key=\"plater_id\" value=\"{plater_id}\"/>\n{name_row}{rows}  </plate>\n"
        )
    }

    fn model_settings(plates: &[String]) -> String {
        format!(
            "<?xml version=\"1.0\"?>\n<config>\n{}</config>",
            plates.concat()
        )
    }

    #[test]
    fn plate_layout_maps_each_instance_to_its_declared_plate() {
        let xml = model_settings(&[
            plate_block(1, Some("Left"), &[(1, 0), (2, 0)]),
            plate_block(2, Some("Right"), &[(1, 1), (2, 1)]),
        ]);
        let layout = parse_plate_layout(&xml, &mut test_guard()).unwrap();

        assert_eq!(layout.names, vec!["Left".to_string(), "Right".to_string()]);
        assert_eq!(layout.assignments.get(&(1, 0)), Some(&0));
        assert_eq!(layout.assignments.get(&(2, 0)), Some(&0));
        assert_eq!(layout.assignments.get(&(1, 1)), Some(&1));
        assert_eq!(layout.assignments.get(&(2, 1)), Some(&1));
    }

    #[test]
    fn plate_layout_names_unnamed_plates_from_plater_id() {
        let xml = model_settings(&[
            plate_block(3, None, &[(1, 0)]),
            plate_block(7, Some(""), &[]),
        ]);
        let layout = parse_plate_layout(&xml, &mut test_guard()).unwrap();

        assert_eq!(
            layout.names,
            vec!["Plate 3".to_string(), "Plate 7".to_string()]
        );
    }

    #[test]
    fn plate_layout_degrades_to_empty_on_malformed_xml() {
        let xml = format!(
            "{}<unclosed",
            model_settings(&[plate_block(1, None, &[(1, 0)])])
        );
        let layout = parse_plate_layout(&xml, &mut test_guard()).unwrap();

        assert!(layout.names.is_empty());
        assert!(layout.assignments.is_empty());
    }

    #[test]
    fn plate_layout_caps_declared_plates() {
        let plates: Vec<String> = (0..MAX_SCENE_PLATES + 5)
            .map(|index| plate_block(index as u32 + 1, None, &[(index as u32 + 1, 0)]))
            .collect();
        let layout = parse_plate_layout(&model_settings(&plates), &mut test_guard()).unwrap();

        assert_eq!(layout.names.len(), MAX_SCENE_PLATES);
        // Instances declared on plates beyond the cap are absent from
        // `assignments`, so `assign_build_items_to_plates` falls back to plate 0
        // for them - they are not folded onto the last plate we kept, and they
        // are not dropped from the scene either.
        assert!(layout
            .assignments
            .values()
            .all(|plate| *plate < MAX_SCENE_PLATES));
        assert_eq!(layout.assignments.len(), MAX_SCENE_PLATES);
    }

    #[test]
    fn plate_layout_keeps_the_first_declaration_of_a_duplicated_instance() {
        let xml = model_settings(&[
            plate_block(1, Some("Left"), &[(1, 0)]),
            plate_block(2, Some("Right"), &[(1, 0)]),
        ]);
        let layout = parse_plate_layout(&xml, &mut test_guard()).unwrap();

        assert_eq!(layout.assignments.get(&(1, 0)), Some(&0));
    }

    #[test]
    fn build_items_replay_the_vendor_instance_counter() {
        let package = RawPackage {
            models: HashMap::from([(
                DEFAULT_MODEL_PART.to_string(),
                RawModel {
                    objects: HashMap::new(),
                    build: vec![1, 2, 1, 2]
                        .into_iter()
                        .map(|object_id| Component {
                            object_id,
                            model_part: None,
                            transform: Transform::identity(),
                        })
                        .collect(),
                    unit: "millimeter".to_string(),
                    appearances: HashMap::new(),
                    malformed_appearance: false,
                },
            )]),
            root_part: DEFAULT_MODEL_PART.to_string(),
            plate_layout: parse_plate_layout(
                &model_settings(&[
                    plate_block(1, None, &[(1, 0), (2, 0)]),
                    plate_block(2, None, &[(1, 1), (2, 1)]),
                ]),
                &mut test_guard(),
            )
            .unwrap(),
        };
        let root_model = package.models.get(DEFAULT_MODEL_PART).unwrap();

        assert_eq!(
            assign_build_items_to_plates(root_model, &package.plate_layout),
            vec![0, 0, 1, 1]
        );
    }

    #[test]
    fn flatten_emits_one_scene_plate_per_populated_plate() {
        let bytes = package_with_model_settings(
            &four_instance_model(),
            &model_settings(&[
                plate_block(1, Some("Left"), &[(1, 0), (2, 0)]),
                plate_block(2, Some("Right"), &[(1, 1), (2, 1)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 2);
        assert_eq!(mesh.plates[0].id, "plate-0");
        assert_eq!(mesh.plates[0].name, "Left");
        assert_eq!(mesh.plates[0].index, 0);
        assert_eq!(mesh.plates[1].id, "plate-1");
        assert_eq!(mesh.plates[1].name, "Right");
        assert_eq!(mesh.plates[1].index, 1);

        assert_eq!(
            mesh.plates[0].root_object_ids,
            vec![
                "plate-0/item-0/object-1".to_string(),
                "plate-0/item-1/object-2".to_string()
            ]
        );
        assert_eq!(
            mesh.plates[1].root_object_ids,
            vec![
                "plate-1/item-2/object-1".to_string(),
                "plate-1/item-3/object-2".to_string()
            ]
        );
        // Every root id still appears once in the scene-wide roots, in build order.
        assert_eq!(
            mesh.root_object_ids,
            vec![
                "plate-0/item-0/object-1".to_string(),
                "plate-0/item-1/object-2".to_string(),
                "plate-1/item-2/object-1".to_string(),
                "plate-1/item-3/object-2".to_string()
            ]
        );
        for object in &mesh.objects {
            let plate = if object.id.starts_with("plate-1/") {
                "plate-1"
            } else {
                "plate-0"
            };
            assert_eq!(
                object.plate_id, plate,
                "object {} on wrong plate",
                object.id
            );
        }
    }

    #[test]
    fn flatten_keeps_a_single_plate_without_vendor_settings() {
        let bytes = package(&four_instance_model(), true, DEFAULT_MODEL_PART);
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].id, "plate-0");
        assert_eq!(mesh.plates[0].name, "Plate 1");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 4);
        assert!(mesh
            .objects
            .iter()
            .all(|object| object.id.starts_with("plate-0/") && object.plate_id == "plate-0"));
    }

    #[test]
    fn flatten_skips_declared_plates_that_hold_no_geometry() {
        let bytes = package_with_model_settings(
            &four_instance_model(),
            &model_settings(&[
                plate_block(1, Some("Empty"), &[]),
                plate_block(2, Some("Full"), &[(1, 0), (2, 0), (1, 1), (2, 1)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        // The empty plate is dropped and the populated one is renumbered to 0,
        // so the selector never offers a plate with nothing on it.
        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].id, "plate-0");
        assert_eq!(mesh.plates[0].index, 0);
        assert_eq!(mesh.plates[0].name, "Full");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 4);
    }

    #[test]
    fn flatten_falls_back_to_the_first_plate_for_unlisted_instances() {
        let bytes = package_with_model_settings(
            &four_instance_model(),
            &model_settings(&[
                plate_block(1, Some("Left"), &[(1, 0)]),
                plate_block(2, Some("Right"), &[(1, 1)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 2);
        // Object 2's instances are absent from the layout, so both land on plate 0.
        assert_eq!(
            mesh.plates[0].root_object_ids,
            vec![
                "plate-0/item-0/object-1".to_string(),
                "plate-0/item-1/object-2".to_string(),
                "plate-0/item-3/object-2".to_string()
            ]
        );
        assert_eq!(
            mesh.plates[1].root_object_ids,
            vec!["plate-1/item-2/object-1".to_string()]
        );
    }

    #[test]
    fn flatten_ignores_a_model_settings_part_that_declares_no_plates() {
        let bytes = package_with_model_settings(
            &four_instance_model(),
            "<?xml version=\"1.0\"?>\n<config><object id=\"1\"/></config>",
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].name, "Plate 1");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 4);
    }

    #[test]
    fn flatten_puts_component_children_on_their_parents_plate() {
        let model = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
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
      <components>
        <component objectid="1"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
    <item objectid="2"/>
  </build>
</model>"#;
        let bytes = package_with_model_settings(
            model,
            &model_settings(&[
                plate_block(1, Some("Left"), &[(2, 0)]),
                plate_block(2, Some("Right"), &[(2, 1)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 2);
        let second_plate: Vec<&ThreeMfSceneObject> = mesh
            .objects
            .iter()
            .filter(|object| object.plate_id == "plate-1")
            .collect();
        assert_eq!(second_plate.len(), 2);
        // The child id is derived from the root id, so it inherits the plate prefix.
        assert!(second_plate
            .iter()
            .all(|object| object.id.starts_with("plate-1/item-1/object-2")));
    }

    /// A production-extension package that also carries the vendor plate layout.
    fn production_package_with_model_settings(
        root_xml: &str,
        model_parts: &[(&str, &str)],
        settings_xml: &str,
    ) -> Vec<u8> {
        let mut buf = production_package(root_xml, model_parts);
        // Re-open the archive to append the vendor part, so this helper stays a
        // thin wrapper over the one the production-extension tests already use.
        let mut rebuilt = Vec::new();
        {
            let mut source = zip::ZipArchive::new(Cursor::new(&mut buf)).unwrap();
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut rebuilt));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for index in 0..source.len() {
                let mut entry = source.by_index(index).unwrap();
                let name = entry.name().to_string();
                let mut contents = Vec::new();
                entry.read_to_end(&mut contents).unwrap();
                writer.start_file(name, options).unwrap();
                writer.write_all(&contents).unwrap();
            }
            writer.start_file(MODEL_SETTINGS_PART, options).unwrap();
            writer.write_all(settings_xml.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        rebuilt
    }

    /// Two build items on the root part and one on an external part, all naming
    /// object id 1 - the shape where the vendor's `object_id` key is ambiguous.
    fn cross_part_root_model() -> &'static str {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
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
    <item objectid="1"/>
    <item p:path="/3D/Objects/body.model" objectid="1"/>
    <item objectid="1"/>
  </build>
</model>"#
    }

    #[test]
    fn flatten_discards_the_vendor_layout_when_a_build_item_names_a_model_part() {
        // Object ids are scoped per model part, but the vendor layout keys on
        // the id alone. Here the external item takes instance 1 of the shared
        // counter, so the local object's second instance would be assigned the
        // "Other" plate. Rather than resolve an ambiguity the vendor's own key
        // space cannot express, the layout is dropped entirely.
        let bytes = production_package_with_model_settings(
            cross_part_root_model(),
            &[("3D/Objects/body.model", &single_triangle_model())],
            &model_settings(&[
                plate_block(1, Some("Local pair"), &[(1, 0), (1, 1)]),
                plate_block(2, Some("Other"), &[(1, 2)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].root_object_ids.len(), 3);
        // The name degrades too: labelling the implicit plate "Local pair" would
        // claim a vendor plate that is not what is actually on screen.
        assert_eq!(mesh.plates[0].name, "Plate 1");
        assert!(mesh
            .objects
            .iter()
            .all(|object| object.plate_id == "plate-0"));
    }

    #[test]
    fn flatten_applies_the_vendor_layout_when_no_build_item_names_a_model_part() {
        // The control for the test above. Without it, that test would pass
        // against a build that never applied the layout at all.
        let local_only = cross_part_root_model().replace(
            r#"<item p:path="/3D/Objects/body.model" objectid="1"/>"#,
            r#"<item objectid="1"/>"#,
        );
        let bytes = package_with_model_settings(
            &local_only,
            &model_settings(&[
                plate_block(1, Some("Local pair"), &[(1, 0), (1, 1)]),
                plate_block(2, Some("Other"), &[(1, 2)]),
            ]),
        );
        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 2);
        assert_eq!(mesh.plates[0].name, "Local pair");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 2);
        assert_eq!(mesh.plates[1].name, "Other");
        assert_eq!(mesh.plates[1].root_object_ids.len(), 1);
    }

    #[test]
    fn parse_bytes_caps_declared_plates_and_folds_the_surplus_onto_plate_zero() {
        // The cap is also asserted against `parse_plate_layout` directly, but a
        // unit test cannot see whether the 8 MB metadata limit rejects the
        // document first - which would pass for the wrong reason and would hide
        // a future tightening of that limit shadowing this cap entirely.
        let surplus = 5;
        let declared = MAX_SCENE_PLATES + surplus;
        let objects: String = (1..=declared)
            .map(|id| {
                format!(
                    r#"    <object id="{id}" type="model"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
"#
                )
            })
            .collect();
        let items: String = (1..=declared)
            .map(|id| format!("    <item objectid=\"{id}\"/>\n"))
            .collect();
        let model = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
{objects}  </resources>
  <build>
{items}  </build>
</model>"#
        );
        let plates: Vec<String> = (0..declared)
            .map(|index| plate_block(index as u32 + 1, None, &[(index as u32 + 1, 0)]))
            .collect();
        let settings = model_settings(&plates);
        assert!(
            (settings.len() as u64) < MAX_METADATA_XML_BYTES,
            "the fixture must stay under the metadata limit or the cap is untested"
        );

        let mesh = parse_bytes(&package_with_model_settings(&model, &settings)).unwrap();

        assert_eq!(mesh.plates.len(), MAX_SCENE_PLATES);
        assert_eq!(mesh.plates[MAX_SCENE_PLATES - 1].id, "plate-999");
        // Over-cap instances are absent from the assignment map, so they fall
        // back to plate 0 rather than being dropped from the scene.
        assert_eq!(mesh.plates[0].root_object_ids.len(), 1 + surplus);
        for plate in mesh.plates.iter().skip(1) {
            assert_eq!(plate.root_object_ids.len(), 1);
        }
    }

    #[test]
    fn flatten_degrades_when_the_vendor_part_exceeds_the_metadata_limit() {
        // One of the five advertised degradation modes. Padding is XML comment
        // text so the document stays well-formed - the point is the size limit,
        // not a parse failure or the independent compression-ratio guard.
        const ALPHANUMERIC: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let mut state = 0x4d59_5df4_d0f3_3173u64;
        let mut settings = String::with_capacity(MAX_METADATA_XML_BYTES as usize + 1024);
        settings.push_str("<?xml version=\"1.0\"?>\n<config>\n<!--");
        for _ in 0..MAX_METADATA_XML_BYTES as usize + 1 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            settings.push(ALPHANUMERIC[state as usize % ALPHANUMERIC.len()] as char);
        }
        settings.push_str("-->\n");
        settings.push_str(&plate_block(1, Some("Left"), &[(1, 0), (2, 0)]));
        settings.push_str(&plate_block(2, Some("Right"), &[(1, 1), (2, 1)]));
        settings.push_str("</config>");
        assert!((settings.len() as u64) > MAX_METADATA_XML_BYTES);

        // Control: the same layout under the limit does split the scene, so a
        // pass below cannot come from a fixture that never had two plates.
        let control = parse_bytes(&package_with_model_settings(
            &four_instance_model(),
            &two_plates(),
        ))
        .unwrap();
        assert_eq!(control.plates.len(), 2);

        let bytes = package_with_model_settings(&four_instance_model(), &settings);
        let mut archive = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let metadata = archive.by_name(MODEL_SETTINGS_PART).unwrap();
        assert!(
            metadata.size()
                <= crate::limits::MAX_COMPRESSION_RATIO * metadata.compressed_size().max(1),
            "the fixture must stay below the compression-ratio limit or the size fallback is untested"
        );

        let mesh = parse_bytes(&bytes).unwrap();

        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].name, "Plate 1");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 4);
    }

    #[test]
    fn vendor_plate_metadata_rejects_document_type_declarations() {
        let bytes = package_with_model_settings(
            &four_instance_model(),
            "<!DOCTYPE config><config></config>",
        );

        assert!(matches!(
            parse_bytes(&bytes),
            Err(ThreeMfError::Limit(LimitViolation::XmlDoctype))
        ));
    }

    #[test]
    fn vendor_plate_metadata_preserves_compression_ratio_enforcement() {
        let mut settings = String::from("<config><!--");
        settings.push_str(&"x".repeat(crate::limits::COMPRESSION_RATIO_FLOOR_BYTES as usize + 1));
        settings.push_str("--></config>");
        assert!((settings.len() as u64) < MAX_METADATA_XML_BYTES);

        let error = parse_bytes(&package_with_model_settings(
            &four_instance_model(),
            &settings,
        ))
        .unwrap_err();

        assert!(matches!(
            error,
            ThreeMfError::Limit(LimitViolation::CompressionRatio { part, .. })
                if part == MODEL_SETTINGS_PART
        ));
    }

    #[test]
    fn flatten_degrades_when_the_vendor_part_is_not_utf8() {
        // The remaining advertised degradation mode. A lone 0xFF byte cannot
        // begin a UTF-8 sequence, so the decode fails before any XML parsing.
        let mut settings = two_plates().into_bytes();
        settings.insert(0, 0xFF);
        assert!(String::from_utf8(settings.clone()).is_err());

        let control = parse_bytes(&package_with_model_settings(
            &four_instance_model(),
            &two_plates(),
        ))
        .unwrap();
        assert_eq!(control.plates.len(), 2);

        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(RELATIONSHIPS_PART, options).unwrap();
            writer.write_all(RELS_XML.as_bytes()).unwrap();
            writer.start_file(DEFAULT_MODEL_PART, options).unwrap();
            writer.write_all(four_instance_model().as_bytes()).unwrap();
            writer.start_file(MODEL_SETTINGS_PART, options).unwrap();
            writer.write_all(&settings).unwrap();
            writer.finish().unwrap();
        }

        let mesh = parse_bytes(&buf).unwrap();

        assert_eq!(mesh.plates.len(), 1);
        assert_eq!(mesh.plates[0].name, "Plate 1");
        assert_eq!(mesh.plates[0].root_object_ids.len(), 4);
    }

    /// The known-good two-plate layout for `four_instance_model`, used as the
    /// control in the degradation tests.
    fn two_plates() -> String {
        model_settings(&[
            plate_block(1, Some("Left"), &[(1, 0), (2, 0)]),
            plate_block(2, Some("Right"), &[(1, 1), (2, 1)]),
        ])
    }

    #[test]
    fn cancellation_is_not_lost_by_the_advisory_plate_layout_read() {
        // `read_plate_layout` degrades on *every* error, including a guard trip.
        // This pins the property that makes that sound end to end: a cancelled
        // parse never returns a scene, no matter which read observes the trip
        // first. (That a trip is monotonic, so a later checkpoint still sees
        // it, is pinned separately by `guard_reports_cancellation_immediately`.)
        let token = crate::limits::CancellationToken::new();
        token.cancel();
        let bytes = package_with_model_settings(&four_instance_model(), &two_plates());

        let error =
            parse_bytes_with_limits(&bytes, ParseLimits::default().with_cancellation(token))
                .expect_err("a cancelled parse must not return a scene");
        assert!(matches!(
            error,
            ThreeMfError::Limit(LimitViolation::Cancelled)
        ));

        // Control: the identical package parses, and with both plates, when
        // nothing cancels it - so the rejection above is the cancellation and
        // not something wrong with the fixture.
        assert_eq!(parse_bytes(&bytes).unwrap().plates.len(), 2);
    }

    /// A mesh whose faces carry per-face colour references, on an object that
    /// declares no material of its own. `every_face_referenced` controls the
    /// one thing under test: whether a face is left to inherit a material that
    /// does not exist.
    fn per_face_colour_model(every_face_referenced: bool) -> String {
        let second_face = if every_face_referenced {
            r#"<triangle v1="0" v2="1" v3="3" pid="10" p1="1"/>"#
        } else {
            r#"<triangle v1="0" v2="1" v3="3"/>"#
        };
        format!(
            r##"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <colorgroup id="10">
      <color color="#FF0000"/>
      <color color="#00FF00"/>
    </colorgroup>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
          <vertex x="0" y="0" z="1"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" pid="10" p1="0"/>
          {second_face}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>"##
        )
    }

    #[test]
    fn dropping_the_face_colour_array_is_reported_as_unresolved() {
        // The array is all-or-nothing, so one face with no colour to inherit
        // drops every face's colour. Dropping them is defensible; dropping them
        // while reporting Complete is not - that is the colours vanishing with
        // a clean status, which is the failure the caller can neither see nor
        // act on.
        let mesh = parse_bytes(&package(
            &per_face_colour_model(false),
            true,
            DEFAULT_MODEL_PART,
        ))
        .unwrap();

        assert!(mesh.parts.iter().all(|part| part.material_label.is_none()));
        assert_eq!(mesh.status, SceneLoadStatus::Partial);
        assert!(mesh
            .status_messages
            .iter()
            .any(|message| message.contains("could not be resolved to a colour")));
    }

    #[test]
    fn a_fully_referenced_face_colour_array_still_loads_complete() {
        // The legitimate maximum for the check above. Without it, that test
        // would pass just as well against a build that reported every mesh
        // carrying per-face colours as Partial.
        let mesh = parse_bytes(&package(
            &per_face_colour_model(true),
            true,
            DEFAULT_MODEL_PART,
        ))
        .unwrap();

        assert_eq!(mesh.status, SceneLoadStatus::Complete);
        assert!(mesh.status_messages.is_empty());
    }

    /// The total expansion the archive admits to - the only figure the
    /// preflight gets to see.
    fn declared_archive_total(bytes: &[u8]) -> u64 {
        let mut archive = ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().size())
            .sum()
    }

    #[test]
    fn a_budget_tripped_by_the_advisory_plate_read_is_not_degraded_away() {
        // The vendor plate part is advisory and degrades on a documented
        // allowlist, but a security-budget violation is not on that list.
        //
        // Getting the violation to arise *inside* the plate read is the whole
        // difficulty, and it is why the sibling test that drives a pre-cancelled
        // parse cannot pin this arm: that trips at the first checkpoint, in the
        // archive preflight, long before the plate part is opened. An honest
        // archive cannot do it either - the declared-total preflight sees the
        // sum of every declared size up front, and the running accumulator can
        // only ever charge that same sum, so the preflight always fires first.
        // The entry therefore has to under-declare, which the preflight cannot
        // detect and only the post-read charge against real bytes can.
        let mut bytes = package_with_model_settings(&four_instance_model(), &two_plates());
        crate::vendor::tests::patch_declared_uncompressed_size(&mut bytes, MODEL_SETTINGS_PART, 1);

        // Exactly the total the archive now claims, so the preflight passes and
        // every honest read stays inside it. Only the settings part's real
        // bytes, charged once it has been inflated, can push past.
        let limits = ParseLimits {
            max_total_decompressed_bytes: declared_archive_total(&bytes),
            ..ParseLimits::default().without_timeout()
        };

        let error = parse_bytes_with_limits(&bytes, limits)
            .expect_err("a budget trip inside the advisory read must fail the package");
        assert!(
            matches!(
                error,
                ThreeMfError::Limit(LimitViolation::TotalDecompressedBytes { .. })
            ),
            "expected the running accumulator, got {error:?}"
        );

        // Control: the same package unpatched, under a budget derived the same
        // way, parses and still yields both plates - so the rejection above is
        // the budget trip and not a fixture that never parsed.
        let honest = package_with_model_settings(&four_instance_model(), &two_plates());
        let honest_limits = ParseLimits {
            max_total_decompressed_bytes: declared_archive_total(&honest),
            ..ParseLimits::default().without_timeout()
        };
        assert_eq!(
            parse_bytes_with_limits(&honest, honest_limits)
                .unwrap()
                .plates
                .len(),
            2
        );
    }
}
