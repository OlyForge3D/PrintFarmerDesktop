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
});
