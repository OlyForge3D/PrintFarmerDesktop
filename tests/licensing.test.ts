// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  license?: unknown;
}

interface LockfileMetadata {
  packages?: {
    ''?: PackageMetadata;
  };
}

const repoRoot = path.resolve(import.meta.dirname, '..');

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
}

function parsePackageMetadata(relativePath: string): PackageMetadata {
  const parsed: unknown = JSON.parse(readText(relativePath));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${relativePath} must contain a JSON object`);
  }
  return parsed;
}

function parseLockfile(): LockfileMetadata {
  const parsed: unknown = JSON.parse(readText('package-lock.json'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package-lock.json must contain a JSON object');
  }
  return parsed;
}

describe('repository licensing metadata', () => {
  it('uses AGPL-3.0-only consistently across package manifests', () => {
    expect(parsePackageMetadata('package.json').license).toBe('AGPL-3.0-only');
    expect(parseLockfile().packages?.['']?.license).toBe('AGPL-3.0-only');
    expect(readText('native/Cargo.toml')).toContain(
      'license = "AGPL-3.0-only"',
    );
    expect(readText('native/model-core/Cargo.toml')).toContain(
      'license.workspace = true',
    );
    expect(readText('native/model-core/Cargo.toml')).toContain(
      'repository.workspace = true',
    );
  });

  it('ships the license, source policy, and exact source attribution', () => {
    expect(readText('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(readText('THIRD_PARTY_NOTICES.md')).toContain(
      '057d6117b9ab31747ede3a5684a009cb6079ad11',
    );
    expect(readText('THIRD_PARTY_NOTICES.md')).toContain('Aaron Taylor');
    expect(readText('docs/compliance/CORRESPONDING_SOURCE.md')).toContain(
      'releases/tag/<tag>',
    );
    expect(readText('.github/CODEOWNERS')).toContain('/compliance/ @jpapiez');
  });

  it('keeps public Printer Calibration framing native to PFD', () => {
    const readme = readText('README.md');
    expect(readme).toContain('Printer Calibration');
    expect(readme).toContain(
      'https://github.com/OrcaSlicer/OrcaSlicer/wiki/calibration_guide',
    );
    expect(readme).not.toContain('PerfectFit');
    expect(readme).not.toContain('Bambu Studio');
  });
});
