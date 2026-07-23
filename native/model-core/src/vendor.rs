//! Pure-Rust vendor 3MF metadata extraction.
//!
//! Slicers (PrusaSlicer, Bambu Studio, OrcaSlicer, SuperSlicer, …) ship 3MF
//! *projects*: standard OPC packages that additionally embed vendor-specific
//! parts under `Metadata/` — slice statistics, per-plate filament usage,
//! print-time predictions, and rendered plate thumbnails. Those parts live
//! outside the standard 3MF geometry model and outside lib3mf's domain, so this
//! module reads them directly from the ZIP/XML stack already used by
//! [`crate::threemf`]. No slicer code is copied; only the public, documented
//! file layout is parsed from independently authored fixtures.
//!
//! The extractor is deliberately tolerant: any missing or malformed vendor part
//! is skipped rather than failing the whole extraction, because these parts are
//! optional and vary across slicer versions. Only a corrupt outer ZIP is a hard
//! error.

use std::io::{Cursor, Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::threemf::{self, ThreeMfError};

/// Conventional locations of vendor parts inside a slicer 3MF project.
const SLICE_INFO_PART: &str = "Metadata/slice_info.config";
const PRUSA_MODEL_CONFIG: &str = "Metadata/Slic3r_PE_model.config";
const PRUSA_CONFIG: &str = "Metadata/Slic3r_PE.config";
const BAMBU_PROJECT_SETTINGS: &str = "Metadata/project_settings.config";
const BAMBU_MODEL_SETTINGS: &str = "Metadata/model_settings.config";

/// Guard so a hostile package cannot make us allocate unbounded plate records.
const MAX_PLATES: usize = 1_000;

/// The slicer that authored a 3MF project, identified from the model's
/// `Application` metadata.
///
/// Detection order matters for forks: OrcaSlicer is a Bambu Studio fork and
/// SuperSlicer is a PrusaSlicer fork, so the more specific name must be checked
/// first or the fork would be misreported as its upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slicer {
    PrusaSlicer,
    SuperSlicer,
    BambuStudio,
    OrcaSlicer,
    Cura,
    Unknown,
}

impl Slicer {
    /// Classify a slicer from the free-form `Application` metadata string, e.g.
    /// `"BambuStudio-01.08.00.55"` or `"PrusaSlicer-2.7.1+win64"`.
    pub fn from_application(application: &str) -> Self {
        let app = application.to_ascii_lowercase();
        // Check forks before their upstreams.
        if app.contains("orca") {
            Slicer::OrcaSlicer
        } else if app.contains("bambu") {
            Slicer::BambuStudio
        } else if app.contains("superslicer") || app.contains("super slicer") {
            Slicer::SuperSlicer
        } else if app.contains("prusa") || app.contains("slic3r") {
            Slicer::PrusaSlicer
        } else if app.contains("cura") {
            Slicer::Cura
        } else {
            Slicer::Unknown
        }
    }

    /// Stable camelCase wire name, matching the desktop string-enum convention.
    pub fn as_str(&self) -> &'static str {
        match self {
            Slicer::PrusaSlicer => "prusaSlicer",
            Slicer::SuperSlicer => "superSlicer",
            Slicer::BambuStudio => "bambuStudio",
            Slicer::OrcaSlicer => "orcaSlicer",
            Slicer::Cura => "cura",
            Slicer::Unknown => "unknown",
        }
    }
}

/// Core Dublin-Core-style metadata declared on the model root as
/// `<metadata name="…">value</metadata>` elements. Every field is optional
/// because slicers populate different subsets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreMetadata {
    pub title: Option<String>,
    pub designer: Option<String>,
    pub description: Option<String>,
    pub application: Option<String>,
    pub creation_date: Option<String>,
    pub modification_date: Option<String>,
    pub license_terms: Option<String>,
    pub copyright: Option<String>,
}

impl CoreMetadata {
    fn set(&mut self, name: &str, value: String) {
        match name {
            "Title" => self.title = Some(value),
            "Designer" => self.designer = Some(value),
            "Description" => self.description = Some(value),
            "Application" => self.application = Some(value),
            "CreationDate" => self.creation_date = Some(value),
            "ModificationDate" => self.modification_date = Some(value),
            "LicenseTerms" => self.license_terms = Some(value),
            "Copyright" => self.copyright = Some(value),
            _ => {}
        }
    }

    fn is_empty(&self) -> bool {
        *self == CoreMetadata::default()
    }
}

impl CoreMetadata {
    /// Whether no metadata fields were populated.
    pub fn is_populated(&self) -> bool {
        !self.is_empty()
    }
}

/// Per-plate slice statistics parsed from `Metadata/slice_info.config`. Bambu
/// and Orca write one `<plate>` element per print bed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlateSliceInfo {
    /// 1-based plate index as reported by the slicer, when present.
    pub index: Option<u32>,
    /// Predicted print time in seconds.
    pub prediction_seconds: Option<u64>,
    /// Total filament weight for the plate in grams.
    pub weight_grams: Option<f64>,
    /// Distinct filament material types used on the plate, e.g. `["PLA"]`.
    pub filament_types: Vec<String>,
}

impl PlateSliceInfo {
    fn is_empty(&self) -> bool {
        self.index.is_none()
            && self.prediction_seconds.is_none()
            && self.weight_grams.is_none()
            && self.filament_types.is_empty()
    }
}

/// A vendor part discovered in the package, with the parts the caller may want
/// to upload alongside the model (currently rendered plate thumbnails).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VendorParts {
    /// ZIP part names of embedded PNG thumbnails, sorted for determinism.
    pub thumbnails: Vec<String>,
}

/// The full vendor metadata extracted from a slicer 3MF project.
#[derive(Debug, Clone, PartialEq)]
pub struct VendorMetadata {
    pub slicer: Slicer,
    pub core: CoreMetadata,
    pub plates: Vec<PlateSliceInfo>,
    pub parts: VendorParts,
}

/// Extract vendor metadata from a 3MF file on disk.
pub fn extract_file(path: &Path) -> Result<VendorMetadata, ThreeMfError> {
    let data = std::fs::read(path)?;
    extract_bytes(&data)
}

/// Extract vendor metadata from an in-memory 3MF package.
pub fn extract_bytes(data: &[u8]) -> Result<VendorMetadata, ThreeMfError> {
    let mut archive = ZipArchive::new(Cursor::new(data))?;

    let core = extract_core(&mut archive)?;
    let plates = extract_plates(&mut archive)?;
    let parts = collect_parts(&mut archive);

    let slicer = core
        .application
        .as_deref()
        .map(Slicer::from_application)
        .unwrap_or(Slicer::Unknown);

    Ok(VendorMetadata {
        slicer,
        core,
        plates,
        parts,
    })
}

/// Read the model root `<metadata>` elements into [`CoreMetadata`].
fn extract_core<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<CoreMetadata, ThreeMfError> {
    let model_part = match threemf::locate_model_part(archive) {
        Ok(part) => part,
        // A vendor project without a resolvable model part still may carry
        // useful config parts; treat missing geometry as empty core metadata.
        Err(ThreeMfError::MissingModelPart) => return Ok(CoreMetadata::default()),
        Err(e) => return Err(e),
    };
    let Some(xml) = threemf::read_entry(archive, &model_part)? else {
        return Ok(CoreMetadata::default());
    };
    parse_core_metadata(&xml)
}

/// Parse `<metadata name="…">value</metadata>` from the model XML. Only
/// top-level model metadata is captured; object-scoped metadata is ignored so a
/// nested `<metadata>` cannot overwrite a document-level field.
fn parse_core_metadata(xml: &str) -> Result<CoreMetadata, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    let mut core = CoreMetadata::default();
    let mut depth: i32 = 0;
    let mut pending: Option<String> = None;
    let mut text = String::new();

    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                if e.name().as_ref() == b"metadata" && depth == 1 {
                    pending = threemf::get_attr(&e, b"name");
                    text.clear();
                } else if e.name().as_ref() == b"metadata" {
                    pending = None;
                }
                depth += 1;
            }
            Event::Empty(e) => {
                // A self-closing metadata element carries no value.
                if e.name().as_ref() == b"metadata" {
                    pending = None;
                }
            }
            Event::Text(t) => {
                if pending.is_some() {
                    text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Event::End(e) => {
                depth -= 1;
                if e.name().as_ref() == b"metadata" {
                    if let Some(name) = pending.take() {
                        let value = text.trim().to_string();
                        if !value.is_empty() {
                            core.set(&name, value);
                        }
                    }
                    text.clear();
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(core)
}

/// Read `Metadata/slice_info.config` into per-plate statistics. Absent on
/// PrusaSlicer projects and older exports; that yields an empty list.
fn extract_plates<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<PlateSliceInfo>, ThreeMfError> {
    let Some(xml) = threemf::read_entry(archive, SLICE_INFO_PART)? else {
        return Ok(Vec::new());
    };
    parse_slice_info(&xml)
}

/// Parse the Bambu/Orca `slice_info.config` XML. Its shape is:
///
/// ```xml
/// <config>
///   <plate>
///     <metadata key="index" value="1"/>
///     <metadata key="prediction" value="1234"/>
///     <metadata key="weight" value="12.34"/>
///     <filament id="1" type="PLA" used_g="3.4"/>
///   </plate>
/// </config>
/// ```
fn parse_slice_info(xml: &str) -> Result<Vec<PlateSliceInfo>, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    let mut plates: Vec<PlateSliceInfo> = Vec::new();
    let mut current: Option<PlateSliceInfo> = None;

    loop {
        match reader.read_event()? {
            Event::Start(e) if e.name().as_ref() == b"plate" => {
                current = Some(PlateSliceInfo::default());
            }
            Event::Start(e) | Event::Empty(e) => {
                let Some(plate) = current.as_mut() else {
                    continue;
                };
                match e.name().as_ref() {
                    b"metadata" => {
                        let key = threemf::get_attr(&e, b"key").unwrap_or_default();
                        let value = threemf::get_attr(&e, b"value").unwrap_or_default();
                        match key.as_str() {
                            "index" => plate.index = value.trim().parse::<u32>().ok(),
                            "prediction" => {
                                plate.prediction_seconds = value.trim().parse::<u64>().ok();
                            }
                            "weight" => plate.weight_grams = value.trim().parse::<f64>().ok(),
                            _ => {}
                        }
                    }
                    b"filament" => {
                        if let Some(ty) = threemf::get_attr(&e, b"type") {
                            let ty = ty.trim().to_string();
                            if !ty.is_empty() && !plate.filament_types.contains(&ty) {
                                plate.filament_types.push(ty);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::End(e) if e.name().as_ref() == b"plate" => {
                if let Some(plate) = current.take() {
                    if !plate.is_empty() && plates.len() < MAX_PLATES {
                        plates.push(plate);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(plates)
}

/// Enumerate uploadable vendor parts (PNG thumbnails) from the archive index.
fn collect_parts<R: Read + Seek>(archive: &mut ZipArchive<R>) -> VendorParts {
    let mut thumbnails: Vec<String> = archive
        .file_names()
        .filter(|name| name.to_ascii_lowercase().ends_with(".png"))
        .map(|name| name.to_string())
        .collect();
    thumbnails.sort();
    VendorParts { thumbnails }
}

/// Read a named embedded part (e.g. a plate thumbnail) as raw bytes, returning
/// `None` if the part is absent. Callers use this to upload plate PNGs.
pub fn read_part_bytes(data: &[u8], part_name: &str) -> Result<Option<Vec<u8>>, ThreeMfError> {
    let mut archive = ZipArchive::new(Cursor::new(data))?;
    threemf::read_entry_bytes(&mut archive, part_name)
}

/// Whether a package appears to be a slicer project (has any known vendor part).
/// Cheap heuristic over the ZIP index; does not parse content.
pub fn is_vendor_project(data: &[u8]) -> Result<bool, ThreeMfError> {
    let archive = ZipArchive::new(Cursor::new(data))?;
    let known = [
        SLICE_INFO_PART,
        PRUSA_MODEL_CONFIG,
        PRUSA_CONFIG,
        BAMBU_PROJECT_SETTINGS,
        BAMBU_MODEL_SETTINGS,
    ];
    let found = archive
        .file_names()
        .any(|name| known.contains(&name) || name.starts_with("Metadata/"));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};
    use zip::CompressionMethod;

    /// Build an in-memory ZIP from `(name, bytes)` parts using the pure-Rust
    /// stored method so no C compression backend is required.
    fn build_zip(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, bytes) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>"#;

    fn model_with_metadata(app: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">My Widget</metadata>
  <metadata name="Designer">Ada</metadata>
  <metadata name="Application">{app}</metadata>
  <metadata name="LicenseTerms">CC-BY-4.0</metadata>
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
  </resources>
  <build><item objectid="1"/></build>
</model>"#
        )
    }

    const SLICE_INFO: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="12.5"/>
    <filament id="1" type="PLA" color="#000000" used_g="10.0"/>
    <filament id="2" type="PLA" color="#FFFFFF" used_g="2.5"/>
    <filament id="3" type="PETG" color="#FF0000" used_g="1.0"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="4.0"/>
    <filament id="1" type="TPU" used_g="4.0"/>
  </plate>
</config>"##;

    #[test]
    fn slicer_detects_forks_before_upstreams() {
        assert_eq!(
            Slicer::from_application("OrcaSlicer-2.1.0"),
            Slicer::OrcaSlicer
        );
        assert_eq!(
            Slicer::from_application("BambuStudio-01.08.00.55"),
            Slicer::BambuStudio
        );
        assert_eq!(
            Slicer::from_application("SuperSlicer-2.5.59"),
            Slicer::SuperSlicer
        );
        assert_eq!(
            Slicer::from_application("PrusaSlicer-2.7.1+win64"),
            Slicer::PrusaSlicer
        );
        assert_eq!(Slicer::from_application("Cura 5.6"), Slicer::Cura);
        assert_eq!(Slicer::from_application("Some Other Tool"), Slicer::Unknown);
    }

    #[test]
    fn slicer_wire_names_are_camel_case() {
        assert_eq!(Slicer::PrusaSlicer.as_str(), "prusaSlicer");
        assert_eq!(Slicer::BambuStudio.as_str(), "bambuStudio");
        assert_eq!(Slicer::OrcaSlicer.as_str(), "orcaSlicer");
        assert_eq!(Slicer::SuperSlicer.as_str(), "superSlicer");
        assert_eq!(Slicer::Cura.as_str(), "cura");
        assert_eq!(Slicer::Unknown.as_str(), "unknown");
    }

    #[test]
    fn extracts_core_metadata_and_slicer() {
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("BambuStudio-01.08.00.55").as_bytes(),
            ),
            ("Metadata/slice_info.config", SLICE_INFO.as_bytes()),
            ("Metadata/plate_1.png", b"\x89PNG\r\n\x1a\nfake"),
            ("Metadata/plate_2.png", b"\x89PNG\r\n\x1a\nfake2"),
        ]);

        let md = extract_bytes(&zip).unwrap();
        assert_eq!(md.slicer, Slicer::BambuStudio);
        assert_eq!(md.core.title.as_deref(), Some("My Widget"));
        assert_eq!(md.core.designer.as_deref(), Some("Ada"));
        assert_eq!(md.core.license_terms.as_deref(), Some("CC-BY-4.0"));
        assert_eq!(
            md.core.application.as_deref(),
            Some("BambuStudio-01.08.00.55")
        );
    }

    #[test]
    fn extracts_core_metadata_from_case_variant_model_part() {
        let relationships = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
    Target="/3D/Objects/Body.model"/>
</Relationships>"#;
        let zip = build_zip(&[
            ("_RELS/.RELS", relationships.as_bytes()),
            (
                "3d/OBJECTS/BODY.MODEL",
                model_with_metadata("OrcaSlicer-2.1.0").as_bytes(),
            ),
        ]);

        let metadata = extract_bytes(&zip).unwrap();
        assert_eq!(metadata.slicer, Slicer::OrcaSlicer);
        assert_eq!(metadata.core.title.as_deref(), Some("My Widget"));
        assert_eq!(metadata.core.designer.as_deref(), Some("Ada"));
    }

    #[test]
    fn extracts_per_plate_slice_info() {
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("OrcaSlicer-2.1.0").as_bytes(),
            ),
            ("Metadata/slice_info.config", SLICE_INFO.as_bytes()),
        ]);

        let md = extract_bytes(&zip).unwrap();
        assert_eq!(md.plates.len(), 2);

        let p1 = &md.plates[0];
        assert_eq!(p1.index, Some(1));
        assert_eq!(p1.prediction_seconds, Some(3600));
        assert_eq!(p1.weight_grams, Some(12.5));
        // Duplicate PLA collapses to one entry; order preserved.
        assert_eq!(p1.filament_types, vec!["PLA", "PETG"]);

        let p2 = &md.plates[1];
        assert_eq!(p2.index, Some(2));
        assert_eq!(p2.filament_types, vec!["TPU"]);
    }

    #[test]
    fn enumerates_and_reads_thumbnails() {
        let png_a = b"\x89PNG\r\n\x1a\nAAA".to_vec();
        let png_b = b"\x89PNG\r\n\x1a\nBBB".to_vec();
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("PrusaSlicer-2.7.1").as_bytes(),
            ),
            ("Metadata/plate_2.png", &png_b),
            ("Metadata/plate_1.png", &png_a),
        ]);

        let md = extract_bytes(&zip).unwrap();
        // Sorted for determinism.
        assert_eq!(
            md.parts.thumbnails,
            vec![
                "Metadata/plate_1.png".to_string(),
                "Metadata/plate_2.png".to_string()
            ]
        );

        let bytes = read_part_bytes(&zip, "Metadata/plate_1.png").unwrap();
        assert_eq!(bytes.as_deref(), Some(png_a.as_slice()));
        let missing = read_part_bytes(&zip, "Metadata/nope.png").unwrap();
        assert_eq!(missing, None);
    }

    #[test]
    fn missing_vendor_parts_are_tolerated() {
        // A bare standard 3MF with no vendor parts and no metadata.
        let plain_model = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object></resources>
  <build><item objectid="1"/></build>
</model>"#;
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", plain_model.as_bytes()),
        ]);

        let md = extract_bytes(&zip).unwrap();
        assert_eq!(md.slicer, Slicer::Unknown);
        assert!(md.core.is_empty());
        assert!(md.plates.is_empty());
        assert!(md.parts.thumbnails.is_empty());
        assert!(!is_vendor_project(&zip).unwrap());
    }

    #[test]
    fn detects_vendor_project() {
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("BambuStudio").as_bytes(),
            ),
            ("Metadata/slice_info.config", SLICE_INFO.as_bytes()),
        ]);
        assert!(is_vendor_project(&zip).unwrap());
    }

    #[test]
    fn corrupt_zip_is_an_error() {
        let err = extract_bytes(b"not a zip at all");
        assert!(err.is_err());
    }
}
