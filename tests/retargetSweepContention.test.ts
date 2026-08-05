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
  blocked: {
    path: null as string | null,
    code: 'EPERM',
    calls: [] as string[],
  },
}));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  const { getSystemErrorMap } =
    await vi.importActual<typeof import('node:util')>('node:util');

  // `errno` is read from the running platform rather than written as a literal.
  // A real `NodeJS.ErrnoException` always carries one, and the value is
  // platform-specific: EPERM is -4048 under libuv on Windows and 1 on macOS, so
  // a hardcoded number is wrong on one of the two runners this suite executes
  // on. Nothing in production reads `errno` today; the point is that a future
  // classifier which does must not read `undefined` here, because that lies in
  // the permissive direction.
  const errnoByCode = new Map<string, number>();
  for (const [errno, [code]] of getSystemErrorMap()) {
    errnoByCode.set(code, errno);
  }

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
        const errno = errnoByCode.get(blocked.code);
        if (errno === undefined) {
          // Refuse to inject an error this platform never raises, rather than
          // quietly omitting the field and restoring the gap above.
          throw new Error(
            `no platform errno for injected code '${blocked.code}', so the ` +
              'injected error would not resemble one Node raises',
          );
        }
        const error: NodeJS.ErrnoException = Object.assign(
          new Error(`${blocked.code}: injected failure, rmdir '${asString}'`),
          { errno, code: blocked.code, syscall: 'rmdir', path: asString },
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
  blocked.code = 'EPERM';
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

  it.each(['EBUSY', 'ENOTEMPTY'])(
    'also tolerates the pending-handle error %s',
    async (code) => {
      const { root, stale } = await staleInstance();
      blocked.path = stale;
      blocked.code = code;

      await expect(serviceFor(root).initialize()).resolves.toBeUndefined();

      expect(blocked.calls).toContain(stale);
      await expect(exists(stale)).resolves.toBe(true);

      // The same control the EPERM case above carries. Without it these two
      // assert only that initialize() did not throw and the directory survived,
      // and both are equally true of a service that quietly did no work at all
      // -- a catch around the whole method skips `mkdir` and the owner-marker
      // write and still satisfies everything above. Today that mutant is caught
      // on the shared path by the EPERM case; that is a property of a
      // neighbouring test, not of these, and it leaves the moment the EPERM
      // case is narrowed.
      expect(
        await ownedByThisProcess(root),
        'initialize() tolerated the failed sweep but never registered this instance',
      ).toHaveLength(1);
    },
  );

  it('propagates a sweep error outside the pending-handle family', async () => {
    const { root, stale } = await staleInstance();
    blocked.path = stale;
    blocked.code = 'EIO';

    await expect(serviceFor(root).initialize()).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(blocked.calls).toContain(stale);
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

  it('collects on a later sweep what a refusal left behind', async () => {
    // Issue #454. The `catch` above leaves the directory "for a later sweep, by
    // this process or another one", and that promise is load-bearing outside
    // this file: `e2e/retarget.spec.ts` relaunches the packaged app and asserts
    // the closed instance's roots are gone. Every test above stops at "the
    // refusal was tolerated and the directory survived" -- none of them
    // exercises the later sweep, so the sentence the E2E depends on was
    // unproven.
    //
    // Stated as the property rather than the mechanism: a refusal must defer a
    // collection, not cancel it.
    const { root, stale } = await staleInstance();
    blocked.path = stale;

    await serviceFor(root).initialize();

    // Control, and the reason this test is not trivial. Without it the whole
    // test passes when the FIRST sweep already deleted the directory, which
    // proves nothing about a later one -- the assertion after the second sweep
    // would be reading the first sweep's success.
    expect(
      blocked.calls,
      'rm was never called on the stale root, so the first sweep never refused',
    ).toContain(stale);
    expect(
      await exists(stale),
      'the first sweep deleted the stale root, so there is nothing left for a later sweep to collect and this test proves nothing',
    ).toBe(true);

    // The contention is gone, as it is once the other process releases its
    // handles. A second startup is a second sweep.
    blocked.path = null;
    const callsBeforeLaterSweep = blocked.calls.length;

    await serviceFor(root).initialize();

    expect(
      blocked.calls
        .slice(callsBeforeLaterSweep)
        .some(
          (call) => call === stale || call.startsWith(`${stale}${path.sep}`),
        ),
      'the later sweep never attempted a deletion anywhere under the deferred root, so it was dropped from consideration rather than retried',
    ).toBe(true);
    expect(
      await exists(stale),
      'the root a refusal deferred was never collected by a later sweep, so the deferral is permanent and e2e/retarget.spec.ts asserts a property the module does not deliver',
    ).toBe(false);
  });
});

describe("disposing this process's instance root", () => {
  /**
   * The instance directory this service registered for itself.
   *
   * Throws rather than returning undefined: every assertion below is about what
   * happens when removing *this* root is refused, so a fixture that never
   * produced one must fail loudly instead of leaving `blocked.path` null, which
   * would disarm the injection and pass.
   */
  async function ownRootOf(
    root: string,
    subject: { initialize: () => Promise<void> },
  ): Promise<string> {
    await subject.initialize();
    const [ownInstance] = await ownedByThisProcess(root);
    if (ownInstance === undefined) {
      throw new Error('the service did not create its own instance root');
    }
    return path.join(root, 'PrintFarmer', 'retarget', ownInstance);
  }

  it('propagates a pending-handle error for its own directory', async () => {
    const { root } = await staleInstance();
    const subject = serviceFor(root);
    const ownRoot = await ownRootOf(root, subject);
    blocked.path = ownRoot;

    await expect(subject.disposeAll()).rejects.toMatchObject({ code: 'EPERM' });
    expect(blocked.calls).toContain(ownRoot);
  });

  it('propagates a non-pending-handle error for its own directory', async () => {
    // The counterpart to `propagates a sweep error outside the pending-handle
    // family`, which covers the sweep only. The asymmetry ran the wrong way:
    // the sweep operates on *another* process's directory, where giving up
    // costs a later sweep, while disposeAll() operates on this process's own
    // root, where giving up strands it on disk with no signal anywhere.
    //
    // Without this, disposeAll() could swallow every error outside the
    // pending-handle family -- keeping the tested case green -- and all 107
    // test files still passed (issue #442).
    const { root } = await staleInstance();
    const subject = serviceFor(root);
    const ownRoot = await ownRootOf(root, subject);
    blocked.path = ownRoot;
    blocked.code = 'EIO';

    // `errno` and `syscall` are asserted, not merely written into the fixture.
    // A field that is never the reason an assertion passes is documentation
    // that reads as coverage (#448), which is how the missing `errno` survived
    // in the first place.
    const rejection: unknown = await subject.disposeAll().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(
      rejection,
      'disposeAll() resolved instead of propagating the injected EIO',
    ).toBeDefined();
    expect(rejection).toMatchObject({ code: 'EIO', syscall: 'rmdir' });
    expect(
      typeof (rejection as NodeJS.ErrnoException).errno,
      'the injected error carries no errno, so it does not resemble one Node raises',
    ).toBe('number');

    // Control: the refusal was reached. `rejects` alone is satisfied by any
    // rejection, including one raised before `rm` was ever called.
    expect(
      blocked.calls,
      'rm was never called on this process own root, so no refusal was triggered',
    ).toContain(ownRoot);
  });
});
