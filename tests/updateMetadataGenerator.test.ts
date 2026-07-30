// @vitest-environment node

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSignedUpdateMetadata } from '../scripts/generate-update-metadata.mjs';
import { verifySignedUpdateMetadata } from '../src/main/updateMetadata';

const temporaryDirectories: string[] = [];

function encodedPem(
  key: ReturnType<typeof generateKeyPairSync>['privateKey'],
  type: 'pkcs8' | 'spki',
): string {
  return Buffer.from(key.export({ type, format: 'pem' }).toString()).toString(
    'base64',
  );
}

async function artifactDirectory(
  windowsName = 'PrintFarmer.DesktopSetup.exe',
  macName = 'PrintFarmer.Desktop-darwin-universal-1.2.3.zip',
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'update-metadata-'));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, 'nested'));
  await Promise.all([
    writeFile(path.join(directory, windowsName), 'windows installer'),
    writeFile(path.join(directory, 'nested', macName), 'mac archive'),
  ]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('update metadata generator', () => {
  it('hashes both platform artifacts and signs the exact published payload', async () => {
    const directory = await artifactDirectory();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const generated = createSignedUpdateMetadata({
      artifactsDirectory: directory,
      version: '1.2.3',
      tag: 'v1.2.3',
      repository: 'OlyForge3D/PrintFarmerDesktop',
      publishedAt: '2026-07-27T18:00:00Z',
      environment: {
        UPDATE_SIGNING_PRIVATE_KEY_BASE64: encodedPem(privateKey, 'pkcs8'),
        PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64:
          Buffer.from(publicKeyPem).toString('base64'),
      },
    });

    const verified = verifySignedUpdateMetadata(
      generated.payload,
      generated.signature,
      publicKeyPem,
    );
    expect(verified.artifacts['win32-x64'].size).toBe(
      Buffer.byteLength('windows installer'),
    );
    expect(verified.artifacts['win32-x64'].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.artifacts['darwin-universal'].size).toBe(
      Buffer.byteLength('mac archive'),
    );
    expect(verified.artifacts['darwin-universal'].sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('rejects a private key that does not match the embedded public key', async () => {
    const directory = await artifactDirectory();
    const signingKeys = generateKeyPairSync('ed25519');
    const unrelatedKeys = generateKeyPairSync('ed25519');

    expect(() =>
      createSignedUpdateMetadata({
        artifactsDirectory: directory,
        version: '1.2.3',
        tag: 'v1.2.3',
        repository: 'OlyForge3D/PrintFarmerDesktop',
        publishedAt: '2026-07-27T18:00:00Z',
        environment: {
          UPDATE_SIGNING_PRIVATE_KEY_BASE64: encodedPem(
            signingKeys.privateKey,
            'pkcs8',
          ),
          PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64: encodedPem(
            unrelatedKeys.publicKey,
            'spki',
          ),
        },
      }),
    ).toThrow('does not match');
  });

  it('rejects names that GitHub would rewrite during upload', async () => {
    const directory = await artifactDirectory('PrintFarmer DesktopSetup.exe');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    expect(() =>
      createSignedUpdateMetadata({
        artifactsDirectory: directory,
        version: '1.2.3',
        tag: 'v1.2.3',
        repository: 'OlyForge3D/PrintFarmerDesktop',
        publishedAt: '2026-07-27T18:00:00Z',
        environment: {
          UPDATE_SIGNING_PRIVATE_KEY_BASE64: encodedPem(privateKey, 'pkcs8'),
          PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64: encodedPem(publicKey, 'spki'),
        },
      }),
    ).toThrow('release artifact name is not upload-safe');
  });
});
