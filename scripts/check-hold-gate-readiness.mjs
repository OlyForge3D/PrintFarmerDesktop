// Reports how close `development` is to the enforcement channel #480 chose,
// and refuses to let "some settings look right" pass for "the gate is live."
//
// #480 measured that a BLOCKING review verdict binds nothing here: comments
// are invisible to the merge gate, review states can never move off empty
// (self-review is 422'd — #206, #187), and the `hold:sequenced` label reads
// like a lock but is not a required context (`.squad/holds.md`). Of the two
// channels #480 names, only one is even possible in this single-collaborator
// repository:
//
//   (b) required_approving_review_count >= 1 — categorically ruled out.
//       `jpapiez` is the sole collaborator and GitHub returns 422 on
//       self-approval and self-request-changes (#206, #187). No amount of
//       engineering fixes an API refusal; only a second reviewing identity
//       would, and #111/#151/#206/#187 all name that as the shared revisit
//       trigger. `check-protection-assumptions.mjs` already fails the day a
//       second collaborator appears.
//
//   (a) `Sequencing hold` becomes a required status context — adopted, and
//       the one this module tracks. It is content/operation-based rather
//       than identity-based (it reads a label, not an approving account), so
//       it does not hit the self-review wall. It had two prerequisites:
//
//         1. `.github/workflows/sequencing-hold.yml` must subscribe to
//            `merge_group` and reclassify from `# merge-queue: advisory` to
//            `# merge-queue: reports` — otherwise a required context this
//            workflow emits would never report for a queued entry and the
//            queue would hang rather than fail (#122). DONE: landed by a
//            session using a credential with the `workflow` OAuth scope
//            (the active `GH_TOKEN` in a prior session lacked it; a second,
//            non-active keyring account on the same machine had it, and
//            using it required unsetting `GH_TOKEN` in-process so `gh` and
//            `git push` would pick up the other credential instead — see
//            `.squad/holds.md`'s #480 follow-up section for the measured
//            steps). `check-sequencing-hold.mjs` needed NO change for this:
//            its `resolvePullRequestNumber` (shared with
//            `check-pr-closure-scope.mjs`) already parses a merge-queue head
//            ref into a PR number, and label-fetching is a plain REST call
//            keyed on that number — the gap was the workflow trigger
//            declaration alone.
//         2. The repository owner adds `"Sequencing hold"` to
//            `development`'s `required_status_checks.contexts` (a
//            branch-protection write this session does not perform — see
//            `.squad/decisions/inbox/ripley-480-sequencing-hold-required-context.md`).
//            STILL PENDING, deliberately: the active token in this session
//            independently carries `admin: true` on this repository, so this
//            is not a permission block either, but #480's own reasoning is
//            adopted rather than re-derived — a gate that the person
//            proposing it can silently install is not a gate. Left for the
//            repository owner to run explicitly.
//
// (1) is therefore done; (2) is the sole remaining blocker this script
// reports. This script is what "verifiable work around the gap" looks like:
// it reads the live facts and says exactly which of the two remains, so
// neither has to be taken on anyone's word.

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverToken,
  discoverRepository,
  declaredClassOf,
  triggersOf,
  readWorkflows,
} from './check-merge-queue-contexts.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const HOLD_CONTEXT_NAME = 'Sequencing hold';
export const HOLD_WORKFLOW_FILE = 'sequencing-hold.yml';

/**
 * Pure. Takes the already-read workflow source and the already-fetched
 * branch-protection/ruleset facts, and says what is missing.
 *
 * Deliberately does not special-case "the merge queue ruleset happens to be
 * disabled today" into a pass. A ruleset going from disabled to active with
 * no announcement is exactly the drift `check-protection-assumptions.mjs`
 * was built to catch (`rulesets` went from `[]` to one entry between two
 * consecutive days in #151), so this reports the workflow gap as a blocker
 * unconditionally rather than only when the queue happens to be watched.
 */
export function evaluateHoldGateReadiness({
  workflowContents,
  requiredContexts,
  rulesets = [],
}) {
  if (typeof workflowContents !== 'string') {
    throw new TypeError(
      `workflowContents must be the text of ${HOLD_WORKFLOW_FILE}, received ${typeof workflowContents}`,
    );
  }
  if (!Array.isArray(requiredContexts)) {
    throw new TypeError(
      `requiredContexts must be an array, received ${typeof requiredContexts}`,
    );
  }

  const declared = declaredClassOf(workflowContents, HOLD_WORKFLOW_FILE);
  const triggers = triggersOf(workflowContents, HOLD_WORKFLOW_FILE);
  const workflowReports =
    declared === 'reports' && triggers.includes('merge_group');

  const contextRequired = requiredContexts.includes(HOLD_CONTEXT_NAME);

  const mergeQueueActive = rulesets.some(
    (r) =>
      String(r?.enforcement ?? '').toLowerCase() === 'active' &&
      (r?.target === undefined ||
        String(r.target).toLowerCase() === 'branch') &&
      String(r?.name ?? '')
        .toLowerCase()
        .includes('merge queue'),
  );

  const blockers = [];
  if (!workflowReports) {
    blockers.push({
      id: 'workflow-merge-group',
      owner: 'a session with the `workflow` OAuth scope',
      detail:
        `${HOLD_WORKFLOW_FILE} is classified "${declared}" and does not ` +
        'subscribe to merge_group. Add `merge_group:` to its `on:` block ' +
        'and change its header to `# merge-queue: reports` before this ' +
        'context may safely be required — otherwise a queued entry would ' +
        'hang rather than fail the moment the (currently disabled) ' +
        '"development merge queue" ruleset is turned on. ' +
        'check-sequencing-hold.mjs needs no change: resolvePullRequestNumber ' +
        'already parses a merge-queue head ref into a PR number.',
    });
  }
  if (!contextRequired) {
    blockers.push({
      id: 'branch-protection-context',
      owner: 'the repository owner (branch-protection admin write)',
      detail:
        `development's required_status_checks.contexts does not yet include ` +
        `"${HOLD_CONTEXT_NAME}". Exact call: ` +
        'gh api -X PUT repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection/required_status_checks ' +
        '-f strict=true -F "contexts[]=Desktop (windows-latest)" ... (all 8 existing names) ' +
        `-F "contexts[]=${HOLD_CONTEXT_NAME}".`,
    });
  }
  if (contextRequired && !workflowReports && mergeQueueActive) {
    blockers.push({
      id: 'live-deadlock',
      owner: 'URGENT — the repository owner',
      detail:
        `"${HOLD_CONTEXT_NAME}" is a required context, the merge queue is ` +
        'active, and the workflow does not report under merge_group: every ' +
        'queued entry is hanging right now. Disable the merge queue ' +
        'ruleset or fix the workflow trigger immediately.',
    });
  }

  return {
    workflowReports,
    contextRequired,
    mergeQueueActive,
    ready: workflowReports && contextRequired,
    blockers,
  };
}

export function formatReadiness(result) {
  const lines = [
    result.ready
      ? `"${HOLD_CONTEXT_NAME}" is a live, safe required context. The #480 gate is enforcing.`
      : `"${HOLD_CONTEXT_NAME}" is NOT yet enforcing. ${result.blockers.length} blocker(s) remain.`,
  ];
  for (const b of result.blockers) {
    lines.push('', `  [${b.id}] owner: ${b.owner}`, `    ${b.detail}`);
  }
  return lines.join('\n');
}

async function main() {
  const token = discoverToken(process.env);
  const repositoryName = discoverRepository(process.env);
  if (token === null || repositoryName === null) {
    const missing = [];
    if (token === null) missing.push('no GITHUB_TOKEN and no `gh auth token`');
    if (repositoryName === null)
      missing.push('no GITHUB_REPOSITORY and no origin remote');
    console.log(`Skipped the live readiness check: ${missing.join('; ')}.`);
    console.log(
      'This run has NOT checked whether the #480 hold gate is enforcing.',
    );
    return;
  }

  const { owner, repo } = resolveRepository(
    repositoryName === ''
      ? process.env
      : { ...process.env, GITHUB_REPOSITORY: repositoryName },
  );

  const api = async (endpoint) => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}${endpoint}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `${endpoint} request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  };

  const [protection, rulesets] = await Promise.all([
    api('/branches/development/protection'),
    api('/rulesets'),
  ]);

  const workflowsDir = path.resolve(
    import.meta.dirname,
    '..',
    '.github',
    'workflows',
  );
  const workflows = readWorkflows(workflowsDir);
  const holdWorkflow = workflows.find((w) => w.file === HOLD_WORKFLOW_FILE);
  if (!holdWorkflow) {
    throw new Error(`could not find ${HOLD_WORKFLOW_FILE} on disk`);
  }

  const result = evaluateHoldGateReadiness({
    workflowContents: holdWorkflow.contents,
    requiredContexts: protection?.required_status_checks?.contexts ?? [],
    rulesets,
  });
  console.log(formatReadiness(result));
  process.exitCode = result.ready ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Unable to check hold gate readiness: ${error.message}`);
    process.exitCode = 2;
  });
}
