/**
 * Guards the startup rejection window on `retargetArtifacts.initialize()`.
 *
 * The promise is assigned to `retargetReady` and awaited inside three IPC
 * handlers, so its rejection *is* eventually handled — but only once the
 * renderer first retargets, which may be minutes after startup or never. Until
 * then Node sees a rejected promise with no handler attached and, depending on
 * `--unhandled-rejections`, terminates the main process. `initialize()` reaps
 * stale instance directories, so it rejects on ordinary filesystem contention:
 * it is the call that threw `EPERM: rmdir` and exited the #159 suite non-zero
 * while every test passed.
 *
 * Three claims, because closing the window is not the whole requirement:
 *   1. the process survives — no `unhandledRejection` is reported;
 *   2. the failure is observable — a record naming it is emitted;
 *   3. that record is caused by the rejection — it is absent when initialize
 *      resolves, so claim 2 cannot be satisfied by an unconditional log;
 *   4. the rejection is still delivered — an IPC handler that awaits
 *      `retargetReady` reports the failure rather than proceeding.
 *
 * Claim 1 is an absence, so it is worthless without the control below: an
 * `unhandledRejection` listener that never fires satisfies `toEqual([])` for
 * every reason, including being attached to the wrong event or in a mode where
 * Node does not report at all. The control rejects a promise with no handler in
 * the same harness and requires the listener to see it.
 *
 * Claim 4 exists because the first three do not imply it. All three are about
 * the startup path, and a suite that only registers handlers cannot distinguish
 * "the rejection is handled and still delivered to its awaiters" from "the
 * rejection is swallowed and every awaiting handler resolves as though
 * initialize succeeded" — which is the worse defect. Reassigning
 * `retargetReady` to the caught promise left the first three green. Measured,
 * not assumed, which is why claim 4 invokes an awaiter rather than asserting
 * about one.
 *
 * `retargetProfileFailureClassification.test.ts` also kills that mutation, as a
 * side effect of asserting which envelope a reaper failure produces. That is a
 * different question, and depending on it made this file's coverage contingent
 * on another file continuing to invoke a handler for reasons of its own. Claim
 * 4 states the property here, where it is the subject rather than a by-product:
 * an awaiter of a rejected `retargetReady` must observe the failure.
 *
 * @module retargetInitUnhandledRejection.test
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { captureCalibrationLogs } from '../src/main/calibrationLog.js';
import type { ChannelFactory, SidecarChannel } from '../src/main/sidecar.js';

const INIT_FAILURE = 'EPERM: operation not permitted, rmdir';

/**
 * Real, per-run, and removed afterwards.
 *
 * The resolving control for claim 4 runs past the `retargetReady` await into
 * the real `refreshTargetProfiles()`, whose `initialize()` calls `mkdir` under
 * `app.getPath('userData')`. With the literal `/test/userData` this file used
 * before, that put five directories on the developer's filesystem outside the
 * repository, at a fixed absolute path shared with every other suite stubbing
 * the same value — so one suite's leftovers become another's starting state.
 *
 * Exercising the real service is the point of the control, so this contains the
 * writes rather than mocking the service away: `mkdtempSync` gives each run its
 * own root, which makes the writes both harmless and non-transferable.
 */
const userDataRoot = mkdtempSync(join(tmpdir(), 'retarget-init-'));

/**
 * Registered disposers, drained after every test.
 *
 * `registerIpcHandlers()` returns a disposer that calls `sidecar.dispose()`
 * whenever it constructed the sidecar itself, which is the case here. Every
 * spec in this file used to discard it.
 */
const pendingDisposers: Array<() => Promise<void>> = [];

/**
 * A channel that answers instead of spawning.
 *
 * `registerIpcHandlers()` builds `new SidecarClient(channelFactory ?? spawnSidecarChannel)`,
 * so with no factory supplied the suite spawned the real `model-core` binary:
 * `TargetProfileService.initialize()` reaches `loadBundled()`, which calls
 * `sidecar.listRetargetProfiles()`. Measured before this seam was used —
 * `model-core` peaked at one process above baseline during the run, on a
 * machine where `resources/sidecar/` exists.
 *
 * This injects the factory rather than mocking `targetProfiles`, because the
 * factory is a typed four-method seam the module already exposes: if
 * `SidecarChannel` changes, `tsc` fails here. A `vi.mock` factory for
 * `targetProfiles.js` would be an untyped claim about another module's export
 * surface and would go stale silently — the failure mode that put PR #146 red.
 *
 * It answers `ok: false` rather than a synthetic success: returning a result
 * would hard-code the response schema `listRetargetProfiles()` parses, which is
 * the same stale-claim problem one level down. A rejection is enough, because
 * the control below asserts only which envelope must *not* appear.
 */
/**
 * Every channel this suite hands out, so a spec can ask whether the disposer
 * actually closed them. Without this the disposer contract is unguarded: with a
 * fake channel nothing observable leaks, so "we forgot to dispose" and "we
 * disposed correctly" produce identical runs.
 */
const issuedChannels: Array<{ closed: boolean }> = [];

const testChannelFactory: ChannelFactory = (): SidecarChannel => {
  let onMessage: ((line: string) => void) | undefined;
  const state = { closed: false };
  issuedChannels.push(state);
  return {
    send: (line: string) => {
      const id: unknown = (JSON.parse(line) as { id?: unknown }).id;
      // Replying asynchronously: SidecarClient registers the pending request
      // after `send` returns, so a synchronous reply would arrive before there
      // is anything to resolve and the request would hang to its timeout.
      queueMicrotask(() =>
        onMessage?.(
          JSON.stringify({ id, ok: false, error: 'test channel: no sidecar' }),
        ),
      );
    },
    onMessage: (handler: (line: string) => void) => {
      onMessage = handler;
    },
    onClose: () => {},
    close: () => {
      state.closed = true;
    },
  };
};

const LIST_CHANNEL = 'retarget:listProfiles';

/**
 * Pinned verbatim from `retargetWorkspaceFailure()` in `ipc.ts`. Asserting the
 * message rather than the code because `internalError` is also what an
 * unclassified profile fault returns, so the code alone cannot tell the two
 * apart — and telling them apart is the whole point of claim 4.
 */
const WORKSPACE_FAILURE_MESSAGE =
  'The retarget workspace could not be prepared.';

const electronState = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
};

/** Lets a single test flip `initialize()` between rejecting and resolving. */
const retargetState = { failInit: true };

/**
 * Same control for the scene cache, which is stubbed for a different reason:
 * the real `SceneCacheService.initialize()` spawns the sidecar binary, so
 * whether it rejects depends on whether `resources/sidecar/` exists on disk.
 * That directory is gitignored, so the outcome of this spec used to depend on
 * an untracked build artifact (#267).
 */
const sceneCacheState = { failInit: false };

/**
 * Emitted by the test itself to prove the capture is live. It has to be a
 * record this spec owns: any record produced by other startup machinery makes
 * the liveness check a measurement of that machinery instead.
 */
const SINK_LIVENESS_SENTINEL = 'test.sinkLivenessProbe';

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataRoot,
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/test/userData',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  shell: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronState.handlers.delete(channel);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 'window-stub' }) },
}));

vi.mock('../src/main/retargetArtifacts.js', () => ({
  RetargetArtifactService: class {
    initialize = () =>
      retargetState.failInit
        ? Promise.reject(new Error(INIT_FAILURE))
        : Promise.resolve();
    disposeAll = () => Promise.resolve();
    disposeOwner = () => Promise.resolve();
    disposeForOwner = () => Promise.resolve({ disposed: true });
    preflight = () => Promise.resolve({ status: 'canceled' });
    build = () => Promise.resolve({ status: 'canceled' });
    loadScene = () => Promise.resolve({ status: 'canceled' });
    saveAs = () => Promise.resolve({ status: 'canceled' });
  },
}));

vi.mock('../src/main/sceneCache.js', () => ({
  SceneCacheService: class {
    initialize = () =>
      sceneCacheState.failInit
        ? Promise.reject(new Error('scene cache stub: initialize rejected'))
        : Promise.resolve();
    loadScene = () => Promise.resolve({ status: 'canceled' });
    adoptRecipe = () => Promise.resolve({ status: 'canceled' });
    purge = () => Promise.resolve();
  },
}));

/**
 * Collects `unhandledRejection` events raised while `run` executes, then drains
 * the microtask queue and one macrotask turn — Node reports at the end of the
 * turn in which the promise settles, so a synchronous assertion sees nothing
 * regardless of whether the defect is present.
 */
async function collectUnhandledRejections(
  run: () => void | Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  const existing = process.listeners('unhandledRejection');
  for (const listener of existing) {
    process.off('unhandledRejection', listener);
  }
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    for (const listener of existing) {
      process.on(
        'unhandledRejection',
        listener as (...args: unknown[]) => void,
      );
    }
  }
  return seen;
}

describe('retargetArtifacts.initialize() startup rejection', () => {
  let capture: ReturnType<typeof captureCalibrationLogs>;

  beforeEach(() => {
    electronState.handlers.clear();
    retargetState.failInit = true;
    sceneCacheState.failInit = false;
  });

  async function drainPendingDisposers(): Promise<void> {
    while (pendingDisposers.length > 0) {
      await pendingDisposers.pop()?.();
    }
  }

  afterEach(async () => {
    // Drained before `resetModules`, or the disposer would run against a module
    // graph that has already been replaced.
    await drainPendingDisposers();
    capture?.stop();
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(userDataRoot, { recursive: true, force: true });
  });

  /**
   * `vi.resetModules()` gives each test a fresh module registry, so the sink
   * must be installed on the same `calibrationLog` instance `ipc.ts` will
   * import. Capturing from a statically-imported copy silently observes a
   * different module and records nothing — which the non-empty assertions
   * below turn into a failure rather than a vacuous pass.
   */
  async function loadIpcWithCapture(): Promise<{
    registerIpcHandlers: (...args: unknown[]) => () => Promise<void>;
    emitSinkLivenessProbe: () => void;
  }> {
    const log = await import('../src/main/calibrationLog.js');
    capture = log.captureCalibrationLogs();
    const ipc = (await import('../src/main/ipc.js')) as unknown as {
      registerIpcHandlers: (...args: unknown[]) => () => Promise<void>;
    };
    // Re-resolved AFTER `ipc.js`, and that ordering is the whole point. Nothing
    // runs between the two imports, so this is the same module instance `ipc.ts`
    // just resolved for its own static import of `./calibrationLog.js`. The
    // binding captured above is a different question: if the registry was reset
    // between the capture and the `ipc.js` import, `log` and `logSeenByIpc` are
    // two distinct copies, and only the second one is the sink `ipc.ts` writes
    // to.
    const logSeenByIpc = await import('../src/main/calibrationLog.js');
    return {
      // Wrapped so the injected channel and the disposer are impossible to
      // forget at a call site: every spec goes through this one function, and
      // adding a spec that spawns a real sidecar now requires bypassing it
      // deliberately rather than merely omitting an argument.
      registerIpcHandlers: (...args: unknown[]) => {
        const dispose = ipc.registerIpcHandlers(
          ...(args.length > 0 ? args : [testChannelFactory]),
        );
        pendingDisposers.push(dispose);
        return dispose;
      },
      // Emitted through `logSeenByIpc`, NOT through the `log` binding the
      // capture came from. Emitting through `log` would have proved `log ===
      // log`: the probe would reach the capture no matter which copy `ipc.ts`
      // resolved, which is the one thing this is supposed to detect. Sourcing
      // it here means a divergence sends the probe into the other instance's
      // sink, the sentinel never reaches `capture.records`, and the liveness
      // assertion goes red instead of passing vacuously.
      emitSinkLivenessProbe: () =>
        logSeenByIpc.emitCalibrationLog({
          level: 'info',
          component: 'calibration.sidecar',
          event: SINK_LIVENESS_SENTINEL,
          outcome: 'ok',
        }),
    };
  }

  it('reports an unhandled rejection when nothing attaches a handler', async () => {
    // CONTROL. Without this, the assertion below that the real code produces no
    // unhandled rejection is unfalsifiable: a listener that never fires passes
    // it for every reason, including reasons that have nothing to do with the
    // fix. This proves the harness observes the event it claims to observe.
    const seen = await collectUnhandledRejections(() => {
      void Promise.reject(new Error('control: nothing handles this'));
    });

    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('control: nothing handles this');
  });

  it('directs every userData write into a disposable temp root', async () => {
    // GUARD on the containment, not a restatement of it. The specs below drive
    // the real TargetProfileService, which mkdirs under `app.getPath('userData')`
    // — so whatever that mock returns is where this suite writes. Point it at a
    // fixed absolute path again (this file used `/test/userData` until now, as
    // six sibling suites still do) and this fails, where every other assertion
    // in the file stays green because the writes succeed either way.
    const { app } = await import('electron');
    const resolved = app.getPath('userData');

    expect(resolved.startsWith(tmpdir())).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('survives a rejecting initialize and says so, without swallowing it', async () => {
    const { registerIpcHandlers } = await loadIpcWithCapture();

    let dispose: (() => Promise<void>) | undefined;
    const seen = await collectUnhandledRejections(() => {
      dispose = registerIpcHandlers();
    });

    // 1. The process survives: startup produced no unhandled rejection.
    expect(seen).toEqual([]);

    // 2. The failure is observable. Assert the captured set is non-empty before
    //    asserting anything about its contents — a capture that returns nothing
    //    satisfies every claim made about what it does not contain.
    const records = capture.records;
    expect(records.length).toBeGreaterThan(0);

    const failure = records.find(
      (record) =>
        record.event === 'retargetArtifacts.startupInitializationFailed',
    );
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('error');
    expect(failure?.outcome).toBe('failed');

    expect(typeof dispose).toBe('function');
  });

  it('emits no such record when initialize succeeds', async () => {
    // CONTROL for the assertion above. Without it, "the failure is observable"
    // is satisfied by a record emitted unconditionally at startup, which would
    // survive deleting the rejection entirely. Same input path, one variable
    // changed: initialize resolves.
    retargetState.failInit = false;
    const { registerIpcHandlers, emitSinkLivenessProbe } =
      await loadIpcWithCapture();
    emitSinkLivenessProbe();

    const seen = await collectUnhandledRejections(() => {
      registerIpcHandlers();
    });
    expect(seen).toEqual([]);

    // The capture is live -- proven by a record this spec emitted itself, so
    // the zero below is a statement about the event rather than about an empty
    // sink. A bare `records.length > 0` used to stand here, and it was
    // satisfied by `sceneCache.startupInvalidationFailed`, which is emitted
    // only when the sidecar binary is MISSING. That made the control pass
    // because an unrelated subsystem was broken, and fail on any machine where
    // it works.
    expect(capture.records.map((record) => record.event)).toContain(
      SINK_LIVENESS_SENTINEL,
    );
    expect(
      capture.records.filter(
        (record) =>
          record.event === 'retargetArtifacts.startupInitializationFailed',
      ),
    ).toEqual([]);
  });

  /**
   * Claim 4. Reaches `retargetReady` through an actual awaiter rather than
   * asserting about one.
   *
   * `retarget:listProfiles` returns before touching the profile bundle when
   * `retargetReady` rejects, so this needs no `targetProfiles` stub. That is
   * deliberate: a `vi.mock` factory is a hard-coded claim about another
   * module's export surface, and this file would then go red whenever that
   * surface grew — the same failure mode as a count assertion, one level up.
   */
  async function invokeListProfiles(): Promise<{
    status: string;
    error?: { code?: string; message?: string };
  }> {
    const { registerIpcHandlers } = await loadIpcWithCapture();
    registerIpcHandlers();

    // Non-empty before asserting about contents: an empty handler map would
    // make every claim below vacuous by satisfying it with nothing.
    expect(electronState.handlers.size).toBeGreaterThan(0);
    const handler = electronState.handlers.get(LIST_CHANNEL);
    expect(handler).toBeDefined();

    return (await handler?.({ sender: {} })) as {
      status: string;
      error?: { code?: string; message?: string };
    };
  }

  it('delivers the rejection to a handler that awaits it', async () => {
    const response = await invokeListProfiles();

    // The property: an awaiter must see the failure. Swallowing the rejection
    // at the creation site would let this resolve as though the workspace had
    // been prepared, which is the defect claims 1-3 cannot see.
    expect(response.status).toBe('error');
    expect(response.error?.message).toBe(WORKSPACE_FAILURE_MESSAGE);
  });

  it('reports something other than the workspace when initialize succeeds', async () => {
    // CONTROL for the spec above. Without it, "the handler reports the
    // workspace failure" is satisfied by a handler that reports it
    // unconditionally, and would survive deleting the await entirely.
    retargetState.failInit = false;

    const response = await invokeListProfiles();

    // Deterministic *because* the channel is injected. Measured with the
    // injection removed, this same call returns `status: 'ok'` and a catalog of
    // bundled profiles read off disk — so asserting `'error'` here is also the
    // guard on the injection itself: delete the factory and this spec fails.
    //
    // The previous version asserted only `message !== WORKSPACE_FAILURE_MESSAGE`
    // and was deliberately environment-independent, since the real
    // `refreshTargetProfiles()` returned different things on different machines.
    // That property is exactly what made it blind: it passed whether or not a
    // sidecar was spawned. Controlling the environment is what makes a specific
    // outcome safe to assert, and asserting one is what guards the control.
    expect(response.status).toBe('error');
    expect(response.error?.message).not.toBe(WORKSPACE_FAILURE_MESSAGE);
  });

  it('closes the sidecar channel when the IPC disposer runs', async () => {
    // GUARD on the disposer. Two reviewers rejected the head above this one for
    // discarding the value `registerIpcHandlers()` returns, and with a fake
    // channel that defect is invisible: nothing observable leaks, so forgetting
    // to dispose and disposing correctly produce identical runs. The fake
    // records its own `close()` so the omission has somewhere to show up.
    retargetState.failInit = false;
    const before = issuedChannels.length;

    // Drives the sidecar, which is what makes a channel exist at all — the
    // client constructs it lazily, on first request, not in its constructor.
    await invokeListProfiles();
    expect(issuedChannels.length).toBeGreaterThan(before);

    const issued = issuedChannels.slice(before);
    expect(issued.every((channel) => channel.closed)).toBe(false);

    await drainPendingDisposers();

    expect(issued.every((channel) => channel.closed)).toBe(true);
  });
});

/*
 * Not asserted here, deliberately, and it is a finding rather than a gap.
 *
 * `retarget:listProfiles` is the channel that awaits `retargetReady`, so the
 * obvious third claim — that handling the rejection at the creation site does
 * not swallow it — looks testable through its response. It is not. Measured at
 * `c7bd1f6` with `initialize()` rejecting and resolving, and again with a stub
 * retarget sidecar injected, the handler returned a byte-identical envelope in
 * both conditions:
 *
 *   { status: 'error', error: { code: 'sidecarUnavailable', … } }
 *
 * because its `catch` mapped every error — the startup reap failure, a profile
 * refresh failure, an absent sidecar — onto one outcome. Any assertion written
 * against that envelope passed whether or not the rejection was swallowed, so
 * it would have been an assertion that cannot fail.
 *
 * The gap is measured, not asserted. Two mutations, both swallowing:
 *
 *   M-4   `initialize().catch(() => undefined)`            exit 1, RED
 *   M-4b  log identically, then swallow for awaiters       exit 0, SURVIVED
 *
 * M-4 is red for the wrong reason — it removes the rejection, so no record is
 * emitted and the observability assertion fires. It changes two things and
 * would read as coverage of the awaiter claim. M-4b changes only the one, and
 * it survives: nothing here can distinguish preserved from swallowed.
 *
 * UPDATE (#316). The lossy envelope described above was reported and fixed;
 * the paragraph is kept because the mutation result about *this* suite still
 * holds, but its premise no longer describes the handler. `retargetReady` is
 * now awaited in its own `try` and a reaper failure reports the workspace
 * rather than the profile bundle, so the two faults are distinguishable and
 * `tests/retargetProfileFailureClassification.test.ts` asserts exactly that.
 *
 * That does **not** close the awaiter claim above in full, but it narrows it,
 * and the narrowing was measured rather than argued. Mutating the creation site
 * to swallow *for awaiters* — `initialize().catch(() => undefined)` — is now
 * killed: four cases in `tests/retargetProfileFailureClassification.test.ts` go
 * red, because a resolved `retargetReady` lets the handler run on an
 * unprepared workspace and the import channel returns `canceled` where the
 * workspace envelope is expected. So the property *"the rejection reaches its
 * awaiters"* IS asserted now, as a side effect of asserting classification.
 *
 * What remains un-asserted is narrower than the paragraph above claims: the
 * `void retargetReady.catch(...)` handler at the creation site could log and
 * return, or return without logging, and no awaiter could tell — because that
 * `.catch` produces a *new* discarded promise and cannot alter what
 * `await retargetReady` observes. That residue is covered by this suite's own
 * observability assertion, not by the classification suite.
 *
 * Recorded because the first version of this note said M-4b "still survives",
 * which was false. It was corrected by running the mutation instead of
 * re-reading the code — the reasoning that produced the false claim was
 * confident and wrong about which promise the `.catch` attaches to.
 */
