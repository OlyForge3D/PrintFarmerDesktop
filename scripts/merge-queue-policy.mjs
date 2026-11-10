// Shared by the live policy reader and the staged protection-assumption check.
export const REQUIRED_CONTEXT_NAMES = Object.freeze([
  'Dependency advisories',
  'Design detector',
  'Desktop (macos-latest)',
  'Desktop (windows-latest)',
  'Release package (macos-latest)',
  'Release package (windows-latest)',
  'Sequencing hold',
  'Sidecar (macos-latest)',
  'Sidecar (windows-latest)',
]);

export const QUEUE_PARAMETERS = Object.freeze({
  merge_method: 'SQUASH',
  max_entries_to_build: 1,
  min_entries_to_merge: 1,
  max_entries_to_merge: 1,
  min_entries_to_merge_wait_minutes: 0,
  grouping_strategy: 'ALLGREEN',
  check_response_timeout_minutes: 120,
});

export function validQueueRuleset(ruleset) {
  const refs = ruleset?.conditions?.ref_name;
  const queues = ruleset?.rules?.filter((rule) => rule.type === 'merge_queue');
  return (
    ruleset?.enforcement === 'active' &&
    ruleset.target === 'branch' &&
    refs?.include?.length === 1 &&
    refs.include[0] === 'refs/heads/development' &&
    Array.isArray(refs.exclude) &&
    refs.exclude.length === 0 &&
    Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length === 0 &&
    queues?.length === 1 &&
    Object.entries(QUEUE_PARAMETERS).every(
      ([key, value]) => queues[0].parameters?.[key] === value,
    )
  );
}

export function evaluateQueuePolicy({ protection, rules, rulesets }) {
  if (!Array.isArray(rules) || !Array.isArray(rulesets)) {
    throw new Error(
      'Effective branch rules and full ruleset details are required.',
    );
  }
  const status = protection?.required_status_checks;
  if (
    typeof status?.strict !== 'boolean' ||
    !Array.isArray(status.checks) ||
    !Array.isArray(status.contexts) ||
    status.contexts.some(
      (context) => !status.checks.some((check) => check.context === context),
    )
  ) {
    throw new Error(
      'Required status checks or strict policy could not be read.',
    );
  }
  const checks = status.checks.map(({ context, app_id }) => ({
    context,
    appId: app_id,
  }));
  for (const rule of rules.filter(
    (rule) => rule.type === 'required_status_checks',
  )) {
    if (!Array.isArray(rule.parameters?.required_status_checks)) {
      throw new Error('Malformed effective required-status rule.');
    }
    checks.push(
      ...rule.parameters.required_status_checks.map((check) => ({
        context: check.context,
        appId: check.integration_id,
      })),
    );
  }
  if (
    checks.some(
      (check) => typeof check.context !== 'string' || check.appId !== 15368,
    ) ||
    REQUIRED_CONTEXT_NAMES.some(
      (name) => !checks.some((check) => check.context === name),
    )
  ) {
    throw new Error(
      'All nine required checks must retain their GitHub Actions app binding (15368).',
    );
  }
  const queues = rules.filter((rule) => rule.type === 'merge_queue');
  if (queues.length === 0) {
    if (!status.strict)
      throw new Error(
        'Unsafe transition: strict=false without an active merge queue.',
      );
    return { mode: 'strict', checks };
  }
  if (
    queues.length !== 1 ||
    !rulesets.some(
      (ruleset) =>
        ruleset.id === queues[0].ruleset_id && validQueueRuleset(ruleset),
    ) ||
    !Object.entries(QUEUE_PARAMETERS).every(
      ([key, value]) => queues[0].parameters?.[key] === value,
    )
  ) {
    throw new Error(
      'Queue must be development-only, non-bypassable, ALLGREEN, squash, and serialized with the documented settings.',
    );
  }
  return { mode: 'queue', checks };
}
