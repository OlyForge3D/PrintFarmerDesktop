// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(
    import.meta.dirname,
    '..',
    '.github',
    'workflows',
    'release.yml',
  ),
  'utf8',
);

describe('signed release workflow', () => {
  function step(name: string): string {
    const marker = `- name: ${name}`;
    const start = workflow.indexOf(marker);
    if (start < 0) throw new Error(`workflow step not found: ${name}`);
    const next = workflow.indexOf('\n      - name:', start + marker.length);
    return workflow.slice(start, next < 0 ? workflow.length : next);
  }

  it('preserves configured macOS makers and verifies the resulting installer', () => {
    const archives = step('Make macOS publishable archives');
    expect(archives).toContain(
      'npm run make -- --skip-package --platform=darwin --arch=universal',
    );
    expect(archives).not.toContain('--targets');
    const verification = step('Verify branded macOS installer');
    expect(verification).toContain("if: runner.os == 'macOS'");
    expect(verification).toContain('npm run verify:dmg');
    expect(workflow.indexOf('Verify branded macOS installer')).toBeGreaterThan(
      workflow.indexOf('Make macOS publishable archives'),
    );
    expect(workflow.indexOf('Verify branded macOS installer')).toBeLessThan(
      workflow.indexOf('Generate signed update metadata'),
    );
  });

  it('selects configured Windows makers without rebuilding the signed installer', () => {
    expect(step('Make unsigned Windows installer')).toContain(
      '--targets=squirrel',
    );
    expect(step('Make Windows portable archive')).toContain('--targets=zip');
    expect(workflow).not.toContain('--targets=@electron-forge/');
  });

  it('exercises and verifies the DMG in the CI release-package job', () => {
    const ci = readFileSync(
      path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const packageJob = ci.slice(
      ci.indexOf('\n  package:'),
      ci.indexOf('\n  advisories:'),
    );
    for (const name of [
      'Make macOS installers using configured makers',
      'Verify branded macOS installer',
    ]) {
      const candidate = packageJob
        .split(`- name: ${name}\n`)[1]
        ?.split('\n      - name:')[0];
      expect(candidate).toBeDefined();
      expect(candidate).toContain("steps.changes.outputs.docs_only != 'true'");
      expect(candidate).toContain(
        "steps.changes.outputs.docs_and_tests != 'true'",
      );
      expect(candidate).toContain("runner.os == 'macOS'");
      expect(candidate).not.toContain('continue-on-error');
      expect(candidate).not.toContain('--targets');
    }
    expect(packageJob).toContain(
      'npm run make -- --skip-package --platform=darwin',
    );
    expect(packageJob).toContain('npm run verify:dmg');
    expect(packageJob.indexOf('Make macOS installers')).toBeGreaterThan(
      packageJob.indexOf('run: npm run package'),
    );
    expect(
      packageJob.indexOf('Verify branded macOS installer'),
    ).toBeGreaterThan(packageJob.indexOf('Make macOS installers'));
  });

  it('preflights credentials before building and signs after packaging', () => {
    const preflight = workflow.indexOf('Preflight macOS release credentials');
    const install = workflow.indexOf('Install dependencies');
    const build = workflow.indexOf('Build universal macOS sidecar (release)');
    const packageApp = workflow.indexOf('Package unsigned application');
    const windowsSign = workflow.indexOf(
      'Sign Windows package and build Squirrel installer',
    );
    const macSign = workflow.indexOf(
      'Sign universal sidecar and macOS application',
    );
    const notarize = workflow.indexOf('Notarize macOS application');
    const macArchives = workflow.indexOf('Make macOS publishable archives');

    expect(preflight).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(preflight);
    expect(build).toBeGreaterThan(install);
    expect(packageApp).toBeGreaterThan(build);
    expect(windowsSign).toBeGreaterThan(packageApp);
    expect(macSign).toBeGreaterThan(packageApp);
    expect(notarize).toBeGreaterThan(macSign);
    expect(macArchives).toBeGreaterThan(notarize);
    expect(workflow).toContain(
      'PRINTFARMER_SIDECAR_SOURCE: ${{ matrix.platform ==',
    );
  });

  it('fails tagged builds when signing or notarization secrets are absent', () => {
    expect(workflow).toContain('WINDOWS_CERTIFICATE_P12_BASE64');
    expect(workflow).toContain('APPLE_CERTIFICATE_P12_BASE64');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY');
    expect(workflow).toContain('APPLE_APP_SPECIFIC_PASSWORD');
    expect(workflow).toContain('UPDATE_SIGNING_PRIVATE_KEY_BASE64');
    expect(workflow).toContain('UPDATE_SIGNING_PUBLIC_KEY_BASE64');

    const preflight = step('Preflight macOS release credentials');
    for (const secret of [
      'APPLE_CERTIFICATE_P12_BASE64',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(preflight).toContain(`[[ -n "$${secret}" ]]`);
    }
    expect(preflight).toContain(
      'Tagged macOS releases require GitHub secrets:',
    );

    const notarize = step('Notarize macOS application');
    for (const secret of [
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(notarize).toContain(`[[ -n "$${secret}" ]]`);
    }
    expect(notarize).toContain('missing=()');
    expect(notarize).toContain('Tagged releases require GitHub secrets:');
  });

  it('verifies platform signatures before signing update metadata', () => {
    const windowsVerification = workflow.indexOf(
      'Verify Windows Authenticode signatures',
    );
    const macVerification = workflow.indexOf(
      'Verify universal app, nested sidecar, and notarization',
    );
    const metadata = workflow.indexOf('Generate signed update metadata');
    const release = workflow.indexOf('Publish signed release');

    expect(windowsVerification).toBeGreaterThan(-1);
    expect(macVerification).toBeGreaterThan(-1);
    expect(metadata).toBeGreaterThan(macVerification);
    expect(metadata).toBeGreaterThan(windowsVerification);
    expect(release).toBeGreaterThan(metadata);
  });

  it('fails publication when macOS signing or notarization verification fails', () => {
    for (const name of [
      'Sign universal sidecar and macOS application',
      'Notarize macOS application',
      'Verify universal app, nested sidecar, and notarization',
    ]) {
      expect(step(name)).not.toContain('continue-on-error');
      expect(step(name)).toContain('set -euo pipefail');
    }
    expect(workflow).toContain('    needs: [prepare, make]');
  });

  it('builds and publishes the prepared version commit, not the dispatch SHA', () => {
    expect(
      workflow.match(/ref: \$\{\{ needs.prepare.outputs.sha \}\}/g),
    ).toHaveLength(2);
    expect(workflow).toContain('Verify prepared release tree');
    expect(workflow).toContain('Verify prepared publication tree');
    expect(workflow).toContain('RELEASE_SHA: ${{ needs.prepare.outputs.sha }}');
    expect(workflow).toContain('RELEASE_TAG: ${{ needs.prepare.outputs.tag }}');
    expect(workflow).toContain('--tag "$RELEASE_TAG"');
    expect(workflow).toContain('git show -s --format=%cI "$RELEASE_SHA"');
    expect(workflow).not.toContain('startsWith(github.ref');
    expect(workflow).not.toContain('$GITHUB_REF_NAME');
  });

  it('retains pending dispatch and tag runs in one non-cancelling publication group', () => {
    // Omitting queue: max restores GitHub's replace-the-pending-run default.
    const concurrency = workflow.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m);
    expect(
      concurrency?.[1]
        ?.trim()
        .split('\n')
        .map((line) => line.trim()),
    ).toEqual([
      'group: release-publication',
      'queue: max',
      'cancel-in-progress: false',
    ]);
  });

  it('keeps release preparation under the release workflow code owner', () => {
    const owners = readFileSync(
      path.resolve(import.meta.dirname, '..', '.github', 'CODEOWNERS'),
      'utf8',
    );
    expect(owners).toMatch(/^\/\.github\/workflows\/release\.yml @jpapiez$/m);
    expect(owners).toMatch(/^\/scripts\/prepare-release\.mjs @jpapiez$/m);
  });

  it('creates releases without overwriting', () => {
    expect(workflow).toContain(
      'gh release create "$RELEASE_TAG" dist/* --verify-tag --target "$RELEASE_SHA"',
    );
    expect(workflow).not.toContain('action-gh-release');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).toContain('Verify published release assets');
  });

  it('exposes the dedicated push token only to development manual publication preparation', () => {
    expect(workflow.match(/secrets.RELEASE_PUSH_TOKEN/g)).toHaveLength(1);
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && !inputs.dry_run && github.ref == 'refs/heads/development' && secrets.RELEASE_PUSH_TOKEN",
    );
    const makeAndPublish = workflow.slice(workflow.indexOf('\n  make:'));
    expect(makeAndPublish).not.toContain('RELEASE_PUSH_TOKEN');
    expect(workflow).toContain("if: needs.prepare.outputs.build == 'true'");
    expect(workflow).toContain("if: needs.prepare.outputs.publish == 'true'");
  });

  it('normalizes release asset names before signing their download URLs', () => {
    expect(workflow).toContain(
      "sed -E 's/[^A-Za-z0-9._-]+/./g; s/^\\.+//; s/\\.+$//'",
    );
    expect(workflow.indexOf('safe_name=')).toBeLessThan(
      workflow.indexOf('Generate signed update metadata'),
    );
  });

  it('keeps every ordinary build and maker step free of secret names', () => {
    const forbidden = [
      'CERTIFICATE_BASE64',
      'CERTIFICATE_PASSWORD',
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_SIGNING_KEYCHAIN',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
      'UPDATE_SIGNING_PRIVATE_KEY_BASE64',
    ];
    const ordinarySteps = [
      'Install dependencies',
      'Build Windows sidecar (release)',
      'Add universal macOS Rust targets',
      'Build universal macOS sidecar (release)',
      'Package unsigned application',
      'Make unsigned Windows installer',
      'Make Windows portable archive',
      'Make macOS publishable archives',
      'Verify SBOM reproduces from the lockfiles',
      'Verify third-party licence policy',
      'Verify third-party notices reproduce from the SBOM',
      'Verify packaged sidecar and compliance resources',
    ];
    for (const name of ordinarySteps) {
      for (const secret of forbidden) {
        expect(step(name), `${name} contains ${secret}`).not.toContain(secret);
      }
    }
    expect(workflow).not.toContain('>> "$GITHUB_ENV"');
  });

  it('gives each dedicated process only its own credentials', () => {
    const windows = step('Sign Windows package and build Squirrel installer');
    expect(windows).toContain('WINDOWS_CERTIFICATE_P12_BASE64');
    expect(windows).toContain('WINDOWS_CERTIFICATE_PASSWORD');
    expect(windows).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
    expect(windows).not.toContain('UPDATE_SIGNING_PRIVATE_KEY_BASE64');

    const macSign = step('Sign universal sidecar and macOS application');
    expect(macSign).toContain('APPLE_CERTIFICATE_P12_BASE64');
    expect(macSign).toContain('APPLE_CERTIFICATE_PASSWORD');
    expect(macSign).toContain('APPLE_SIGNING_IDENTITY');
    expect(macSign).toContain('scripts/macos-signing-keychain.mjs');
    expect(macSign).toContain('scripts/release-environment.mjs');
    expect(macSign).not.toContain('APPLE_ID');
    expect(macSign).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');

    const notarize = step('Notarize macOS application');
    expect(notarize).toContain('APPLE_ID');
    expect(notarize).toContain('APPLE_APP_SPECIFIC_PASSWORD');
    expect(notarize).toContain('APPLE_TEAM_ID');
    expect(notarize).not.toContain('APPLE_CERTIFICATE_PASSWORD');

    const metadata = step('Generate signed update metadata');
    expect(metadata).toContain('UPDATE_SIGNING_PRIVATE_KEY_BASE64');
    expect(metadata).not.toContain('WINDOWS_CERTIFICATE_PASSWORD');
    expect(metadata).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
  });

  it('requires durable Windows timestamps before publishing', () => {
    expect(workflow).toContain('TimeStamperCertificate');
    expect(workflow).toContain('Missing RFC 3161 timestamp');
    expect(workflow).toContain('signtool.exe');
    expect(workflow).toContain('verify /pa /all /v');
    expect(workflow).toContain('Hash of file \\(sha256\\)');
  });
});
