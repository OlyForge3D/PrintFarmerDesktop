/**
 * Guards the classification of target-profile failures on the two retarget
 * profile channels.
 *
 * `targetProfileFailure` used to be a two-arm ternary whose `else` returned
 * `sidecarUnavailable`. That branch was reached by a genuine sidecar problem
 * *and* by a rejected `retargetReady` — the temp-root reaper failing on
 * ordinary filesystem contention — so an operator hitting the second was told
 * the profile bundle was missing and advised to reinstall, which cannot clear
 * a stale temp directory.
 *
 * The assertion that matters here is an absence: the reaper failure must no
 * longer report `sidecarUnavailable`. **An absence proves nothing on its own.**
 * A handler that returned an empty envelope, a capture that never ran, or a
 * fixture that could not produce that code satisfies it just as well as a
 * correct fix. So every absence below is paired with a control that produces
 * the same code from the same handler on a different input:
 *
 *   - `reports the sidecar when the sidecar is at fault` is the control for
 *     `does not report the sidecar for a workspace fault`. Without it, the
 *     latter passes for a handler that cannot emit `sidecarUnavailable` at all.
 *   - `the two faults are distinguishable` asserts the two envelopes *differ*.
 *     This is the claim the #178 suite recorded as untestable, because the
 *     handler then mapped both onto one outcome; it is testable now, and it
 *     fails if the arms are ever collapsed back together.
 *
 * @module retargetProfileFailureClassification.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TargetProfileNativeError,
  TargetProfileUnavailableError,
} from '../src/main/targetProfiles.js';

const INIT_FAILURE = 'EPERM: operation not permitted, rmdir';

const electronState = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
};

/** Lets each test choose which of the two fault sources fires. */
const faultState: {
  failWorkspace: boolean;
  profileFault: Error | null;
} = { failWorkspace: false, profileFault: null };

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test/userData',
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
      faultState.failWorkspace
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

/*
 * The real error classes are re-exported, not restubbed: `targetProfileFailure`
 * discriminates with `instanceof`, so a locally-declared lookalike would take
 * the unclassified arm and the controls below would silently stop controlling
 * anything.
 */
vi.mock('../src/main/targetProfiles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/main/targetProfiles.js')
  >('../src/main/targetProfiles.js');
  return {
    ...actual,
    TargetProfileService: class {
      initialize = () =>
        faultState.profileFault
          ? Promise.reject(faultState.profileFault)
          : Promise.resolve();
      catalog = () => ({ profiles: [], warnings: [] });
      refresh = () => Promise.resolve({ profiles: [], warnings: [] });
    },
  };
});

const LIST_CHANNEL = 'retarget:listProfiles';
const IMPORT_CHANNEL = 'retarget:importProfile';

type Envelope = {
  status: string;
  error?: {
    domain: string;
    code: string;
    message: string;
    action: string;
  };
};

describe('retarget profile failure classification', () => {
  beforeEach(() => {
    electronState.handlers.clear();
    faultState.failWorkspace = false;
    faultState.profileFault = null;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function invoke(channel: string): Promise<Envelope> {
    const { registerIpcHandlers } =
      (await import('../src/main/ipc.js')) as unknown as {
        registerIpcHandlers: (...args: unknown[]) => () => Promise<void>;
      };
    registerIpcHandlers();

    // Assert the captured set is non-empty and holds the channel under test
    // before asserting anything about what a response does not contain. A
    // handler map that stayed empty would make every claim below vacuous.
    expect(electronState.handlers.size).toBeGreaterThan(0);
    const handler = electronState.handlers.get(channel);
    expect(handler).toBeDefined();

    return (await handler?.({ sender: {} })) as Envelope;
  }

  it('reports the workspace, not the profile bundle, when the reaper fails', async () => {
    faultState.failWorkspace = true;

    const response = await invoke(LIST_CHANNEL);

    expect(response.status).toBe('error');
    expect(response.error).toBeDefined();

    // The defect, stated directly: this fault is not a sidecar fault.
    expect(response.error?.code).not.toBe('sidecarUnavailable');
    expect(response.error?.code).toBe('internalError');

    // And the advice must not send the operator at the profile bundle. This is
    // the half that made the old envelope actively harmful rather than merely
    // imprecise: reinstalling cannot remove a temp directory.
    expect(response.error?.message).toContain('retarget workspace');
    expect(response.error?.action).not.toMatch(/profile bundle remains/i);
  });

  it('reports the sidecar when the sidecar really is at fault', async () => {
    // CONTROL for the assertion above. Same handler, same code path, one
    // variable changed. Without this, "the reaper failure is not reported as
    // sidecarUnavailable" is satisfied by a handler that never emits that code
    // under any condition — absence would be indistinguishable from
    // never-present.
    faultState.profileFault = new TargetProfileUnavailableError();

    const response = await invoke(LIST_CHANNEL);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('sidecarUnavailable');
    expect(response.error?.action).toMatch(/profile bundle remains/i);
  });

  it('passes a native failure through with its own classification', async () => {
    // Second control: the classified arm still wins over both fallbacks, so
    // the fix cannot be satisfied by mapping everything onto internalError.
    faultState.profileFault = new TargetProfileNativeError({
      code: 'profileStoreCorrupt',
      message: 'native said the store is corrupt',
      action: 'native action',
      part: null,
      setting: null,
    });

    const response = await invoke(LIST_CHANNEL);

    expect(response.status).toBe('error');
    expect(response.error?.domain).toBe('native');
    expect(response.error?.code).toBe('profileStoreCorrupt');
    expect(response.error?.message).toBe('native said the store is corrupt');
  });

  it('makes the two fault sources distinguishable to the operator', async () => {
    // The claim #178 recorded as untestable, because the handler then returned
    // a byte-identical envelope for both. Values, not key presence: identical
    // codes and identical actions are exactly the defect.
    faultState.failWorkspace = true;
    const workspace = await invoke(LIST_CHANNEL);

    vi.resetModules();
    electronState.handlers.clear();
    faultState.failWorkspace = false;
    faultState.profileFault = new TargetProfileUnavailableError();
    const sidecar = await invoke(LIST_CHANNEL);

    expect(workspace.error).toBeDefined();
    expect(sidecar.error).toBeDefined();
    expect(workspace.error?.code).not.toBe(sidecar.error?.code);
    expect(workspace.error?.message).not.toBe(sidecar.error?.message);
    expect(workspace.error?.action).not.toBe(sidecar.error?.action);
  });

  it('reports the workspace on the import channel too', async () => {
    // The two channels share the helper, so the import channel inherited the
    // same misdirection and must be fixed with it.
    faultState.failWorkspace = true;

    const response = await invoke(IMPORT_CHANNEL);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('internalError');
    expect(response.error?.message).toContain('retarget workspace');
    expect(response.error?.action).not.toMatch(/profile bundle remains/i);
  });

  it('returns ok when neither fault fires', async () => {
    // CONTROL for all of the above: the handler is capable of succeeding, so
    // the error assertions describe the faults injected rather than some
    // unrelated breakage in the harness that would fail every call.
    const response = await invoke(LIST_CHANNEL);

    expect(response.status).toBe('ok');
    expect(response.error).toBeUndefined();
  });
});
