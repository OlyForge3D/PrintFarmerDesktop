use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{CompressionMethod, DateTime, ZipArchive};

use super::report::IssueCode;
use super::{RetargetError, RetargetLimits};
use crate::threemf;

pub(crate) const PROJECT_SETTINGS_PART: &str = "Metadata/project_settings.config";
pub(crate) const MODEL_SETTINGS_PART: &str = "Metadata/model_settings.config";
const CONTENT_TYPES_PART: &str = "[Content_Types].xml";
pub(crate) const CONTENT_TYPES_PART_FOR_VALIDATION: &str = "[content_types].xml";
const MAX_RELATIONSHIP_BYTES: u64 = 16 * 1024 * 1024;
const MODEL_RELATIONSHIP_TYPE: &str =
    "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

#[derive(Debug, Clone)]
pub(crate) struct ArchivePart {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct ArchivePackage {
    pub parts: BTreeMap<String, ArchivePart>,
    pub compressed_size: u64,
}

#[derive(Debug, Default)]
pub(crate) struct StalePartPlan {
    pub removed: HashSet<String>,
    pub stale_slice_count: usize,
    pub custom_gcode_count: usize,
    pub signature_count: usize,
}

#[derive(Debug)]
pub(crate) struct WriteSummary {
    pub removed_part_count: usize,
    pub preserved_part_count: usize,
}

impl ArchivePackage {
    pub(crate) fn open(path: &Path, limits: &RetargetLimits) -> Result<Self, RetargetError> {
        let metadata =
            fs::symlink_metadata(path).map_err(|error| RetargetError::source_io(path, error))?;
        if !metadata.file_type().is_file() {
            return Err(RetargetError::new(
                IssueCode::SourceNotFound,
                "source path is not a regular file",
                "Choose a regular editable 3MF file.",
            ));
        }
        if metadata.len() > limits.max_source_bytes {
            return Err(limit_error("compressed archive exceeds 512 MiB"));
        }
        let data = fs::read(path).map_err(|error| RetargetError::source_io(path, error))?;
        let mut archive = ZipArchive::new(Cursor::new(&data)).map_err(zip_error)?;
        if archive.len() > limits.max_archive_parts {
            return Err(limit_error("archive contains too many parts"));
        }
        let mut parts = BTreeMap::new();
        let mut names = HashSet::new();
        let mut total_uncompressed = 0u64;
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).map_err(zip_error)?;
            let name = file.name().to_string();
            validate_part_name(&name)?;
            if file.encrypted() {
                return Err(RetargetError::new(
                    IssueCode::InvalidArchive,
                    format!("encrypted ZIP part '{name}' is not allowed"),
                    "Re-export the project without ZIP encryption.",
                ));
            }
            if file.is_dir() {
                return Err(unsafe_path_error(format!(
                    "directory entry '{name}' is not a regular package part"
                )));
            }
            if let Some(mode) = file.unix_mode() {
                let file_type = mode & 0o170000;
                if file_type != 0 && file_type != 0o100000 {
                    return Err(unsafe_path_error(format!(
                        "special or symbolic ZIP entry '{name}' is not allowed"
                    )));
                }
            }
            if !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            ) {
                return Err(RetargetError::new(
                    IssueCode::InvalidArchive,
                    format!("unsupported ZIP compression for part '{name}'"),
                    "Re-export the project using Stored or Deflate compression.",
                ));
            }
            if file.size() > limits.max_part_bytes {
                return Err(limit_error(format!("part '{name}' exceeds 512 MiB")));
            }
            total_uncompressed = total_uncompressed
                .checked_add(file.size())
                .ok_or_else(|| limit_error("archive size overflowed"))?;
            if total_uncompressed > limits.max_uncompressed_bytes {
                return Err(limit_error("archive expands beyond 2 GiB"));
            }
            let key = name.to_ascii_lowercase();
            if !names.insert(key.clone()) {
                return Err(unsafe_path_error(format!(
                    "case-equivalent duplicate package part '{name}'"
                )));
            }
            let capacity = usize::try_from(file.size())
                .map_err(|_| limit_error(format!("part '{name}' is too large")))?;
            let mut bytes = Vec::with_capacity(capacity);
            file.by_ref()
                .take(limits.max_part_bytes.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(RetargetError::io)?;
            if bytes.len() as u64 != file.size() {
                return Err(RetargetError::new(
                    IssueCode::InvalidArchive,
                    format!("declared and streamed size disagree for part '{name}'"),
                    "Re-export the source project.",
                ));
            }
            parts.insert(key, ArchivePart { name, bytes });
        }
        let package = Self {
            parts,
            compressed_size: metadata.len(),
        };
        package.validate_relationships()?;
        Ok(package)
    }

    pub(crate) fn get(&self, name: &str) -> Option<&ArchivePart> {
        self.parts.get(&name.to_ascii_lowercase())
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub(crate) fn has_single_root_model_relationship(&self) -> Result<bool, RetargetError> {
        let Some(root_rels) = self.get("_rels/.rels") else {
            return Ok(false);
        };
        let mut reader = Reader::from_reader(root_rels.bytes.as_slice());
        reader.config_mut().trim_text(true);
        let mut buffer = Vec::new();
        let mut count = 0usize;
        loop {
            match reader.read_event_into(&mut buffer).map_err(xml_error)? {
                Event::Start(element) | Event::Empty(element)
                    if element.name().local_name().as_ref() == b"Relationship" =>
                {
                    if attr_value(&reader, &element, b"Type")?.as_deref()
                        == Some(MODEL_RELATIONSHIP_TYPE)
                    {
                        count += 1;
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
        Ok(count == 1)
    }

    pub(crate) fn stale_plan(&self) -> StalePartPlan {
        let mut plan = StalePartPlan::default();
        for part in self.parts.values() {
            let lower = part.name.to_ascii_lowercase();
            let stale_slice = lower == "metadata/slice_info.config"
                || (lower.starts_with("metadata/plate_")
                    && (lower.ends_with(".gcode") || lower.ends_with(".gcode.md5")));
            let custom = lower == "metadata/custom_gcode_per_layer.xml";
            let signature = lower.starts_with("_xmlsignatures/") || lower == "_xmlsignatures";
            if stale_slice || custom || signature {
                plan.removed.insert(lower);
                if stale_slice {
                    plan.stale_slice_count += 1;
                }
                if custom {
                    plan.custom_gcode_count += 1;
                }
                if signature {
                    plan.signature_count += 1;
                }
            }
        }
        plan
    }

    fn validate_relationships(&self) -> Result<(), RetargetError> {
        for part in self.parts.values() {
            if !part.name.to_ascii_lowercase().ends_with(".rels") {
                continue;
            }
            if part.bytes.len() as u64 > MAX_RELATIONSHIP_BYTES {
                return Err(limit_error(format!(
                    "relationship part '{}' exceeds 16 MiB",
                    part.name
                )));
            }
            let source = relationship_source(&part.name)?;
            let mut reader = Reader::from_reader(part.bytes.as_slice());
            reader.config_mut().trim_text(true);
            let mut buffer = Vec::new();
            loop {
                match reader.read_event_into(&mut buffer).map_err(xml_error)? {
                    Event::Start(element) | Event::Empty(element)
                        if element.name().local_name().as_ref() == b"Relationship" =>
                    {
                        validate_relationship_element(&reader, &element, &source, &self.parts)?;
                    }
                    Event::Eof => break,
                    _ => {}
                }
                buffer.clear();
            }
        }
        Ok(())
    }

    pub(crate) fn control_parts_match(
        &self,
        output: &Self,
        stale: &StalePartPlan,
    ) -> Result<bool, RetargetError> {
        for part in self.parts.values() {
            let lower = part.name.to_ascii_lowercase();
            if stale.removed.contains(&lower) {
                continue;
            }
            let expected = if lower.ends_with(".rels") {
                Some(repair_relationships(
                    &part.name,
                    &part.bytes,
                    &stale.removed,
                )?)
            } else if lower == CONTENT_TYPES_PART.to_ascii_lowercase() {
                Some(repair_content_types(&part.bytes, &stale.removed)?)
            } else {
                None
            };
            if let Some(expected) = expected {
                let Some(candidate) = output.get(&part.name) else {
                    return Ok(false);
                };
                if candidate.bytes != expected {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    pub(crate) fn write_transformed(
        &self,
        output: &Path,
        settings_json: &[u8],
        model_settings_xml: &[u8],
        stale: &StalePartPlan,
    ) -> Result<WriteSummary, RetargetError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    RetargetError::new(
                        IssueCode::OutputPathConflict,
                        "output path already exists",
                        "Choose a new temporary .3mf output path.",
                    )
                } else {
                    RetargetError::io(error)
                }
            })?;
        self.write_zip(file, settings_json, model_settings_xml, stale)
    }

    fn write_zip(
        &self,
        file: File,
        settings_json: &[u8],
        model_settings_xml: &[u8],
        stale: &StalePartPlan,
    ) -> Result<WriteSummary, RetargetError> {
        let mut parts: Vec<_> = self
            .parts
            .values()
            .filter(|part| !stale.removed.contains(&part.name.to_ascii_lowercase()))
            .collect();
        parts.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        });
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6))
            .last_modified_time(DateTime::default())
            .unix_permissions(0o644);
        let mut writer = ZipWriter::new(file);
        for part in &parts {
            let lower = part.name.to_ascii_lowercase();
            let bytes = if lower == PROJECT_SETTINGS_PART.to_ascii_lowercase() {
                settings_json.to_vec()
            } else if lower == MODEL_SETTINGS_PART.to_ascii_lowercase() {
                model_settings_xml.to_vec()
            } else if lower.ends_with(".rels") {
                repair_relationships(&part.name, &part.bytes, &stale.removed)?
            } else if lower == CONTENT_TYPES_PART.to_ascii_lowercase() {
                repair_content_types(&part.bytes, &stale.removed)?
            } else {
                part.bytes.clone()
            };
            writer.start_file(&part.name, options).map_err(zip_error)?;
            writer.write_all(&bytes).map_err(RetargetError::io)?;
        }
        writer.finish().map_err(zip_error)?;
        Ok(WriteSummary {
            removed_part_count: stale.removed.len(),
            preserved_part_count: parts.len(),
        })
    }
}

fn validate_part_name(name: &str) -> Result<(), RetargetError> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.ends_with('/')
        || name.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || segment.contains('\0')
                || segment.contains(':')
        })
    {
        return Err(unsafe_path_error(format!(
            "unsafe package part name '{name}'"
        )));
    }
    Ok(())
}

fn relationship_source(rels_name: &str) -> Result<String, RetargetError> {
    let lower = rels_name.to_ascii_lowercase();
    if lower == "_rels/.rels" {
        return Ok(String::new());
    }
    let (directory, file) = rels_name
        .rsplit_once('/')
        .ok_or_else(|| unsafe_path_error(format!("invalid relationship part '{rels_name}'")))?;
    let parent = directory
        .strip_suffix("/_rels")
        .ok_or_else(|| unsafe_path_error(format!("invalid relationship part '{rels_name}'")))?;
    let source_file = file
        .strip_suffix(".rels")
        .ok_or_else(|| unsafe_path_error(format!("invalid relationship part '{rels_name}'")))?;
    Ok(if parent.is_empty() {
        source_file.to_string()
    } else {
        format!("{parent}/{source_file}")
    })
}

fn attr_value(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    name: &[u8],
) -> Result<Option<String>, RetargetError> {
    let mut value = None;
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| {
            RetargetError::new(
                IssueCode::InvalidArchive,
                format!("invalid relationship attribute: {error}"),
                "Re-export the source project.",
            )
        })?;
        let attribute_name = attribute.key.as_ref();
        let qualified = attribute_name.len() > name.len()
            && attribute_name.ends_with(name)
            && attribute_name[attribute_name.len() - name.len() - 1] == b':';
        if qualified {
            return Err(RetargetError::new(
                IssueCode::InvalidArchive,
                format!(
                    "OPC attribute '{}' must be unqualified",
                    String::from_utf8_lossy(name)
                ),
                "Re-export the source project.",
            ));
        }
        if attribute_name == name {
            if value.is_some() {
                return Err(RetargetError::new(
                    IssueCode::InvalidArchive,
                    format!(
                        "OPC element declares duplicate '{}' attributes",
                        String::from_utf8_lossy(name)
                    ),
                    "Re-export the source project.",
                ));
            }
            value = Some(
                attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(xml_error)?
                    .into_owned(),
            );
        }
    }
    Ok(value)
}

fn validate_relationship_element(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    source: &str,
    parts: &BTreeMap<String, ArchivePart>,
) -> Result<(), RetargetError> {
    if let Some(mode) = attr_value(reader, element, b"TargetMode")? {
        if mode.eq_ignore_ascii_case("external") {
            return Err(RetargetError::new(
                IssueCode::ExternalRelationship,
                "external OPC relationships are not allowed",
                "Remove external relationships and re-export the project.",
            ));
        }
        if !mode.eq_ignore_ascii_case("internal") {
            return Err(RetargetError::new(
                IssueCode::InvalidArchive,
                format!("invalid OPC relationship TargetMode '{mode}'"),
                "Re-export a valid OPC/3MF project.",
            ));
        }
    }
    let target = attr_value(reader, element, b"Target")?.ok_or_else(|| {
        RetargetError::new(
            IssueCode::InvalidArchive,
            "OPC relationship is missing Target",
            "Re-export the source project.",
        )
    })?;
    let resolved = threemf::resolve_relationship_target(source, &target).map_err(|error| {
        unsafe_path_error(format!("unsafe relationship target '{target}': {error}"))
    })?;
    if !parts.contains_key(&resolved.to_ascii_lowercase()) {
        return Err(RetargetError::new(
            IssueCode::InvalidArchive,
            format!("relationship target '/{resolved}' is missing"),
            "Re-export a complete project without dangling relationships.",
        ));
    }
    Ok(())
}

fn repair_relationships(
    rels_name: &str,
    xml: &[u8],
    removed: &HashSet<String>,
) -> Result<Vec<u8>, RetargetError> {
    let source = relationship_source(rels_name)?;
    let mut reader = Reader::from_reader(xml);
    let mut output = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut skip_depth = 0usize;
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(xml_error)?;
        if skip_depth > 0 {
            match event {
                Event::Start(_) => skip_depth += 1,
                Event::End(_) => skip_depth -= 1,
                Event::Eof => {
                    return Err(RetargetError::new(
                        IssueCode::InvalidArchive,
                        "unterminated relationship element",
                        "Re-export the source project.",
                    ))
                }
                _ => {}
            }
            buffer.clear();
            continue;
        }
        match &event {
            Event::Start(element) if element.name().local_name().as_ref() == b"Relationship" => {
                let target = attr_value(&reader, element, b"Target")?.ok_or_else(|| {
                    RetargetError::new(
                        IssueCode::InvalidArchive,
                        "OPC relationship is missing Target",
                        "Re-export the source project.",
                    )
                })?;
                let resolved =
                    threemf::resolve_relationship_target(&source, &target).map_err(|error| {
                        unsafe_path_error(format!("unsafe relationship target: {error}"))
                    })?;
                if removed.contains(&resolved.to_ascii_lowercase()) {
                    skip_depth = 1;
                } else {
                    output.write_event(event.into_owned()).map_err(xml_error)?;
                }
            }
            Event::Empty(element) if element.name().local_name().as_ref() == b"Relationship" => {
                let target = attr_value(&reader, element, b"Target")?.ok_or_else(|| {
                    RetargetError::new(
                        IssueCode::InvalidArchive,
                        "OPC relationship is missing Target",
                        "Re-export the source project.",
                    )
                })?;
                let resolved =
                    threemf::resolve_relationship_target(&source, &target).map_err(|error| {
                        unsafe_path_error(format!("unsafe relationship target: {error}"))
                    })?;
                if !removed.contains(&resolved.to_ascii_lowercase()) {
                    output.write_event(event.into_owned()).map_err(xml_error)?;
                }
            }
            Event::Eof => break,
            _ => output.write_event(event.into_owned()).map_err(xml_error)?,
        }
        buffer.clear();
    }
    Ok(output.into_inner())
}

fn repair_content_types(xml: &[u8], removed: &HashSet<String>) -> Result<Vec<u8>, RetargetError> {
    if xml.len() as u64 > MAX_RELATIONSHIP_BYTES {
        return Err(limit_error("[Content_Types].xml exceeds 16 MiB"));
    }
    let mut reader = Reader::from_reader(xml);
    let mut output = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut skip_depth = 0usize;
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(xml_error)?;
        if skip_depth > 0 {
            match &event {
                Event::Start(_) => skip_depth += 1,
                Event::End(_) => skip_depth -= 1,
                Event::Eof => {
                    return Err(RetargetError::new(
                        IssueCode::InvalidArchive,
                        "unterminated content type Override",
                        "Re-export the source project.",
                    ))
                }
                _ => {}
            }
            buffer.clear();
            continue;
        }
        match &event {
            Event::Empty(element) if element.name().local_name().as_ref() == b"Override" => {
                let part_name = attr_value(&reader, element, b"PartName")?
                    .unwrap_or_default()
                    .trim_start_matches('/')
                    .to_ascii_lowercase();
                if !removed.contains(&part_name) {
                    output.write_event(event.into_owned()).map_err(xml_error)?;
                }
            }
            Event::Start(element) if element.name().local_name().as_ref() == b"Override" => {
                let part_name = attr_value(&reader, element, b"PartName")?
                    .unwrap_or_default()
                    .trim_start_matches('/')
                    .to_ascii_lowercase();
                if removed.contains(&part_name) {
                    skip_depth = 1;
                } else {
                    output.write_event(event.into_owned()).map_err(xml_error)?;
                }
            }
            Event::Eof => break,
            _ => output.write_event(event.into_owned()).map_err(xml_error)?,
        }
        buffer.clear();
    }
    Ok(output.into_inner())
}

fn zip_error(error: zip::result::ZipError) -> RetargetError {
    RetargetError::new(
        IssueCode::InvalidArchive,
        format!("invalid ZIP archive: {error}"),
        "Re-export a complete, unencrypted editable 3MF project.",
    )
}

fn xml_error(error: quick_xml::Error) -> RetargetError {
    RetargetError::new(
        IssueCode::InvalidArchive,
        format!("invalid OPC XML: {error}"),
        "Re-export a complete editable 3MF project.",
    )
}

fn limit_error(message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::ArchiveLimitExceeded,
        message,
        "Reduce project size or complexity and export again.",
    )
}

fn unsafe_path_error(message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::UnsafeArchivePath,
        message,
        "Re-export a package with normalized relative part paths.",
    )
}
