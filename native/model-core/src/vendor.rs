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

use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::limits::ParseGuard;
use crate::threemf::{self, ThreeMfError};

/// Conventional locations of vendor parts inside a slicer 3MF project.
const SLICE_INFO_PART: &str = "Metadata/slice_info.config";
const PRUSA_MODEL_CONFIG: &str = "Metadata/Slic3r_PE_model.config";
const PRUSA_CONFIG: &str = "Metadata/Slic3r_PE.config";
const BAMBU_PROJECT_SETTINGS: &str = "Metadata/project_settings.config";
const BAMBU_MODEL_SETTINGS: &str = "Metadata/model_settings.config";

/// Guard so a hostile package cannot make us allocate unbounded plate records.
///
/// `pub(crate)` so `threemf::MAX_SCENE_PLATES` can assert equality at compile
/// time rather than the two literals drifting apart independently.
pub(crate) const MAX_PLATES: usize = 1_000;
/// Guard so thumbnail RPCs cannot enumerate or decode unbounded image payloads.
const MAX_THUMBNAIL_PARTS: usize = MAX_PLATES;
const MAX_THUMBNAIL_PART_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_THUMBNAIL_BYTES: u64 = 64 * 1024 * 1024;

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

/// One embedded plate thumbnail, carrying both its ZIP part name and PNG bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlateThumbnail {
    pub part_name: String,
    pub plate_index: Option<u32>,
    pub png_bytes: Vec<u8>,
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
    let mut guard = ParseGuard::default();
    let (mut archive, _index) = threemf::open_package(data, &mut guard)?;

    let core = extract_core(&mut archive, &mut guard)?;
    let plates = extract_plates(&mut archive, &mut guard)?;
    let parts = collect_parts(&mut archive, &mut guard)?;

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
fn extract_core<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    guard: &mut ParseGuard,
) -> Result<CoreMetadata, ThreeMfError> {
    let model_part = match threemf::locate_model_part(archive, guard) {
        Ok(part) => part,
        // A vendor project without a resolvable model part still may carry
        // useful config parts; treat missing geometry as empty core metadata.
        Err(ThreeMfError::MissingModelPart) => return Ok(CoreMetadata::default()),
        Err(e) => return Err(e),
    };
    let Some(xml) = threemf::read_entry(archive, &model_part, guard)? else {
        return Ok(CoreMetadata::default());
    };
    parse_core_metadata(&xml, guard)
}

/// Parse `<metadata name="…">value</metadata>` from the model XML. Only
/// top-level model metadata is captured; object-scoped metadata is ignored so a
/// nested `<metadata>` cannot overwrite a document-level field.
fn parse_core_metadata(xml: &str, guard: &mut ParseGuard) -> Result<CoreMetadata, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    let mut core = CoreMetadata::default();
    let mut depth: i32 = 0;
    let mut pending: Option<String> = None;
    let mut text = String::new();
    let mut xml_guard = guard.xml_guard();

    loop {
        guard.checkpoint()?;
        let event = reader.read_event()?;
        xml_guard.observe(&event)?;
        match event {
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
    guard: &mut ParseGuard,
) -> Result<Vec<PlateSliceInfo>, ThreeMfError> {
    let Some(xml) = threemf::read_entry(archive, SLICE_INFO_PART, guard)? else {
        return Ok(Vec::new());
    };
    parse_slice_info(&xml, guard)
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
fn parse_slice_info(
    xml: &str,
    guard: &mut ParseGuard,
) -> Result<Vec<PlateSliceInfo>, ThreeMfError> {
    let mut reader = Reader::from_str(xml);
    let mut plates: Vec<PlateSliceInfo> = Vec::new();
    let mut current: Option<PlateSliceInfo> = None;
    let mut xml_guard = guard.xml_guard();

    loop {
        guard.checkpoint()?;
        let event = reader.read_event()?;
        xml_guard.observe(&event)?;
        match event {
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
fn collect_parts<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    guard: &mut ParseGuard,
) -> Result<VendorParts, ThreeMfError> {
    Ok(VendorParts {
        thumbnails: collect_thumbnail_part_names(archive, guard)?,
    })
}

/// Read a named embedded part (e.g. a plate thumbnail) as raw bytes, returning
/// `None` if the part is absent. Callers use this to upload plate PNGs.
pub fn read_part_bytes(data: &[u8], part_name: &str) -> Result<Option<Vec<u8>>, ThreeMfError> {
    let mut guard = ParseGuard::default();
    let (mut archive, _index) = threemf::open_package(data, &mut guard)?;
    read_part_bytes_limited(
        &mut archive,
        part_name,
        MAX_THUMBNAIL_PART_BYTES,
        || ThreeMfError::DataTooLarge {
            resource: "plate thumbnail",
            limit: MAX_THUMBNAIL_PART_BYTES,
        },
        &mut guard,
    )
}

fn read_part_bytes_limited<R: Read + Seek, F: Fn() -> ThreeMfError>(
    archive: &mut ZipArchive<R>,
    part_name: &str,
    max_bytes: u64,
    too_large: F,
    guard: &mut ParseGuard,
) -> Result<Option<Vec<u8>>, ThreeMfError> {
    threemf::read_entry_bytes(archive, part_name, max_bytes, too_large, guard)
}

fn collect_thumbnail_part_names<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    guard: &mut ParseGuard,
) -> Result<Vec<String>, ThreeMfError> {
    let mut thumbnails = Vec::new();
    let mut total_thumbnail_bytes = 0u64;

    for index in 0..archive.len() {
        guard.checkpoint()?;
        let file = archive.by_index(index)?;
        let part_name = file.name().to_string();
        if !part_name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        if thumbnails.len() >= MAX_THUMBNAIL_PARTS {
            return Err(ThreeMfError::TooManyParts {
                resource: "plate thumbnail parts",
                limit: MAX_THUMBNAIL_PARTS,
            });
        }
        if file.size() > MAX_THUMBNAIL_PART_BYTES {
            return Err(ThreeMfError::DataTooLarge {
                resource: "plate thumbnail",
                limit: MAX_THUMBNAIL_PART_BYTES,
            });
        }
        // A PNG that claims an impossible expansion ratio is a decompression
        // bomb aimed at the thumbnail RPC, not a plate preview.
        guard.check_ratio(&part_name, file.compressed_size(), file.size())?;
        total_thumbnail_bytes =
            total_thumbnail_bytes
                .checked_add(file.size())
                .ok_or(ThreeMfError::DataTooLarge {
                    resource: "plate thumbnails",
                    limit: MAX_TOTAL_THUMBNAIL_BYTES,
                })?;
        if total_thumbnail_bytes > MAX_TOTAL_THUMBNAIL_BYTES {
            return Err(ThreeMfError::DataTooLarge {
                resource: "plate thumbnails",
                limit: MAX_TOTAL_THUMBNAIL_BYTES,
            });
        }
        thumbnails.push(part_name);
    }

    thumbnails.sort();
    Ok(thumbnails)
}

fn read_thumbnail_part<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    part_name: &str,
    total_thumbnail_bytes: &mut u64,
    guard: &mut ParseGuard,
) -> Result<Option<Vec<u8>>, ThreeMfError> {
    let remaining = MAX_TOTAL_THUMBNAIL_BYTES
        .checked_sub(*total_thumbnail_bytes)
        .ok_or(ThreeMfError::DataTooLarge {
            resource: "plate thumbnails",
            limit: MAX_TOTAL_THUMBNAIL_BYTES,
        })?;
    let limit = remaining.min(MAX_THUMBNAIL_PART_BYTES);
    let png_bytes = read_part_bytes_limited(
        archive,
        part_name,
        limit,
        || {
            if remaining < MAX_THUMBNAIL_PART_BYTES {
                ThreeMfError::DataTooLarge {
                    resource: "plate thumbnails",
                    limit: MAX_TOTAL_THUMBNAIL_BYTES,
                }
            } else {
                ThreeMfError::DataTooLarge {
                    resource: "plate thumbnail",
                    limit: MAX_THUMBNAIL_PART_BYTES,
                }
            }
        },
        guard,
    )?;
    if let Some(png_bytes) = &png_bytes {
        *total_thumbnail_bytes = total_thumbnail_bytes
            .checked_add(png_bytes.len() as u64)
            .ok_or(ThreeMfError::DataTooLarge {
                resource: "plate thumbnails",
                limit: MAX_TOTAL_THUMBNAIL_BYTES,
            })?;
    }
    Ok(png_bytes)
}

fn plate_index_from_part_name(part_name: &str) -> Option<u32> {
    let file_name = Path::new(part_name).file_name()?.to_string_lossy();
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".png")?;
    let digits = stem.strip_prefix("plate_")?;
    digits.parse::<u32>().ok()
}

/// Enumerate all embedded PNG thumbnails and return each one's ZIP part name,
/// inferred plate index (when the part follows `plate_<n>.png`), and PNG bytes.
///
/// Extraction enforces both per-entry and aggregate limits against the actual
/// decompressed bytes returned from the ZIP reader.
pub fn read_plate_thumbnails(data: &[u8]) -> Result<Vec<PlateThumbnail>, ThreeMfError> {
    let mut guard = ParseGuard::default();
    let (mut archive, _index) = threemf::open_package(data, &mut guard)?;
    let part_names = collect_thumbnail_part_names(&mut archive, &mut guard)?;
    let mut thumbnails = Vec::new();
    let mut total_thumbnail_bytes = 0u64;
    for part_name in part_names {
        let Some(png_bytes) = read_thumbnail_part(
            &mut archive,
            &part_name,
            &mut total_thumbnail_bytes,
            &mut guard,
        )?
        else {
            return Err(ThreeMfError::Malformed(format!(
                "enumerated thumbnail part '{part_name}' could not be re-read"
            )));
        };
        thumbnails.push(PlateThumbnail {
            plate_index: plate_index_from_part_name(&part_name),
            part_name,
            png_bytes,
        });
    }
    Ok(thumbnails)
}

/// Read all embedded plate thumbnails from a 3MF file on disk.
pub fn read_plate_thumbnails_file(path: &Path) -> Result<Vec<PlateThumbnail>, ThreeMfError> {
    let data = std::fs::read(path)?;
    read_plate_thumbnails(&data)
}

/// Whether a package appears to be a slicer project (has any known vendor part).
/// Cheap heuristic over the ZIP index; does not parse content.
pub fn is_vendor_project(data: &[u8]) -> Result<bool, ThreeMfError> {
    let mut guard = ParseGuard::default();
    let (archive, _index) = threemf::open_package(data, &mut guard)?;
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
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;
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

    /// Rewrite an entry's *declared* uncompressed size in both the local and
    /// central headers, leaving the real payload intact - the shape of an
    /// archive that lies about what it will expand to. Shared with the
    /// `threemf` tests, which need the same lie to reach the running
    /// accumulator without the declared-total preflight seeing it first.
    pub(crate) fn patch_declared_uncompressed_size(
        zip: &mut [u8],
        part_name: &str,
        fake_size: u32,
    ) {
        patch_local_uncompressed_size(zip, part_name, fake_size);
        patch_central_uncompressed_size(zip, part_name, fake_size);
    }

    fn patch_local_uncompressed_size(zip: &mut [u8], part_name: &str, fake_size: u32) {
        fn overwrite_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }

        let part_name = part_name.as_bytes();
        let mut patched_local = false;
        let mut index = 0usize;
        while index + 30 + part_name.len() <= zip.len() {
            if &zip[index..index + 4] == b"PK\x03\x04" {
                let name_len = u16::from_le_bytes([zip[index + 26], zip[index + 27]]) as usize;
                let extra_len = u16::from_le_bytes([zip[index + 28], zip[index + 29]]) as usize;
                let name_start = index + 30;
                let name_end = name_start + name_len;
                if name_len == part_name.len() && &zip[name_start..name_end] == part_name {
                    overwrite_u32_le(zip, index + 22, fake_size);
                    patched_local = true;
                }
                index = name_end.saturating_add(extra_len);
                continue;
            }
            index += 1;
        }

        assert!(patched_local, "missing local header for {part_name:?}");
    }

    fn patch_central_uncompressed_size(zip: &mut [u8], part_name: &str, fake_size: u32) {
        fn overwrite_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }

        let part_name = part_name.as_bytes();
        let mut patched_central = false;
        let mut index = 0usize;

        while index + 46 + part_name.len() <= zip.len() {
            if &zip[index..index + 4] == b"PK\x01\x02" {
                let name_len = u16::from_le_bytes([zip[index + 28], zip[index + 29]]) as usize;
                let extra_len = u16::from_le_bytes([zip[index + 30], zip[index + 31]]) as usize;
                let comment_len = u16::from_le_bytes([zip[index + 32], zip[index + 33]]) as usize;
                let name_start = index + 46;
                let name_end = name_start + name_len;
                if name_len == part_name.len() && &zip[name_start..name_end] == part_name {
                    overwrite_u32_le(zip, index + 24, fake_size);
                    patched_central = true;
                }
                index = name_end
                    .saturating_add(extra_len)
                    .saturating_add(comment_len);
                continue;
            }
            index += 1;
        }

        assert!(
            patched_central,
            "missing central directory header for {part_name:?}"
        );
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
    fn reads_plate_thumbnails_with_part_names_and_indices() {
        let png_a = b"\x89PNG\r\n\x1a\nAAA".to_vec();
        let png_b = b"\x89PNG\r\n\x1a\nBBB".to_vec();
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("BambuStudio-01.08.00.55").as_bytes(),
            ),
            ("Metadata/plate_2.png", &png_b),
            ("Metadata/plate_1.png", &png_a),
        ]);

        let thumbnails = read_plate_thumbnails(&zip).unwrap();
        assert_eq!(thumbnails.len(), 2);
        assert_eq!(thumbnails[0].part_name, "Metadata/plate_1.png");
        assert_eq!(thumbnails[0].plate_index, Some(1));
        assert_eq!(thumbnails[0].png_bytes, png_a);
        assert_eq!(thumbnails[1].part_name, "Metadata/plate_2.png");
        assert_eq!(thumbnails[1].plate_index, Some(2));
        assert_eq!(thumbnails[1].png_bytes, png_b);
    }

    #[test]
    fn read_plate_thumbnails_accepts_small_honest_total_bytes() {
        let png_a = b"\x89PNG\r\n\x1a\nA".to_vec();
        let png_b = b"\x89PNG\r\n\x1a\nBB".to_vec();
        let png_c = b"\x89PNG\r\n\x1a\nCCC".to_vec();
        let zip = build_zip(&[
            ("Metadata/plate_3.png", &png_c),
            ("Metadata/plate_1.png", &png_a),
            ("Metadata/plate_2.png", &png_b),
        ]);

        let thumbnails = read_plate_thumbnails(&zip).unwrap();
        assert_eq!(thumbnails.len(), 3);
        assert_eq!(thumbnails[0].png_bytes, png_a);
        assert_eq!(thumbnails[1].png_bytes, png_b);
        assert_eq!(thumbnails[2].png_bytes, png_c);
    }

    #[test]
    fn read_plate_thumbnails_returns_empty_when_archive_has_no_png_parts() {
        let zip = build_zip(&[
            ("_rels/.rels", RELS.as_bytes()),
            (
                "3D/3dmodel.model",
                model_with_metadata("PrusaSlicer-2.7.1").as_bytes(),
            ),
            ("Metadata/project_settings.config", b"{}"),
        ]);

        let thumbnails = read_plate_thumbnails(&zip).unwrap();
        assert!(thumbnails.is_empty());
    }

    #[test]
    fn plate_index_from_part_name_rejects_non_numeric_or_noncanonical_names() {
        assert_eq!(plate_index_from_part_name("Metadata/thumbnail.png"), None);
        assert_eq!(plate_index_from_part_name("Metadata/plate_abc.png"), None);
        assert_eq!(
            plate_index_from_part_name("Metadata/plate_1_bottom.png"),
            None
        );
    }

    #[test]
    fn read_plate_thumbnails_rejects_too_many_thumbnail_parts() {
        let mut buf = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for index in 0..=MAX_THUMBNAIL_PARTS {
                writer
                    .start_file(format!("Metadata/plate_{index}.png"), options)
                    .unwrap();
                writer.write_all(b"\x89PNG\r\n\x1a\nx").unwrap();
            }
            writer.finish().unwrap();
        }

        let err = read_plate_thumbnails(&buf).unwrap_err();
        assert!(matches!(
            err,
            ThreeMfError::TooManyParts {
                resource: "plate thumbnail parts",
                limit: MAX_THUMBNAIL_PARTS,
            }
        ));
    }

    #[test]
    fn read_plate_thumbnails_rejects_oversized_thumbnail_parts() {
        let oversized_png = vec![0u8; MAX_THUMBNAIL_PART_BYTES as usize + 1];
        let zip = build_zip(&[("Metadata/plate_1.png", oversized_png.as_slice())]);

        let err = read_plate_thumbnails(&zip).unwrap_err();
        assert!(matches!(
            err,
            ThreeMfError::DataTooLarge {
                resource: "plate thumbnail",
                limit: MAX_THUMBNAIL_PART_BYTES,
            }
        ));
    }

    #[test]
    fn read_plate_thumbnails_rejects_real_total_bytes_exceeding_limit_with_spoofed_declared_sizes()
    {
        let large_png = vec![0xAB; MAX_THUMBNAIL_PART_BYTES as usize];
        let mut zip = build_zip(&[
            ("Metadata/plate_1.png", large_png.as_slice()),
            ("Metadata/plate_2.png", large_png.as_slice()),
            ("Metadata/plate_3.png", large_png.as_slice()),
            ("Metadata/plate_4.png", large_png.as_slice()),
            ("Metadata/plate_5.png", large_png.as_slice()),
        ]);
        for index in 1..=5 {
            patch_declared_uncompressed_size(&mut zip, &format!("Metadata/plate_{index}.png"), 100);
        }

        let err = read_plate_thumbnails(&zip).unwrap_err();
        assert!(matches!(
            err,
            ThreeMfError::DataTooLarge {
                resource: "plate thumbnails",
                limit: MAX_TOTAL_THUMBNAIL_BYTES,
            }
        ));
    }

    #[test]
    fn read_plate_thumbnails_accepts_total_bytes_at_exact_limit() {
        let exact_limit_png = vec![0x7A; MAX_THUMBNAIL_PART_BYTES as usize];
        let zip = build_zip(&[
            ("Metadata/plate_4.png", exact_limit_png.as_slice()),
            ("Metadata/plate_2.png", exact_limit_png.as_slice()),
            ("Metadata/plate_1.png", exact_limit_png.as_slice()),
            ("Metadata/plate_3.png", exact_limit_png.as_slice()),
        ]);

        let thumbnails = read_plate_thumbnails(&zip).unwrap();
        assert_eq!(thumbnails.len(), 4);
        assert_eq!(
            thumbnails
                .iter()
                .map(|thumbnail| thumbnail.png_bytes.len())
                .sum::<usize>() as u64,
            MAX_TOTAL_THUMBNAIL_BYTES
        );
    }

    #[test]
    fn read_plate_thumbnails_rejects_honest_total_bytes_exceeding_limit() {
        let honest_png = vec![0x5C; (13 * 1024 * 1024) as usize];
        let zip = build_zip(&[
            ("Metadata/plate_1.png", honest_png.as_slice()),
            ("Metadata/plate_2.png", honest_png.as_slice()),
            ("Metadata/plate_3.png", honest_png.as_slice()),
            ("Metadata/plate_4.png", honest_png.as_slice()),
            ("Metadata/plate_5.png", honest_png.as_slice()),
        ]);

        let err = read_plate_thumbnails(&zip).unwrap_err();
        assert!(matches!(
            err,
            ThreeMfError::DataTooLarge {
                resource: "plate thumbnails",
                limit: MAX_TOTAL_THUMBNAIL_BYTES,
            }
        ));
    }

    #[test]
    fn read_plate_thumbnails_accepts_zero_byte_parts() {
        let zip = build_zip(&[("Metadata/plate_2.png", b""), ("Metadata/plate_1.png", b"")]);

        let thumbnails = read_plate_thumbnails(&zip).unwrap();
        assert_eq!(thumbnails.len(), 2);
        assert_eq!(thumbnails[0].part_name, "Metadata/plate_1.png");
        assert!(thumbnails[0].png_bytes.is_empty());
        assert_eq!(thumbnails[1].part_name, "Metadata/plate_2.png");
        assert!(thumbnails[1].png_bytes.is_empty());
    }

    #[test]
    fn read_plate_thumbnails_rejects_inconsistent_declared_sizes_using_actual_bytes() {
        let large_png = vec![0xD4; MAX_THUMBNAIL_PART_BYTES as usize];
        let mut zip = build_zip(&[
            ("Metadata/plate_1.png", large_png.as_slice()),
            ("Metadata/plate_2.png", large_png.as_slice()),
            ("Metadata/plate_3.png", large_png.as_slice()),
            ("Metadata/plate_4.png", large_png.as_slice()),
            ("Metadata/plate_5.png", large_png.as_slice()),
        ]);
        for index in 1..=5 {
            let part_name = format!("Metadata/plate_{index}.png");
            patch_local_uncompressed_size(&mut zip, &part_name, MAX_THUMBNAIL_PART_BYTES as u32);
            patch_central_uncompressed_size(&mut zip, &part_name, 100);
        }

        let err = read_plate_thumbnails(&zip).unwrap_err();
        assert!(matches!(
            err,
            ThreeMfError::DataTooLarge {
                resource: "plate thumbnails",
                limit: MAX_TOTAL_THUMBNAIL_BYTES,
            }
        ));
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
