use std::collections::{BTreeMap, BTreeSet};

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};

use super::guardrails;
use super::profile::{
    is_filament_identity_key, is_filament_profile_setting, safe_filament_default, ResolvedProfile,
    SettingValue, MACHINE_NAME,
};
use super::project::ProjectInspection;
use super::report::{ChangeRecord, GroupedChanges, IssueCode, RetargetIssue};
use super::RetargetError;

pub(crate) struct TransformResult {
    pub settings: BTreeMap<String, SettingValue>,
    pub json: Vec<u8>,
    pub model_settings: Vec<u8>,
    pub changes: GroupedChanges,
    pub warnings: Vec<RetargetIssue>,
}

const MACHINE_OWNED_KEYS: &[&str] = &[
    "printer_model",
    "printer_variant",
    "printer_settings_id",
    "printer_technology",
    "gcode_flavor",
    "printable_area",
    "printable_height",
    "bed_exclude_area",
    "bed_model",
    "bed_texture",
    "nozzle_diameter",
    "nozzle_type",
    "extruder_offset",
    "single_extruder_multi_material",
    "auxiliary_fan",
    "extruder_clearance_radius",
    "extruder_clearance_height_to_rod",
    "extruder_clearance_height_to_lid",
    "machine_tool_change_time",
    "machine_load_filament_time",
    "machine_unload_filament_time",
    "machine_max_acceleration_e",
    "machine_max_acceleration_extruding",
    "machine_max_acceleration_retracting",
    "machine_max_acceleration_travel",
    "machine_max_acceleration_x",
    "machine_max_acceleration_y",
    "machine_max_acceleration_z",
    "machine_max_speed_e",
    "machine_max_speed_x",
    "machine_max_speed_y",
    "machine_max_speed_z",
    "machine_max_jerk_e",
    "machine_max_jerk_x",
    "machine_max_jerk_y",
    "machine_max_jerk_z",
    "machine_min_extruding_rate",
    "machine_min_travel_rate",
    "max_layer_height",
    "min_layer_height",
    "deretraction_speed",
    "long_retractions_when_cut",
    "retract_before_wipe",
    "retract_length_toolchange",
    "retract_lift_above",
    "retract_lift_below",
    "retract_lift_enforce",
    "retract_restart_extra",
    "retract_restart_extra_toolchange",
    "retract_when_changing_layer",
    "retraction_distances_when_cut",
    "retraction_length",
    "retraction_minimum_travel",
    "retraction_speed",
    "travel_slope",
    "wipe",
    "wipe_distance",
    "z_hop",
    "z_hop_types",
    "z_hop_when_prime",
    "enable_filament_ramming",
    "ramming_pressure_advance_value",
    "tool_change_temprature_wait",
    "purge_in_prime_tower",
    "scan_first_layer",
    "machine_start_gcode",
    "machine_end_gcode",
    "change_filament_gcode",
    "machine_pause_gcode",
    "before_layer_change_gcode",
    "layer_change_gcode",
];

const PROCESS_OWNED_KEYS: &[&str] = &[
    "print_settings_id",
    "compatible_printers",
    "compatible_printers_condition",
    "layer_height",
    "initial_layer_print_height",
    "standby_temperature_delta",
    "ooze_prevention",
    "enable_prime_tower",
    "prime_tower_width",
    "prime_volume",
    "prime_tower_brim_width",
    "wipe_tower_filament",
    "wipe_tower_cone_angle",
    "wipe_tower_no_sparse_layers",
    "preheat_time",
];

const SOURCE_INTENT_KEYS: &[&str] = &[
    "wall_loops",
    "top_shell_layers",
    "bottom_shell_layers",
    "top_shell_thickness",
    "bottom_shell_thickness",
    "sparse_infill_density",
    "sparse_infill_pattern",
    "internal_solid_infill_pattern",
    "top_surface_pattern",
    "bottom_surface_pattern",
    "infill_direction",
    "wall_generator",
    "detect_thin_wall",
    "detect_overhang_wall",
    "seam_position",
    "seam_gap",
    "resolution",
    "slice_closing_radius",
    "elefant_foot_compensation",
    "precise_outer_wall",
    "only_one_wall_top",
    "only_one_wall_first_layer",
    "ensure_vertical_shell_thickness",
    "strength",
    "support_enable",
    "support_type",
    "support_style",
    "support_threshold_angle",
    "support_on_build_plate_only",
    "support_critical_regions_only",
    "support_remove_small_overhang",
    "support_interface_top_layers",
    "support_interface_bottom_layers",
    "support_interface_pattern",
    "support_base_pattern",
    "support_object_xy_distance",
    "support_top_z_distance",
    "support_bottom_z_distance",
    "support_expansion",
    "support_material",
    "raft_layers",
    "raft_first_layer_density",
    "raft_first_layer_expansion",
    "skirt_loops",
    "skirt_height",
    "skirt_distance",
    "brim_type",
    "brim_width",
    "brim_object_gap",
    "draft_shield",
    "print_sequence",
    "spiral_mode",
    "timelapse_type",
    "enable_overhang_speed",
    "enable_support",
    "enable_wipe_tower",
    "flush_into_infill",
    "flush_into_objects",
    "flush_into_support",
    "flush_multiplier",
    "prime_tower_brim_width",
    "prime_tower_width",
    "prime_volume",
    "wipe_tower_cone_angle",
    "wipe_tower_no_sparse_layers",
    "bridge_speed",
    "gap_infill_speed",
    "initial_layer_infill_speed",
    "initial_layer_speed",
    "initial_layer_travel_speed",
    "inner_wall_speed",
    "internal_bridge_speed",
    "internal_solid_infill_speed",
    "ironing_speed",
    "outer_wall_speed",
    "overhang_1_4_speed",
    "overhang_2_4_speed",
    "overhang_3_4_speed",
    "overhang_4_4_speed",
    "overhang_totally_speed",
    "small_perimeter_speed",
    "sparse_infill_speed",
    "support_interface_speed",
    "support_speed",
    "top_surface_speed",
    "travel_speed",
    "bridge_acceleration",
    "default_acceleration",
    "initial_layer_acceleration",
    "initial_layer_travel_acceleration",
    "inner_wall_acceleration",
    "internal_bridge_acceleration",
    "internal_solid_infill_acceleration",
    "outer_wall_acceleration",
    "sparse_infill_acceleration",
    "top_surface_acceleration",
    "travel_acceleration",
];

pub(crate) fn build_settings(
    project: &ProjectInspection,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
    filaments: &[&ResolvedProfile],
    filament_defaults: &BTreeMap<String, SettingValue>,
    object_exclusion: bool,
) -> Result<TransformResult, RetargetError> {
    validate_source_array_lengths(project, |key| {
        is_filament_identity_key(key)
            || filaments
                .iter()
                .any(|profile| is_filament_profile_setting(key, profile))
    })?;
    let mut settings = machine.settings.clone();
    settings.extend(process.settings.clone());
    let mut changes = GroupedChanges::new();
    let mut warnings = Vec::new();

    merge_filaments(&mut settings, filaments, filament_defaults)?;
    for key in SOURCE_INTENT_KEYS {
        if let Some(source) = project.settings.get(*key) {
            let before = settings.insert((*key).to_string(), source.clone());
            if before.as_ref() != Some(source) {
                changes
                    .entry("process".to_string())
                    .or_default()
                    .push(ChangeRecord {
                        code: IssueCode::SourceSettingReplaced,
                        message: format!("Preserved safe source intent for '{key}'."),
                        setting: Some((*key).to_string()),
                        before: before.as_ref().map(setting_text),
                        after: Some(setting_text(source)),
                    });
            }
        }
    }

    for key in ["filament_colour", "default_filament_colour"] {
        if let Some(colors) = project.settings.get(key) {
            settings.insert(key.to_string(), colors.clone());
        }
    }
    if !project.colors.is_empty() {
        settings.insert(
            "filament_colour".to_string(),
            SettingValue::List(project.colors.clone()),
        );
    }

    reassert(&mut settings, &machine.settings, MACHINE_OWNED_KEYS);
    reassert(&mut settings, &process.settings, PROCESS_OWNED_KEYS);
    settings.insert(
        "printer_settings_id".to_string(),
        SettingValue::Scalar(MACHINE_NAME.to_string()),
    );
    settings.insert(
        "print_settings_id".to_string(),
        SettingValue::Scalar(process.name.clone()),
    );
    settings.insert(
        "filament_settings_id".to_string(),
        SettingValue::List(
            filaments
                .iter()
                .map(|profile| profile.name.clone())
                .collect(),
        ),
    );
    settings.insert(
        "exclude_object".to_string(),
        SettingValue::Scalar(if object_exclusion { "1" } else { "0" }.to_string()),
    );
    apply_extruder_colors(&mut settings, machine, &project.colors);

    changes
        .entry("machine".to_string())
        .or_default()
        .push(ChangeRecord {
            code: IssueCode::SourceSettingReplaced,
            message: "Replaced machine identity, dimensions, limits, tools, and scripts with verified U1 values.".to_string(),
            setting: None,
            before: project.machine_id.clone(),
            after: Some(MACHINE_NAME.to_string()),
        });
    changes
        .entry("filament".to_string())
        .or_default()
        .extend(
            filaments
                .iter()
                .enumerate()
                .map(|(slot, profile)| ChangeRecord {
                    code: IssueCode::FilamentProfileMapped,
                    message: format!("Mapped material slot {} to '{}'.", slot + 1, profile.name),
                    setting: Some("filament_settings_id".to_string()),
                    before: project.materials.get(slot).cloned(),
                    after: Some(profile.name.clone()),
                }),
        );
    changes
        .entry("objectExclusion".to_string())
        .or_default()
        .push(ChangeRecord {
            code: IssueCode::SourceSettingReplaced,
            message: "Set explicit object exclusion behavior.".to_string(),
            setting: Some("exclude_object".to_string()),
            before: project.settings.get("exclude_object").map(setting_text),
            after: Some(if object_exclusion { "1" } else { "0" }.to_string()),
        });

    let copied: BTreeSet<&str> = SOURCE_INTENT_KEYS
        .iter()
        .copied()
        .chain(["filament_colour", "default_filament_colour"])
        .collect();
    let omitted = project
        .settings
        .keys()
        .filter(|key| !copied.contains(key.as_str()))
        .filter(|key| !settings.contains_key(key.as_str()) || is_source_owned_identity(key))
        .count();
    if omitted > 0 {
        warnings.push(RetargetIssue::warning(
            IssueCode::UnsupportedSourceSettingsOmitted,
            "Unsupported source settings omitted",
            format!(
                "{omitted} source settings were omitted from the rebuilt target configuration."
            ),
            "Review the target settings before slicing.",
        ));
    }

    guardrails::apply(&mut settings, machine, process, &mut changes)?;
    guardrails::validate(&settings, machine, process)?;
    let model_settings =
        transform_model_settings(&project.model_settings, machine, process, &mut changes)?;
    let json = settings_to_json(&settings)?;
    Ok(TransformResult {
        settings,
        json,
        model_settings,
        changes,
        warnings,
    })
}

fn transform_model_settings(
    xml: &[u8],
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
    changes: &mut GroupedChanges,
) -> Result<Vec<u8>, RetargetError> {
    let mut reader = Reader::from_reader(xml);
    let mut writer = Writer::new(Vec::with_capacity(xml.len()));
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(model_settings_xml_error)?;
        match event {
            Event::Start(element) if element.name().as_ref() == b"metadata" => {
                let (element, change) =
                    clamp_metadata_element(&reader, &element, machine, process)?;
                writer
                    .write_event(Event::Start(element))
                    .map_err(model_settings_xml_error)?;
                if let Some(change) = change {
                    changes
                        .entry("guardrails".to_string())
                        .or_default()
                        .push(change);
                }
            }
            Event::Empty(element) if element.name().as_ref() == b"metadata" => {
                let (element, change) =
                    clamp_metadata_element(&reader, &element, machine, process)?;
                writer
                    .write_event(Event::Empty(element))
                    .map_err(model_settings_xml_error)?;
                if let Some(change) = change {
                    changes
                        .entry("guardrails".to_string())
                        .or_default()
                        .push(change);
                }
            }
            Event::Eof => break,
            event => writer
                .write_event(event.into_owned())
                .map_err(model_settings_xml_error)?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner())
}

fn clamp_metadata_element(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
) -> Result<(BytesStart<'static>, Option<ChangeRecord>), RetargetError> {
    let mut key = None;
    let mut value_index = None;
    let mut attributes = Vec::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| {
            model_settings_error(format!("invalid metadata attribute: {error}"))
        })?;
        let name = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|error| model_settings_error(format!("invalid attribute name: {error}")))?
            .to_string();
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| model_settings_error(format!("invalid metadata value: {error}")))?
            .into_owned();
        if attribute.key.as_ref() == b"key" {
            key = Some(value.clone());
        } else if attribute.key.as_ref() == b"value" {
            value_index = Some(attributes.len());
        }
        attributes.push((name, value));
    }
    let Some(key) = key.filter(|key| guardrails::is_motion_key(key)) else {
        return Ok((element.to_owned(), None));
    };
    let value_index = value_index.ok_or_else(|| {
        model_settings_error(format!("motion override '{key}' is missing its value"))
            .with_setting(&key)
    })?;
    let before = attributes[value_index].1.clone();
    let after = guardrails::clamp_override(&key, &before, machine, process)?;
    if after == before {
        return Ok((element.to_owned(), None));
    }
    attributes[value_index].1.clone_from(&after);

    let name = std::str::from_utf8(element.name().as_ref())
        .map_err(|error| model_settings_error(format!("invalid element name: {error}")))?
        .to_string();
    let mut replacement = BytesStart::new(name);
    for (name, value) in &attributes {
        let escaped = quick_xml::escape::escape(value).into_owned();
        replacement.push_attribute((name.as_str(), escaped.as_str()));
    }
    Ok((
        replacement,
        Some(ChangeRecord {
            code: IssueCode::SettingClamped,
            message: format!("Clamped object override '{key}' to the verified U1 ceiling."),
            setting: Some(key),
            before: Some(before),
            after: Some(after),
        }),
    ))
}

fn model_settings_xml_error(error: quick_xml::Error) -> RetargetError {
    model_settings_error(format!("invalid model settings XML: {error}"))
}

fn model_settings_error(message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::InvalidModelSettings,
        message,
        "Re-export a complete editable project.",
    )
}

fn merge_filaments(
    settings: &mut BTreeMap<String, SettingValue>,
    filaments: &[&ResolvedProfile],
    defaults: &BTreeMap<String, SettingValue>,
) -> Result<(), RetargetError> {
    let union: BTreeSet<_> = filaments
        .iter()
        .flat_map(|profile| {
            profile
                .settings
                .keys()
                .filter(|key| is_filament_profile_setting(key, profile))
                .cloned()
        })
        .collect();
    for key in union {
        let values = filaments
            .iter()
            .enumerate()
            .map(|(slot, profile)| {
                let safe_default;
                let setting = if let Some(setting) = profile.settings.get(&key) {
                    setting
                } else if let Some(setting) = defaults.get(&key) {
                    setting
                } else if let Some(value) = safe_filament_default(&key) {
                    safe_default = SettingValue::Scalar(value.to_string());
                    &safe_default
                } else {
                    return Err(RetargetError::new(
                        IssueCode::ProfileValueInvalid,
                        format!(
                            "filament combination has no verified default for '{key}' in '{}'",
                            profile.name
                        ),
                        "Choose a filament combination with complete compatible settings.",
                    )
                    .with_setting(&key));
                };
                match setting {
                    SettingValue::Scalar(value) => Ok(value.clone()),
                    SettingValue::List(values) if values.len() == 1 => Ok(values[0].clone()),
                    SettingValue::List(values) if slot < values.len() => Ok(values[slot].clone()),
                    SettingValue::List(_) => Err(RetargetError::new(
                        IssueCode::ProfileValueInvalid,
                        format!(
                            "filament profile '{}' cannot supply slot {} for '{key}'",
                            profile.name,
                            slot + 1
                        ),
                        "Restore the pinned profile bundle.",
                    )),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        settings.insert(key, SettingValue::List(values));
    }
    Ok(())
}

pub(crate) fn validate_source_array_lengths(
    project: &ProjectInspection,
    is_per_filament_key: impl Fn(&str) -> bool,
) -> Result<(), RetargetError> {
    let slot_count = project.materials.len();
    for (key, value) in &project.settings {
        if !is_per_filament_key(key) {
            continue;
        }
        let SettingValue::List(values) = value else {
            return Err(RetargetError::new(
                IssueCode::IncompleteProject,
                format!("per-filament setting '{key}' must be an array"),
                "Re-export with array-valued per-filament settings.",
            )
            .with_setting(key));
        };
        let optional_empty_color = values.is_empty()
            && matches!(key.as_str(), "filament_colour" | "default_filament_colour");
        if !optional_empty_color && values.len() != slot_count {
            return Err(RetargetError::new(
                IssueCode::IncompleteProject,
                format!(
                    "per-filament setting '{key}' has {} values for {slot_count} slots",
                    values.len()
                ),
                "Re-export with consistent per-filament array lengths.",
            )
            .with_setting(key));
        }
    }
    Ok(())
}

fn reassert(
    settings: &mut BTreeMap<String, SettingValue>,
    target: &BTreeMap<String, SettingValue>,
    keys: &[&str],
) {
    for key in keys {
        if let Some(value) = target.get(*key) {
            settings.insert((*key).to_string(), value.clone());
        } else {
            settings.remove(*key);
        }
    }
}

fn apply_extruder_colors(
    settings: &mut BTreeMap<String, SettingValue>,
    machine: &ResolvedProfile,
    colors: &[String],
) {
    let mut palette = machine
        .settings
        .get("extruder_colour")
        .map(SettingValue::as_list)
        .unwrap_or_default()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    palette.resize(4, "#FCE94F".to_string());
    palette.truncate(4);
    for (slot, color) in colors.iter().take(4).enumerate() {
        palette[slot] = color.clone();
    }
    settings.insert("extruder_colour".to_string(), SettingValue::List(palette));
}

fn settings_to_json(settings: &BTreeMap<String, SettingValue>) -> Result<Vec<u8>, RetargetError> {
    let object: BTreeMap<_, _> = settings
        .iter()
        .map(|(key, value)| (key.clone(), value.to_json()))
        .collect();
    serde_json::to_vec(&object).map_err(|error| {
        RetargetError::new(
            IssueCode::OutputValidationFailed,
            format!("failed to serialize target settings: {error}"),
            "Retry the conversion.",
        )
    })
}

fn is_source_owned_identity(key: &str) -> bool {
    matches!(
        key,
        "printer_model"
            | "printer_variant"
            | "printer_settings_id"
            | "print_settings_id"
            | "filament_settings_id"
    )
}

fn setting_text(value: &SettingValue) -> String {
    match value {
        SettingValue::Scalar(value) => value.clone(),
        SettingValue::List(values) => values.join(","),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_is_serialized_as_orca_string_boolean() {
        let value = SettingValue::Scalar(if true { "1" } else { "0" }.to_string());
        assert_eq!(value, SettingValue::Scalar("1".into()));
    }

    #[test]
    fn source_allowlist_is_explicit_and_motion_complete() {
        assert!(SOURCE_INTENT_KEYS.contains(&"wall_loops"));
        for key in guardrails::SPEED_KEYS
            .iter()
            .chain(guardrails::ACCELERATION_KEYS)
        {
            assert!(SOURCE_INTENT_KEYS.contains(key));
        }
    }
}
