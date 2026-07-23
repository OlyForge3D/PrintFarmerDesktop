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

  it('accepts a folder-aware import preview', () => {
    const value = ipcSchemas[IpcChannel.PreviewImport].response.parse({
      modelCount: 3,
      totalBytes: 4096,
      skippedErrors: 0,
      formats: { stl: 1, threeMf: 1, obj: 1 },
      folders: [
        {
          relativePath: 'Animals/Cats',
          name: 'Cats',
          depth: 2,
          modelCount: 1,
        },
      ],
      foldersTruncated: false,
    });

    expect(value.formats.threeMf).toBe(1);
    expect(value.folders[0]?.relativePath).toBe('Animals/Cats');
  });

  it('validates confirmed import rules', () => {
    const value = ipcSchemas[IpcChannel.ImportRoot].request.parse({
      rootId: 'root-1',
      path: 'C:\\models',
      rules: [
        {
          relativePath: 'Animals',
          kind: 'collection',
          name: 'Animals',
        },
      ],
      commonTags: ['printable'],
    });

    expect(value.rules).toHaveLength(1);
    expect(() =>
      ipcSchemas[IpcChannel.ImportRoot].request.parse({
        rootId: 'root-1',
        path: 'C:\\models',
        rules: [
          {
            relativePath: 'Animals',
            kind: 'tag',
            name: '   ',
          },
        ],
        commonTags: [],
      }),
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
    // Absent parts default to an empty array.
    expect(value.parts).toEqual([]);
  });

  it('parses scene parts and rejects a negative triangle start', () => {
    const value = ipcSchemas[IpcChannel.LoadScene].response.parse({
      positions: [0, 0, 0],
      indices: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      sourceFormat: 'threeMf',
      parts: [{ name: 'Body', triangleStart: 0, triangleCount: 1 }],
    });
    expect(value.parts[0]?.name).toBe('Body');

    expect(() =>
      ipcSchemas[IpcChannel.LoadScene].response.parse({
        positions: [],
        indices: [],
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        sourceFormat: 'stl',
        parts: [{ name: 'x', triangleStart: -1, triangleCount: 1 }],
      }),
    ).toThrow();
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
        sourceFormat: 'gltf',
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
        { hash: 'x', format: 'gltf', size: 1, locations: [] },
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

  it('accepts an add-model-tag request and tag-array response', () => {
    const request = ipcSchemas[IpcChannel.AddModelTag].request.parse({
      hash: 'abc',
      name: 'Minis',
    });
    expect(request.name).toBe('Minis');

    const response = ipcSchemas[IpcChannel.AddModelTag].response.parse([
      { id: 'minis', name: 'Minis' },
    ]);
    expect(response).toEqual([{ id: 'minis', name: 'Minis' }]);
  });

  it('rejects an add-model-tag request with a blank name', () => {
    expect(() =>
      ipcSchemas[IpcChannel.AddModelTag].request.parse({
        hash: 'abc',
        name: '',
      }),
    ).toThrow();
  });

  it('accepts a remove-model-tag request', () => {
    const request = ipcSchemas[IpcChannel.RemoveModelTag].request.parse({
      hash: 'abc',
      tagId: 'minis',
    });
    expect(request.tagId).toBe('minis');
  });

  it('accepts a create-collection request and collection response', () => {
    const request = ipcSchemas[IpcChannel.CreateCollection].request.parse({
      name: 'Dragons',
    });
    expect(request.name).toBe('Dragons');

    const response = ipcSchemas[IpcChannel.CreateCollection].response.parse({
      id: 'col-1',
      name: 'Dragons',
      sharedToFarm: false,
      memberCount: 0,
    });
    expect(response.id).toBe('col-1');
  });

  it('accepts a collection-membership request', () => {
    const request = ipcSchemas[IpcChannel.AddModelToCollection].request.parse({
      collectionId: 'col-1',
      hash: 'abc',
    });
    expect(request.collectionId).toBe('col-1');
  });

  it('rejects a collection with a negative member count', () => {
    expect(() =>
      ipcSchemas[IpcChannel.ListCollections].response.parse([
        { id: 'c', name: 'C', sharedToFarm: false, memberCount: -1 },
      ]),
    ).toThrow();
  });
});
