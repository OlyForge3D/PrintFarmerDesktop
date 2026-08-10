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
// The gate remains fail closed. On Windows only, the script first retries the
// exact removals npm requested, then subjects the resulting tree to the same
// structural validation. An unrecoverable warning still fails here, before any
// test or supply-chain step can run.
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
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
export const CLEANUP_FAILURE_ANCHOR = 'could not finish removing node_modules';
export const CLEANUP_FAILURE_DIAGNOSTIC = `npm-ci-strict: \`npm ci\` exited 0 but reported it ${CLEANUP_FAILURE_ANCHOR}.`;
export const CLEANUP_EVIDENCE_OUTPUT = 'cleanup_evidence';
export const CLEANUP_EVIDENCE_FILENAME = 'npm-cleanup-evidence.json';

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

function cleanupEntries(output) {
  if (typeof output !== 'string') return [];
  const entries = [];
  let current = null;
  let depth = 0;
  for (const line of output.split(/\r?\n/)) {
    const content = line
      .replace(/^\s*npm (?:warn|error) cleanup\s*/i, '')
      .trim();
    if (content === '[') {
      if (depth === 0) current = [];
      depth += 1;
      continue;
    }
    if (content === ']' && depth > 0) {
      depth -= 1;
      if (depth === 0 && current !== null) {
        entries.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return entries;
}

function isRetryableCleanupEntry(entry) {
  const errorCodes = [...entry.matchAll(/\[Error:\s*([A-Z][A-Z0-9_]*)\b/g)].map(
    (match) => match[1],
  );
  const propertyCodes = [...entry.matchAll(/\bcode:\s*['"]([^'"]+)['"]/gi)].map(
    (match) => match[1]?.toUpperCase(),
  );
  const syscalls = [...entry.matchAll(/\bsyscall:\s*['"]([^'"]+)['"]/gi)].map(
    (match) => match[1]?.toLowerCase(),
  );
  return (
    errorCodes.length === 1 &&
    errorCodes[0] === 'EPERM' &&
    propertyCodes.length > 0 &&
    propertyCodes.every((code) => code === 'EPERM') &&
    syscalls.length > 0 &&
    syscalls.every((syscall) => syscall === 'rmdir')
  );
}

/**
 * Directories npm said should have been removed, relative to `node_modules`.
 *
 * Only quoted paths inside `node_modules` are accepted. Parent directories
 * subsume nested entries so the recorded `parse-color` and nested
 * `color-convert` failure becomes one bounded removal.
 *
 * @param {unknown} output
 * @returns {string[]}
 */
export function extractCleanupDirectories(output) {
  const found = new Set();
  for (const entry of cleanupEntries(output).filter(isRetryableCleanupEntry)) {
    for (const match of entry.matchAll(
      /['"]([^'"\r\n]*node_modules[\\/][^'"\r\n]+)['"]/g,
    )) {
      const normalized = (match[1] ?? '').replaceAll('\\', '/');
      const marker = '/node_modules/';
      const markerIndex = normalized.toLowerCase().indexOf(marker);
      if (markerIndex < 0) continue;
      const relative = normalized.slice(markerIndex + marker.length);
      const segments = relative.split('/').filter(Boolean);
      if (
        segments.length === 0 ||
        segments.some(
          (segment) =>
            segment === '.' || segment === '..' || segment.includes(':'),
        )
      ) {
        continue;
      }
      found.add(segments.join('/'));
    }
  }

  const selected = [];
  for (const candidate of [...found].sort(
    (left, right) => left.split('/').length - right.split('/').length,
  )) {
    if (
      selected.some(
        (parent) => candidate === parent || candidate.startsWith(`${parent}/`),
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

/**
 * Retry only the removals npm itself requested, and only on Windows where the
 * recorded EPERM/rmdir mechanism occurs.
 *
 * @param {string} output
 * @param {{
 *   platform?: NodeJS.Platform,
 *   root?: string,
 *   rmImpl?: typeof rm
 * }} [options]
 */
export async function retryCleanupRemovals(output, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      attempted: false,
      recovered: false,
      directories: [],
      reason: 'automatic cleanup removal retry is restricted to Windows',
    };
  }

  const directories = extractCleanupDirectories(output);
  if (directories.length === 0) {
    return {
      attempted: false,
      recovered: false,
      directories,
      reason:
        'npm named no safely bounded directory in an EPERM/rmdir cleanup block',
    };
  }

  const root = options.root ?? repoRoot;
  const rmImpl = options.rmImpl ?? rm;
  for (const directory of directories) {
    const target = path.join(root, 'node_modules', ...directory.split('/'));
    await rmImpl(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }

  return {
    attempted: true,
    recovered: true,
    directories,
    reason: null,
  };
}

export function resolveCleanupEvidencePath(environment = process.env) {
  return (
    environment.NPM_CLEANUP_EVIDENCE_PATH ??
    path.join(environment.RUNNER_TEMP ?? os.tmpdir(), CLEANUP_EVIDENCE_FILENAME)
  );
}

/**
 * @param {{
 *   output: string,
 *   recovery: {
 *     attempted: boolean,
 *     recovered: boolean,
 *     directories: string[],
 *     reason: string | null
 *   },
 *   productionTreeProblems?: string[],
 *   productionTreeExitProblems?: string[],
 *   productionTreeError?: string | null,
 *   environment?: NodeJS.ProcessEnv,
 *   recordedAt?: string
 * }} input
 */
export function createCleanupEvidence(input) {
  const environment = input.environment ?? process.env;
  const runId = environment.GITHUB_RUN_ID ?? null;
  const runAttempt = environment.GITHUB_RUN_ATTEMPT ?? null;
  const repository = environment.GITHUB_REPOSITORY ?? null;
  const serverUrl = environment.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl =
    repository && runId
      ? `${serverUrl}/${repository}/actions/runs/${runId}${
          runAttempt ? `/attempts/${runAttempt}` : ''
        }`
      : null;
  const warningExcerpt = input.output
    .split(/\r?\n/)
    .filter((line) =>
      /npm warn cleanup|EPERM|rmdir|node_modules[\\/]/i.test(line),
    )
    .slice(0, 80);

  return {
    schemaVersion: 1,
    anchor: CLEANUP_FAILURE_ANCHOR,
    diagnostic: CLEANUP_FAILURE_DIAGNOSTIC,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    repository,
    runId,
    runAttempt,
    runUrl,
    headSha: environment.GITHUB_SHA ?? null,
    job: environment.GITHUB_JOB ?? null,
    workflow: environment.GITHUB_WORKFLOW ?? null,
    runnerOs: environment.RUNNER_OS ?? process.platform,
    runnerName: environment.RUNNER_NAME ?? null,
    cleanupPaths: extractCleanupPaths(input.output),
    cleanupDirectories: input.recovery.directories,
    recovery: {
      attempted: input.recovery.attempted,
      recovered: input.recovery.recovered,
      reason: input.recovery.reason,
    },
    productionTreeProblems: input.productionTreeProblems ?? [],
    productionTreeExitProblems: input.productionTreeExitProblems ?? [],
    productionTreeError: input.productionTreeError ?? null,
    warningExcerpt,
  };
}

export async function writeCleanupEvidence(
  evidence,
  {
    environment = process.env,
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
  } = {},
) {
  const evidencePath = resolveCleanupEvidencePath(environment);
  await mkdirImpl(path.dirname(evidencePath), { recursive: true });
  await writeFileImpl(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return evidencePath;
}

export async function markCleanupEvidenceOutput(
  environment = process.env,
  appendFileImpl = appendFile,
) {
  if (!environment.GITHUB_OUTPUT) return false;
  await appendFileImpl(
    environment.GITHUB_OUTPUT,
    `${CLEANUP_EVIDENCE_OUTPUT}=true${os.EOL}`,
    'utf8',
  );
  return true;
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
 * npm's exit status for the tree read, as a problem in its own right.
 *
 * `findTreeProblems` above reads npm's *self-report* — the `problems` and
 * `error` keys it prints inside the JSON. That is a different channel from the
 * exit status, and the two are only correlated:
 *
 *     healthy tree            exit 0   `problems` absent
 *     an extraneous package   exit 0   `problems` present   <- status says nothing
 *     an invalid package      exit 1   `problems` present   <- both fire
 *
 * Every non-zero exit reachable through the real pipeline also populated
 * `problems`, so the tree self-report caught them all. But that is an
 * observation about npm's behaviour, not a property of this guard: if npm ever
 * exits non-zero without populating `problems`, a caller reading only the JSON
 * accepts a tree npm has already refused to vouch for. Reading the status makes
 * the refusal binding by construction rather than by correlation. Origin: #255.
 *
 * Fails closed on `null`, which is what `spawnSync` reports when the child is
 * killed by a signal and when the spawn itself never happened — neither is a
 * tree anyone should walk.
 *
 * @param {unknown} status exit status from `spawnSync`
 * @param {unknown} stderr the child's stderr, used only for the message
 * @returns {string[]} one problem string when npm refused, otherwise empty
 */
export function findTreeExitProblems(status, stderr) {
  if (status === 0) return [];
  const described =
    typeof status === 'number'
      ? `exited ${status}`
      : `exited ${String(status)}`;
  const detail =
    typeof stderr === 'string'
      ? (stderr.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '')
      : '';
  return [
    `\`${NPM_PRODUCTION_TREE_COMMAND}\` ${described}${
      detail ? `: ${detail.trim()}` : ''
    }`,
  ];
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

/**
 * Read the production tree, carrying npm's exit status alongside its output.
 *
 * Returns the status rather than throwing on it, so the decision layer in
 * `main` owns the verdict and can report npm's own problem strings in the same
 * message — the package names are what make a tree failure actionable, and npm
 * prints a usable tree alongside the failure. Origin: #255.
 *
 * @returns {{ tree: unknown, status: unknown, stderr: string }}
 */
function readProductionTree() {
  const { command, args } = npmInvocation(NPM_PRODUCTION_TREE_COMMAND);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = result.stderr ?? '';
  if (!result.stdout || !result.stdout.trim()) {
    const detail = stderr.trim().split(/\r?\n/, 1)[0];
    throw new Error(
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` produced no JSON output${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  try {
    return { tree: JSON.parse(result.stdout), status: result.status, stderr };
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

/**
 * Run the shipped CLI decision layer with injectable process boundaries.
 *
 * @param {{
 *   runNpmCi?: typeof runNpmCi,
 *   retryCleanupRemovals?: typeof retryCleanupRemovals,
 *   writeCleanupEvidence?: typeof writeCleanupEvidence,
 *   markCleanupEvidenceOutput?: typeof markCleanupEvidenceOutput,
 *   readProductionTree?: typeof readProductionTree,
 *   fail?: typeof fail,
 *   exit?: (code: number) => void,
 *   writeStderr?: (message: string) => void
 * }} [dependencies]
 */
export async function main({
  runNpmCi: runNpmCiImpl = runNpmCi,
  retryCleanupRemovals: retryCleanupRemovalsImpl = retryCleanupRemovals,
  writeCleanupEvidence: writeCleanupEvidenceImpl = writeCleanupEvidence,
  markCleanupEvidenceOutput:
    markCleanupEvidenceOutputImpl = markCleanupEvidenceOutput,
  readProductionTree: readProductionTreeImpl = readProductionTree,
  fail: failImpl = fail,
  exit: exitImpl = (code) => process.exit(code),
  writeStderr = (message) => process.stderr.write(message),
} = {}) {
  const { code, output } = await runNpmCiImpl();

  if (code !== 0) {
    return exitImpl(code);
  }

  if (hasCleanupFailure(output)) {
    let recovery;
    try {
      recovery = await retryCleanupRemovalsImpl(output);
    } catch (error) {
      recovery = {
        attempted: true,
        recovered: false,
        directories: extractCleanupDirectories(output),
        reason: `retry failed: ${error.message}`,
      };
    }

    if (recovery.recovered) {
      writeStderr(
        `npm-ci-strict: retried npm's requested Windows removal for ${recovery.directories.join(
          ', ',
        )}; validating the resulting tree before continuing.\n`,
      );
    } else {
      let productionTreeProblems = [];
      let productionTreeExitProblems = [];
      let productionTreeError = null;
      try {
        const { tree, status, stderr } = readProductionTreeImpl();
        productionTreeProblems = findTreeProblems(tree);
        productionTreeExitProblems = findTreeExitProblems(status, stderr);
      } catch (error) {
        productionTreeError = error.message;
      }

      const evidence = createCleanupEvidence({
        output,
        recovery,
        productionTreeProblems,
        productionTreeExitProblems,
        productionTreeError,
      });
      let evidenceResult;
      try {
        const evidencePath = await writeCleanupEvidenceImpl(evidence);
        await markCleanupEvidenceOutputImpl();
        evidenceResult = `Durable evidence staged at ${evidencePath}.`;
      } catch (error) {
        evidenceResult = `Durable evidence could not be staged: ${error.message}`;
      }

      // Fold both channels together, mirroring the primary gate further down:
      // npm's self-reported `problems`/`error` keys are a different channel
      // from its exit status, and a non-zero exit without populated
      // `problems` must not be reported as "no problems". Origin: #255, #700.
      const allProductionTreeProblems = [
        ...productionTreeExitProblems,
        ...productionTreeProblems,
      ];
      const productionTreeLine = productionTreeError
        ? `\`${NPM_PRODUCTION_TREE_COMMAND}\` could not be read: ${productionTreeError}`
        : allProductionTreeProblems.length > 0
          ? `\`${NPM_PRODUCTION_TREE_COMMAND}\` also reports problems: ${allProductionTreeProblems.join('; ')}`
          : `\`${NPM_PRODUCTION_TREE_COMMAND}\` reports no problems; the residue is outside the production tree.`;

      const paths = extractCleanupPaths(output);
      failImpl([
        '',
        CLEANUP_FAILURE_DIAGNOSTIC,
        '',
        'The installed tree is therefore neither the lockfile tree nor a clean one,',
        'and every later step in this job would run against it.',
        paths.length > 0 ? `Directories npm named: ${paths.join(', ')}` : '',
        `Automatic recovery: ${recovery.reason}.`,
        productionTreeLine,
        evidenceResult,
        '',
        'Do not rerun this job directly. Follow docs/npm-cleanup-recovery.md;',
        'the discharge workflow requires a justification, preserves the failed job',
        'reference on the durable cleanup tracking issue, and refuses to rerun',
        'mixed or policy failures.',
        '',
      ]);
      return;
    }
  }

  const { tree, status, stderr } = readProductionTreeImpl();

  const problems = findTreeProblems(tree);
  const exitProblems = findTreeExitProblems(status, stderr);
  if (exitProblems.length > 0) {
    failImpl([
      '',
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` refused the installed tree.`,
      '',
      ...[...exitProblems, ...problems].map((problem) => `  - ${problem}`),
      '',
      'npm printed a tree and exited non-zero. The exit status and the `problems`',
      'key are separate channels: every failure seen through the real pipeline set',
      'both, but this guard does not depend on that holding. A tree npm refuses to',
      'vouch for is not walked here regardless of what it printed. Origin: #255.',
      '',
    ]);
    return;
  }

  if (problems.length > 0) {
    failImpl([
      '',
      'npm-ci-strict: npm itself reported problems with the installed tree.',
      '',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` reports these even when it exits 0, which`,
      'is how a partially-wiped tree reaches the SBOM gate several steps later and',
      'reads there as an unrelated failure. Origin: #195. This control: #274.',
      '',
    ]);
    return;
  }

  const unresolved = findUnresolvedPackages(tree);
  if (unresolved.length > 0) {
    failImpl([
      '',
      'npm-ci-strict: the installed production tree contains packages npm cannot resolve.',
      '',
      `Unresolvable: ${unresolved.join(', ')}`,
      '',
      `\`${NPM_PRODUCTION_TREE_COMMAND}\` returned nodes with no version, or marked`,
      'extraneous/invalid. That is the same condition the npm SBOM completeness',
      'gate fails on, detected here at the install step instead of several steps',
      'later where it reads as an unrelated test failure. Origin: #195. This',
      'control: #274.',
      '',
    ]);
    return;
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
