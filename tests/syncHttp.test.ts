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
              operationId: 'op',
              entityType: 'ModelCollection',
              operation: 'Create',
              entityId: 'local',
              payload: {},
              baseRevision: null,
              concurrencyToken: null,
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
