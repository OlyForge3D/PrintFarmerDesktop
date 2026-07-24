import { createReadStream } from 'node:fs';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RemoteUploadResult, type UploadError } from '@shared/ipc';

export const MAX_UPLOAD_REQUEST_BYTES = 512_000_000;
export const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

const ModernWireResponse = z
  .object({
    id: z.string().min(1).max(256).refine(noControlCharacters),
    name: z.string().min(1).max(1024),
    fileName: z.string().min(1).max(1024),
    fileSize: z.number().int().nonnegative(),
    fileType: z.string().min(1).max(128),
    uploadedAt: z.string().datetime(),
    url: z.string().max(4096),
    thumbnailUrl: z.string().max(4096).nullable(),
    wasExisting: z.boolean(),
    clientUploadId: z.string().uuid(),
    etag: z.string().min(1).max(1024).refine(noControlCharacters),
  })
  .passthrough();

const LegacyWireResponse = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().int().nonnegative().optional(),
    fileType: z.string().optional(),
    uploadedAt: z.string().datetime().optional(),
    url: z.string().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    etag: z.string().optional(),
  })
  .passthrough();

export type UploadRequestPhase =
  | 'notStarted'
  | 'headersSent'
  | 'modelStreaming'
  | 'bodyComplete'
  | 'responseReceived';

export class ModelUploadError extends Error {
  constructor(
    readonly detail: UploadError,
    readonly phase: UploadRequestPhase = 'notStarted',
    override readonly cause?: unknown,
  ) {
    super(detail.message);
    this.name = 'ModelUploadError';
  }

  get bytesMayHaveReachedServer(): boolean {
    return (
      this.phase === 'modelStreaming' ||
      this.phase === 'bodyComplete' ||
      this.phase === 'responseReceived'
    );
  }
}

export interface UploadTransportRequest {
  endpoint: string;
  token: string;
  modelPath: string;
  displayName: string;
  modelSize: number;
  clientUploadId: string;
  mode: 'modern' | 'legacyModelOnly';
  thumbnail?: Buffer;
  signal: AbortSignal;
  onProgress(bytesSent: number): void | Promise<void>;
}

export type UploadTransport = (
  request: UploadTransportRequest,
) => Promise<z.infer<typeof RemoteUploadResult>>;

export interface NodeUploadTransportOptions {
  uploadTimeoutMs?: number;
  responseTimeoutMs?: number;
  request?: typeof httpRequest;
  secureRequest?: typeof httpsRequest;
  createReadStream?: typeof createReadStream;
}

interface WriterState {
  phase: UploadRequestPhase;
  stream: ReturnType<typeof createReadStream> | null;
  stopped: boolean;
  stopPromise: Promise<void>;
  resolveStop(): void;
}

export function createNodeUploadTransport(
  options: NodeUploadTransportOptions = {},
): UploadTransport {
  return async (input) => {
    if (input.signal.aborted) {
      throw makeUploadError('ABORTED', 'The upload was stopped.', true);
    }
    const target = validateEndpoint(input.endpoint);
    const boundary = `----PrintFarmerDesktop${randomBytes(18).toString('hex')}`;
    const filename = sanitizeMultipartFilename(input.displayName);
    const modelHeader = partHeader(
      boundary,
      'modelFile',
      filename,
      contentTypeFor(filename),
    );
    const thumbnailHeader = input.thumbnail
      ? partHeader(boundary, 'thumbnailFile', 'thumbnail.png', 'image/png')
      : null;
    const clientIdPart =
      input.mode === 'modern'
        ? Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="clientUploadId"\r\n\r\n${input.clientUploadId}\r\n`,
          )
        : null;
    const end = Buffer.from(`--${boundary}--\r\n`);
    const contentLength =
      modelHeader.length +
      input.modelSize +
      2 +
      (thumbnailHeader?.length ?? 0) +
      (input.thumbnail?.length ?? 0) +
      (input.thumbnail ? 2 : 0) +
      (clientIdPart?.length ?? 0) +
      end.length;
    if (contentLength > MAX_UPLOAD_REQUEST_BYTES) {
      throw makeUploadError(
        'PAYLOAD_TOO_LARGE',
        'The multipart request exceeds the server upload limit.',
        false,
      );
    }

    const requestOptions: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(contentLength),
        accept: 'application/json',
      },
    };
    const requestImpl =
      target.protocol === 'https:'
        ? (options.secureRequest ?? httpsRequest)
        : (options.request ?? httpRequest);
    let resolveStop: () => void = () => undefined;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const state: WriterState = {
      phase: 'notStarted',
      stream: null,
      stopped: false,
      stopPromise,
      resolveStop,
    };
    let response: IncomingMessage | null = null;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;
    let settleOutcome: (
      outcome: Error | z.infer<typeof RemoteUploadResult>,
    ) => void = () => undefined;
    const outcomePromise = new Promise<
      Error | z.infer<typeof RemoteUploadResult>
    >((resolve) => {
      settleOutcome = resolve;
    });
    let outcomeSettled = false;
    const settle = (
      outcome: Error | z.infer<typeof RemoteUploadResult>,
    ): void => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      settleOutcome(outcome);
    };
    const stopWriter = (reason: Error, destroyRequest: boolean): void => {
      if (!state.stopped) state.resolveStop();
      state.stopped = true;
      state.stream?.destroy(reason);
      if (destroyRequest && !req.destroyed) req.destroy(reason);
    };

    const req = requestImpl(requestOptions, (incoming) => {
      response = incoming;
      const responseArrivedEarly = state.phase !== 'bodyComplete';
      state.phase = 'responseReceived';
      clearTimeout(uploadTimer);
      responseTimer = setTimeout(() => {
        stopWriter(new Error('response timeout'), true);
        incoming.destroy();
        settle(
          makeUploadError(
            'RESPONSE_TIMEOUT',
            'The server did not finish its response in time.',
            true,
            state.phase,
            { duplicateRisk: input.mode === 'legacyModelOnly' },
          ),
        );
      }, options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
      if (responseArrivedEarly) {
        stopWriter(
          new Error('server responded before request body completed'),
          false,
        );
      }
      void readResponse(incoming, input, filename)
        .then((result) =>
          settle(
            responseArrivedEarly
              ? makeUploadError(
                  'INVALID_RESPONSE',
                  'The server reported success before receiving the complete request.',
                  input.mode === 'modern',
                  'responseReceived',
                  { duplicateRisk: input.mode === 'legacyModelOnly' },
                )
              : result,
          ),
        )
        .catch((error: unknown) => {
          settle(
            error instanceof ModelUploadError
              ? error
              : makeUploadError(
                  'TRANSPORT_ERROR',
                  'The server response connection failed.',
                  true,
                  state.phase,
                  { duplicateRisk: input.mode === 'legacyModelOnly' },
                  error,
                ),
          );
        });
    });
    state.phase = 'headersSent';
    req.on('error', () => {
      settle(
        makeUploadError(
          'TRANSPORT_ERROR',
          'The upload connection failed.',
          true,
          state.phase,
          { duplicateRisk: input.mode === 'legacyModelOnly' },
        ),
      );
    });
    const abort = (): void => {
      stopWriter(new Error('upload aborted'), true);
      response?.destroy();
      settle(
        makeUploadError(
          'ABORTED',
          'The upload was stopped.',
          true,
          state.phase,
          {
            duplicateRisk: input.mode === 'legacyModelOnly',
          },
        ),
      );
    };
    input.signal.addEventListener('abort', abort, { once: true });
    const uploadTimer = setTimeout(() => {
      stopWriter(new Error('upload timeout'), true);
      response?.destroy();
      settle(
        makeUploadError(
          'UPLOAD_TIMEOUT',
          'The upload did not complete in time.',
          true,
          state.phase,
          { duplicateRisk: input.mode === 'legacyModelOnly' },
        ),
      );
    }, options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);

    const writerPromise = writeMultipart(
      req,
      state,
      input,
      modelHeader,
      thumbnailHeader,
      clientIdPart,
      end,
      options.createReadStream ?? createReadStream,
    ).catch((error: unknown) => {
      if (!outcomeSettled && !state.stopped) {
        settle(
          makeUploadError(
            'SOURCE_READ_FAILED',
            'The private upload snapshot could not be read completely.',
            false,
            state.phase,
            {},
            error,
          ),
        );
      }
    });

    const outcome = await outcomePromise;
    stopWriter(new Error('upload settled'), outcome instanceof Error);
    await writerPromise;
    clearTimeout(uploadTimer);
    if (responseTimer) clearTimeout(responseTimer);
    input.signal.removeEventListener('abort', abort);
    if (!req.destroyed && outcome instanceof Error) req.destroy();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

async function writeMultipart(
  request: ClientRequest,
  state: WriterState,
  input: UploadTransportRequest,
  modelHeader: Buffer,
  thumbnailHeader: Buffer | null,
  clientIdPart: Buffer | null,
  end: Buffer,
  streamFactory: typeof createReadStream,
): Promise<void> {
  if (state.stopped) return;
  await writeChunk(request, modelHeader);
  if (state.stopped) return;
  state.phase = 'modelStreaming';
  const stream = streamFactory(input.modelPath, { highWaterMark: 64 * 1024 });
  state.stream = stream;
  let sent = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (state.stopped) break;
      sent += chunk.length;
      if (sent > input.modelSize) {
        throw new Error('snapshot grew');
      }
      await writeChunk(request, chunk);
      const progress = Promise.resolve(input.onProgress(sent)).then(
        () => 'completed' as const,
      );
      const progressResult = await Promise.race([
        progress,
        state.stopPromise.then(() => 'stopped' as const),
      ]);
      if (progressResult === 'stopped') return;
    }
  } finally {
    state.stream = null;
  }
  if (state.stopped) return;
  if (sent !== input.modelSize) throw new Error('snapshot length mismatch');
  if (!(await writeTailChunk(request, state, Buffer.from('\r\n')))) return;
  if (thumbnailHeader && input.thumbnail) {
    if (!(await writeTailChunk(request, state, thumbnailHeader))) return;
    if (!(await writeTailChunk(request, state, input.thumbnail))) return;
    if (!(await writeTailChunk(request, state, Buffer.from('\r\n')))) return;
  }
  if (clientIdPart && !(await writeTailChunk(request, state, clientIdPart)))
    return;
  if (state.stopped) return;
  state.phase = 'bodyComplete';
  request.end(end);
}

async function writeTailChunk(
  request: ClientRequest,
  state: WriterState,
  chunk: Buffer,
): Promise<boolean> {
  if (state.stopped) return false;
  await writeChunk(request, chunk);
  return !state.stopped;
}

function writeChunk(request: ClientRequest, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    request.write(chunk, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readResponse(
  response: IncomingMessage,
  input: UploadTransportRequest,
  filename: string,
): Promise<z.infer<typeof RemoteUploadResult>> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw makeUploadError(
        'RESPONSE_TOO_LARGE',
        'The server response exceeded the safety limit.',
        false,
        'responseReceived',
      );
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const status = response.statusCode ?? 0;
  if (status !== 201) {
    throw httpStatusError(
      status,
      body,
      response.headers['retry-after'],
      'responseReceived',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw makeUploadError(
      'INVALID_RESPONSE',
      'The server returned 201 with invalid JSON.',
      input.mode === 'modern',
      'responseReceived',
      { duplicateRisk: input.mode === 'legacyModelOnly' },
    );
  }
  const etagHeader = headerValue(response.headers.etag);
  if (input.mode === 'modern') {
    const parsed = ModernWireResponse.safeParse(
      raw && typeof raw === 'object' && etagHeader
        ? { ...(raw as Record<string, unknown>), etag: etagHeader }
        : raw,
    );
    if (
      !parsed.success ||
      parsed.data.clientUploadId !== input.clientUploadId
    ) {
      throw makeUploadError(
        'INVALID_RESPONSE',
        'The server returned an upload identity that did not match this request.',
        true,
        'responseReceived',
      );
    }
    const value = parsed.data;
    return RemoteUploadResult.parse({
      id: value.id,
      name: value.name,
      fileName: value.fileName,
      fileSize: value.fileSize,
      fileType: value.fileType,
      uploadedAt: value.uploadedAt,
      url: value.url,
      thumbnailUrl: value.thumbnailUrl,
      wasExisting: value.wasExisting,
      clientUploadId: value.clientUploadId,
      etag: value.etag,
    });
  }
  const parsed = LegacyWireResponse.safeParse(raw);
  if (!parsed.success) {
    throw makeUploadError(
      'INVALID_RESPONSE',
      'The legacy server returned an invalid upload result.',
      false,
      'responseReceived',
      { duplicateRisk: true },
    );
  }
  const legacy = parsed.data;
  return RemoteUploadResult.parse({
    id: legacy.id,
    name: legacy.name ?? filename,
    fileName: legacy.fileName ?? filename,
    fileSize: legacy.fileSize ?? input.modelSize,
    fileType: legacy.fileType ?? extname(filename).slice(1).toLowerCase(),
    uploadedAt: legacy.uploadedAt ?? new Date().toISOString(),
    url: legacy.url ?? '',
    thumbnailUrl: legacy.thumbnailUrl ?? null,
    wasExisting: false,
    clientUploadId: null,
    etag: etagHeader ?? legacy.etag ?? null,
  });
}

function validateEndpoint(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw makeUploadError(
      'INVALID_ENDPOINT',
      'The authenticated upload endpoint is invalid.',
      false,
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    throw makeUploadError(
      'INVALID_ENDPOINT',
      'The authenticated upload endpoint is invalid.',
      false,
    );
  }
  return parsed;
}

function partHeader(
  boundary: string,
  field: string,
  filename: string,
  contentType: string,
): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${sanitizeMultipartFilename(filename)}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
}

export function sanitizeMultipartFilename(value: string): string {
  const normalized = Array.from(basename(value).normalize('NFKC'))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('');
  const safe = normalized
    .replace(/["\\/]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 240)
    .trim();
  return safe || 'model.bin';
}

function contentTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.stl':
      return 'model/stl';
    case '.3mf':
      return 'model/3mf';
    case '.obj':
      return 'model/obj';
    default:
      return 'application/octet-stream';
  }
}

function httpStatusError(
  status: number,
  body: string,
  retryAfterHeader: string | string[] | undefined,
  phase: UploadRequestPhase,
): ModelUploadError {
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  void body;
  const descriptions: Record<number, [string, string, boolean]> = {
    400: ['BAD_REQUEST', 'The server rejected the upload request.', false],
    401: ['UNAUTHENTICATED', 'Authentication expired or was rejected.', true],
    403: ['FORBIDDEN', 'This account cannot upload models.', false],
    404: ['NOT_FOUND', 'The server upload endpoint was not found.', false],
    409: ['CONFLICT', 'The upload conflicts with an existing model.', false],
    412: [
      'PRECONDITION_FAILED',
      'The server rejected an upload precondition.',
      false,
    ],
    413: [
      'PAYLOAD_TOO_LARGE',
      'The model is too large for this server.',
      false,
    ],
    415: [
      'UNSUPPORTED_MEDIA_TYPE',
      'The server does not support this model format.',
      false,
    ],
    422: [
      'UNPROCESSABLE_ENTITY',
      'The server could not process this model.',
      false,
    ],
    408: ['REQUEST_TIMEOUT', 'The server timed out this request.', true],
    425: ['TOO_EARLY', 'The server asked the client to retry later.', true],
    429: ['RATE_LIMITED', 'The server is rate limiting uploads.', true],
  };
  const mapped =
    descriptions[status] ??
    (status >= 500
      ? ([
          'SERVER_ERROR',
          `The server failed with HTTP ${status}.`,
          true,
        ] as const)
      : ([
          'HTTP_ERROR',
          `The server returned HTTP ${status}.`,
          false,
        ] as const));
  return makeUploadError(mapped[0], mapped[1], mapped[2], phase, {
    retryAfterSeconds,
  });
}

export function parseRetryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw.trim()), 86_400);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, Math.ceil((date - now) / 1000)), 86_400);
}

/** Convert an untrusted local error into a path- and secret-free message. */
export function scrubSensitiveText(message: string): string {
  void message;
  return 'The upload failed before a trusted result was available.';
}

export function makeUploadError(
  code: string,
  message: string,
  retryable: boolean,
  phase: UploadRequestPhase = 'notStarted',
  overrides: Partial<UploadError> = {},
  cause?: unknown,
): ModelUploadError {
  return new ModelUploadError(
    {
      code,
      message: message.slice(0, 1024),
      retryable,
      retryAfterSeconds: null,
      duplicateRisk: false,
      ...overrides,
    },
    phase,
    cause,
  );
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function noControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

export function validateThumbnailPng(buffer: Buffer): void {
  if (buffer.length > MAX_THUMBNAIL_BYTES) {
    throw makeUploadError(
      'INVALID_THUMBNAIL',
      'The thumbnail exceeds 10 MiB.',
      false,
    );
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, signature.length).equals(signature) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw makeUploadError(
      'INVALID_THUMBNAIL',
      'The thumbnail is not a valid PNG.',
      false,
    );
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 16_000_000
  ) {
    throw makeUploadError(
      'INVALID_THUMBNAIL',
      'The thumbnail dimensions exceed server limits.',
      false,
    );
  }
}
