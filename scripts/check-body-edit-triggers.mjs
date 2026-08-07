// A guard that reads a pull request body must re-run when the body changes.
//
// The defect (#436). Two guards read body-derived metadata, and their trigger
// sets are opposites of their enforceability:
//
//   check-closing-references.mjs  reads `gh pr view --json body`
//                                runs in pr-closure-scope.yml (NOT required)
//                                pull_request: types include `edited`
//
//   check-pr-closure-scope.mjs   reads `closingIssuesReferences`, which GitHub
//                                derives from the body
//                                runs in pr-closure-scope.yml (NOT required)
//                                pull_request: types include `edited`
//
// Before #436: the body-reading guard that gated could not see a body edit,
// while the one that could see an edit did not gate. Measured on PR #427 at head
// 1764e735, after a body-only edit -- `PR closure scope` ran twice while every
// required context ran once and stayed green on the previous body revision.
//
// Why that is exploitable in the #57 shape: the arming guard's conclusion is
// attached to a COMMIT, and branch protection evaluates required contexts on
// that commit. A body edited after the green run is certified by a check that
// never saw it. #57 was the body disarmed by an edit with the keyword surviving
// in the commit message; this is the inverse -- the body armed by an edit, with
// the guard's green certifying a revision that no longer exists.
//
// `types:` REPLACES the default set rather than extending it, which is why the
// remedy has to spell out all four events and why this module compares against
// DEFAULT_PULL_REQUEST_TYPES rather than assuming a listed set is additive.
//
// What this refuses to do: decide which contexts are required. That needs a
// branch-protection read, a token, and a network call, which is exactly the
// dependency that keeps check-merge-queue-contexts.mjs off the execution path
// (#472). The rule here is deliberately stricter and offline -- EVERY workflow
// invoking a body-reading guard must subscribe to `edited`, whether or not its
// contexts gate today. A rule that depends on protection settings stops being
// true the moment someone changes them, silently.
//
// Guards are detected from their source rather than named in a list, so a guard
// added tomorrow is covered without anyone remembering to register it. A list
// would be one more citation that can go stale (#472, #313).
//
// No shebang: this module is imported by tests/bodyEditTriggers.test.ts, and
// vite's transform does not strip one the way node does.

import path from 'node:path';

import { runCommandLines } from './check-script-reachability.mjs';

/** What GitHub dispatches for `pull_request:` when no `types:` is given. */
export const DEFAULT_PULL_REQUEST_TYPES = ['opened', 'synchronize', 'reopened'];

/** The event that fires when a title or body is edited. */
export const BODY_EDIT_TYPE = 'edited';

/**
 * Source patterns that mean "this script's verdict depends on the PR body".
 *
 * `closingIssuesReferences` is included because GitHub derives it from the body
 * text: a body edit changes it without any commit, which is the whole defect.
 * Each entry carries the reason so a failure names the mechanism rather than
 * the regex.
 */
export const BODY_DERIVED_READS = [
  {
    pattern: /--json['",\s]+body\b|['"]body['"]\s*,\s*['"]--jq['"]|\.body\b/,
    reason: 'reads the pull request body directly',
  },
  {
    pattern: /closingIssuesReferences/,
    reason:
      'reads closingIssuesReferences, which GitHub derives from the body text',
  },
];

/**
 * Source with line and block comments removed.
 *
 * Written after this module's own first run attributed
 * `closingIssuesReferences` to check-closing-references.mjs, which only
 * mentions the field in prose. That is the citation-vs-invocation error this
 * module tests for in workflows, committed in the script scan — a guard is
 * what a file DOES, and a comment does not read anything.
 */
export function stripComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Which body-derived reads a script source performs. */
export function bodyDerivedReads(contents) {
  const code = stripComments(contents);
  return BODY_DERIVED_READS.filter(({ pattern }) => pattern.test(code)).map(
    ({ reason }) => reason,
  );
}

/**
 * Script basenames a workflow actually runs.
 *
 * Resolves `npm run <key>` through package.json so a guard invoked by its npm
 * alias is not invisible, and accepts a direct `node scripts/x.mjs`. Only
 * `run:` lines count -- a script named in a comment is a citation, not an
 * invocation, which is the distinction #472 exists for.
 */
export function invokedScripts(workflowContents, npmScripts = {}) {
  const found = new Set();
  for (const line of runCommandLines(workflowContents)) {
    for (const match of line.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)) {
      found.add(match[1]);
    }
    for (const match of line.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      const command = npmScripts[match[1]];
      if (typeof command !== 'string') continue;
      const resolved = /scripts\/([A-Za-z0-9._-]+\.mjs)/.exec(command);
      if (resolved) found.add(resolved[1]);
    }
  }
  return [...found].sort();
}

/**
 * The `pull_request:` types a workflow subscribes to.
 *
 * `null` means the workflow does not subscribe to `pull_request` at all, which
 * is not the same as subscribing with no types -- the first has no obligation
 * here, the second inherits the defaults. Collapsing them would let a workflow
 * that never runs on pull requests report as compliant for the wrong reason.
 */
export function pullRequestTypes(workflowContents) {
  const lines = workflowContents.split(/\r?\n/);
  const onIndex = lines.indexOf('on:');
  if (onIndex < 0) return null;

  let inPullRequest = false;
  const collected = [];
  let sawTypes = false;

  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line)) break;
    if (/^ {2}[A-Za-z_]/.test(line)) {
      if (inPullRequest) break;
      inPullRequest = /^ {2}pull_request:/.test(line);
      continue;
    }
    if (!inPullRequest) continue;

    const inline = /^ {4}types:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      sawTypes = true;
      for (const entry of inline[1].split(',')) {
        const value = entry.trim().replace(/^['"]|['"]$/g, '');
        if (value) collected.push(value);
      }
      continue;
    }
    if (/^ {4}types:\s*$/.test(line)) {
      sawTypes = true;
      continue;
    }
    const item = /^ {6}-\s*['"]?([A-Za-z_]+)['"]?\s*$/.exec(line);
    if (sawTypes && item) collected.push(item[1]);
  }

  if (!inPullRequest && !sawTypes && collected.length === 0) {
    // `pull_request:` was never opened above; distinguish absent from empty.
    if (!/^ {2}pull_request:/m.test(workflowContents)) return null;
  }
  return sawTypes ? collected : [];
}

/** What GitHub will actually dispatch, defaults substituted. */
export function effectiveTypes(types) {
  if (types === null) return null;
  return types.length === 0 ? [...DEFAULT_PULL_REQUEST_TYPES] : types;
}

/**
 * Defaults missing from an explicitly declared `types:` list.
 *
 * Scoped deliberately. A workflow that subscribes to NONE of the defaults --
 * `[closed]`, `[completed]` -- is scoped to a different lifecycle and is not
 * dropping anything. A workflow that subscribes to SOME of them has opted into
 * the code-changing lifecycle and then silently left part of it out: because
 * `types:` replaces the default set rather than extending it, `[opened,
 * reopened, edited]` stops CI on every push and reads identically to a
 * workflow that simply never ran. Partial overlap is the signature.
 */
export function droppedDefaultTypes(types) {
  if (!Array.isArray(types) || types.length === 0) return [];
  const overlap = DEFAULT_PULL_REQUEST_TYPES.filter((type) =>
    types.includes(type),
  );
  if (overlap.length === 0) return [];
  return DEFAULT_PULL_REQUEST_TYPES.filter((type) => !types.includes(type));
}

/**
 * Which workflows run a body-reading guard without subscribing to `edited`.
 *
 * `guards` is returned alongside the findings so a caller can assert the scan
 * found any guards at all. A zero-finding result over a zero-guard corpus is
 * the vacuous pass this whole class of check keeps producing.
 */
export function evaluateBodyEditTriggers({ workflows, scripts, npmScripts }) {
  const guards = new Map();
  for (const { basename, contents } of scripts) {
    const reasons = bodyDerivedReads(contents);
    if (reasons.length > 0) guards.set(basename, reasons);
  }

  const findings = [];
  const compliant = [];
  const droppedDefaults = [];

  for (const { path: workflowPath, contents } of workflows) {
    const declared = pullRequestTypes(contents);
    const dropped = droppedDefaultTypes(declared);
    if (dropped.length > 0) {
      droppedDefaults.push({
        workflow: workflowPath,
        types: declared,
        dropped,
      });
    }

    const invoked = invokedScripts(contents, npmScripts).filter((basename) =>
      guards.has(basename),
    );
    if (invoked.length === 0) continue;

    const types = effectiveTypes(declared);
    if (types === null) continue;

    const entry = {
      workflow: workflowPath,
      guards: invoked,
      types,
      reasons: invoked.flatMap((basename) => guards.get(basename) ?? []),
    };
    if (types.includes(BODY_EDIT_TYPE)) compliant.push(entry);
    else findings.push(entry);
  }

  return {
    findings,
    compliant,
    droppedDefaults,
    guards: [...guards.keys()].sort(),
  };
}

/** One line per dropped-default finding. */
export function formatDroppedDefaults(droppedDefaults) {
  return droppedDefaults.map(
    ({ workflow, types, dropped }) =>
      `${path.basename(workflow)} subscribes to [${types.join(', ')}], which ` +
      `opts into the code-changing lifecycle but omits [${dropped.join(', ')}]. ` +
      `types: replaces the default set rather than extending it, so the omitted ` +
      `events never dispatch and the workflow is indistinguishable from one that ` +
      `never ran. List all of [${DEFAULT_PULL_REQUEST_TYPES.join(', ')}].`,
  );
}

/** One line per finding, naming the mechanism and not the regex. */
export function formatFindings(findings) {
  return findings.map(
    ({ workflow, guards, types, reasons }) =>
      `${path.basename(workflow)} runs ${guards.join(', ')} — which ${reasons.join('; ')} — ` +
      `but subscribes only to [${types.join(', ')}], so a body edit leaves its ` +
      `conclusion attached to a body revision that no longer exists. Add ` +
      `'${BODY_EDIT_TYPE}' to its pull_request types (types: replaces the defaults, ` +
      `so list all of them).`,
  );
}
