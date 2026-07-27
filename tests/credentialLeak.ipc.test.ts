// @vitest-environment node

/**
 * Credential-leak checks at the WIRED IPC boundary — #21 slice 4.
 *
 * `credentialLeak.test.ts` drives the `ServerProfileService` in isolation.
 * This file instead invokes the handlers that `registerIpcHandlers` actually
 * registers, with the REAL service passed in as the collaborator — the
 * composition a renderer reaches in production. It is the credential analogue
 * of `ipc.authz.test.ts`, which proves the same registration path authorizes
 * filesystem paths.
 *
 * The distinction matters for the reason #96's B3 did: `ipc.authz.test.ts`
 * passes a *fake* profile service (`list` returns `{ profiles: [] }`), so the
 * real redaction has never run through the registered handler. A handler that
 * returned `profiles.save(request)` without the `ipcSchemas[...].response.parse`
 * wrapper — or a response schema switched to `.passthrough()` — would leak, and
 * nothing in the suite would see it. Here the real service holds a real secret
 * and the assertions read what the handler hands back to the renderer.
 *
 * Non-vacuity: return `response` unwrapped at ipc.ts:785 (drop the
 * `.response.parse`) OR return `redacted` unstripped at serverProfiles.ts:1679,
 * and the leak assertions below turn RED.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import {
  ServerProfileService,
  type ProfileFileSystem,
  type SecretStorage,
} from '../src/main/serverProfiles.js';
import type { ServerProfileDraft } from '@shared/ipc';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const USER_DATA_PATH = path.join(
  process.cwd(),
  'credential-leak-ipc-test-data',
);
const API_SECRET = 'desktop-secret';
const ISSUED_JWT = 'short-lived-jwt';
const FORBIDDEN = [API_SECRET, ISSUED_JWT, 'encryptedSecret'];

function leaks(value: unknown): string[] {
  const serialized = JSON.stringify(value) ?? '';
  return FORBIDDEN.filter((token) => serialized.includes(token));
}

type Handler = (event: unknown, request?: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

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
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: {},
}));

// `registerIpcHandlers` constructs `RetargetArtifactService` directly; the real
// one is irrelevant to credential redaction, so it is stubbed exactly as in
// `ipc.authz.test.ts` to keep registration side-effect free.
vi.mock('../src/main/retargetArtifacts.js', () => ({
  RetargetArtifactService: class {
    initialize = () => Promise.resolve();
    disposeAll = () => Promise.resolve();
    disposeForOwner = () => Promise.resolve({ disposed: true });
    preflight = () => Promise.resolve({ status: 'canceled' });
    build = () => Promise.resolve({ status: 'canceled' });
    loadScene = () => Promise.resolve({ status: 'canceled' });
    saveAs = () => Promise.resolve({ status: 'canceled' });
  },
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

class MemoryFileSystem implements ProfileFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readFile(filePath: string): Promise<Uint8Array> {
    const value = this.files.get(filePath);
    if (!value) {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(value);
  }
  writeFile(filePath: string, data: string): Promise<void> {
    this.files.set(filePath, new TextEncoder().encode(data));
    return Promise.resolve();
  }
  rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value) {
      this.files.set(to, value);
      this.files.delete(from);
    }
    return Promise.resolve();
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
    return Promise.resolve();
  }
}

const xorStorage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) =>
    new TextEncoder().encode(
      [...value].map((character) => character.charCodeAt(0) ^ 42).join(','),
    ),
  decryptString: (value) =>
    new TextDecoder()
      .decode(value)
      .split(',')
      .map((code) => String.fromCharCode(Number(code) ^ 42))
      .join(''),
};

const VERSION = {
  service: 'Farm.Web.Api',
  version: '0.2.2',
  environment: 'Production',
  runtime: '.NET 9',
  timestamp: '2026-07-23T11:59:00.000Z',
};
const CAPABILITIES = {
  architecture: 'Integrated',
  slicingEnabled: true,
  modelFilesEnabled: true,
  thumbnailGenerationEnabled: true,
  gcodeUploadEnabled: true,
  clientThumbnailUploadEnabled: true,
  idempotentModelUploadEnabled: true,
  modelThumbnailReplacementEnabled: true,
  operatorFeatures: { queue: true },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulFetch(): typeof globalThis.fetch {
  return vi.fn((input: string | URL | Request) => {
    const url =
      typeof input === 'string' || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
    switch (url.pathname) {
      case '/api/system/version':
        return Promise.resolve(json(VERSION));
      case '/api/system/capabilities':
        return Promise.resolve(json(CAPABILITIES));
      case '/api/auth/api-key/exchange':
        return Promise.resolve(
          json({
            token: ISSUED_JWT,
            expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
            scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
          }),
        );
      case '/api/auth/me':
        return Promise.resolve(
          json({ id: 'operator-1', username: 'operator' }),
        );
      default:
        return Promise.resolve(json({}, 404));
    }
  });
}

const apiKeyDraft = (
  overrides: Partial<ServerProfileDraft> = {},
): ServerProfileDraft => ({
  displayName: 'Farm',
  baseUrl: 'http://10.0.0.20/',
  credentials: { authMode: 'apiKey', apiKey: API_SECRET },
  allowLegacy: false,
  ...overrides,
});

function realService(): ServerProfileService {
  let id = 0;
  return new ServerProfileService({
    userDataPath: USER_DATA_PATH,
    fileSystem: new MemoryFileSystem(),
    secretStorage: xorStorage,
    fetch: successfulFetch(),
    now: () => NOW,
    createId: () =>
      id++ === 0
        ? '11111111-1111-4111-8111-111111111111'
        : `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`,
  });
}

function register(profiles: ServerProfileService): Map<string, Handler> {
  electronState.handlers.clear();
  const noopSidecar = {
    loadScene: () => Promise.resolve({}),
    extractVendorMetadata: () => Promise.resolve({}),
    extractVendorPlateThumbnails: () => Promise.resolve({ thumbnails: [] }),
    renderThumbnail: () =>
      Promise.resolve({ width: 1, height: 1, pngBase64: 'AA==' }),
    scanRoot: () => Promise.resolve({}),
    handshake: () => Promise.resolve({ sidecarVersion: '0' }),
    dispose: () => undefined,
  };
  const sceneCache = {
    loadScene: () => Promise.resolve({}),
    initialize: () => Promise.resolve(),
    adoptRecipe: () => Promise.resolve(),
    dispose: () => undefined,
  };
  const approvals = {
    canonicalizePickerFile: (requested: string) => Promise.resolve(requested),
    authorizeFile: () => Promise.reject(new Error('denied')),
    resolve: () => Promise.reject(new Error('denied')),
    approveFromPicker: () => Promise.reject(new Error('denied')),
    reset: () => Promise.resolve(),
  };
  registerIpcHandlers(
    undefined,
    profiles,
    noopSidecar as never,
    noopSidecar as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    approvals as never,
    sceneCache as never,
  );
  return new Map(electronState.handlers);
}

const senderEvent = { sender: { id: 1, once: () => undefined } };

describe('credential-leak: wired server-profile IPC handlers', () => {
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    handlers = register(realService());
  });

  it('registers the server-profile channels (guards the assertions below)', () => {
    // Without this, a registration regression would make every leak assertion
    // pass vacuously against an absent handler.
    for (const channel of [
      IpcChannel.ListServerProfiles,
      IpcChannel.SaveServerProfile,
      IpcChannel.SelectServerProfile,
      IpcChannel.TestServerProfile,
      IpcChannel.DeleteServerProfile,
    ]) {
      expect(handlers.get(channel), `${channel} not registered`).toBeTypeOf(
        'function',
      );
    }
  });

  it('hands the renderer no secret through save, then list/select/test', async () => {
    const saved = (await handlers.get(IpcChannel.SaveServerProfile)!(
      senderEvent,
      apiKeyDraft(),
    )) as { id: string };
    const listed = await handlers.get(IpcChannel.ListServerProfiles)!(
      senderEvent,
    );
    const selected = await handlers.get(IpcChannel.SelectServerProfile)!(
      senderEvent,
      { id: saved.id },
    );
    const tested = await handlers.get(IpcChannel.TestServerProfile)!(
      senderEvent,
      { source: 'draft', draft: apiKeyDraft({ id: saved.id }) },
    );

    for (const [label, payload] of [
      ['save', saved],
      ['list', listed],
      ['select', selected],
      ['test', tested],
    ] as const) {
      expect(leaks(payload), `${label} handler leaked a secret`).toEqual([]);
    }
  });

  it('still returns the profile the renderer needs (probe E)', async () => {
    // The admitting direction through the wired path: a handler that returned
    // `{}` or threw would pass every leak assertion above.
    const saved = (await handlers.get(IpcChannel.SaveServerProfile)!(
      senderEvent,
      apiKeyDraft(),
    )) as Record<string, unknown>;
    expect(saved).toMatchObject({
      displayName: 'Farm',
      baseUrl: 'http://10.0.0.20',
      authMode: 'apiKey',
    });

    const listed = (await handlers.get(IpcChannel.ListServerProfiles)!(
      senderEvent,
    )) as { profiles: unknown[] };
    expect(listed.profiles).toHaveLength(1);
  });
});
