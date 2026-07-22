import { describe, expect, it, vi } from 'vitest';
import {
  SidecarClient,
  resolveSidecarPath,
  type SidecarChannel,
} from '../src/main/sidecar';

/**
 * An in-memory fake sidecar channel. Tests supply a `respond` callback that
 * maps an incoming request line to zero or more response lines, letting us
 * exercise the client's framing and supervision without a real process.
 */
function makeFakeChannel(
  respond: (
    request: { id: number; method: string; params: unknown },
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
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params: unknown;
      };
      // Respond asynchronously, like a real process would.
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

describe('SidecarClient', () => {
  it('resolves a handshake response', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { protocolVersion: 1, sidecarVersion: '0.1.0' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await expect(client.handshake()).resolves.toEqual({
      protocolVersion: 1,
      sidecarVersion: '0.1.0',
    });
  });

  it('sends a well-formed loadScene request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { positions: [0, 0, 0], indices: [], sourceFormat: 'stl' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.loadScene('C:/models/part.stl');
    expect(result).toMatchObject({ sourceFormat: 'stl' });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('loadScene');
    expect(request.params.path).toBe('C:/models/part.stl');
  });

  it('sends a well-formed extractVendorMetadata request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            slicer: 'bambuStudio',
            core: { title: 'Widget' },
            plates: [],
            thumbnails: ['Metadata/plate_1.png'],
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.extractVendorMetadata('C:/models/project.3mf');
    expect(result).toMatchObject({ slicer: 'bambuStudio' });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('extractVendorMetadata');
    expect(request.params.path).toBe('C:/models/project.3mf');
  });

  it('sends a well-formed renderThumbnail request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { width: 64, height: 64, pngBase64: 'iVBORw0KGgo=' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.renderThumbnail('C:/models/part.stl', 64);
    expect(result).toMatchObject({ width: 64, height: 64 });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string; size?: number };
    };
    expect(request.method).toBe('renderThumbnail');
    expect(request.params.path).toBe('C:/models/part.stl');
    expect(request.params.size).toBe(64);
  });

  it('omits the optional size when rendering a thumbnail without one', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { width: 512, height: 512, pngBase64: 'iVBORw0KGgo=' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await client.renderThumbnail('C:/models/part.stl');
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string; size?: number };
    };
    expect(request.params.size).toBeUndefined();
  });

  it('sends a well-formed scanRoot request and resolves the report', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            added: 2,
            changed: 0,
            unchanged: 1,
            missing: 0,
            hashErrors: 0,
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.scanRoot('root1', 'C:/models');
    expect(result).toMatchObject({ added: 2, unchanged: 1 });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { rootId: string; path: string };
    };
    expect(request.method).toBe('scanRoot');
    expect(request.params.rootId).toBe('root1');
    expect(request.params.path).toBe('C:/models');
  });

  it('sends a listModels request and resolves the model array', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: [
            {
              hash: 'abc',
              format: 'stl',
              size: 1024,
              locations: [],
            },
          ],
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.listModels();
    expect(Array.isArray(result)).toBe(true);
    const request = JSON.parse(sent[0] ?? '{}') as { method: string };
    expect(request.method).toBe('listModels');
  });

  it('rejects when the sidecar returns an error envelope', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: 'failed to load scene',
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await expect(client.loadScene('missing.stl')).rejects.toThrow(
      /failed to load scene/,
    );
  });

  it('correlates concurrent requests by id', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      // Reply out of order to prove id-based correlation.
      const delay =
        req.params && (req.params as { path?: string }).path === 'a' ? 20 : 0;
      setTimeout(() => {
        emit(
          JSON.stringify({ id: req.id, ok: true, result: { echoed: req.id } }),
        );
      }, delay);
    });
    const client = new SidecarClient(() => channel);
    const [first, second] = await Promise.all([
      client.loadScene('a'),
      client.loadScene('b'),
    ]);
    expect(first).toEqual({ echoed: 1 });
    expect(second).toEqual({ echoed: 2 });
  });

  it('rejects in-flight requests when the sidecar exits', async () => {
    const { channel } = makeFakeChannel((_req, _emit, close) => {
      close(1);
    });
    const client = new SidecarClient(() => channel);
    await expect(client.loadScene('a')).rejects.toThrow(/sidecar exited/);
  });

  it('times out a request that never gets a response', async () => {
    vi.useFakeTimers();
    const { channel } = makeFakeChannel(() => {
      // Never respond.
    });
    const client = new SidecarClient(() => channel, { requestTimeoutMs: 100 });
    const promise = client.handshake();
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    vi.useRealTimers();
  });

  it('restarts the channel after a crash on the next request', async () => {
    let starts = 0;
    const factory = (): SidecarChannel => {
      starts += 1;
      const startForThisChannel = starts;
      const { channel } = makeFakeChannel((req, emit, close) => {
        if (startForThisChannel === 1) {
          close(1);
        } else {
          emit(
            JSON.stringify({
              id: req.id,
              ok: true,
              result: { protocolVersion: 1, sidecarVersion: '0.1.0' },
            }),
          );
        }
      });
      return channel;
    };
    const client = new SidecarClient(factory);
    await expect(client.handshake()).rejects.toThrow();
    await expect(client.handshake()).resolves.toMatchObject({
      protocolVersion: 1,
    });
    expect(starts).toBe(2);
  });

  it('gives up after too many consecutive failures', async () => {
    const factory = (): SidecarChannel => {
      const { channel } = makeFakeChannel((_req, _emit, close) => close(1));
      return channel;
    };
    const client = new SidecarClient(factory, { maxConsecutiveFailures: 2 });
    await expect(client.handshake()).rejects.toThrow(/exited/);
    await expect(client.handshake()).rejects.toThrow(/exited/);
    await expect(client.handshake()).rejects.toThrow(/unavailable/);
  });
});

describe('resolveSidecarPath', () => {
  it('honors the PRINTFARMER_SIDECAR_PATH override', () => {
    const original = process.env.PRINTFARMER_SIDECAR_PATH;
    process.env.PRINTFARMER_SIDECAR_PATH = '/custom/model-core';
    try {
      expect(resolveSidecarPath()).toBe('/custom/model-core');
    } finally {
      if (original === undefined) {
        delete process.env.PRINTFARMER_SIDECAR_PATH;
      } else {
        process.env.PRINTFARMER_SIDECAR_PATH = original;
      }
    }
  });

  it('falls back to a debug build path with the platform binary name', () => {
    const original = process.env.PRINTFARMER_SIDECAR_PATH;
    delete process.env.PRINTFARMER_SIDECAR_PATH;
    try {
      const resolved = resolveSidecarPath();
      const expectedName =
        process.platform === 'win32' ? 'model-core.exe' : 'model-core';
      expect(resolved).toContain(expectedName);
    } finally {
      if (original !== undefined) {
        process.env.PRINTFARMER_SIDECAR_PATH = original;
      }
    }
  });
});
