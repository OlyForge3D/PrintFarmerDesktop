#![cfg(feature = "step")]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use model_core::model::ModelFormat;
use model_core::scene::{load_scene, SCENE_DTO_VERSION};
use model_core::scene_status::SceneLoadStatus;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    fixtures: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    file: String,
    label: String,
    notes: String,
    expected: ExpectedScene,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedScene {
    vertex_count: usize,
    triangle_count: usize,
    part_count: usize,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
}

#[test]
fn step_fixture_manifest_matches_tessellated_scenes() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("step");
    let manifest: FixtureManifest = serde_json::from_slice(
        &fs::read(fixture_dir.join("manifest.json")).expect("read step manifest"),
    )
    .expect("parse step manifest");

    for fixture in manifest.fixtures {
        let path = fixture_dir.join(&fixture.file);
        let started = Instant::now();
        let scene = load_scene(&path).expect("load STEP fixture");
        let elapsed = started.elapsed();

        assert_eq!(scene.source_format, ModelFormat::Step, "{}", fixture.label);
        assert_eq!(scene.status, SceneLoadStatus::Complete, "{}", fixture.label);
        assert!(
            scene.status_messages.is_empty(),
            "STEP geometry-only import should not emit status messages: {}",
            fixture.label
        );
        assert_eq!(
            scene.vertex_count(),
            fixture.expected.vertex_count,
            "{}",
            fixture.label
        );
        assert_eq!(
            scene.triangle_count(),
            fixture.expected.triangle_count,
            "{}",
            fixture.label
        );
        assert_eq!(
            scene.parts.len(),
            fixture.expected.part_count,
            "{}",
            fixture.label
        );
        for (index, part) in scene.parts.iter().enumerate() {
            assert_eq!(
                part.name,
                format!("Part {}", index + 1),
                "{}",
                fixture.label
            );
            assert_eq!(part.status, SceneLoadStatus::Complete, "{}", fixture.label);
            assert!(
                part.status_detail.is_none(),
                "STEP geometry-only import should not invent status details: {}",
                fixture.label
            );
            assert!(
                part.part_number.is_none(),
                "STEP parser does not expose part numbers: {}",
                fixture.label
            );
            assert!(
                part.material_label.is_none(),
                "STEP parser does not expose material labels: {}",
                fixture.label
            );
        }
        assert_eq!(
            scene.bounds.min, fixture.expected.bounds_min,
            "{}",
            fixture.label
        );
        assert_eq!(
            scene.bounds.max, fixture.expected.bounds_max,
            "{}",
            fixture.label
        );
        assert_eq!(scene.scene_version, SCENE_DTO_VERSION, "{}", fixture.label);
        assert_eq!(scene.objects.len(), 1, "{}", fixture.label);
        assert_eq!(
            scene.objects[0].source_id, "step:model",
            "{}",
            fixture.label
        );
        assert_eq!(scene.root_object_ids, vec!["object-0"], "{}", fixture.label);
        assert_eq!(scene.plates.len(), 1, "{}", fixture.label);
        assert_eq!(
            scene.plates[0].root_object_ids, scene.root_object_ids,
            "{}",
            fixture.label
        );

        eprintln!(
            "{} {} -> {} vertices, {} triangles, {} parts in {:.3} ms ({})",
            fixture.label,
            fixture.file,
            scene.vertex_count(),
            scene.triangle_count(),
            scene.parts.len(),
            elapsed.as_secs_f64() * 1000.0,
            fixture.notes
        );
    }
}

#[test]
fn step_fixture_files_are_discoverable_by_extension() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("step");
    for file_name in ["cube.step", "cylinder.step"] {
        let path = fixture_dir.join(file_name);
        assert_eq!(
            ModelFormat::from_path(Path::new(&path)),
            Some(ModelFormat::Step)
        );
    }
}
