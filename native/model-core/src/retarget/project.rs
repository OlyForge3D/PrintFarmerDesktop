use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value;

use super::archive::{ArchivePackage, MODEL_SETTINGS_PART, PROJECT_SETTINGS_PART};
use super::guardrails;
use super::profile::SettingValue;
use super::report::{IssueCode, RetargetIssue};
use super::{RetargetError, RetargetLimits};
use crate::threemf::{self, ThreeMfError, ThreeMfMesh};
use crate::vendor::{self, Slicer};

#[derive(Debug)]
pub(crate) struct ProjectInspection {
    pub settings: BTreeMap<String, SettingValue>,
    pub materials: Vec<String>,
    pub colors: Vec<String>,
    pub layer_height: Option<f64>,
    pub machine_id: Option<String>,
    pub process_id: Option<String>,
    pub producer: String,
    pub mesh: ThreeMfMesh,
    pub plate_count: usize,
    pub has_paint_metadata: bool,
    pub model_settings: Vec<u8>,
    pub blockers: Vec<RetargetIssue>,
    pub warnings: Vec<RetargetIssue>,
}

impl ProjectInspection {
    pub(crate) fn inspect_snapshot(
        path: &Path,
        archive: &ArchivePackage,
        limits: &RetargetLimits,
        snapshot: &[u8],
    ) -> Result<Self, RetargetError> {
        if !archive.has_single_root_model_relationship()? {
            return Err(RetargetError::new(
                IssueCode::MissingModel,
                "package must declare exactly one root 3D model relationship",
                "Re-export a complete 3MF with one root model relationship.",
            ));
        }
        if !archive.has("[Content_Types].xml") {
            return Err(RetargetError::new(
                IssueCode::InvalidArchive,
                "editable 3MF package is missing [Content_Types].xml",
                "Re-export a complete OPC/3MF project.",
            ));
        }
        let mesh = threemf::parse_bytes(snapshot).map_err(map_threemf_error)?;
        let metadata = vendor::extract_bytes(snapshot).map_err(map_threemf_error)?;
        let application = metadata.core.application.clone();
        let mut blockers = Vec::new();
        let mut warnings = Vec::new();

        if mesh.build_item_count == 0 || mesh.triangle_count() == 0 {
            blockers.push(RetargetIssue::blocker(
                IssueCode::EmptyBuild,
                "Empty build",
                "The project has no renderable build geometry.",
                "Add at least one printable object and export an editable 3MF.",
            ));
        }

        let lower_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_gcode_3mf = lower_name.ends_with(".gcode.3mf");
        let has_gcode = archive.parts.values().any(|part| {
            let lower = part.name.to_ascii_lowercase();
            lower.starts_with("metadata/plate_") && lower.ends_with(".gcode")
        });
        let has_project = archive.has(PROJECT_SETTINGS_PART);
        let has_model = archive.has(MODEL_SETTINGS_PART);
        let has_prusa_parts = archive.has("Metadata/Slic3r_PE.config")
            || archive.has("Metadata/Slic3r_PE_model.config");
        let has_cura_parts = archive
            .parts
            .values()
            .any(|part| part.name.to_ascii_lowercase().contains("cura"));

        if is_gcode_3mf {
            blockers.push(RetargetIssue::blocker(
                IssueCode::PreSlicedOnly,
                "G-code 3MF is not editable",
                "Files ending in .gcode.3mf are treated as executable print jobs.",
                "Download or export the editable project .3mf instead.",
            ));
        } else if matches!(metadata.slicer, Slicer::PrusaSlicer | Slicer::SuperSlicer)
            || has_prusa_parts
        {
            blockers.push(RetargetIssue::blocker(
                IssueCode::UnsupportedPrusa,
                "Prusa-family project is unsupported",
                "Prusa/SuperSlicer project settings cannot be safely translated.",
                "Open the source in OrcaSlicer or Bambu Studio and export an editable project.",
            ));
        } else if metadata.slicer == Slicer::Cura || has_cura_parts {
            blockers.push(RetargetIssue::blocker(
                IssueCode::UnsupportedCura,
                "Cura project is unsupported",
                "Cura project settings cannot be safely translated.",
                "Export a complete editable Orca/Bambu-family project.",
            ));
        }

        if !has_project && !has_model {
            blockers.push(RetargetIssue::blocker(
                if has_gcode {
                    IssueCode::PreSlicedOnly
                } else {
                    IssueCode::GeometryOnly
                },
                if has_gcode {
                    "Pre-sliced project has no editable settings"
                } else {
                    "Geometry-only 3MF"
                },
                "The archive does not contain the Orca/Bambu editable project configuration.",
                "Export the complete project, not model geometry or a sliced print job.",
            ));
        } else {
            if !has_project {
                blockers.push(RetargetIssue::blocker(
                    IssueCode::MissingProjectSettings,
                    "Missing project settings",
                    format!("The archive has no {PROJECT_SETTINGS_PART}."),
                    "Export a complete editable Orca/Bambu project.",
                ));
            }
            if !has_model {
                blockers.push(RetargetIssue::blocker(
                    IssueCode::MissingModelSettings,
                    "Missing model settings",
                    format!("The archive has no {MODEL_SETTINGS_PART}."),
                    "Export a complete editable Orca/Bambu project.",
                ));
            }
        }

        let mut settings = BTreeMap::new();
        let mut materials = Vec::new();
        let mut colors = Vec::new();
        let mut layer_height = None;
        let mut machine_id = None;
        let mut process_id = None;
        if let Some(part) = archive.get(PROJECT_SETTINGS_PART) {
            if part.bytes.len() as u64 > limits.max_project_settings_bytes {
                blockers.push(RetargetIssue::blocker(
                    IssueCode::ArchiveLimitExceeded,
                    "Project settings are too large",
                    "project_settings.config exceeds 16 MiB.",
                    "Reduce the project configuration and export again.",
                ));
            } else {
                match parse_project_settings(&part.bytes, limits.max_settings) {
                    Ok(parsed) => {
                        settings = parsed;
                        machine_id = settings
                            .get("printer_settings_id")
                            .or_else(|| settings.get("printer_model"))
                            .and_then(SettingValue::first)
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_string);
                        process_id = settings
                            .get("print_settings_id")
                            .and_then(SettingValue::first)
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_string);
                        layer_height = settings
                            .get("layer_height")
                            .and_then(SettingValue::finite_positive);
                        materials = settings
                            .get("filament_type")
                            .and_then(|value| match value {
                                SettingValue::List(values) => Some(values.clone()),
                                SettingValue::Scalar(_) => None,
                            })
                            .unwrap_or_default();
                        colors = settings
                            .get("filament_colour")
                            .and_then(|value| match value {
                                SettingValue::List(values) => Some(values.clone()),
                                SettingValue::Scalar(_) => None,
                            })
                            .unwrap_or_default();
                        validate_required_settings(
                            &settings,
                            &materials,
                            &colors,
                            layer_height,
                            &mut blockers,
                        );
                    }
                    Err(issue) => blockers.push(issue),
                }
            }
        }

        let mut plate_count = 1usize;
        let mut has_paint_metadata = false;
        let mut model_settings = Vec::new();
        if let Some(part) = archive.get(MODEL_SETTINGS_PART) {
            model_settings = part.bytes.clone();
            if part.bytes.len() as u64 > limits.max_model_settings_bytes {
                blockers.push(RetargetIssue::blocker(
                    IssueCode::ArchiveLimitExceeded,
                    "Model settings are too large",
                    "model_settings.config exceeds 16 MiB.",
                    "Reduce the project configuration and export again.",
                ));
            } else {
                match observe_model_settings(&part.bytes, &mesh, materials.len(), limits.max_plates)
                {
                    Ok(observation) => {
                        plate_count = observation.plate_count.max(1);
                        has_paint_metadata = observation.has_paint_metadata;
                    }
                    Err(issue) => blockers.push(issue),
                }
            }
        }
        has_paint_metadata |= archive.parts.values().any(|part| {
            let lower_name = part.name.to_ascii_lowercase();
            if !(lower_name.ends_with(".model")
                || lower_name == MODEL_SETTINGS_PART.to_ascii_lowercase())
            {
                return false;
            }
            let lower = String::from_utf8_lossy(&part.bytes).to_ascii_lowercase();
            lower.contains("paint") || lower.contains("mmu_segmentation") || lower.contains("seam")
        });

        let structurally_complete =
            has_project && has_model && !has_fatal_structure_blocker(&blockers);
        if blockers
            .iter()
            .all(|issue| issue.code != IssueCode::UnsupportedPrusa)
            && blockers
                .iter()
                .all(|issue| issue.code != IssueCode::UnsupportedCura)
        {
            match metadata.slicer {
                Slicer::OrcaSlicer | Slicer::BambuStudio => {}
                Slicer::Unknown if structurally_complete => warnings.push(RetargetIssue::warning(
                    IssueCode::UnknownOrcaFamilyProducer,
                    "Unknown Orca-family producer",
                    application.as_deref().map_or(
                        "The complete Orca/Bambu project structure has no recognized producer.",
                        |_| "The complete Orca/Bambu project structure names an unrecognized producer.",
                    ),
                    "Review the preflight changes before building.",
                )),
                Slicer::Unknown if application.is_some() => blockers.push(
                    RetargetIssue::blocker(
                        IssueCode::UnsupportedSlicer,
                        "Unsupported slicer",
                        format!(
                            "Producer '{}' is not supported and the project signature is incomplete.",
                            application.as_deref().unwrap_or_default()
                        ),
                        "Export a complete editable Orca/Bambu project.",
                    ),
                ),
                _ => {}
            }
        }

        Ok(Self {
            settings,
            materials,
            colors,
            layer_height,
            machine_id,
            process_id,
            producer: application.unwrap_or_else(|| metadata.slicer.as_str().to_string()),
            mesh,
            plate_count,
            has_paint_metadata,
            model_settings,
            blockers,
            warnings,
        })
    }
}

#[allow(clippy::result_large_err)]
fn parse_project_settings(
    bytes: &[u8],
    max_settings: usize,
) -> Result<BTreeMap<String, SettingValue>, RetargetIssue> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        RetargetIssue::blocker(
            IssueCode::InvalidProjectSettings,
            "Invalid project settings",
            format!("project_settings.config is not valid UTF-8 JSON: {error}"),
            "Re-export the editable project.",
        )
        .with_part(PROJECT_SETTINGS_PART)
    })?;
    let object = value.as_object().ok_or_else(|| {
        RetargetIssue::blocker(
            IssueCode::InvalidProjectSettings,
            "Invalid project settings",
            "project_settings.config must contain a JSON object.",
            "Re-export the editable project.",
        )
        .with_part(PROJECT_SETTINGS_PART)
    })?;
    if object.len() > max_settings {
        return Err(RetargetIssue::blocker(
            IssueCode::ArchiveLimitExceeded,
            "Too many project settings",
            format!("The project has more than {max_settings} settings."),
            "Reduce project configuration complexity.",
        ));
    }
    object
        .iter()
        .map(|(key, value)| {
            normalize_source_value(value)
                .map(|value| (key.clone(), value))
                .map_err(|message| {
                    RetargetIssue::blocker(
                        IssueCode::InvalidProjectSettings,
                        "Invalid project setting value",
                        format!("Setting '{key}' {message}."),
                        "Remove unsupported structured values and export again.",
                    )
                    .with_setting(key)
                })
        })
        .collect()
}

fn normalize_source_value(value: &Value) -> Result<SettingValue, &'static str> {
    match value {
        Value::String(value) => Ok(SettingValue::Scalar(value.clone())),
        Value::Number(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|_| SettingValue::Scalar(value.to_string()))
            .ok_or("contains a non-finite number"),
        Value::Bool(value) => Ok(SettingValue::Scalar(
            if *value { "1" } else { "0" }.to_string(),
        )),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                Value::Number(value) => value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .map(|_| value.to_string())
                    .ok_or("contains a non-finite number"),
                Value::Bool(value) => Ok(if *value { "1" } else { "0" }.to_string()),
                _ => Err("contains a null, object, or nested array"),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(SettingValue::List),
        Value::Null | Value::Object(_) => Err("must be a scalar or array of scalar primitives"),
    }
}

fn validate_required_settings(
    settings: &BTreeMap<String, SettingValue>,
    materials: &[String],
    colors: &[String],
    layer_height: Option<f64>,
    blockers: &mut Vec<RetargetIssue>,
) {
    if settings
        .get("printer_model")
        .or_else(|| settings.get("printer_settings_id"))
        .and_then(SettingValue::first)
        .is_none_or(|value| value.trim().is_empty())
    {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::IncompleteProject,
                "Missing source machine identity",
                "Project settings do not identify the source printer.",
                "Select a printer preset and export the complete editable project.",
            )
            .with_setting("printer_settings_id"),
        );
    }
    if layer_height.is_none() {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::IncompleteProject,
                "Invalid layer height",
                "layer_height must be a finite positive decimal.",
                "Choose a positive layer height and export again.",
            )
            .with_setting("layer_height"),
        );
    }
    if materials.is_empty() {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::IncompleteProject,
                "Missing filament slots",
                "filament_type must be a non-empty string array.",
                "Assign one to four source materials and export again.",
            )
            .with_setting("filament_type"),
        );
    } else if materials.len() > 4 {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::TooManyFilamentSlots,
                "Too many filament slots",
                "Snapmaker U1 supports at most four material slots.",
                "Reduce the project to four filament slots.",
            )
            .with_setting("filament_type"),
        );
    }
    if materials.iter().any(|material| material.trim().is_empty()) {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::IncompleteProject,
                "Empty filament material",
                "Every filament_type slot must be non-empty.",
                "Assign a supported material to every slot.",
            )
            .with_setting("filament_type"),
        );
    }
    if !colors.is_empty() && colors.len() != materials.len() {
        blockers.push(
            RetargetIssue::blocker(
                IssueCode::IncompleteProject,
                "Filament color count mismatch",
                "filament_colour must be empty or match filament_type slot count.",
                "Assign one color per filament slot and export again.",
            )
            .with_setting("filament_colour"),
        );
    }
}

#[derive(Debug)]
struct ModelObservation {
    plate_count: usize,
    has_paint_metadata: bool,
}

#[allow(clippy::result_large_err)]
fn observe_model_settings(
    bytes: &[u8],
    mesh: &ThreeMfMesh,
    filament_slots: usize,
    max_plates: usize,
) -> Result<ModelObservation, RetargetIssue> {
    let text = std::str::from_utf8(bytes).map_err(|error| {
        invalid_model_settings(format!("model_settings.config is not UTF-8: {error}"))
    })?;
    let retained_ids: HashSet<u32> = mesh
        .objects
        .iter()
        .filter_map(|object| {
            object
                .source_id
                .rsplit_once('#')?
                .1
                .strip_prefix("object-")?
                .parse()
                .ok()
        })
        .collect();
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut records = 0usize;
    let mut plate_count = 0usize;
    let mut object_record_ids = HashSet::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| invalid_model_settings(format!("invalid XML: {error}")))?;
        match event {
            Event::Start(element) => {
                let name = element.name();
                let local = name.as_ref();
                if depth == 0 {
                    if root_seen {
                        return Err(invalid_model_settings(
                            "model_settings.config must contain exactly one root element",
                        ));
                    }
                    if local != b"config" {
                        return Err(invalid_model_settings(
                            "model_settings.config root must be <config>",
                        ));
                    }
                    root_seen = true;
                }
                if matches!(local, b"object" | b"part" | b"assembly" | b"assemble_item") {
                    records += 1;
                }
                if local == b"plate" {
                    plate_count += 1;
                    if plate_count > max_plates {
                        return Err(RetargetIssue::blocker(
                            IssueCode::ArchiveLimitExceeded,
                            "Too many plates",
                            format!("model settings exceed {max_plates} plates."),
                            "Reduce the project plate count.",
                        ));
                    }
                }
                if matches!(local, b"object" | b"part" | b"assemble_item") {
                    validate_model_record_attributes(
                        &reader,
                        &element,
                        &retained_ids,
                        filament_slots,
                        local != b"part",
                    )?;
                }
                if local == b"metadata" {
                    validate_model_metadata(&reader, &element, &retained_ids, filament_slots)?;
                }
                if local == b"object" {
                    validate_unique_object_record(
                        &reader,
                        &element,
                        &retained_ids,
                        &mut object_record_ids,
                    )?;
                }
                depth = depth.saturating_add(1);
            }
            Event::Empty(element) => {
                let name = element.name();
                let local = name.as_ref();
                if depth == 0 {
                    if root_seen {
                        return Err(invalid_model_settings(
                            "model_settings.config must contain exactly one root element",
                        ));
                    }
                    if local != b"config" {
                        return Err(invalid_model_settings(
                            "model_settings.config root must be <config>",
                        ));
                    }
                    root_seen = true;
                    root_closed = true;
                }
                if matches!(local, b"object" | b"part" | b"assembly" | b"assemble_item") {
                    records += 1;
                }
                if local == b"plate" {
                    plate_count += 1;
                    if plate_count > max_plates {
                        return Err(RetargetIssue::blocker(
                            IssueCode::ArchiveLimitExceeded,
                            "Too many plates",
                            format!("model settings exceed {max_plates} plates."),
                            "Reduce the project plate count.",
                        ));
                    }
                }
                if matches!(local, b"object" | b"part" | b"assemble_item") {
                    validate_model_record_attributes(
                        &reader,
                        &element,
                        &retained_ids,
                        filament_slots,
                        local != b"part",
                    )?;
                }
                if local == b"metadata" {
                    validate_model_metadata(&reader, &element, &retained_ids, filament_slots)?;
                }
                if local == b"object" {
                    validate_unique_object_record(
                        &reader,
                        &element,
                        &retained_ids,
                        &mut object_record_ids,
                    )?;
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Err(invalid_model_settings(
                        "model_settings.config has an unexpected closing element",
                    ));
                }
                depth -= 1;
                if depth == 0 {
                    root_closed = true;
                }
            }
            Event::Eof => {
                if depth != 0 || !root_closed {
                    return Err(invalid_model_settings(
                        "model_settings.config has an unclosed element",
                    ));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    if !root_seen || !root_closed || records == 0 || object_record_ids.is_empty() {
        return Err(invalid_model_settings(
            "model settings must contain at least one valid object record",
        ));
    }

    #[allow(clippy::result_large_err)]
    fn validate_model_record_attributes(
        reader: &Reader<&[u8]>,
        element: &quick_xml::events::BytesStart<'_>,
        retained_ids: &HashSet<u32>,
        filament_slots: usize,
        validate_id_reference: bool,
    ) -> Result<(), RetargetIssue> {
        let mut object_reference_seen = false;
        let mut extruder_seen = false;
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|error| {
                invalid_model_settings(format!("invalid XML attribute: {error}"))
            })?;
            let name = attribute.key.as_ref();
            if [b"id".as_slice(), b"object_id", b"objectid", b"extruder"]
                .iter()
                .any(|semantic| is_qualified_attribute(name, semantic))
            {
                return Err(invalid_model_settings(
                    "model record semantic attributes must be unqualified",
                ));
            }
            if matches!(name, b"object_id" | b"objectid")
                || (validate_id_reference && name == b"id")
            {
                if object_reference_seen {
                    return Err(invalid_model_settings(
                        "model record declares conflicting object references",
                    ));
                }
                object_reference_seen = true;
                let value = attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| {
                        invalid_model_settings(format!("invalid object id attribute: {error}"))
                    })?;
                let id = value.parse::<u32>().map_err(|_| {
                    invalid_model_settings(format!(
                        "object id '{value}' is not an unsigned integer"
                    ))
                })?;
                if !retained_ids.contains(&id) {
                    return Err(invalid_model_settings(format!(
                        "model settings reference missing object id {id}"
                    )));
                }
            }
            if name == b"extruder" {
                if extruder_seen {
                    return Err(invalid_model_settings(
                        "model record declares duplicate extruder attributes",
                    ));
                }
                extruder_seen = true;
                let value = attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| {
                        invalid_model_settings(format!("invalid extruder attribute: {error}"))
                    })?;
                validate_extruder_slot(&value, filament_slots)?;
            }
        }
        Ok(())
    }

    fn is_qualified_attribute(name: &[u8], semantic: &[u8]) -> bool {
        name.len() > semantic.len()
            && name.ends_with(semantic)
            && name[name.len() - semantic.len() - 1] == b':'
    }

    #[allow(clippy::result_large_err)]
    fn validate_unique_object_record(
        reader: &Reader<&[u8]>,
        element: &quick_xml::events::BytesStart<'_>,
        retained_ids: &HashSet<u32>,
        object_record_ids: &mut HashSet<u32>,
    ) -> Result<(), RetargetIssue> {
        let mut id = None;
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|error| {
                invalid_model_settings(format!("invalid XML attribute: {error}"))
            })?;
            let name = attribute.key.as_ref();
            if name.ends_with(b":id") {
                return Err(invalid_model_settings(
                    "object id attribute must be unqualified",
                ));
            }
            if name != b"id" {
                continue;
            }
            if id.is_some() {
                return Err(invalid_model_settings(
                    "object record declares more than one id",
                ));
            }
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .map_err(|error| {
                    invalid_model_settings(format!("invalid object id attribute: {error}"))
                })?;
            id = Some(value.parse::<u32>().map_err(|_| {
                invalid_model_settings(format!("object id '{value}' is not an unsigned integer"))
            })?);
        }
        let id = id.ok_or_else(|| invalid_model_settings("object record is missing its id"))?;
        if !retained_ids.contains(&id) {
            return Err(invalid_model_settings(format!(
                "model settings reference missing object id {id}"
            )));
        }
        if !object_record_ids.insert(id) {
            return Err(invalid_model_settings(format!(
                "model settings contain duplicate object id {id}"
            )));
        }
        Ok(())
    }

    #[allow(clippy::result_large_err)]
    fn validate_model_metadata(
        reader: &Reader<&[u8]>,
        element: &quick_xml::events::BytesStart<'_>,
        retained_ids: &HashSet<u32>,
        filament_slots: usize,
    ) -> Result<(), RetargetIssue> {
        let mut key = None;
        let mut value = None;
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|error| {
                invalid_model_settings(format!("invalid XML attribute: {error}"))
            })?;
            let name = attribute.key.as_ref();
            if name.ends_with(b":key") || name.ends_with(b":value") {
                return Err(invalid_model_settings(
                    "metadata key and value attributes must be unqualified",
                ));
            }
            if matches!(name, b"key" | b"value") {
                let decoded = attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| {
                        invalid_model_settings(format!("invalid metadata attribute: {error}"))
                    })?
                    .into_owned();
                if name == b"key" {
                    if key.is_some() {
                        return Err(invalid_model_settings(
                            "metadata declares duplicate key attributes",
                        ));
                    }
                    key = Some(decoded);
                } else {
                    if value.is_some() {
                        return Err(invalid_model_settings(
                            "metadata declares duplicate value attributes",
                        ));
                    }
                    value = Some(decoded);
                }
            }
        }
        match key.as_deref() {
            Some("extruder") => {
                let value = value.ok_or_else(|| {
                    invalid_model_settings("extruder metadata is missing its value")
                })?;
                validate_extruder_slot(&value, filament_slots)
            }
            Some("object_id" | "objectid") => {
                let value = value.ok_or_else(|| {
                    invalid_model_settings("object-id metadata is missing its value")
                })?;
                let id = value.parse::<u32>().map_err(|_| {
                    invalid_model_settings(format!(
                        "object id '{value}' is not an unsigned integer"
                    ))
                })?;
                if !retained_ids.contains(&id) {
                    return Err(invalid_model_settings(format!(
                        "model settings reference missing object id {id}"
                    )));
                }
                Ok(())
            }
            Some(key) if guardrails::is_motion_key(key) => {
                let value = value.ok_or_else(|| {
                    invalid_model_settings(format!("motion override '{key}' is missing its value"))
                })?;
                guardrails::validate_source_override(key, &value).map_err(|error| {
                    RetargetIssue::blocker(
                        error.code,
                        "Unsafe object motion override",
                        error.message,
                        error.action,
                    )
                    .with_setting(key)
                })
            }
            _ => Ok(()),
        }
    }

    #[allow(clippy::result_large_err)]
    fn validate_extruder_slot(value: &str, filament_slots: usize) -> Result<(), RetargetIssue> {
        let slot = value.parse::<usize>().map_err(|_| {
            invalid_model_settings(format!(
                "extruder value '{value}' is not a non-negative slot number"
            ))
        })?;
        if slot > filament_slots {
            return Err(invalid_model_settings(format!(
                "model settings reference filament slot {slot}, but only {filament_slots} slots exist"
            )));
        }
        Ok(())
    }
    let lower = text.to_ascii_lowercase();
    Ok(ModelObservation {
        plate_count,
        has_paint_metadata: lower.contains("paint")
            || lower.contains("mmu_segmentation")
            || lower.contains("seam"),
    })
}

fn invalid_model_settings(message: impl Into<String>) -> RetargetIssue {
    RetargetIssue::blocker(
        IssueCode::InvalidModelSettings,
        "Invalid model settings",
        message,
        "Re-export a complete editable Orca/Bambu project.",
    )
    .with_part(MODEL_SETTINGS_PART)
}

fn has_fatal_structure_blocker(blockers: &[RetargetIssue]) -> bool {
    blockers.iter().any(|issue| {
        matches!(
            issue.code,
            IssueCode::MissingProjectSettings
                | IssueCode::InvalidProjectSettings
                | IssueCode::MissingModelSettings
                | IssueCode::InvalidModelSettings
                | IssueCode::GeometryOnly
                | IssueCode::PreSlicedOnly
                | IssueCode::IncompleteProject
                | IssueCode::TooManyFilamentSlots
        )
    })
}

pub(crate) fn map_threemf_error(error: ThreeMfError) -> RetargetError {
    match error {
        ThreeMfError::MissingModelPart => RetargetError::new(
            IssueCode::MissingModel,
            error.to_string(),
            "Re-export a complete 3MF with a root model relationship.",
        ),
        ThreeMfError::TooLarge
        | ThreeMfError::DataTooLarge { .. }
        | ThreeMfError::TooManyParts { .. }
        | ThreeMfError::RenderBudgetExceeded { .. } => RetargetError::new(
            IssueCode::ArchiveLimitExceeded,
            error.to_string(),
            "Reduce project size or complexity.",
        ),
        ThreeMfError::Malformed(message) if message.contains("external OPC relationship") => {
            RetargetError::new(
                IssueCode::ExternalRelationship,
                message,
                "Remove external relationships and re-export.",
            )
        }
        ThreeMfError::Malformed(message)
            if message.contains("part name")
                || message.contains("escapes the package root")
                || message.contains("case-equivalent") =>
        {
            RetargetError::new(
                IssueCode::UnsafeArchivePath,
                message,
                "Re-export with normalized safe package paths.",
            )
        }
        _ => RetargetError::new(
            IssueCode::InvalidArchive,
            error.to_string(),
            "Re-export a complete editable 3MF project.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_settings_normalize_scalars() {
        assert_eq!(
            normalize_source_value(&serde_json::json!(true)).unwrap(),
            SettingValue::Scalar("1".into())
        );
        assert_eq!(
            normalize_source_value(&serde_json::json!([1, "two", false])).unwrap(),
            SettingValue::List(vec!["1".into(), "two".into(), "0".into()])
        );
        assert!(normalize_source_value(&serde_json::json!({"bad": true})).is_err());
    }
}
