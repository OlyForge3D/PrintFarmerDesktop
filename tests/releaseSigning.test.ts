// @vitest-environment node

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_SIGNING_FLAG,
  resolveReleaseSigningConfiguration,
  UPDATE_PUBLIC_KEY_ENV,
} from '../release-signing';
import {
  UNIVERSAL_MAC_TARGETS,
  UNIVERSAL_SIDECAR_PATH,
} from '../scripts/build-universal-sidecar.mjs';

describe('release signing configuration', () => {
  it('keeps local and development packages unsigned', () => {
    expect(resolveReleaseSigningConfiguration({}, 'win32')).toEqual({
      packagerConfig: {},
      squirrelConfig: {},
    });
    expect(resolveReleaseSigningConfiguration({}, 'darwin')).toEqual({
      packagerConfig: {},
      squirrelConfig: {},
    });
  });

  it('fails closed when a Windows release credential is missing', () => {
    expect(() =>
      resolveReleaseSigningConfiguration(
        {
          [RELEASE_SIGNING_FLAG]: '1',
          WINDOWS_CERTIFICATE_FILE: 'release.p12',
          [UPDATE_PUBLIC_KEY_ENV]: 'public-key',
        },
        'win32',
      ),
    ).toThrow(/WINDOWS_CERTIFICATE_PASSWORD/);
  });

  it('signs both the packaged Windows app and Squirrel installer', () => {
    const configuration = resolveReleaseSigningConfiguration(
      {
        [RELEASE_SIGNING_FLAG]: '1',
        WINDOWS_CERTIFICATE_FILE: 'release.p12',
        WINDOWS_CERTIFICATE_PASSWORD: 'password',
        [UPDATE_PUBLIC_KEY_ENV]: 'public-key',
      },
      'win32',
    );
    const certificateFile = path.resolve('release.p12');

    expect(configuration.packagerConfig).toEqual({
      windowsSign: {
        certificateFile,
        certificatePassword: 'password',
      },
    });
    expect(configuration.squirrelConfig).toEqual({
      certificateFile,
      certificatePassword: 'password',
    });
  });

  it('requires signing, notarization, and update trust for macOS releases', () => {
    const configuration = resolveReleaseSigningConfiguration(
      {
        [RELEASE_SIGNING_FLAG]: '1',
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID)',
        APPLE_ID: 'release@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAMID',
        APPLE_SIGNING_KEYCHAIN: '/tmp/release.keychain-db',
        [UPDATE_PUBLIC_KEY_ENV]: 'public-key',
      },
      'darwin',
    );

    expect(configuration.packagerConfig).toMatchObject({
      osxSign: {
        identity: 'Developer ID Application: Example (TEAMID)',
        keychain: '/tmp/release.keychain-db',
        hardenedRuntime: true,
      },
      osxNotarize: {
        appleId: 'release@example.com',
        appleIdPassword: 'app-password',
        teamId: 'TEAMID',
      },
    });
  });

  it('builds the sidecar for both macOS architectures before combining it', () => {
    expect(UNIVERSAL_MAC_TARGETS).toEqual([
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]);
    expect(UNIVERSAL_SIDECAR_PATH).toContain(
      path.join('target', 'universal-apple-darwin', 'release', 'model-core'),
    );
  });
});
