#!/usr/bin/env node
// Run mutation arms with the controls that make their results mean something.
//
// #371 established, with measurements, that a mutation result on Windows can be
// silently confounded: mutate -> run -> restore, and if the restore is skipped
// the next arm runs against stacked damage. It still goes red, the red is the
// one you predicted, and nothing in the output says the restore never happened.
//
// #371 concludes with a protocol. This file exists because a protocol is a
// commitment: the only party able to skip a verification step is the person
// performing it, and they skip it in exactly the state where they are confident.
// Everything the protocol asks a human to remember is asserted here instead.
//
// THREE CONTROLS, each of which caught a real defect while this was written or
// in the run that produced #371:
//
//   1. THE MUTATION LANDED. Anchor occurrences are counted before the write and
//      the replacement is counted after. An anchor that matches zero times is a
//      silent no-op -- the harness that produced this file emitted two of them
//      in one batch, and both would have been read as "the mutation survived".
//
//   2. THE EXTRACTOR WORKS. A baseline arm runs the suite UNMUTATED and the
//      parse must yield failed === 0 with passed > 0. This is the only control
//      that can catch a broken result parser, because a parser that reports
//      nothing reports nothing identically for a killed mutant and a survivor.
//      Measured instance, twice independently: `Select-String 'Tests '` is
//      case-insensitive and matches vitest's Duration line, which contains
//      `tests 4ms`. It reported "0 failed" for an arm that killed one test.
//
//   3. THE RESTORE LANDED. After every arm the working file is hashed and
//      compared against the blob pinned before the run, and the mutation
//      residue is counted and must be zero. `git rev-parse <sha>:<path>` is
//      deliberately NOT used: it resolves a path inside a commit, so it is
//      blind to the working tree and reported "matches trunk" with live
//      residue on disk (#371 arm 4, #367 instance 8).
//
// A CONFOUNDED ARM IS NOT A SURVIVING ARM. That distinction is the whole point.
// A mutation that was never applied has told you nothing; reporting it as
// "survived" invents a finding, and reporting it as "killed" invents an
// assurance. It exits 2, which is neither.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// The lock protocol is shared with tests/mutationWindowGuard.ts rather than
// restated here; see scripts/mutationWindowProtocol.mjs for why.
import {
  MUTATION_TOKEN_VARIABLE,
  lockPathFor,
} from './mutationWindowProtocol.mjs';

export { MUTATION_TOKEN_VARIABLE, lockPathFor };

import {
  INCONCLUSIVE,
  UNMATCHED,
  checkSelectors,
  formatRefusal,
} from './vitest-strict.mjs';

export const ARM_KILLED = 'killed';
export const ARM_SURVIVED = 'survived';
export const ARM_CONFOUNDED = 'confounded';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

/**
 * Parse a vitest run summary into counts.
 *
 * Case sensitivity is load-bearing, not stylistic. vitest prints a Duration
 * line containing `tests 4ms`, so a case-insensitive match on "Tests " finds
 * the timing line, extracts no counts, and yields a confident zero. Both
 * sessions that wrote a result extractor for this repo hit that exact line.
 *
 * The leading anchor also excludes the `Failed Tests 4` banner, which is a
 * count of failing FILES sections rather than of tests.
 */
export function parseTestSummary(output) {
  const text = stripAnsi(output);
  const line = /^[ \t]*Tests[ \t]+([^\n]*)$/m.exec(text);
  if (!line) {
    return null;
  }
  const failed = /(\d+)[ \t]+failed/.exec(line[1]);
  const passed = /(\d+)[ \t]+passed/.exec(line[1]);
  if (!failed && !passed) {
    return null;
  }
  return {
    failed: failed ? Number(failed[1]) : 0,
    passed: passed ? Number(passed[1]) : 0,
  };
}

export function countOccurrences(haystack, needle) {
  if (needle === '') {
    throw new Error('refusing to count occurrences of an empty string');
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Did the write actually change the file in the way the arm intended?
 *
 * `expectedAnchors` defaults to 1 because an anchor matching several places
 * mutates several places, and an arm that changes more than it claims is as
 * unreadable as one that changes nothing.
 */
export function classifyApplication({
  anchorsBefore,
  replacementsAfter,
  expectedAnchors = 1,
} = {}) {
  if (anchorsBefore !== expectedAnchors) {
    return {
      applied: false,
      reason: `anchor matched ${anchorsBefore} times, expected ${expectedAnchors}; the write was a no-op or hit more than it claimed`,
    };
  }
  if (replacementsAfter < 1) {
    return {
      applied: false,
      reason:
        'the replacement is not present after the write, so the file on disk is not the file this arm describes',
    };
  }
  return { applied: true, reason: 'mutation present on disk' };
}

/**
 * Did the file come back? Two readings are required, because each is blind to
 * something the other sees: a hash comparison misses damage to other files,
 * and the porcelain delta misses nothing but cannot name what changed.
 *
 * There is deliberately no residue count here. A hash match already entails
 * byte-identity with the pinned blob, and byte-identity already entails zero
 * occurrences of the replacement beyond whatever the pinned blob itself
 * contains -- so a residue check reachable only after the hash has matched
 * can never confirm anything the hash didn't already confirm, and can only
 * ever produce a false CONFOUNDED verdict when the replacement string (e.g.
 * `;`) happens to occur naturally in the file (#557). The residue count is
 * still meaningful in `classifyApplication`, where it runs BEFORE any hash
 * check and confirms the mutation actually landed.
 *
 * The porcelain reading is a DELTA, not an absolute. An absolute reading was
 * measured against this very repository and confounded every arm, because the
 * file under test was untracked and reported `??` before the run had begun --
 * an arm confounded by a condition that predates it is a false alarm, and a
 * false alarm whose remedy is "stop using the harness" is worse than the
 * silence it replaced. Comparing before against after asks the question that
 * is actually owed: did THIS ARM leave anything behind.
 */
export function classifyRestore({
  pinnedHash,
  actualHash,
  porcelainBefore,
  porcelainAfter,
} = {}) {
  if (typeof pinnedHash !== 'string' || pinnedHash === '') {
    throw new Error('pinnedHash is required to verify a restore');
  }
  if (actualHash !== pinnedHash) {
    return {
      restored: false,
      reason: `working file hashes ${actualHash}, pinned blob is ${pinnedHash}`,
    };
  }
  const before = normaliseStatus(porcelainBefore);
  const after = normaliseStatus(porcelainAfter);
  const introduced = after.filter((line) => !before.includes(line));
  if (introduced.length > 0) {
    return {
      restored: false,
      reason: `this arm left the working tree changed: ${introduced.join('; ')}`,
    };
  }
  return { restored: true, reason: 'file and tree restored' };
}

function normaliseStatus(porcelain) {
  if (typeof porcelain !== 'string') {
    return [];
  }
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The baseline is what licenses every later reading. If the suite does not pass
 * unmutated, or the extractor cannot read that it passed, nothing downstream is
 * interpretable and the run must not produce findings.
 */
export function classifyBaseline(summary) {
  if (summary === null) {
    return {
      usable: false,
      reason:
        'the result extractor produced nothing on an unmutated run, so it cannot distinguish a killed mutant from a survivor',
    };
  }
  if (summary.failed !== 0) {
    return {
      usable: false,
      reason: `${summary.failed} test(s) fail before any mutation, so a red arm proves nothing about the mutation`,
    };
  }
  if (summary.passed <= 0) {
    return {
      usable: false,
      reason:
        'the unmutated run reports zero passing tests, so the suite selected here exercises nothing',
    };
  }
  return {
    usable: true,
    reason: `baseline ${summary.passed} passed, 0 failed`,
  };
}

export function classifyArm({ application, restore, summary } = {}) {
  // Order matters. An arm whose mutation never landed is confounded even if the
  // suite went red, because something else made it red.
  if (application && application.applied === false) {
    return { state: ARM_CONFOUNDED, reason: application.reason };
  }
  if (restore && restore.restored === false) {
    return { state: ARM_CONFOUNDED, reason: restore.reason };
  }
  if (!summary) {
    return {
      state: ARM_CONFOUNDED,
      reason: 'the result extractor produced nothing for this arm',
    };
  }
  if (summary.failed > 0) {
    return {
      state: ARM_KILLED,
      reason: `${summary.failed} test(s) failed`,
      failed: summary.failed,
    };
  }
  return {
    state: ARM_SURVIVED,
    reason: 'every test passed with the mutation on disk',
  };
}

/**
 * Exit 0 every arm killed, 1 an arm survived, 2 the run cannot be interpreted.
 * Confounded outranks survived: an unreadable run must never be reported as a
 * finding, and a surviving mutant is a finding.
 */
export function evaluateRun(arms) {
  const confounded = arms.filter(({ state }) => state === ARM_CONFOUNDED);
  const survived = arms.filter(({ state }) => state === ARM_SURVIVED);
  if (confounded.length > 0) {
    return {
      exitCode: 2,
      verdict: 'confounded',
      confounded,
      survived,
    };
  }
  if (survived.length > 0) {
    return { exitCode: 1, verdict: 'survived', confounded, survived };
  }
  return { exitCode: 0, verdict: 'all-killed', confounded, survived };
}

export function formatRun(result, arms) {
  const lines = [
    `[mutation-harness] ${result.verdict}: ${arms.length} arm(s), ` +
      `${arms.filter((a) => a.state === ARM_KILLED).length} killed, ` +
      `${result.survived.length} survived, ${result.confounded.length} confounded`,
  ];
  for (const arm of arms) {
    lines.push(`  ${arm.state.padEnd(10)} ${arm.label ?? ''} — ${arm.reason}`);
  }
  if (result.confounded.length > 0) {
    lines.push(
      '  A confounded arm is not a surviving arm. Nothing above is a finding until it is resolved.',
    );
  }
  return lines.join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd });
}

export function hashWorkingFile(filePath, cwd) {
  return git(['hash-object', filePath], cwd).trim();
}

export function porcelainStatus(cwd) {
  return git(['status', '--porcelain'], cwd);
}

/**
 * Windows cannot execFile a shim. npm/npx/yarn/pnpm are `.cmd` files and Node
 * refuses them outright with EINVAL (the CVE-2024-27980 mitigation), measured:
 *
 *   execFileSync('npx.cmd', ['vitest','--version'])                -> EINVAL
 *   execFileSync('npx.cmd', ['vitest','--version'], {shell:true})  -> works
 *
 * `shell: true` is not the fix. With an args array it emits DEP0190, because
 * Node concatenates the arguments into the command line without escaping them
 * -- the same hazard already recorded against this repository in #384. So the
 * command line is built here, explicitly, and the cases whose quoting cannot
 * be made safe are REFUSED rather than approximated.
 *
 * The refusal is the load-bearing part. cmd.exe expands `%VAR%` and `!VAR!`
 * even inside double quotes, so there is no quoting of those tokens that is
 * correct; a harness that guessed would run a command other than the one the
 * spec names, and then report mutation results from it.
 */
const CMD_SAFE_TOKEN = /^[A-Za-z0-9._:@=+\-/\\]+$/;

export function resolveCommand(command, platform = process.platform) {
  if (command.length === 0) {
    throw new Error('mutation-harness: testCommand is empty');
  }
  const [head, ...rest] = command;
  if (platform !== 'win32' || !/^(npm|npx|yarn|pnpm)$/.test(head)) {
    return { file: head, args: [...rest] };
  }
  const tokens = [`${head}.cmd`, ...rest];
  const unsafe = tokens.find((token) => !CMD_SAFE_TOKEN.test(token));
  if (unsafe !== undefined) {
    throw new Error(
      `mutation-harness: cannot launch "${head}" on Windows with the argument ${JSON.stringify(
        unsafe,
      )}. It is a .cmd shim, so it must go through cmd.exe, and cmd.exe expands % and ! even inside quotes. Name a real executable instead, for example ["node", "node_modules/vitest/vitest.mjs", "run", "..."].`,
    );
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', tokens.join(' ')],
  };
}

function runCommand(command, cwd, env) {
  const { file, args } = resolveCommand(command);
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (error) {
    // A non-zero exit is the expected outcome of a killed mutant, so the output
    // matters and the status does not. Reading the status here instead of the
    // summary is how a broken extractor hides.
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/**
 * A FIFTH CONTROL: THE MUTATION WINDOW IS NOT PRIVATE.
 *
 * The four controls above all police *this* process. None of them can see the
 * other direction: while an arm is applied, the mutation is in the real working
 * tree, so any *other* process running the suite compiles the mutant. It reads
 * a source file this harness is halfway through editing.
 *
 * That was measured, not supposed. Looping this file's own suite alongside a
 * harness run failed 2 of 4 concurrent runs, and the failures landed precisely
 * on the tests guarding the mutated lines -- the exact signature of a real
 * defect. The tree is clean again by the time anyone looks, so the failure is
 * unreproducible and reads as flake. One such observation cost a review round.
 *
 * The header of this file already commits to the principle: whatever the
 * protocol asks a human to remember is asserted here instead. So the mutation
 * window is published while it is open, and `tests/setup.ts` refuses to run
 * inside a window it does not own. A confounded neighbour now says so, loudly,
 * instead of inventing a defect in whatever test happened to guard the anchor.
 *
 * The harness's own child runs carry the token and are admitted; everyone
 * else's are stopped. The lock lives under `node_modules/.cache`, which is
 * already ignored, so it cannot disturb the restore comparison in
 * `classifyRestore` the way a tracked file would.
 */
function openMutationWindow({ filePath, label, cwd }) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lockPath = lockPathFor(cwd);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      token,
      pid: process.pid,
      file: filePath,
      label,
      openedAt: new Date().toISOString(),
    }),
  );
  return { token, lockPath };
}

function closeMutationWindow(lockPath) {
  rmSync(lockPath, { force: true });
}

/**
 * There are deliberately no signal handlers here.
 *
 * An earlier revision registered SIGINT/SIGTERM handlers that restored the file
 * before exiting, on the theory that `finally` does not run on a signal. That
 * was measured and it was worse than nothing: `runCommand` uses `execFileSync`,
 * which blocks the event loop for the entire child run, and Node dispatches
 * signals on the loop. So the handler could not fire during the window it
 * claimed to protect -- it ran only after the arm had already finished and the
 * `finally` had already restored. Worse, registering a listener suppresses
 * Node's default terminate action, so Ctrl-C during an arm no longer stopped
 * the harness at all: one probe measured a signal sitting queued for 34
 * seconds while the mutant stayed on disk. The handlers extended the window and
 * pushed the operator toward the hard kill that produces the debris state.
 *
 * The hard-kill case is covered where it can actually be observed instead: the
 * lock records which file was mutated, and `tests/mutationWindowGuard.ts`
 * refuses to run when that file is still modified and the holder is gone.
 */

export function runArm({
  filePath,
  original,
  pinnedHash,
  anchor,
  replacement,
  expectedAnchors,
  testCommand,
  label,
  cwd,
}) {
  const anchorsBefore = countOccurrences(original, anchor);
  // Read before the mutation is written, so the comparison isolates this arm
  // rather than indicting whatever the checkout was already carrying.
  const porcelainBefore = porcelainStatus(cwd);
  // Opened before the file is touched and closed after it is restored, so the
  // window covers every instant in which the tree holds the mutant.
  const { token, lockPath } = openMutationWindow({ filePath, label, cwd });
  let application;
  let summary = null;
  try {
    writeFileSync(filePath, original.split(anchor).join(replacement));

    const after = readFileSync(filePath, 'utf8');
    application = classifyApplication({
      anchorsBefore,
      replacementsAfter: countOccurrences(after, replacement),
      expectedAnchors,
    });

    if (application.applied) {
      summary = parseTestSummary(
        runCommand(testCommand, cwd, { [MUTATION_TOKEN_VARIABLE]: token }),
      );
    }
  } finally {
    // Restored unconditionally, including when the mutation never applied. A
    // restore that only runs on the success path is the skipped restore #371
    // measured.
    writeFileSync(filePath, original);
    closeMutationWindow(lockPath);
  }

  const restore = classifyRestore({
    pinnedHash,
    actualHash: hashWorkingFile(filePath, cwd),
    porcelainBefore,
    porcelainAfter: porcelainStatus(cwd),
  });

  return { label, ...classifyArm({ application, restore, summary }) };
}

/**
 * A fourth control: THE SUITE IS THE ONE NAMED.
 *
 * `spec.testCommand` is a free-form array, so it can carry several selectors.
 * #369 measured what vitest does with one that matches nothing:
 *
 *   vitest run <fabricated>          -> "No test files found"  exit 1
 *   vitest run <real> <fabricated>   -> "1 passed"             exit 0
 *
 * The second row is invisible to all three controls above it. The mutation
 * still lands, the extractor still reads a summary, the restore still verifies
 * -- and the arm reports SURVIVED for a mutation whose guarding test was never
 * run. That is a manufactured finding, and this header already says that
 * reporting a confounded arm as survived invents one.
 *
 * The check is delegated to scripts/vitest-strict.mjs rather than
 * reimplemented, for the reason that file gives: reproducing another tool's
 * filter grammar hard-codes a claim about it that goes stale toward a false
 * red (#146).
 */
const VITEST_LAUNCHER_SUFFIXES = new Set([
  '',
  '.mjs',
  '.cjs',
  '.js',
  '.cmd',
  '.bat',
  '.exe',
  '.ps1',
]);

/**
 * Is this token vitest itself, rather than a launcher or a selector?
 *
 * The suffix set is an allow-list on purpose. A selector named
 * `tests/vitest.test.ts` has the stem `vitest.test`, and even a bare
 * `vitest.test` would be refused by the suffix check -- the two ways of
 * getting this wrong both fail closed.
 */
export function isVitestToken(token) {
  const tail = String(token ?? '')
    .split(/[\\/]/)
    .pop();
  const dot = tail.lastIndexOf('.');
  const stem = dot > 0 ? tail.slice(0, dot) : tail;
  const suffix = dot > 0 ? tail.slice(dot).toLowerCase() : '';
  return stem === 'vitest' && VITEST_LAUNCHER_SUFFIXES.has(suffix);
}

/**
 * Split a launcher command into (launcher, vitest argv).
 *
 * Handing the whole command to selectorCandidates() is the mistake this
 * function exists to prevent. Measured, not assumed:
 *
 *   ["npx","vitest","run","tests/a.test.ts"]
 *     -> candidates ["npx", "vitest", "tests/a.test.ts"]
 *
 * `npx` and `vitest` are then checked as selectors, match nothing, and EVERY
 * CORRECT SPEC IS REFUSED. A false red inside the guard against a false green
 * is not a trade; it is the same defect wearing the other sign.
 *
 * Rather than parse launcher grammars -- npx, npm, yarn, pnpm, node, and
 * whatever arrives next -- find the token that IS vitest and take what follows
 * it. The first such token, not the last: a selector can only appear after the
 * binary, so searching forward keeps a selector that is somehow named `vitest`
 * inside the argv instead of cutting it off.
 *
 * When no such token exists -- `["npm","test","--","tests/a.test.ts"]` is the
 * measured case -- the boundary is genuinely unknown, and this returns null so
 * the caller can decline to check rather than guess at it.
 */
export function vitestArgvOf(command = []) {
  const tokens = [...command];
  const index = tokens.findIndex((token) => isVitestToken(token));
  if (index === -1) return { argv: null, index: -1 };
  return { argv: tokens.slice(index + 1), index };
}

/**
 * Decide whether a testCommand may be trusted to run the suite it names.
 *
 * Refusal is exit 2, never 1, for the reason at the foot of this file: an
 * inability to run the harness is not a surviving mutant.
 *
 * Two cases deliberately do NOT refuse:
 *
 *   - an unreadable boundary. Refusing here would punish a spec for a launcher
 *     form this function has not met, which is the false red above.
 *   - INCONCLUSIVE. `vitest list` failing is weaker evidence than the baseline
 *     arm, which runs the real command a moment later and already refuses when
 *     it cannot read a passing run.
 *
 * Both say so on stderr. An unchecked selector you have been TOLD about is a
 * different object from one you have not.
 */
export function selectorGate(
  command = [],
  { check = checkSelectors, format = formatRefusal } = {},
) {
  const { argv } = vitestArgvOf(command);

  if (argv === null) {
    return {
      refuse: false,
      message:
        '[mutation-harness] NOT CHECKED: no `vitest` token in testCommand, so ' +
        'the selectors could not be located.\n' +
        `  testCommand: ${command.join(' ')}\n` +
        '  A selector matching nothing would report a survivor for an arm that ' +
        'never ran.',
    };
  }

  const outcome = check(argv);

  if (outcome.verdict === UNMATCHED) {
    return {
      refuse: true,
      message: [
        '[mutation-harness] confounded: a selector in testCommand matched no test files.',
        '',
        format(outcome),
        '',
        '  Every arm would have been measured against a suite you did not name.',
      ].join('\n'),
    };
  }

  if (outcome.verdict === INCONCLUSIVE) {
    return {
      refuse: false,
      message:
        `[mutation-harness] NOT CHECKED: \`vitest list\` exited ${outcome.code} ` +
        `for ${outcome.selector}.\n` +
        '  Not refused here: the baseline arm runs the real command and is the ' +
        'better instrument for whether it can run at all.',
    };
  }

  return { refuse: false, message: null };
}

function main() {
  const [, , specPath] = process.argv;
  if (!specPath) {
    console.error(
      'usage: mutation-harness.mjs <spec.json>\n' +
        '  { "file": "scripts/x.mjs", "testCommand": ["npx","vitest","run","tests/x.test.ts"],\n' +
        '    "arms": [{ "label": "...", "anchor": "...", "replacement": "..." }] }',
    );
    process.exitCode = 2;
    return;
  }

  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  // Before any file is read or written: is the named suite the one that runs?
  const gate = selectorGate(spec.testCommand);
  if (gate.message) console.error(gate.message);
  if (gate.refuse) {
    process.exitCode = 2;
    return;
  }

  const filePath = spec.file;
  const original = readFileSync(filePath, 'utf8');
  const pinnedHash = hashWorkingFile(filePath);

  const baseline = classifyBaseline(
    parseTestSummary(runCommand(spec.testCommand)),
  );
  if (!baseline.usable) {
    console.error(`[mutation-harness] confounded: ${baseline.reason}`);
    process.exitCode = 2;
    return;
  }
  console.log(`[mutation-harness] ${baseline.reason}`);

  const arms = spec.arms.map((arm) =>
    runArm({
      filePath,
      original,
      pinnedHash,
      anchor: arm.anchor,
      replacement: arm.replacement,
      expectedAnchors: arm.expectedAnchors,
      testCommand: spec.testCommand,
      label: arm.label,
    }),
  );

  const result = evaluateRun(arms);
  const rendered = formatRun(result, arms);
  if (result.exitCode === 0) {
    console.log(rendered);
  } else {
    console.error(rendered);
  }
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // Exit 2, never 1: an inability to run the harness is not a surviving
    // mutant, and 1 is what a surviving mutant means.
    console.error(`Unable to run the mutation harness: ${error.message}`);
    process.exitCode = 2;
  }
}
