// Runs `npm ci` and refuses to report success when the install did not actually
// produce a clean tree.
//
// Why this exists (#195, and its live follow-up #274): on `windows-latest`,
// `npm ci` failed to delete part of `node_modules`, printed
// `npm warn cleanup Failed to remove some directories`, and **exited 0**. The job continued against a tree that was neither the
// lockfile's nor a clean one. Three steps later the supply-chain SBOM gate
// refused to certify it and failed the job with
// `cannot identify npm ls package parse-color`.
//
// The gate was right and is deliberately untouched by this script. The defect is
// that a broken install reported itself as a successful one, so the failure
// surfaced four steps away from its cause and looked like a flaky test on a
// docs-only branch.
//
// Two independent checks, because they fail in different situations:
//
//   1. the cleanup warning itself — the direct signal, emitted by npm at the
//      moment the wipe fails. Text-matched, so `CLEANUP_WARNING_MARKER` is
//      pinned by a test: an npm upgrade that reworded it must break that test
//      rather than silently disable this check.
//   2. a structural walk of `npm ls --omit=dev --all --json` — the same
//      enumeration the SBOM gate uses, run here instead of four steps later.
//      Catches an unresolvable tree even if npm said nothing at all.
//
// Neither subsumes the other. A wipe can fail without leaving an unresolvable
// production node, and a tree can be unresolvable without a cleanup warning.
//
// Discharge path (#274): the cleanup warning alone used to hard-fail the job at
// its FIRST check, before the structural walk ever ran. On `windows-latest` that
// warning is an `EPERM: operation not permitted, rmdir` inside a hosted runner's
// node_modules — a file-locking behaviour a PR author cannot fix. The message
// forbade the only action available (re-running the job) and named no
// alternative, so the practical outcome was a deadlock: the PR sat.
//
// This script now executes the discharge path itself, in-job, and records that
// it did. When npm warns it could not finish the wipe, we remove node_modules
// explicitly (EPERM-tolerant), re-run `npm ci` ONCE, and then decide on the
// STRUCTURAL checks — the direct measurement of harm — instead of on the proxy
// (npm printed a warning). A leftover directory that reinstalls to a clean,
// resolvable tree is residue; a tree that is still unresolvable is the #195
// defect and still hard-fails.
//
// This is NOT a regression of #195. #195's rule is "don't clear it by re-running
// the job on a fresh runner, which wipes cleanly and HIDES the defect." An
// explicit in-place wipe-and-reverify that RECORDS that it happened (step
// summary, workflow annotation, uploaded artifact) is the opposite of that
// amnesia: the repair is measured, not disappeared. That record is the
// load-bearing judgement in this change.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * The exact substring npm prints when it cannot finish removing `node_modules`.
 *
 * Taken verbatim from run 30860812970, job 91842161902, `Desktop
 * (windows-latest)`, step `Install dependencies`:
 *
 *     npm warn cleanup Failed to remove some directories [
 *
 * Matched case-insensitively on the first two words plus `cleanup` so that a
 * change of log level (`warn` -> `error`) still matches, but a reworded message
 * does not. `tests/npmCiStrict.test.ts` pins this against the recorded output.
 */
export const CLEANUP_WARNING_MARKER = 'cleanup Failed to remove';

export const NPM_PRODUCTION_TREE_COMMAND = 'npm ls --omit=dev --all --json';

/**
 * True when npm's own output says it could not finish removing `node_modules`.
 *
 * @param {string} output combined stdout+stderr of `npm ci`
 * @returns {boolean}
 */
export function hasCleanupFailure(output) {
  if (typeof output !== 'string') return false;
  return output.toLowerCase().includes(CLEANUP_WARNING_MARKER.toLowerCase());
}

/**
 * Every directory name npm named in a `npm warn cleanup` block.
 *
 * Best-effort and reported only as context — the decision to fail is made by
 * {@link hasCleanupFailure}, which does not depend on this parsing succeeding.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function extractCleanupPaths(output) {
  if (typeof output !== 'string') return [];
  const found = new Set();
  for (const match of output.matchAll(/node_modules[\\/]+([^'"\\/\s,\]]+)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Describe the shape of a value for a diagnostic message, distinguishing the
 * three things `typeof x === 'object'` conflates.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * npm's own verdict on the tree it just printed.
 *
 * `npm ls` reports `problems` whenever anything is wrong with the tree, and
 * `error` when it also exits non-zero. Measured against real npm output:
 *
 *     healthy tree          `problems` absent, `error` absent   exit 0
 *     an extraneous package `problems` present, `error` absent  exit 0  <-
 *     an invalid package    `problems` present, `error` present exit 1
 *
 * The marked line is the reason this exists: npm knows the tree is wrong and
 * still exits 0, which is #195's whole shape one level up from the install.
 *
 * Reading it also closes the case where npm returns a tree with no
 * `dependencies` key at all — an unparseable `package.json` yields valid JSON
 * carrying only `error`/`problems`, on which a structural walk finds nothing to
 * walk and reports success.
 *
 * @param {unknown} tree parsed `npm ls --json` output
 * @returns {string[]} npm's problem strings, plus its error summary
 */
export function findTreeProblems(tree) {
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
    return [
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` returned ${describeShape(tree)} where an object was expected`,
    ];
  }
  const problems = [];
  if (Array.isArray(tree.problems)) {
    for (const problem of tree.problems) {
      const text = typeof problem === 'string' ? problem.trim() : '';
      if (text.length > 0) problems.push(text);
    }
  }
  if (tree.error !== undefined && tree.error !== null) {
    const code =
      typeof tree.error.code === 'string' ? tree.error.code : 'unknown error';
    const summary =
      typeof tree.error.summary === 'string' ? tree.error.summary.trim() : '';
    problems.push(`npm reported ${code}${summary ? `: ${summary}` : ''}`);
  }
  // npm marks the root project invalid as a string explaining the mismatch, not
  // as a boolean — see `findUnresolvedPackages` below.
  if (tree.invalid !== undefined && tree.invalid !== false) {
    problems.push(
      `npm marked the root project invalid: ${String(tree.invalid)}`,
    );
  }
  return [...new Set(problems)];
}

/**
 * Walk an `npm ls --json` tree and return every dependency npm could not
 * resolve to a version.
 *
 * This is the same condition the npm SBOM completeness gate throws on. A stale
 * directory left behind by a failed wipe shows up here as a named node with no
 * `version`.
 *
 * `extraneous` and `invalid` are read as truthy rather than compared to `true`.
 * Real npm emits `extraneous` as a boolean but `invalid` as a *string* naming
 * the unsatisfied range — `'"^1.3.0" from the root project'` — so `=== true`
 * never matched a tree npm actually produced.
 *
 * A node whose shape npm should never emit is reported rather than skipped. The
 * previous behaviour was to return early, which turned every malformed tree
 * into an empty result and therefore into a pass.
 *
 * @param {unknown} tree parsed `npm ls --json` output
 * @returns {string[]} package names, deduplicated, in encounter order
 */
export function findUnresolvedPackages(tree) {
  const unresolved = new Set();
  const seen = new Set();
  const walk = (node, label) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      unresolved.add(
        `${label} (npm ls returned ${describeShape(node)} for it)`,
      );
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const dependencies = node.dependencies;
    // A leaf legitimately has no `dependencies` key; any other non-object is a
    // shape npm does not emit, and must not be read as "nothing to check".
    if (dependencies === undefined) return;
    if (
      typeof dependencies !== 'object' ||
      dependencies === null ||
      Array.isArray(dependencies)
    ) {
      unresolved.add(
        `${label} (npm ls returned ${describeShape(dependencies)} for its \`dependencies\`)`,
      );
      return;
    }
    for (const [name, child] of Object.entries(dependencies)) {
      const resolvable =
        typeof child === 'object' &&
        child !== null &&
        !Array.isArray(child) &&
        typeof child.version === 'string' &&
        child.version.length > 0;
      if (!resolvable) {
        unresolved.add(name);
        continue;
      }
      if (child.extraneous || child.invalid) {
        unresolved.add(name);
      }
      walk(child, name);
    }
  };
  walk(tree, 'the root project');
  return [...unresolved];
}

/**
 * Build the argv for a command, routing through cmd.exe on Windows the way the
 * other scripts in this repo do — `npm` is a `.cmd` shim there and is not
 * directly executable.
 *
 * @param {string} commandLine
 * @returns {{ command: string, args: string[] }}
 */
export function npmInvocation(commandLine) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
    };
  }
  const [, ...rest] = commandLine.split(' ');
  return { command: 'npm', args: rest };
}

/**
 * How many times {@link removeNodeModules} asks the runtime to retry a failed
 * unlink/rmdir, and the base backoff between tries.
 *
 * `fs.rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay })`
 * retries on `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and — the one that fires
 * here — `EPERM`, waiting `retryDelay` ms longer on each attempt (linear
 * backoff). That behaviour is documented and measured, not assumed: the EPERM
 * in #195's log is exactly one of the retried classes, which is why an explicit
 * rm succeeds where npm's own in-place cleanup lost the race with the file lock.
 */
export const NODE_MODULES_REMOVAL = { maxRetries: 6, retryDelay: 200 };

/**
 * Remove `node_modules` explicitly, tolerating the transient Windows file locks
 * that made npm's own cleanup give up. `rm` is injected so a test can assert the
 * retry options are passed without needing a real locked directory.
 *
 * @param {string} dir absolute path to the `node_modules` to remove
 * @param {{ rm?: typeof rmSync }} [options]
 * @returns {{ removed: true }}
 */
export function removeNodeModules(dir, options = {}) {
  const rm = options.rm ?? rmSync;
  rm(dir, {
    recursive: true,
    force: true,
    maxRetries: NODE_MODULES_REMOVAL.maxRetries,
    retryDelay: NODE_MODULES_REMOVAL.retryDelay,
  });
  return { removed: true };
}

/**
 * Decide the repair's outcome from the SECOND attempt's evidence — the direct
 * measurement of harm, not the proxy. Pure so the pass/fail rule is tested
 * without shelling out to npm.
 *
 * The repair succeeds only when the reinstalled tree is clean on every direct
 * check: npm exited 0, did not warn again, `npm ls` found no problems, and the
 * production walk found nothing unresolvable. Any one of those is a genuine
 * defect of the #195 shape and hard-fails — this is where residue is separated
 * from a broken tree.
 *
 * @param {{ secondExitCode: number, secondWarned: boolean, problems: string[], unresolved: string[] }} evidence
 * @returns {{ succeeded: boolean, reasons: string[] }}
 */
export function repairOutcome(evidence) {
  const reasons = [];
  if (evidence.secondExitCode !== 0) {
    reasons.push(
      `the second \`npm ci\` exited ${evidence.secondExitCode} rather than 0`,
    );
  }
  if (evidence.secondWarned) {
    reasons.push(
      'npm again reported it could not finish removing node_modules after the explicit wipe',
    );
  }
  for (const problem of evidence.problems ?? []) reasons.push(problem);
  for (const name of evidence.unresolved ?? []) {
    reasons.push(`npm cannot resolve \`${name}\` in the reinstalled tree`);
  }
  return { succeeded: reasons.length === 0, reasons };
}

/**
 * Human-readable `$GITHUB_STEP_SUMMARY` section recording that a repair ran.
 *
 * This is durable evidence in the job-log sense only. State plainly (in the PR
 * body, and here) what it does NOT achieve, because it is less than it looks:
 *
 *   - It does not survive a RE-RUN of this same job. `actions/runs?head_sha=…`
 *     returns only the latest attempt, so a summary written on attempt 1 is not
 *     in the attempt-2 view anyone reads. Measured on #269 `e639e72`: attempt 1
 *     failed on this exact install, attempt 2 passed, and the head_sha view
 *     shows three greens with no sign attempt 1 existed — only `run_attempt: 2`
 *     betrays it. A record with the same lifetime as the failure it records is
 *     not a record.
 *   - It does not survive commit supersession on the branch view either — a
 *     superseded commit's summary is not what a reader of the branch sees next.
 *
 * The real value of the repair is that it makes the re-run UNNECESSARY (the
 * repair happens in this attempt), not that this summary outlives one. A record
 * that survives a re-run or a push needs cross-run mutable state — an issue
 * comment or a label — which needs a token and a workflow permission, and is out
 * of scope for this script. See #274, defect 2.
 *
 * @param {{ firstPaths: string[], secondExitCode: number, secondWarned: boolean, problems: string[], unresolved: string[], succeeded: boolean }} record
 * @returns {string}
 */
export function formatStepSummary(record) {
  const namedList =
    record.firstPaths.length > 0 ? record.firstPaths.join(', ') : 'none named';
  const list = (items) => (items.length > 0 ? items.join(', ') : 'none');
  const lines = [
    '## npm-ci-strict: node_modules was repaired in-job',
    '',
    '`npm ci` exited 0 but reported it could not finish removing node_modules.',
    'Rather than fail with no discharge path, this job removed node_modules',
    'explicitly and re-ran `npm ci` once, then judged the RESULT — not the',
    'warning. See #274.',
    '',
    `- Directories npm first named: ${namedList}`,
    `- node_modules removed explicitly: yes`,
    `- Second \`npm ci\` exit code: ${record.secondExitCode}`,
    `- Second cleanup warning: ${record.secondWarned ? 'yes' : 'no'}`,
    `- Structural problems (\`npm ls\`): ${list(record.problems)}`,
    `- Unresolvable production packages: ${list(record.unresolved)}`,
    '',
    record.succeeded
      ? 'Outcome: **PASS** — the reinstalled tree is clean and resolvable. The repair'
      : 'Outcome: **FAIL** — the reinstalled tree is still broken. Re-running the job',
    record.succeeded
      ? 'was recorded rather than hidden.'
      : 'will not help; the repair was already attempted here.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Single-line `::warning::` workflow annotation. Surfaces on the run summary and
 * on the PR's Checks tab. Same durability caveat as {@link formatStepSummary}.
 *
 * @param {{ firstPaths: string[], succeeded: boolean }} record
 * @returns {string}
 */
export function formatWarningAnnotation(record) {
  const named =
    record.firstPaths.length > 0
      ? record.firstPaths.join(', ')
      : 'unnamed directories';
  const outcome = record.succeeded ? 'PASS' : 'FAIL';
  return `::warning title=npm-ci-strict::node_modules was repaired in-job (removed + reinstalled once) after npm could not finish removing ${named}. Outcome: ${outcome}. See #274.`;
}

/**
 * Append a section to `$GITHUB_STEP_SUMMARY` when that file is set (it always is
 * on a GitHub runner, and never is locally). Injectable for tests.
 *
 * @param {string} markdown
 * @param {{ env?: Record<string, string | undefined>, append?: typeof appendFileSync }} [options]
 * @returns {boolean} whether anything was written
 */
export function appendStepSummary(markdown, options = {}) {
  const env = options.env ?? process.env;
  const append = options.append ?? appendFileSync;
  const target = env.GITHUB_STEP_SUMMARY;
  if (typeof target !== 'string' || target.length === 0) return false;
  append(target, `${markdown}\n`);
  return true;
}

/**
 * Write the repair record as JSON so the workflow can upload it as an artifact —
 * evidence that outlives the job's log-retention window better than the summary.
 * Same supersession caveat applies (see #274, defect 2).
 *
 * @param {object} record
 * @param {string} target absolute path to write
 * @param {{ write?: typeof writeFileSync }} [options]
 * @returns {void}
 */
export function writeRepairArtifact(record, target, options = {}) {
  const write = options.write ?? writeFileSync;
  write(target, `${JSON.stringify(record, null, 2)}\n`);
}

function runNpmCi() {
  return new Promise((resolve, reject) => {
    const { command, args } = npmInvocation('npm ci');
    const child = spawn(command, args, { cwd: repoRoot, shell: false });
    let combined = '';
    child.stdout.on('data', (chunk) => {
      combined += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      combined += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output: combined }));
  });
}

function readProductionTree() {
  const { command, args } = npmInvocation(NPM_PRODUCTION_TREE_COMMAND);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout || !result.stdout.trim()) {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/, 1)[0];
    throw new Error(
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` produced no JSON output${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` output was not valid JSON: ${error.message}`,
    );
  }
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(1);
}

function note(lines) {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

/**
 * Run the two direct, structural checks over the production tree and return
 * every failure they found, flattened. This is the "direct measurement of harm"
 * the repair path decides on. Kept as one call so the repair arm and the
 * ordinary arm cannot drift apart.
 *
 * @returns {{ problems: string[], unresolved: string[] }}
 */
function inspectProductionTree() {
  const tree = readProductionTree();
  return {
    problems: findTreeProblems(tree),
    unresolved: findUnresolvedPackages(tree),
  };
}

/**
 * The cleanup-warning discharge path (#274). Runs only after a zero-exit
 * `npm ci` whose output tripped {@link hasCleanupFailure}.
 *
 * Removes node_modules explicitly, re-runs `npm ci` once, then decides on the
 * structural checks and records what happened either way.
 *
 * @param {string} firstOutput combined output of the first `npm ci`
 */
async function dischargeCleanupFailure(firstOutput) {
  const firstPaths = extractCleanupPaths(firstOutput);
  note([
    '',
    'npm-ci-strict: `npm ci` exited 0 but reported it could not finish removing node_modules.',
    firstPaths.length > 0
      ? `Directories npm named: ${firstPaths.join(', ')}`
      : '',
    '',
    'Executing the discharge path: removing node_modules explicitly and',
    're-running `npm ci` once, then judging the reinstalled tree directly. See #274.',
    '',
  ]);

  removeNodeModules(path.join(repoRoot, 'node_modules'));

  const { code: secondExitCode, output: secondOutput } = await runNpmCi();
  const secondWarned = hasCleanupFailure(secondOutput);

  // Only read the tree when the second install exited 0. A non-zero exit means
  // `npm ls` would describe a half-written tree, and its problems would be noise
  // next to the real signal (the exit code itself).
  const { problems, unresolved } =
    secondExitCode === 0
      ? inspectProductionTree()
      : { problems: [], unresolved: [] };

  const outcome = repairOutcome({
    secondExitCode,
    secondWarned,
    problems,
    unresolved,
  });

  const record = {
    issue: 274,
    firstPaths,
    removedNodeModules: true,
    secondExitCode,
    secondWarned,
    problems,
    unresolved,
    succeeded: outcome.succeeded,
  };

  // Durable evidence, always — a repair that passed is exactly the case #195
  // warned would be hidden, so recording it is the point.
  appendStepSummary(formatStepSummary(record));
  note([formatWarningAnnotation(record)]);
  try {
    writeRepairArtifact(
      record,
      path.join(repoRoot, 'npm-ci-strict-repair.json'),
    );
  } catch (error) {
    // The artifact is secondary evidence; never let writing it mask the outcome.
    process.stderr.write(
      `npm-ci-strict: could not write repair artifact: ${error.message}\n`,
    );
  }

  if (outcome.succeeded) {
    note([
      '',
      'npm-ci-strict: repair succeeded. node_modules was wiped and reinstalled to a',
      'clean, resolvable tree, and that repair was recorded (step summary,',
      'annotation, artifact). This is the opposite of #195: the wipe happened',
      'in-place and on the record, not silently on a fresh runner.',
      '',
    ]);
    return;
  }

  fail([
    '',
    'npm-ci-strict: the in-job repair did not produce a clean tree.',
    '',
    ...outcome.reasons.map((reason) => `  - ${reason}`),
    '',
    'node_modules was ALREADY removed and `npm ci` re-run once in this job, so',
    're-running the job is not the remedy — it would repeat exactly this and, on a',
    'fresh runner, hide the defect (#195). The reinstalled tree is still not the',
    'lockfile tree, which is the condition the SBOM gate fails on several steps',
    'later. Fix the dependency graph, not the runner. See #195 and #274.',
    '',
  ]);
}

async function main() {
  const { code, output } = await runNpmCi();

  if (code !== 0) {
    process.exit(code);
  }

  if (hasCleanupFailure(output)) {
    await dischargeCleanupFailure(output);
    return;
  }

  const { problems, unresolved } = inspectProductionTree();

  if (problems.length > 0) {
    fail([
      '',
      'npm-ci-strict: npm itself reported problems with the installed tree.',
      '',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` reports these even when it exits 0, which`,
      'is how a partially-wiped tree reaches the SBOM gate several steps later and',
      'reads there as an unrelated failure. See #195 and #274.',
      '',
    ]);
  }

  if (unresolved.length > 0) {
    fail([
      '',
      'npm-ci-strict: the installed production tree contains packages npm cannot resolve.',
      '',
      `Unresolvable: ${unresolved.join(', ')}`,
      '',
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` returned nodes with no version, or marked`,
      'extraneous/invalid. That is the same condition the npm SBOM completeness',
      'gate fails on, detected here at the install step instead of several steps',
      'later where it reads as an unrelated test failure. See #195 and #274.',
      '',
    ]);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`npm-ci-strict: ${error.message}\n`);
    process.exit(1);
  });
}
