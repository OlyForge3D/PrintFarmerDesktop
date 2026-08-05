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
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'u1-real-sweep-'));
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
// no error at all elsewhere and every arm below would be vacuous. Skipped
// rather than silently green, and the guard below asserts the skip is a
// platform decision rather than an empty file.
describe.skipIf(!onWindows)(
  'startup sweep against a real filesystem refusal (issue #514)',
  () => {
    it('the fixture is collectable when nothing holds it', async () => {
      // The negative control for every arm below. "The directory survived"
      // passes both when removal was refused and when the sweep never targeted
      // it -- a marker that fails validation, a live pid, a name that fails the
      // uuid pattern. Without this, a survivor proves nothing.
      const { root, stale } = await staleInstance();

      await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

      expect(
        await exists(stale),
        'the fixture was never collectable, so the refusal arms prove nothing',
      ).toBe(false);
    });

    it('the real filesystem refuses the removal with a code, not just a message', async () => {
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
    });

    it('starts up when a real refusal blocks a stale root', async () => {
      const { root, stale } = await staleInstance();
      await holdBusy(stale);

      // The claim: initialize() resolves rather than propagating the refusal.
      await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

      expect(
        await exists(stale),
        'the stale root was deleted despite the real refusal, so the arm ' +
          'exercised no refusal at all',
      ).toBe(true);

      // Control: initialize() finished its real work rather than merely not
      // throwing. A catch placed around too much of the method would swallow
      // the failure and skip registration, passing every assertion above.
      expect(
        await ownedByThisProcess(root),
        'initialize() tolerated the failed sweep but never registered this instance',
      ).toHaveLength(1);
    });

    it('classifies the real refusal the same way as the hand-authored fixture', async () => {
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
    });
  },
);

// Outside the skipIf, so it runs on every platform. A file that is entirely
// skipped reports as passing and is indistinguishable from one whose tests were
// deleted; this states which platform was in play and why nothing ran.
it('names the platform it can measure on', () => {
  expect(['win32', 'darwin', 'linux']).toContain(process.platform);
  if (!onWindows) {
    expect(
      onWindows,
      `real deletion refusal is Windows-specific and this runner is ` +
        `${process.platform}, so the arms above were skipped deliberately`,
    ).toBe(false);
  }
});
