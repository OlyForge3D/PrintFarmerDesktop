// Finds scripts and checks that exist but never run.
//
// The defect this exists for: a guard is written, reviewed, merged, and then
// nothing ever invokes it. It is not broken — it is absent, and absence reads
// exactly like success. `scripts/check-citation-reachability.mjs` (#162) was
// 197 lines with no call site while three documents said "Enforced by" in the
// present tense; `available_resolutions()` at sync.rs:1213 is `pub` with zero
// callers, which is precisely why the compiler's own dead-code lint cannot
// fire on it. A detector that is never invoked is indistinguishable from one
// that is invoked and always passes.
//
// The design constraint is that this file must make a wrong answer
// UNRETURNABLE rather than merely detectable. A new script with no invocation
// is an error, not a warning, and the only way to silence it is an allowlist
// entry carrying a written reason. You cannot add an unrun check quietly; you
// can only add one and say why in the diff.
//
// No shebang: this module is imported by tests/scriptReachability.test.ts, and
// vite's transform does not strip one the way node does.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPT_DIRECTORY = 'scripts';

// Scripts that legitimately have no automated invocation. A reason is
// mandatory and is asserted non-empty by the test suite, because an allowlist
// whose entries need no justification is just a way to delete the check one
// line at a time.
export const UNINVOKED_SCRIPTS = {
  'generate-installer-gif.mjs':
    'Regenerates assets/installing.gif, a committed binary. Run by hand when the ' +
    'branding changes — forge.config.ts documents the command. Deliberately not ' +
    'automated: it needs a display-capable Electron renderer, and the output is ' +
    'reviewed as a binary diff rather than trusted.',
  'mvp-smoke.mjs':
    'ORPHANED, not manual: a headless end-to-end smoke test with zero references ' +
    'anywhere in the repository — no npm script, no workflow, no import, no ' +
    'documentation. Recorded here so it is visible rather than silently dead. ' +
    'Either wire it into CI or delete it; see the issue tracking this.',
};

// npm scripts named check:*/verify:* that no workflow invokes. Same rule: the
// reason is the deliverable. "It is in package.json" is not enforcement —
// package.json is a menu, not a schedule.
export const UNENFORCED_CHECKS = {
  'check:merge-queue-contexts':
    'Its classification half IS enforced in CI: tests/mergeQueueReadiness.test.ts ' +
    'exercises every exported rule under `npm run test`. Its main() additionally ' +
    'compares the live required-context set, which needs a branch-protection read ' +
    'that the default GITHUB_TOKEN does not carry, so running it in CI would ' +
    'degrade to the half the tests already cover. Invoked by hand with a ' +
    'privileged token when the queue configuration changes.',
};

const IGNORED_SUFFIXES = ['.d.mts'];

/**
 * Source files whose contents can express an invocation. Markdown and YAML
 * outside `run:` are deliberately excluded: a document saying a script is
 * "enforced" is the exact claim this file exists to disbelieve.
 */
export const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts'];

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every line that forms part of a `run:` command, including the continuation
 * lines of a block scalar.
 *
 * Matching only lines that begin with `run:` is wrong here and the repository
 * proves it: `release.yml` invokes both `notarize-macos-release.mjs` and
 * `verify-update-key-pair.mjs` from inside `run: |` blocks, several lines below
 * the key. A line-anchored test reports two live release steps as dead code —
 * a false positive rate that would get this check deleted the first week.
 */
export function runCommandLines(contents) {
  const collected = [];
  let blockIndent = null;

  for (const line of contents.split(/\r?\n/)) {
    if (blockIndent !== null) {
      if (line.trim() === '') {
        collected.push(line);
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent > blockIndent) {
        collected.push(line);
        continue;
      }
      blockIndent = null;
    }

    const match = /^(\s*)(-\s*)?run:(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    collected.push(line);
    if (/^[|>][-+]?\d*\s*$/.test(match[3].trim())) {
      blockIndent = match[1].length;
    }
  }

  return collected;
}

/**
 * Whether `contents` invokes `basename`, as opposed to merely mentioning it.
 *
 * The distinction is the whole point and it is not pedantry. In this
 * repository `forge.config.ts` both invokes `stage-compliance.mjs` — via
 * `runBuildScript('stage-compliance.mjs', ...)` — and mentions
 * `generate-installer-gif.mjs` in a comment explaining how to run it by hand.
 * A checker that counts occurrences calls both reachable and reports nothing.
 */
export function invocationKinds({ basename, filePath, contents }) {
  const name = escapeForRegExp(basename);
  const kinds = [];

  if (path.basename(filePath) === 'package.json') {
    let manifest;
    try {
      manifest = JSON.parse(contents);
    } catch {
      return kinds;
    }
    const scripts = manifest.scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      if (
        typeof value === 'string' &&
        new RegExp(`${SCRIPT_DIRECTORY}/${name}(\\s|$)`).test(value)
      ) {
        kinds.push({ kind: 'npm', where: `package.json:scripts.${key}` });
      }
    }
    return kinds;
  }

  if (/\.ya?ml$/.test(filePath)) {
    for (const line of runCommandLines(contents)) {
      if (new RegExp(`${SCRIPT_DIRECTORY}/${name}`).test(line)) {
        kinds.push({ kind: 'workflow', where: filePath });
      }
    }
    return kinds;
  }

  if (!SOURCE_EXTENSIONS.includes(path.extname(filePath))) {
    return kinds;
  }

  // A static import or dynamic import() of the module.
  if (
    new RegExp(`(from|import\\()\\s*['"][^'"]*${name}['"]`).test(contents) ||
    new RegExp(
      `(from|import\\()\\s*['"][^'"]*${name.replace(/\\\.mjs$/, '')}\\.mjs['"]`,
    ).test(contents)
  ) {
    kinds.push({ kind: 'import', where: filePath });
  }

  // Passed as a quoted argument to a call, which is how forge.config.ts runs
  // its build scripts. Requires the opening paren so that an array entry in a
  // lint config — `files: ['scripts/generate-installer-gif.mjs']` — does not
  // count as running anything.
  if (new RegExp(`\\(\\s*['"][^'"]*${name}['"]`).test(contents)) {
    kinds.push({ kind: 'dynamic', where: filePath });
  }

  return kinds;
}

/**
 * Which scripts nothing invokes.
 *
 * `files` excludes the script itself and its `.d.mts` sibling, so a module
 * cannot make itself reachable by naming itself.
 */
export function evaluateScriptReachability({ scripts, files, allowlist }) {
  const known = allowlist ?? UNINVOKED_SCRIPTS;
  const orphans = [];
  const declared = [];
  const invoked = [];

  for (const scriptPath of scripts) {
    const basename = path.basename(scriptPath);
    if (IGNORED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
      continue;
    }

    const kinds = files
      .filter(
        (file) =>
          file.path !== scriptPath &&
          file.path !== scriptPath.replace(/\.mjs$/, '.d.mts'),
      )
      .flatMap((file) =>
        invocationKinds({
          basename,
          filePath: file.path,
          contents: file.contents,
        }),
      );

    if (kinds.length > 0) {
      invoked.push({ basename, kinds });
    } else if (Object.prototype.hasOwnProperty.call(known, basename)) {
      declared.push({ basename, reason: known[basename] });
    } else {
      orphans.push({ basename });
    }
  }

  return { orphans, declared, invoked };
}

/**
 * Which `check:*`/`verify:*` npm scripts no workflow ever runs.
 *
 * Being defined in package.json is not enforcement. This is the half that
 * catches a guard which is real, tested, and simply never scheduled.
 */
export function evaluateCheckEnforcement({
  packageScripts,
  workflows,
  allowlist,
}) {
  const known = allowlist ?? UNENFORCED_CHECKS;
  const unenforced = [];
  const declared = [];
  const enforced = [];

  for (const key of Object.keys(packageScripts)) {
    if (!/^(check|verify):/.test(key)) {
      continue;
    }

    const runners = workflows.filter(({ contents }) =>
      runCommandLines(contents).some((line) =>
        new RegExp(`npm run ${escapeForRegExp(key)}(\\s|$)`).test(line),
      ),
    );

    if (runners.length > 0) {
      enforced.push({ key, workflows: runners.map(({ path: p }) => p) });
    } else if (Object.prototype.hasOwnProperty.call(known, key)) {
      declared.push({ key, reason: known[key] });
    } else {
      unenforced.push({ key });
    }
  }

  return { unenforced, declared, enforced };
}

export function formatFindings({ reachability, enforcement }) {
  const lines = [];

  for (const { basename } of reachability.orphans) {
    lines.push(
      `scripts/${basename} is never invoked: no npm script, no workflow \`run:\`, ` +
        `no import, no call. Wire it up, delete it, or add it to ` +
        `UNINVOKED_SCRIPTS with a reason.`,
    );
  }

  for (const { key } of enforcement.unenforced) {
    lines.push(
      `npm script \`${key}\` is defined but no workflow runs it, so it enforces ` +
        `nothing. Add it to a workflow, or add it to UNENFORCED_CHECKS with a reason.`,
    );
  }

  return lines;
}

export function readTrackedFiles(repoRoot) {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const files = [];
  for (const relative of listed.split('\0')) {
    if (!relative) {
      continue;
    }
    const extension = path.extname(relative);
    const isInteresting =
      SOURCE_EXTENSIONS.includes(extension) ||
      /\.ya?ml$/.test(relative) ||
      path.basename(relative) === 'package.json';
    if (!isInteresting) {
      continue;
    }
    try {
      files.push({
        path: relative,
        contents: readFileSync(path.join(repoRoot, relative), 'utf8'),
      });
    } catch {
      // A tracked path that cannot be read is not evidence of an invocation.
    }
  }

  return files;
}

async function main() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );

  const files = readTrackedFiles(repoRoot);
  const scripts = files
    .map(({ path: p }) => p)
    .filter((p) => p.startsWith(`${SCRIPT_DIRECTORY}/`) && p.endsWith('.mjs'));

  if (scripts.length === 0) {
    // Reporting "nothing unreachable" after finding nothing to check is the
    // vacuous pass this file exists to prevent, so it is an error instead.
    throw new Error(
      `found no ${SCRIPT_DIRECTORY}/*.mjs to check — the scan is broken, not the repository clean`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );

  const reachability = evaluateScriptReachability({ scripts, files });
  const enforcement = evaluateCheckEnforcement({
    packageScripts: manifest.scripts ?? {},
    workflows: files.filter(({ path: p }) =>
      p.startsWith('.github/workflows/'),
    ),
  });

  const findings = formatFindings({ reachability, enforcement });

  console.log(
    `Checked ${scripts.length} scripts and ` +
      `${enforcement.enforced.length + enforcement.declared.length + enforcement.unenforced.length} check/verify npm scripts.`,
  );
  console.log(
    `  invoked: ${reachability.invoked.length}  declared-uninvoked: ${reachability.declared.length}  ` +
      `enforced: ${enforcement.enforced.length}  declared-unenforced: ${enforcement.declared.length}`,
  );

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`  ${finding}`);
    }
    throw new Error(
      `${findings.length} unreachable script(s) or unrun check(s)`,
    );
  }

  console.log('  no undeclared orphans and no undeclared unrun checks.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Script reachability check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
