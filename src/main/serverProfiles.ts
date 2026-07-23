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

const SecretEnvelope = z
  .object({
    version: z.literal(1),
    profileId: z.string().uuid(),
    baseUrl: z.string().url().max(2048),
    authMode: z.enum(['apiKey', 'password']),
    username: z.string().min(1).max(256).nullable(),
    secret: StoredSecret,
  })
  .strict();
type SecretEnvelope = z.infer<typeof SecretEnvelope>;

const RemoteServerVersion = z
  .object({
    service: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    commit: z
      .string()
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    environment: z.string().min(1).max(64),
    runtime: z.string().min(1).max(128),
    timestamp: z.string().datetime(),
  })
  .passthrough()
  .transform((value) =>
    ServerVersion.parse({
      service: value.service,
      version: value.version,
      commit: value.commit,
      environment: value.environment,
      runtime: value.runtime,
      timestamp: value.timestamp,
    }),
  );

const RemoteServerCapabilities = z
  .object({
    architecture: z.string().min(1).max(128),
    slicingEnabled: z.boolean(),
    modelFilesEnabled: z.boolean(),
    thumbnailGenerationEnabled: z.boolean(),
    gcodeUploadEnabled: z.boolean(),
    clientThumbnailUploadEnabled: z.boolean().optional().default(false),
    idempotentModelUploadEnabled: z.boolean().optional().default(false),
    modelThumbnailReplacementEnabled: z.boolean().optional().default(false),
    platformNote: z
      .string()
      .max(1024)
      .nullish()
      .transform((value) => value ?? null),
    operatorFeatures: z.record(z.boolean()).optional(),
  })
  .passthrough()
  .transform((value) =>
    ServerCapabilities.parse({
      architecture: value.architecture,
      slicingEnabled: value.slicingEnabled,
      modelFilesEnabled: value.modelFilesEnabled,
      thumbnailGenerationEnabled: value.thumbnailGenerationEnabled,
      gcodeUploadEnabled: value.gcodeUploadEnabled,
      clientThumbnailUploadEnabled: value.clientThumbnailUploadEnabled,
      idempotentModelUploadEnabled: value.idempotentModelUploadEnabled,
      modelThumbnailReplacementEnabled: value.modelThumbnailReplacementEnabled,
      platformNote: value.platformNote,
      ...(value.operatorFeatures
        ? { operatorFeatures: value.operatorFeatures }
        : {}),
    }),
  );

const RemoteTokenResponse = z
  .object({
    token: z.string().min(1).max(16_384),
    expiresAt: z.string().datetime(),
    scopes: z.array(z.string().min(1).max(128)).max(100),
  })
  .passthrough()
  .transform((value) => ({
    token: value.token,
    expiresAt: value.expiresAt,
    scopes: value.scopes,
  }));

const RemoteLoginResponse = z
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
  .passthrough()
  .transform((value) => ({
    success: value.success,
    token: value.token,
    expiresAt: value.expiresAt,
    user: value.user,
    error: value.error,
  }));

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
  /** Test seam immediately before the legacy-confirmation generation CAS. */
  beforeLegacyConfirmationCas?: () => Promise<void>;
}

export type ProfileErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'AUTHENTICATION_SUPERSEDED'
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

class ProbeFailure extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly error: ServerProfileError,
  ) {
    super(error.message);
    this.name = 'ProbeFailure';
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
  binding: string;
  generation: number;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
}

interface AuthenticatedToken extends IssuedToken {
  cacheId: string;
  binding: string;
  generation: number;
}

interface TokenRenewal {
  binding: string;
  generation: number;
  promise: Promise<IssuedToken>;
}

interface TokenBinding {
  binding: string;
  generation: number;
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

interface ProbedProfile {
  profile: RedactedProfile;
  authentication: AuthenticatedToken;
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
  private readonly tokenBindings = new Map<string, TokenBinding>();
  private readonly tokenRenewals = new Map<string, TokenRenewal>();
  private readonly authGenerations = new Map<string, number>();
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
    const ids = new Set([
      ...this.authGenerations.keys(),
      ...this.tokens.keys(),
      ...this.tokenBindings.keys(),
      ...this.tokenRenewals.keys(),
    ]);
    for (const id of ids) {
      this.invalidateToken(id);
    }
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
      const ephemeralCacheId = this.createId();
      try {
        const probed = await this.probe(
          id,
          draft.displayName,
          draft.baseUrl,
          this.secretFromDraft(draft),
          ephemeralCacheId,
        );
        return probed.profile;
      } catch (error) {
        throw unwrapProbeFailure(error);
      } finally {
        this.disposeEphemeralAuth(ephemeralCacheId);
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
          secret: this.decryptSecret(stored),
        };
      } catch (error) {
        this.invalidateToken(stored.id);
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
    let authentication: AuthenticatedToken | null = null;
    let probeFailure: ProbeFailure | null = null;
    try {
      const probed = await this.probe(
        snapshot.profile.id,
        snapshot.profile.displayName,
        snapshot.profile.baseUrl,
        snapshot.secret,
      );
      tested = probed.profile;
      authentication = probed.authentication;
    } catch (error) {
      if (error instanceof ProbeFailure) {
        probeFailure = error;
      } else {
        throw error;
      }
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
      const expectedGeneration =
        authentication?.generation ?? probeFailure?.expectedGeneration;
      if (
        expectedGeneration === undefined ||
        this.currentAuthGeneration(request.id) !== expectedGeneration
      ) {
        throw authenticationSupersededError();
      }
      if (profileRevision(current) !== snapshot.revision) {
        this.invalidateToken(request.id);
        throw profileChangedError();
      }
      if (probeFailure) {
        if (isAuthenticationSuperseded(probeFailure.error)) {
          throw probeFailure.error;
        }
        store.profiles[index] = errorProfile(current, this.now());
        await this.writeStore(store);
        throw probeFailure.error;
      }
      if (tested) {
        if (!authentication || !this.authenticationIsCurrent(authentication)) {
          throw authenticationSupersededError();
        }
        store.profiles[index] = mergeProbeResult(current, tested);
        await this.writeStore(store);
        if (authentication) {
          this.installAuthenticatedTokenIfCurrent(authentication);
        }
        return tested;
      }
      throw new ServerProfileError(
        'TRANSPORT_ERROR',
        'The server profile test did not produce a result.',
      );
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
    let probed: ProbedProfile;
    try {
      probed = await this.probe(id, draft.displayName, draft.baseUrl, secret);
    } catch (error) {
      throw unwrapProbeFailure(error);
    }
    const tested = probed.profile;
    if (tested.status === 'legacy' && !draft.allowLegacy) {
      const beforeLegacyCas = this.dependencies.beforeLegacyConfirmationCas;
      if (beforeLegacyCas) {
        await beforeLegacyCas();
      }
      await this.withMutationLock(() => {
        if (!this.invalidateAuthenticationIfCurrent(probed.authentication)) {
          throw authenticationSupersededError();
        }
        return Promise.resolve();
      });
      throw new ServerProfileError(
        'LEGACY_CONFIRMATION_REQUIRED',
        'This server does not publish desktop capabilities. Confirm legacy mode before saving it.',
      );
    }

    const encryptedSecret = this.encryptSecret(id, tested.baseUrl, secret);
    await this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.profiles.findIndex((profile) => profile.id === id);
      const current = index < 0 ? null : store.profiles[index]!;
      const currentRevision = current ? profileRevision(current) : null;
      if (currentRevision !== expectedRevision) {
        this.invalidateToken(id);
        throw profileChangedError();
      }
      if (!this.authenticationIsCurrent(probed.authentication)) {
        throw authenticationSupersededError();
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
        this.installAuthenticatedTokenIfCurrent(probed.authentication);
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
    const snapshot = await this.withMutationLock(async () => {
      const store = await this.readStore();
      const profile = store.profiles.find((candidate) => candidate.id === id);
      if (!profile) {
        throw new ServerProfileError('NOT_FOUND', 'Server profile not found.');
      }
      const secret = this.decryptSecret(profile);
      const binding = credentialBinding(profile.baseUrl, secret);
      const generation = this.currentAuthGeneration(id);
      const cached = this.tokens.get(id);
      if (
        cached?.binding === binding &&
        cached.generation === generation &&
        cached.expiresAt - TOKEN_SKEW_MS > this.now()
      ) {
        return { cachedToken: cached.token };
      }
      return {
        profile,
        secret,
        binding,
        generation,
        revision: profileRevision(profile),
      };
    });
    if ('cachedToken' in snapshot) {
      return snapshot.cachedToken;
    }

    this.tokenBindings.set(id, {
      binding: snapshot.binding,
      generation: snapshot.generation,
    });
    const issued = await this.renewToken(
      snapshot.profile.baseUrl,
      snapshot.secret,
      id,
      snapshot.binding,
      snapshot.generation,
    );
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const current = store.profiles.find((profile) => profile.id === id);
      if (!current) {
        this.discardTokenBinding(id, snapshot.binding, snapshot.generation);
        throw new ServerProfileError(
          'NOT_FOUND',
          'The server profile was removed while authentication was running.',
        );
      }
      if (profileRevision(current) !== snapshot.revision) {
        this.discardTokenBinding(id, snapshot.binding, snapshot.generation);
        throw profileChangedError();
      }
      if (
        this.currentAuthGeneration(id) !== snapshot.generation ||
        !tokenBindingMatches(
          this.tokenBindings.get(id),
          snapshot.binding,
          snapshot.generation,
        )
      ) {
        throw authenticationSupersededError();
      }
      this.tokens.set(id, {
        ...issued,
        binding: snapshot.binding,
        generation: snapshot.generation,
      });
      return issued.token;
    });
  }

  private async probe(
    id: string,
    displayName: string,
    rawBaseUrl: string,
    secret: StoredSecret,
    cacheId = id,
  ): Promise<ProbedProfile> {
    const baseUrl = normalizeServerUrl(rawBaseUrl);
    const expectedGeneration = await this.withMutationLock(() =>
      Promise.resolve(this.invalidateToken(cacheId)),
    );
    try {
      this.assertAuthGeneration(cacheId, expectedGeneration);
      const [versionResult, capabilityProbe] = await Promise.all([
        this.getAnonymous(baseUrl, '/api/system/version', RemoteServerVersion),
        this.getCapabilities(baseUrl),
      ]);
      this.assertAuthGeneration(cacheId, expectedGeneration);
      const capabilitiesResult = capabilityProbe?.capabilities ?? null;
      const legacy =
        versionResult === null ||
        capabilityProbe === null ||
        !capabilityProbe.modernUploadContract;
      const authentication = await this.authenticate(
        baseUrl,
        secret,
        cacheId,
        expectedGeneration,
      );
      this.assertAuthGeneration(cacheId, expectedGeneration);

      const availability = availabilityFor(capabilitiesResult, legacy);
      return {
        profile: ServerProfile.parse({
          id,
          displayName: displayName.trim(),
          baseUrl,
          authMode: secret.authMode,
          ...(secret.authMode === 'password'
            ? { username: secret.username }
            : {}),
          version: versionResult,
          capabilities: capabilitiesResult,
          availability,
          status: legacy ? 'legacy' : 'connected',
          lastCheckedAt: new Date(this.now()).toISOString(),
          warnings: [
            ...(baseUrl.startsWith('http:') ? (['insecureHttp'] as const) : []),
            ...(legacy ? (['legacy'] as const) : []),
          ],
        }),
        authentication,
      };
    } catch (error) {
      throw new ProbeFailure(expectedGeneration, scrubProbeError(error));
    }
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
    const parsed = RemoteServerCapabilities.safeParse(raw);
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
    expectedGeneration: number,
  ): Promise<AuthenticatedToken> {
    this.assertAuthGeneration(cacheId, expectedGeneration);
    const binding = credentialBinding(baseUrl, secret);
    const generation = expectedGeneration;
    this.tokenBindings.set(cacheId, { binding, generation });
    const issued = await this.renewToken(
      baseUrl,
      secret,
      cacheId,
      binding,
      generation,
    );
    this.assertAuthGeneration(cacheId, expectedGeneration);
    if (
      this.currentAuthGeneration(cacheId) !== generation ||
      !tokenBindingMatches(this.tokenBindings.get(cacheId), binding, generation)
    ) {
      throw authenticationSupersededError();
    }
    return { ...issued, cacheId, binding, generation };
  }

  private renewToken(
    baseUrl: string,
    secret: StoredSecret,
    cacheId: string,
    binding: string,
    generation: number,
  ): Promise<IssuedToken> {
    const renewal = this.tokenRenewals.get(cacheId);
    if (renewal?.binding === binding && renewal.generation === generation) {
      return renewal.promise;
    }
    let promise = this.issueToken(baseUrl, secret);
    promise = promise.finally(() => {
      if (this.tokenRenewals.get(cacheId)?.promise === promise) {
        this.tokenRenewals.delete(cacheId);
      }
    });
    this.tokenRenewals.set(cacheId, { binding, generation, promise });
    return promise;
  }

  private async issueToken(
    baseUrl: string,
    secret: StoredSecret,
  ): Promise<IssuedToken> {
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
      const exchange = await this.parseJson(response, RemoteTokenResponse);
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
      const login = await this.parseJson(response, RemoteLoginResponse);
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

  private currentAuthGeneration(id: string): number {
    return this.authGenerations.get(id) ?? 0;
  }

  private assertAuthGeneration(id: string, expectedGeneration: number): void {
    if (this.currentAuthGeneration(id) !== expectedGeneration) {
      throw authenticationSupersededError();
    }
  }

  private authenticationIsCurrent(authentication: AuthenticatedToken): boolean {
    return (
      this.currentAuthGeneration(authentication.cacheId) ===
        authentication.generation &&
      tokenBindingMatches(
        this.tokenBindings.get(authentication.cacheId),
        authentication.binding,
        authentication.generation,
      )
    );
  }

  private invalidateAuthenticationIfCurrent(
    authentication: AuthenticatedToken,
  ): boolean {
    if (!this.authenticationIsCurrent(authentication)) {
      return false;
    }
    this.invalidateToken(authentication.cacheId);
    return true;
  }

  private installAuthenticatedTokenIfCurrent(
    authentication: AuthenticatedToken,
  ): boolean {
    if (!this.authenticationIsCurrent(authentication)) {
      return false;
    }
    this.tokens.set(authentication.cacheId, {
      token: authentication.token,
      expiresAt: authentication.expiresAt,
      binding: authentication.binding,
      generation: authentication.generation,
    });
    return true;
  }

  private invalidateToken(id: string): number {
    const generation = this.currentAuthGeneration(id) + 1;
    this.authGenerations.set(id, generation);
    this.tokens.delete(id);
    this.tokenBindings.delete(id);
    this.tokenRenewals.delete(id);
    return generation;
  }

  private disposeEphemeralAuth(id: string): void {
    this.invalidateToken(id);
    this.authGenerations.delete(id);
  }

  private discardTokenBinding(
    id: string,
    binding: string,
    generation: number,
  ): void {
    if (this.currentAuthGeneration(id) === generation) {
      this.invalidateToken(id);
      return;
    }
    const cached = this.tokens.get(id);
    if (cached?.binding === binding && cached.generation === generation) {
      this.tokens.delete(id);
    }
    if (tokenBindingMatches(this.tokenBindings.get(id), binding, generation)) {
      this.tokenBindings.delete(id);
    }
    const renewal = this.tokenRenewals.get(id);
    if (renewal?.binding === binding && renewal.generation === generation) {
      this.tokenRenewals.delete(id);
    }
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

  private encryptSecret(
    profileId: string,
    baseUrl: string,
    secret: StoredSecret,
  ): string {
    this.requireEncryption();
    const envelope: SecretEnvelope = SecretEnvelope.parse({
      version: 1,
      profileId,
      baseUrl,
      authMode: secret.authMode,
      username: secret.authMode === 'password' ? secret.username : null,
      secret,
    });
    return Buffer.from(
      this.dependencies.secretStorage.encryptString(JSON.stringify(envelope)),
    ).toString('base64');
  }

  private decryptSecret(profile: StoredProfile): StoredSecret {
    this.requireEncryption();
    let raw: unknown;
    try {
      const plain = this.dependencies.secretStorage.decryptString(
        Buffer.from(profile.encryptedSecret, 'base64'),
      );
      raw = JSON.parse(plain) as unknown;
    } catch {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'A saved server credential could not be decrypted or validated.',
      );
    }
    if (StoredSecret.safeParse(raw).success) {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'This profile uses an unsupported feature-branch credential format. Re-enter and save its credentials.',
      );
    }
    const parsed = SecretEnvelope.safeParse(raw);
    if (!parsed.success) {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'A saved server credential envelope is invalid.',
      );
    }
    const envelope = parsed.data;
    const expectedUsername =
      profile.authMode === 'password' ? (profile.username ?? null) : null;
    const secretUsername =
      envelope.secret.authMode === 'password' ? envelope.secret.username : null;
    if (
      envelope.profileId !== profile.id ||
      envelope.baseUrl !== profile.baseUrl ||
      envelope.authMode !== profile.authMode ||
      envelope.secret.authMode !== profile.authMode ||
      envelope.username !== expectedUsername ||
      secretUsername !== expectedUsername
    ) {
      throw new ServerProfileError(
        'CORRUPT_STORE',
        'The saved credential does not belong to this server profile. Re-enter its credentials.',
      );
    }
    return envelope.secret;
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

function authenticationSupersededError(): ServerProfileError {
  return new ServerProfileError(
    'AUTHENTICATION_SUPERSEDED',
    'Authentication was cancelled because the server profile changed.',
  );
}

function isAuthenticationSuperseded(error: unknown): boolean {
  return (
    error instanceof ServerProfileError &&
    error.code === 'AUTHENTICATION_SUPERSEDED'
  );
}

function unwrapProbeFailure(error: unknown): ServerProfileError {
  return error instanceof ProbeFailure ? error.error : scrubProbeError(error);
}

function tokenBindingMatches(
  actual: TokenBinding | undefined,
  binding: string,
  generation: number,
): boolean {
  return actual?.binding === binding && actual.generation === generation;
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
