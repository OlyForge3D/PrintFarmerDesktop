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
import { IpcChannel, ipcSchemas } from '@shared/ipc';

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
/**
 * Marker carried by every refusal the fake approval store issues. Assertions
 * match on it rather than on "any rejection", so a handler that blew up for an
 * unrelated reason — a missing collaborator method, say — cannot be mistaken
 * for a handler that refused.
 */
const DENIED = 'TEST_APPROVAL_DENIED';

class TestApprovalError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
}

/** A call the handler layer made to something downstream of authorization. */
interface DownstreamCall {
  target: 'sidecar' | 'sceneCache';
  method: string;
  args: unknown[];
}

interface Harness {
  handlers: Map<string, Handler>;
  downstream: DownstreamCall[];
}

function harness(): Harness {
  electronState.handlers.clear();
  electronState.owners.length = 0;
  const downstream: DownstreamCall[] = [];

  const record =
    (target: DownstreamCall['target'], method: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      downstream.push({ target, method, args });
      return Promise.resolve(result);
    };

  const sidecar = {
    loadScene: record('sidecar', 'loadScene'),
    extractVendorMetadata: record('sidecar', 'extractVendorMetadata'),
    extractVendorPlateThumbnails: record(
      'sidecar',
      'extractVendorPlateThumbnails',
      { thumbnails: [] },
    ),
    renderThumbnail: record('sidecar', 'renderThumbnail', {
      width: 1,
      height: 1,
      pngBase64: 'AA==',
    }),
    scanRoot: record('sidecar', 'scanRoot'),
    handshake: () => Promise.resolve({ sidecarVersion: '0' }),
    dispose: () => undefined,
  };

  // #84 moved `LoadScene` behind SceneCacheService, so the sidecar is no longer
  // the only thing downstream of authorization. Both are recorded into one
  // list: the security property is "nothing downstream is reached", not
  // "the sidecar is not reached", and tracking only the sidecar is what let the
  // pre-rebase version of this test go vacuous when the collaborator moved.
  const sceneCache = {
    loadScene: record('sceneCache', 'loadScene'),
    initialize: () => Promise.resolve(),
    adoptRecipe: () => Promise.resolve(),
    dispose: () => undefined,
  };

  // Only the renderer-path channels are exercised here, so the approval store
  // implements exactly the surface those handlers touch.
  const approvals = {
    canonicalizePickerFile: (requested: string) => {
      if (requested === RENDERER_PATH) return Promise.resolve(CANONICAL_PATH);
      return Promise.reject(new TestApprovalError(DENIED));
    },
    authorizeFile: (requested: string) => {
      if (requested === RENDERER_PATH) {
        return Promise.resolve({
          sourcePath: requested,
          canonicalPath: CANONICAL_PATH,
        });
      }
      return Promise.reject(new TestApprovalError(DENIED));
    },
    resolve: () => Promise.reject(new TestApprovalError(DENIED)),
    approveFromPicker: () => Promise.reject(new TestApprovalError(DENIED)),
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
    sceneCache as never,
  );

  return { handlers: new Map(electronState.handlers), downstream };
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
 * Channels whose *request schema* exposes a `path` key, derived from
 * `ipcSchemas` at run time rather than transcribed from the handler bodies.
 *
 * A hand-maintained list is the same manual derivation that let
 * `ExtractVendorPlateThumbnails` ship unauthorized: it records what someone
 * read once, and a channel added later simply never appears in it. Reading the
 * contract instead means a new path-bearing channel joins this set on the run
 * that introduces it.
 */
function pathBearingChannels(): string[] {
  const found: string[] = [];
  for (const [channel, pair] of Object.entries(ipcSchemas)) {
    const request = (pair as { request: unknown }).request;
    const shape = (request as { shape?: Record<string, unknown> } | undefined)
      ?.shape;
    if (shape && Object.prototype.hasOwnProperty.call(shape, 'path')) {
      found.push(channel);
    }
  }
  return found;
}

/**
 * Every channel whose request carries a renderer-supplied filesystem path, and
 * the collaborator method each is expected to forward the *authorized* path to.
 * The membership of this list is checked against {@link pathBearingChannels}
 * below, so it cannot silently drift behind the contract; what it adds is the
 * per-channel detail that cannot be derived — which collaborator receives the
 * path.
 */
const PATH_CHANNELS: {
  channel: string;
  target: DownstreamCall['target'];
  method: string;
  pathArgIndex: number;
  request: (path: string) => unknown;
}[] = [
  {
    channel: IpcChannel.LoadScene,
    // #84 routed this through SceneCacheService; `sidecar.loadScene` is no
    // longer called. The property is unchanged — the canonical path, not the
    // renderer's string, is what the collaborator receives — but the
    // collaborator moved.
    target: 'sceneCache',
    method: 'loadScene',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.ExtractVendorMetadata,
    target: 'sidecar',
    method: 'extractVendorMetadata',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.ExtractVendorPlateThumbnails,
    target: 'sidecar',
    method: 'extractVendorPlateThumbnails',
    pathArgIndex: 0,
    request: (path) => ({ path }),
  },
  {
    channel: IpcChannel.RenderThumbnail,
    target: 'sidecar',
    method: 'renderThumbnail',
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

  it('covers exactly the channels whose request schema carries a path', () => {
    // Reads the contract rather than trusting the table above. A new
    // path-bearing channel fails here on the run that adds it, instead of
    // waiting for someone to notice it is missing from a hand-written list.
    expect([...pathBearingChannels()].sort()).toEqual(
      PATH_CHANNELS.map((entry) => entry.channel).sort(),
    );
  });

  it.each(pathBearingChannels())(
    '%s refuses an unapproved path and reaches nothing downstream of authorization',
    async (channel) => {
      // Driven by the derived set, not the table, and asserting only properties
      // that hold for *any* path channel. A path-bearing channel added without
      // authorization fails this without anyone having to describe it first.
      const handler = h.handlers.get(channel);
      expect(handler).toBeTypeOf('function');

      await expect(
        Promise.resolve(handler!(senderEvent(1), { path: UNAPPROVED_PATH })),
      ).rejects.toThrow(DENIED);

      // The load-bearing half. Rejecting is not enough on its own: a handler
      // that forwarded the path and *then* failed on the reply would also
      // reject. Asserting nothing downstream was touched — rather than naming
      // one collaborator — is what keeps this meaningful when a handler is
      // rewired, which is exactly what #84 did to LoadScene.
      expect(h.downstream).toEqual([]);
    },
  );

  describe.each(PATH_CHANNELS)(
    '$channel',
    ({ channel, target, method, pathArgIndex, request }) => {
      it(`forwards the canonicalized path to ${target}.${method}, not the string the renderer supplied`, async () => {
        const handler = h.handlers.get(channel);
        expect(handler).toBeTypeOf('function');

        await Promise.resolve(
          handler!(senderEvent(1), request(RENDERER_PATH)),
        ).catch(() => undefined);

        const call = h.downstream.find(
          (candidate) =>
            candidate.target === target && candidate.method === method,
        );
        expect(
          call,
          `${channel} never reached ${target}.${method}`,
        ).toBeDefined();
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
