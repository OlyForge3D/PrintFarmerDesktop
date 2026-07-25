use std::collections::BTreeMap;
use std::path::Path;

use super::archive::{
    ArchivePackage, CONTENT_TYPES_PART_FOR_VALIDATION, MODEL_SETTINGS_PART, PROJECT_SETTINGS_PART,
};
use super::guardrails;
use super::profile::{ResolvedTarget, SettingValue};
use super::project::ProjectInspection;
use super::report::{IssueCode, RetargetIssue, SceneCompatibility, ValidationReport};
use super::transform;
use super::{RetargetError, RetargetLimits, RetargetOptions};
use crate::hash::{hash_file, hash_reader};
use crate::rpc::SceneMeshDto;
use crate::scene::SceneMesh;

pub(crate) fn run(
    source_path: &Path,
    output_path: &Path,
    target: &ResolvedTarget,
    options: &RetargetOptions,
    limits: &RetargetLimits,
) -> Result<ValidationReport, RetargetError> {
    let source_snapshot = ArchivePackage::read_bounded(source_path, limits)?;
    let output_snapshot = ArchivePackage::read_bounded(output_path, limits)?;
    run_snapshots(
        source_path,
        output_path,
        &source_snapshot,
        &output_snapshot,
        target,
        options,
        limits,
    )
}

pub(crate) fn run_snapshots(
    source_path: &Path,
    output_path: &Path,
    source_snapshot: &[u8],
    output_snapshot: &[u8],
    target: &ResolvedTarget,
    options: &RetargetOptions,
    limits: &RetargetLimits,
) -> Result<ValidationReport, RetargetError> {
    let source_sha256 = hash_reader(source_snapshot)
        .map_err(|error| RetargetError::source_io(source_path, error))?;
    let output_sha256 = hash_reader(output_snapshot).map_err(RetargetError::io)?;
    let source_archive = ArchivePackage::from_bytes(source_snapshot, limits)?;
    let output_archive = ArchivePackage::from_bytes(output_snapshot, limits)?;
    let source =
        ProjectInspection::inspect_snapshot(source_path, &source_archive, limits, source_snapshot)?;
    let output =
        ProjectInspection::inspect_snapshot(output_path, &output_archive, limits, output_snapshot)?;
    let filaments = target.map_materials(&source.materials)?;
    let expected = transform::build_settings(
        &source,
        &target.machine,
        &target.process,
        &filaments,
        &target.filament_defaults,
        options.object_exclusion,
    )?;

    let before_scene = SceneMeshDto::from(&SceneMesh::from_threemf(&source.mesh));
    let after_scene = SceneMeshDto::from(&SceneMesh::from_threemf(&output.mesh));
    let scene_compatible = before_scene == after_scene;
    let mut differences = Vec::new();
    if !scene_compatible {
        differences
            .push("normalized geometry, hierarchy, transforms, or build order changed".into());
    }
    let settings_match = output.settings == expected.settings;
    let project_settings_bytes_match = output_archive
        .get(PROJECT_SETTINGS_PART)
        .is_some_and(|part| part.bytes == expected.json);
    let model_settings_match = output.model_settings == expected.model_settings;
    let no_stale_parts = output_archive.stale_plan().removed.is_empty();
    let preserved_parts = preserved_parts_match(&source_archive, &output_archive);
    let control_parts_match =
        source_archive.control_parts_match(&output_archive, &source_archive.stale_plan())?;
    let target_identity = output
        .settings
        .get("printer_settings_id")
        .and_then(SettingValue::first)
        == Some(target.machine.name.as_str())
        && output
            .settings
            .get("print_settings_id")
            .and_then(SettingValue::first)
            == Some(target.process.name.as_str());
    let guardrails_valid =
        guardrails::validate(&output.settings, &target.machine, &target.process).is_ok();
    let project_complete = output.blockers.is_empty();
    let source_preserved = source_sha256
        == hash_file(source_path).map_err(|error| RetargetError::source_io(source_path, error))?;

    let mut invariants = BTreeMap::new();
    invariants.insert("sourcePreserved".to_string(), source_preserved);
    invariants.insert("outputHashPresent".to_string(), !output_sha256.is_empty());
    invariants.insert("projectReopened".to_string(), project_complete);
    invariants.insert("targetSettingsExact".to_string(), settings_match);
    invariants.insert(
        "projectSettingsBytesExact".to_string(),
        project_settings_bytes_match,
    );
    invariants.insert(
        "modelSettingsGuardrailsExact".to_string(),
        model_settings_match,
    );
    invariants.insert("targetIdentityExact".to_string(), target_identity);
    invariants.insert("staleArtifactsAbsent".to_string(), no_stale_parts);
    invariants.insert("unknownPartsPreserved".to_string(), preserved_parts);
    invariants.insert("opcControlPartsExact".to_string(), control_parts_match);
    invariants.insert("guardrailsValid".to_string(), guardrails_valid);
    invariants.insert("sceneCompatible".to_string(), scene_compatible);

    let mut errors = output.blockers;
    for (name, valid) in &invariants {
        if !valid {
            let code = match name.as_str() {
                "sourcePreserved" => IssueCode::SourceChanged,
                "sceneCompatible" => IssueCode::SceneIncompatible,
                _ => IssueCode::OutputValidationFailed,
            };
            errors.push(RetargetIssue::blocker(
                code,
                "Output validation failed",
                format!("Post-build invariant '{name}' failed."),
                "Discard the output and retry after correcting the source or target.",
            ));
        }
    }
    let valid = errors.is_empty() && invariants.values().all(|value| *value);
    Ok(ValidationReport {
        valid,
        source_sha256,
        output_sha256,
        source_preserved,
        scene_compatibility: SceneCompatibility {
            compatible: scene_compatible,
            differences,
        },
        invariants,
        warnings: output.warnings,
        errors,
        before_scene,
        after_scene,
    })
}

fn preserved_parts_match(source: &ArchivePackage, output: &ArchivePackage) -> bool {
    let stale = source.stale_plan();
    source.parts.values().all(|part| {
        let lower = part.name.to_ascii_lowercase();
        if stale.removed.contains(&lower)
            || lower == PROJECT_SETTINGS_PART.to_ascii_lowercase()
            || lower == MODEL_SETTINGS_PART.to_ascii_lowercase()
            || lower.ends_with(".rels")
            || lower == CONTENT_TYPES_PART_FOR_VALIDATION
        {
            return true;
        }
        output
            .get(&part.name)
            .is_some_and(|candidate| candidate.bytes == part.bytes)
    }) && output
        .parts
        .values()
        .all(|part| source.has(&part.name) || part.name.eq_ignore_ascii_case(PROJECT_SETTINGS_PART))
}
