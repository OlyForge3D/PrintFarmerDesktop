#![cfg(feature = "lib3mf")]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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

fn stage_test_library() {
    static STAGED: OnceLock<Result<(), String>> = OnceLock::new();
    STAGED
        .get_or_init(stage_test_library_once)
        .as_ref()
        .unwrap_or_else(|error| panic!("failed to stage lib3mf test library: {error}"));
}

fn stage_test_library_once() -> Result<(), String> {
    let extension = if cfg!(windows) {
        "dll"
    } else if cfg!(target_os = "macos") {
        "dylib"
    } else {
        "so"
    };
    let exe_dir = std::env::current_exe()
        .map_err(|error| format!("unable to locate test executable: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "test executable has no parent directory".to_string())?;
    let staged = exe_dir.join(format!("lib3mf.{extension}"));
    if staged.exists() {
        return Ok(());
    }

    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join(".cargo"))
        })
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
        .ok_or_else(|| "unable to determine Cargo home for lib3mf test staging".to_string())?;
    let checkouts = cargo_home.join("git").join("checkouts");
    let source = std::fs::read_dir(&checkouts)
        .map_err(|error| format!("unable to read {checkouts:?}: {error}"))?
        .filter_map(Result::ok)
        .find_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("lib3mf_rs-") {
                return None;
            }
            std::fs::read_dir(entry.path())
                .ok()?
                .filter_map(Result::ok)
                .map(|revision| {
                    revision
                        .path()
                        .join("libraries")
                        .join(format!("lib3mf.{extension}"))
                })
                .find(|candidate| candidate.is_file())
        })
        .ok_or_else(|| format!("unable to find lib3mf.{extension} under {checkouts:?}"))?;
    std::fs::copy(&source, &staged)
        .map_err(|error| format!("unable to stage {source:?} to {staged:?}: {error}"))?;
    Ok(())
}

#[test]
fn lib3mf_feature_validates_standard_fixture_into_scene_manifest() {
    stage_test_library();
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
    stage_test_library();
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

#[test]
fn lib3mf_feature_marks_empty_components_build_item_unsupported() {
    stage_test_library();
    let path = fixture_path("lib3mf_empty_components_unsupported.3mf");

    let mesh = parse_file_with_lib3mf(&path)
        .unwrap_or_else(|error| panic!("failed to parse unsupported fixture with lib3mf: {error}"));

    assert_eq!(mesh.status, SceneLoadStatus::Unsupported);
    assert_eq!(mesh.parts.len(), 2);
    assert_eq!(mesh.parts[0].status, SceneLoadStatus::Complete);
    assert_eq!(mesh.parts[1].name, "Placeholder Assembly");
    assert_eq!(mesh.parts[1].status, SceneLoadStatus::Unsupported);
    assert_eq!(mesh.parts[1].triangle_count, 0);
    assert!(mesh.parts[1]
        .status_detail
        .as_deref()
        .is_some_and(|detail| detail.contains("did not yield triangle geometry")));
    assert!(mesh.status_messages.iter().any(|message| {
        message.contains("build item for object 2 did not yield triangle geometry")
    }));
}

#[test]
fn lib3mf_feature_falls_back_when_native_validation_rejects_fixture() {
    stage_test_library();
    let path = fixture_path("lib3mf_invalid_namespace.3mf");

    let mesh = parse_file_with_lib3mf(&path).unwrap_or_else(|error| {
        panic!("expected graceful fallback when lib3mf rejects the fixture: {error}")
    });

    assert_eq!(mesh.status, SceneLoadStatus::Unsupported);
    assert_eq!(mesh.parts.len(), 1);
    assert_eq!(mesh.parts[0].name, "Invalid Namespace");
    assert_eq!(mesh.parts[0].status, SceneLoadStatus::Complete);
    assert!(mesh.status_messages.iter().any(|message| {
        message.contains("native lib3mf validation failed, falling back to internal parser")
    }));
}
