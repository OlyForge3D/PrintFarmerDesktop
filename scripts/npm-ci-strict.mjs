// Runs `npm ci` and refuses to report success when the install did not actually
// produce a clean tree.
//
// Why this exists (#195): on `windows-latest`, `npm ci` failed to delete part of
// `node_modules`, printed `npm warn cleanup Failed to remove some directories`,
// and **exited 0**. The job continued against a tree that was neither the
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

import { spawn, spawnSync } from 'node:child_process';
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

async function main() {
  const { code, output } = await runNpmCi();

  if (code !== 0) {
    process.exit(code);
  }

  if (hasCleanupFailure(output)) {
    const paths = extractCleanupPaths(output);
    fail([
      '',
      'npm-ci-strict: `npm ci` exited 0 but reported it could not finish removing node_modules.',
      '',
      'The installed tree is therefore neither the lockfile tree nor a clean one,',
      'and every later step in this job would run against it.',
      paths.length > 0 ? `Directories npm named: ${paths.join(', ')}` : '',
      '',
      'This is an environment failure, not a test failure. Do NOT clear it by',
      're-running the job: a fresh runner wipes cleanly and hides the defect,',
      'which teaches the squad to treat the supply-chain gate as noise. See #195.',
      '',
    ]);
  }

  const tree = readProductionTree();

  const problems = findTreeProblems(tree);
  if (problems.length > 0) {
    fail([
      '',
      'npm-ci-strict: npm itself reported problems with the installed tree.',
      '',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` reports these even when it exits 0, which`,
      'is how a partially-wiped tree reaches the SBOM gate several steps later and',
      'reads there as an unrelated failure. See #195.',
      '',
    ]);
  }

  const unresolved = findUnresolvedPackages(tree);
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
      'later where it reads as an unrelated test failure. See #195.',
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
