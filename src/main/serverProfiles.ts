import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FeatureAvailability,
  ServerCapabilities,
  ServerProfile,
  ServerVersion,
  type ListServerProfilesResponse,
  type ServerProfile as RedactedProfile,
  type ServerProfileDraft,
  type TestServerProfileRequest,
} from '@shared/ipc';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_SKEW_MS = 60_000;
const REQUIRED_SCOPES = ['ModelRead', 'ModelWrite', 'LibrarySync'] as const;

const StoredProfile = ServerProfile.extend({
  encryptedSecret: z.string().min(1).max(32_768),
}).strict();

const ProfileStore = z
  .object({
    version: z.literal(STORE_VERSION),
    selectedProfileId: z.string().uuid().nullable(),
    profiles: z.array(StoredProfile).max(100),
  })
  .strict();

type StoredProfile = z.infer<typeof StoredProfile>;
type ProfileStore = z.infer<typeof ProfileStore>;

const StoredSecret = z.discriminatedUnion('authMode', [
  z
    .object({
      authMode: z.literal('apiKey'),
      apiKey: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      authMode: z.literal('password'),
      username: z.string().min(1).max(256),
      password: z.string().min(1).max(4096),
      rememberMe: z.boolean(),
    })
    .strict(),
]);
type StoredSecret = z.infer<typeof StoredSecret>;

const TokenResponse = z
  .object({
    token: z.string().min(1).max(16_384),
    expiresAt: z.string().datetime(),
    scopes: z.array(z.string().min(1).max(128)).max(100),
  })
  .strict();

const LoginResponse = z
  .object({
    success: z.boolean(),
    token: z.string().min(1).max(16_384).nullable(),
    expiresAt: z.string().datetime().nullable(),
    user: z.record(z.unknown()).nullable(),
    error: z.string().max(1024).nullable(),
  })
  .strict();

export interface ProfileFileSystem {
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
  getSelectedStorageBackend?(): string;
}

export interface ServerProfileDependencies {
  userDataPath: string;
  fileSystem?: ProfileFileSystem;
  secretStorage: SecretStorage;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  createId?: () => string;
}

export type ProfileErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'CERTIFICATE_ERROR'
  | 'CORRUPT_STORE'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'LEGACY_CONFIRMATION_REQUIRED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_UNSUPPORTED'
  | 'TIMEOUT'
  | 'TRANSPORT_ERROR'
  | 'VALIDATION_ERROR';

export class ServerProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ServerProfileError';
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const nodeFileSystem: ProfileFileSystem = {
  readFile: (filePath) => nodeFs.readFile(filePath),
  writeFile: (filePath, data) => nodeFs.writeFile(filePath, data, 'utf8'),
  rename: (from, to) => nodeFs.rename(from, to),
  mkdir: (directory) =>
    nodeFs.mkdir(directory, { recursive: true }).then(() => undefined),
  unlink: (filePath) => nodeFs.unlink(filePath),
};

export function normalizeServerUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ServerProfileError(
      'VALIDATION_ERROR',
      'Enter a valid HTTP or HTTPS server URL.',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ServerProfileError(
      'VALIDATION_ERROR',
      'Server URLs must use HTTP or HTTPS and cannot include credentials, a query, or a fragment.',
    );
  }
  parsed.pathname =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export class ServerProfileService {
  private readonly fileSystem: ProfileFileSystem;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly storePath: string;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly dependencies: ServerProfileDependencies) {
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? randomUUID;
    this.storePath = path.join(
      dependencies.userDataPath,
      'server-profiles.v1.json',
    );
  }

  clearTokens(): void {
    this.tokens.clear();
  }

  async list(): Promise<ListServerProfilesResponse> {
    const store = await this.readStore();
    return this.redactStore(store);
  }

  async test(request: TestServerProfileRequest): Promise<RedactedProfile> {
    if (request.source === 'draft') {
      const draft = request.draft;
      const id = draft.id ?? this.createId();
      try {
        return await this.probe(
          id,
          draft.displayName,
          draft.baseUrl,
          this.secretFromDraft(draft),
        );
      } finally {
        this.tokens.delete(id);
      }
    }

    const store = await this.readStore();
    const index = store.profiles.findIndex(
      (profile) => profile.id === request.id,
    );
    if (index < 0) {
      throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
    }
    const stored = store.profiles[index]!;
    const secret = this.decryptSecret(stored.encryptedSecret);
    try {
      const tested = await this.probe(
        stored.id,
        stored.displayName,
        stored.baseUrl,
        secret,
      );
      store.profiles[index] = {
        ...tested,
        encryptedSecret: stored.encryptedSecret,
      };
      await this.writeStore(store);
      return tested;
    } catch (error) {
      store.profiles[index] = {
        ...stored,
        status: 'error',
        lastCheckedAt: new Date(this.now()).toISOString(),
      };
      await this.writeStore(store);
      throw error;
    }
  }

  async save(draft: ServerProfileDraft): Promise<RedactedProfile> {
    this.requireEncryption();
    const secret = this.secretFromDraft(draft);
    const id = draft.id ?? this.createId();
    const tested = await this.probe(
      id,
      draft.displayName,
      draft.baseUrl,
      secret,
    );
    if (tested.status === 'legacy' && !draft.allowLegacy) {
      this.tokens.delete(id);
      throw new ServerProfileError(
        'LEGACY_CONFIRMATION_REQUIRED',
        'This server does not publish desktop capabilities. Confirm legacy mode before saving it.',
      );
    }

    const encryptedSecret = Buffer.from(
      this.dependencies.secretStorage.encryptString(JSON.stringify(secret)),
    ).toString('base64');
    const store = await this.readStore();
    const index = store.profiles.findIndex((profile) => profile.id === id);
    const stored: StoredProfile = { ...tested, encryptedSecret };
    if (index < 0) {
      store.profiles.push(stored);
    } else {
      store.profiles[index] = stored;
    }
    store.selectedProfileId ??= id;
    await this.writeStore(store);
    return tested;
  }

  async select(id: string): Promise<RedactedProfile> {
    const store = await this.readStore();
    const profile = store.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
    }
    store.selectedProfileId = id;
    await this.writeStore(store);
    return this.redact(profile);
  }

  async delete(id: string): Promise<ListServerProfilesResponse> {
    const store = await this.readStore();
    const index = store.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) {
      throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
    }
    store.profiles.splice(index, 1);
    this.tokens.delete(id);
    if (store.selectedProfileId === id) {
      store.selectedProfileId = store.profiles[0]?.id ?? null;
    }
    await this.writeStore(store);
    return this.redactStore(store);
  }

  async getToken(id: string): Promise<string> {
    const cached = this.tokens.get(id);
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > this.now()) {
      return cached.token;
    }
    const store = await this.readStore();
    const profile = store.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
    }
    const secret = this.decryptSecret(profile.encryptedSecret);
    return this.authenticate(profile.baseUrl, secret, id);
  }

  private async probe(
    id: string,
    displayName: string,
    rawBaseUrl: string,
    secret: StoredSecret,
  ): Promise<RedactedProfile> {
    const baseUrl = normalizeServerUrl(rawBaseUrl);
    const [versionResult, capabilitiesResult] = await Promise.all([
      this.getAnonymous(baseUrl, '/api/system/version', ServerVersion),
      this.getAnonymous(
        baseUrl,
        '/api/system/capabilities',
        ServerCapabilities,
      ),
    ]);
    const legacy = versionResult === null || capabilitiesResult === null;
    await this.authenticate(baseUrl, secret, id);

    const availability = availabilityFor(capabilitiesResult, legacy);
    return ServerProfile.parse({
      id,
      displayName: displayName.trim(),
      baseUrl,
      authMode: secret.authMode,
      ...(secret.authMode === 'password' ? { username: secret.username } : {}),
      version: versionResult,
      capabilities: capabilitiesResult,
      availability,
      status: legacy ? 'legacy' : 'connected',
      lastCheckedAt: new Date(this.now()).toISOString(),
      warnings: [
        ...(baseUrl.startsWith('http:') ? (['insecureHttp'] as const) : []),
        ...(legacy ? (['legacy'] as const) : []),
      ],
    });
  }

  private async getAnonymous<T>(
    baseUrl: string,
    endpoint: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const response = await this.request(
      baseUrl,
      endpoint,
      { method: 'GET' },
      true,
    );
    if (response === null) {
      return null;
    }
    return this.parseJson(response, schema);
  }

  private async authenticate(
    baseUrl: string,
    secret: StoredSecret,
    cacheId: string,
  ): Promise<string> {
    const cached = this.tokens.get(cacheId);
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > this.now()) {
      return cached.token;
    }

    let token: string;
    let expiresAt: string;
    if (secret.authMode === 'apiKey') {
      const response = await this.request(
        baseUrl,
        '/api/auth/api-key/exchange',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: secret.apiKey }),
        },
      );
      if (response === null) {
        throw new ServerProfileError(
          'SERVER_UNSUPPORTED',
          'This server does not support Desktop API keys.',
        );
      }
      const exchange = await this.parseJson(response, TokenResponse);
      const missing = REQUIRED_SCOPES.filter(
        (scope) => !exchange.scopes.includes(scope),
      );
      if (missing.length > 0) {
        throw new ServerProfileError(
          'AUTHORIZATION_FAILED',
          `The Desktop API key is missing required scopes: ${missing.join(', ')}.`,
        );
      }
      token = exchange.token;
      expiresAt = exchange.expiresAt;
    } else {
      const response = await this.request(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          usernameOrEmail: secret.username,
          password: secret.password,
          rememberMe: secret.rememberMe,
        }),
      });
      if (response === null) {
        throw new ServerProfileError(
          'SERVER_UNSUPPORTED',
          'This server does not support password login.',
        );
      }
      const login = await this.parseJson(response, LoginResponse);
      if (!login.success || !login.token || !login.expiresAt) {
        throw new ServerProfileError(
          'AUTHENTICATION_FAILED',
          'The username or password was not accepted.',
        );
      }
      token = login.token;
      expiresAt = login.expiresAt;
    }

    const expiration = Date.parse(expiresAt);
    if (!Number.isFinite(expiration) || expiration <= this.now()) {
      throw new ServerProfileError(
        'AUTHENTICATION_FAILED',
        'The server returned an expired authentication token.',
      );
    }
    const me = await this.request(baseUrl, '/api/auth/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (me === null) {
      throw new ServerProfileError(
        'SERVER_UNSUPPORTED',
        'This server does not provide the current-user endpoint.',
      );
    }
    await this.parseJson(me, z.record(z.unknown()));
    this.tokens.set(cacheId, { token, expiresAt: expiration });
    return token;
  }

  private async request(
    baseUrl: string,
    endpoint: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${endpoint}`, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ServerProfileError(
          'TIMEOUT',
          'The server did not respond before the connection timed out.',
        );
      }
      const cause =
        error instanceof Error && 'cause' in error
          ? String((error as Error & { cause?: { code?: string } }).cause?.code)
          : '';
      if (/CERT|TLS|SSL/i.test(cause)) {
        throw new ServerProfileError(
          'CERTIFICATE_ERROR',
          'The HTTPS certificate could not be verified. Certificate validation was not bypassed.',
        );
      }
      throw new ServerProfileError(
        'TRANSPORT_ERROR',
        'Could not connect to the PrintFarmer server.',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 404 && allowNotFound) {
      return null;
    }
    if (response.status === 401) {
      throw new ServerProfileError(
        'AUTHENTICATION_FAILED',
        'The server rejected the supplied credentials.',
      );
    }
    if (response.status === 403) {
      throw new ServerProfileError(
        'AUTHORIZATION_FAILED',
        'The credentials do not permit this Desktop operation.',
      );
    }
    if (response.status === 404) {
      return null;
    }
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(
        response.headers.get('retry-after'),
        this.now(),
      );
      throw new ServerProfileError(
        'RATE_LIMITED',
        retryAfterSeconds === null
          ? 'The server is rate limiting requests. Try again later.'
          : `The server is rate limiting requests. Try again in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      );
    }
    if (!response.ok) {
      throw new ServerProfileError(
        'TRANSPORT_ERROR',
        `The server returned HTTP ${response.status}.`,
      );
    }
    return response;
  }

  private async parseJson<T>(
    response: Response,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ServerProfileError(
        'VALIDATION_ERROR',
        'The server returned malformed JSON.',
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ServerProfileError(
        'VALIDATION_ERROR',
        'The server response did not match the expected PrintFarmer contract.',
      );
    }
    return result.data;
  }

  private secretFromDraft(draft: ServerProfileDraft): StoredSecret {
    return StoredSecret.parse(
      draft.credentials.authMode === 'apiKey'
        ? {
            authMode: 'apiKey',
            apiKey: draft.credentials.apiKey,
          }
        : {
            authMode: 'password',
            username: draft.credentials.username,
            password: draft.credentials.password,
            rememberMe: draft.credentials.rememberMe,
          },
    );
  }

  private requireEncryption(): void {
    if (
      !this.dependencies.secretStorage.isEncryptionAvailable() ||
      this.dependencies.secretStorage.getSelectedStorageBackend?.() ===
        'basic_text'
    ) {
      throw new ServerProfileError(
        'ENCRYPTION_UNAVAILABLE',
        'Secure OS credential storage is unavailable. The profile was not saved.',
      );
    }
  }

  private decryptSecret(encrypted: string): StoredSecret {
    this.requireEncryption();
    try {
      const plain = this.dependencies.secretStorage.decryptString(
        Buffer.from(encrypted, 'base64'),
      );
      return StoredSecret.parse(JSON.parse(plain));
    } catch {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'A saved server credential could not be decrypted or validated.',
      );
    }
  }

  private async readStore(): Promise<ProfileStore> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fileSystem.readFile(this.storePath);
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          version: STORE_VERSION,
          selectedProfileId: null,
          profiles: [],
        };
      }
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'The server profile store could not be read.',
      );
    }
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'The server profile store exceeds its size limit.',
      );
    }
    try {
      const store = ProfileStore.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (
        store.selectedProfileId !== null &&
        !store.profiles.some(
          (profile) => profile.id === store.selectedProfileId,
        )
      ) {
        throw new Error('selected profile is missing');
      }
      return store;
    } catch {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'The server profile store is corrupt or uses an unsupported version.',
      );
    }
  }

  private async writeStore(store: ProfileStore): Promise<void> {
    const validated = ProfileStore.parse(store);
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      throw new ServerProfileError(
        'VALIDATION_ERROR',
        'The server profile store exceeds its size limit.',
      );
    }
    await this.fileSystem.mkdir(path.dirname(this.storePath));
    const temporary = `${this.storePath}.${this.createId()}.tmp`;
    try {
      await this.fileSystem.writeFile(temporary, serialized);
      await this.fileSystem.rename(temporary, this.storePath);
    } catch (error) {
      try {
        await this.fileSystem.unlink(temporary);
      } catch {
        // Best-effort cleanup; preserve the original atomic-write failure.
      }
      throw error;
    }
  }

  private redact(profile: StoredProfile): RedactedProfile {
    const redacted: Partial<StoredProfile> = { ...profile };
    delete redacted.encryptedSecret;
    return ServerProfile.parse(redacted);
  }

  private redactStore(store: ProfileStore): ListServerProfilesResponse {
    return {
      profiles: store.profiles.map((profile) => this.redact(profile)),
      selectedProfileId: store.selectedProfileId,
    };
  }
}

function availabilityFor(
  capabilities: z.infer<typeof ServerCapabilities> | null,
  legacy: boolean,
): z.infer<typeof FeatureAvailability> {
  if (legacy || !capabilities) {
    const reason =
      'Unavailable because this legacy server does not publish capabilities.';
    return {
      modelUpload: { available: false, reason },
      librarySync: { available: false, reason },
      clientThumbnailUpload: { available: false, reason },
    };
  }
  return {
    modelUpload: {
      available: capabilities.modelFilesEnabled,
      reason: capabilities.modelFilesEnabled
        ? null
        : 'Model files are disabled on this server.',
    },
    librarySync: {
      available:
        capabilities.modelFilesEnabled &&
        capabilities.idempotentModelUploadEnabled,
      reason:
        capabilities.modelFilesEnabled &&
        capabilities.idempotentModelUploadEnabled
          ? null
          : 'Library sync requires model files and idempotent model upload.',
    },
    clientThumbnailUpload: {
      available: capabilities.clientThumbnailUploadEnabled,
      reason: capabilities.clientThumbnailUploadEnabled
        ? null
        : 'Client thumbnail upload is disabled on this server.',
    },
  };
}

async function readBoundedBody(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximum) {
    throw new ServerProfileError(
      'VALIDATION_ERROR',
      'The server response exceeds the allowed size.',
    );
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ServerProfileError(
        'VALIDATION_ERROR',
        'The server response exceeds the allowed size.',
      );
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now) / 1000))
    : null;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
