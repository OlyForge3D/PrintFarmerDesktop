// Refuses a branch ruleset that would deadlock a merge queue.
//
// No shebang: this module is imported by tests/mergeQueueReadiness.test.ts, and
// vite's transform does not strip one the way node does. The same lesson is
// recorded at the top of check-pr-closure-scope.mjs and check-sequencing-hold.mjs.
//
// #122 established the failure: a required status check that no workflow emits
// for a `merge_group` event leaves the queue entry Pending forever. It does not
// fail — it hangs, with no red anywhere to look at. PR #147 fixed it for ci.yml
// by adding the trigger, and tests/ciWorkflowTriggers.test.ts pins that trigger.
//
// That guard is necessary and not sufficient, and the gap is the reason this
// file exists. It checks ONE workflow. Since it was written, two more workflows
// that emit check runs on pull requests have been added — pr-closure-scope.yml
// and sequencing-hold.yml — and NEITHER subscribes to `merge_group`. Both say so,
// in prose, in their own headers, in the imperative:
//
//     "this workflow does not report under `merge_group`, so it MUST NOT be
//      added to a branch ruleset's required contexts while that remains true"
//
// The constraint is therefore documented twice, by two authors, and enforced
// zero times. Nothing reads those comments. Making either context required is a
// checkbox in a settings page, it is a reasonable-looking thing to do to a check
// that runs on every pull request, and the resulting deadlock is silent.
//
// This module makes the constraint machine-readable in both directions:
//
//   evaluateWorkflowClassification  the repo side — every workflow states which
//                                   class it is in, and the statement is checked
//                                   against its actual triggers. Enumerates the
//                                   directory, so a NEW workflow fails until
//                                   somebody classifies it.
//   evaluateRequiredContexts        the ruleset side — every required context
//                                   must be emitted by a workflow that reports
//                                   under merge_group.
//
// Deliberately NOT wired to a new workflow of its own. A new pull-request-only
// workflow is the exact hazard this file guards against, and adding one to guard
// against it would make the problem one larger. The repo-side check runs inside
// the vitest suite, which runs inside ci.yml, which does subscribe to
// merge_group. The ruleset-side check reads live branch protection and is meant
// to be run by a human before enabling the queue.

import process from 'node:process';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRepository } from './check-pr-closure-scope.mjs';

/**
 * Find a credential for the live half without demanding it be exported.
 *
 * The script previously read `GITHUB_TOKEN`/`GH_TOKEN` and nothing else, so on a
 * developer machine with `gh` logged in it reported "not set" for a credential
 * that was sitting right there and skipped the ruleset check. `gh auth token` is
 * the same credential every other squad workflow already uses.
 *
 * `run` is injected so the discovery can be tested without a `gh` on PATH, and
 * `SKIP_CREDENTIAL_DISCOVERY` exists so the offline tests stay offline by
 * construction rather than by whether the runner happens to be logged in.
 */
export function discoverToken(env = process.env, run = spawnSync) {
  const fromEnv = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '';
  if (fromEnv !== '') return fromEnv;
  if ((env.SKIP_CREDENTIAL_DISCOVERY ?? '') !== '') return null;
  // `gh` is a .cmd shim on Windows, which spawn cannot exec directly. The
  // obvious workaround is `shell: true`, and node deprecates that with args
  // (DEP0190) precisely because the arguments are concatenated rather than
  // escaped. Naming the shim explicitly keeps the argument vector intact.
  const candidates =
    process.platform === 'win32' ? ['gh.cmd', 'gh.exe', 'gh'] : ['gh'];
  for (const command of candidates) {
    let result;
    try {
      result = run(command, ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    if (!result || result.error || result.status !== 0) continue;
    const token = String(result.stdout ?? '').trim();
    if (token !== '') return token;
  }
  return null;
}

/**
 * Resolve which repository to ask about.
 *
 * Returns the value to use for `GITHUB_REPOSITORY`, `''` when the environment
 * already carries enough for `resolveRepository` to work it out on its own, and
 * `null` when there is genuinely nothing to go on.
 */
export function discoverRepository(env = process.env, run = spawnSync) {
  if ((env.GITHUB_REPOSITORY ?? '') !== '') return env.GITHUB_REPOSITORY;
  if ((env.GITHUB_REPOSITORY_OWNER ?? '') !== '') return '';
  if ((env.SKIP_CREDENTIAL_DISCOVERY ?? '') !== '') return null;
  let result;
  try {
    result = run('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const url = String(result.stdout ?? '').trim();
  // Both forms git uses: https://host/owner/name(.git) and git@host:owner/name(.git)
  const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export { resolveRepository };

/**
 * How a workflow relates to a merge queue.
 *
 * `reports` is the only class whose contexts may appear in a branch ruleset.
 * The other two are named separately rather than lumped as "not required"
 * because they are unsafe for different reasons, and a future reader deciding
 * where a new workflow belongs needs the distinction:
 *
 *   advisory     runs on pull_request, emits a check run, does NOT report for a
 *                queued entry. Requiring it deadlocks the queue.
 *   publication  never runs on pull_request at all. Requiring it deadlocks
 *                every pull request immediately, queue or no queue.
 */
export const MERGE_QUEUE_CLASSES = Object.freeze([
  'reports',
  'advisory',
  'publication',
]);

// Captures hyphens and digits deliberately, though no valid class contains
// them. A narrower pattern fails to match a malformed value at all, so
// `# merge-queue: probably-fine` is reported as a MISSING declaration — sending
// the reader to look for a line that is sitting right in front of them. Capture
// broadly, then reject by value, so the message names what is actually wrong.
const DECLARATION = /^#\s*merge-queue:\s*([A-Za-z0-9_-]+)\s*$/;

/**
 * The class a workflow declares about itself.
 *
 * Throws on a missing or unrecognised declaration rather than defaulting.
 * A default would be the whole defect back again: the safe-looking default is
 * `advisory`, and an unclassified ci.yml would silently become "not required"
 * — a guard that reports everything is fine because it stopped looking.
 */
export function declaredClassOf(contents, file = '<workflow>') {
  if (typeof contents !== 'string') {
    throw new TypeError(
      `${file}: workflow contents must be a string, received ${typeof contents}`,
    );
  }
  const declared = contents
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = DECLARATION.exec(line.trim());
      return match?.[1] === undefined ? [] : [match[1]];
    })
    .at(0);
  if (declared === undefined) {
    throw new Error(
      `${file}: no "# merge-queue: <class>" declaration. Every workflow must ` +
        `state whether its check runs report for a queued entry. ` +
        `Expected one of: ${MERGE_QUEUE_CLASSES.join(', ')}.`,
    );
  }
  if (!MERGE_QUEUE_CLASSES.includes(declared)) {
    throw new Error(
      `${file}: unrecognised merge-queue class "${declared}". ` +
        `Expected one of: ${MERGE_QUEUE_CLASSES.join(', ')}.`,
    );
  }
  return declared;
}

/**
 * Event names a workflow subscribes to, sorted.
 *
 * Textual, matching tests/ciWorkflowTriggers.test.ts: the repository ships no
 * YAML parser and this change does not add one. Splitting on /\r?\n/ rather
 * than '\n' is deliberate — a workflow authored on Windows is still a workflow,
 * and a parser that reports "no triggers" for one names the wrong subject.
 */
export function triggersOf(contents, file = '<workflow>') {
  const lines = String(contents).split(/\r?\n/);
  const start = lines.indexOf('on:');
  if (start < 0) {
    throw new Error(`${file}: no top-level "on:" block`);
  }
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^\S/.test(line));
  return (end < 0 ? body : body.slice(0, end))
    .flatMap((line) => {
      const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    })
    .sort();
}

/**
 * The check-run names GitHub renders from a workflow.
 *
 * Matrix jobs expand, because a ruleset pins the rendered string
 * ("Desktop (windows-latest)"), not the job key.
 */
export function renderedContexts(contents, file = '<workflow>') {
  const lines = String(contents).split(/\r?\n/);
  const start = lines.indexOf('jobs:');
  if (start < 0) {
    throw new Error(`${file}: no top-level "jobs:" block`);
  }
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^\S/.test(line));
  const section = end < 0 ? body : body.slice(0, end);

  const starts = [];
  section.forEach((line, index) => {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1] !== undefined) starts.push({ key: match[1], index });
  });

  return starts
    .flatMap(({ key, index }, position) => {
      const next = starts[position + 1]?.index ?? section.length;
      const jobBody = section.slice(index + 1, next);
      const name = jobBody
        .flatMap((line) => {
          const match = /^ {4}name:\s*(.+)$/.exec(line);
          return match?.[1] === undefined ? [] : [match[1].trim()];
        })
        .at(0);
      if (name === undefined) {
        throw new Error(`${file}: job "${key}" has no name`);
      }
      const matrix = jobBody
        .flatMap((line) => {
          const match = /^ {8}os:\s*\[(.+)\]\s*$/.exec(line);
          return match?.[1] === undefined ? [] : [match[1]];
        })
        .at(0);
      if (matrix === undefined) return [name];
      return matrix
        .split(',')
        .map((value) => name.replaceAll('${{ matrix.os }}', value.trim()));
    })
    .sort();
}

/**
 * Check every workflow's declaration against what it actually subscribes to.
 *
 * Pure: takes already-read files, so the rule is testable without a filesystem.
 * Returns violations rather than throwing, so a caller can report all of them
 * at once — a guard that stops at the first problem trains people to fix one
 * thing and re-run.
 */
export function evaluateWorkflowClassification(workflows) {
  if (!Array.isArray(workflows)) {
    throw new TypeError(
      `workflows must be an array, received ${typeof workflows}`,
    );
  }
  const violations = [];
  for (const entry of workflows) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.file !== 'string'
    ) {
      throw new TypeError(
        'each workflow must be an object with a string "file" property',
      );
    }
    const { file, contents } = entry;
    const declared = declaredClassOf(contents, file);
    const triggers = triggersOf(contents, file);
    const subscribes = triggers.includes('merge_group');
    const onPullRequest = triggers.includes('pull_request');

    if (declared === 'reports' && !subscribes) {
      violations.push({
        file,
        declared,
        reason:
          'declares "reports" but does not subscribe to merge_group, so its ' +
          'contexts would never report for a queued entry',
      });
    }
    if (declared !== 'reports' && subscribes) {
      violations.push({
        file,
        declared,
        reason: `declares "${declared}" but subscribes to merge_group`,
      });
    }
    if (declared === 'advisory' && !onPullRequest) {
      violations.push({
        file,
        declared,
        reason:
          'declares "advisory" but does not run on pull_request; an advisory ' +
          'check that never runs on a pull request is a publication workflow',
      });
    }
    if (declared === 'publication' && onPullRequest) {
      violations.push({
        file,
        declared,
        reason:
          'declares "publication" but runs on pull_request; it emits check ' +
          'runs a ruleset can require, so it is advisory at best',
      });
    }
  }
  return violations;
}

/**
 * Required contexts that no merge-queue-reporting workflow emits.
 *
 * Each one is a queue entry that stays Pending forever. Pure.
 */
export function evaluateRequiredContexts({ workflows, requiredContexts }) {
  if (!Array.isArray(requiredContexts)) {
    throw new TypeError(
      `requiredContexts must be an array, received ${typeof requiredContexts}`,
    );
  }
  const emitted = new Map();
  for (const { file, contents } of workflows) {
    if (declaredClassOf(contents, file) !== 'reports') continue;
    for (const context of renderedContexts(contents, file)) {
      emitted.set(context, file);
    }
  }
  const advisory = new Map();
  for (const { file, contents } of workflows) {
    if (declaredClassOf(contents, file) === 'reports') continue;
    for (const context of renderedContexts(contents, file)) {
      advisory.set(context, file);
    }
  }
  return requiredContexts
    .filter((context) => !emitted.has(context))
    .map((context) => ({
      context,
      emittedBy: advisory.get(context),
      reason:
        advisory.get(context) === undefined
          ? 'no workflow in this repository emits a check run with this name'
          : `emitted by ${advisory.get(context)}, which does not report under merge_group`,
    }));
}

/** Read every workflow file from a directory. Sorted, so output is stable. */
export function readWorkflows(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()
    .map((file) => ({
      file,
      contents: readFileSync(path.join(directory, file), 'utf8'),
    }));
}

/**
 * Required contexts from live branch protection.
 *
 * Throws rather than returning [] when the field is absent. An empty list is
 * indistinguishable from "nothing is required", which would make this check
 * report success for a repository it could not read — the failure mode is a
 * green result that means "I did not look".
 */
export async function fetchRequiredContexts({
  repository,
  branch,
  token,
  fetchImpl = fetch,
}) {
  const { owner, repo } = repository;
  if (typeof owner !== 'string' || typeof repo !== 'string') {
    throw new TypeError(
      'repository must be an { owner, repo } object, as returned by ' +
        'resolveRepository — interpolating it directly builds a URL for a ' +
        'repository that does not exist, and the 404 names the wrong subject',
    );
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `branch protection request failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  const contexts = payload?.required_status_checks?.contexts;
  if (!Array.isArray(contexts)) {
    throw new Error(
      'branch protection response has no required_status_checks.contexts array',
    );
  }
  const rawChecks = payload?.required_status_checks?.checks;
  let checks;
  if (
    rawChecks === undefined ||
    (Array.isArray(rawChecks) && rawChecks.length === 0)
  ) {
    checks = contexts.map((context) => ({ context, appId: null }));
  } else if (!Array.isArray(rawChecks)) {
    throw new Error(
      'branch protection response has a malformed required_status_checks.checks field',
    );
  } else {
    checks = rawChecks.map((check, index) => {
      if (
        typeof check?.context !== 'string' ||
        check.context === '' ||
        (check.app_id !== null &&
          (!Number.isSafeInteger(check.app_id) ||
            (check.app_id !== -1 && check.app_id <= 0)))
      ) {
        throw new Error(
          `branch protection required check ${index + 1} has no valid context or app_id`,
        );
      }
      return { context: check.context, appId: check.app_id };
    });
  }
  return {
    contexts,
    checks,
    strict: payload.required_status_checks.strict === true,
  };
}

/** Human-readable refusal. The text is the product; the exit code is a summary. */
export function formatDeadlock(offenders) {
  return [
    'Enabling a merge queue with this ruleset would deadlock every pull request.',
    '',
    ...offenders.map(
      ({ context, reason }) => `  required: "${context}" — ${reason}`,
    ),
    '',
    'A required context that never reports for a merge_group event leaves the',
    'queue entry Pending forever. It does not go red; there is nothing to look',
    'at. See #122, and the header comments in the workflows named above.',
  ].join('\n');
}

async function main() {
  const workflowsDir = path.resolve(
    import.meta.dirname,
    '..',
    '.github',
    'workflows',
  );
  const workflows = readWorkflows(workflowsDir);

  const violations = evaluateWorkflowClassification(workflows);
  if (violations.length > 0) {
    for (const { file, reason } of violations) {
      process.stderr.write(`${file}: ${reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const token = discoverToken(process.env);
  const repositoryName = discoverRepository(process.env);
  const missing = [];
  if (token === null) {
    missing.push('GITHUB_TOKEN');
  }
  if (repositoryName === null) {
    missing.push('GITHUB_REPOSITORY');
  }
  if (missing.length > 0) {
    // Degrade to classification-only rather than failing. The remote half needs
    // credentials and a repository; the local half needs neither, and it is the
    // half that is actually enforced (tests/mergeQueueReadiness.test.ts runs it
    // from disk in CI). Failing here would make `npm run check:merge-queue-
    // contexts` exit 1 on a developer machine for want of an env var, which
    // teaches people to ignore the exit code of the thing guarding the queue.
    //
    // That reasoning is sound and is left intact. What it did not account for is
    // how OFTEN this path was taken: the script asked only for env vars, so on
    // an ordinary developer machine with `gh` logged in it skipped the live
    // check and exited 0 — reporting a clean bill for the half it never ran.
    // Measured: `gh auth token` returned a credential, and with it supplied the
    // live check ran and passed. The degrade is now the rare genuine case rather
    // than the default, which shrinks the window in which a green from this
    // script means less than it appears to.
    process.stdout.write(
      'Workflow classification is consistent.\n' +
        `Skipped the live ruleset check: ${missing.join(' and ')} not set.\n` +
        'That half is the one that reads branch protection, so this run has NOT ' +
        'checked whether a required context would deadlock the queue.\n',
    );
    return;
  }

  const repository = resolveRepository(
    repositoryName === ''
      ? process.env
      : { ...process.env, GITHUB_REPOSITORY: repositoryName },
  );
  const branch = process.env.PROTECTED_BRANCH ?? 'development';
  const { contexts, strict } = await fetchRequiredContexts({
    repository,
    branch,
    token,
  });
  const offenders = evaluateRequiredContexts({
    workflows,
    requiredContexts: contexts,
  });

  if (offenders.length > 0) {
    process.stderr.write(`${formatDeadlock(offenders)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `All ${contexts.length} required context(s) on ${branch} are emitted by a ` +
      `workflow that reports under merge_group (strict=${strict}).\n` +
      'A merge queue can be enabled without deadlocking.\n',
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    // Exit 1 rather than letting the rejection escape. An uncaught throw here
    // exits with a platform-dependent code — on Windows a native assertion and
    // 0xC0000409 — which no caller can distinguish from a crash, and which a
    // shell that tests `if ($LASTEXITCODE -eq 1)` reads as "not a refusal".
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
