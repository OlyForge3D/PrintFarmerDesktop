/**
 * The queue change-feed cursor-boundary gap check (issue #429).
 *
 * `calibration:pollQueueChanges` sets `gapDetected` so the caller knows to
 * refetch job state over REST. Two branches feed it: intra-page contiguity
 * (event N+1 follows event N), and the cursor boundary (the first event of the
 * page follows the cursor the client asked from).
 *
 * The cursor boundary was compared against `page.afterSequence` — a field the
 * **server** supplies in its own response — rather than `request.afterSequence`,
 * the cursor this process actually sent. A server returning
 * `afterSequence = events[0].sequence - 1` made that comparison false no matter
 * how many events it had skipped, so the branch could never fire. That is an
 * integrity check asking the party being checked to confirm itself, and it
 * fails identically for a merely buggy server: a truncated or mis-paginated
 * page is the ordinary shape of "events begin after a gap from the cursor".
 *
 * Everything here drives the real handler through the real
 * `CalibrationHttpClient` and the real wire schema, with only `globalThis.fetch`
 * stubbed. `registerIpcHandlers` builds `new CalibrationHttpClient(tokens)` with
 * no fetch injection, and the client defaults `fetchImpl` to `globalThis.fetch`,
 * so the stub sits at the socket rather than in place of the client. No
 * hardware and no live PrintFarmer server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';

type Handler = (event: unknown, request: unknown) => unknown;

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
  shell: { openExternal: () => Promise.resolve() },
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'https://queue.internal.example';

/** A minimal wire event. Every operational field is nullish on the wire. */
function wireEvent(sequence: number): Record<string, unknown> {
  return {
    schemaVersion: '3',
    eventId: `${String(sequence % 10).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    sequence,
    eventType: 'JobStatusChanged',
    occurredAtUtc: '2026-01-01T00:00:00.000Z',
  };
}

interface PollResult {
  status: string;
  gapDetected?: boolean;
  afterSequence?: number;
  nextSequence?: number;
  error?: { code: string; message: string };
}

interface PollOutcome {
  result: PollResult;
  /** The `afterSequence` this process actually put on the wire. */
  requestedCursor: string | null;
}

/**
 * Registers the real handlers, stubs `fetch` with the given change-feed page,
 * and invokes `calibration:pollQueueChanges` with `cursor`.
 *
 * `sequences` are the event sequences the server returns. `serverAfterSequence`
 * is the echo the server puts in its own response body — the value the removed
 * check trusted.
 */
async function poll(options: {
  cursor: number;
  sequences: number[];
  serverAfterSequence: number;
  /**
   * Overrides the `nextSequence` the stubbed server returns. Defaults to the
   * honest value (highest delivered sequence, or `serverAfterSequence` for an
   * empty page) when omitted. Set explicitly to simulate a server steering
   * the cursor past what it actually delivered (#487).
   */
  serverNextSequence?: number;
}): Promise<PollOutcome> {
  electronState.handlers.clear();

  let requestedCursor: string | null = null;

  vi.stubGlobal('fetch', (input: URL | Request | string) => {
    // `CalibrationHttpClient` always calls with a `URL`; the other arms keep
    // the stub honest to the `fetch` signature rather than stringifying blind.
    const href =
      input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : input;
    const url = new URL(href);
    requestedCursor = url.searchParams.get('afterSequence');
    const honestNextSequence =
      options.sequences.length > 0
        ? Math.max(...options.sequences)
        : options.serverAfterSequence;
    const body = JSON.stringify({
      afterSequence: options.serverAfterSequence,
      nextSequence: options.serverNextSequence ?? honestNextSequence,
      hasMore: false,
      events: options.sequences.map(wireEvent),
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  const profiles = {
    list: () =>
      Promise.resolve({
        profiles: [{ id: PROFILE_ID, name: 'selected', baseUrl: BASE_URL }],
        selectedProfileId: PROFILE_ID,
      }),
    getAuthenticatedContext: (id: string) =>
      Promise.resolve({
        profile: { id, baseUrl: BASE_URL },
        token: 'token',
        revision: 1,
        generation: 1,
        serverBinding: 'binding',
        endpoint: (p: string) => `${BASE_URL}${p}`,
      }),
    getAuthenticatedServerContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'token',
        binding: 'binding',
      }),
  };

  const inert = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        return () => Promise.resolve({});
      },
    },
  );

  registerIpcHandlers(
    undefined,
    profiles as never,
    inert as never,
    inert as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    {
      authorizeFile: () => Promise.reject(new Error('not used')),
      canonicalizePickerFile: (p: string) => Promise.resolve(p),
      resolve: () => Promise.reject(new Error('not used')),
      reset: () => Promise.resolve(),
    } as never,
    {
      initialize: () => Promise.resolve(),
      dispose: () => undefined,
      purge: () => Promise.resolve(),
      loadScene: () => Promise.resolve({}),
      adoptRecipe: () => Promise.resolve(),
    } as never,
  );

  const handler = electronState.handlers.get(
    IpcChannel.CalibrationPollQueueChanges,
  );
  if (handler === undefined) {
    throw new Error('calibration:pollQueueChanges handler was not registered');
  }

  const result = (await handler(
    {},
    { profileId: PROFILE_ID, afterSequence: options.cursor, limit: 200 },
  )) as PollResult;

  return { result, requestedCursor };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calibration:pollQueueChanges cursor-boundary gap detection', () => {
  it('flags a gap when the page begins after the cursor and the server echoes a cursor that hides it', async () => {
    // The client asked from 10. The server answers with 20, 21, 22 — nine
    // events unaccounted for — and echoes `afterSequence: 19`, exactly
    // `events[0].sequence - 1`, so a check against the echo sees contiguity.
    const { result, requestedCursor } = await poll({
      cursor: 10,
      sequences: [20, 21, 22],
      serverAfterSequence: 19,
    });

    expect(
      requestedCursor,
      'the cursor under test must be the one actually sent',
    ).toBe('10');
    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'cursor-boundary case: events begin at 20 after a cursor of 10, so nine ' +
        'events were skipped. A server echo of 19 must not be able to suppress ' +
        'this — the boundary is checked against the client cursor.',
    ).toBe(true);
  });

  /**
   * Localises the boundary, not merely the operand. Each row keeps the page
   * internally contiguous and keeps the server echo hostile
   * (`events[0].sequence - 1`), so only the cursor branch can move the result.
   *
   * A near-miss survives the case above: `!== request.afterSequence` without
   * `+ 1` still reports the gap, and so does `+ 2`. The rows below are what
   * separate them — 11 is the first legitimate event after a cursor of 10.
   */
  it.each([
    {
      first: 11,
      expected: false,
      why: 'first legitimate event after cursor 10',
    },
    { first: 12, expected: true, why: 'exactly one event skipped' },
    { first: 13, expected: true, why: 'two events skipped' },
  ])(
    'cursor 10 with a page starting at $first sets gapDetected=$expected ($why)',
    async ({ first, expected, why }) => {
      const { result } = await poll({
        cursor: 10,
        sequences: [first, first + 1, first + 2],
        serverAfterSequence: first - 1,
      });

      expect(result.status).toBe('ok');
      expect(
        result.gapDetected,
        `cursor-boundary case: cursor 10, page starts at ${first} (${why}). ` +
          `An off-by-one boundary fails here even with the correct operand.`,
      ).toBe(expected);
    },
  );

  it('reports no gap for an honest contiguous page (negative control)', async () => {
    // Nothing hostile: the server echoes the cursor it was given and the page
    // continues from it. If this were true the assertions above would be
    // satisfied by an always-true flag rather than by detection.
    const { result } = await poll({
      cursor: 10,
      sequences: [11, 12, 13],
      serverAfterSequence: 10,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'negative control: cursor 10, page 11-13, honest echo. gapDetected must ' +
        'be false, otherwise the positive assertions prove nothing.',
    ).toBe(false);
  });

  it('still flags an intra-page discontinuity, which is a separate branch', async () => {
    // Contiguous with the cursor, broken inside the page. This branch was
    // always correct; it is pinned so a change to the cursor boundary cannot
    // silently trade one detection for the other.
    const { result } = await poll({
      cursor: 10,
      sequences: [11, 13, 14],
      serverAfterSequence: 10,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'intra-page case: 11 then 13 skips 12. This branch is independent of the ' +
        'cursor boundary and must keep firing.',
    ).toBe(true);
  });

  it('treats the documented start-from-the-beginning cursor as a real cursor', async () => {
    // `afterSequence: 0` is documented as "start from the beginning"
    // (`src/shared/ipc.ts`), and the only caller initialises its cursor to 0,
    // so every mount's first poll lands here. 0 is a cursor like any other:
    // the first legitimate event after it is 1, and a page that begins at 5 has
    // skipped four. Before the fix, a server echoing 4 suppressed that.
    //
    // This is a behavioural change on the first poll of every mount against any
    // server whose sequence counter is not at 1 — a pruned or long-lived queue
    // will now report a gap once and trigger one REST reconcile. That direction
    // is the safe one and it is bounded, and exempting cursor 0 would put back
    // a blind spot on exactly the poll that has the least local state.
    const gapped = await poll({
      cursor: 0,
      sequences: [5, 6, 7],
      serverAfterSequence: 4,
    });
    expect(gapped.result.status).toBe('ok');
    expect(
      gapped.result.gapDetected,
      'cursor-boundary case: cursor 0 means "from the beginning", so a page ' +
        'starting at 5 skipped events 1-4 and must be reported.',
    ).toBe(true);

    const clean = await poll({
      cursor: 0,
      sequences: [1, 2, 3],
      serverAfterSequence: 0,
    });
    expect(clean.result.status).toBe('ok');
    expect(
      clean.result.gapDetected,
      'cursor 0 with a page starting at 1 is contiguous and must not be ' +
        'reported, so the row above is not just "cursor 0 always flags".',
    ).toBe(false);
  });

  it('reports no gap for an empty page, whatever the server echoes', async () => {
    // Characterization: with no first event there is no cursor-boundary or
    // internal discontinuity to check, so `detectQueueChangeFeedGap` itself
    // cannot see anything here. Server steering of `nextSequence` past what
    // it delivered is now caught by a separate mechanism exercised in the
    // "queue-cursor-steering" suite below (#487) — this test pins that the
    // page-shape check alone stays silent on an empty, honestly-cursored page.
    const { result } = await poll({
      cursor: 10,
      sequences: [],
      serverAfterSequence: 10,
      serverNextSequence: 10,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'empty page with an honest (unadvanced) nextSequence: no first event, ' +
        'so the cursor-boundary branch does not apply, and nextSequence was ' +
        'not steered past the cursor.',
    ).toBe(false);
  });
});

describe('calibration:pollQueueChanges nextSequence cursor-steering (#487)', () => {
  it('flags a gap and clamps the cursor when an empty page advances nextSequence', async () => {
    // Poll with cursor 10. The server returns no events but an advanced
    // nextSequence of 900 — the exact reproduction from the issue. Before the
    // fix, `nextSequence: 900` was adopted verbatim and `gapDetected` stayed
    // false because `detectQueueChangeFeedGap` never inspects `nextSequence`.
    const { result } = await poll({
      cursor: 10,
      sequences: [],
      serverAfterSequence: 10,
      serverNextSequence: 900,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'an empty page whose nextSequence advances past the request cursor ' +
        'must be flagged as a gap — no events were delivered to justify the jump.',
    ).toBe(true);
    expect(
      result.nextSequence,
      'the returned cursor must be clamped to the last sequence actually ' +
        'delivered (here, the request cursor itself, since no events came ' +
        'back), never adopted verbatim from the server.',
    ).toBe(10);
  });

  it('flags a gap and clamps the cursor when a short page advances nextSequence beyond what it delivered', async () => {
    // Poll with cursor 10. The server delivers only event 11 but claims
    // nextSequence 900, hiding the skip of events 12-899 behind a page that
    // is otherwise perfectly contiguous with the cursor (so the existing
    // boundary/internal checks alone see nothing wrong).
    const { result } = await poll({
      cursor: 10,
      sequences: [11],
      serverAfterSequence: 10,
      serverNextSequence: 900,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'a short page (one event) whose nextSequence advances far past the ' +
        'last delivered sequence must be flagged as a gap.',
    ).toBe(true);
    expect(
      result.nextSequence,
      'the returned cursor must clamp to the highest sequence actually ' +
        'delivered (11), not the server-claimed 900.',
    ).toBe(11);
  });

  it('does not flag a gap for an honest page whose nextSequence matches the last delivered sequence (negative control)', async () => {
    // Nothing hostile: nextSequence equals the last delivered sequence, which
    // is the normal, honest shape of a response. If the steering check fired
    // here it would prove nothing about the positive cases above.
    const { result } = await poll({
      cursor: 10,
      sequences: [11, 12, 13],
      serverAfterSequence: 10,
    });

    expect(result.status).toBe('ok');
    expect(
      result.gapDetected,
      'negative control: nextSequence (13) equals the last delivered ' +
        'sequence, so no cursor-steering gap should be reported.',
    ).toBe(false);
    expect(result.nextSequence).toBe(13);
  });

  it('boundary: nextSequence exactly equal to the last delivered sequence is not a gap, but one past it is', async () => {
    // Pins the clamp boundary itself so an off-by-one (e.g. `>=` instead of
    // `>`, or clamping to `lastDelivered - 1`) cannot pass. `first` is the
    // last delivered sequence in both rows; only the claimed nextSequence
    // differs by exactly one.
    const exact = await poll({
      cursor: 10,
      sequences: [11, 12],
      serverAfterSequence: 10,
      serverNextSequence: 12,
    });
    expect(
      exact.result.gapDetected,
      'nextSequence exactly equal to the last delivered sequence (12) is the ' +
        'honest shape and must not be flagged.',
    ).toBe(false);
    expect(exact.result.nextSequence).toBe(12);

    const offByOne = await poll({
      cursor: 10,
      sequences: [11, 12],
      serverAfterSequence: 10,
      serverNextSequence: 13,
    });
    expect(
      offByOne.result.gapDetected,
      'nextSequence one past the last delivered sequence (13, when only up ' +
        'to 12 was delivered) must be flagged — a clamp that permits an ' +
        'off-by-one overshoot would miss exactly this case.',
    ).toBe(true);
    expect(
      offByOne.result.nextSequence,
      'even when flagged, the returned cursor must clamp to 12, not adopt ' +
        'the server-claimed 13.',
    ).toBe(12);
  });

  it('clamps a rewound cursor to the request cursor rather than adopting it', async () => {
    // The server tries to rewind nextSequence below the cursor the client
    // just sent, which would otherwise cause a redelivery loop on the next
    // poll. This is not itself treated as a "gap" (no events were skipped),
    // but the rewound value must never be adopted verbatim.
    const { result } = await poll({
      cursor: 10,
      sequences: [11, 12],
      serverAfterSequence: 10,
      serverNextSequence: 3,
    });

    expect(result.status).toBe('ok');
    expect(
      result.nextSequence,
      'a server-supplied nextSequence below the request cursor must be ' +
        'clamped up to the request cursor, not adopted verbatim.',
    ).toBe(10);
  });
});
