// @vitest-environment node

/**
 * Issue #514 — the startup sweep's failure classifier, measured against an
 * error the filesystem actually raised rather than one a test author wrote.
 *
 * `tests/retargetSweepContention.test.ts` pins both sides of
 * `isBrokenTempRootError` — `EBUSY`/`ENOTEMPTY` tolerated, `EIO`/`ENOSPC`/
 * `EROFS` fatal — by replacing `rm` with a stub that throws a constructed
 * error. That is the right way to get determinism, and this file does not
 * replace it. What it cannot do is say whether the codes it enumerates are the
 * codes Windows emits: the fixture and the assertion are drawn from the same
 * belief, so they agree with each other whatever the operating system does.
 *
 * This file supplies the one thing that comparison needs: a real error.
 *
 * ## Why this is a separate file
 *
 * Not organisational. `retargetSweepContention.test.ts` calls
 * `vi.mock('node:fs/promises')` at module scope, which replaces `rm` for
 * everything in that module graph. A real-filesystem arm placed there would be
 * served by the stub and would measure the stub.
 *
 * ## The mechanism, and why the neighbouring file says there isn't one
 *
 * That file records six probed mechanisms, all of which were deleted without
 * complaint:
 *
 *     open file 'r' / 'w' / held write stream / chmod 0o500 /
 *     nested dir with an open handle / open directory handle
 *
 * Every one of those is reproduced here as a finding, not a doubt: Node opens
 * files with `FILE_SHARE_DELETE`, so a held handle does not block removal. The
 * conclusion drawn there — that a real refusal appears only under a race, and
 * a test built on it would be "a flaky test for a flake" — is true of those six
 * and does not generalise. A seventh mechanism is deterministic:
 *
 *     a live process whose current working directory is inside the target
 *
 * Windows refuses to remove a directory that is some process's cwd, and it
 * refuses every time rather than racily. Measured before this file was written,
 * 20 trials, with the identical fixture and no child process as the control:
 *
 *     CONTROL (no child)  0 of 20 failed
 *     SUBJECT (child cwd) 20 of 20 failed, EBUSY/rmdir every time
 *
 * The control is what makes that a measurement: the same directory, built the
 * same way, is removable when nothing holds it.
 *
 * ## What this file is for
 *
 * It is a calibration test, and it is worth being plain that it does not catch
 * a product mutation the neighbouring file misses — that suite is thorough, and
 * anything that moves `EBUSY` between the tolerated and fatal sets turns both
 * files red. What it catches is the case that suite cannot see: the day the
 * error Windows raises here stops being a member of the set that suite
 * enumerates. Then this file goes red and that one stays green, because that
 * one is asking whether the classifier handles the codes its author listed, and
 * this one is asking whether those are the codes.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  RetargetArtifactService,
  isBrokenTempRootError,
} from '../src/main/retargetArtifacts.js';

const OWNER_MARKER = '.printfarmer-retarget-owner.json';

/**
 * The string `tests/retargetProfileFailureClassification.test.ts` builds its
 * rejected `retargetReady` from. Reproduced verbatim, not imported, because the
 * comparison in this file is against the value as that file writes it: an
 * import would silently follow a change there and stop being the fixture whose
 * realism is in question.
 */
const AUTHORED_INIT_FAILURE = 'EPERM: operation not permitted, rmdir';

const onWindows = process.platform === 'win32';

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

const ARM_CONTROL = 'the fixture is collectable when nothing holds it';
const ARM_CODE =
  'the real filesystem refuses the removal with a code, not just a message';
const ARM_STARTUP = 'starts up when a real refusal blocks a stale root';
const ARM_CLASSIFY =
  'classifies the real refusal the same way as the hand-authored fixture';

/**
 * The arms whose absence this file must not report as a pass.
 *
 * Written out rather than derived from the `it` calls, so that skipping an arm
 * leaves its name here and turns the file red. The independence is real but
 * bounded, and the bound is worth stating because a reviewer of PR #518
 * measured it: deleting an arm *together with* its constant and this entry
 * still passes. No guard that lives inside a file can survive an edit to that
 * file. What this defends against is an arm that stops running -- skipped,
 * filtered, platform-gated, bailed out of -- which is the failure mode that
 * reports green. Deletion needs a policy test that reads the test directory
 * from outside, which is deliberately not in this PR.
 */
const REQUIRED_ON_WINDOWS = [
  ARM_CONTROL,
  ARM_CODE,
  ARM_STARTUP,
  ARM_CLASSIFY,
] as const;

/**
 * What each arm must have observed. Held here rather than only inside the arms
 * so the guard below can re-assert it, which is what stops a gutted arm from
 * reporting a pass.
 */
const EXPECTED_EVIDENCE: Record<string, Record<string, unknown>> = {
  [ARM_CONTROL]: { survivedUnheld: false },
  [ARM_CODE]: { hasCode: true, code: 'EBUSY', syscall: 'rmdir' },
  [ARM_STARTUP]: { survivedRefusal: true, ownedCount: 1 },
  [ARM_CLASSIFY]: {
    realIsFatal: false,
    authoredIsFatal: false,
    authoredHasCode: false,
    realHasCode: true,
  },
};

/**
 * Whether the current run's filter selected `arm`.
 *
 * A reviewer of PR #518 measured why any of this exists: `vitest -t <name>` on
 * a clean Windows tree failed, because the completeness check below cannot tell
 * a deliberately narrowed run from a neutered file. A guard that reddens a
 * correct tree is a false-red generator, and this repository has already had
 * one of those redden a correct change.
 *
 * `process.argv` is not the signal -- measured, not assumed: inside a vitest
 * worker it is `[node, tinypool/dist/entry/process.js]` and carries no CLI
 * flags at all. The run configuration is reachable only through
 * `globalThis.__vitest_worker__`, which is internal API. The fallback is
 * deliberate: if that global is ever missing, no filter is reported, every arm
 * is required, and the completeness check runs. An upstream change then
 * produces a loud false red rather than a silent exemption, and silence is the
 * failure this whole file exists to prevent.
 *
 * Two earlier versions of this asked the wrong question, and the second one was
 * defeated by two independent round-5 reviewers within minutes of each other,
 * which is the useful part of the history:
 *
 *   1. "Was the run narrowed at all?" exempted the whole check whenever a
 *      pattern was present, so a pattern committed to `vitest.config.ts`
 *      disabled it permanently and silently.
 *   2. "Did the narrowing come from the committed config?" answered that by
 *      substring-searching the config's SOURCE TEXT for `testNamePattern`. Two
 *      reviewers defeated it identically with a computed key
 *      (`['testName' + 'Pattern']`), and a third showed the same instrument
 *      produced a FALSE RED when the word appeared only in a comment. Matching
 *      source text is not reading configuration: it is defeated by any spelling
 *      the author did not anticipate and fooled by any mention that is not code.
 *
 * So this asks the question that has an answer: does the filter this run is
 * ACTUALLY using select this arm? Where the filter came from stops mattering,
 * which is what makes the origin-based bypasses meaningless. An arm the filter
 * excludes is legitimately absent. An arm the filter selects must have run, no
 * matter how the filter was spelled or where it was declared.
 */
const DESCRIBE_TITLE =
  'startup sweep against a real filesystem refusal (issue #514)';

function runFilter(): RegExp | undefined {
  const worker = (globalThis as Record<string, unknown>).__vitest_worker__ as
    { config?: { testNamePattern?: unknown } } | undefined;
  const pattern = worker?.config?.testNamePattern;
  if (pattern instanceof RegExp) {
    // A `g` flag would make `test()` stateful across arms, so the last arm
    // checked could be reported absent purely because of where `lastIndex`
    // happened to land.
    return new RegExp(pattern.source, pattern.flags.replace(/g/g, ''));
  }
  if (typeof pattern === 'string' && pattern.length > 0) {
    return new RegExp(pattern);
  }
  return undefined;
}

function armWasSelected(arm: string, filter: RegExp | undefined): boolean {
  if (filter === undefined) return true;
  // Vitest matches the full name including enclosing describes. Both forms are
  // tried rather than assuming the separator, so a change to how vitest joins
  // them widens the required set rather than silently exempting an arm.
  return (
    filter.test(arm) ||
    filter.test(`${DESCRIBE_TITLE} > ${arm}`) ||
    filter.test(`${DESCRIBE_TITLE} ${arm}`)
  );
}

/**
 * What each arm observed, recorded as its last statement and re-asserted below.
 *
 * A bare "this arm ran" marker was the first version, and two reviewers killed
 * it with the same mutation: delete an arm's assertions, keep its marker, and
 * the file still passed. Execution is not measurement. Recording the observed
 * values instead means a gutted arm registers evidence that the `afterAll`
 * then rejects, so the cheapest way to make this file lie is no longer to
 * delete an `expect` -- it is to write a false value into the record, which is
 * a deliberate act that reads as one in a diff. The protection extends exactly
 * as far as the recorded keys: see the note above the `afterAll`.
 */
const observations = new Map<string, Record<string, unknown>>();

function record(arm: string, evidence: Record<string, unknown>): void {
  observations.set(arm, evidence);
}

function serviceFor(tempPath: string) {
  return new RetargetArtifactService({
    sidecar: {
      retargetPreflight: vi.fn(),
      retargetBuild: vi.fn(),
      loadRetargetScene: vi.fn(),
      scanRoot: vi.fn(),
    } as never,
    profiles: {
      getPrivateReference: () => ({
        kind: 'bundled' as const,
        targetProfileId: 'p',
      }),
      getFingerprint: () => 'e'.repeat(64),
    },
    dialogs: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    tempPath,
  });
}

/** A directory the sweep should consider collectable: well-formed marker, dead pid. */
async function staleInstance(): Promise<{ root: string; stale: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), TEMP_ROOT_PREFIX));
  temporaryDirectories.push(root);
  const parent = path.join(root, 'PrintFarmer', 'retarget');
  const staleId = randomUUID();
  const stale = path.join(parent, staleId);
  await mkdir(path.join(stale, 'inner'), { recursive: true });
  await writeFile(path.join(stale, 'inner', 'artifact.3mf'), 'stale');
  await writeFile(
    path.join(stale, OWNER_MARKER),
    JSON.stringify({ schemaVersion: 1, instanceId: staleId, pid: 2147483647 }),
  );
  return { root, stale };
}

/**
 * Hold `directory` busy by parking a live process's cwd inside it.
 *
 * Resolves only once the child has reported that it is running, rather than
 * after a sleep. A timer would make the contention probabilistic again, which
 * is the property this mechanism was chosen for.
 */
async function holdBusy(directory: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready");setTimeout(() => {}, 120_000);'],
    { cwd: path.join(directory, 'inner'), stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () =>
      reject(new Error('the holding process exited before it took its cwd')),
    );
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

/** Instance directories under `root` whose marker names this process. */
async function ownedByThisProcess(root: string): Promise<string[]> {
  const parent = path.join(root, 'PrintFarmer', 'retarget');
  const owned: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const marker = JSON.parse(
        await readFile(path.join(parent, entry.name, OWNER_MARKER), 'utf8'),
      ) as { pid: number };
      if (marker.pid === process.pid) owned.push(entry.name);
    } catch {
      // Not an instance directory owned by this process.
    }
  }
  return owned;
}

/** The error the real filesystem raises for the removal the sweep performs. */
async function realRemovalError(
  directory: string,
): Promise<NodeJS.ErrnoException> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 0 });
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error(
    `removing ${directory} succeeded, so no real error was produced and ` +
      'every assertion drawn from one would be vacuous',
  );
}

const TEMP_ROOT_PREFIX = 'u1-real-sweep-';

// A round-4 reviewer noted that a run killed mid-arm leaves its temp root
// behind, because cleanup lives in `afterEach` and nothing in this file runs
// after a SIGKILL. A `beforeAll` sweep of `os.tmpdir()` by prefix and age was
// tried and is deliberately NOT here: a round-5 reviewer measured it deleting
// the signed artifact of a still-BUSY root and then hanging for 10 seconds
// inside a required Desktop context. `os.tmpdir()` is shared between concurrent
// CI jobs, worktrees and other agents, so a sweep keyed on a name prefix cannot
// tell another run's live directory from an abandoned one -- and a hook that
// can stall a required context is a far worse defect than the leak it closes,
// being exactly the deadlock shape this repository already carries a scar from
// (issue #122). The leak is bounded, confined to the OS temp directory, and
// collected by the platform. Not every hole is worth the plug.

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  // Windows releases the directory asynchronously after the holder exits, so
  // cleanup retries rather than asserting the handle is already gone.
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20 }).catch(
          () => undefined,
        ),
      ),
  );
});

// The contention behaviour under test is Windows-specific: POSIX permits
// removing a directory that is a live process's cwd, so the mechanism produces
// no error at all elsewhere and every arm below would be vacuous. The `afterAll`
// at the foot of this file is what makes the skip safe: on Windows it fails
// unless every arm ran to completion, and elsewhere it fails if any of them ran.
describe.skipIf(!onWindows)(
  'startup sweep against a real filesystem refusal (issue #514)',
  () => {
    it(ARM_CONTROL, async () => {
      // The negative control for every arm below. "The directory survived"
      // passes both when removal was refused and when the sweep never targeted
      // it -- a marker that fails validation, a live pid, a name that fails the
      // uuid pattern. Without this, a survivor proves nothing.
      const { root, stale } = await staleInstance();

      await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

      const survivedUnheld = await exists(stale);
      expect(
        survivedUnheld,
        'the fixture was never collectable, so the refusal arms prove nothing',
      ).toBe(false);

      record(ARM_CONTROL, { survivedUnheld });
    });

    it(ARM_CODE, async () => {
      const { stale } = await staleInstance();
      await holdBusy(stale);

      const error = await realRemovalError(stale);

      // Asserted on `code`, never on the message text: the message is a
      // human-readable string that carries no contract, and matching it is how
      // a classifier ends up keying on prose.
      expect(
        'code' in error,
        'the real error carries no code property, so a classifier keying on ' +
          'code would read undefined and tolerate everything',
      ).toBe(true);
      expect(error.code).toBe('EBUSY');
      expect(error.syscall).toBe('rmdir');

      record(ARM_CODE, {
        hasCode: 'code' in error,
        code: error.code,
        syscall: error.syscall,
      });
    });

    it(ARM_STARTUP, async () => {
      const { root, stale } = await staleInstance();
      await holdBusy(stale);

      // The claim: initialize() resolves rather than propagating the refusal.
      await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

      const survivedRefusal = await exists(stale);
      expect(
        survivedRefusal,
        'the stale root was deleted despite the real refusal, so the arm ' +
          'exercised no refusal at all',
      ).toBe(true);

      // Control: initialize() finished its real work rather than merely not
      // throwing. A catch placed around too much of the method would swallow
      // the failure and skip registration, passing every assertion above.
      const owned = await ownedByThisProcess(root);
      expect(
        owned,
        'initialize() tolerated the failed sweep but never registered this instance',
      ).toHaveLength(1);

      record(ARM_STARTUP, { survivedRefusal, ownedCount: owned.length });
    });

    it(ARM_CLASSIFY, async () => {
      const { stale } = await staleInstance();
      await holdBusy(stale);

      const real = await realRemovalError(stale);
      const authored = new Error(AUTHORED_INIT_FAILURE);

      // #514 asks whether the authored string and reality lead to the same
      // decision. They do: both are tolerated.
      expect(isBrokenTempRootError(real)).toBe(false);
      expect(isBrokenTempRootError(authored)).toBe(isBrokenTempRootError(real));

      // They agree for different reasons, and the difference is worth pinning
      // rather than leaving as a comment. The real error is tolerated because
      // its code is outside the fatal set. The authored one is tolerated
      // because it has no code at all -- `new Error('EPERM: ...')` puts the
      // code in the message and nowhere else, so it would be tolerated by a
      // classifier that had stopped reading codes entirely. Any change that
      // starts keying on the presence of a code turns this red, which is the
      // moment someone needs to look at the authored fixture.
      expect(
        'code' in authored,
        'the authored fixture has gained a code, so this asymmetry is gone ' +
          'and this assertion should be deleted along with the caveat above',
      ).toBe(false);
      expect('code' in real).toBe(true);

      record(ARM_CLASSIFY, {
        realIsFatal: isBrokenTempRootError(real),
        authoredIsFatal: isBrokenTempRootError(authored),
        authoredHasCode: 'code' in authored,
        realHasCode: 'code' in real,
      });
    });
  },
);

// A wholly skipped file reports as passing, and so does one whose arms were
// gutted. Two rounds of review shaped this guard, and both rounds are recorded
// here because the reasoning is the useful part:
//
//   Round 1 -- the guard asserted `onWindows === false` on non-Windows, which
//   is reflexive and cannot fail for any input, and never checked that the
//   Windows arms ran. Hard-skipping them still reported green.
//
//   Round 2 -- the replacement recorded "this arm ran" and checked attendance.
//   Two reviewers killed that with the same mutation: delete an arm's
//   assertions, keep its marker, still green. Execution is not measurement.
//
// So the arms now record what they OBSERVED, and this re-asserts those
// observations. Gutting an arm's `expect`s over a value it records no longer
// helps: the arm records the real value and this rejects it. A round-4 reviewer
// deleted ARM_CONTROL's only `expect` and saw the file still pass, which is
// worth being exact about -- that mutation is equivalent, because it was run
// against a CORRECT tree, where passing is the right answer. Deleting the same
// `expect` AND breaking the product was measured too, and this caught it:
// `expected { survivedUnheld: true } to strictly equal { survivedUnheld: false }`,
// exit 1. The claim is therefore about values that reach a `record(...)` call.
// An assertion over something no arm records is protected by nothing but
// itself, which is why the evidence maps mirror the arms rather than sampling
// them. The cheapest way to make this file lie is to write a false literal into
// a `record(...)` call, which is a deliberate act and reads as one in a diff.
//
// Three limits, stated rather than implied, all measured by reviewers or by
// the experiments above rather than guessed:
//   - Deleting an arm together with its constant and its `REQUIRED_ON_WINDOWS`
//     entry passes, as does deleting this `afterAll` or editing the filter it
//     consults. No guard inside a file survives an edit to that file.
//   - Nothing inside a file can notice that the file was deleted.
//   - If NO test in this file runs, this hook does not run either, so nothing
//     is checked. Measured: skipping an arm and then narrowing to only that arm
//     (`-t 'starts up when a real refusal'`) reports `1 skipped | 5 skipped`,
//     tests 0ms, exit 0. That is inherent -- an in-file hook cannot fire in a
//     run that executes none of the file's tests -- and it is visible, because
//     a run that measured nothing says so in its counts. CI narrows nothing, so
//     every arm is required there.
// The first two need a policy test that reads the test directory from outside.
// That is deliberately not in this PR.
//
// This runs after every test in the file regardless of declaration order, and
// checks both platform directions.
afterAll(() => {
  const ran = [...observations.keys()].sort();

  // Deliberately NOT `onWindows`. A round-3 reviewer defeated the previous
  // version with a single token: flipping `onWindows` at its definition
  // (`===` to `!==`) skipped every arm AND flipped this guard to the branch
  // that expects nothing, so a Windows runner reported `1 passed | 4 skipped`
  // and exit 0. A guard that reads the same flag it is auditing is checking
  // the flag's self-consistency, not the platform. This re-derives from
  // `process.platform`, which is what the skip is ultimately claiming about.
  const runnerIsWindows = process.platform === 'win32';

  if (!runnerIsWindows) {
    // POSIX permits removing a directory that is a live process's cwd, so an
    // arm that runs here is measuring nothing and would pass by producing no
    // error at all.
    if (ran.length > 0) {
      throw new Error(
        `the real-refusal arms ran on ${process.platform}, where the mechanism ` +
          `produces no error, so their assertions are vacuous: ${ran.join(' | ')}`,
      );
    }
    return;
  }

  // An arm may be absent only if the filter this run is ACTUALLY using excludes
  // it. Asking that, rather than "was the run narrowed", is what makes it
  // irrelevant where the filter was declared or how it was spelled -- the two
  // bypasses round 5 found both attacked the origin question, which no longer
  // gets asked.
  const filter = runFilter();
  const missing = REQUIRED_ON_WINDOWS.filter(
    (name) => !observations.has(name) && armWasSelected(name, filter),
  );
  if (missing.length > 0) {
    throw new Error(
      `this runner is win32, where the real-refusal arms are the only reason ` +
        `this file exists, but ${missing.length} of ` +
        `${REQUIRED_ON_WINDOWS.length} recorded no observation: ` +
        `${missing.join(' | ')}. Skipping an arm reports as a pass, so this ` +
        `file fails rather than claiming a measurement it never made. If an ` +
        `arm above failed, that failure is the cause and this is its ` +
        `consequence -- read that one first.`,
    );
  }

  // Attendance is not measurement, so the observations are re-asserted here.
  // These duplicate the arms' own assertions deliberately: the duplication is
  // what makes deleting an arm's assertions insufficient to silence the file.
  // Only arms that ran are checked, so a narrowed run still verifies whatever
  // it did execute rather than being exempted wholesale.
  for (const arm of REQUIRED_ON_WINDOWS) {
    const evidence = observations.get(arm);
    if (evidence === undefined) continue;
    expect(evidence, `evidence recorded by the arm: ${arm}`).toStrictEqual(
      EXPECTED_EVIDENCE[arm],
    );
  }
});

it('runs on a platform whose real-refusal behaviour this file has decided', () => {
  // Not a restatement of `onWindows`. A runner this file has never been
  // reasoned about lands here and forces the decision to be made explicitly,
  // instead of being absorbed by `!onWindows` and skipped in silence.
  expect(['win32', 'darwin', 'linux']).toContain(process.platform);
});
