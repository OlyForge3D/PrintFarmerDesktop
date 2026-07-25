import { describe, expect, it } from 'vitest';
import { IpcChannel, ipcSchemas } from '@shared/ipc';

const profile = {
  id: 'imported:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  source: 'imported',
  displayName: 'U1 Standard',
  processName: 'U1 Standard',
  machineName: 'Snapmaker U1',
  compatibleFilaments: ['PLA'],
  layerHeight: 0.2,
  category: null,
  bundleCommit: null,
  settingCount: 1,
  settingsSummary: {},
  importedAt: 1,
  fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('retarget IPC contract', () => {
  it('accepts a path-free imported catalog and bounded opaque requests', () => {
    const response = ipcSchemas[IpcChannel.RetargetListProfiles].response.parse(
      {
        status: 'ok',
        value: { profiles: [profile], warnings: [] },
      },
    );
    expect(response.status).toBe('ok');
    expect(() =>
      ipcSchemas[IpcChannel.RetargetListProfiles].response.parse({
        status: 'ok',
        value: {
          profiles: [{ ...profile, path: 'C:\\secret.3mf' }],
          warnings: [],
        },
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas[IpcChannel.RetargetBuild].request.parse({
        token: 'short',
        profileId: profile.id,
        objectExclusion: false,
      }),
    ).toThrow();
  });

  it('rejects additive fields and accepts native/electron failure domains', () => {
    const response = ipcSchemas[IpcChannel.RetargetSaveAs].response.parse({
      status: 'error',
      error: {
        domain: 'electron',
        code: 'saveDestinationExists',
        message: 'exists',
        action: 'Pick another name.',
        part: null,
        setting: null,
      },
    });
    expect(response.status).toBe('error');
    expect(() =>
      ipcSchemas[IpcChannel.RetargetDispose].request.parse({
        token: 'a'.repeat(43),
        unexpected: true,
      }),
    ).toThrow();
  });
});
