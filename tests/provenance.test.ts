// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface DerivedFixture {
  id: string;
  classification: 'adapted-source';
  sourcePath: string;
  sourceBlob: string;
  destinationPath: string;
  destinationSha256: string;
  spdxLicense: 'AGPL-3.0-only';
  originalNotices: string[];
  modifiedAt: string;
  modifications: string;
  review: {
    decision: 'approved';
    reviewedBy: string;
    reviewedAt: string;
    decisionReference: string;
  };
}

interface FixtureManifest {
  repository: {
    licenseReview: {
      status: string;
      issue: string;
      approvedBy: string | null;
      approvedAt: string | null;
      decisionReference: string | null;
    };
  };
  approvedSource: {
    commit: string;
  };
  sourceDecisions: Array<{
    sourcePath: string;
    sourceBlob: string;
    decision: string;
  }>;
  derivedFiles: DerivedFixture[];
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const checker = path.join(
  repoRoot,
  'scripts',
  'check-calibration-provenance.mjs',
);
const schema = path.join(
  repoRoot,
  'compliance',
  'printer-calibration-provenance.schema.json',
);
const productionManifest = path.join(
  repoRoot,
  'compliance',
  'printer-calibration-provenance.json',
);
const temporaryDirectories: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFixtureManifest(value: unknown): value is FixtureManifest {
  if (!isRecord(value)) return false;
  const repository = value.repository;
  const approvedSource = value.approvedSource;
  return (
    isRecord(repository) &&
    isRecord(repository.licenseReview) &&
    isRecord(approvedSource) &&
    typeof approvedSource.commit === 'string' &&
    Array.isArray(value.sourceDecisions) &&
    Array.isArray(value.derivedFiles)
  );
}

function loadManifest(): FixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(productionManifest, 'utf8'));
  if (!isFixtureManifest(parsed)) {
    throw new Error('Production provenance manifest has an unexpected shape');
  }
  return structuredClone(parsed);
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pfd-provenance-'));
  temporaryDirectories.push(root);
  return root;
}

function writeManifest(root: string, manifest: FixtureManifest): string {
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function runCheck(root: string, manifestPath: string) {
  return spawnSync(
    process.execPath,
    [checker, '--root', root, '--manifest', manifestPath, '--schema', schema],
    { encoding: 'utf8' },
  );
}

function createValidDerivedFixture() {
  const root = createRoot();
  const manifest = loadManifest();

  const sourcePath = 'src/logic/formulas.ts';
  const sourceBlob = '5d1ac9edd84bde6bb5993204efcf1f33b001eecb';
  const destinationPath = 'src/calibration/derived/formulas.ts';
  const originalNotice =
    'Aaron Taylor (pinned repository package author; no file-level notice in the reviewed blob)';
  const modifications =
    'Synthetic traceability fixture only; it contains no copied upstream implementation.';
  const destination = path.join(root, ...destinationPath.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });

  const derivedMarker = ['PFD', 'SOURCE', 'DERIVED'].join('-');
  const contents = [
    `// ${derivedMarker}: printer-calibration`,
    `// Source-Commit: ${manifest.approvedSource.commit}`,
    `// Source-Path: ${sourcePath}`,
    `// Source-Blob: ${sourceBlob}`,
    '// SPDX-License-Identifier: AGPL-3.0-only',
    `// PFD-Original-Notice: ${originalNotice}`,
    '// PFD-Modified-At: 2026-07-24',
    `// PFD-Modifications: ${modifications}`,
    '',
    'export const syntheticComplianceFixture = true;',
    '',
  ].join('\n');
  writeFileSync(destination, contents);

  manifest.derivedFiles = [
    {
      id: 'synthetic-formulas-fixture',
      classification: 'adapted-source',
      sourcePath,
      sourceBlob,
      destinationPath,
      destinationSha256: createHash('sha256').update(contents).digest('hex'),
      spdxLicense: 'AGPL-3.0-only',
      originalNotices: [originalNotice],
      modifiedAt: '2026-07-24',
      modifications,
      review: {
        decision: 'approved',
        reviewedBy: '@jpapiez',
        reviewedAt: '2026-07-24',
        decisionReference:
          'https://github.com/OlyForge3D/PrintFarmerDesktop/pull/999',
      },
    },
  ];

  return { root, manifest };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Printer Calibration provenance enforcement', () => {
  it('accepts the pinned production manifest with no derived source', () => {
    const result = runCheck(repoRoot, productionManifest);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0 derived file(s)');
  });

  it('rejects an unknown source revision', () => {
    const root = createRoot();
    const manifest = loadManifest();
    manifest.approvedSource.commit = '0'.repeat(40);
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'approvedSource.commit is not an approved source value',
    );
  });

  it('rejects a file in a derived root without provenance', () => {
    const root = createRoot();
    const destination = path.join(
      root,
      'src',
      'calibration',
      'derived',
      'dist',
      'unreviewed.ts',
    );
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, 'export const unreviewed = true;\n');
    const result = runCheck(root, writeManifest(root, loadManifest()));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'File in controlled derived root lacks a manifest record',
    );
  });

  it('rejects changing an excluded source file to eligible', () => {
    const root = createRoot();
    const manifest = loadManifest();
    const printerDatabase = manifest.sourceDecisions.find(
      (decision) => decision.sourcePath === 'src/data/printerDatabase.ts',
    );
    if (!printerDatabase) throw new Error('Expected printer database decision');
    printerDatabase.decision = 'eligible-for-review';
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'src/data/printerDatabase.ts must retain decision exclude',
    );
  });

  it('rejects derived source until repository licensing is approved', () => {
    const { root, manifest } = createValidDerivedFixture();
    manifest.repository.licenseReview = {
      status: 'pending-maintainer-approval',
      issue: 'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51',
      approvedBy: null,
      approvedAt: null,
      decisionReference: null,
    };
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Source-derived files are forbidden while repository licensing is pending-maintainer-approval',
    );
  });

  it('rejects a forged repository licensing approval', () => {
    const root = createRoot();
    const manifest = loadManifest();
    manifest.repository.licenseReview.approvedBy = '@unapproved-reviewer';
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Repository licensing approval must name @jpapiez',
    );
  });

  it('rejects missing attribution in a derived-file record', () => {
    const { root, manifest } = createValidDerivedFixture();
    manifest.derivedFiles[0]!.originalNotices = [];
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must NOT have fewer than 1 items');
  });

  it('finds marked source outside the controlled scan roots', () => {
    const root = createRoot();
    const markerText = `${['PFD', 'SOURCE', 'DERIVED'].join('-')}: printer-calibration`;
    const destination = path.join(root, 'e2e', 'unreviewed.spec.ts');
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `// ${markerText}\nexport {};\n`);
    const result = runCheck(root, writeManifest(root, loadManifest()));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Source-derived marker lacks a manifest record: e2e/unreviewed.spec.ts',
    );
  });

  it('rejects provenance text embedded outside the leading comment header', () => {
    const { root, manifest } = createValidDerivedFixture();
    const entry = manifest.derivedFiles[0]!;
    const destination = path.join(root, ...entry.destinationPath.split('/'));
    const originalContents = readFileSync(destination, 'utf8');
    const embedded = `export const embeddedNotices = ${JSON.stringify(originalContents)};\n`;
    writeFileSync(destination, embedded);
    entry.destinationSha256 = createHash('sha256')
      .update(embedded)
      .digest('hex');
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is missing leading notice');
  });

  it('validates a complete path-to-blob-to-destination audit fixture', () => {
    const { root, manifest } = createValidDerivedFixture();
    const result = runCheck(root, writeManifest(root, manifest));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 derived file(s)');
  });
});
