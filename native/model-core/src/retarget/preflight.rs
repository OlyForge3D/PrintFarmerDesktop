use std::collections::BTreeMap;
use std::path::Path;

use super::archive::{ArchivePackage, MODEL_SETTINGS_PART, PROJECT_SETTINGS_PART};
use super::profile::Bundle;
use super::project::ProjectInspection;
use super::report::{
    ChangeRecord, GroupedChanges, IssueCode, PreflightReport, RetargetIssue, SourceSummary,
};
use super::{RetargetError, RetargetLimits, RetargetOptions};
use crate::hash::hash_file;
use crate::rpc::SceneMeshDto;
use crate::scene::SceneMesh;

pub(crate) fn run(
    bundle: &Bundle,
    source_path: &Path,
    options: &RetargetOptions,
    limits: &RetargetLimits,
) -> Result<PreflightReport, RetargetError> {
    let archive = ArchivePackage::open(source_path, limits)?;
    let hash =
        hash_file(source_path).map_err(|error| RetargetError::source_io(source_path, error))?;
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let lower_name = file_name.to_ascii_lowercase();
    let has_gcode = archive.parts.values().any(|part| {
        let lower = part.name.to_ascii_lowercase();
        lower.starts_with("metadata/plate_") && lower.ends_with(".gcode")
    });
    if lower_name.ends_with(".gcode.3mf")
        || (has_gcode && (!archive.has(PROJECT_SETTINGS_PART) || !archive.has(MODEL_SETTINGS_PART)))
    {
        return Ok(PreflightReport {
            accepted: false,
            source: SourceSummary {
                file_name,
                byte_size: archive.compressed_size,
                sha256: hash,
                producer: "unknown".to_string(),
                machine_id: None,
                process_id: None,
                layer_height: None,
                object_count: 0,
                build_item_count: 0,
                plate_count: 0,
                materials: Vec::new(),
                colors: Vec::new(),
            },
            recommendation: None,
            blockers: vec![RetargetIssue::blocker(
                IssueCode::PreSlicedOnly,
                "Pre-sliced print job",
                "This archive contains executable G-code without a complete editable project.",
                "Use the original editable project .3mf.",
            )],
            warnings: Vec::new(),
            proposed_changes: BTreeMap::new(),
            before_scene: None,
        });
    }

    let project = ProjectInspection::inspect(source_path, &archive, limits)?;
    report_from_inspection(bundle, source_path, archive, project, options, hash)
}

fn report_from_inspection(
    bundle: &Bundle,
    source_path: &Path,
    archive: ArchivePackage,
    project: ProjectInspection,
    options: &RetargetOptions,
    hash: String,
) -> Result<PreflightReport, RetargetError> {
    let mut blockers = project.blockers.clone();
    let mut warnings = project.warnings.clone();
    if let Err(error) = bundle.map_materials(&project.materials) {
        let mut blocker = RetargetIssue::blocker(
            error.code,
            "Unsupported filament configuration",
            error.message,
            error.action,
        );
        blocker = blocker.with_setting(error.setting.as_deref().unwrap_or("filament_type"));
        blockers.push(blocker);
    }
    if let Err(error) = super::transform::validate_source_array_lengths(&project, |key| {
        bundle.is_filament_setting_key(key)
    }) {
        let mut blocker = RetargetIssue::blocker(
            error.code,
            "Inconsistent per-filament settings",
            error.message,
            error.action,
        );
        if let Some(part) = error.part {
            blocker = blocker.with_part(part);
        }
        if let Some(setting) = error.setting {
            blocker = blocker.with_setting(setting);
        }
        blockers.push(blocker);
    }
    let stale = archive.stale_plan();
    if stale.stale_slice_count > 0 {
        warnings.push(RetargetIssue::warning(
            IssueCode::StaleSliceArtifactsRemoved,
            "Stale slice artifacts will be removed",
            format!(
                "{} executable or cached slice parts will be removed.",
                stale.stale_slice_count
            ),
            "Re-slice the completed U1 project before printing.",
        ));
    }
    if stale.custom_gcode_count > 0 {
        warnings.push(RetargetIssue::warning(
            IssueCode::CustomGcodeRemoved,
            "Custom layer G-code will be removed",
            "Custom per-layer G-code cannot be safely carried to another printer.",
            "Recreate required safe customizations after reviewing the U1 project.",
        ));
    }
    if stale.signature_count > 0 {
        warnings.push(RetargetIssue::warning(
            IssueCode::DigitalSignaturesRemoved,
            "Invalidated signatures will be removed",
            "Package signatures cannot remain valid after settings are changed.",
            "Re-sign the completed project if required.",
        ));
    }
    if project.has_paint_metadata {
        warnings.push(RetargetIssue::warning(
            IssueCode::PaintMetadataPreservedUnverified,
            "Paint metadata preserved without render verification",
            "Raw paint and seam metadata will be preserved byte-for-byte, but the native scene parser does not render it.",
            "Review painted regions in OrcaSlicer before printing.",
        ));
    }

    let recommendation = project
        .layer_height
        .map(|height| bundle.recommend(height, project.process_id.as_deref()));
    if let Some(recommendation) = &recommendation {
        if recommendation
            .alternatives
            .first()
            .is_some_and(|candidate| {
                (candidate.score - recommendation.recommended.score).abs() < f64::EPSILON
            })
        {
            warnings.push(RetargetIssue::warning(
                IssueCode::ProfileRecommendationAmbiguous,
                "Profile recommendation is tied",
                "Multiple U1 process profiles have the same recommendation score.",
                "Choose the intended target profile explicitly.",
            ));
        }
    }

    let proposed_changes = proposed_changes(&archive, &project, options);
    let before_scene = SceneMeshDto::from(&SceneMesh::from_threemf(&project.mesh));
    Ok(PreflightReport {
        accepted: blockers.is_empty(),
        source: SourceSummary {
            file_name: source_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string(),
            byte_size: archive.compressed_size,
            sha256: hash,
            producer: project.producer,
            machine_id: project.machine_id,
            process_id: project.process_id,
            layer_height: project.layer_height,
            object_count: project.mesh.object_count,
            build_item_count: project.mesh.build_item_count,
            plate_count: project.plate_count,
            materials: project.materials,
            colors: project.colors,
        },
        recommendation,
        blockers,
        warnings,
        proposed_changes,
        before_scene: Some(before_scene),
    })
}

fn proposed_changes(
    archive: &ArchivePackage,
    project: &ProjectInspection,
    options: &RetargetOptions,
) -> GroupedChanges {
    let mut changes = GroupedChanges::new();
    changes
        .entry("machine".to_string())
        .or_default()
        .push(ChangeRecord {
            code: IssueCode::SourceSettingReplaced,
            message:
                "Replace source printer settings and scripts with verified Snapmaker U1 values."
                    .to_string(),
            setting: Some("printer_settings_id".to_string()),
            before: project.machine_id.clone(),
            after: Some("Snapmaker U1 (0.4 nozzle)".to_string()),
        });
    changes
        .entry("process".to_string())
        .or_default()
        .push(ChangeRecord {
        code: IssueCode::SourceSettingReplaced,
        message:
            "Apply the explicitly selected U1 process while preserving allowlisted slicing intent."
                .to_string(),
        setting: Some("print_settings_id".to_string()),
        before: project.process_id.clone(),
        after: None,
    });
    changes
        .entry("objectExclusion".to_string())
        .or_default()
        .push(ChangeRecord {
            code: IssueCode::SourceSettingReplaced,
            message: "Write an explicit Orca string boolean for object exclusion.".to_string(),
            setting: Some("exclude_object".to_string()),
            before: None,
            after: Some(if options.object_exclusion { "1" } else { "0" }.to_string()),
        });
    let stale = archive.stale_plan();
    if !stale.removed.is_empty() {
        changes
            .entry("archive".to_string())
            .or_default()
            .push(ChangeRecord {
                code: IssueCode::StaleSliceArtifactsRemoved,
                message: format!(
                    "Remove {} stale, executable, custom-G-code, or signature parts.",
                    stale.removed.len()
                ),
                setting: None,
                before: Some(stale.removed.len().to_string()),
                after: Some("0".to_string()),
            });
    }
    changes
}
