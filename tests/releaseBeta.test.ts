// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { verifyUpdateKeyPair } from '../scripts/generate-update-metadata.mjs';
import { releaseContext } from '../scripts/prepare-release.mjs';

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

function releaseConditions(
  version: string,
  publish: boolean,
  runnerOs: string,
) {
  const prepared = releaseContext('a'.repeat(40), version, publish);
  const env: Record<string, string> = {};
  const context = {
    needs: { prepare: { outputs: prepared } },
    runner: { os: runnerOs },
    env,
    startsWith: (value: string, prefix: string) => value.startsWith(prefix),
    contains: (value: string, part: string) => value.includes(part),
  };
  // These workflow conditions use JavaScript-compatible boolean expressions.
  const evaluate = (condition: string): boolean => {
    const result: unknown = runInNewContext(condition, context, {
      timeout: 1_000,
    });
    expect(typeof result).toBe('boolean');
    return result === true;
  };
  env.IS_STABLE_RELEASE = prepared.stable;
  env.IS_BETA_RELEASE = prepared.beta;
  const publishCondition =
    /^ {2}publish:\n {4}name: Publish release\n {4}if: (.+)$/m.exec(
      workflow,
    )?.[1];
  if (!publishCondition) throw new Error('publish job condition not found');
  return {
    env,
    publishRuns: evaluate(publishCondition),
    stepRuns: (name: string) => evaluate(stepCondition(name)),
  };
}

function encodePem(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64');
}

describe('beta prereleases', () => {
  it('takes signing modes from the prepared release, not the pre-bump dispatch ref', () => {
    expect(workflow).toContain(
      'IS_STABLE_RELEASE: ${{ needs.prepare.outputs.stable }}',
    );
    expect(workflow).toContain(
      'IS_BETA_RELEASE: ${{ needs.prepare.outputs.beta }}',
    );
  });

  it.each([
    'Sign Windows package and build Squirrel installer',
    'Verify Windows Authenticode signatures',
    'Generate signed update metadata',
    'Publish signed release',
  ])('never runs "%s" for a beta tag', (name) => {
    expect(stepCondition(name)).toContain("env.IS_STABLE_RELEASE == 'true'");
  });

  it.each([
    'Make unsigned Windows installer',
    'Publish beta prerelease',
    'Reject signed update metadata on a beta tag',
  ])('runs "%s" only for a beta tag', (name) => {
    expect(stepCondition(name)).toContain("env.IS_BETA_RELEASE == 'true'");
  });

  it('marks the beta GitHub release as a prerelease', () => {
    const publish = workflow.split('- name: Publish beta prerelease')[1];
    expect(publish).toContain('--prerelease');
    expect(publish).toContain('Developer ID signed');
    expect(publish).toContain('notarized and stapled');
    expect(publish).toContain('no Authenticode signature');
    expect(publish).not.toContain('ad-hoc signed only');
  });

  it.each(
    (
      [
        ['tag stable', '1.2.3', true, true, false],
        ['tag beta', '1.2.3-beta.1', true, false, true],
        ['tag rc', '1.2.3-rc.1', true, false, true],
        ['manual stable', '1.2.3', true, true, false],
        ['manual beta', '1.2.3-beta.1', true, false, true],
        ['dry stable', '1.2.3', false, false, false],
        ['dry beta', '1.2.3-beta.1', false, false, false],
        ['suppressed managed tag', '1.2.3-beta.1', false, false, false],
      ] as const
    ).flatMap(([mode, version, publish, stable, beta]) =>
      ['macOS', 'Windows'].map((runnerOs) => ({
        mode,
        version,
        publish,
        runnerOs,
        stable,
        beta,
      })),
    ),
  )(
    'enforces signing and publication gates for $mode on $runnerOs',
    ({ version, publish, runnerOs, stable, beta }) => {
      const { env, publishRuns, stepRuns } = releaseConditions(
        version,
        publish,
        runnerOs,
      );
      expect(env.IS_STABLE_RELEASE).toBe(String(stable));
      expect(env.IS_BETA_RELEASE).toBe(String(beta));
      expect(publishRuns).toBe(stable || beta);

      for (const name of [
        'Sign universal sidecar and macOS application',
        'Notarize macOS application',
        'Verify universal app, nested sidecar, and notarization',
      ]) {
        expect(stepRuns(name), name).toBe(
          (stable || beta) && runnerOs === 'macOS',
        );
      }
      for (const name of [
        'Sign Windows package and build Squirrel installer',
        'Verify Windows Authenticode signatures',
      ]) {
        expect(stepRuns(name), name).toBe(stable && runnerOs === 'Windows');
      }
      expect(stepRuns('Make unsigned Windows installer')).toBe(
        beta && runnerOs === 'Windows',
      );
      expect(stepRuns('Generate signed update metadata')).toBe(stable);
      expect(stepRuns('Publish signed release')).toBe(stable);
      expect(stepRuns('Publish beta prerelease')).toBe(beta);
      expect(stepRuns('Reject signed update metadata on a beta tag')).toBe(
        beta,
      );
    },
  );

  it('requires notarization verification rather than the old ad-hoc beta check', () => {
    expect(workflow).not.toContain(
      '- name: Verify universal app and nested sidecar (beta)',
    );
    expect(workflow).toContain('xcrun stapler validate "$app_path"');
    expect(workflow).toContain(
      'spctl --assess --type execute --verbose=2 "$app_path"',
    );
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
