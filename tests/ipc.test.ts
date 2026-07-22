import { describe, expect, it } from 'vitest';
import { IPC_CONTRACT_VERSION, ipcSchemas, IpcChannel } from '@shared/ipc';

describe('ipc contract', () => {
  it('accepts a valid app info response', () => {
    const value = ipcSchemas[IpcChannel.AppInfo].response.parse({
      contractVersion: IPC_CONTRACT_VERSION,
      appVersion: '0.1.0',
      platform: 'win32',
      electronVersion: '33.0.0',
    });
    expect(value.appVersion).toBe('0.1.0');
  });

  it('rejects an app info response with the wrong contract version', () => {
    expect(() =>
      ipcSchemas[IpcChannel.AppInfo].response.parse({
        contractVersion: 999,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
    ).toThrow();
  });

  it('accepts a valid sidecar ping request', () => {
    const value = ipcSchemas[IpcChannel.SidecarPing].request.parse({
      nonce: 'abc123',
    });
    expect(value.nonce).toBe('abc123');
  });

  it('rejects a sidecar ping request with an empty nonce', () => {
    expect(() =>
      ipcSchemas[IpcChannel.SidecarPing].request.parse({ nonce: '' }),
    ).toThrow();
  });

  it('rejects a sidecar ping request with an oversized nonce', () => {
    expect(() =>
      ipcSchemas[IpcChannel.SidecarPing].request.parse({
        nonce: 'x'.repeat(129),
      }),
    ).toThrow();
  });

  it('accepts a valid load-scene request', () => {
    const value = ipcSchemas[IpcChannel.LoadScene].request.parse({
      path: 'C:\\models\\part.stl',
    });
    expect(value.path).toContain('part.stl');
  });

  it('rejects a load-scene request with an empty path', () => {
    expect(() =>
      ipcSchemas[IpcChannel.LoadScene].request.parse({ path: '' }),
    ).toThrow();
  });

  it('accepts a valid scene response', () => {
    const value = ipcSchemas[IpcChannel.LoadScene].response.parse({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: null,
    });
    expect(value.indices).toEqual([0, 1, 2]);
    expect(value.sourceFormat).toBe('threeMf');
  });

  it('rejects a scene response with a negative index', () => {
    expect(() =>
      ipcSchemas[IpcChannel.LoadScene].response.parse({
        positions: [0, 0, 0],
        indices: [-1],
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        sourceFormat: 'stl',
      }),
    ).toThrow();
  });

  it('rejects a scene response with an unknown source format', () => {
    expect(() =>
      ipcSchemas[IpcChannel.LoadScene].response.parse({
        positions: [],
        indices: [],
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        sourceFormat: 'obj',
      }),
    ).toThrow();
  });

  it('accepts a selected open-model-file response', () => {
    const value = ipcSchemas[IpcChannel.OpenModelFile].response.parse({
      path: 'C:\\models\\part.stl',
    });
    expect(value).toEqual({ path: 'C:\\models\\part.stl' });
  });

  it('accepts a null open-model-file response (cancelled)', () => {
    const value = ipcSchemas[IpcChannel.OpenModelFile].response.parse(null);
    expect(value).toBeNull();
  });

  it('rejects an open-model-file response with an empty path', () => {
    expect(() =>
      ipcSchemas[IpcChannel.OpenModelFile].response.parse({ path: '' }),
    ).toThrow();
  });

  it('accepts a valid extract-vendor-metadata request', () => {
    const value = ipcSchemas[IpcChannel.ExtractVendorMetadata].request.parse({
      path: 'C:\\models\\project.3mf',
    });
    expect(value.path).toContain('project.3mf');
  });

  it('rejects an extract-vendor-metadata request with an empty path', () => {
    expect(() =>
      ipcSchemas[IpcChannel.ExtractVendorMetadata].request.parse({ path: '' }),
    ).toThrow();
  });

  it('accepts a full vendor-metadata response', () => {
    const value = ipcSchemas[IpcChannel.ExtractVendorMetadata].response.parse({
      slicer: 'bambuStudio',
      core: { title: 'Widget', application: 'BambuStudio-01.08.00.55' },
      plates: [
        {
          index: 1,
          predictionSeconds: 3600,
          weightGrams: 12.5,
          filamentTypes: ['PLA'],
        },
      ],
      thumbnails: ['Metadata/plate_1.png'],
    });
    expect(value.slicer).toBe('bambuStudio');
    expect(value.core.title).toBe('Widget');
    expect(value.plates[0]?.filamentTypes).toEqual(['PLA']);
    expect(value.thumbnails).toEqual(['Metadata/plate_1.png']);
  });

  it('accepts a minimal vendor-metadata response (unknown slicer)', () => {
    const value = ipcSchemas[IpcChannel.ExtractVendorMetadata].response.parse({
      slicer: 'unknown',
      core: {},
      plates: [],
      thumbnails: [],
    });
    expect(value.slicer).toBe('unknown');
    expect(value.plates).toEqual([]);
  });

  it('rejects a vendor-metadata response with an unknown slicer value', () => {
    expect(() =>
      ipcSchemas[IpcChannel.ExtractVendorMetadata].response.parse({
        slicer: 'simplify3d',
        core: {},
        plates: [],
        thumbnails: [],
      }),
    ).toThrow();
  });

  it('accepts a valid render-thumbnail request with a size', () => {
    const value = ipcSchemas[IpcChannel.RenderThumbnail].request.parse({
      path: 'C:\\models\\part.stl',
      size: 256,
    });
    expect(value.path).toContain('part.stl');
    expect(value.size).toBe(256);
  });

  it('accepts a render-thumbnail request without a size', () => {
    const value = ipcSchemas[IpcChannel.RenderThumbnail].request.parse({
      path: 'C:\\models\\part.stl',
    });
    expect(value.size).toBeUndefined();
  });

  it('rejects a render-thumbnail request with an out-of-range size', () => {
    expect(() =>
      ipcSchemas[IpcChannel.RenderThumbnail].request.parse({
        path: 'C:\\models\\part.stl',
        size: 8,
      }),
    ).toThrow();
  });

  it('accepts a render-thumbnail response', () => {
    const value = ipcSchemas[IpcChannel.RenderThumbnail].response.parse({
      width: 512,
      height: 512,
      pngBase64: 'iVBORw0KGgo=',
    });
    expect(value.width).toBe(512);
    expect(value.pngBase64.length).toBeGreaterThan(0);
  });

  it('rejects a render-thumbnail response with an empty png', () => {
    expect(() =>
      ipcSchemas[IpcChannel.RenderThumbnail].response.parse({
        width: 512,
        height: 512,
        pngBase64: '',
      }),
    ).toThrow();
  });

  it('accepts a valid scan-root request', () => {
    const value = ipcSchemas[IpcChannel.ScanRoot].request.parse({
      rootId: 'root1',
      path: 'C:\\models',
    });
    expect(value.rootId).toBe('root1');
    expect(value.path).toContain('models');
  });

  it('rejects a scan-root request with an empty rootId', () => {
    expect(() =>
      ipcSchemas[IpcChannel.ScanRoot].request.parse({
        rootId: '',
        path: 'C:\\models',
      }),
    ).toThrow();
  });

  it('accepts a scan-root (reconcile report) response', () => {
    const value = ipcSchemas[IpcChannel.ScanRoot].response.parse({
      added: 3,
      changed: 1,
      unchanged: 5,
      missing: 2,
      hashErrors: 0,
    });
    expect(value.added).toBe(3);
    expect(value.hashErrors).toBe(0);
  });

  it('accepts a list-models response with a logical model', () => {
    const value = ipcSchemas[IpcChannel.ListModels].response.parse([
      {
        hash: 'deadbeef',
        format: 'threeMf',
        size: 4096,
        locations: [
          {
            rootId: 'root1',
            path: 'C:\\models\\part.3mf',
            rootRelative: 'part.3mf',
            size: 4096,
            available: true,
          },
        ],
      },
    ]);
    expect(value[0]?.format).toBe('threeMf');
    expect(value[0]?.locations[0]?.available).toBe(true);
  });

  it('rejects a logical model with an unknown format', () => {
    expect(() =>
      ipcSchemas[IpcChannel.ListModels].response.parse([
        { hash: 'x', format: 'obj', size: 1, locations: [] },
      ]),
    ).toThrow();
  });

  it('accepts a selected open-folder response', () => {
    const value = ipcSchemas[IpcChannel.OpenFolder].response.parse({
      path: 'C:\\models',
    });
    expect(value).toEqual({ path: 'C:\\models' });
  });

  it('accepts a null open-folder response (cancelled)', () => {
    const value = ipcSchemas[IpcChannel.OpenFolder].response.parse(null);
    expect(value).toBeNull();
  });

  it('rejects an open-folder response with an empty path', () => {
    expect(() =>
      ipcSchemas[IpcChannel.OpenFolder].response.parse({ path: '' }),
    ).toThrow();
  });
});
