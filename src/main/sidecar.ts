import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Supervised client for the Rust `model-core` sidecar.
 *
 * The sidecar is a separate process that speaks newline-delimited JSON-RPC over
 * stdio (see `native/model-core/src/serve.rs`). This client owns its lifecycle:
 * it lazily starts the process, correlates responses to requests by id, times
 * out stuck calls, and transparently restarts a crashed sidecar on the next
 * request (up to a bounded number of consecutive failures).
 *
 * The transport is injected as a {@link ChannelFactory} so the framing and
 * supervision logic can be unit-tested without spawning a real process.
 */

/** A duplex, line-oriented channel to one running sidecar process. */
export interface SidecarChannel {
  /** Send a single request line (no trailing newline required). */
  send(line: string): void;
  /** Register the handler invoked once per received response line. */
  onMessage(handler: (line: string) => void): void;
  /** Register the handler invoked when the process/channel closes. */
  onClose(handler: (info: { code: number | null }) => void): void;
  /** Terminate the channel and its process. */
  close(): void;
}

/** Creates a fresh channel bound to a newly spawned sidecar process. */
export type ChannelFactory = () => SidecarChannel;

interface ResponseEnvelope {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Default per-request timeout. Parsing a very large model can be slow. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** How many times the sidecar may fail to produce a response before we give up. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface SidecarClientOptions {
  requestTimeoutMs?: number;
  maxConsecutiveFailures?: number;
}

export class SidecarClient {
  private channel: SidecarChannel | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private consecutiveFailures = 0;
  private readonly requestTimeoutMs: number;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private readonly createChannel: ChannelFactory,
    options: SidecarClientOptions = {},
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  }

  /** Confirm the sidecar is alive and report its protocol/version. */
  async handshake(): Promise<{
    protocolVersion: number;
    sidecarVersion: string;
  }> {
    const result = (await this.request('handshake', {})) as {
      protocolVersion: number;
      sidecarVersion: string;
    };
    return result;
  }

  /** Parse a model file into a normalized scene mesh (raw wire object). */
  async loadScene(filePath: string): Promise<unknown> {
    return this.request('loadScene', { path: filePath });
  }

  /** Extract slicer-project (vendor) metadata from a 3MF file (raw wire object). */
  async extractVendorMetadata(filePath: string): Promise<unknown> {
    return this.request('extractVendorMetadata', { path: filePath });
  }

  /** Stop the sidecar and reject any in-flight requests. */
  dispose(): void {
    const channel = this.channel;
    this.channel = null;
    this.rejectAllPending(new Error('sidecar client disposed'));
    channel?.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    let channel: SidecarChannel;
    try {
      channel = this.ensureChannel();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.recordFailure();
        reject(new Error(`sidecar request '${method}' timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        channel.send(line);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.recordFailure();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureChannel(): SidecarChannel {
    if (this.channel) {
      return this.channel;
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new Error(
        `sidecar unavailable after ${this.consecutiveFailures} consecutive failures`,
      );
    }

    const channel = this.createChannel();
    channel.onMessage((rawLine) => this.handleMessage(rawLine));
    channel.onClose((info) => this.handleClose(channel, info));
    this.channel = channel;
    return channel;
  }

  private handleMessage(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return;
    }

    let envelope: ResponseEnvelope;
    try {
      envelope = JSON.parse(trimmed) as ResponseEnvelope;
    } catch {
      // A corrupt line is a protocol fault; ignore it rather than crashing.
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.ok) {
      this.consecutiveFailures = 0;
      pending.resolve(envelope.result);
    } else {
      this.recordFailure();
      pending.reject(new Error(envelope.error ?? 'sidecar returned an error'));
    }
  }

  private handleClose(
    closedChannel: SidecarChannel,
    info: { code: number | null },
  ): void {
    // Ignore closes from a channel we already replaced.
    if (this.channel !== closedChannel) {
      return;
    }
    this.channel = null;
    if (this.pending.size > 0) {
      this.recordFailure();
      this.rejectAllPending(
        new Error(
          `sidecar exited (code ${info.code ?? 'unknown'}) with requests in flight`,
        ),
      );
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

/**
 * Resolve the path to the compiled sidecar binary.
 *
 * Priority: an explicit `PRINTFARMER_SIDECAR_PATH` override, then the packaged
 * location under Electron's `resourcesPath`, then the local debug build used
 * during `electron-forge start`.
 */
export function resolveSidecarPath(): string {
  const override = process.env.PRINTFARMER_SIDECAR_PATH;
  if (override && override.length > 0) {
    return override;
  }

  const binaryName =
    process.platform === 'win32' ? 'model-core.exe' : 'model-core';

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    return path.join(resourcesPath, 'sidecar', binaryName);
  }

  return path.resolve(process.cwd(), 'native', 'target', 'debug', binaryName);
}

/**
 * Spawn the real sidecar process and adapt its stdio into a
 * {@link SidecarChannel}. stdout is decoded as UTF-8 and split on newlines;
 * stderr is forwarded to the main-process console for diagnostics.
 */
export function spawnSidecarChannel(binaryPath?: string): SidecarChannel {
  const executable = binaryPath ?? resolveSidecarPath();
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let messageHandler: ((line: string) => void) | null = null;
  let closeHandler: ((info: { code: number | null }) => void) | null = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (messageHandler) {
        messageHandler(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    console.error(`[model-core] ${chunk.trimEnd()}`);
  });

  const emitClose = (code: number | null): void => {
    if (closeHandler) {
      closeHandler({ code });
    }
  };
  child.on('close', (code) => emitClose(code));
  child.on('error', (error) => {
    console.error(`[model-core] failed to start: ${error.message}`);
    emitClose(null);
  });

  return {
    send(line: string): void {
      child.stdin.write(`${line}\n`);
    },
    onMessage(handler: (line: string) => void): void {
      messageHandler = handler;
    },
    onClose(handler: (info: { code: number | null }) => void): void {
      closeHandler = handler;
    },
    close(): void {
      child.kill();
    },
  };
}
