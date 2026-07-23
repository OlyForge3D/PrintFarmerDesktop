import { describe, expect, it, vi } from 'vitest';
import {
  ServerProfileError,
  ServerProfileService,
  normalizeServerUrl,
  type ProfileFileSystem,
  type SecretStorage,
} from '../src/main/serverProfiles.js';
import type { ServerProfileDraft } from '@shared/ipc';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const VERSION = {
  service: 'Farm.Web.Api',
  version: '0.2.2',
  commit: '63b0053f2',
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
  platformNote: null,
  operatorFeatures: { queue: true },
};

class MemoryFileSystem implements ProfileFileSystem {
  readonly files = new Map<string, Uint8Array>();
  renames = 0;

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
    switch (url.pathname) {
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

function service(
  fileSystem: MemoryFileSystem,
  fetchImpl = successfulFetch(),
  now: () => number = () => NOW,
  storage: SecretStorage = secureStorage,
): ServerProfileService {
  let id = 0;
  return new ServerProfileService({
    userDataPath: 'C:\\profile-test',
    fileSystem,
    secretStorage: storage,
    fetch: fetchImpl,
    now,
    createId: () =>
      id++ === 0
        ? '11111111-1111-4111-8111-111111111111'
        : `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`,
  });
}

describe('server profiles', () => {
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
    expect(listed.profiles).toEqual([saved]);
    expect(JSON.stringify(listed)).not.toContain('encryptedSecret');
    expect(persisted).not.toContain('desktop-secret');
    expect(persisted).not.toContain('short-lived-jwt');
    expect(calls).toContain('/api/auth/me');
    expect(fs.renames).toBeGreaterThan(0);
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

  it('performs password login without exposing or persisting the password', async () => {
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
              error: null,
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
    expect(await profiles.getToken(saved.id)).toBe('short-lived-jwt');
    expect(exchanges).toBe(2);
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
    expect(tested.availability.librarySync.reason).toContain('legacy');
    await expect(profiles.save(draft)).rejects.toMatchObject({
      code: 'LEGACY_CONFIRMATION_REQUIRED',
    });
    await expect(
      profiles.save({ ...draft, allowLegacy: true }),
    ).resolves.toMatchObject({ status: 'legacy' });
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
      'C:\\profile-test\\server-profiles.v1.json',
      new TextEncoder().encode('{"version":999}'),
    );
    await expect(service(fs).list()).rejects.toMatchObject({
      code: 'CORRUPT_STORE',
    });
  });
});
