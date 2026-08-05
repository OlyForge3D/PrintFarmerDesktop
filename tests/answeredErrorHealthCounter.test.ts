import { describe, expect, it } from 'vitest';
import {
  SidecarClient,
  SidecarRespondedError,
  type SidecarChannel,
} from '../src/main/sidecar';

/**
 * #522. `consecutiveFailures` gates `ensureChannel()`, which refuses to create a
 * channel at all once the ceiling is reached and reports "sidecar unavailable
 * after N consecutive failures". An answered error envelope used to advance that
 * counter — so N unhappy-but-correct answers in a row silenced a demonstrably
 * healthy sidecar, under a message that could only ever be false.
 *
 * The distinction is the same one #404 drew one layer up: *could not ask* versus
 * *asked, and was answered*. Here it is behavioural rather than diagnostic, so
 * the assertions below are about whether a request is DISPATCHED, not about
 * which error came back. An error-code assertion would pass against a client
 * that had stopped talking to the sidecar entirely.
 *
 * Mutations run against this file (each reverted; control green):
 *   M-1  restore `this.recordFailure()` on the answered branch
 *          -> RED, 'still contacts the sidecar' + 'mixed sequence' both fire
 *   M-2  delete recordFailure() from ALL five sites (the over-broad "fix")
 *          -> RED, the CONTROL fires: the ceiling never trips for transport
 *             faults. This is the mutation that a passing-tests-only reading of
 *             #522 would have shipped.
 *   M-3  make the fake channel resolve every request successfully
 *          -> RED, positive control first: the specs stop observing rejections
 *   CONTROL  all reverted -> GREEN
 */

/** Records every dispatched request line so a spec can assert delivery. */
function makeCountingChannel(
  respond: (
    request: { id: number; method: string },
    emit: (line: string) => void,
    close: (code: number | null) => void,
  ) => void,
): { channel: SidecarChannel; sent: string[] } {
  let messageHandler: ((line: string) => void) | null = null;
  let closeHandler: ((info: { code: number | null }) => void) | null = null;
  const sent: string[] = [];

  const channel: SidecarChannel = {
    send(line: string): void {
      sent.push(line);
      const request = JSON.parse(line) as { id: number; method: string };
      queueMicrotask(() => {
        respond(
          request,
          (responseLine) => messageHandler?.(responseLine),
          (code) => closeHandler?.({ code }),
        );
      });
    },
    onMessage(handler): void {
      messageHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): void {
      closeHandler?.({ code: 0 });
    },
  };

  return { channel, sent };
}

const CEILING = 3;

describe('an answered sidecar error is not a transport failure (#522)', () => {
  it('still contacts the sidecar after more consecutive answered errors than the ceiling', async () => {
    const { channel, sent } = makeCountingChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: 'mesh has no manifold surface',
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    const attempts = CEILING + 3;
    for (let i = 0; i < attempts; i += 1) {
      await expect(client.loadScene(`C:/models/broken-${i}.stl`)).rejects.toThrow(
        SidecarRespondedError,
      );
    }

    // The load-bearing assertion. Every attempt reached the transport; had the
    // answered errors advanced the counter, ensureChannel() would have thrown
    // before `send` on attempt CEILING + 1 and `sent` would be short.
    expect(sent).toHaveLength(attempts);
  });

  it('reports the sidecar-supplied reason, never an availability claim', async () => {
    const { channel } = makeCountingChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: 'mesh has no manifold surface',
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    for (let i = 0; i < CEILING; i += 1) {
      await client.loadScene(`C:/models/broken-${i}.stl`).catch(() => undefined);
    }

    // The attempt that previously crossed the ceiling.
    const error = await client
      .loadScene('C:/models/broken-final.stl')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SidecarRespondedError);
    expect((error as Error).message).toBe('mesh has no manifold surface');
    expect((error as Error).message).not.toMatch(/unavailable/i);
  });

  it('does not let answered errors advance a streak of real transport faults', async () => {
    let mode: 'close' | 'answer' = 'close';
    const { channel, sent } = makeCountingChannel((request, emit, close) => {
      if (mode === 'close') {
        close(1);
        return;
      }
      emit(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: 'mesh has no manifold surface',
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    // One short of the ceiling, from genuine transport faults.
    for (let i = 0; i < CEILING - 1; i += 1) {
      await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
        /sidecar exited/,
      );
    }

    mode = 'answer';
    const beforeAnswers = sent.length;
    for (let i = 0; i < 10; i += 1) {
      await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
        SidecarRespondedError,
      );
    }

    // Ten answered errors must not have moved the streak: all ten dispatched,
    // and an eleventh still reaches the transport.
    expect(sent).toHaveLength(beforeAnswers + 10);
    await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
      SidecarRespondedError,
    );
    expect(sent).toHaveLength(beforeAnswers + 11);
  });

  it('CONTROL: the ceiling still fires for genuinely unreachable faults', async () => {
    const { channel, sent } = makeCountingChannel((_request, _emit, close) => {
      close(1);
    });
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    for (let i = 0; i < CEILING; i += 1) {
      await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
        /sidecar exited/,
      );
    }
    const dispatchedBefore = sent.length;

    await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
      `sidecar unavailable after ${CEILING} consecutive failures`,
    );

    // Supervision is intact: the refused attempt never reached the transport.
    // Without this arm, deleting every recordFailure() call would pass.
    expect(sent).toHaveLength(dispatchedBefore);
  });
});
