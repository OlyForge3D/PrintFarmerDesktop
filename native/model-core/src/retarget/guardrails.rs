use std::collections::BTreeMap;

use super::profile::{ResolvedProfile, SettingValue};
use super::report::{ChangeRecord, GroupedChanges, IssueCode};
use super::RetargetError;

pub(crate) const SPEED_KEYS: &[&str] = &[
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
];

pub(crate) const ACCELERATION_KEYS: &[&str] = &[
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

pub(crate) fn apply(
    settings: &mut BTreeMap<String, SettingValue>,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
    changes: &mut GroupedChanges,
) -> Result<(), RetargetError> {
    for key in SPEED_KEYS {
        let Some(current) = settings.get(*key).cloned() else {
            continue;
        };
        let ceiling = target_ceiling(key, machine, process)?;
        let clamped = clamp_value(key, &current, ceiling)?;
        if clamped != current {
            record_change(changes, key, &current, &clamped);
            settings.insert((*key).to_string(), clamped);
        }
    }
    for key in ACCELERATION_KEYS {
        let Some(current) = settings.get(*key).cloned() else {
            continue;
        };
        let ceiling = target_ceiling(key, machine, process)?;
        let clamped = clamp_value(key, &current, ceiling)?;
        if clamped != current {
            record_change(changes, key, &current, &clamped);
            settings.insert((*key).to_string(), clamped);
        }
    }
    Ok(())
}

pub(crate) fn validate(
    settings: &BTreeMap<String, SettingValue>,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
) -> Result<(), RetargetError> {
    for key in SPEED_KEYS {
        if let Some(value) = settings.get(*key) {
            let ceiling = target_ceiling(key, machine, process)?;
            validate_value(key, value, ceiling)?;
        }
    }
    for key in ACCELERATION_KEYS {
        if let Some(value) = settings.get(*key) {
            let ceiling = target_ceiling(key, machine, process)?;
            validate_value(key, value, ceiling)?;
        }
    }
    Ok(())
}

pub(crate) fn is_motion_key(key: &str) -> bool {
    SPEED_KEYS.contains(&key) || ACCELERATION_KEYS.contains(&key)
}

pub(crate) fn validate_source_override(key: &str, value: &str) -> Result<(), RetargetError> {
    clamp_scalar(key, value, 1.0).map(|_| ())
}

pub(crate) fn clamp_override(
    key: &str,
    value: &str,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
) -> Result<String, RetargetError> {
    clamp_scalar(key, value, target_ceiling(key, machine, process)?)
}

fn target_ceiling(
    key: &str,
    machine: &ResolvedProfile,
    process: &ResolvedProfile,
) -> Result<f64, RetargetError> {
    if SPEED_KEYS.contains(&key) {
        process
            .settings
            .get(key)
            .and_then(SettingValue::finite_positive)
            .or_else(|| speed_machine_ceiling(machine, key))
            .ok_or_else(|| unsafe_value(key, "no positive target speed ceiling exists"))
    } else if ACCELERATION_KEYS.contains(&key) {
        process
            .settings
            .get(key)
            .and_then(SettingValue::finite_positive)
            .or_else(|| acceleration_machine_ceiling(machine, key))
            .ok_or_else(|| unsafe_value(key, "no positive target acceleration ceiling exists"))
    } else {
        Err(unsafe_value(key, "setting has no motion guardrail"))
    }
}

fn speed_machine_ceiling(machine: &ResolvedProfile, _key: &str) -> Option<f64> {
    let mut candidates = Vec::new();
    push_positive(&mut candidates, machine.settings.get("machine_max_speed_x"));
    push_positive(&mut candidates, machine.settings.get("machine_max_speed_y"));
    candidates.into_iter().reduce(f64::min)
}

fn acceleration_machine_ceiling(machine: &ResolvedProfile, key: &str) -> Option<f64> {
    let setting = if key.contains("travel") {
        "machine_max_acceleration_travel"
    } else {
        "machine_max_acceleration_extruding"
    };
    first_positive(machine.settings.get(setting)).or_else(|| {
        let mut candidates = Vec::new();
        push_positive(
            &mut candidates,
            machine.settings.get("machine_max_acceleration_x"),
        );
        push_positive(
            &mut candidates,
            machine.settings.get("machine_max_acceleration_y"),
        );
        candidates.into_iter().reduce(f64::min)
    })
}

fn push_positive(values: &mut Vec<f64>, setting: Option<&SettingValue>) {
    if let Some(value) = first_positive(setting) {
        values.push(value);
    }
}

fn first_positive(setting: Option<&SettingValue>) -> Option<f64> {
    setting?
        .as_list()
        .into_iter()
        .filter_map(|value| value.trim().parse::<f64>().ok())
        .find(|value| value.is_finite() && *value > 0.0)
}

fn clamp_value(
    key: &str,
    value: &SettingValue,
    ceiling: f64,
) -> Result<SettingValue, RetargetError> {
    match value {
        SettingValue::Scalar(value) => Ok(SettingValue::Scalar(clamp_scalar(key, value, ceiling)?)),
        SettingValue::List(values) => values
            .iter()
            .map(|value| clamp_scalar(key, value, ceiling))
            .collect::<Result<Vec<_>, _>>()
            .map(SettingValue::List),
    }
}

fn clamp_scalar(key: &str, value: &str, ceiling: f64) -> Result<String, RetargetError> {
    let trimmed = value.trim();
    let parsed = trimmed.parse::<f64>();
    let safe = match parsed {
        Ok(number) if number.is_finite() && number > 0.0 => number.min(ceiling),
        Ok(0.0) => ceiling,
        _ if trimmed.ends_with('%') => ceiling,
        _ => {
            return Err(unsafe_value(
                key,
                format!("'{value}' is not a finite speed or acceleration"),
            ))
        }
    };
    Ok(format_decimal(safe))
}

fn validate_value(key: &str, value: &SettingValue, ceiling: f64) -> Result<(), RetargetError> {
    for scalar in value.as_list() {
        let parsed = scalar
            .trim()
            .parse::<f64>()
            .map_err(|_| unsafe_value(key, "value is not numeric"))?;
        if !parsed.is_finite() || parsed <= 0.0 || parsed > ceiling {
            return Err(unsafe_value(
                key,
                format!("value {parsed} exceeds safe target ceiling {ceiling}"),
            ));
        }
    }
    Ok(())
}

fn format_decimal(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn record_change(
    changes: &mut GroupedChanges,
    key: &str,
    before: &SettingValue,
    after: &SettingValue,
) {
    changes
        .entry("guardrails".to_string())
        .or_default()
        .push(ChangeRecord {
            code: IssueCode::SettingClamped,
            message: format!("Clamped '{key}' to the verified U1 ceiling."),
            setting: Some(key.to_string()),
            before: Some(value_text(before)),
            after: Some(value_text(after)),
        });
}

fn value_text(value: &SettingValue) -> String {
    match value {
        SettingValue::Scalar(value) => value.clone(),
        SettingValue::List(values) => values.join(","),
    }
}

fn unsafe_value(key: &str, message: impl Into<String>) -> RetargetError {
    RetargetError::new(
        IssueCode::UnsafeSettingValue,
        format!("unsafe setting '{key}': {}", message.into()),
        "Choose another target or correct the source setting.",
    )
    .with_setting(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_clamp_replaces_percentages_and_caps_numbers() {
        assert_eq!(clamp_scalar("speed", "150%", 300.0).unwrap(), "300");
        assert_eq!(clamp_scalar("speed", "500", 300.0).unwrap(), "300");
        assert_eq!(clamp_scalar("speed", "120", 300.0).unwrap(), "120");
    }
}
