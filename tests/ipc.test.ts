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
});
