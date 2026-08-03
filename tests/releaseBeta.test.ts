// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyUpdateKeyPair } from '../scripts/generate-update-metadata.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

function stepCondition(name: string): string {
  const steps = workflow.split('\n      - name: ');
  const step = steps.find((candidate) => candidate.startsWith(`${name}\n`));
  if (!step) throw new Error(`release workflow has no step named "${name}"`);
  const condition = /^\s+if: (.+)$/m.exec(step);
  return condition?.[1] ?? '';
}

function encodePem(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64');
}

describe('beta prereleases', () => {
  it('treats a semver prerelease tag as a beta and any other tag as stable', () => {
    expect(workflow).toContain(
      "IS_STABLE_RELEASE: ${{ startsWith(github.ref, 'refs/tags/') && !contains(github.ref_name, '-') }}",
    );
    expect(workflow).toContain(
      "IS_BETA_RELEASE: ${{ startsWith(github.ref, 'refs/tags/') && contains(github.ref_name, '-') }}",
    );
  });

  it.each([
    'Sign Windows package and build Squirrel installer',
    'Sign universal sidecar and macOS application',
    'Notarize macOS application',
    'Verify Windows Authenticode signatures',
    'Verify universal app, nested sidecar, and notarization',
    'Generate signed update metadata',
    'Publish signed release',
  ])('never runs "%s" for a beta tag', (name) => {
    expect(stepCondition(name)).toContain("env.IS_STABLE_RELEASE == 'true'");
  });

  it.each([
    'Make unsigned Windows installer',
    'Publish unsigned beta prerelease',
    'Reject signed update metadata on a beta tag',
  ])('runs "%s" only for a beta tag', (name) => {
    expect(stepCondition(name)).toContain("env.IS_BETA_RELEASE == 'true'");
  });

  it('marks the beta GitHub release as a prerelease', () => {
    const publish = workflow.split(
      '- name: Publish unsigned beta prerelease',
    )[1];
    expect(publish).toContain('prerelease: true');
  });
});

describe('update key pair verification', () => {
  const environmentFor = (privatePem: string, publicPem: string) => ({
    UPDATE_SIGNING_PRIVATE_KEY_BASE64: encodePem(privatePem),
    PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64: encodePem(publicPem),
  });

  const keyPair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privatePem: privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  };

  it('accepts a matching pair', () => {
    const { privatePem, publicPem } = keyPair();
    expect(() =>
      verifyUpdateKeyPair(environmentFor(privatePem, publicPem)),
    ).not.toThrow();
  });

  it('rejects a public key from a different pair', () => {
    const { privatePem } = keyPair();
    const { publicPem } = keyPair();
    expect(() =>
      verifyUpdateKeyPair(environmentFor(privatePem, publicPem)),
    ).toThrow(/does not match/);
  });

  it('rejects a missing key', () => {
    const { privatePem, publicPem } = keyPair();
    expect(() =>
      verifyUpdateKeyPair({
        ...environmentFor(privatePem, publicPem),
        PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64: '',
      }),
    ).toThrow(/required/);
  });
});
