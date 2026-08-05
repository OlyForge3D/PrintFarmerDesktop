import { describe, expect, it } from 'vitest';
import {
  SidecarClient,
  SidecarRespondedError,
  type SidecarChannel,
} from '../src/main/sidecar';

/**
 * #522. `consecutiveFailures` gates `ensureChannel()`, which refuses to create a
 * channel once the ceiling is reached and reports "sidecar unavailable after N
 * consecutive failures". An answered error envelope used to advance that
 * counter — so unhappy-but-correct answers silenced a demonstrably healthy
 * sidecar, under a claim that could only be false: the counter could only have
 * reached N because the sidecar answered N times.
 *
 * The distinction is the same one #404 drew one layer up: *could not ask* versus
 * *asked, and was answered*. Here it is behavioural, so these specs assert that
 * a request is DISPATCHED. An error-code assertion would pass against a client
 * that had stopped talking to the sidecar entirely.
 *
 * THE SHAPE OF THIS FILE IS THE RESULT OF A SURVIVING MUTATION. The first
 * version drove answered errors against a channel that stayed open, and M-1
 * survived it green. `ensureChannel()` returns early whenever `this.channel` is
 * set, so the ceiling is never consulted while a channel is alive — the counter
 * can sit far past the ceiling with no observable effect. The defect surfaces
 * only on the first request after the channel is replaced. Every spec below
 * therefore closes the channel before the assertion that matters.
 *
 * Mutations run (each reverted; control green):
 *   M-1  restore `this.recordFailure()` on the answered branch
 *          -> SURVIVED the first draft (see above); RED against this one on all
 *             three non-control specs, naming 'sidecar unavailable after 3'
 *   M-2  delete recordFailure() from ALL five sites (the over-broad "fix")
 *          -> RED, the CONTROL fires: the ceiling never trips for transport
 *             faults. This is what a passing-tests-only reading of #522 ships.
 *   M-3  fake channel resolves every request successfully
 *          -> RED, positive control first: the specs stop observing rejections
 *   CONTROL  all reverted -> GREEN
 */

function makeCountingChannel(
  respond: (
    request: { id: number; method: string },
    emit: (line: string) => void,
    close: (code: number | null) => void,
  ) => void,
): {
  channel: SidecarChannel;
  sent: string[];
  closeFromSidecar: (code: number | null) => void;
} {
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

  return {
    channel,
    sent,
    closeFromSidecar: (code) => closeHandler?.({ code }),
  };
}

const CEILING = 3;
const ANSWERED = 'mesh has no manifold surface';

function answeringChannel() {
  return makeCountingChannel((request, emit) => {
    emit(JSON.stringify({ id: request.id, ok: false, error: ANSWERED }));
  });
}

describe('an answered sidecar error is not a transport failure (#522)', () => {
  it('still contacts the sidecar after the channel is replaced, having answered more errors than the ceiling', async () => {
    const { channel, sent, closeFromSidecar } = answeringChannel();
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    const answers = CEILING + 3;
    for (let i = 0; i < answers; i += 1) {
      await expect(
        client.loadScene(`C:/models/broken-${i}.stl`),
      ).rejects.toThrow(SidecarRespondedError);
    }

    // A clean replacement with nothing in flight: no transport fault is
    // recorded, so the only thing that could refuse the next request is a
    // streak built from answered errors.
    closeFromSidecar(0);

    await expect(client.loadScene('C:/models/next.stl')).rejects.toThrow(
      SidecarRespondedError,
    );
    // Load-bearing: the request reached the transport rather than being
    // refused by the ceiling.
    expect(sent).toHaveLength(answers + 1);
  });

  it('reports the sidecar-supplied reason, never an availability claim', async () => {
    const { channel, closeFromSidecar } = answeringChannel();
    const client = new SidecarClient(() => channel, {
      maxConsecutiveFailures: CEILING,
    });

    for (let i = 0; i < CEILING; i += 1) {
      await client
        .loadScene(`C:/models/broken-${i}.stl`)
        .catch(() => undefined);
    }
    closeFromSidecar(0);

    const error = await client
      .loadScene('C:/models/broken-final.stl')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SidecarRespondedError);
    expect((error as Error).message).toBe(ANSWERED);
    expect((error as Error).message).not.toMatch(/unavailable/i);
  });

  it('does not let answered errors advance a streak of real transport faults', async () => {
    let mode: 'close' | 'answer' = 'close';
    const { channel, sent, closeFromSidecar } = makeCountingChannel(
      (request, emit, close) => {
        if (mode === 'close') {
          close(1);
          return;
        }
        emit(JSON.stringify({ id: request.id, ok: false, error: ANSWERED }));
      },
    );
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
    for (let i = 0; i < 10; i += 1) {
      await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
        SidecarRespondedError,
      );
    }
    const dispatchedBefore = sent.length;
    closeFromSidecar(0);

    // Ten answered errors must not push a streak of two past a ceiling of three.
    await expect(client.loadScene('C:/models/part.stl')).rejects.toThrow(
      SidecarRespondedError,
    );
    expect(sent).toHaveLength(dispatchedBefore + 1);
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

    // Supervision is intact, and the refused attempt never reached the
    // transport. Without this arm, deleting every recordFailure() call passes.
    expect(sent).toHaveLength(dispatchedBefore);
  });
});
