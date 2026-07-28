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
  it('signs the universal sidecar before Forge signs the outer app', () => {
    const build = workflow.indexOf('Build universal macOS sidecar (release)');
    const sign = workflow.indexOf(
      'Sign universal Rust sidecar before the Electron app',
    );
    const make = workflow.indexOf('Make artifacts');

    expect(build).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(build);
    expect(make).toBeGreaterThan(sign);
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
    expect(workflow).toContain('PRINTFARMER_REQUIRE_SIGNING: ${{');
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

  it('normalizes release asset names before signing their download URLs', () => {
    expect(workflow).toContain(
      "sed -E 's/[^A-Za-z0-9._-]+/./g; s/^\\.+//; s/\\.+$//'",
    );
    expect(workflow.indexOf('safe_name=')).toBeLessThan(
      workflow.indexOf('Generate signed update metadata'),
    );
  });

  it('keeps signing and notarization secrets out of the job environment', () => {
    expect(workflow).not.toContain(
      'WINDOWS_CERTIFICATE_PASSWORD=$env:CERTIFICATE_PASSWORD',
    );
    expect(workflow).not.toContain(
      'APPLE_APP_SPECIFIC_PASSWORD=$NOTARIZATION_PASSWORD',
    );
    expect(workflow).not.toContain('>> "$GITHUB_ENV"');
    expect(workflow).toContain(
      'WINDOWS_CERTIFICATE_PASSWORD: ${{ startsWith(github.ref',
    );
    expect(workflow).toContain(
      'APPLE_APP_SPECIFIC_PASSWORD: ${{ startsWith(github.ref',
    );
  });

  it('requires durable Windows timestamps before publishing', () => {
    expect(workflow).toContain('TimeStamperCertificate');
    expect(workflow).toContain('Missing RFC 3161 timestamp');
    expect(workflow).toContain('signtool.exe');
    expect(workflow).toContain('verify /pa /all /v');
    expect(workflow).toContain('Hash of file \\(sha256\\)');
  });
});
