import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeUploadTransport,
  MAX_THUMBNAIL_BYTES,
  MAX_UPLOAD_MODEL_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  multipartRequestBytes,
  parseRetryAfter,
  sanitizeMultipartFilename,
  validateThumbnailPng,
} from '../src/main/uploadTransport.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('streaming multipart upload transport', () => {
  it('streams exact modern fields with content length and parses ETag', async () => {
    const modelPath = path.resolve('package.json');
    const stat = await fs.stat(modelPath);
    let body = Buffer.alloc(0);
    let declaredLength = '';
    let requestedPath = '';
    const baseUrl = await listen((request, response) => {
      requestedPath = request.url ?? '';
      declaredLength = String(request.headers['content-length']);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        body = Buffer.concat(chunks);
        response.writeHead(201, {
          'content-type': 'application/json',
          etag: '"server-etag"',
          location: '/api/models/wrong-location',
        });
        response.end(
          JSON.stringify({
            id: 'remote-1',
            name: 'package.json',
            fileName: 'package.json',
            fileSize: stat.size,
            fileType: 'obj',
            uploadedAt: '2026-07-23T20:00:00.000Z',
            url: '/models/remote-1',
            thumbnailUrl: null,
            wasExisting: false,
            clientUploadId: '11111111-1111-4111-8111-111111111111',
            etag: '"body-etag"',
            additiveFutureField: { supported: true },
          }),
        );
      });
    });
    const progress: number[] = [];
    const result = await createNodeUploadTransport()({
      endpoint: `${baseUrl}/proxy/api/3d-models/upload`,
      token: 'not-a-real-token',
      modelPath,
      displayName: 'bad"\r\nname.obj',
      modelSize: stat.size,
      clientUploadId: '11111111-1111-4111-8111-111111111111',
      mode: 'modern',
      thumbnail: png(1, 1),
      signal: new AbortController().signal,
      onProgress: (bytes) => {
        progress.push(bytes);
      },
    });
    const multipart = body.toString('latin1');
    expect(Number(declaredLength)).toBe(body.length);
    expect(requestedPath).toBe('/proxy/api/3d-models/upload');
    expect(multipart).toContain('name="modelFile"');
    expect(multipart).toContain('name="thumbnailFile"');
    expect(multipart).toContain('name="clientUploadId"');
    expect(multipart).not.toContain('\r\nname.obj"\r\n');
    expect(progress.at(-1)).toBe(stat.size);
    expect(result.etag).toBe('"server-etag"');
  });

  it('accepts the exact model limit and rejects the first byte over it', async () => {
    const clientUploadId = '11111111-1111-4111-8111-111111111111';
    const displayName = `${'x'.repeat(1_020)}.stl`;
    const exactRequestBytes = multipartRequestBytes({
      displayName,
      modelSize: MAX_UPLOAD_MODEL_BYTES,
      clientUploadId,
      mode: 'modern',
      thumbnailBytes: MAX_THUMBNAIL_BYTES,
    });
    expect(exactRequestBytes).toBeLessThanOrEqual(MAX_UPLOAD_REQUEST_BYTES);

    const requestAccepted = new Error('request accepted');
    let requestAttempts = 0;
    const request = (() => {
      requestAttempts += 1;
      throw requestAccepted;
    }) as unknown as typeof import('node:http').request;
    const transport = createNodeUploadTransport({ request });
    const exactInput = {
      endpoint: 'http://127.0.0.1/upload',
      token: 'token',
      modelPath: 'private-snapshot',
      displayName,
      modelSize: MAX_UPLOAD_MODEL_BYTES,
      clientUploadId,
      mode: 'modern' as const,
      thumbnail: Buffer.alloc(MAX_THUMBNAIL_BYTES),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    };

    await expect(transport(exactInput)).rejects.toBe(requestAccepted);
    await expect(
      transport({
        ...exactInput,
        modelSize: MAX_UPLOAD_MODEL_BYTES + 1,
      }),
    ).rejects.toMatchObject({
      detail: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(requestAttempts).toBe(1);
  });

  it('calculates the exact multipart request boundary without materializing it', () => {
    const input = {
      displayName: 'model.stl',
      modelSize: 0,
      clientUploadId: '11111111-1111-4111-8111-111111111111',
      mode: 'modern' as const,
    };
    const envelopeBytes = multipartRequestBytes(input);
    const exactModelBytes = MAX_UPLOAD_REQUEST_BYTES - envelopeBytes;

    expect(
      multipartRequestBytes({ ...input, modelSize: exactModelBytes }),
    ).toBe(MAX_UPLOAD_REQUEST_BYTES);
    expect(
      multipartRequestBytes({ ...input, modelSize: exactModelBytes + 1 }),
    ).toBe(MAX_UPLOAD_REQUEST_BYTES + 1);
  });

  it.each([401, 413])(
    'tears down the writer before releasing an early HTTP %s response',
    async (status) => {
      const baseUrl = await listen((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'rejected' }));
      });
      let reads = 0;
      let destroyed = false;
      class CountingStream extends Readable {
        override _read(): void {
          setImmediate(() => {
            if (this.destroyed || reads >= 1024) {
              if (!this.destroyed) this.push(null);
              return;
            }
            reads += 1;
            this.push(Buffer.alloc(64 * 1024));
          });
        }

        override _destroy(
          error: Error | null,
          callback: (error?: Error | null) => void,
        ): void {
          destroyed = true;
          callback(error);
        }
      }
      const createStream = (() =>
        new CountingStream()) as unknown as typeof import('node:fs').createReadStream;
      await expect(
        createNodeUploadTransport({ createReadStream: createStream })({
          endpoint: `${baseUrl}/proxy/api/3d-models/upload`,
          token: 'token',
          modelPath: 'private-snapshot',
          displayName: 'large.stl',
          modelSize: 64 * 1024 * 1024,
          clientUploadId: '11111111-1111-4111-8111-111111111111',
          mode: 'modern',
          signal: new AbortController().signal,
          onProgress: () => undefined,
        }),
      ).rejects.toMatchObject({
        detail: {
          code: status === 401 ? 'UNAUTHENTICATED' : 'PAYLOAD_TOO_LARGE',
        },
      });
      expect(destroyed).toBe(true);
      const readsAtRelease = reads;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads).toBe(readsAtRelease);
    },
  );

  it('treats a mismatched modern upload identity as recoverable ambiguity', async () => {
    const modelPath = path.resolve('package.json');
    const stat = await fs.stat(modelPath);
    const baseUrl = await listen((request, response) => {
      request.resume();
      response.writeHead(201, {
        'content-type': 'application/json',
        etag: '"etag"',
      });
      response.end(
        JSON.stringify({
          id: 'remote',
          name: 'model',
          fileName: 'model.stl',
          fileSize: stat.size,
          fileType: 'stl',
          uploadedAt: '2026-07-23T20:00:00.000Z',
          url: '/models/remote',
          thumbnailUrl: null,
          wasExisting: false,
          clientUploadId: '22222222-2222-4222-8222-222222222222',
          etag: '"etag"',
        }),
      );
    });
    await expect(
      createNodeUploadTransport()({
        endpoint: `${baseUrl}/api/3d-models/upload`,
        token: 'token',
        modelPath,
        displayName: 'model.stl',
        modelSize: stat.size,
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        mode: 'modern',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({
      detail: { code: 'INVALID_RESPONSE', retryable: true },
      phase: 'responseReceived',
    });
  });

  it('times out and tears down even when an async progress callback hangs', async () => {
    const modelPath = path.resolve('package.json');
    const stat = await fs.stat(modelPath);
    const baseUrl = await listen((request, response) => {
      void response;
      request.resume();
    });
    await expect(
      createNodeUploadTransport({ uploadTimeoutMs: 20 })({
        endpoint: `${baseUrl}/api/3d-models/upload`,
        token: 'token',
        modelPath,
        displayName: 'model.stl',
        modelSize: stat.size,
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        mode: 'modern',
        signal: new AbortController().signal,
        onProgress: () => new Promise<void>(() => undefined),
      }),
    ).rejects.toMatchObject({
      detail: { code: 'UPLOAD_TIMEOUT' },
    });
  });

  it('omits clientUploadId and thumbnail fields for legacy fallback', async () => {
    const modelPath = path.resolve('package.json');
    const stat = await fs.stat(modelPath);
    let body = '';
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        body = Buffer.concat(chunks).toString('latin1');
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 42 }));
      });
    });
    const result = await createNodeUploadTransport()({
      endpoint: `${baseUrl}/api/3d-models/upload`,
      token: 'token',
      modelPath,
      displayName: 'model.stl',
      modelSize: stat.size,
      clientUploadId: '11111111-1111-4111-8111-111111111111',
      mode: 'legacyModelOnly',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(body).toContain('name="modelFile"');
    expect(body).not.toContain('name="thumbnailFile"');
    expect(body).not.toContain('name="clientUploadId"');
    expect(result).toMatchObject({
      id: '42',
      clientUploadId: null,
      wasExisting: false,
    });
  });

  it('maps rate limiting and bounded invalid success responses explicitly', async () => {
    const modelPath = path.resolve('package.json');
    const stat = await fs.stat(modelPath);
    const baseUrl = await listen((request, response) => {
      request.resume();
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '12',
      });
      response.end(JSON.stringify({ message: 'Please retry later' }));
    });
    let caught: unknown;
    try {
      await createNodeUploadTransport()({
        endpoint: `${baseUrl}/api/3d-models/upload`,
        token: 'token',
        modelPath,
        displayName: 'model.stl',
        modelSize: stat.size,
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        mode: 'modern',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      detail: {
        code: 'RATE_LIMITED',
        retryable: true,
        retryAfterSeconds: 12,
        duplicateRisk: false,
      },
    });
    expect((caught as { detail: { message: string } }).detail.message).toBe(
      'The server is rate limiting uploads.',
    );
    expect(
      (caught as { detail: { message: string } }).detail.message,
    ).not.toContain('Please retry later');
  });
});

it('validates PNG dimensions and sanitizes multipart filenames', () => {
  expect(() => validateThumbnailPng(png(4096, 3906))).not.toThrow();
  expect(() => validateThumbnailPng(png(4096, 4096))).toThrow();
  expect(sanitizeMultipartFilename('..\\evil"\r\n.stl')).not.toMatch(
    /["\r\n\\]/,
  );
  expect(parseRetryAfter('3')).toBe(3);
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.write('IHDR', 12, 'ascii');
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}
