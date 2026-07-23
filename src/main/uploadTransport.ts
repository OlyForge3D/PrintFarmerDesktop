import { createReadStream, promises as fs } from 'node:fs';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RemoteUploadResult, type UploadError } from '@shared/ipc';

export const MAX_UPLOAD_REQUEST_BYTES = 512_000_000;
export const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

const ModernUploadResponse = RemoteUploadResult.extend({
  etag: z.string().min(1).max(1024),
}).strict();
const LegacyUploadResponse = z
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

export class ModelUploadError extends Error {
  constructor(
    readonly detail: UploadError,
    override readonly cause?: unknown,
  ) {
    super(detail.message);
    this.name = 'ModelUploadError';
  }
}

export interface UploadTransportRequest {
  baseUrl: string;
  token: string;
  modelPath: string;
  displayName: string;
  modelSize: number;
  clientUploadId: string;
  mode: 'modern' | 'legacyModelOnly';
  thumbnail?: Buffer;
  signal: AbortSignal;
  onProgress(bytesSent: number): void;
}

export type UploadTransport = (
  request: UploadTransportRequest,
) => Promise<z.infer<typeof RemoteUploadResult>>;

export interface NodeUploadTransportOptions {
  uploadTimeoutMs?: number;
  responseTimeoutMs?: number;
  request?: typeof httpRequest;
  secureRequest?: typeof httpsRequest;
}

export function createNodeUploadTransport(
  options: NodeUploadTransportOptions = {},
): UploadTransport {
  return async (input) => {
    if (input.signal.aborted) {
      throw uploadError('ABORTED', 'The upload was stopped.', true, undefined, {
        duplicateRisk: input.mode === 'legacyModelOnly',
      });
    }
    const target = new URL('/api/3d-models/upload', input.baseUrl);
    const boundary = `----PrintFarmerDesktop${randomBytes(18).toString('hex')}`;
    const filename = sanitizeMultipartFilename(input.displayName);
    const modelType = contentTypeFor(filename);
    const modelHeader = partHeader(boundary, 'modelFile', filename, modelType);
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
    const thumbnailTail = input.thumbnail ? Buffer.from('\r\n') : null;
    const contentLength =
      modelHeader.length +
      input.modelSize +
      2 +
      (thumbnailHeader?.length ?? 0) +
      (input.thumbnail?.length ?? 0) +
      (thumbnailTail?.length ?? 0) +
      (clientIdPart?.length ?? 0) +
      end.length;
    if (contentLength > MAX_UPLOAD_REQUEST_BYTES) {
      throw uploadError(
        'PAYLOAD_TOO_LARGE',
        `The multipart upload is ${contentLength.toLocaleString()} bytes and exceeds the server's 512,000,000-byte request limit.`,
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

    return new Promise((resolve, reject) => {
      let settled = false;
      let uploadTimer: ReturnType<typeof setTimeout> | null = null;
      let responseTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        error: Error | null,
        value?: z.infer<typeof RemoteUploadResult>,
      ): void => {
        if (settled) return;
        settled = true;
        if (uploadTimer) clearTimeout(uploadTimer);
        if (responseTimer) clearTimeout(responseTimer);
        input.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const req = requestImpl(requestOptions, (response) => {
        if (uploadTimer) clearTimeout(uploadTimer);
        responseTimer = setTimeout(() => {
          req.destroy(new Error('response timeout'));
          finish(
            uploadError(
              'RESPONSE_TIMEOUT',
              'The server did not finish its response in time.',
              true,
            ),
          );
        }, options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response too large'));
            finish(
              uploadError(
                'RESPONSE_TOO_LARGE',
                'The server response exceeded the 256 KiB safety limit.',
                false,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status !== 201) {
            finish(
              httpStatusError(status, body, response.headers['retry-after']),
            );
            return;
          }
          try {
            const raw: unknown = JSON.parse(body);
            const etagHeader = headerValue(response.headers.etag);
            if (input.mode === 'modern') {
              const candidate =
                raw && typeof raw === 'object' && etagHeader
                  ? { ...(raw as Record<string, unknown>), etag: etagHeader }
                  : raw;
              finish(null, ModernUploadResponse.parse(candidate));
              return;
            }
            const legacy = LegacyUploadResponse.parse(raw);
            const uploadedAt = legacy.uploadedAt ?? new Date().toISOString();
            const normalized = RemoteUploadResult.parse({
              id: legacy.id,
              name: legacy.name ?? filename,
              fileName: legacy.fileName ?? filename,
              fileSize: legacy.fileSize ?? input.modelSize,
              fileType:
                legacy.fileType ?? extname(filename).slice(1).toLowerCase(),
              uploadedAt,
              url: legacy.url ?? '',
              thumbnailUrl: legacy.thumbnailUrl ?? null,
              wasExisting: false,
              clientUploadId: null,
              etag: etagHeader ?? legacy.etag ?? null,
            });
            finish(null, normalized);
          } catch (error) {
            finish(
              uploadError(
                'INVALID_RESPONSE',
                'The server returned 201 but its upload result was invalid.',
                false,
                error,
              ),
            );
          }
        });
      });
      const abort = (): void => {
        req.destroy(new Error('upload aborted'));
        finish(
          uploadError('ABORTED', 'The upload was stopped.', true, undefined, {
            duplicateRisk: input.mode === 'legacyModelOnly',
          }),
        );
      };
      input.signal.addEventListener('abort', abort, { once: true });
      req.on('error', (error) => {
        if (settled) return;
        finish(
          uploadError(
            'TRANSPORT_ERROR',
            'The upload connection failed.',
            true,
            error,
            { duplicateRisk: input.mode === 'legacyModelOnly' },
          ),
        );
      });
      uploadTimer = setTimeout(() => {
        req.destroy(new Error('upload timeout'));
        finish(
          uploadError(
            'UPLOAD_TIMEOUT',
            'The upload did not complete in time.',
            true,
            undefined,
            { duplicateRisk: input.mode === 'legacyModelOnly' },
          ),
        );
      }, options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);

      void (async () => {
        try {
          await writeChunk(req, modelHeader);
          const stream = createReadStream(input.modelPath, {
            highWaterMark: 64 * 1024,
          });
          const stopStream = (): void => {
            stream.destroy(new Error('aborted'));
          };
          input.signal.addEventListener('abort', stopStream, { once: true });
          let sent = 0;
          try {
            for await (const chunk of stream as AsyncIterable<Buffer>) {
              await writeChunk(req, chunk);
              sent += chunk.length;
              input.onProgress(sent);
            }
          } finally {
            input.signal.removeEventListener('abort', stopStream);
          }
          await writeChunk(req, Buffer.from('\r\n'));
          if (thumbnailHeader && input.thumbnail && thumbnailTail) {
            await writeChunk(req, thumbnailHeader);
            await writeChunk(req, input.thumbnail);
            await writeChunk(req, thumbnailTail);
          }
          if (clientIdPart) await writeChunk(req, clientIdPart);
          req.end(end);
        } catch (error) {
          req.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      })();
    });
  };
}

async function writeChunk(
  request: ReturnType<typeof httpRequest>,
  chunk: Buffer,
): Promise<void> {
  if (!request.write(chunk)) await once(request, 'drain');
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
): ModelUploadError {
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  const message = safeServerMessage(body);
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
  return uploadError(
    mapped[0],
    message ? `${mapped[1]} ${message}` : mapped[1],
    mapped[2],
    undefined,
    { retryAfterSeconds },
  );
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

function safeServerMessage(body: string): string {
  if (!body) return '';
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    const message =
      typeof raw.message === 'string'
        ? raw.message
        : typeof raw.error === 'string'
          ? raw.error
          : '';
    return scrubSensitiveText(message).slice(0, 300);
  } catch {
    return '';
  }
}

export function scrubSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)+[^\\\s"'<>|]*/g, '[local file]')
    .replace(/\/(?:home|Users)\/[^\s"'<>]+/g, '[local file]')
    .replace(
      /(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    );
}

function uploadError(
  code: string,
  message: string,
  retryable: boolean,
  cause?: unknown,
  overrides: Partial<UploadError> = {},
): ModelUploadError {
  return new ModelUploadError(
    {
      code,
      message: scrubSensitiveText(message).slice(0, 1024),
      retryable,
      retryAfterSeconds: null,
      duplicateRisk: false,
      ...overrides,
    },
    cause,
  );
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function validateThumbnailPng(buffer: Buffer): Promise<void> {
  await Promise.resolve();
  if (buffer.length > MAX_THUMBNAIL_BYTES) {
    throw uploadError(
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
    throw uploadError(
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
    throw uploadError(
      'INVALID_THUMBNAIL',
      'The thumbnail dimensions exceed server limits.',
      false,
    );
  }
}

export async function stableFileStat(filePath: string): Promise<{
  size: number;
  mtimeMs: number;
}> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw uploadError(
      'FILE_UNAVAILABLE',
      'The catalog location is not a file.',
      false,
    );
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}
