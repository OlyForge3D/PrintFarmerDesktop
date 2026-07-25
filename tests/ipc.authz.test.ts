// @vitest-environment node

/**
 * Authorization proofs for the registered IPC handler layer.
 *
 * These tests invoke `registerIpcHandlers` and call the resulting handler
 * functions. That distinguishes them from `tests/ipc.test.ts`, which imports
 * only `@shared/ipc` and exercises the Zod request/response schemas. The
 * schemas cannot express authorization: `ExtractVendorMetadataRequest` and
 * `ExtractVendorPlateThumbnailsRequest` are byte-identical (`shared/ipc.ts:272`
 * and `:301`, both `{ path: z.string().min(1).max(4096) }`), so a contract test
 * cannot tell an authorizing handler from a non-authorizing one. The difference
 * lives only in the handler body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';

type Handler = (event: unknown, request: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  /** Owner ids the IPC layer passed into the artifact service, per method. */
  owners: [] as { method: string; owner: unknown }[],
}));

vi.mock('../src/main/retargetArtifacts.js', () => {
  const capture = (method: string, result: unknown) => (owner: unknown) => {
    electronState.owners.push({ method, owner });
    return Promise.resolve(result);
  };
  const outcome = {
    status: 'error',
    error: {
      domain: 'electron',
      code: 'invalidRequest',
      message: 'x',
      action: 'y',
      part: null,
      setting: null,
    },
  };
  return {
    RetargetArtifactService: class {
      initialize = () => Promise.resolve();
      disposeAll = () => Promise.resolve();
      disposeOwner = () => Promise.resolve();
      disposeArtifacts = () => Promise.resolve();
      preflight = capture('preflight', outcome);
      build = capture('build', outcome);
      loadScene = capture('loadScene', outcome);
      saveAs = capture('saveAs', { status: 'canceled' });
      disposeForOwner = capture('disposeForOwner', { disposed: true });
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test/userData',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 'window-stub' }) },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: {},
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

/** A path the renderer names. Never valid to hand to the sidecar as-is. */
const RENDERER_PATH = '/renderer/claimed/model.3mf';
/** What the approval store canonicalizes {@link RENDERER_PATH} to. */
const CANONICAL_PATH = '/approved/real/model.3mf';
/** A path the approval store refuses. */
const UNAPPROVED_PATH = '/etc/shadow';

class TestApprovalError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
}

interface Harness {
  handlers: Map<string, Handler>;
  sidecarCalls: { method: string; args: unknown[] }[];
}

function harness(): Harness {
  electronState.handlers.clear();
  electronState.owners.length = 0;
  const sidecarCalls: { method: string; args: unknown[] }[] = [];

  const record =
    (method: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      sidecarCalls.push({ method, args });
      return Promise.resolve(result);
    };

  const sidecar = {
    loadScene: record('loadScene'),
    extractVendorMetadata: record('extractVendorMetadata'),
    extractVendorPlateThumbnails: record('extractVendorPlateThumbnails', {
      thumbnails: [],
    }),
    renderThumbnail: record('renderThumbnail', {
      width: 1,
      height: 1,
      pngBase64: 'AA==',
    }),
    scanRoot: record('scanRoot'),
    handshake: () => Promise.resolve({ sidecarVersion: '0' }),
    dispose: () => undefined,
  };

  // Only the renderer-path channels are exercised here, so the approval store
  // implements exactly the surface those handlers touch.
  const approvals = {
    canonicalizePickerFile: (requested: string) => {
      if (requested === RENDERER_PATH) return Promise.resolve(CANONICAL_PATH);
      return Promise.reject(new TestApprovalError('not a picker file'));
    },
    authorizeFile: (requested: string) => {
      if (requested === RENDERER_PATH) {
        return Promise.resolve({
          sourcePath: requested,
          canonicalPath: CANONICAL_PATH,
        });
      }
      return Promise.reject(new TestApprovalError('not approved'));
    },
    resolve: () => Promise.reject(new TestApprovalError('no approval')),
    approveFromPicker: () => Promise.reject(new TestApprovalError('no picker')),
    reset: () => Promise.resolve(),
  };

  registerIpcHandlers(
    undefined,
    {
      list: () => Promise.resolve({ profiles: [], selectedProfileId: null }),
    } as never,
    sidecar as never,
    sidecar as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    approvals as never,
  );

  return { handlers: new Map(electronState.handlers), sidecarCalls };
}

function senderEvent(id: number) {
  return {
    sender: {
      id,
      once: () => undefined,
    },
  };
}

/**
 * Every channel whose request carries a renderer-supplied filesystem path, and
 * the sidecar method each is expected to forward the *authorized* path to.
 * Derived by reading each `ipcMain.handle` body in `src/main/ipc.ts` that
 * dereferences `request.path`.
 */
const PATH_CHANNELS: {
  channel: string;
  sidecarMethod: string;
  pathArgIndex: number;
  request: (path: string) => unknown;
}[] = [
  {
    channel: IpcChannel.LoadScene,
    sidecarMethod: 'loadScene',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.ExtractVendorMetadata,
    sidecarMethod: 'extractVendorMetadata',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.ExtractVendorPlateThumbnails,
    sidecarMethod: 'extractVendorPlateThumbnails',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.RenderThumbnail,
    sidecarMethod: 'renderThumbnail',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
];

describe('IPC handler layer: renderer-supplied filesystem paths', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('registers every channel in the shared contract', () => {
    // Guards the harness itself: if registration silently stopped happening,
    // every authorization test below would pass vacuously against an empty map.
    expect(h.handlers.size).toBe(Object.keys(IpcChannel).length);
  });

  describe.each(PATH_CHANNELS)(
    '$channel',
    ({ channel, sidecarMethod, pathArgIndex, request }) => {
      it('refuses a path the approval store does not approve, without invoking the sidecar', async () => {
        const handler = h.handlers.get(channel);
        expect(handler).toBeTypeOf('function');

        await expect(
          Promise.resolve(handler!(senderEvent(1), request(UNAPPROVED_PATH))),
        ).rejects.toThrow();

        // The load-bearing assertion. Rejecting is not enough on its own: a
        // handler that forwarded the path and *then* failed to parse the
        // sidecar's reply would also reject. This proves the refusal happened
        // before the filesystem was touched.
        expect(
          h.sidecarCalls.filter((call) => call.method === sidecarMethod),
        ).toHaveLength(0);
      });

      it('forwards the canonicalized path rather than the string the renderer supplied', async () => {
        const handler = h.handlers.get(channel);
        expect(handler).toBeTypeOf('function');

        await Promise.resolve(
          handler!(senderEvent(1), request(RENDERER_PATH)),
        ).catch(() => undefined);

        const call = h.sidecarCalls.find(
          (candidate) => candidate.method === sidecarMethod,
        );
        expect(call, `${channel} never reached the sidecar`).toBeDefined();
        expect(call!.args[pathArgIndex]).toBe(CANONICAL_PATH);
        expect(call!.args[pathArgIndex]).not.toBe(RENDERER_PATH);
      });
    },
  );
});

/**
 * Retarget artifacts are owned by the WebContents that created them;
 * `RetargetArtifactService` compares `record.owner !== owner` and returns
 * `artifactForbidden` on a mismatch. `tests/retargetArtifacts.test.ts` proves
 * that comparison at the service level, but it constructs the owner itself, so
 * it holds even if the IPC layer passed a constant. These tests pin the wiring:
 * the value the service receives is the calling WebContents' own id.
 */
const OWNER_CHANNELS: {
  channel: string;
  method: string;
  request: unknown;
}[] = [
  {
    channel: IpcChannel.RetargetPreflight,
    method: 'preflight',
    request: {
      modelHash: 'a'.repeat(64),
      rootId: 'root-1',
      profileId: 'profile-1',
      objectExclusion: false,
    },
  },
  {
    channel: IpcChannel.RetargetBuild,
    method: 'build',
    request: {
      token: 'b'.repeat(43),
      profileId: 'profile-1',
      objectExclusion: false,
    },
  },
  {
    channel: IpcChannel.RetargetLoadScene,
    method: 'loadScene',
    request: { token: 'b'.repeat(43), source: 'source' },
  },
  {
    channel: IpcChannel.RetargetSaveAs,
    method: 'saveAs',
    request: { token: 'b'.repeat(43) },
  },
  {
    channel: IpcChannel.RetargetDispose,
    method: 'disposeForOwner',
    request: { token: 'b'.repeat(43) },
  },
];

describe('IPC handler layer: retarget artifact ownership', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it.each(OWNER_CHANNELS)(
    '$channel passes the calling WebContents id through as the artifact owner',
    async ({ channel, method, request }) => {
      const handler = h.handlers.get(channel);
      expect(handler).toBeTypeOf('function');

      // Two senders, neither id a plausible hardcoded default. A handler that
      // passed a constant — including `0`, `1`, or a captured first-caller id —
      // cannot satisfy both expectations, which is the mutation this guards.
      await Promise.resolve(handler!(senderEvent(7), request)).catch(
        () => undefined,
      );
      await Promise.resolve(handler!(senderEvent(9001), request)).catch(
        () => undefined,
      );

      const seen = electronState.owners
        .filter((entry) => entry.method === method)
        .map((entry) => entry.owner);

      expect(
        seen,
        `${channel} should have forwarded both calling sender ids to ${method}`,
      ).toEqual([7, 9001]);
    },
  );
});
