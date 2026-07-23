import type { z } from 'zod';
import {
  ApplyConflictResponse,
  ApplySuccess,
  ChangesResponse,
  CollectionList,
  CollectionSnapshot,
  MembershipList,
  TagSnapshot,
  type ApplyRequest,
  type ApplySuccess as ApplySuccessValue,
  type ApplyConflictResponse as ApplyConflictValue,
  type ChangesResponse as ChangesValue,
  type CollectionSnapshot as CollectionValue,
  type MembershipSnapshot as MembershipValue,
  type TagSnapshot as TagValue,
} from './syncWire.js';

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type SyncHttpErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'authentication'
  | 'authorization'
  | 'rateLimited'
  | 'server'
  | 'notFound'
  | 'invalidResponse'
  | 'bodyTooLarge';

export class SyncHttpError extends Error {
  constructor(
    readonly code: SyncHttpErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export interface SyncHttpClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxGetAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface SyncTokenProvider {
  getToken(profileId: string): Promise<string>;
  refreshToken(profileId: string): Promise<string>;
}

export type ApplyResult =
  | { kind: 'success'; value: ApplySuccessValue }
  | { kind: 'conflict'; value: ApplyConflictValue };

export class SyncHttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxGetAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleepImpl: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly tokens: SyncTokenProvider,
    options: SyncHttpClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.maxGetAttempts = options.maxGetAttempts ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleepImpl = options.sleep ?? sleep;
  }

  getChanges(
    profileId: string,
    baseUrl: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ChangesValue> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) query.set('cursor', cursor);
    return this.get(
      profileId,
      baseUrl,
      `/api/library-sync/changes?${query.toString()}`,
      ChangesResponse,
      signal,
    );
  }

  getCollection(
    profileId: string,
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<CollectionValue | null> {
    return this.getOptional<CollectionValue>(
      profileId,
      baseUrl,
      `/api/model-collections/${encodeURIComponent(id)}`,
      CollectionSnapshot,
      signal,
    );
  }

  getCollections(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<CollectionValue[]> {
    return this.get(
      profileId,
      baseUrl,
      '/api/model-collections',
      CollectionList,
      signal,
    );
  }

  getCollectionMembers(
    profileId: string,
    baseUrl: string,
    collectionId: string,
    signal: AbortSignal,
  ): Promise<MembershipValue[] | null> {
    return this.getOptional<MembershipValue[]>(
      profileId,
      baseUrl,
      `/api/model-collections/${encodeURIComponent(collectionId)}/members`,
      MembershipList,
      signal,
    );
  }

  getTag(
    profileId: string,
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<TagValue | null> {
    return this.getOptional<TagValue>(
      profileId,
      baseUrl,
      `/api/tags/${encodeURIComponent(id)}`,
      TagSnapshot,
      signal,
    );
  }

  async apply(
    profileId: string,
    baseUrl: string,
    body: ApplyRequest,
    signal: AbortSignal,
  ): Promise<ApplyResult> {
    if (body.operations.length === 0 || body.operations.length > 500) {
      throw new SyncHttpError(
        'invalidResponse',
        'Outbound apply batches must contain 1..=500 operations.',
      );
    }
    const response = await this.request(
      profileId,
      baseUrl,
      '/api/library-sync/apply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
      true,
    );
    if (response.status === 409) {
      return {
        kind: 'conflict',
        value: await this.parse(response, ApplyConflictResponse, signal),
      };
    }
    if (!response.ok) {
      throw await this.statusError(response, true);
    }
    return {
      kind: 'success',
      value: await this.parse(response, ApplySuccess, signal),
    };
  }

  private async get<T>(
    profileId: string,
    baseUrl: string,
    resource: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.request(
          profileId,
          baseUrl,
          resource,
          { method: 'GET' },
          signal,
          false,
        );
        if (!response.ok) throw await this.statusError(response, false);
        return await this.parse(response, schema, signal);
      } catch (error) {
        const mapped = mapError(error, signal, false);
        attempt += 1;
        if (
          attempt >= this.maxGetAttempts ||
          !isTransient(mapped) ||
          mapped.code === 'cancelled'
        ) {
          throw mapped;
        }
        await this.sleepImpl(this.retryDelay(mapped, attempt), signal);
      }
    }
  }

  private async getOptional<T>(
    profileId: string,
    baseUrl: string,
    resource: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    signal: AbortSignal,
  ): Promise<T | null> {
    try {
      return await this.get(profileId, baseUrl, resource, schema, signal);
    } catch (error) {
      if (
        error instanceof SyncHttpError &&
        (error.code === 'notFound' || error.code === 'authorization')
      ) {
        return null;
      }
      throw error;
    }
  }

  private async request(
    profileId: string,
    baseUrl: string,
    resource: string,
    init: RequestInit,
    signal: AbortSignal,
    postMayBeAmbiguous: boolean,
  ): Promise<Response> {
    let token: string;
    try {
      token = await this.tokens.getToken(profileId);
    } catch {
      throw new SyncHttpError(
        'authentication',
        'Server authentication could not be renewed.',
      );
    }
    for (
      let authenticationAttempt = 0;
      authenticationAttempt < 2;
      authenticationAttempt += 1
    ) {
      const combined = deadlineSignal(signal, this.timeoutMs);
      try {
        const response = await this.fetchImpl(
          new URL(resource.replace(/^\//, ''), `${baseUrl}/`),
          {
            ...init,
            headers: {
              accept: 'application/json',
              ...init.headers,
              authorization: `Bearer ${token}`,
            },
            signal: combined.signal,
          },
        );
        if (response.status !== 401 || authenticationAttempt > 0)
          return response;
        await discard(response);
        try {
          token = await this.tokens.refreshToken(profileId);
        } catch {
          throw new SyncHttpError(
            'authentication',
            'Server authentication could not be renewed.',
            401,
          );
        }
      } catch (error) {
        throw mapError(error, signal, postMayBeAmbiguous, combined.timedOut());
      } finally {
        combined.dispose();
      }
    }
    throw new SyncHttpError(
      'authentication',
      'Server authentication was rejected.',
      401,
    );
  }

  private async parse<T>(
    response: Response,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const text = await readBoundedBody(response, this.maxResponseBytes, signal);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SyncHttpError(
        'invalidResponse',
        'The server returned invalid JSON.',
        response.status,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new SyncHttpError(
        'invalidResponse',
        'The server response did not match the library sync contract.',
        response.status,
      );
    }
    return parsed.data;
  }

  private async statusError(
    response: Response,
    postMayBeAmbiguous: boolean,
  ): Promise<SyncHttpError> {
    await discard(response);
    const retryAfterMs = parseRetryAfter(
      response.headers.get('retry-after'),
      this.now(),
    );
    if (response.status === 401) {
      return new SyncHttpError(
        'authentication',
        'Server authentication was rejected.',
        401,
      );
    }
    if (response.status === 403) {
      return new SyncHttpError(
        'authorization',
        'The server denied library synchronization.',
        403,
      );
    }
    if (response.status === 404) {
      return new SyncHttpError(
        'notFound',
        'The requested synchronized entity was not found.',
        404,
      );
    }
    if (response.status === 429) {
      return new SyncHttpError(
        'rateLimited',
        'The server rate limited library synchronization.',
        429,
        retryAfterMs,
      );
    }
    return new SyncHttpError(
      response.status >= 500 ? 'server' : 'invalidResponse',
      `Library synchronization failed with HTTP ${response.status}.`,
      response.status,
      retryAfterMs,
      postMayBeAmbiguous && response.status >= 500,
    );
  }

  private retryDelay(error: SyncHttpError, attempt: number): number {
    if (error.retryAfterMs !== null) {
      return Math.min(this.maxBackoffMs, Math.max(0, error.retryAfterMs));
    }
    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.floor(exponential * (0.75 + this.random() * 0.5));
  }
}

function isTransient(error: SyncHttpError): boolean {
  return (
    error.code === 'timeout' ||
    error.code === 'transport' ||
    error.code === 'rateLimited' ||
    (error.status !== null && TRANSIENT_STATUSES.has(error.status))
  );
}

function mapError(
  error: unknown,
  externalSignal: AbortSignal,
  ambiguous: boolean,
  timedOut = false,
): SyncHttpError {
  if (error instanceof SyncHttpError) return error;
  if (externalSignal.aborted) {
    return new SyncHttpError(
      'cancelled',
      'Library synchronization was cancelled.',
    );
  }
  if (timedOut) {
    return new SyncHttpError(
      'timeout',
      'The library synchronization request timed out.',
      null,
      null,
      ambiguous,
    );
  }
  return new SyncHttpError(
    'transport',
    'The library synchronization request could not be completed.',
    null,
    null,
    ambiguous,
  );
}

function deadlineSignal(
  external: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  if (external.aborted) controller.abort();
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      external.removeEventListener('abort', onAbort);
    },
  };
}

async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await discard(response);
    throw new SyncHttpError(
      'bodyTooLarge',
      `The server response exceeded ${limit} bytes.`,
      response.status,
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new SyncHttpError(
          'cancelled',
          'Library synchronization was cancelled.',
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SyncHttpError(
          'bodyTooLarge',
          `The server response exceeded ${limit} bytes.`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status still determines the result when body disposal fails.
  }
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      new SyncHttpError('cancelled', 'Library synchronization was cancelled.'),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          new SyncHttpError(
            'cancelled',
            'Library synchronization was cancelled.',
          ),
        );
      },
      { once: true },
    );
  });
}
