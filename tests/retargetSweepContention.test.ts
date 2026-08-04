// @vitest-environment node

/**
 * Issue #229 — the startup sweep must not abort startup when it cannot delete
 * another instance's leftovers.
 *
 * `RetargetArtifactService.initialize()` reaps directories belonging to *other*,
 * dead instances. On Windows a concurrent process holding a handle under one of
 * them makes `rm` throw `EPERM: rmdir`, and `force: true` suppresses only
 * `ENOENT`. That rejection propagated out of `initialize()`.
 *
 * The symptom is worth stating because it is the reason this is tested at the
 * mechanism: a whole test file failed in setup with every test inside it green.
 *
 *     Test Files  1 failed (1)  |  Tests  11 passed (11)  |  exit code 1
 *
 * ## Why this injects the failure instead of causing it
 *
 * Causing a real refusal was tried first and abandoned on measurement, not on
 * preference. Six mechanisms were probed on Windows and every one of them was
 * deleted without complaint:
 *
 *     open file 'r' / 'w' / held write stream / chmod 0o500 /
 *     nested dir with an open handle / open directory handle
 *
 * Node opens files with `FILE_SHARE_DELETE` and `rm` retries internally, so the
 * refusal only appears under genuine concurrent contention — the race this issue
 * measures at roughly 1 in 14, load-dependent. A test built on it would be a
 * flaky test for a flake.
 *
 * `rm` is therefore replaced with a delegating stub that refuses exactly one
 * path and performs the real deletion for every other. The rest of the module's
 * filesystem access is untouched, and the error raised carries a real `EPERM`
 * code and `rmdir` syscall.
 *
 * ## Why re-running the suite is not evidence here
 *
 * Seven consecutive clean suites were recorded on this issue *while it was
 * unfixed*. A green run is consistent with the defect being present, so "it
 * stopped flaking" cannot be the acceptance signal. Only a deterministic
 * exercise of the failure path can be.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { blocked } = vi.hoisted(() => ({
  blocked: { path: null as string | null, calls: [] as string[] },
}));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  return {
    ...actual,
    default: actual,
    rm: async (
      target: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      const asString = String(target);
      blocked.calls.push(asString);
      if (blocked.path !== null && asString === blocked.path) {
        const error: NodeJS.ErrnoException = Object.assign(
          new Error(`EPERM: operation not permitted, rmdir '${asString}'`),
          { errno: -4048, code: 'EPERM', syscall: 'rmdir', path: asString },
        );
        throw error;
      }
      return actual.rm(target, options);
    },
  };
});

const { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } =
  await import('node:fs/promises');
const { RetargetArtifactService } =
  await import('../src/main/retargetArtifacts.js');

const OWNER_MARKER = '.printfarmer-retarget-owner.json';
const temporaryDirectories: string[] = [];

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

/**
 * A directory the sweep should consider collectable: a well-formed owner marker
 * naming a pid that is not running.
 */
async function addStaleInstance(parent: string): Promise<string> {
  const staleId = randomUUID();
  const stale = path.join(parent, staleId);
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, 'artifact.3mf'), 'stale');
  await writeFile(
    path.join(stale, OWNER_MARKER),
    JSON.stringify({ schemaVersion: 1, instanceId: staleId, pid: 2147483647 }),
  );
  return stale;
}

async function staleInstance(): Promise<{ root: string; stale: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u1-sweep-'));
  temporaryDirectories.push(root);
  const stale = await addStaleInstance(
    path.join(root, 'PrintFarmer', 'retarget'),
  );
  return { root, stale };
}

/**
 * Whether `target` still exists.
 *
 * Deliberately a boolean rather than `expect(access(...)).rejects` — vitest
 * drops the custom message on `expect(promise, message).resolves`, so a
 * failure there reports only "promise rejected ... instead of resolving" and
 * never names what was expected to survive or be collected.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Instance directories under `root` whose marker names this process. */ async function ownedByThisProcess(
  root: string,
): Promise<string[]> {
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

beforeEach(() => {
  blocked.path = null;
  blocked.calls = [];
});

afterEach(async () => {
  // `blocked.path` is cleared first, so the mocked `rm` delegates to the real
  // one for every path here.
  blocked.path = null;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('startup sweep under deletion refusal (issue #229)', () => {
  it('collects a stale instance root when the delete succeeds', async () => {
    // The control for the test below. "The directory survived" passes both when
    // removal was refused *and* when the sweep never targeted the directory --
    // a marker that fails validation, a live pid, a name that fails the uuid
    // pattern. This proves the fixture is genuinely collectable, so a survivor
    // in the next test is a refusal rather than a skip.
    const { root, stale } = await staleInstance();

    await serviceFor(root).initialize();

    await expect(
      exists(stale),
      'the fixture was never collectable, so the refusal test proves nothing',
    ).resolves.toBe(false);
  });

  it('starts up when a stale root cannot be deleted', async () => {
    const { root, stale } = await staleInstance();
    blocked.path = stale;

    // The claim: initialize() resolves rather than propagating EPERM.
    await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

    // Control: the refusal was actually exercised. Without this the test passes
    // if the sweep never reached `rm` at all.
    expect(
      blocked.calls,
      'rm was never called on the stale root, so no refusal was triggered',
    ).toContain(stale);
    expect(
      await exists(stale),
      'the stale root was deleted despite the injected refusal',
    ).toBe(true);

    // Control: initialize() finished its real work rather than merely not
    // throwing. A catch placed around too much of the method would swallow the
    // failure and skip registration, passing every assertion above.
    expect(
      await ownedByThisProcess(root),
      'initialize() tolerated the failed sweep but never registered this instance',
    ).toHaveLength(1);
  });

  it('collects the other stale roots when one of them refuses', async () => {
    // A refusal must not abort the loop and strand the remaining directories.
    //
    // The blocked directory must be the one the sweep reaches FIRST, and that
    // is not a detail. Both names are random uuids, so with an arbitrary choice
    // the sweep visits the survivor before the refusal about half the time --
    // and in those runs a loop that aborts on the first error still satisfies
    // every assertion below. This test was written that way and a mutant that
    // wrapped the whole loop in a single catch survived it. `readdir` order is
    // therefore read from the filesystem and the first entry is the one
    // blocked, so the remaining directory is always reached only if the sweep
    // continued past the refusal.
    const { root } = await staleInstance();
    const parent = path.join(root, 'PrintFarmer', 'retarget');
    await addStaleInstance(parent);

    const order = (await readdir(parent)).map((name) =>
      path.join(parent, name),
    );
    const [first, rest] = order;
    if (first === undefined || rest === undefined) {
      throw new Error(
        `the fixture did not produce two stale roots, so nothing tests loop continuation: ${JSON.stringify(order)}`,
      );
    }
    blocked.path = first;

    await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

    expect(
      await exists(first),
      'the blocked root was deleted, so the refusal was not exercised',
    ).toBe(true);
    expect(
      await exists(rest),
      'a refusal on the first stale root stopped the sweep collecting the rest',
    ).toBe(false);
  });
});
