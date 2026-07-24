import { describe, expect, it, vi } from 'vitest';
import { SyncHttpClient, SyncHttpError } from '../src/main/syncHttp.js';

const CHANGE_PAGE = {
  changes: [],
  nextCursor: null,
  hasMore: false,
  serverRevision: 1,
  additiveField: true,
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SyncHttpClient', () => {
  it('defaults omitted deployed nullable properties to null', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          changes: [
            {
              revision: 1,
              entityType: 'ModelCollection',
              entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              operation: 'Update',
              // `ownerUserId` is entirely omitted here (not `null`), which
              // the deployed 10.0.0.20 contract does for some legacy/system
              // owned entities -- the schema must accept a missing key, not
              // just an explicit `null`.
              visibility: 'Shared',
              actorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              timestamp: new Date().toISOString(),
            },
          ],
          hasMore: false,
          serverRevision: 1,
        }),
      )
      .mockResolvedValueOnce(
        json({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'Remote',
          isShared: false,
          modelIds: [],
          revision: 1,
          concurrencyToken: 'token',
        }),
      );
    const client = new SyncHttpClient(tokens(), { fetch });

    await expect(
      client.getChanges(
        'profile',
        'https://farm.example',
        null,
        500,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      nextCursor: null,
      changes: [{ ownerUserId: null }],
    });
    await expect(
      client.getCollection(
        'profile',
        'https://farm.example',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ownerUserId: null, description: null });
  });

  it('sends and parses the deployed flat apply contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        json({
          applied: [
            {
              entityType: 'ModelCollection',
              operation: 'Create',
              entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              revision: 7,
              merged: false,
              additive: 'accepted',
            },
          ],
          serverRevision: 7,
          additive: true,
        }),
      ),
    );
    const client = new SyncHttpClient(tokens(), { fetch });
    const operation = {
      entityType: 'ModelCollection' as const,
      operation: 'Create' as const,
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      baseRevision: null,
      concurrencyToken: null,
      collectionId: null,
      modelId: null,
      name: 'Farm parts',
      description: null,
      isShared: false,
    };

    await expect(
      client.apply(
        'profile',
        'https://farm.example',
        { operations: [operation] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: 'success',
      value: { serverRevision: 7 },
    });
    const requestBody = fetch.mock.calls[0]![1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(requestBody as string)).toEqual({
      operations: [operation],
    });
  });

  it('accepts additive fields and preserves an empty opaque cursor', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json(CHANGE_PAGE)),
    );
    const client = new SyncHttpClient(tokens(), { fetch });

    await client.getChanges(
      'profile',
      'https://farm.example/base',
      '',
      500,
      new AbortController().signal,
    );

    const request = fetch.mock.calls[0]![0];
    const url = new URL(
      typeof request === 'string' || request instanceof URL
        ? request
        : request.url,
    );
    expect(url.pathname).toBe('/base/api/library-sync/changes');
    expect(url.searchParams.get('cursor')).toBe('');
    expect(url.searchParams.get('limit')).toBe('500');
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: 'Bearer token-1',
    });
  });

  it('refreshes a rejected JWT once without exposing it', async () => {
    const provider = tokens();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(CHANGE_PAGE));
    const client = new SyncHttpClient(provider, { fetch });

    await client.getChanges(
      'profile',
      'https://farm.example',
      null,
      500,
      new AbortController().signal,
    );

    expect(provider.refreshToken).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1]![1]?.headers).toMatchObject({
      authorization: 'Bearer token-2',
    });
  });

  it('honors Retry-After for retryable GET requests', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(json(CHANGE_PAGE));
    const client = new SyncHttpClient(tokens(), {
      fetch,
      sleep,
      random: () => 0,
    });

    await client.getChanges(
      'profile',
      'https://farm.example',
      null,
      500,
      new AbortController().signal,
    );

    expect(sleep).toHaveBeenCalledWith(7000, expect.any(AbortSignal));
  });

  it('rejects declared and streamed oversized bodies', async () => {
    const declared = new SyncHttpClient(tokens(), {
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response('x', {
            headers: { 'content-length': '101' },
          }),
        ),
      ),
      maxResponseBytes: 100,
      maxGetAttempts: 1,
    });
    await expect(
      declared.getChanges(
        'profile',
        'https://farm.example',
        null,
        500,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'bodyTooLarge' });

    const streamed = new SyncHttpClient(tokens(), {
      fetch: vi.fn(() => Promise.resolve(new Response('x'.repeat(101)))),
      maxResponseBytes: 100,
      maxGetAttempts: 1,
    });
    await expect(
      streamed.getChanges(
        'profile',
        'https://farm.example',
        null,
        500,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'bodyTooLarge' });
  });

  it('classifies a failed POST transport as ambiguous and never retries it', async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError('secret transport detail')),
    );
    const client = new SyncHttpClient(tokens(), { fetch });

    await expect(
      client.apply(
        'profile',
        'https://farm.example',
        {
          operations: [
            {
              entityType: 'ModelCollection',
              operation: 'Create',
              entityId: '11111111-1111-4111-8111-111111111111',
              baseRevision: null,
              concurrencyToken: null,
              collectionId: null,
              modelId: null,
              name: 'Collection',
              description: null,
              isShared: false,
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SyncHttpError>>({
        code: 'transport',
        ambiguous: true,
      }),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the deadline active while a response body is stalled', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately never enqueue or close.
      },
    });
    const client = new SyncHttpClient(tokens(), {
      fetch: vi.fn(() => Promise.resolve(new Response(stream))),
      timeoutMs: 10,
      maxGetAttempts: 1,
    });

    await expect(
      client.getChanges(
        'profile',
        'https://farm.example',
        null,
        500,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'timeout', ambiguous: false });
  });

  it('cancels a stalled body when its owning run is disposed', async () => {
    let bodyReadStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        bodyReadStarted();
      },
      cancel: () => undefined,
    });
    const controller = new AbortController();
    const client = new SyncHttpClient(tokens(), {
      fetch: vi.fn(() => Promise.resolve(new Response(stream))),
      timeoutMs: 10_000,
      maxGetAttempts: 1,
    });
    const pending = client.getChanges(
      'profile',
      'https://farm.example',
      null,
      500,
      controller.signal,
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});

function tokens(): {
  getToken: ReturnType<typeof vi.fn>;
  refreshToken: ReturnType<typeof vi.fn>;
} {
  return {
    getToken: vi.fn(() => Promise.resolve('token-1')),
    refreshToken: vi.fn(() => Promise.resolve('token-2')),
  };
}
