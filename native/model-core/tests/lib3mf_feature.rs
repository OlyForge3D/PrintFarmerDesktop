#![cfg(feature = "lib3mf")]

use std::path::PathBuf;

use model_core::model::ModelFormat;
use model_core::scene::load_scene;
use model_core::scene_status::SceneLoadStatus;
use model_core::threemf::parse_file_with_lib3mf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[test]
fn lib3mf_feature_validates_standard_fixture_into_scene_manifest() {
    let path = fixture_path("lib3mf_standard_validation.3mf");

    let mesh = parse_file_with_lib3mf(&path)
        .unwrap_or_else(|error| panic!("failed to parse fixture with lib3mf: {error}"));
    assert_eq!(mesh.unit, "millimeter");
    assert_eq!(mesh.object_count, 3);
    assert_eq!(mesh.build_item_count, 2);
    assert_eq!(mesh.status, SceneLoadStatus::Partial);
    assert_eq!(mesh.vertex_count(), 6);
    assert_eq!(mesh.triangle_count(), 2);
    assert_eq!(mesh.bounds.min, [0.0, 0.0, 0.0]);
    assert_eq!(mesh.bounds.max, [6.0, 7.0, 0.0]);

    assert_eq!(mesh.parts.len(), 2);
    assert_eq!(mesh.parts[0].name, "Assembly");
    assert_eq!(mesh.parts[0].status, SceneLoadStatus::Complete);
    assert_eq!(mesh.parts[0].part_number.as_deref(), Some("ASM-1"));
    assert_eq!(
        mesh.parts[0].material_label.as_deref(),
        Some("Orange PLA (#FF6600)")
    );

    assert_eq!(mesh.parts[1].name, "Mixed Support");
    assert_eq!(mesh.parts[1].status, SceneLoadStatus::Partial);
    assert_eq!(mesh.parts[1].part_number.as_deref(), Some("SUP-1"));
    assert!(mesh.parts[1]
        .status_detail
        .as_deref()
        .is_some_and(|detail| detail.contains("per-corner triangle properties")));
}

#[test]
fn load_scene_uses_lib3mf_feature_path() {
    let path = fixture_path("lib3mf_standard_validation.3mf");
    let scene = load_scene(&path).unwrap_or_else(|error| panic!("load_scene failed: {error}"));

    assert_eq!(scene.source_format, ModelFormat::ThreeMf);
    assert_eq!(scene.status, SceneLoadStatus::Partial);
    assert_eq!(scene.parts.len(), 2);
    assert_eq!(
        scene.parts[0].material_label.as_deref(),
        Some("Orange PLA (#FF6600)")
    );
    assert!(
        scene.status_messages.iter().any(|message| {
            message.contains("non-model type Support")
                || message.contains("non-model type SolidSupport")
        }),
        "expected lib3mf validation status messages for support object types"
    );
}
