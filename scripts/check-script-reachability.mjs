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
    'Either wire it into CI or delete it — tracked by issue #300, which is the ' +
    'discharge path for removing this entry.',
};

// npm scripts named check:*/verify:* that no workflow invokes. Same rule: the
// reason is the deliverable. "It is in package.json" is not enforcement —
// package.json is a menu, not a schedule.
export const UNENFORCED_CHECKS = {
  'check:review-coverage':
    'Its judgement IS enforced in CI: tests/reviewHeadCoverage.test.ts drives ' +
    'normalizeSha, reviewCoversHead, classifyCoverage, evaluateControls, ' +
    'evaluateSweep and formatSweep over plain objects, including both control ' +
    'arms that can be reached without a live corpus. Its main() is a CENSUS ' +
    'over the merged population, so running it per-PR would re-scan the whole ' +
    'history on every push to answer a question that only changes when ' +
    'something merges. ' +
    'STATE THE WEAKNESS PLAINLY: it therefore reports only when a human runs ' +
    'it, which is weaker than a schedule and is not a gate at all. That is ' +
    'deliberate and it is the point — with required_approving_review_count at ' +
    '0, one collaborator, and GitHub refusing self-approval, a gate on review ' +
    'coverage cannot be satisfied by any pull request and would deadlock the ' +
    'repository permanently. #280 asked for the absence to be made VISIBLE, ' +
    'not enforced. Discharge path: a scheduled workflow once someone owns the ' +
    'cadence — it guards a repository-wide property, not any given change.',
  'check:protection-assumptions':
    'Its evaluator IS enforced in CI: tests/protectionAssumptions.test.ts pins ' +
    'every premise as data and fails if one is widened. Its main() reads ' +
    'branch protection, rulesets, protected branches and the collaborator set, ' +
    'and every one of those endpoints needs admin scope that the default ' +
    'GITHUB_TOKEN does not carry — the same constraint recorded for ' +
    'check:merge-queue-contexts above. Running it in CI would degrade to the ' +
    'half the tests already cover, and would do it silently. ' +
    'STATE THE WEAKNESS PLAINLY: this makes it a tripwire that only fires when ' +
    'a human runs it, so #151 revisit trigger is faster to check but still not ' +
    'automatic. That is weaker than intended and better than the paragraph it ' +
    'replaces, which nothing re-read at all. Discharge path: wire it into a ' +
    'scheduled workflow the moment a privileged token exists as a repository ' +
    'secret — at which point it should run on a schedule rather than per-PR, ' +
    'because it guards repository configuration and not any given change.',
  'check:merge-queue-contexts':
    'Its classification half IS enforced in CI: tests/mergeQueueReadiness.test.ts ' +
    'exercises every exported rule under `npm run test`. Its main() additionally ' +
    'compares the live required-context set, which needs a branch-protection read ' +
    'that the default GITHUB_TOKEN does not carry, so running it in CI would ' +
    'degrade to the half the tests already cover. Invoked by hand with a ' +
    'privileged token when the queue configuration changes.',
  'check:required-contexts':
    'Its judgement IS enforced in CI: tests/requiredContexts.test.ts drives ' +
    'evaluateRequiredContexts, latestRunNamed and main over plain objects and ' +
    'a stub spawn, so all four exit codes are exercised under `npm run test`. ' +
    'Its main() additionally needs two things CI cannot supply for the PR it is ' +
    'asked about: a credential, and a PULL REQUEST NUMBER. The second is the ' +
    'real obstruction and it is not incidental — this check answers "is THIS ' +
    'pull request ready to merge", which is a question asked BY a human or a ' +
    'merge driver at the moment of merging, not a property of a commit that a ' +
    'per-PR workflow could assert about itself. A pull_request run of it would ' +
    'be asking whether its own still-running checks had finished, which is ' +
    'answerable only in the negative. ' +
    'STATE THE WEAKNESS PLAINLY: nothing forces anyone to run this before ' +
    'merging, so it does not prevent a merge on a head missing a required ' +
    'context. It replaces a ritual ("report the seven by name") with a command, ' +
    'which is strictly better than the ritual and strictly weaker than a gate. ' +
    'Discharge path: invoke it from whatever performs the merge, and treat a ' +
    'non-zero exit as a refusal — at which point it becomes a gate and this ' +
    'entry should be deleted.',
  'check:squad-verdict':
    'Its verifier logic IS enforced in CI: tests/squadReviewVerdict.test.ts ' +
    'drives bindStatusToHead, verifySquadVerdict and selectSquadVerdict over ' +
    'plain fixtures, including the forgery/lookalike/rerun arms and both ' +
    'directions of head-movement supersession. Its main() additionally needs ' +
    'a specific PR number and a live commit status posted by a prior, ' +
    'independently-dispatched run of squad-review-verdict.yml — neither of ' +
    'which a per-PR CI run can supply about itself without asking whether its ' +
    'own still-running checks had finished. ' +
    'STATE THE WEAKNESS PLAINLY: nothing forces anyone to run this before ' +
    'merging, and squad-review-verdict.yml itself is workflow_dispatch-only, ' +
    'so no PR here carries a squad/pre-pr-verdict status until a non-author ' +
    'administrator manually dispatches it. Until then, review here is ' +
    'advisory and author-opened squad PRs require a human GitHub approval ' +
    'before merge — recorded as a decision in ' +
    '.squad/decisions/inbox/vasquez-187-squad-verdict-evidence.md, not left ' +
    'implicit. Ported from OlyForge3D/PrintFarmer #1187 (fixing PrintFarmer ' +
    'issue #1116), which carries the identical unwired script for the ' +
    'identical reason. Discharge path: the day #111/#151 revisit trigger ' +
    'fires (a second collaborator or non-admin automation account), a ' +
    'non-author administrator can dispatch the verdict workflow for real, ' +
    'and this check becomes invocable from whatever performs the merge.',
  'check:behind-base':
    'Its judgement IS enforced in CI: tests/behindBase.test.ts drives ' +
    'evaluateBehindBase and formatResult over plain objects, exercising all ' +
    'three states under `npm run test`. Its main() needs the same two things ' +
    '`check:required-contexts` needs and cannot get from a pull_request run: a ' +
    'credential, and the PR NUMBER being merged — this answers "is THIS PR ' +
    'behind THIS base right now", asked at the moment of merging, not a ' +
    'property a commit could assert about itself while still open (#397: the ' +
    'incident this exists for is a PR that was green and BEHIND simultaneously; ' +
    'a workflow attached to that same PR run cannot see what lands on the base ' +
    'after it). ' +
    'STATE THE WEAKNESS PLAINLY: `enforce_admins: false` already makes the ' +
    'server-side `strict` requirement bypassable for the sole admin merger ' +
    '(#397, #388), so this check is not a second server-side gate either — it ' +
    'is a client-side one, same shape as scripts/push-guard.mjs for force-pushes. ' +
    'Nothing forces anyone to run it before `gh pr merge`; `.squad/skills/' +
    'git-workflow/SKILL.md` documents it as a required step, and a documented ' +
    'step is a convention, not a control, until something runs it for you. ' +
    'Discharge path: invoke it from whatever performs the merge and treat a ' +
    'non-zero exit as a refusal — at which point it becomes a gate and this ' +
    'entry should be deleted.',
  'check:stale-checkout-head':
    'Its judgement IS enforced in CI: tests/staleCheckoutHead.test.ts drives ' +
    'normalizeSha, classifyHeadFreshness, evaluateControls and formatResult ' +
    'over plain objects, including both control arms, under `npm run test`. ' +
    'Its main() answers "is THIS checkout\'s read of THIS branch/PR still ' +
    'live", which is a question asked by whoever is ABOUT TO USE a shared ' +
    'checkout at the moment they use it (#473) — not a property of a commit ' +
    'that a pull_request-triggered workflow could assert about itself, and ' +
    'the same shape check:required-contexts and check:stacked-base above are ' +
    'unenforced for. Discharge path: invoke it by hand (or from whatever reads ' +
    'a shared checkout before quoting a head) whenever a session is about to ' +
    'report a PR head from a local branch that was not just freshly cloned.',
  'check:closed-head-dispatch':
    'Its judgement IS enforced in CI: tests/closedHeadDispatch.test.ts drives ' +
    'normalizeSha, classifyDispatch, evaluateControls and formatResult over ' +
    'plain objects, including the "query failure is not the same as silent" ' +
    'control, under `npm run test`. #380: PR #281 closed at two heads with ' +
    'total_count: 0 workflow runs and nothing noticed; this check reads a ' +
    "closed PR's head sha from the close event itself and fails loudly on " +
    'that shape. Its workflow (.github/workflows/closed-head-dispatch.yml, ' +
    'fully written and covered by the same test file) is NOT yet committed — ' +
    "not a design choice, a measured one: the authoring session's git " +
    'credential is bound to a fixed OAuth App token that GitHub itself ' +
    'rejects for any push touching `.github/workflows/*` ("refusing to allow ' +
    'an OAuth App to create or update workflow ... without `workflow` ' +
    'scope"), independent of which `gh auth` account is active locally. ' +
    'STATE THE WEAKNESS PLAINLY: until a maintainer with `workflow` scope ' +
    'adds the file, nothing dispatches this check automatically and it is ' +
    'exactly as invisible as the failure mode it exists to catch. Full ' +
    'workflow text and the exact rejection is recorded in ' +
    'docs/closed-head-dispatch.md. Discharge path: a maintainer pastes that ' +
    'file in as-is and deletes this entry — the reachability check will then ' +
    'find it invoked for real.',
  'check:direct-push-artifact':
    'Its evaluator IS enforced in CI: tests/directPushArtifact.test.ts drives ' +
    'findBareCommits, formatBareCommitEvidence, alreadyRecorded and the fetch ' +
    'helpers over plain objects and a stubbed fetch/exec, under `npm run test`. ' +
    "Its main() needs the same 'workflow' OAuth scope check:closed-head-dispatch " +
    'above is blocked on: a push-triggered workflow file under ' +
    '.github/workflows/ is what would invoke it automatically, and this ' +
    "session's credential lacks 'workflow' scope for any diff touching that " +
    'directory, measured the same way (#380, #388). ' +
    'STATE THE WEAKNESS PLAINLY: until a maintainer with `workflow` scope adds ' +
    'the trigger file, nothing runs this after a push lands, and the artifact ' +
    'it exists to leave (#388 remedy 3, for the enforce_admins exemption) is ' +
    'only posted when a human invokes it by hand. That is weaker than intended ' +
    'and it is still a record where today there is none at all — the two known ' +
    '2026-08-04 bypass commits were posted to #388 by hand as part of closing ' +
    'that issue. Discharge path: the day a maintainer commits ' +
    '.github/workflows/direct-push-artifact.yml (on: push, branches: ' +
    '[development]) invoking `npm run check:direct-push-artifact -- --since ' +
    '<previous head>`, this becomes enforced and this entry should be deleted.',
};

// `check:citation-reachability` was here, with a four-condition discharge path.
// All four are now met and it is invoked by .github/workflows/citation-reachability.yml,
// so it classifies as `enforced` and this entry would never be read again:
//
//   1. repair or declare the orphans — #328, merged. Re-measured afterwards in a
//      clean 144-ref clone of `development`, not in a worktree: REACHABLE 43,
//      TWIN 44, DECLARED 9, ORPHAN 0, exit 0. The earlier 36/22 was true when
//      written; the clean clone matters because this machine holds 4018 refs
//      including `refs/copilot/checkpoints/…` that no clone has, and the harness
//      names one citation that survives here and nowhere else.
//   2. fetch-depth: 0                    — workflow, checkout step
//   3. explicit origin/development fetch — workflow, "Fetch the mainline" step
//   4. assert the reachable-commit count — workflow, "Assert the checkout holds
//      history" step. Narrowed from its original wording on measurement: the
//      shallow arm it describes is already covered by the harness itself, which
//      exits 2 INCONCLUSIVE on a depth-1 clone rather than reporting ORPHAN.
//
// Note the removal itself, because until this commit nothing would have forced
// it. `evaluateCheckEnforcement` classifies a wired check as `enforced` before
// it ever consults this object, so a stale justification is not an error and not
// a warning — it is unreachable text that still reads as a current statement of
// policy.
//
// The test suite looked like it covered this and did not. `tests/scriptReachability.test.ts`
// has a describe block named "the allowlists cannot rot quietly" — plural —
// containing `holds no entry that is in fact invoked, so a stale exemption is
// caught`. That test iterates UNINVOKED_SCRIPTS only. UNENFORCED_CHECKS is
// checked for presence in package.json and never for whether a workflow now runs
// it. Measured, not read: re-adding a stale `check:citation-reachability` entry
// while this workflow invokes it left all 28 tests green. The plural in the
// block name is the whole defect — one allowlist is protected and the name
// covers both. The missing case is added in that file alongside this commit.

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

/**
 * Which relative imports between scripts do not resolve to a TRACKED file.
 *
 * FOUND BY RUNNING A SCRIPT, NOT BY READING ONE. I copied
 * check-required-contexts.mjs out of scripts/ without its three siblings and
 * ran it. Node exited 1 with ERR_MODULE_NOT_FOUND — and 1 in that file's
 * taxonomy means "a required context is present and not green". A module that
 * never loaded produced a verdict about a pull request.
 *
 * That file already wraps main() precisely so an exception cannot masquerade as
 * a finding, and the wrapper is correct and could not have helped: ESM resolves
 * the whole static import graph BEFORE evaluating the module, so at the moment
 * of failure there is no main to catch anything. Every check script in this
 * repository shares the shape — a taxonomy of small exit codes, and exit 1
 * already spoken for by a real finding — so ANY of them turns a renamed sibling
 * into a confident false verdict. No in-process handler can close that; the
 * only decidable half is upstream, and it is this: the target must be there.
 *
 * TRACKED, not merely present on disk. An untracked sibling loads on the
 * machine that created it and is absent from every fresh checkout, which is the
 * form of this defect that reaches CI rather than staying local.
 *
 * Pure over resolved facts, and deliberately taking no fs and no reader: an
 * injected collaborator that no caller ever omits is a collaborator nothing
 * executes, so the honest way to make this drivable is to hand it data.
 *
 * SCOPE IS LOAD-BEARING AND WAS MEASURED, NOT ASSUMED. Run repo-wide over every
 * tracked source file, a regex for import specifiers reported 2 unresolved of
 * 557 — and both were ordinary STRINGS inside
 * tests/calibrationMaliciousInputCorpus.test.ts ('...' and './x.js'), which is
 * a corpus of hostile paths and therefore full of text shaped like imports.
 * Restricted to scripts/*.mjs — machine-formatted, prettier-enforced, no such
 * fixtures — the same pattern reports 18 specifiers and 0 unresolved. Widening
 * this to .ts requires a parser, not a better regex, and that is a different
 * change. Text matching cannot tell an import from a string that reads like
 * one; narrowing the corpus to where the distinction cannot arise is what makes
 * the cheap instrument sound rather than merely quiet.
 *
 * @param {{ sources: readonly {path: string, contents: string}[],
 *           trackedPaths: ReadonlySet<string> }} input
 */
export function evaluateImportResolution({ sources, trackedPaths }) {
  const resolved = [];
  const unresolved = [];

  for (const { path: filePath, contents } of sources) {
    for (const specifier of relativeImportSpecifiers(contents)) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(filePath), specifier),
      );
      const record = { from: filePath, specifier, target };
      if (trackedPaths.has(target)) {
        resolved.push(record);
      } else {
        unresolved.push(record);
      }
    }
  }

  return { resolved, unresolved };
}

/**
 * Relative import specifiers, line-anchored.
 *
 * Only a whole line of the form `import ... from './x.mjs';` counts. See the
 * scope note on evaluateImportResolution for why this is restricted rather
 * than made cleverer.
 *
 * @param {string} contents
 * @returns {string[]}
 */
export function relativeImportSpecifiers(contents) {
  return [...contents.matchAll(/^import .*? from '(\.[^']*)';$/gm)]
    .map((match) => match[1])
    .filter((specifier) => typeof specifier === 'string');
}

export function formatFindings({ reachability, enforcement, imports }) {
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

  for (const { from, specifier, target } of imports?.unresolved ?? []) {
    lines.push(
      `${from} imports '${specifier}', which is not a tracked file (${target}). ` +
        `The module will fail to load and Node will exit 1 — the code most of ` +
        `these scripts reserve for a real finding.`,
    );
  }

  return lines;
}

/**
 * Every tracked path, unfiltered.
 *
 * readTrackedFiles() keeps only source-ish files because it needs their
 * CONTENTS. An import target is a membership question, not a content one, and
 * filtering by extension there would report a real file as missing purely for
 * having an extension this scanner does not read.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function readAllTrackedPaths(repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
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

  const imports = evaluateImportResolution({
    sources: files.filter(({ path: p }) => scripts.includes(p)),
    trackedPaths: new Set(readAllTrackedPaths(repoRoot)),
  });

  if (imports.resolved.length + imports.unresolved.length === 0) {
    // Same reason as the empty-scripts throw above. Scripts in this repository
    // do import each other; finding none means the matcher stopped working,
    // and reporting "no unresolved imports" from a scan that examined nothing
    // is the vacuous pass this file exists to prevent.
    throw new Error(
      'found no relative imports among scripts/*.mjs — the scan is broken, not the repository clean',
    );
  }

  const findings = formatFindings({ reachability, enforcement, imports });

  console.log(
    `Checked ${scripts.length} scripts and ` +
      `${enforcement.enforced.length + enforcement.declared.length + enforcement.unenforced.length} check/verify npm scripts.`,
  );
  console.log(
    `  invoked: ${reachability.invoked.length}  declared-uninvoked: ${reachability.declared.length}  ` +
      `enforced: ${enforcement.enforced.length}  declared-unenforced: ${enforcement.declared.length}`,
  );
  console.log(
    `  relative imports between scripts: ${imports.resolved.length} resolved  ` +
      `${imports.unresolved.length} unresolved`,
  );

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`  ${finding}`);
    }
    throw new Error(
      `${findings.length} unreachable script(s) or unrun check(s)`,
    );
  }

  console.log(
    '  no undeclared orphans, no undeclared unrun checks, and every relative import resolves.',
  );
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
