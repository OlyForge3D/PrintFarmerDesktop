// @vitest-environment node

/**
 * Credential-leak checks for the server-profile credential store
 * (`src/main/serverProfiles.ts`) — #21 slice 4.
 *
 * This file drives the REAL `ServerProfileService`, doubling only its injected
 * seams (`ProfileFileSystem`, `SecretStorage`, `fetch`). The `SecretStorage`
 * double is a genuine byte transform (XOR-42), not identity, so a plaintext
 * secret truly does not survive into the ciphertext — an identity double would
 * make every "not.toContain(secret)" assertion below pass vacuously.
 *
 * What it adds over the existing suites, rather than duplicating them:
 *   - `serverProfiles.test.ts` proves the *on-disk* store omits the apiKey and
 *     JWT (`:321`, `:322`) and that redaction drops the `encryptedSecret` key
 *     (`:320`). It does not scan the renderer-facing *responses* for the secret
 *     *values*, nor the log/error surfaces at all.
 *   - `security.test.ts` / `mainWindow.security.test.ts` prove renderer
 *     isolation and CSP `connect-src 'self'`; they are the exfil half.
 * The gap this file closes is the three credential *sinks* Ripley named that no
 * test exercised: the IPC response payload (by secret value, both redaction
 * layers), process logs, and thrown-error messages/stacks.
 *
 * Every block names the source mutation that turns it RED, so its
 * non-vacuity is reproducible:
 *   - responses / schema  -> serverProfiles.ts:1679 return `redacted` instead
 *     of `ServerProfile.parse(redacted)` (the strip is the real backstop; the
 *     `delete` lines at :1674-1678 are belt-and-suspenders the schema repeats).
 *   - logs                -> add `console.error(secret)` on any credential path.
 *   - errors              -> interpolate `${draft.credentials.apiKey}` into a
 *     `ServerProfileError` message.
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ipcSchemas, IpcChannel } from '@shared/ipc';
import {
  ServerProfileError,
  ServerProfileService,
  type ProfileFileSystem,
  type SecretStorage,
} from '../src/main/serverProfiles.js';
import type { ServerProfileDraft } from '@shared/ipc';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const USER_DATA_PATH = path.join(process.cwd(), 'credential-leak-test-data');

/** The renderer-supplied API key. Must never leave the main process. */
const API_SECRET = 'desktop-secret';
/** The JWT the server mints in exchange for the key. Also main-process-only. */
const ISSUED_JWT = 'short-lived-jwt';
/** A password-mode secret, for the second credential shape. */
const ACCOUNT_PASSWORD = 'operator-password-9f3';

/**
 * Substrings that constitute a leak if found on a renderer/log/error surface.
 * `encryptedSecret` is the *field name*: its presence means the ciphertext rode
 * along, which is a leak even though the ciphertext is not the plaintext.
 */
const FORBIDDEN = [API_SECRET, ISSUED_JWT, ACCOUNT_PASSWORD, 'encryptedSecret'];

/** Every forbidden token found in `value` once serialized. Empty == clean. */
function leaks(value: unknown): string[] {
  const serialized =
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return FORBIDDEN.filter((token) => serialized.includes(token));
}

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

/** A real reversible transform, so plaintext is genuinely absent from output. */
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

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

/** A fetch that authenticates an apiKey draft and mints {@link ISSUED_JWT}. */
function successfulFetch(): typeof globalThis.fetch {
  return vi.fn((input: string | URL | Request) => {
    switch (requestUrl(input).pathname) {
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

/**
 * A fetch that mints a token missing the required scopes, driving the
 * `AUTHORIZATION_FAILED` throw in `issueToken` (serverProfiles.ts:1207) — a
 * failure path where the plaintext secret is in scope at the throw site.
 */
function insufficientScopeFetch(): typeof globalThis.fetch {
  return vi.fn((input: string | URL | Request) => {
    switch (requestUrl(input).pathname) {
      case '/api/system/version':
        return Promise.resolve(json(VERSION));
      case '/api/system/capabilities':
        return Promise.resolve(json(CAPABILITIES));
      case '/api/auth/api-key/exchange':
        return Promise.resolve(
          json({
            token: ISSUED_JWT,
            expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
            scopes: [],
          }),
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

function service(
  fileSystem: MemoryFileSystem,
  fetchImpl: typeof globalThis.fetch = successfulFetch(),
  storage: SecretStorage = xorStorage,
): ServerProfileService {
  let id = 0;
  return new ServerProfileService({
    userDataPath: USER_DATA_PATH,
    fileSystem,
    secretStorage: storage,
    fetch: fetchImpl,
    now: () => NOW,
    createId: () =>
      id++ === 0
        ? '11111111-1111-4111-8111-111111111111'
        : `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`,
  });
}

function persistedStore(fileSystem: MemoryFileSystem): string {
  const value = fileSystem.files.get(
    path.join(USER_DATA_PATH, 'server-profiles.v1.json'),
  );
  if (!value) throw new Error('expected a persisted profile store');
  return new TextDecoder().decode(value);
}

describe('credential-leak: renderer-facing IPC responses', () => {
  it('returns no secret material from save/list/select/test', async () => {
    const fs = new MemoryFileSystem();
    const profiles = service(fs);

    const saved = await profiles.save(apiKeyDraft());
    const listed = await profiles.list();
    const selected = await profiles.select(saved.id);
    const tested = await profiles.test({
      source: 'draft',
      draft: apiKeyDraft({ id: saved.id }),
    });

    // The ciphertext actually written for this profile: it too must not appear
    // in anything handed to the renderer.
    const ciphertext = /"encryptedSecret":"([^"]+)"/.exec(
      persistedStore(fs),
    )?.[1];
    expect(
      ciphertext,
      'expected a persisted ciphertext to scan for',
    ).toBeTruthy();

    for (const [label, payload] of [
      ['save', saved],
      ['list', listed],
      ['select', selected],
      ['test', tested],
    ] as const) {
      expect(leaks(payload), `${label} response leaked a secret`).toEqual([]);
      expect(
        JSON.stringify(payload).includes(ciphertext!),
        `${label} response carried the raw ciphertext`,
      ).toBe(false);
    }
  });

  it('still returns the legitimate profile fields (probe E)', async () => {
    // The admitting direction. A redactor that stripped everything would pass
    // every assertion above while making the profile list useless; this fails
    // it. `baseUrl` is the normalized form, proving a real profile round-tripped
    // rather than an empty husk.
    const profiles = service(new MemoryFileSystem());
    const saved = await profiles.save(apiKeyDraft());

    expect(saved).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Farm',
      baseUrl: 'http://10.0.0.20',
      authMode: 'apiKey',
      status: 'connected',
    });
    const listed = await profiles.list();
    expect(listed.profiles).toEqual([saved]);
    expect(listed.selectedProfileId).toBe(saved.id);
  });

  it('rejects a secret-bearing profile at the shared response schema (fail-closed backstop)', async () => {
    // The second redaction layer, independent of the service. Every server-
    // profile IPC handler returns `ipcSchemas[channel].response.parse(...)`
    // (ipc.ts:766/775/785/796/808). Those response schemas are STRICT: a secret
    // the service failed to drop is not silently stripped — the parse throws and
    // the IPC call rejects, rather than handing the renderer a secret. This is a
    // stronger posture than stripping, and this test pins it: switching the
    // schema to `.passthrough()` (or `.strip()`) turns the hostile-direction
    // assertions RED.
    const profiles = service(new MemoryFileSystem());
    const saved = await profiles.save(apiKeyDraft());
    const singleChannels = [
      IpcChannel.SaveServerProfile,
      IpcChannel.SelectServerProfile,
      IpcChannel.TestServerProfile,
    ] as const;

    // Probe E / admitting direction: the legitimate redacted profile passes the
    // response schema untouched. A schema that rejected everything fails here.
    for (const channel of singleChannels) {
      expect(ipcSchemas[channel].response.parse(saved)).toEqual(saved);
    }
    const listResponse = { profiles: [saved], selectedProfileId: saved.id };
    expect(
      ipcSchemas[IpcChannel.ListServerProfiles].response.parse(listResponse),
    ).toEqual(listResponse);

    // Hostile direction: any secret-bearing key is refused outright.
    const poisoned = {
      ...saved,
      encryptedSecret: 'ciphertext',
      apiKey: API_SECRET,
    };
    for (const channel of singleChannels) {
      expect(
        () => ipcSchemas[channel].response.parse(poisoned),
        `${channel} response schema admitted a secret-bearing profile`,
      ).toThrow();
    }
    expect(() =>
      ipcSchemas[IpcChannel.ListServerProfiles].response.parse({
        profiles: [poisoned],
        selectedProfileId: saved.id,
      }),
    ).toThrow();
  });
});

describe('credential-leak: process logs', () => {
  it('writes no secret to any console channel across a credential lifecycle', async () => {
    const captured: string[] = [];
    const record =
      () =>
      (...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      };
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (channel) => vi.spyOn(console, channel).mockImplementation(record()),
    );

    try {
      // Reachability guard: prove the spies actually capture, so an empty
      // buffer below means "nothing was logged", not "the spy was never wired".
      console.info('__credential_leak_spy_live__');

      const fs = new MemoryFileSystem();
      const profiles = service(fs);
      const saved = await profiles.save(apiKeyDraft());
      await profiles.test({
        source: 'draft',
        draft: apiKeyDraft({ id: saved.id }),
      });
      const token = await profiles.getToken(saved.id);
      // The token retrieval genuinely returns the JWT to its main-process
      // caller; the property under test is that returning it did not also log it.
      expect(token).toBe(ISSUED_JWT);
      await profiles.delete(saved.id);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(
      captured.some((line) => line.includes('__credential_leak_spy_live__')),
      'console spies were not capturing — the leak scan would be vacuous',
    ).toBe(true);
    const offenders = captured.filter((line) => leaks(line).length > 0);
    expect(offenders, 'a secret reached the console').toEqual([]);
  });
});

describe('credential-leak: thrown error surfaces', () => {
  it('omits the secret when persistence fails closed without OS encryption', async () => {
    const profiles = service(new MemoryFileSystem(), successfulFetch(), {
      ...xorStorage,
      isEncryptionAvailable: () => false,
    });

    const error = await profiles.save(apiKeyDraft()).then(
      () => {
        throw new Error('expected save to reject without encryption');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ServerProfileError);
    expect((error as ServerProfileError).code).toBe('ENCRYPTION_UNAVAILABLE');
    expect(leaks((error as Error).message)).toEqual([]);
    expect(leaks((error as Error).stack ?? '')).toEqual([]);
    expect(leaks(error)).toEqual([]);
  });

  it('omits the secret when the api-key is refused for insufficient scopes', async () => {
    const profiles = service(new MemoryFileSystem(), insufficientScopeFetch());

    const error = await profiles.save(apiKeyDraft()).then(
      () => {
        throw new Error('expected save to reject on an under-scoped key');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ServerProfileError);
    expect(leaks((error as Error).message)).toEqual([]);
    expect(leaks((error as Error).stack ?? '')).toEqual([]);
    expect(leaks(error)).toEqual([]);
  });
});
