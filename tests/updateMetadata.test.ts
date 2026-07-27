// @vitest-environment node

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertUpdateIsNotRollback,
  compareVersions,
  selectUpdateArtifact,
  verifySignedUpdateMetadata,
  type UpdateMetadata,
} from '../src/main/updateMetadata';

function publicPem(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function signedMetadata(overrides: Partial<UpdateMetadata> = {}): {
  payload: string;
  signature: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    version: '1.2.3',
    publishedAt: '2026-07-27T18:00:00.000Z',
    artifacts: {
      'win32-x64': {
        fileName: 'PrintFarmer-1.2.3.Setup.exe',
        url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v1.2.3/PrintFarmer-1.2.3.Setup.exe',
        sha256: 'a'.repeat(64),
        size: 1024,
      },
      'darwin-universal': {
        fileName: 'PrintFarmer-darwin-universal-1.2.3.zip',
        url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v1.2.3/PrintFarmer-darwin-universal-1.2.3.zip',
        sha256: 'b'.repeat(64),
        size: 2048,
      },
    },
    ...overrides,
  };
  const payload = `${JSON.stringify(metadata, null, 2)}\n`;
  return {
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
    publicKey: publicPem(publicKey),
  };
}

describe('signed update metadata', () => {
  it('verifies exact signed bytes and selects the universal macOS artifact', () => {
    const fixture = signedMetadata();
    const metadata = verifySignedUpdateMetadata(
      fixture.payload,
      fixture.signature,
      fixture.publicKey,
    );

    expect(metadata.version).toBe('1.2.3');
    expect(
      selectUpdateArtifact(metadata, 'darwin', 'arm64').fileName,
    ).toContain('universal');
    expect(selectUpdateArtifact(metadata, 'darwin', 'x64')).toEqual(
      metadata.artifacts['darwin-universal'],
    );
  });

  it('rejects metadata changed after signing', () => {
    const fixture = signedMetadata();
    expect(() =>
      verifySignedUpdateMetadata(
        fixture.payload.replace('"1.2.3"', '"9.9.9"'),
        fixture.signature,
        fixture.publicKey,
      ),
    ).toThrow('signature verification failed');
  });

  it('rejects signatures from a different release key', () => {
    const fixture = signedMetadata();
    const { publicKey } = generateKeyPairSync('ed25519');

    expect(() =>
      verifySignedUpdateMetadata(
        fixture.payload,
        fixture.signature,
        publicPem(publicKey),
      ),
    ).toThrow('signature verification failed');
  });

  it('rejects signed artifacts outside the trusted GitHub release path', () => {
    const fixture = signedMetadata({
      artifacts: {
        ...signedMetadataObject().artifacts,
        'win32-x64': {
          ...signedMetadataObject().artifacts['win32-x64'],
          url: 'https://example.com/PrintFarmer-1.2.3.Setup.exe',
        },
      },
    });

    expect(() =>
      verifySignedUpdateMetadata(
        fixture.payload,
        fixture.signature,
        fixture.publicKey,
      ),
    ).toThrow('trusted release asset URL');
  });

  it('rejects rollback below the running or highest previously trusted version', () => {
    expect(() => assertUpdateIsNotRollback('1.9.9', '2.0.0', '2.0.0')).toThrow(
      'rollback from 2.0.0',
    );
    expect(() => assertUpdateIsNotRollback('2.1.0', '2.0.0', '2.2.0')).toThrow(
      'previously trusted version 2.2.0',
    );
    expect(() =>
      assertUpdateIsNotRollback('2.2.0', '2.0.0', '2.2.0'),
    ).not.toThrow();
  });

  it('orders stable and prerelease versions without permitting lexical rollback', () => {
    expect(compareVersions('2.0.0', '2.0.0-rc.10')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-rc.10', '2.0.0-rc.2')).toBeGreaterThan(0);
    expect(compareVersions('10.0.0', '2.99.99')).toBeGreaterThan(0);
  });
});

function signedMetadataObject(): UpdateMetadata {
  return JSON.parse(signedMetadata().payload) as UpdateMetadata;
}
