import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
const MODERN_UPLOAD_CAPABILITY_FIELDS = [
  'clientThumbnailUploadEnabled',
  'idempotentModelUploadEnabled',
  'modelThumbnailReplacementEnabled',
] as const;

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
    error: z
      .string()
      .max(1024)
      .nullish()
      .transform((value) => value ?? null),
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
  binding: string;
}

interface TokenRenewal {
  binding: string;
  promise: Promise<string>;
}

interface PendingResponse {
  response: Response;
  signal: AbortSignal;
  finish(): void;
}

interface CapabilityProbe {
  capabilities: z.infer<typeof ServerCapabilities>;
  modernUploadContract: boolean;
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
  private readonly tokenBindings = new Map<string, string>();
  private readonly tokenRenewals = new Map<string, TokenRenewal>();
  private mutationTail: Promise<void> = Promise.resolve();

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
    this.tokenBindings.clear();
    this.tokenRenewals.clear();
  }

  async list(): Promise<ListServerProfilesResponse> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      return this.redactStore(store);
    });
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
        this.invalidateToken(id);
      }
    }

    const snapshot = await this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.profiles.findIndex(
        (profile) => profile.id === request.id,
      );
      if (index < 0) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      const stored = store.profiles[index]!;
      const revision = profileRevision(stored);
      try {
        return {
          profile: stored,
          revision,
          secret: this.decryptSecret(stored.encryptedSecret),
        };
      } catch (error) {
        store.profiles[index] = errorProfile(stored, this.now());
        try {
          await this.writeStore(store);
        } catch {
          throw new ServerProfileError(
            'CORRUPT_STORE',
            'The saved server profile error state could not be persisted.',
          );
        }
        throw scrubVaultError(error);
      }
    });

    let tested: RedactedProfile | null = null;
    let probeError: unknown;
    try {
      tested = await this.probe(
        snapshot.profile.id,
        snapshot.profile.displayName,
        snapshot.profile.baseUrl,
        snapshot.secret,
      );
    } catch (error) {
      probeError = error;
    }

    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.profiles.findIndex(
        (profile) => profile.id === request.id,
      );
      if (index < 0) {
        this.invalidateToken(request.id);
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      const current = store.profiles[index]!;
      if (profileRevision(current) !== snapshot.revision) {
        this.invalidateToken(request.id);
        throw profileChangedError();
      }
      if (tested) {
        store.profiles[index] = mergeProbeResult(current, tested);
        await this.writeStore(store);
        return tested;
      }
      store.profiles[index] = errorProfile(current, this.now());
      await this.writeStore(store);
      throw scrubProbeError(probeError);
    });
  }

  async save(draft: ServerProfileDraft): Promise<RedactedProfile> {
    this.requireEncryption();
    const secret = this.secretFromDraft(draft);
    const id = draft.id ?? this.createId();
    const expectedRevision = await this.withMutationLock(async () => {
      const store = await this.readStore();
      const existing = store.profiles.find((profile) => profile.id === id);
      if (draft.id && !existing) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      return existing ? profileRevision(existing) : null;
    });
    const tested = await this.probe(
      id,
      draft.displayName,
      draft.baseUrl,
      secret,
    );
    if (tested.status === 'legacy' && !draft.allowLegacy) {
      this.invalidateToken(id);
      throw new ServerProfileError(
        'LEGACY_CONFIRMATION_REQUIRED',
        'This server does not publish desktop capabilities. Confirm legacy mode before saving it.',
      );
    }

    const encryptedSecret = Buffer.from(
      this.dependencies.secretStorage.encryptString(JSON.stringify(secret)),
    ).toString('base64');
    await this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.profiles.findIndex((profile) => profile.id === id);
      const current = index < 0 ? null : store.profiles[index]!;
      const currentRevision = current ? profileRevision(current) : null;
      if (currentRevision !== expectedRevision) {
        this.invalidateToken(id);
        throw profileChangedError();
      }
      const stored: StoredProfile = { ...tested, encryptedSecret };
      if (index < 0) {
        store.profiles.push(stored);
      } else {
        store.profiles[index] = stored;
      }
      store.selectedProfileId ??= id;
      try {
        await this.writeStore(store);
      } catch (error) {
        this.invalidateToken(id);
        throw error;
      }
    });
    return tested;
  }

  async select(id: string): Promise<RedactedProfile> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const profile = store.profiles.find((candidate) => candidate.id === id);
      if (!profile) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      store.selectedProfileId = id;
      await this.writeStore(store);
      return this.redact(profile);
    });
  }

  async delete(id: string): Promise<ListServerProfilesResponse> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      store.profiles.splice(index, 1);
      this.invalidateToken(id);
      if (store.selectedProfileId === id) {
        store.selectedProfileId = store.profiles[0]?.id ?? null;
      }
      await this.writeStore(store);
      return this.redactStore(store);
    });
  }

  async getToken(id: string): Promise<string> {
    const { profile, secret } = await this.withMutationLock(async () => {
      const store = await this.readStore();
      const profile = store.profiles.find((candidate) => candidate.id === id);
      if (!profile) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      return {
        profile,
        secret: this.decryptSecret(profile.encryptedSecret),
      };
    });
    return this.authenticate(profile.baseUrl, secret, id, false);
  }

  private async probe(
    id: string,
    displayName: string,
    rawBaseUrl: string,
    secret: StoredSecret,
  ): Promise<RedactedProfile> {
    const baseUrl = normalizeServerUrl(rawBaseUrl);
    this.invalidateToken(id);
    const [versionResult, capabilityProbe] = await Promise.all([
      this.getAnonymous(baseUrl, '/api/system/version', ServerVersion),
      this.getCapabilities(baseUrl),
    ]);
    const capabilitiesResult = capabilityProbe?.capabilities ?? null;
    const legacy =
      versionResult === null ||
      capabilityProbe === null ||
      !capabilityProbe.modernUploadContract;
    await this.authenticate(baseUrl, secret, id, true);

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

  private async getCapabilities(
    baseUrl: string,
  ): Promise<CapabilityProbe | null> {
    const response = await this.request(
      baseUrl,
      '/api/system/capabilities',
      { method: 'GET' },
      true,
    );
    if (response === null) {
      return null;
    }
    const raw = await this.parseJson(response, z.unknown());
    const parsed = ServerCapabilities.safeParse(raw);
    if (!parsed.success) {
      throw new ServerProfileError(
        'VALIDATION_ERROR',
        'The server response did not match the expected PrintFarmer contract.',
      );
    }
    const modernUploadContract =
      typeof raw === 'object' &&
      raw !== null &&
      MODERN_UPLOAD_CAPABILITY_FIELDS.every((field) =>
        Object.prototype.hasOwnProperty.call(raw, field),
      );
    return {
      capabilities: parsed.data,
      modernUploadContract,
    };
  }

  private async authenticate(
    baseUrl: string,
    secret: StoredSecret,
    cacheId: string,
    force: boolean,
  ): Promise<string> {
    const binding = credentialBinding(baseUrl, secret);
    this.tokenBindings.set(cacheId, binding);
    if (force) {
      this.tokens.delete(cacheId);
    }
    const cached = this.tokens.get(cacheId);
    if (
      cached &&
      cached.binding === binding &&
      cached.expiresAt - TOKEN_SKEW_MS > this.now()
    ) {
      return cached.token;
    }
    this.tokens.delete(cacheId);

    const renewal = this.tokenRenewals.get(cacheId);
    if (renewal?.binding === binding) {
      return renewal.promise;
    }

    let promise: Promise<string>;
    promise = this.issueToken(baseUrl, secret).then((issued) => {
      if (this.tokenBindings.get(cacheId) === binding) {
        this.tokens.set(cacheId, { ...issued, binding });
      }
      return issued.token;
    });
    promise = promise.finally(() => {
      if (this.tokenRenewals.get(cacheId)?.promise === promise) {
        this.tokenRenewals.delete(cacheId);
      }
    });
    this.tokenRenewals.set(cacheId, { binding, promise });
    return promise;
  }

  private async issueToken(
    baseUrl: string,
    secret: StoredSecret,
  ): Promise<{ token: string; expiresAt: number }> {
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
    return { token, expiresAt: expiration };
  }

  private async request(
    baseUrl: string,
    endpoint: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<PendingResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
      }
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${endpoint}`, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      finish();
      if (controller.signal.aborted) {
        throw timeoutError();
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
    }

    const pending: PendingResponse = {
      response,
      signal: controller.signal,
      finish,
    };
    if (response.status === 404 && allowNotFound) {
      await discardBody(pending);
      return null;
    }
    if (response.status === 401) {
      await discardBody(pending);
      throw new ServerProfileError(
        'AUTHENTICATION_FAILED',
        'The server rejected the supplied credentials.',
      );
    }
    if (response.status === 403) {
      await discardBody(pending);
      throw new ServerProfileError(
        'AUTHORIZATION_FAILED',
        'The credentials do not permit this Desktop operation.',
      );
    }
    if (response.status === 404) {
      await discardBody(pending);
      return null;
    }
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(
        response.headers.get('retry-after'),
        this.now(),
      );
      await discardBody(pending);
      throw new ServerProfileError(
        'RATE_LIMITED',
        retryAfterSeconds === null
          ? 'The server is rate limiting requests. Try again later.'
          : `The server is rate limiting requests. Try again in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      );
    }
    if (!response.ok) {
      await discardBody(pending);
      throw new ServerProfileError(
        'TRANSPORT_ERROR',
        `The server returned HTTP ${response.status}.`,
      );
    }
    return pending;
  }

  private async parseJson<T>(
    pending: PendingResponse,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(
        pending.response,
        MAX_RESPONSE_BYTES,
        pending.signal,
      );
    } catch (error) {
      if (pending.response.body && !pending.response.body.locked) {
        void pending.response.body.cancel().catch(() => undefined);
      }
      if (pending.signal.aborted) {
        throw timeoutError();
      }
      throw error;
    } finally {
      pending.finish();
    }
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

  private invalidateToken(id: string): void {
    this.tokens.delete(id);
    this.tokenBindings.delete(id);
    this.tokenRenewals.delete(id);
  }

  private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
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
    const modelFilesAvailable = capabilities?.modelFilesEnabled ?? true;
    const serverThumbnailsAvailable =
      capabilities?.thumbnailGenerationEnabled ?? true;
    return {
      modelUpload: {
        available: modelFilesAvailable,
        mode: modelFilesAvailable ? 'legacyModelOnly' : 'unavailable',
        reason: modelFilesAvailable
          ? 'Legacy model-only upload fallback; modern idempotency is unavailable.'
          : 'Model files are disabled on this server.',
      },
      librarySync: {
        available: false,
        reason:
          'Library sync is unavailable because modern idempotent upload was not advertised.',
      },
      clientThumbnailUpload: {
        available: false,
        reason:
          'Client thumbnail upload is unavailable because the capability was not advertised.',
      },
      serverThumbnailFallback: {
        available: serverThumbnailsAvailable,
        reason: serverThumbnailsAvailable
          ? 'Use server-generated thumbnails with the legacy model-only fallback.'
          : 'Server thumbnail generation is disabled.',
      },
    };
  }
  const modernModelUpload =
    capabilities.modelFilesEnabled && capabilities.idempotentModelUploadEnabled;
  const serverThumbnailFallback =
    capabilities.modelFilesEnabled &&
    !capabilities.clientThumbnailUploadEnabled &&
    capabilities.thumbnailGenerationEnabled;
  return {
    modelUpload: {
      available: capabilities.modelFilesEnabled,
      mode: modernModelUpload
        ? 'modern'
        : capabilities.modelFilesEnabled
          ? 'legacyModelOnly'
          : 'unavailable',
      reason: modernModelUpload
        ? null
        : capabilities.modelFilesEnabled
          ? 'Only model-file upload is available because idempotent upload is disabled.'
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
    serverThumbnailFallback: {
      available: serverThumbnailFallback,
      reason: serverThumbnailFallback
        ? 'Use server-generated thumbnails because client-thumbnail upload is disabled.'
        : 'Server-thumbnail fallback is not required or not supported.',
    },
  };
}

function profileRevision(profile: StoredProfile): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: profile.id,
        displayName: profile.displayName,
        baseUrl: profile.baseUrl,
        authMode: profile.authMode,
        username: profile.username ?? null,
        encryptedSecret: profile.encryptedSecret,
      }),
    )
    .digest('hex');
}

function mergeProbeResult(
  current: StoredProfile,
  tested: RedactedProfile,
): StoredProfile {
  return {
    ...current,
    version: tested.version,
    capabilities: tested.capabilities,
    availability: tested.availability,
    status: tested.status,
    lastCheckedAt: tested.lastCheckedAt,
    warnings: tested.warnings,
  };
}

function errorProfile(profile: StoredProfile, now: number): StoredProfile {
  return {
    ...profile,
    status: 'error',
    lastCheckedAt: new Date(now).toISOString(),
  };
}

function profileChangedError(): ServerProfileError {
  return new ServerProfileError(
    'VALIDATION_ERROR',
    'The server profile changed while the operation was running. Test it again.',
  );
}

function scrubVaultError(error: unknown): ServerProfileError {
  if (error instanceof ServerProfileError) {
    return new ServerProfileError(
      error.code,
      error.message,
      error.retryAfterSeconds,
    );
  }
  return new ServerProfileError(
    'CORRUPT_STORE',
    'A saved server credential could not be decrypted or validated.',
  );
}

function scrubProbeError(error: unknown): ServerProfileError {
  if (error instanceof ServerProfileError) {
    return new ServerProfileError(
      error.code,
      error.message,
      error.retryAfterSeconds,
    );
  }
  return new ServerProfileError(
    'TRANSPORT_ERROR',
    'The server profile test failed.',
  );
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
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
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal, () => {
        void reader.cancel().catch(() => undefined);
      });
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
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may retain the lock until its cancellation settles.
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function discardBody(pending: PendingResponse): Promise<void> {
  try {
    if (pending.response.body) {
      await withAbort(
        pending.response.body.cancel(),
        pending.signal,
        () => undefined,
      );
    }
  } catch (error) {
    if (pending.signal.aborted) {
      throw timeoutError();
    }
    throw error;
  } finally {
    pending.finish();
  }
}

function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(timeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(timeoutError());
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(
          error instanceof Error
            ? error
            : new ServerProfileError(
                'TRANSPORT_ERROR',
                'The server response body could not be read.',
              ),
        );
      },
    );
  });
}

function timeoutError(): ServerProfileError {
  return new ServerProfileError(
    'TIMEOUT',
    'The server did not respond before the connection timed out.',
  );
}

function credentialBinding(baseUrl: string, secret: StoredSecret): string {
  return createHash('sha256')
    .update(baseUrl)
    .update('\0')
    .update(JSON.stringify(secret))
    .digest('hex');
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
