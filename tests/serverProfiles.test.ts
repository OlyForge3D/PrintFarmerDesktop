import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ServerProfileError,
  ServerProfileService,
  buildServerEndpoint,
  normalizeServerUrl,
  type ProfileFileSystem,
  type SecretStorage,
} from '../src/main/serverProfiles.js';
import type { ServerProfileDraft } from '@shared/ipc';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const TEST_USER_DATA_PATH = path.join(process.cwd(), 'profile-test-data');
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

class MemoryFileSystem implements ProfileFileSystem {
  readonly files = new Map<string, Uint8Array>();
  renames = 0;
  private nextWriteGate: {
    reached: () => void;
    release: Promise<void>;
  } | null = null;
  private nextWriteError: Error | null = null;

  gateNextWrite(): {
    reached: Promise<void>;
    release: () => void;
  } {
    const reached = deferred<void>();
    const release = deferred<void>();
    this.nextWriteGate = {
      reached: () => reached.resolve(),
      release: release.promise,
    };
    return { reached: reached.promise, release: () => release.resolve() };
  }

  failNextWrite(error: Error): void {
    this.nextWriteError = error;
  }

  readFile(filePath: string): Promise<Uint8Array> {
    const value = this.files.get(filePath);
    if (!value) {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(value);
  }

  async writeFile(filePath: string, data: string): Promise<void> {
    const gate = this.nextWriteGate;
    if (gate) {
      this.nextWriteGate = null;
      gate.reached();
      await gate.release;
    }
    const writeError = this.nextWriteError;
    if (writeError) {
      this.nextWriteError = null;
      throw writeError;
    }
    this.files.set(filePath, new TextEncoder().encode(data));
  }

  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, await this.readFile(from));
    this.files.delete(from);
    this.renames += 1;
  }

  async mkdir(): Promise<void> {}

  unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
    return Promise.resolve();
  }
}

const secureStorage: SecretStorage = {
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

const apiKeyDraft = (
  overrides: Partial<ServerProfileDraft> = {},
): ServerProfileDraft => ({
  displayName: 'Farm',
  baseUrl: 'http://10.0.0.20/',
  credentials: {
    authMode: 'apiKey',
    apiKey: 'desktop-secret',
  },
  allowLegacy: false,
  ...overrides,
});

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function successfulFetch(
  onRequest?: (url: URL, init: RequestInit) => void,
): typeof globalThis.fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    onRequest?.(url, init ?? {});
    const endpointPath = url.pathname.replace(/^\/prefix(?=\/)/, '');
    switch (endpointPath) {
      case '/api/system/version':
        return Promise.resolve(json(VERSION));
      case '/api/system/capabilities':
        return Promise.resolve(json(CAPABILITIES));
      case '/api/auth/api-key/exchange':
        return Promise.resolve(
          json({
            token: 'short-lived-jwt',
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

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected string body');
  return JSON.parse(init.body) as unknown;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function persistedStore(fileSystem: MemoryFileSystem): string {
  const value = fileSystem.files.get(
    path.join(TEST_USER_DATA_PATH, 'server-profiles.v1.json'),
  );
  if (!value) throw new Error('Expected persisted profile store');
  return new TextDecoder().decode(value);
}

function encryptedBlob(serializedStore: string): string {
  const match = /"encryptedSecret":"([^"]+)"/.exec(serializedStore);
  if (!match?.[1]) throw new Error('Expected encrypted profile secret');
  return match[1];
}

const MutableProfileStore = z
  .object({
    selectedProfileId: z.string().uuid().nullable(),
    profiles: z.array(z.record(z.unknown())).min(1),
  })
  .passthrough();

function mutateStoredProfile(
  fileSystem: MemoryFileSystem,
  mutate: (profile: Record<string, unknown>) => void,
): void {
  const store = MutableProfileStore.parse(
    JSON.parse(persistedStore(fileSystem)),
  );
  const profile = store.profiles[0]!;
  const originalId = profile.id;
  mutate(profile);
  if (
    typeof originalId === 'string' &&
    typeof profile.id === 'string' &&
    store.selectedProfileId === originalId
  ) {
    store.selectedProfileId = profile.id;
  }
  fileSystem.files.set(
    path.join(TEST_USER_DATA_PATH, 'server-profiles.v1.json'),
    new TextEncoder().encode(JSON.stringify(store)),
  );
}

function service(
  fileSystem: MemoryFileSystem,
  fetchImpl = successfulFetch(),
  now: () => number = () => NOW,
  storage: SecretStorage = secureStorage,
  beforeLegacyConfirmationCas?: () => Promise<void>,
  afterSaveProbe?: () => void,
): ServerProfileService {
  let id = 0;
  return new ServerProfileService({
    userDataPath: TEST_USER_DATA_PATH,
    fileSystem,
    secretStorage: storage,
    fetch: fetchImpl,
    now,
    ...(beforeLegacyConfirmationCas ? { beforeLegacyConfirmationCas } : {}),
    ...(afterSaveProbe ? { afterSaveProbe } : {}),
    createId: () =>
      id++ === 0
        ? '11111111-1111-4111-8111-111111111111'
        : `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`,
  });
}

it('builds authenticated endpoints without dropping reverse-proxy prefixes', () => {
  expect(
    buildServerEndpoint(
      'https://farm.example/print-farmer',
      '/api/3d-models/upload',
    ).toString(),
  ).toBe('https://farm.example/print-farmer/api/3d-models/upload');
});

describe('server profiles', () => {
  it('keeps persisted server binding stable across rename and token renewal', async () => {
    const profiles = service(new MemoryFileSystem());
    const saved = await profiles.save(apiKeyDraft());
    const initial = await profiles.getPersistedSyncBinding(saved.id);
    const invalidated = vi.fn();
    profiles.subscribeInvalidation(invalidated);

    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'Renamed farm',
        credentials: { authMode: 'apiKey', apiKey: 'rotated-key' },
      }),
    );
    await profiles.refreshToken(saved.id);
    const unchanged = await profiles.getPersistedSyncBinding(saved.id);

    expect(unchanged).toEqual(initial);
    expect(invalidated).not.toHaveBeenCalled();
  });

  it('normalizes deterministic server URLs and rejects unsafe components', () => {
    expect(normalizeServerUrl(' HTTP://Example.COM:80/farm/// ')).toBe(
      'http://example.com/farm',
    );
    expect(() => normalizeServerUrl('ftp://farm.example')).toThrow(
      ServerProfileError,
    );
    expect(() =>
      normalizeServerUrl('https://user:password@farm.example?secret=x'),
    ).toThrow(/cannot include credentials/);
  });

  it('persists encrypted credentials atomically and returns only redacted data', async () => {
    const fs = new MemoryFileSystem();
    const calls: string[] = [];
    const profiles = service(
      fs,
      successfulFetch((url) => calls.push(url.pathname)),
    );

    const saved = await profiles.save(apiKeyDraft());
    const listed = await profiles.list();
    const persisted = [...fs.files.values()]
      .map((value) => new TextDecoder().decode(value))
      .join('');

    expect(saved).toMatchObject({
      authMode: 'apiKey',
      baseUrl: 'http://10.0.0.20',
      status: 'connected',
      warnings: ['insecureHttp'],
    });
    expect(saved.availability.librarySync.available).toBe(true);
    expect(saved.capabilities?.platformNote).toBeNull();
    expect(saved.version?.commit).toBeNull();
    expect(listed.profiles).toEqual([saved]);
    expect(JSON.stringify(listed)).not.toContain('encryptedSecret');
    expect(persisted).not.toContain('desktop-secret');
    expect(persisted).not.toContain('short-lived-jwt');
    expect(calls).toContain('/api/auth/me');
    expect(fs.renames).toBeGreaterThan(0);
  });

  it('binds authenticated contexts to profile revision and token generation', async () => {
    const fileSystem = new MemoryFileSystem();
    const paths: string[] = [];
    const profiles = service(
      fileSystem,
      successfulFetch((url) => paths.push(url.pathname)),
    );
    const saved = await profiles.save({
      ...apiKeyDraft(),
      baseUrl: 'https://farm.example/prefix',
    });
    const context = await profiles.getAuthenticatedContext(saved.id);
    expect(context.endpoint('/api/3d-models/upload').toString()).toBe(
      'https://farm.example/prefix/api/3d-models/upload',
    );
    expect(paths.every((value) => value.startsWith('/prefix/api/'))).toBe(true);
    await expect(
      profiles.revalidateAuthenticatedContext(context),
    ).resolves.toBeUndefined();

    mutateStoredProfile(fileSystem, (profile) => {
      profile.baseUrl = 'https://other-farm.example';
    });
    await expect(
      profiles.revalidateAuthenticatedContext(context),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_SUPERSEDED' });
    await expect(profiles.invalidateRejectedContext(context)).resolves.toBe(
      false,
    );
  });

  it('invalidates a rejected JWT only once for its exact context', async () => {
    const fileSystem = new MemoryFileSystem();
    const profiles = service(fileSystem);
    const saved = await profiles.save(apiKeyDraft());
    const context = await profiles.getAuthenticatedContext(saved.id);
    await expect(profiles.invalidateRejectedContext(context)).resolves.toBe(
      true,
    );
    await expect(profiles.invalidateRejectedContext(context)).resolves.toBe(
      false,
    );
  });

  it('notifies coordinated listeners when a profile endpoint changes or is removed', async () => {
    const fileSystem = new MemoryFileSystem();
    const profiles = service(fileSystem);
    const changed = vi.fn((profileId: string, binding: string) => {
      void profileId;
      void binding;
      return Promise.resolve();
    });
    profiles.onProfileBindingChanged(changed);
    const saved = await profiles.save(apiKeyDraft());
    await profiles.save({
      id: saved.id,
      displayName: saved.displayName,
      baseUrl: 'https://other-farm.example',
      credentials: { authMode: 'apiKey', apiKey: 'replacement-key' },
      allowLegacy: false,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    await profiles.delete(saved.id);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[0]?.[0]).toBe(saved.id);
  });

  it('accepts additive remote version, capability, and exchange fields', async () => {
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        switch (requestUrl(input).pathname) {
          case '/api/system/version':
            return Promise.resolve(
              json({ ...VERSION, additiveVersionField: 'future' }),
            );
          case '/api/system/capabilities':
            return Promise.resolve(
              json({
                ...CAPABILITIES,
                additiveCapabilityField: { enabled: true },
              }),
            );
          case '/api/auth/api-key/exchange':
            return Promise.resolve(
              json({
                token: 'future-jwt',
                expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
                scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
                additiveExchangeField: 'future',
              }),
            );
          default:
            return baseline(input, init);
        }
      },
    );

    await expect(
      service(new MemoryFileSystem(), fetchImpl).save(apiKeyDraft()),
    ).resolves.toMatchObject({
      status: 'connected',
      version: { service: 'Farm.Web.Api' },
      capabilities: { architecture: 'Integrated' },
    });
  });

  it('deleting a profile removes its encrypted secret and cached token', async () => {
    const fs = new MemoryFileSystem();
    const profiles = service(fs);
    const saved = await profiles.save(apiKeyDraft());

    await expect(profiles.getToken(saved.id)).resolves.toBe('short-lived-jwt');
    await expect(profiles.delete(saved.id)).resolves.toEqual({
      profiles: [],
      selectedProfileId: null,
    });
    await expect(profiles.getToken(saved.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const persisted = [...fs.files.values()]
      .map((value) => new TextDecoder().decode(value))
      .join('');
    expect(persisted).not.toContain('encryptedSecret');
  });

  it.each([
    [
      'base URL',
      (profile: Record<string, unknown>) => {
        profile.baseUrl = 'https://redirected.example';
        return profile.id as string;
      },
    ],
    [
      'profile ID',
      (profile: Record<string, unknown>) => {
        profile.id = '33333333-3333-4333-8333-333333333333';
        return profile.id as string;
      },
    ],
    [
      'authentication mode',
      (profile: Record<string, unknown>) => {
        profile.authMode = 'password';
        profile.username = 'redirected-user';
        return profile.id as string;
      },
    ],
  ] as const)(
    'rejects %s tampering before sending stored credentials',
    async (_field, tamper) => {
      const fs = new MemoryFileSystem();
      const fetchImpl = successfulFetch();
      const profiles = service(fs, fetchImpl);
      await profiles.save(apiKeyDraft());
      const requestsBeforeTamper = vi.mocked(fetchImpl).mock.calls.length;
      let requestedId = '';
      mutateStoredProfile(fs, (profile) => {
        requestedId = tamper(profile);
      });

      await expect(profiles.getToken(requestedId)).rejects.toMatchObject({
        code: 'CORRUPT_STORE',
      });
      expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(
        requestsBeforeTamper,
      );
    },
  );

  it('reports the previous feature-branch credential format without using it', async () => {
    const fs = new MemoryFileSystem();
    const fetchImpl = successfulFetch();
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());
    const requestsBeforeTamper = vi.mocked(fetchImpl).mock.calls.length;
    const legacyEncryptedSecret = Buffer.from(
      secureStorage.encryptString(
        JSON.stringify({ authMode: 'apiKey', apiKey: 'legacy-key' }),
      ),
    ).toString('base64');
    mutateStoredProfile(fs, (profile) => {
      profile.encryptedSecret = legacyEncryptedSecret;
    });

    await expect(profiles.getToken(saved.id)).rejects.toThrow(
      /unsupported feature-branch credential format/i,
    );
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(requestsBeforeTamper);
  });

  it('fails closed without OS encryption and does not make a request', async () => {
    const fetchImpl = successfulFetch();
    const profiles = service(new MemoryFileSystem(), fetchImpl, () => NOW, {
      ...secureStorage,
      isEncryptionAvailable: () => false,
    });

    await expect(profiles.save(apiKeyDraft())).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects Electron basic_text instead of falling back to plaintext', async () => {
    const profiles = service(
      new MemoryFileSystem(),
      successfulFetch(),
      () => NOW,
      {
        ...secureStorage,
        getSelectedStorageBackend: () => 'basic_text',
      },
    );
    await expect(profiles.save(apiKeyDraft())).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE',
    });
  });

  it('accepts an omission-shaped successful login without exposing the password', async () => {
    const fs = new MemoryFileSystem();
    let loginBody: unknown;
    const fetchImpl = successfulFetch();
    vi.mocked(fetchImpl).mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/auth/login') {
          loginBody = requestBody(init);
          return Promise.resolve(
            json({
              success: true,
              token: 'password-jwt',
              expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
              user: { id: 'operator' },
              additiveLoginField: { refreshSupported: false },
            }),
          );
        }
        if (url.pathname === '/api/system/version')
          return Promise.resolve(json(VERSION));
        if (url.pathname === '/api/system/capabilities')
          return Promise.resolve(json(CAPABILITIES));
        if (url.pathname === '/api/auth/me')
          return Promise.resolve(json({ id: 'operator' }));
        return Promise.resolve(json({}, 404));
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save({
      displayName: 'Password farm',
      baseUrl: 'https://farm.example',
      credentials: {
        authMode: 'password',
        username: 'operator@example.com',
        password: 'not-for-renderer',
        rememberMe: true,
      },
      allowLegacy: false,
    });

    expect(loginBody).toEqual({
      usernameOrEmail: 'operator@example.com',
      password: 'not-for-renderer',
      rememberMe: true,
    });
    expect(saved.username).toBe('operator@example.com');
    expect(JSON.stringify(saved)).not.toContain('not-for-renderer');
  });

  it('re-exchanges an API key before token expiration', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let exchanges = 0;
    const fetchImpl = successfulFetch((url) => {
      if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
    });
    const profiles = service(fs, fetchImpl, () => currentTime);
    const saved = await profiles.save(apiKeyDraft());

    expect(await profiles.getToken(saved.id)).toBe('short-lived-jwt');
    expect(exchanges).toBe(1);
    currentTime += 14 * 60_000 + 1;
    await expect(
      Promise.all([
        profiles.getToken(saved.id),
        profiles.getToken(saved.id),
        profiles.getToken(saved.id),
      ]),
    ).resolves.toEqual([
      'short-lived-jwt',
      'short-lived-jwt',
      'short-lived-jwt',
    ]);
    expect(exchanges).toBe(2);
  });

  it('keeps a saved token cached after a draft test reuses its profile ID', async () => {
    const fs = new MemoryFileSystem();
    let exchanges = 0;
    const profiles = service(
      fs,
      successfulFetch((url) => {
        if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
      }),
    );
    const saved = await profiles.save(apiKeyDraft());

    await profiles.test({
      source: 'draft',
      draft: apiKeyDraft({ id: saved.id }),
    });
    await expect(profiles.getToken(saved.id)).resolves.toBe('short-lived-jwt');

    expect(exchanges).toBe(2);
  });

  it('isolates a concurrent draft probe from a saved-profile renewal', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let exchanges = 0;
    const renewalReached = deferred<void>();
    const renewalGate = deferred<Response>();
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/auth/api-key/exchange') {
          exchanges += 1;
          if (exchanges === 2) {
            renewalReached.resolve();
            return renewalGate.promise;
          }
          return Promise.resolve(
            json({
              token: exchanges === 3 ? 'draft-jwt' : 'saved-jwt',
              expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
              scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime);
    const saved = await profiles.save(apiKeyDraft());
    currentTime += 14 * 60_000 + 1;

    const renewal = profiles.getToken(saved.id);
    await renewalReached.promise;
    await expect(
      profiles.test({
        source: 'draft',
        draft: apiKeyDraft({ id: saved.id }),
      }),
    ).resolves.toMatchObject({ id: saved.id, status: 'connected' });
    renewalGate.resolve(
      json({
        token: 'renewed-saved-jwt',
        expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
        scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
      }),
    );

    await expect(renewal).resolves.toBe('renewed-saved-jwt');
    await expect(profiles.getToken(saved.id)).resolves.toBe(
      'renewed-saved-jwt',
    );
    expect(exchanges).toBe(3);
  });

  it('rejects a gated token renewal when the profile is deleted', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let exchanges = 0;
    const renewalReached = deferred<void>();
    const renewalGate = deferred<Response>();
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/auth/api-key/exchange') {
          exchanges += 1;
          if (exchanges === 2) {
            renewalReached.resolve();
            return renewalGate.promise;
          }
          return Promise.resolve(
            json({
              token: 'initial-jwt',
              expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
              scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime);
    const saved = await profiles.save(apiKeyDraft());
    currentTime += 14 * 60_000 + 1;

    const renewal = profiles.getToken(saved.id);
    const renewalResult = expect(renewal).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await renewalReached.promise;
    await profiles.delete(saved.id);
    renewalGate.resolve(
      json({
        token: 'removed-credential-jwt',
        expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
        scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
      }),
    );

    await renewalResult;
  });

  it('rejects a gated renewal after profile replacement and keeps the new token', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let oldHostExchanges = 0;
    const renewalReached = deferred<void>();
    const renewalGate = deferred<Response>();
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/auth/api-key/exchange') {
          if (url.host === '10.0.0.20') {
            oldHostExchanges += 1;
            if (oldHostExchanges === 2) {
              renewalReached.resolve();
              return renewalGate.promise;
            }
          }
          return Promise.resolve(
            json({
              token:
                url.host === 'replacement.example'
                  ? 'replacement-jwt'
                  : 'initial-jwt',
              expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
              scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime);
    const saved = await profiles.save(apiKeyDraft());
    currentTime += 14 * 60_000 + 1;

    const renewal = profiles.getToken(saved.id);
    const renewalResult = expect(renewal).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await renewalReached.promise;
    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        baseUrl: 'https://replacement.example',
        credentials: { authMode: 'apiKey', apiKey: 'replacement-key' },
      }),
    );
    renewalGate.resolve(
      json({
        token: 'removed-credential-jwt',
        expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
        scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
      }),
    );

    await renewalResult;
    await expect(profiles.getToken(saved.id)).resolves.toBe('replacement-jwt');
  });

  it('forces fresh authentication and current-user validation for a saved test', async () => {
    const fs = new MemoryFileSystem();
    let exchanges = 0;
    let currentUserChecks = 0;
    const profiles = service(
      fs,
      successfulFetch((url) => {
        if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
        if (url.pathname === '/api/auth/me') currentUserChecks += 1;
      }),
    );
    const saved = await profiles.save(apiKeyDraft());

    await profiles.test({ source: 'saved', id: saved.id });

    expect(exchanges).toBe(2);
    expect(currentUserChecks).toBe(2);
  });

  it('non-destructively adopts a drifted /api/auth/me.id on token renewal', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let currentUserId = 'operator-1';
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/auth/me') {
          return Promise.resolve(
            json({ id: currentUserId, username: 'operator' }),
          );
        }
        if (url.pathname === '/api/auth/api-key/exchange') {
          return Promise.resolve(
            json({
              token: 'renewed-jwt',
              expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
              scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime);
    const invalidated = vi.fn();
    profiles.subscribeInvalidation(invalidated);

    const saved = await profiles.save(apiKeyDraft());
    const initial = await profiles.getPersistedSyncBinding(saved.id);

    // The server now resolves these credentials to a different principal
    // (key reassignment / account remap) without the desktop ever calling
    // saveProfile again.
    currentUserId = 'operator-2';
    currentTime += 14 * 60_000 + 1;

    await expect(profiles.getToken(saved.id)).resolves.toBe('renewed-jwt');

    const adopted = await profiles.getPersistedSyncBinding(saved.id);
    expect(adopted.incarnation).not.toBe(initial.incarnation);
    expect(adopted.revision).toBeGreaterThan(initial.revision);

    const transitions = await profiles.pendingBindingTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      profileId: saved.id,
      expectedBinding: initial.binding,
      newBinding: adopted.binding,
    });
    expect(invalidated).toHaveBeenCalledTimes(1);

    // The profile itself must survive the drift -- adoption must never
    // delete or otherwise destroy the existing profile/local data.
    const listed = await profiles.list();
    expect(listed.profiles.map((profile) => profile.id)).toContain(saved.id);

    // A second renewal against the now-stable principal must not mint yet
    // another binding transition.
    currentTime += 14 * 60_000 + 1;
    await expect(profiles.getToken(saved.id)).resolves.toBe('renewed-jwt');
    await expect(profiles.pendingBindingTransitions()).resolves.toHaveLength(1);
  });

  it('non-destructively adopts a drifted /api/auth/me.id on save', async () => {
    const fs = new MemoryFileSystem();
    let currentUserId = 'operator-1';
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/auth/me') {
          return Promise.resolve(
            json({ id: currentUserId, username: 'operator' }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const invalidated = vi.fn();
    profiles.subscribeInvalidation(invalidated);

    const saved = await profiles.save(apiKeyDraft());
    const initial = await profiles.getPersistedSyncBinding(saved.id);

    currentUserId = 'operator-2';
    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'Rebound farm',
        credentials: { authMode: 'apiKey', apiKey: 'rotated-key' },
      }),
    );

    const adopted = await profiles.getPersistedSyncBinding(saved.id);
    expect(adopted.incarnation).not.toBe(initial.incarnation);
    expect(adopted.revision).toBeGreaterThan(initial.revision);

    const transitions = await profiles.pendingBindingTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      profileId: saved.id,
      expectedBinding: initial.binding,
      newBinding: adopted.binding,
    });
    expect(invalidated).toHaveBeenCalledTimes(1);

    const listed = await profiles.list();
    expect(listed.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: saved.id,
          displayName: 'Rebound farm',
          status: 'connected',
        }),
      ]),
    );

    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'Still rebound farm',
        credentials: { authMode: 'apiKey', apiKey: 'rotated-again' },
      }),
    );
    await expect(profiles.pendingBindingTransitions()).resolves.toHaveLength(1);
    await expect(profiles.getPersistedSyncBinding(saved.id)).resolves.toEqual(
      adopted,
    );
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it('discards an older renewal after a forced saved-profile probe', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let exchanges = 0;
    const renewalReached = deferred<void>();
    const renewalGate = deferred<Response>();
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/auth/api-key/exchange') {
          exchanges += 1;
          if (exchanges === 2) {
            renewalReached.resolve();
            return renewalGate.promise;
          }
          return Promise.resolve(
            json({
              token: exchanges === 3 ? 'forced-probe-jwt' : 'initial-jwt',
              expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
              scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime);
    const saved = await profiles.save(apiKeyDraft());
    currentTime += 14 * 60_000 + 1;

    const oldRenewal = profiles.getToken(saved.id);
    const oldRenewalResult = expect(oldRenewal).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await renewalReached.promise;
    await profiles.test({ source: 'saved', id: saved.id });
    renewalGate.resolve(
      json({
        token: 'superseded-renewal-jwt',
        expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
        scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
      }),
    );

    await oldRenewalResult;
    await expect(profiles.getToken(saved.id)).resolves.toBe('forced-probe-jwt');
    expect(exchanges).toBe(3);
  });

  it('keeps newer retest state when an older stalled retest finishes', async () => {
    const fs = new MemoryFileSystem();
    const olderVersionGate = deferred<Response>();
    const olderRetestReached = deferred<void>();
    const baseline = successfulFetch();
    let versionCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/system/version') {
          versionCalls += 1;
          if (versionCalls === 2) {
            olderRetestReached.resolve();
            return olderVersionGate.promise;
          }
          if (versionCalls === 3) {
            return Promise.resolve(json({ ...VERSION, version: 'B-newer' }));
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());

    const olderRetest = profiles.test({ source: 'saved', id: saved.id });
    const olderResult = expect(olderRetest).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await olderRetestReached.promise;
    await expect(
      profiles.test({ source: 'saved', id: saved.id }),
    ).resolves.toMatchObject({
      status: 'connected',
      version: { version: 'B-newer' },
    });
    olderVersionGate.resolve(json({ ...VERSION, version: 'A-older' }));

    await olderResult;
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [
        {
          id: saved.id,
          status: 'connected',
          version: { version: 'B-newer' },
        },
      ],
    });
    expect(persistedStore(fs)).toContain('"version":"B-newer"');
    expect(persistedStore(fs)).not.toContain('"version":"A-older"');
  });

  it('finishes a guarded save commit before a newer retest generation starts', async () => {
    const fs = new MemoryFileSystem();
    const newerRetestVersionGate = deferred<Response>();
    const newerRetestReached = deferred<void>();
    const baseline = successfulFetch();
    let versionCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/system/version') {
          versionCalls += 1;
          if (versionCalls === 2) {
            return Promise.resolve(
              json({ ...VERSION, version: 'Save-A-version' }),
            );
          }
          if (versionCalls === 3) {
            newerRetestReached.resolve();
            return newerRetestVersionGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());
    const writeGate = fs.gateNextWrite();

    const saveA = profiles.save(
      apiKeyDraft({ id: saved.id, displayName: 'Save A' }),
    );
    await writeGate.reached;
    const retestB = profiles.test({ source: 'saved', id: saved.id });
    writeGate.release();

    await expect(saveA).resolves.toMatchObject({
      displayName: 'Save A',
      version: { version: 'Save-A-version' },
    });
    await newerRetestReached.promise;
    expect(persistedStore(fs)).toContain('"displayName":"Save A"');
    expect(persistedStore(fs)).toContain('"version":"Save-A-version"');

    newerRetestVersionGate.resolve(
      json({ ...VERSION, version: 'Retest-B-version' }),
    );
    await expect(retestB).resolves.toMatchObject({
      displayName: 'Save A',
      version: { version: 'Retest-B-version' },
    });
    expect(persistedStore(fs)).toContain('"version":"Retest-B-version"');
  });

  it('does not install a token candidate when the profile write fails', async () => {
    const fs = new MemoryFileSystem();
    let exchanges = 0;
    const profiles = service(
      fs,
      successfulFetch((url) => {
        if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
      }),
    );
    const saved = await profiles.save(apiKeyDraft());
    fs.failNextWrite(new Error('disk full'));

    await expect(
      profiles.save(
        apiKeyDraft({ id: saved.id, displayName: 'Must not persist' }),
      ),
    ).rejects.toThrow('disk full');
    expect(persistedStore(fs)).not.toContain('Must not persist');
    await expect(profiles.getToken(saved.id)).resolves.toBe('short-lived-jwt');
    expect(exchanges).toBe(3);
  });

  it('does not reinsert a token cleared while the profile write is pending', async () => {
    const fs = new MemoryFileSystem();
    let exchanges = 0;
    const profiles = service(
      fs,
      successfulFetch((url) => {
        if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
      }),
    );
    const saved = await profiles.save(apiKeyDraft());
    const writeGate = fs.gateNextWrite();

    const update = profiles.save(
      apiKeyDraft({ id: saved.id, displayName: 'Persist without token' }),
    );
    await writeGate.reached;
    profiles.clearTokens();
    writeGate.release();

    await expect(update).resolves.toMatchObject({
      id: saved.id,
      displayName: 'Persist without token',
      status: 'connected',
    });
    expect(persistedStore(fs)).toContain(
      '"displayName":"Persist without token"',
    );
    await expect(profiles.getToken(saved.id)).resolves.toBe('short-lived-jwt');
    expect(exchanges).toBe(3);
  });

  it('rebinds cached authentication when URL and credentials are replaced', async () => {
    const fs = new MemoryFileSystem();
    const authentications: Array<{
      host: string;
      endpoint: string;
      body: unknown;
    }> = [];
    const baseline = successfulFetch((url, init) => {
      if (url.pathname === '/api/auth/api-key/exchange') {
        authentications.push({
          host: url.host,
          endpoint: url.pathname,
          body: requestBody(init),
        });
      }
    });
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/auth/login') {
          authentications.push({
            host: url.host,
            endpoint: url.pathname,
            body: requestBody(init),
          });
          return Promise.resolve(
            json({
              success: true,
              token: 'replacement-jwt',
              expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
              user: { id: 'operator' },
            }),
          );
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());

    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        baseUrl: 'https://replacement.example',
        credentials: {
          authMode: 'password',
          username: 'replacement-user',
          password: 'replacement-secret',
          rememberMe: true,
        },
      }),
    );
    await expect(profiles.getToken(saved.id)).resolves.toBe('replacement-jwt');

    expect(authentications).toEqual([
      {
        host: '10.0.0.20',
        endpoint: '/api/auth/api-key/exchange',
        body: { apiKey: 'desktop-secret' },
      },
      {
        host: 'replacement.example',
        endpoint: '/api/auth/login',
        body: {
          usernameOrEmail: 'replacement-user',
          password: 'replacement-secret',
          rememberMe: true,
        },
      },
    ]);
  });

  it('accepts older omission-shaped capabilities as gated legacy fallback', async () => {
    const fetchImpl = successfulFetch();
    vi.mocked(fetchImpl).mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === '/api/system/capabilities') {
          return Promise.resolve(
            json({
              architecture: 'X64',
              slicingEnabled: true,
              modelFilesEnabled: true,
              thumbnailGenerationEnabled: true,
              gcodeUploadEnabled: true,
            }),
          );
        }
        return successfulFetch()(input, init);
      },
    );
    const tested = await service(new MemoryFileSystem(), fetchImpl).test({
      source: 'draft',
      draft: apiKeyDraft(),
    });

    expect(tested.status).toBe('legacy');
    expect(tested.capabilities).toMatchObject({
      platformNote: null,
      clientThumbnailUploadEnabled: false,
      idempotentModelUploadEnabled: false,
      modelThumbnailReplacementEnabled: false,
    });
    expect(tested.availability.modelUpload).toMatchObject({
      available: true,
      mode: 'legacyModelOnly',
    });
    expect(tested.availability.librarySync.available).toBe(false);
    expect(tested.availability.clientThumbnailUpload.available).toBe(false);
    expect(tested.availability.serverThumbnailFallback.available).toBe(true);
  });

  it('does not label non-idempotent upload as modern when capabilities are explicit', async () => {
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) =>
        requestUrl(input).pathname === '/api/system/capabilities'
          ? Promise.resolve(
              json({
                ...CAPABILITIES,
                clientThumbnailUploadEnabled: false,
                idempotentModelUploadEnabled: false,
                modelThumbnailReplacementEnabled: false,
              }),
            )
          : baseline(input, init),
    );

    const tested = await service(new MemoryFileSystem(), fetchImpl).test({
      source: 'draft',
      draft: apiKeyDraft(),
    });

    expect(tested.status).toBe('connected');
    expect(tested.availability.modelUpload.mode).toBe('legacyModelOnly');
    expect(tested.availability.librarySync.available).toBe(false);
    expect(tested.availability.clientThumbnailUpload.available).toBe(false);
    expect(tested.availability.serverThumbnailFallback.available).toBe(true);
  });

  it('keeps the deadline active while a response body stalls', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"service":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = successfulFetch();
      vi.mocked(fetchImpl).mockImplementation(
        (input: string | URL | Request, init?: RequestInit) => {
          if (requestUrl(input).pathname === '/api/system/version') {
            return Promise.resolve(new Response(stalled, { status: 200 }));
          }
          return successfulFetch()(input, init);
        },
      );
      const pending = service(new MemoryFileSystem(), fetchImpl).test({
        source: 'draft',
        draft: apiKeyDraft(),
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an unconsumed 404 response body before legacy fallback', async () => {
    let cancelled = false;
    const notFoundBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not used'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const baseline = successfulFetch();
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) =>
        requestUrl(input).pathname === '/api/system/capabilities'
          ? Promise.resolve(new Response(notFoundBody, { status: 404 }))
          : baseline(input, init),
    );

    const tested = await service(new MemoryFileSystem(), fetchImpl).test({
      source: 'draft',
      draft: apiKeyDraft(),
    });

    expect(tested.status).toBe('legacy');
    expect(cancelled).toBe(true);
  });

  it('reports rate limiting and Retry-After without parsing an error body', async () => {
    const fetchImpl = successfulFetch();
    vi.mocked(fetchImpl).mockImplementation((input: string | URL | Request) =>
      Promise.resolve(
        requestUrl(input).pathname === '/api/system/capabilities'
          ? json({ ignored: true }, 429, { 'retry-after': '12' })
          : json(VERSION),
      ),
    );

    await expect(
      service(new MemoryFileSystem(), fetchImpl).test({
        source: 'draft',
        draft: apiKeyDraft(),
      }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12,
    });
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'AUTHORIZATION_FAILED'],
    [404, 'SERVER_UNSUPPORTED'],
  ] as const)(
    'handles API-key exchange HTTP %s explicitly',
    async (status, code) => {
      let exchanges = 0;
      const fetchImpl = successfulFetch();
      vi.mocked(fetchImpl).mockImplementation(
        (input: string | URL | Request) => {
          const pathname = requestUrl(input).pathname;
          if (pathname === '/api/system/version')
            return Promise.resolve(json(VERSION));
          if (pathname === '/api/system/capabilities')
            return Promise.resolve(json(CAPABILITIES));
          if (pathname === '/api/auth/api-key/exchange') {
            exchanges += 1;
            return Promise.resolve(json({ error: 'redacted' }, status));
          }
          return Promise.resolve(json({}, 404));
        },
      );

      await expect(
        service(new MemoryFileSystem(), fetchImpl).test({
          source: 'draft',
          draft: apiKeyDraft(),
        }),
      ).rejects.toMatchObject({ code });
      expect(exchanges).toBe(1);
    },
  );

  it('requires explicit confirmation before retaining a legacy server', async () => {
    const fs = new MemoryFileSystem();
    const fetchImpl = successfulFetch();
    vi.mocked(fetchImpl).mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/system/version')
        return Promise.resolve(json(VERSION));
      if (url.pathname === '/api/system/capabilities')
        return Promise.resolve(json({}, 404));
      if (url.pathname === '/api/auth/login')
        return Promise.resolve(
          json({
            success: true,
            token: 'legacy-jwt',
            expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
            user: { id: 'operator' },
            error: null,
          }),
        );
      if (url.pathname === '/api/auth/me')
        return Promise.resolve(json({ id: 'operator' }));
      return Promise.resolve(json({}, 404));
    });
    const draft: ServerProfileDraft = {
      displayName: 'Legacy farm',
      baseUrl: 'https://legacy.example',
      credentials: {
        authMode: 'password',
        username: 'operator',
        password: 'secret',
        rememberMe: false,
      },
      allowLegacy: false,
    };
    const profiles = service(fs, fetchImpl);

    const tested = await profiles.test({ source: 'draft', draft });
    expect(tested).toMatchObject({
      status: 'legacy',
      warnings: ['legacy'],
      capabilities: null,
    });
    expect(tested.availability.librarySync.available).toBe(false);
    expect(tested.availability.modelUpload).toMatchObject({
      available: true,
      mode: 'legacyModelOnly',
    });
    expect(tested.availability.serverThumbnailFallback.available).toBe(true);
    await expect(profiles.save(draft)).rejects.toMatchObject({
      code: 'LEGACY_CONFIRMATION_REQUIRED',
    });
    await expect(
      profiles.save({ ...draft, allowLegacy: true }),
    ).resolves.toMatchObject({ status: 'legacy' });
  });

  it('does not let an older legacy save invalidate a newer retest generation', async () => {
    const fs = new MemoryFileSystem();
    const olderSaveReachedLegacyCas = deferred<void>();
    const resumeOlderLegacyCas = deferred<void>();
    let exchanges = 0;
    const baseline = successfulFetch((url) => {
      if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
    });
    let capabilityCalls = 0;
    let versionCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const endpoint = requestUrl(input).pathname;
        if (endpoint === '/api/system/capabilities') {
          capabilityCalls += 1;
          if (capabilityCalls === 2) {
            return Promise.resolve(json({}, 404));
          }
        }
        if (endpoint === '/api/system/version') {
          versionCalls += 1;
          if (versionCalls === 3) {
            return Promise.resolve(
              json({ ...VERSION, version: 'newer-retest-version' }),
            );
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(
      fs,
      fetchImpl,
      () => NOW,
      secureStorage,
      () => {
        olderSaveReachedLegacyCas.resolve();
        return resumeOlderLegacyCas.promise;
      },
    );
    const saved = await profiles.save(apiKeyDraft());

    const olderSave = profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'Older legacy save',
        allowLegacy: false,
      }),
    );
    const olderSaveResult = expect(olderSave).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await olderSaveReachedLegacyCas.promise;
    await expect(
      profiles.test({ source: 'saved', id: saved.id }),
    ).resolves.toMatchObject({
      status: 'connected',
      version: { version: 'newer-retest-version' },
    });
    resumeOlderLegacyCas.resolve();

    await olderSaveResult;
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [
        {
          id: saved.id,
          displayName: 'Farm',
          status: 'connected',
          version: { version: 'newer-retest-version' },
        },
      ],
    });
    await expect(profiles.getToken(saved.id)).resolves.toBe('short-lived-jwt');
    expect(exchanges).toBe(3);
  });

  it('reserves the no-hook legacy CAS before a queued competing mutation', async () => {
    const fs = new MemoryFileSystem();
    const finalProbeGate = deferred<Response>();
    const finalProbeReached = deferred<void>();
    const probeReturned = deferred<void>();
    const competitorStarted = deferred<void>();
    const baseline = successfulFetch();
    let capabilityCalls = 0;
    let currentUserCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const endpoint = requestUrl(input).pathname;
        if (endpoint === '/api/system/capabilities') {
          capabilityCalls += 1;
          if (capabilityCalls === 2) {
            return Promise.resolve(json({}, 404));
          }
        }
        if (endpoint === '/api/auth/me') {
          currentUserCalls += 1;
          if (currentUserCalls === 2) {
            finalProbeReached.resolve();
            return finalProbeGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    let raceEnabled = false;
    let savedId = '';
    let competingDelete: ReturnType<ServerProfileService['delete']> | null =
      null;
    const profiles = service(
      fs,
      fetchImpl,
      () => NOW,
      secureStorage,
      undefined,
      () => {
        if (!raceEnabled) return;
        probeReturned.resolve();
        queueMicrotask(() => {
          competingDelete = profiles.delete(savedId);
          competitorStarted.resolve();
        });
      },
    );
    const saved = await profiles.save(apiKeyDraft());
    savedId = saved.id;
    raceEnabled = true;

    const olderSave = profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'No-hook legacy',
        allowLegacy: false,
      }),
    );
    const olderResult = expect(olderSave).rejects.toMatchObject({
      code: 'LEGACY_CONFIRMATION_REQUIRED',
    });
    await finalProbeReached.promise;
    finalProbeGate.resolve(json({ id: 'operator' }));
    await probeReturned.promise;
    await competitorStarted.promise;

    await olderResult;
    await expect(competingDelete).resolves.toEqual({
      profiles: [],
      selectedProfileId: null,
    });
  });

  it('persists error status when a saved-profile retest rejects', async () => {
    const fs = new MemoryFileSystem();
    let failRetest = false;
    let exchanges = 0;
    const baseline = successfulFetch((url) => {
      if (url.pathname === '/api/auth/api-key/exchange') exchanges += 1;
    });
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (
          failRetest &&
          requestUrl(input).pathname === '/api/system/capabilities'
        ) {
          return Promise.resolve(json({}, 503));
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());
    failRetest = true;

    await expect(
      profiles.test({ source: 'saved', id: saved.id }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [{ id: saved.id, status: 'error' }],
    });
    failRetest = false;
    await profiles.getToken(saved.id);
    expect(exchanges).toBe(2);
  });

  it('does not resurrect a profile deleted during a gated retest', async () => {
    const fs = new MemoryFileSystem();
    const capabilityGate = deferred<Response>();
    const retestReachedNetwork = deferred<void>();
    const baseline = successfulFetch();
    let capabilityCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/system/capabilities') {
          capabilityCalls += 1;
          if (capabilityCalls === 2) {
            retestReachedNetwork.resolve();
            return capabilityGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());

    const retest = profiles.test({ source: 'saved', id: saved.id });
    const retestResult = expect(retest).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await retestReachedNetwork.promise;
    await profiles.delete(saved.id);
    capabilityGate.resolve(json(CAPABILITIES));

    await retestResult;
    await expect(profiles.list()).resolves.toEqual({
      profiles: [],
      selectedProfileId: null,
    });
    expect(persistedStore(fs)).not.toContain('encryptedSecret');
  });

  it('does not overwrite a profile updated during a gated retest', async () => {
    const fs = new MemoryFileSystem();
    const capabilityGate = deferred<Response>();
    const retestReachedNetwork = deferred<void>();
    const baseline = successfulFetch();
    let capabilityCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/system/capabilities') {
          capabilityCalls += 1;
          if (capabilityCalls === 2) {
            retestReachedNetwork.resolve();
            return capabilityGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl);
    const saved = await profiles.save(apiKeyDraft());
    const originalEncryptedSecret = encryptedBlob(persistedStore(fs));

    const retest = profiles.test({ source: 'saved', id: saved.id });
    const retestResult = expect(retest).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await retestReachedNetwork.promise;
    await profiles.save(
      apiKeyDraft({
        id: saved.id,
        displayName: 'Replacement farm',
        baseUrl: 'https://replacement.example',
        credentials: { authMode: 'apiKey', apiKey: 'replacement-key' },
      }),
    );
    const replacementEncryptedSecret = encryptedBlob(persistedStore(fs));
    capabilityGate.resolve(json(CAPABILITIES));

    await retestResult;
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [
        {
          id: saved.id,
          displayName: 'Replacement farm',
          baseUrl: 'https://replacement.example',
          status: 'connected',
        },
      ],
    });
    expect(replacementEncryptedSecret).not.toBe(originalEncryptedSecret);
    expect(encryptedBlob(persistedStore(fs))).toBe(replacementEncryptedSecret);
  });

  it.each([
    ['safeStorage unavailable', 'ENCRYPTION_UNAVAILABLE'],
    ['decryption failure', 'CORRUPT_STORE'],
  ] as const)(
    'persists error status after guarded %s',
    async (failure, expectedCode) => {
      const fs = new MemoryFileSystem();
      let vaultFails = false;
      const fetchImpl = successfulFetch();
      const storage: SecretStorage = {
        ...secureStorage,
        isEncryptionAvailable: () =>
          failure === 'safeStorage unavailable' ? !vaultFails : true,
        decryptString: (value) => {
          if (failure === 'decryption failure' && vaultFails) {
            throw new Error('vault internals must be scrubbed');
          }
          return secureStorage.decryptString(value);
        },
      };
      const profiles = service(fs, fetchImpl, () => NOW, storage);
      const saved = await profiles.save(apiKeyDraft());
      const requestsBeforeRetest = vi.mocked(fetchImpl).mock.calls.length;
      vaultFails = true;

      const retest = profiles.test({ source: 'saved', id: saved.id });
      await expect(retest).rejects.toMatchObject({ code: expectedCode });
      await expect(retest).rejects.not.toThrow(/vault internals/);
      await expect(profiles.list()).resolves.toMatchObject({
        profiles: [{ id: saved.id, status: 'error' }],
      });
      expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(
        requestsBeforeRetest,
      );
    },
  );

  it('vault failure supersedes an older stalled retest', async () => {
    const fs = new MemoryFileSystem();
    let vaultFails = false;
    const storage: SecretStorage = {
      ...secureStorage,
      decryptString: (value) => {
        if (vaultFails) throw new Error('vault unavailable');
        return secureStorage.decryptString(value);
      },
    };
    const olderVersionGate = deferred<Response>();
    const olderRetestReached = deferred<void>();
    const baseline = successfulFetch();
    let versionCalls = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/system/version') {
          versionCalls += 1;
          if (versionCalls === 2) {
            olderRetestReached.resolve();
            return olderVersionGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => NOW, storage);
    const saved = await profiles.save(apiKeyDraft());

    const olderRetest = profiles.test({ source: 'saved', id: saved.id });
    const olderResult = expect(olderRetest).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await olderRetestReached.promise;
    vaultFails = true;
    await expect(
      profiles.test({ source: 'saved', id: saved.id }),
    ).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
    vaultFails = false;
    olderVersionGate.resolve(json({ ...VERSION, version: 'must-not-commit' }));

    await olderResult;
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [{ id: saved.id, status: 'error' }],
    });
    expect(persistedStore(fs)).not.toContain('must-not-commit');
  });

  it('vault failure supersedes an older token renewal', async () => {
    const fs = new MemoryFileSystem();
    let currentTime = NOW;
    let vaultFails = false;
    const storage: SecretStorage = {
      ...secureStorage,
      decryptString: (value) => {
        if (vaultFails) throw new Error('vault unavailable');
        return secureStorage.decryptString(value);
      },
    };
    const renewalGate = deferred<Response>();
    const renewalReached = deferred<void>();
    const baseline = successfulFetch();
    let exchanges = 0;
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).pathname === '/api/auth/api-key/exchange') {
          exchanges += 1;
          if (exchanges === 2) {
            renewalReached.resolve();
            return renewalGate.promise;
          }
        }
        return baseline(input, init);
      },
    );
    const profiles = service(fs, fetchImpl, () => currentTime, storage);
    const saved = await profiles.save(apiKeyDraft());
    currentTime += 14 * 60_000 + 1;

    const renewal = profiles.getToken(saved.id);
    const renewalResult = expect(renewal).rejects.toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
    });
    await renewalReached.promise;
    vaultFails = true;
    await expect(
      profiles.test({ source: 'saved', id: saved.id }),
    ).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
    vaultFails = false;
    renewalGate.resolve(
      json({
        token: 'must-not-return',
        expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
        scopes: ['ModelRead', 'ModelWrite', 'LibrarySync'],
      }),
    );

    await renewalResult;
    await expect(profiles.list()).resolves.toMatchObject({
      profiles: [{ id: saved.id, status: 'error' }],
    });
  });

  it('rejects malformed capabilities and corrupt stores explicitly', async () => {
    const malformed = successfulFetch();
    vi.mocked(malformed).mockImplementation((input: string | URL | Request) =>
      Promise.resolve(
        requestUrl(input).pathname === '/api/system/capabilities'
          ? json({ architecture: 'missing-fields' })
          : json(VERSION),
      ),
    );
    await expect(
      service(new MemoryFileSystem(), malformed).test({
        source: 'draft',
        draft: apiKeyDraft(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const fs = new MemoryFileSystem();
    fs.files.set(
      path.join(TEST_USER_DATA_PATH, 'server-profiles.v1.json'),
      new TextEncoder().encode('{"version":999}'),
    );
    await expect(service(fs).list()).rejects.toMatchObject({
      code: 'CORRUPT_STORE',
    });
  });
});
