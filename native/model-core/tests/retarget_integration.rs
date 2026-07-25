use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use model_core::catalog::InMemoryCatalog;
use model_core::hash::hash_file;
use model_core::retarget::{
    IssueCode, RetargetEngine, RetargetLimits, RetargetOptions, TargetReference,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

const MANDATORY_SPEED_KEYS: &[&str] = &[
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
    "travel_speed_z",
];

const MANDATORY_ACCELERATION_KEYS: &[&str] = &[
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

fn bundle_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("resources")
        .join("target-profiles")
        .join("snapmaker-u1")
}

fn engine() -> RetargetEngine {
    RetargetEngine::open(bundle_root(), RetargetLimits::default()).unwrap()
}

fn target_id(engine: &RetargetEngine) -> String {
    engine
        .list_bundled_profiles()
        .unwrap()
        .into_iter()
        .find(|profile| profile.display_name.starts_with("0.20 Standard"))
        .unwrap()
        .profile_id
}

fn editable_project(path: &Path, application: &str, stale: bool) {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Override PartName="/Metadata/project_settings.config" ContentType="application/json"/>
  <Override PartName="/Metadata/model_settings.config" ContentType="application/xml"/>
  <Override PartName="/Metadata/plate_1.gcode" ContentType="text/plain"/>
  <Override PartName="/Metadata/slice_info.config" ContentType="application/xml"/>
  <Override PartName="/Metadata/custom_gcode_per_layer.xml" ContentType="application/xml"/>
  <Override PartName="/_xmlsignatures/origin.sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/>
</Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
  <Relationship Id="slice" Type="urn:test:slice" Target="/Metadata/slice_info.config"/>
  <Relationship Id="signature" Type="urn:test:signature" Target="/_xmlsignatures/origin.sigs"/>
</Relationships>"#;
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="urn:test:paint">
  <metadata name="Application">{application}</metadata>
  <resources>
    <object id="1" name="Painted triangle" type="model"><mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/>
      </vertices>
      <triangles><triangle v1="0" v2="1" v3="2" p:paint_color="1"/></triangles>
    </mesh></object>
    <object id="2" name="Assembly" type="model"><components>
      <component objectid="1"/>
      <component objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>
    </components></object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 6 7"/></build>
</model>"#
    );
    let settings = json!({
        "printer_model": "Source Printer",
        "printer_settings_id": "Source 0.4",
        "print_settings_id": "0.20 Standard",
        "layer_height": 0.2,
        "filament_type": ["PLA", "PETG"],
        "filament_colour": ["#112233", "#AABBCC"],
        "wall_loops": "3",
        "inner_wall_speed": "9999",
        "default_acceleration": "99999",
        "machine_start_gcode": "UNSAFE SOURCE SCRIPT",
        "unknown_source_knob": "discard me"
    })
    .to_string();
    let model_settings = r#"<?xml version="1.0" encoding="UTF-8"?>
<config><object id="2" extruder="1"><part id="9"/></object><assembly><assemble_item object_id="1"/></assembly><plate/><plate/></config>"#;

    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/project_settings.config", settings.as_bytes()),
        ("Metadata/model_settings.config", model_settings.as_bytes()),
        ("Metadata/unknown.bin", b"\x00\x01preserve me"),
    ];
    if stale {
        parts.extend([
            ("Metadata/plate_1.gcode", b"G28\n" as &[u8]),
            ("Metadata/plate_1.gcode.md5", b"deadbeef"),
            ("Metadata/slice_info.config", b"<config/>"),
            ("Metadata/custom_gcode_per_layer.xml", b"<custom/>"),
            ("_xmlsignatures/origin.sigs", b"signature"),
        ]);
    } else {
        parts.retain(|(name, _)| {
            !matches!(
                *name,
                "Metadata/plate_1.gcode"
                    | "Metadata/slice_info.config"
                    | "Metadata/custom_gcode_per_layer.xml"
                    | "_xmlsignatures/origin.sigs"
            )
        });
    }
    for (name, bytes) in parts {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

fn simple_archive(path: &Path, include_configs: bool) {
    let content_types = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>"#;
    let rels = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="m" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>"#;
    let model = r#"<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio</metadata><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#;
    let mut bytes = Vec::new();
    {
        let mut writer = ZipWriter::new(Cursor::new(&mut bytes));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, data) in [
            ("[Content_Types].xml", content_types.as_bytes()),
            ("_rels/.rels", rels.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        if include_configs {
            writer
                .start_file("Metadata/project_settings.config", options)
                .unwrap();
            writer
                .write_all(br#"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA"]}"#)
                .unwrap();
            writer
                .start_file("Metadata/model_settings.config", options)
                .unwrap();
            writer
                .write_all(br#"<config><object id="1"/></config>"#)
                .unwrap();
        }
        writer.finish().unwrap();
    }
    fs::write(path, bytes).unwrap();
}

#[test]
fn actual_bundle_has_verified_82_file_shape_and_15_targets() {
    let engine = engine();
    let profiles = engine.list_bundled_profiles().unwrap();
    assert_eq!(profiles.len(), 15);
    assert!(profiles.iter().all(|profile| {
        profile
            .profile_id
            .starts_with("snapmaker-u1-orca-presets:profiles/Snapmaker/process/")
    }));
    for profile in profiles {
        let details = engine.inspect_bundled_profile(&profile.profile_id).unwrap();
        assert_eq!(details.compatible_filaments.len(), 23);
        assert_eq!(details.machine.nozzle_count, 4);
        assert_eq!(details.profile_hashes.len(), 25);
    }
}

#[test]
fn builds_deterministically_preserves_source_and_reopens_scene() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source.3mf");
    let first = temp.path().join("first.3mf");
    let second = temp.path().join("second.3mf");
    editable_project(&source, "OrcaSlicer-2.3", true);
    replace_zip_part(
        &source,
        "Metadata/_rels/slice_info.config.rels",
        br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#,
    );
    let source_hash = hash_file(&source).unwrap();

    let preflight = engine
        .preflight(
            &source,
            RetargetOptions {
                object_exclusion: true,
            },
        )
        .unwrap();
    assert!(preflight.accepted, "{:?}", preflight.blockers);
    assert!(preflight
        .warnings
        .iter()
        .any(|warning| warning.code == IssueCode::StaleSliceArtifactsRemoved));
    assert!(preflight
        .warnings
        .iter()
        .any(|warning| warning.code == IssueCode::PaintMetadataPreservedUnverified));

    let report = engine
        .build(
            &source,
            &first,
            &target,
            RetargetOptions {
                object_exclusion: true,
            },
        )
        .unwrap();
    engine
        .build(
            &source,
            &second,
            &target,
            RetargetOptions {
                object_exclusion: true,
            },
        )
        .unwrap();
    assert!(report.validation.valid);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert_eq!(source_hash, hash_file(&source).unwrap());
    let output_settings: Value =
        serde_json::from_slice(&read_zip_part(&first, "Metadata/project_settings.config")).unwrap();
    assert_eq!(
        output_settings["printer_settings_id"],
        "Snapmaker U1 (0.4 nozzle)"
    );
    assert_eq!(output_settings["exclude_object"], "1");
    assert_ne!(
        output_settings["machine_start_gcode"],
        "UNSAFE SOURCE SCRIPT"
    );
    assert_eq!(
        output_settings["filament_settings_id"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(output_settings.get("unknown_source_knob").is_none());
    assert!(
        output_settings["inner_wall_speed"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            < 9999.0
    );
    for removed in [
        "Metadata/plate_1.gcode",
        "Metadata/slice_info.config",
        "Metadata/_rels/slice_info.config.rels",
        "Metadata/custom_gcode_per_layer.xml",
        "_xmlsignatures/origin.sigs",
    ] {
        assert!(zip_part(&first, removed).is_none(), "{removed} survived");
    }
    assert_eq!(
        read_zip_part(&source, "3D/3dmodel.model"),
        read_zip_part(&first, "3D/3dmodel.model")
    );
    assert_eq!(
        read_zip_part(&source, "Metadata/model_settings.config"),
        read_zip_part(&first, "Metadata/model_settings.config")
    );
    assert_eq!(
        read_zip_part(&source, "Metadata/unknown.bin"),
        read_zip_part(&first, "Metadata/unknown.bin")
    );
    model_core::threemf::parse_file(&first).unwrap();
    model_core::scene::load_scene(&first).unwrap();
    model_core::vendor::extract_file(&first).unwrap();
}

#[test]
fn independent_projects_preserve_single_material_and_multi_tool_placement() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();

    let single = temp.path().join("single-material.3mf");
    let single_output = temp.path().join("single-material-output.3mf");
    editable_project(&single, "OrcaSlicer-2.3.5", true);
    replace_zip_part(
        &single,
        "Metadata/project_settings.config",
        br##"{"printer_model":"Independent source","layer_height":"0.2","filament_type":["PLA"],"filament_colour":["#112233"]}"##,
    );
    replace_zip_part(
        &single,
        "Metadata/model_settings.config",
        br#"<config><object id="2" extruder="1"><part id="9" extruder="1"/></object><plate><metadata key="object_id" value="2"/></plate></config>"#,
    );
    let single_preflight = engine
        .preflight(&single, RetargetOptions::default())
        .unwrap();
    assert!(single_preflight.accepted, "{:?}", single_preflight.blockers);
    assert_eq!(single_preflight.source.materials, ["PLA"]);
    assert_eq!(single_preflight.source.plate_count, 1);
    let single_report = engine
        .build(&single, &single_output, &target, RetargetOptions::default())
        .unwrap();
    assert!(single_report.validation.valid);
    let imported_single = engine.inspect_imported_profile(&single_output).unwrap();
    assert_eq!(imported_single.capabilities.max_filament_slots, 1);
    let single_settings: Value = serde_json::from_slice(&read_zip_part(
        &single_output,
        "Metadata/project_settings.config",
    ))
    .unwrap();
    assert_eq!(
        single_settings["filament_settings_id"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        read_zip_part(&single, "Metadata/model_settings.config"),
        read_zip_part(&single_output, "Metadata/model_settings.config")
    );

    let routed = temp.path().join("multi-tool-two-plate.3mf");
    let routed_output = temp.path().join("multi-tool-two-plate-output.3mf");
    editable_project(&routed, "OrcaSlicer-2.3.5", true);
    replace_zip_part(
        &routed,
        "Metadata/model_settings.config",
        br#"<config><object id="2" extruder="2"><part id="9" extruder="1"/></object><assembly><assemble_item object_id="1"/></assembly><plate><metadata key="object_id" value="2"/></plate><plate/></config>"#,
    );
    let routed_preflight = engine
        .preflight(&routed, RetargetOptions::default())
        .unwrap();
    assert!(routed_preflight.accepted, "{:?}", routed_preflight.blockers);
    assert_eq!(routed_preflight.source.materials, ["PLA", "PETG"]);
    assert_eq!(routed_preflight.source.plate_count, 2);
    let routed_report = engine
        .build(&routed, &routed_output, &target, RetargetOptions::default())
        .unwrap();
    assert!(routed_report.validation.valid);
    assert_eq!(
        read_zip_part(&routed, "Metadata/model_settings.config"),
        read_zip_part(&routed_output, "Metadata/model_settings.config")
    );
    assert_eq!(
        read_zip_part(&routed, "3D/3dmodel.model"),
        read_zip_part(&routed_output, "3D/3dmodel.model")
    );
}

#[test]
fn every_mandatory_global_and_object_motion_setting_is_clamped() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("all-motion-overrides.3mf");
    let output = temp.path().join("all-motion-overrides-output.3mf");
    editable_project(&source, "OrcaSlicer-2.3.5", true);

    let mut settings = serde_json::Map::from_iter([
        ("printer_model".to_string(), json!("Independent source")),
        ("layer_height".to_string(), json!("0.2")),
        ("filament_type".to_string(), json!(["PLA", "PETG"])),
        ("filament_colour".to_string(), json!(["#112233", "#AABBCC"])),
    ]);
    for key in MANDATORY_SPEED_KEYS
        .iter()
        .chain(MANDATORY_ACCELERATION_KEYS)
    {
        settings.insert((*key).to_string(), json!("999999"));
    }
    replace_zip_part(
        &source,
        "Metadata/project_settings.config",
        serde_json::to_string(&settings).unwrap().as_bytes(),
    );

    let object_overrides = MANDATORY_SPEED_KEYS
        .iter()
        .chain(MANDATORY_ACCELERATION_KEYS)
        .map(|key| format!(r#"<metadata key="{key}" value="999999" note="A &amp; B"/>"#))
        .collect::<String>();
    let model_settings = format!(
        r#"<config><object id="2" extruder="2">{object_overrides}</object><plate><metadata key="object_id" value="2"/></plate></config>"#
    );
    replace_zip_part(
        &source,
        "Metadata/model_settings.config",
        model_settings.as_bytes(),
    );

    let report = engine
        .build(&source, &output, &target, RetargetOptions::default())
        .unwrap();
    assert!(report.validation.valid);
    let rebuilt: Value =
        serde_json::from_slice(&read_zip_part(&output, "Metadata/project_settings.config"))
            .unwrap();
    let rebuilt_model =
        String::from_utf8(read_zip_part(&output, "Metadata/model_settings.config")).unwrap();
    assert!(rebuilt_model.contains(r#"note="A &amp; B""#));
    assert!(!rebuilt_model.contains("&amp;amp;"));
    let guardrail_changes = report.applied_changes.get("guardrails").unwrap();
    for key in MANDATORY_SPEED_KEYS
        .iter()
        .chain(MANDATORY_ACCELERATION_KEYS)
    {
        let global = rebuilt[*key].as_str().unwrap().parse::<f64>().unwrap();
        assert!(
            global.is_finite() && global > 0.0 && global < 999999.0,
            "{key} was not safely clamped: {global}"
        );
        assert!(
            !rebuilt_model.contains(&format!(r#"key="{key}" value="999999""#)),
            "per-object {key} was not clamped"
        );
        assert!(
            guardrail_changes
                .iter()
                .any(|change| change.setting.as_deref() == Some(key)),
            "{key} did not produce a guardrail change"
        );
    }
}

#[test]
fn rejects_geometry_only_presliced_and_unsafe_paths() {
    let engine = engine();
    let temp = TempDir::new().unwrap();
    let geometry = temp.path().join("geometry.3mf");
    simple_archive(&geometry, false);
    let report = engine
        .preflight(&geometry, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::GeometryOnly));

    let gcode = temp.path().join("job.gcode.3mf");
    let file = fs::File::create(&gcode).unwrap();
    let mut writer = ZipWriter::new(file);
    writer
        .start_file("Metadata/plate_1.gcode", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"G28\n").unwrap();
    writer.finish().unwrap();
    let report = engine
        .preflight(&gcode, RetargetOptions::default())
        .unwrap();
    assert_eq!(report.blockers[0].code, IssueCode::PreSlicedOnly);

    let traversal = temp.path().join("unsafe.3mf");
    let file = fs::File::create(&traversal).unwrap();
    let mut writer = ZipWriter::new(file);
    writer
        .start_file("../escape.model", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"x").unwrap();
    writer.finish().unwrap();
    let error = engine
        .preflight(&traversal, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(error.code, IssueCode::UnsafeArchivePath);
}

#[test]
fn classifies_slicers_and_blocks_invalid_material_configurations() {
    let engine = engine();
    let temp = TempDir::new().unwrap();
    for (name, application, code) in [
        ("prusa.3mf", "PrusaSlicer-2.8", IssueCode::UnsupportedPrusa),
        ("cura.3mf", "Ultimaker Cura 5.7", IssueCode::UnsupportedCura),
    ] {
        let path = temp.path().join(name);
        editable_project(&path, application, true);
        let report = engine.preflight(&path, RetargetOptions::default()).unwrap();
        assert!(report.blockers.iter().any(|blocker| blocker.code == code));
    }

    let unknown = temp.path().join("unknown.3mf");
    editable_project(&unknown, "IndependentSlicer-1.0", true);
    let report = engine
        .preflight(&unknown, RetargetOptions::default())
        .unwrap();
    assert!(report.accepted);
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.code == IssueCode::UnknownOrcaFamilyProducer));

    let unsupported = temp.path().join("unsupported-material.3mf");
    editable_project(&unsupported, "OrcaSlicer", true);
    replace_zip_part(
        &unsupported,
        "Metadata/project_settings.config",
        br#"{"printer_model":"x","layer_height":"0.2","filament_type":["PC"]}"#,
    );
    let report = engine
        .preflight(&unsupported, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::UnsupportedMaterial));

    let five = temp.path().join("five-materials.3mf");
    editable_project(&five, "OrcaSlicer", true);
    replace_zip_part(
        &five,
        "Metadata/project_settings.config",
        br#"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA","PLA","PLA","PLA","PLA"]}"#,
    );
    let report = engine.preflight(&five, RetargetOptions::default()).unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::TooManyFilamentSlots));

    let truncated = temp.path().join("truncated-model-settings.3mf");
    editable_project(&truncated, "OrcaSlicer", true);
    replace_zip_part(
        &truncated,
        "Metadata/model_settings.config",
        br#"<config><object id="2">"#,
    );
    let report = engine
        .preflight(&truncated, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let invalid_part_extruder = temp.path().join("invalid-part-extruder.3mf");
    editable_project(&invalid_part_extruder, "OrcaSlicer", true);
    replace_zip_part(
        &invalid_part_extruder,
        "Metadata/model_settings.config",
        br#"<config><object id="2"><part id="9" extruder="5"/></object></config>"#,
    );
    let report = engine
        .preflight(&invalid_part_extruder, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let invalid_extruder = temp.path().join("invalid-extruder-metadata.3mf");
    editable_project(&invalid_extruder, "OrcaSlicer", true);
    replace_zip_part(
        &invalid_extruder,
        "Metadata/model_settings.config",
        br#"<config><object id="2"><metadata key="extruder" value="3"/></object></config>"#,
    );
    let report = engine
        .preflight(&invalid_extruder, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let invalid_direct_extruder = temp.path().join("invalid-direct-extruder.3mf");
    editable_project(&invalid_direct_extruder, "OrcaSlicer", true);
    replace_zip_part(
        &invalid_direct_extruder,
        "Metadata/model_settings.config",
        br#"<config><object id="2" extruder="invalid"/></config>"#,
    );
    let report = engine
        .preflight(&invalid_direct_extruder, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let inherited_extruder = temp.path().join("inherited-extruder.3mf");
    editable_project(&inherited_extruder, "OrcaSlicer", true);
    replace_zip_part(
        &inherited_extruder,
        "Metadata/model_settings.config",
        br#"<config><object id="2" extruder="0"><metadata key="extruder" value="0"/></object></config>"#,
    );
    let report = engine
        .preflight(&inherited_extruder, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .all(|blocker| blocker.code != IssueCode::InvalidModelSettings));

    let dangling_plate_object = temp.path().join("dangling-plate-object.3mf");
    editable_project(&dangling_plate_object, "OrcaSlicer", true);
    replace_zip_part(
        &dangling_plate_object,
        "Metadata/model_settings.config",
        br#"<config><object id="2"/><plate><metadata key="object_id" value="999"/></plate></config>"#,
    );
    let report = engine
        .preflight(&dangling_plate_object, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let duplicate_objects = temp.path().join("duplicate-object-records.3mf");
    editable_project(&duplicate_objects, "OrcaSlicer", true);
    replace_zip_part(
        &duplicate_objects,
        "Metadata/model_settings.config",
        br#"<config><object id="2"/><object id="2"/></config>"#,
    );
    let report = engine
        .preflight(&duplicate_objects, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let no_objects = temp.path().join("model-settings-without-objects.3mf");
    editable_project(&no_objects, "OrcaSlicer", true);
    replace_zip_part(
        &no_objects,
        "Metadata/model_settings.config",
        br#"<config><assembly/></config>"#,
    );
    let report = engine
        .preflight(&no_objects, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let qualified_metadata = temp.path().join("qualified-metadata.3mf");
    editable_project(&qualified_metadata, "OrcaSlicer", true);
    replace_zip_part(
        &qualified_metadata,
        "Metadata/model_settings.config",
        br#"<config xmlns:x="urn:test"><object id="2"><metadata key="outer_wall_speed" x:key="ignored" value="9999"/></object></config>"#,
    );
    let report = engine
        .preflight(&qualified_metadata, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));

    let conflicting_aliases = temp.path().join("conflicting-object-aliases.3mf");
    editable_project(&conflicting_aliases, "OrcaSlicer", true);
    replace_zip_part(
        &conflicting_aliases,
        "Metadata/model_settings.config",
        br#"<config><object id="2"/><assembly><assemble_item object_id="1" objectid="2"/></assembly></config>"#,
    );
    let report = engine
        .preflight(&conflicting_aliases, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::InvalidModelSettings));
}

#[test]
fn rejects_external_relationships_and_existing_output() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let external = temp.path().join("external.3mf");
    simple_archive(&external, true);
    replace_zip_part(
        &external,
        "_rels/.rels",
        br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="m" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="https://example.invalid/model" TargetMode="External"/></Relationships>"#,
    );
    let error = engine
        .preflight(&external, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(error.code, IssueCode::ExternalRelationship);

    let qualified_external = temp.path().join("qualified-external.3mf");
    simple_archive(&qualified_external, true);
    replace_zip_part(
        &qualified_external,
        "_rels/.rels",
        br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:x="urn:test"><Relationship Id="m" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="https://example.invalid/model" x:TargetMode="Internal" TargetMode="External"/></Relationships>"#,
    );
    let error = engine
        .preflight(&qualified_external, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(error.code, IssueCode::InvalidArchive);

    let source = temp.path().join("source.3mf");
    let output = temp.path().join("existing.3mf");
    editable_project(&source, "OrcaSlicer", true);
    fs::write(&output, b"occupied").unwrap();
    let error = engine
        .build(&source, &output, &target, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(error.code, IssueCode::OutputPathConflict);
    assert_eq!(fs::read(&output).unwrap(), b"occupied");
}

#[test]
fn rejects_oversized_control_parts_during_archive_loading() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("oversized-project-settings.3mf");
    editable_project(&source, "OrcaSlicer", true);
    let limits = RetargetLimits {
        max_project_settings_bytes: 64,
        ..RetargetLimits::default()
    };
    let engine = RetargetEngine::open(bundle_root(), limits).unwrap();

    let error = engine
        .preflight(&source, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(error.code, IssueCode::ArchiveLimitExceeded);
}

#[test]
fn missing_sources_use_stable_source_not_found_code() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let missing = temp.path().join("missing.3mf");

    let build_error = engine
        .build(
            &missing,
            temp.path().join("build-output.txt"),
            &target,
            RetargetOptions::default(),
        )
        .unwrap_err();
    assert_eq!(build_error.code, IssueCode::SourceNotFound);

    let validate_error = engine
        .validate_output(
            &missing,
            temp.path().join("validate-output.3mf"),
            &target,
            RetargetOptions::default(),
        )
        .unwrap_err();
    assert_eq!(validate_error.code, IssueCode::SourceNotFound);
}

#[test]
fn preflight_blocks_inconsistent_per_filament_arrays() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("inconsistent-filaments.3mf");
    editable_project(&source, "OrcaSlicer", true);
    replace_zip_part(
        &source,
        "Metadata/project_settings.config",
        br#"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA","PETG"],"additional_cooling_fan_speed":["0","0","0"]}"#,
    );

    let report = engine
        .preflight(&source, RetargetOptions::default())
        .unwrap();
    assert!(!report.accepted);
    assert!(report.blockers.iter().any(|blocker| {
        blocker.code == IssueCode::IncompleteProject
            && blocker.setting.as_deref() == Some("additional_cooling_fan_speed")
    }));

    let too_many_materials = temp.path().join("too-many-materials.3mf");
    editable_project(&too_many_materials, "OrcaSlicer", true);
    mutate_project_settings(&too_many_materials, |settings| {
        settings["filament_type"] = json!(["PLA", "PETG", "ABS", "ASA", "PLA"]);
        settings["filament_colour"] =
            json!(["#111111", "#222222", "#333333", "#444444", "#555555"]);
    });
    let report = engine
        .preflight_target(&too_many_materials, &target, RetargetOptions::default())
        .unwrap();
    assert!(report
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::UnsupportedMaterial));

    let request = json!({
        "id": 1,
        "method": "buildRetarget",
        "params": {
            "sourcePath": source,
            "outputPath": temp.path().join("blocked-output.3mf"),
            "target": {"kind": "bundled", "targetProfileId": target},
            "objectExclusion": false
        }
    });
    let mut output = Vec::new();
    let mut store = InMemoryCatalog::new();
    model_core::serve::run_with_retarget(
        &mut store,
        Some(&engine),
        format!("{request}\n").as_bytes(),
        &mut output,
    )
    .unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response["result"]["status"], "blocked");
    assert_eq!(
        response["result"]["blockers"][0]["code"],
        "incompleteProject"
    );

    let empty_source = temp.path().join("empty-filament-array.3mf");
    editable_project(&empty_source, "OrcaSlicer", true);
    replace_zip_part(
        &empty_source,
        "Metadata/project_settings.config",
        br#"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA","PETG"],"pressure_advance":[]}"#,
    );
    let empty_report = engine
        .preflight(&empty_source, RetargetOptions::default())
        .unwrap();
    assert!(empty_report.blockers.iter().any(|blocker| {
        blocker.code == IssueCode::IncompleteProject
            && blocker.setting.as_deref() == Some("pressure_advance")
    }));

    let scalar_source = temp.path().join("scalar-filament-setting.3mf");
    editable_project(&scalar_source, "OrcaSlicer", true);
    replace_zip_part(
        &scalar_source,
        "Metadata/project_settings.config",
        br##"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA","PETG"],"filament_colour":"#112233"}"##,
    );
    let scalar_report = engine
        .preflight(&scalar_source, RetargetOptions::default())
        .unwrap();
    assert!(scalar_report.blockers.iter().any(|blocker| {
        blocker.code == IssueCode::IncompleteProject
            && blocker.setting.as_deref() == Some("filament_colour")
    }));
}

#[test]
fn build_accepts_explicit_start_end_content_type_overrides() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("expanded-content-types.3mf");
    let output = temp.path().join("expanded-content-types-output.3mf");
    editable_project(&source, "OrcaSlicer", true);
    replace_zip_part(
        &source,
        "[Content_Types].xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Override PartName="/Metadata/project_settings.config" ContentType="application/json"></Override>
  <Override PartName="/Metadata/model_settings.config" ContentType="application/xml"></Override>
  <Override PartName="/Metadata/slice_info.config" ContentType="application/xml"></Override>
</Types>"#,
    );

    engine
        .build(&source, &output, &target, RetargetOptions::default())
        .unwrap();
    let content_types = String::from_utf8(read_zip_part(&output, "[Content_Types].xml")).unwrap();
    assert!(content_types.contains("/Metadata/project_settings.config"));
    assert!(!content_types.contains("/Metadata/slice_info.config"));
}

#[test]
fn filament_profile_compatibility_metadata_is_not_slot_merged() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("four-filaments.3mf");
    let output = temp.path().join("four-filaments-output.3mf");
    editable_project(&source, "OrcaSlicer", true);
    replace_zip_part(
        &source,
        "Metadata/project_settings.config",
        br##"{"printer_model":"x","layer_height":"0.2","filament_type":["PLA","PETG","PLA","PETG"],"filament_colour":["#111111","#222222","#333333","#444444"],"compatible_printers":["Source Printer"]}"##,
    );

    let preflight = engine
        .preflight(&source, RetargetOptions::default())
        .unwrap();
    assert!(preflight.accepted, "{:?}", preflight.blockers);
    engine
        .build(&source, &output, &target, RetargetOptions::default())
        .unwrap();
    let rebuilt: Value =
        serde_json::from_slice(&read_zip_part(&output, "Metadata/project_settings.config"))
            .unwrap();
    assert_eq!(
        rebuilt["compatible_printers"],
        json!(["Snapmaker U1 (0.4 nozzle)"])
    );
    assert_eq!(rebuilt["filament_settings_id"].as_array().unwrap().len(), 4);
    assert_eq!(
        rebuilt["additional_cooling_fan_speed"],
        json!(["70", "0", "70", "0"])
    );

    let ambiguous = temp.path().join("ambiguous-filament-defaults.3mf");
    editable_project(&ambiguous, "OrcaSlicer", true);
    replace_zip_part(
        &ambiguous,
        "Metadata/project_settings.config",
        br##"{"printer_model":"x","layer_height":"0.2","filament_type":["TPU","TPU-95A","PA-CF","PLA"],"filament_colour":["#111111","#222222","#333333","#444444"]}"##,
    );
    let preflight = engine
        .preflight(&ambiguous, RetargetOptions::default())
        .unwrap();
    assert!(!preflight.accepted);
    assert!(preflight
        .blockers
        .iter()
        .any(|blocker| blocker.code == IssueCode::ProfileValueInvalid));
}

#[test]
fn per_object_motion_overrides_are_clamped_and_validated() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("object-motion-override.3mf");
    let output = temp.path().join("object-motion-override-output.3mf");
    editable_project(&source, "OrcaSlicer", true);
    replace_zip_part(
        &source,
        "Metadata/model_settings.config",
        br#"<config><object id="2"><metadata key="outer_wall_speed" value="9999"/></object><plate><metadata key="object_id" value="2"/></plate></config>"#,
    );

    let report = engine
        .build(&source, &output, &target, RetargetOptions::default())
        .unwrap();
    assert!(report
        .applied_changes
        .get("guardrails")
        .unwrap()
        .iter()
        .any(|change| {
            change.code == IssueCode::SettingClamped
                && change.setting.as_deref() == Some("outer_wall_speed")
        }));
    let model_settings =
        String::from_utf8(read_zip_part(&output, "Metadata/model_settings.config")).unwrap();
    assert!(model_settings.contains("outer_wall_speed"));
    assert!(!model_settings.contains("9999"));
    assert!(report.validation.valid);
}

#[test]
fn validation_rejects_json_type_and_relationship_tampering() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("validation-source.3mf");
    let json_output = temp.path().join("json-tampered.3mf");
    let rels_output = temp.path().join("rels-tampered.3mf");
    editable_project(&source, "OrcaSlicer", true);
    replace_zip_part(
        &source,
        "_rels/.rels",
        br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/><Relationship Id="retained" Type="urn:test:retained" Target="/Metadata/unknown.bin"/><Relationship Id="slice" Type="urn:test:slice" Target="/Metadata/slice_info.config"/><Relationship Id="signature" Type="urn:test:signature" Target="/_xmlsignatures/origin.sigs"/></Relationships>"#,
    );
    engine
        .build(&source, &json_output, &target, RetargetOptions::default())
        .unwrap();
    engine
        .build(&source, &rels_output, &target, RetargetOptions::default())
        .unwrap();

    let mut settings: Value = serde_json::from_slice(&read_zip_part(
        &json_output,
        "Metadata/project_settings.config",
    ))
    .unwrap();
    settings["exclude_object"] = Value::Bool(false);
    replace_zip_part(
        &json_output,
        "Metadata/project_settings.config",
        serde_json::to_string(&settings).unwrap().as_bytes(),
    );
    let validation = engine
        .validate_output(&source, &json_output, &target, RetargetOptions::default())
        .unwrap();
    assert!(!validation.valid);
    assert!(!validation.invariants["projectSettingsBytesExact"]);

    replace_zip_part(
        &rels_output,
        "_rels/.rels",
        br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>"#,
    );
    let validation = engine
        .validate_output(&source, &rels_output, &target, RetargetOptions::default())
        .unwrap();
    assert!(!validation.valid);
    assert!(!validation.invariants["opcControlPartsExact"]);
}

#[test]
fn imported_target_inspect_preflight_build_and_rpc_are_content_addressed() {
    let engine = engine();
    let bundled = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let reference_seed = temp.path().join("reference-seed.3mf");
    let reference = temp.path().join("imported-reference.3mf");
    let source = temp.path().join("imported-source.3mf");
    let first = temp.path().join("imported-first.3mf");
    let second = temp.path().join("imported-second.3mf");
    let rpc_output = temp.path().join("imported-rpc.3mf");
    editable_project(&reference_seed, "OrcaSlicer", true);
    editable_project(&source, "MakerWorld-Orca", true);
    engine
        .build(
            &reference_seed,
            &reference,
            &bundled,
            RetargetOptions::default(),
        )
        .unwrap();
    let pinned_reference_settings: Value = serde_json::from_slice(&read_zip_part(
        &reference,
        "Metadata/project_settings.config",
    ))
    .unwrap();
    mutate_project_settings(&reference, |settings| {
        settings["machine_start_gcode"] = json!("M112 IMPORTED MACHINE SCRIPT");
        settings["filament_start_gcode"] = json!([
            "M112 IMPORTED FILAMENT SCRIPT",
            "M112 IMPORTED FILAMENT SCRIPT"
        ]);
        settings["time_lapse_gcode"] = json!("M112 IMPORTED TIMELAPSE SCRIPT");
        settings["machine_max_speed_x"] = json!(["999999", "999999"]);
        settings["machine_max_speed_y"] = json!(["999999", "999999"]);
        settings["inner_wall_speed"] = json!("999999");
        settings["silent_mode"] = json!("1");
        settings["standby_temperature_delta"] = json!("500");
        for key in [
            "filament_max_volumetric_speed",
            "nozzle_temperature",
            "nozzle_temperature_initial_layer",
            "idle_temperature",
            "hot_plate_temp",
            "hot_plate_temp_initial_layer",
            "cool_plate_temp",
            "cool_plate_temp_initial_layer",
            "eng_plate_temp",
            "eng_plate_temp_initial_layer",
            "textured_cool_plate_temp",
            "textured_cool_plate_temp_initial_layer",
            "textured_plate_temp",
            "textured_plate_temp_initial_layer",
            "chamber_temperature",
        ] {
            settings[key] = json!(["999999", "999999"]);
        }
    });
    mutate_project_settings(&source, |settings| {
        settings["filament_type"] = json!(["PETG", "Polylactic Acid"]);
        settings["filament_colour"] = json!(["#AABBCC", "#112233"]);
    });

    let inspected = engine.inspect_imported_profile(&reference).unwrap();
    assert_eq!(
        inspected.profile_id,
        format!("imported:{}", inspected.sha256)
    );
    assert!(inspected.capabilities.motion_guardrails);
    assert_eq!(inspected.capabilities.max_filament_slots, 2);
    let target = TargetReference::imported(&reference, &inspected.sha256);
    let source_hash = hash_file(&source).unwrap();

    let preflight = engine
        .preflight_target(&source, target.clone(), RetargetOptions::default())
        .unwrap();
    assert!(preflight.accepted, "{:?}", preflight.blockers);
    assert_eq!(
        preflight
            .recommendation
            .as_ref()
            .unwrap()
            .recommended
            .profile_id,
        inspected.profile_id
    );
    assert!(preflight
        .warnings
        .iter()
        .any(|warning| warning.code == IssueCode::PaintMetadataPreservedUnverified));

    let first_report = engine
        .build(&source, &first, target.clone(), RetargetOptions::default())
        .unwrap();
    engine
        .build(&source, &second, target.clone(), RetargetOptions::default())
        .unwrap();
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert_eq!(first_report.target_profile_id, inspected.profile_id);
    assert_eq!(hash_file(&source).unwrap(), source_hash);
    assert!(engine.inspect_imported_profile(&first).is_ok());
    let reference_settings: Value = serde_json::from_slice(&read_zip_part(
        &reference,
        "Metadata/project_settings.config",
    ))
    .unwrap();
    let output_settings: Value =
        serde_json::from_slice(&read_zip_part(&first, "Metadata/project_settings.config")).unwrap();
    let reference_filaments = reference_settings["filament_settings_id"]
        .as_array()
        .unwrap();
    assert_eq!(
        output_settings["filament_settings_id"],
        json!([reference_filaments[1], reference_filaments[0]])
    );
    assert_ne!(
        output_settings["machine_start_gcode"],
        "M112 IMPORTED MACHINE SCRIPT"
    );
    assert!(output_settings["filament_start_gcode"]
        .as_array()
        .unwrap()
        .iter()
        .all(|value| value != "M112 IMPORTED FILAMENT SCRIPT"));
    assert!(output_settings.get("time_lapse_gcode").is_none());
    assert_eq!(
        output_settings["silent_mode"],
        pinned_reference_settings["silent_mode"]
    );
    assert!(
        output_settings["standby_temperature_delta"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            <= 0.0
    );
    assert_eq!(
        output_settings["machine_max_speed_x"],
        pinned_reference_settings["machine_max_speed_x"]
    );
    let pinned_machine_speed = ["machine_max_speed_x", "machine_max_speed_y"]
        .iter()
        .map(|key| {
            pinned_reference_settings[*key]
                .as_array()
                .unwrap()
                .first()
                .unwrap()
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
        })
        .reduce(f64::min)
        .unwrap();
    assert!(
        output_settings["inner_wall_speed"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            <= pinned_machine_speed
    );
    for key in [
        "filament_max_volumetric_speed",
        "nozzle_temperature",
        "nozzle_temperature_initial_layer",
        "idle_temperature",
        "hot_plate_temp",
        "hot_plate_temp_initial_layer",
        "cool_plate_temp",
        "cool_plate_temp_initial_layer",
        "eng_plate_temp",
        "eng_plate_temp_initial_layer",
        "textured_cool_plate_temp",
        "textured_cool_plate_temp_initial_layer",
        "textured_plate_temp",
        "textured_plate_temp_initial_layer",
        "chamber_temperature",
    ] {
        match output_settings.get(key) {
            Some(value) => assert!(value.as_array().unwrap().iter().all(|value| value
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                < 999999.0)),
            None => assert!(pinned_reference_settings.get(key).is_none()),
        }
    }

    let alias_error = engine
        .preflight_target(&reference, target.clone(), RetargetOptions::default())
        .unwrap_err();
    assert_eq!(alias_error.code, IssueCode::TargetSourceConflict);
    let hard_link = temp.path().join("reference-hard-link.3mf");
    fs::hard_link(&reference, &hard_link).unwrap();
    let hard_link_error = engine
        .preflight_target(&hard_link, target.clone(), RetargetOptions::default())
        .unwrap_err();
    assert_eq!(hard_link_error.code, IssueCode::TargetSourceConflict);
    let expected_hash_error = engine
        .preflight_target(
            &source,
            TargetReference::imported(&reference, "0".repeat(64)),
            RetargetOptions::default(),
        )
        .unwrap_err();
    assert_eq!(expected_hash_error.code, IssueCode::ProfileHashMismatch);

    let requests = [
        json!({"id":1,"method":"inspectImportedRetargetProfile","params":{"path":reference}}),
        json!({"id":2,"method":"preflightRetarget","params":{"sourcePath":source,"target":{"kind":"imported","path":reference,"expectedSha256":inspected.sha256},"objectExclusion":false}}),
        json!({"id":3,"method":"buildRetarget","params":{"sourcePath":source,"outputPath":rpc_output,"target":{"kind":"imported","path":reference,"expectedSha256":inspected.sha256},"objectExclusion":false}}),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut output = Vec::new();
    let mut store = InMemoryCatalog::new();
    model_core::serve::run_with_retarget(&mut store, Some(&engine), input.as_bytes(), &mut output)
        .unwrap();
    let responses = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(responses.iter().all(|response| response["ok"] == true));
    assert!(responses
        .iter()
        .all(|response| response["result"]["status"] == "ok"));
    assert_eq!(
        responses[2]["result"]["value"]["targetProfileId"],
        inspected.profile_id
    );

    replace_zip_part(&reference, "Metadata/unknown.bin", b"tampered");
    let tamper_error = engine
        .preflight_target(&source, target, RetargetOptions::default())
        .unwrap_err();
    assert_eq!(tamper_error.code, IssueCode::ProfileHashMismatch);

    let tamper_request = json!({
        "id": 4,
        "method": "preflightRetarget",
        "params": {
            "sourcePath": source,
            "target": {
                "kind": "imported",
                "path": reference,
                "expectedSha256": inspected.sha256
            },
            "objectExclusion": false
        }
    });
    let mut output = Vec::new();
    model_core::serve::run_with_retarget(
        &mut store,
        Some(&engine),
        format!("{tamper_request}\n").as_bytes(),
        &mut output,
    )
    .unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response["result"]["status"], "error");
    assert_eq!(response["result"]["error"]["code"], "profileHashMismatch");
}

#[test]
fn imported_targets_reject_incomplete_invalid_and_ambiguous_settings() {
    let engine = engine();
    let bundled = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let seed = temp.path().join("seed.3mf");
    let reference = temp.path().join("reference.3mf");
    editable_project(&seed, "OrcaSlicer", true);
    engine
        .build(&seed, &reference, &bundled, RetargetOptions::default())
        .unwrap();

    let invalid_identity_shape = temp.path().join("invalid-identity-shape.3mf");
    fs::copy(&reference, &invalid_identity_shape).unwrap();
    mutate_project_settings(&invalid_identity_shape, |settings| {
        settings["printer_variant"] = json!(["0.4", "0.8"]);
    });
    let error = engine
        .inspect_imported_profile(&invalid_identity_shape)
        .unwrap_err();
    assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    assert_eq!(error.setting.as_deref(), Some("printer_variant"));

    let executable_setting = temp.path().join("executable-setting.3mf");
    fs::copy(&reference, &executable_setting).unwrap();
    mutate_project_settings(&executable_setting, |settings| {
        settings["post_process"] = json!(["untrusted-command"]);
    });
    let error = engine
        .inspect_imported_profile(&executable_setting)
        .unwrap_err();
    assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    assert_eq!(error.setting.as_deref(), Some("post_process"));

    let missing_script = temp.path().join("missing-script.3mf");
    fs::copy(&reference, &missing_script).unwrap();
    mutate_project_settings(&missing_script, |settings| {
        settings
            .as_object_mut()
            .unwrap()
            .remove("machine_start_gcode");
    });
    let error = engine
        .inspect_imported_profile(&missing_script)
        .unwrap_err();
    assert_eq!(error.code, IssueCode::IncompleteProject);
    assert_eq!(error.setting.as_deref(), Some("machine_start_gcode"));

    let invalid_limit = temp.path().join("invalid-limit.3mf");
    fs::copy(&reference, &invalid_limit).unwrap();
    mutate_project_settings(&invalid_limit, |settings| {
        settings["machine_max_speed_x"] = json!(["fast", "500"]);
    });
    let error = engine.inspect_imported_profile(&invalid_limit).unwrap_err();
    assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    assert_eq!(error.setting.as_deref(), Some("machine_max_speed_x"));

    let invalid_process_shape = temp.path().join("invalid-process-shape.3mf");
    fs::copy(&reference, &invalid_process_shape).unwrap();
    mutate_project_settings(&invalid_process_shape, |settings| {
        settings["prime_tower_width"] = json!(["35", "40"]);
    });
    let error = engine
        .inspect_imported_profile(&invalid_process_shape)
        .unwrap_err();
    assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    assert_eq!(error.setting.as_deref(), Some("prime_tower_width"));

    let ambiguous = temp.path().join("ambiguous-array.3mf");
    fs::copy(&reference, &ambiguous).unwrap();
    mutate_project_settings(&ambiguous, |settings| {
        settings["imported_slot_override"] = json!(["first", "second"]);
    });
    let error = engine.inspect_imported_profile(&ambiguous).unwrap_err();
    assert_eq!(error.code, IssueCode::ProfileValueInvalid);
    assert_eq!(error.setting.as_deref(), Some("imported_slot_override"));

    let four_slot_reference = temp.path().join("four-slot-reference.3mf");
    fs::copy(&reference, &four_slot_reference).unwrap();
    mutate_project_settings(&four_slot_reference, |settings| {
        for (key, value) in settings.as_object_mut().unwrap() {
            if !key.starts_with("machine_") {
                let Some(values) = value.as_array_mut() else {
                    continue;
                };
                if values.len() == 2 {
                    *values = vec![
                        values[0].clone(),
                        values[1].clone(),
                        values[0].clone(),
                        values[1].clone(),
                    ];
                }
            }
        }
        settings["filament_type"] = json!(["PLA", "PETG", "ABS", "ASA"]);
        settings["filament_settings_id"] = json!([
            "Imported PLA",
            "Imported PETG",
            "Imported ABS",
            "Imported ASA"
        ]);
        settings["filament_colour"] = json!(["#111111", "#222222", "#333333", "#444444"]);
    });
    let four_slot = engine
        .inspect_imported_profile(&four_slot_reference)
        .unwrap();
    assert_eq!(four_slot.capabilities.max_filament_slots, 4);

    let sparse_process = engine
        .list_bundled_profiles()
        .unwrap()
        .into_iter()
        .find(|profile| profile.display_name.starts_with("0.08 Extra Fine"))
        .unwrap();
    let sparse_reference = temp.path().join("sparse-process-reference.3mf");
    engine
        .build(
            &seed,
            &sparse_reference,
            &sparse_process.profile_id,
            RetargetOptions::default(),
        )
        .unwrap();
    assert!(engine.inspect_imported_profile(&sparse_reference).is_ok());
}

#[test]
fn six_retarget_methods_use_typed_wire_outcomes() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("wire-source.3mf");
    let built = temp.path().join("wire-built.3mf");
    let rpc_built = temp.path().join("wire-rpc-built.3mf");
    editable_project(&source, "BambuStudio-2.0", true);
    engine
        .build(&source, &built, &target, RetargetOptions::default())
        .unwrap();

    let requests = [
        json!({"id":1,"method":"listRetargetProfiles","params":{}}),
        json!({"id":2,"method":"inspectRetargetProfile","params":{"profileId":target}}),
        json!({"id":3,"method":"inspectImportedRetargetProfile","params":{"path":built}}),
        json!({"id":4,"method":"preflightRetarget","params":{"sourcePath":source,"target":{"kind":"bundled","targetProfileId":target},"objectExclusion":false}}),
        json!({"id":5,"method":"buildRetarget","params":{"sourcePath":source,"outputPath":rpc_built,"target":{"kind":"bundled","targetProfileId":target},"objectExclusion":false}}),
        json!({"id":6,"method":"validateRetargetOutput","params":{"sourcePath":source,"outputPath":built,"target":{"kind":"bundled","targetProfileId":target},"objectExclusion":false}}),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut output = Vec::new();
    let mut store = InMemoryCatalog::new();
    model_core::serve::run_with_retarget(&mut store, Some(&engine), input.as_bytes(), &mut output)
        .unwrap();
    let responses: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 6);
    assert!(responses.iter().all(|response| response["ok"] == true));
    assert!(responses
        .iter()
        .all(|response| response["result"]["status"] == "ok"));
    assert!(responses[0]["result"]["value"].as_array().unwrap().len() == 15);
    assert!(responses[2]["result"]["value"]["profileId"]
        .as_str()
        .unwrap()
        .starts_with("imported:"));
}

#[test]
fn transport_keeps_outer_errors_and_stable_blocker_codes() {
    let engine = engine();
    let target = target_id(&engine);
    let temp = TempDir::new().unwrap();
    let geometry = temp.path().join("wire-geometry.3mf");
    simple_archive(&geometry, false);
    let requests = [
        json!({"id":1,"method":"preflightRetarget","params":{}}),
        json!({"id":2,"method":"preflightRetarget","params":{"sourcePath":geometry,"target":{"kind":"bundled","targetProfileId":target},"objectExclusion":false}}),
        json!({"id":3,"method":"preflightRetarget","params":{"sourcePath":geometry,"target":{"kind":"bundled","targetProfileId":target,"path":"ignored.3mf"},"objectExclusion":false}}),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut output = Vec::new();
    let mut store = InMemoryCatalog::new();
    model_core::serve::run_with_retarget(&mut store, Some(&engine), input.as_bytes(), &mut output)
        .unwrap();
    let responses: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses[0]["ok"], false);
    assert!(responses[0]["error"]
        .as_str()
        .unwrap()
        .contains("invalid preflightRetarget params"));
    assert_eq!(responses[1]["ok"], true);
    assert_eq!(responses[1]["result"]["status"], "blocked");
    assert_eq!(
        responses[1]["result"]["blockers"][0]["code"],
        "geometryOnly"
    );
    assert_eq!(responses[2]["ok"], false);
    assert!(responses[2]["error"]
        .as_str()
        .unwrap()
        .contains("invalid preflightRetarget params"));
}

fn read_zip_part(path: &Path, name: &str) -> Vec<u8> {
    let file = fs::File::open(path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut part = archive.by_name(name).unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut part, &mut bytes).unwrap();
    bytes
}

fn mutate_project_settings(path: &Path, mutate: impl FnOnce(&mut Value)) {
    let mut settings: Value =
        serde_json::from_slice(&read_zip_part(path, "Metadata/project_settings.config")).unwrap();
    mutate(&mut settings);
    replace_zip_part(
        path,
        "Metadata/project_settings.config",
        serde_json::to_string(&settings).unwrap().as_bytes(),
    );
}

fn zip_part(path: &Path, name: &str) -> Option<PathBuf> {
    let file = fs::File::open(path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    archive.by_name(name).ok().map(|_| path.to_path_buf())
}

fn replace_zip_part(path: &Path, target: &str, replacement: &[u8]) {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut parts = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
        if name.eq_ignore_ascii_case(target) {
            bytes = replacement.to_vec();
        }
        parts.push((name, bytes));
    }
    drop(archive);
    let mut output = Vec::new();
    {
        let mut writer = ZipWriter::new(Cursor::new(&mut output));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in parts {
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap();
    }
    fs::write(path, output).unwrap();
}
