// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: { showOpenDialog: vi.fn() },
}));

import { dialog } from 'electron';
import {
  LEGACY_BACKUP_MAX_BYTES,
  MAX_JSON_NESTING_DEPTH,
  runLegacyBackupPreflight,
} from '../src/main/calibrationImportV4.js';
import { CalibrationAssetManifestService } from '../src/main/calibrationAssetManifest.js';
import {
  discoverLocalOrcaFilamentProfiles,
  discoverLocalOrcaFilamentProfilesWithDiagnostics,
} from '../src/main/orcaProfileDiscovery.js';
import {
  installOrcaProfileWindows,
  OrcaInstallError,
} from '../src/main/orcaProfileInstall.js';
import { ORCA_PROFILE_MAX_BYTES } from '../src/main/orcaProfileValidation.js';
import type { RemoteCalibrationPrinterContext } from '../src/main/calibrationWire.js';

type EntryPoint = 'asset' | 'legacy' | 'orca';
type Vector =
  | 'cyclicInheritance'
  | 'deeplyNestedJson'
  | 'duplicateKeys'
  | 'executableShapedContent'
  | 'malformedBase64DataUrl'
  | 'mimeExtensionMismatch'
  | 'oversized'
  | 'pathTraversal'
  | 'symlinkOrJunctionEscape'
  | 'unsafeNumericValues'
  | 'wrongMagicBytes';

interface CorpusManifest {
  readonly provenance: string;
  readonly fixtures: readonly {
    readonly file: string;
    readonly sha256: string;
    readonly byteLen: number;
    readonly expectedOutcome: string;
  }[];
  readonly materialized: readonly {
    readonly id: string;
    readonly entryPoint: EntryPoint;
    readonly byteLen: number;
    readonly sha256: string;
    readonly expectedOutcome: string;
  }[];
  readonly matrix: readonly {
    readonly vector: Vector;
    readonly entryPoint: EntryPoint;
    readonly applicable: boolean;
    readonly reason?: string;
  }[];
}

const fixtureRoot = path.join(
  import.meta.dirname,
  'fixtures',
  'calibration-malicious',
);
const manifest = JSON.parse(
  await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'),
) as CorpusManifest;
const fixtureByFile = new Map(
  manifest.fixtures.map((fixture) => [fixture.file, fixture]),
);
const materializedById = new Map(
  manifest.materialized.map((fixture) => [fixture.id, fixture]),
);

let testRoot: string;
let sandbox: string;
let outside: string;
let originalAppData: string | undefined;

function fixturePath(relativePath: string): string {
  return path.join(fixtureRoot, ...relativePath.split('/'));
}

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function materialize(id: string, prefix: Buffer, paddingByte: number): Buffer {
  const record = materializedById.get(id);
  if (!record) throw new Error(`Unknown materialized fixture ${id}`);
  const bytes = Buffer.alloc(record.byteLen, paddingByte);
  prefix.copy(bytes);
  expect(hash(bytes)).toBe(record.sha256);
  return bytes;
}

async function snapshotTree(root: string): Promise<string[]> {
  const rows: string[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        rows.push(`link:${childRelative}`);
      } else if (info.isDirectory()) {
        rows.push(`dir:${childRelative}`);
        await visit(child, childRelative);
      } else {
        rows.push(`file:${childRelative}:${hash(await readFile(child))}`);
      }
    }
  }
  await visit(root, '');
  return rows;
}

async function withDeadlockGuard<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('deadlock guard expired')),
      15_000,
    );
  });
  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function orcaContext(): RemoteCalibrationPrinterContext {
  return {
    printerId: 'printer-1',
    displayName: 'Synthetic printer',
    printerModel: null,
    firmware: {
      firmware: 'Klipper',
      gcodeDialect: 'Klipper',
      firmwareVersion: null,
      klipperConfigHash: null,
    },
    orcaProfileId: 'Synthetic PLA @0.4 nozzle',
    orcaProfileDisplayName: 'Synthetic PLA @0.4 nozzle',
    bedWidthMm: 250,
    bedDepthMm: 250,
    nozzleDiameterMm: 0.4,
    snapshotAt: '2026-08-04T00:00:00.000Z',
    isCurrent: true,
    configurationId: 'configuration-1',
    configurationRevision: 1,
    snapshotId: 'snapshot-1',
    snapshotRevision: 1,
    slicerIdentity: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    profileRevision: 'revision-1',
    contentHash: null,
    toolheads: [
      {
        toolId: 'tool-1',
        toolheadId: 'toolhead-1',
        extruderType: 'directDrive',
        nozzle: { id: 'nozzle-1', diameterMm: 0.4, material: 'brass' },
      },
    ],
    safety: null,
    permissions: null,
  };
}

async function copyFixture(relativePath: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(fixturePath(relativePath), destination);
}

async function expectLegacyCode(
  relativePath: string,
  expectedCode: string,
): Promise<void> {
  const source = path.join(sandbox, path.basename(relativePath));
  await copyFixture(relativePath, source);
  await expect(
    withDeadlockGuard(runLegacyBackupPreflight(source)),
  ).rejects.toMatchObject({ code: expectedCode });
}

async function runLegacyCell(vector: Vector): Promise<void> {
  const validPath = path.join(sandbox, 'legacy-valid.json');
  await copyFixture('legacy/valid.json', validPath);
  await expect(
    withDeadlockGuard(runLegacyBackupPreflight(validPath)),
  ).resolves.toMatchObject({ summary: { detectedVersion: 4 } });

  const fixtures: Partial<Record<Vector, [string, string]>> = {
    cyclicInheritance: [
      'legacy/cyclic-inheritance.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    ],
    deeplyNestedJson: ['legacy/deeply-nested.json', 'LEGACY_BACKUP_TOO_DEEP'],
    duplicateKeys: ['legacy/duplicate-keys.json', 'LEGACY_BACKUP_INVALID_JSON'],
    malformedBase64DataUrl: [
      'legacy/malformed-base64.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    ],
    mimeExtensionMismatch: [
      'legacy/mime-mismatch.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    ],
    pathTraversal: [
      'legacy/path-traversal.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    ],
    unsafeNumericValues: [
      'legacy/unsafe-number.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    ],
    wrongMagicBytes: [
      'legacy/wrong-magic.json',
      'LEGACY_BACKUP_INVALID_MARKER',
    ],
  };

  if (vector === 'oversized') {
    const valid = await readFile(fixturePath('legacy/valid.json'));
    const atLimit = path.join(sandbox, 'legacy-at-limit.json');
    await writeFile(atLimit, materialize('legacy-at-limit', valid, 0x20));
    await expect(
      withDeadlockGuard(runLegacyBackupPreflight(atLimit)),
    ).resolves.toMatchObject({ summary: { detectedVersion: 4 } });
    expect((await lstat(atLimit)).size).toBe(LEGACY_BACKUP_MAX_BYTES);

    const overLimit = path.join(sandbox, 'legacy-over-limit.json');
    await writeFile(overLimit, materialize('legacy-over-limit', valid, 0x20));
    await expect(
      withDeadlockGuard(runLegacyBackupPreflight(overLimit)),
    ).rejects.toMatchObject({ code: 'LEGACY_BACKUP_TOO_LARGE' });
    return;
  }

  if (vector === 'symlinkOrJunctionEscape') {
    const target = path.join(outside, 'legacy-target.json');
    const linked = path.join(sandbox, 'legacy-linked.json');
    await symlink(target, linked, 'file');
    await expect(
      withDeadlockGuard(runLegacyBackupPreflight(linked)),
    ).rejects.toMatchObject({ code: 'LEGACY_BACKUP_INVALID_FILE' });
    return;
  }

  if (vector === 'executableShapedContent') {
    await expectLegacyCode(
      'legacy/gcode-shaped.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    );
    await expectLegacyCode(
      'legacy/script-shaped.json',
      'LEGACY_BACKUP_INVALID_SCHEMA',
    );
    return;
  }

  if (vector === 'unsafeNumericValues') {
    for (const file of [
      'legacy/unsafe-number.json',
      'legacy/unsafe-integer.json',
      'legacy/negative-size.json',
    ]) {
      await expectLegacyCode(file, 'LEGACY_BACKUP_INVALID_SCHEMA');
    }
    return;
  }

  const fixture = fixtures[vector];
  if (!fixture) throw new Error(`Missing legacy case for ${vector}`);
  await expectLegacyCode(...fixture);
}

async function runOrcaDiscovery(
  files: readonly string[],
): ReturnType<typeof discoverLocalOrcaFilamentProfilesWithDiagnostics> {
  const root = path.join(
    sandbox,
    `orca-${files.length}-${path.basename(files[0]!)}`,
  );
  await mkdir(root, { recursive: true });
  for (const relativePath of files) {
    await copyFixture(
      relativePath,
      path.join(root, path.basename(relativePath)),
    );
  }
  return withDeadlockGuard(
    discoverLocalOrcaFilamentProfilesWithDiagnostics(orcaContext(), {
      userRoots: [root],
      systemRoots: [],
    }),
  );
}

async function assertOrcaPositiveControl(): Promise<void> {
  const result = await runOrcaDiscovery(['orca/valid.json']);
  expect(result.profiles).toHaveLength(1);
  expect(result.diagnostics).toEqual([]);
  expect(result.metrics.filesInspected).toBe(1);
  expect(result.metrics.bytesRead).toBe(
    fixtureByFile.get('orca/valid.json')!.byteLen,
  );
}

async function expectWindowsInstallRejects(contents: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const appData = path.join(sandbox, `install-${randomUUID()}`);
  await mkdir(appData);
  process.env['APPDATA'] = appData;
  try {
    await withDeadlockGuard(
      installOrcaProfileWindows(
        contents,
        hash(contents),
        'synthetic-profile.json',
      ),
    );
    throw new Error('Expected hostile install profile to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(OrcaInstallError);
    expect(error).toMatchObject({ code: 'verificationFailed' });
  }
  await expect(lstat(path.join(appData, 'OrcaSlicer'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

async function runOrcaCell(vector: Vector): Promise<void> {
  await assertOrcaPositiveControl();
  const cases: Partial<Record<Vector, [readonly string[], string]>> = {
    cyclicInheritance: [
      ['orca/cycle-a.json', 'orca/cycle-b.json', 'orca/cycle-c.json'],
      'cycle',
    ],
    deeplyNestedJson: [['orca/deeply-nested.json'], 'tooDeep'],
    duplicateKeys: [['orca/duplicate-keys.json'], 'duplicateKey'],
    pathTraversal: [['orca/path-traversal.json'], 'unsafeInheritance'],
    unsafeNumericValues: [['orca/unsafe-number.json'], 'unsafeNumber'],
    wrongMagicBytes: [['orca/wrong-magic.json'], 'invalidJson'],
  };

  if (vector === 'oversized') {
    const valid = await readFile(fixturePath('orca/valid.json'));
    const atLimitRoot = path.join(sandbox, 'orca-at-limit-root');
    await mkdir(atLimitRoot);
    await writeFile(
      path.join(atLimitRoot, 'at-limit.json'),
      materialize('orca-at-limit', valid, 0x20),
    );
    const atLimit = await discoverLocalOrcaFilamentProfilesWithDiagnostics(
      orcaContext(),
      {
        userRoots: [atLimitRoot],
        systemRoots: [],
      },
    );
    expect(atLimit.profiles).toHaveLength(1);
    expect(atLimit.metrics.bytesRead).toBe(ORCA_PROFILE_MAX_BYTES);

    const overLimitRoot = path.join(sandbox, 'orca-over-limit-root');
    await mkdir(overLimitRoot);
    await writeFile(
      path.join(overLimitRoot, 'over-limit.json'),
      materialize('orca-over-limit', valid, 0x20),
    );
    const overLimit = await discoverLocalOrcaFilamentProfilesWithDiagnostics(
      orcaContext(),
      {
        userRoots: [overLimitRoot],
        systemRoots: [],
      },
    );
    expect(overLimit.profiles).toEqual([]);
    expect(overLimit.diagnostics.map(({ code }) => code)).toContain('tooLarge');
    expect(overLimit.metrics.bytesRead).toBe(0);
    await expectWindowsInstallRejects(
      materialize('orca-over-limit', valid, 0x20).toString('utf8'),
    );
    return;
  }

  if (vector === 'symlinkOrJunctionEscape') {
    const root = path.join(sandbox, 'orca-symlink-root');
    await mkdir(root);
    const target = path.join(outside, 'outside-profile.json');
    await symlink(target, path.join(root, 'linked.json'), 'file');
    const result = await discoverLocalOrcaFilamentProfilesWithDiagnostics(
      orcaContext(),
      {
        userRoots: [root],
        systemRoots: [],
      },
    );
    expect(result.profiles).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain('symlink');

    if (process.platform === 'win32') {
      const appData = path.join(sandbox, 'appdata');
      await mkdir(appData);
      process.env['APPDATA'] = appData;
      await symlink(outside, path.join(appData, 'OrcaSlicer'), 'junction');
      const generated = await readFile(fixturePath('orca/valid.json'), 'utf8');
      try {
        await withDeadlockGuard(
          installOrcaProfileWindows(
            generated,
            hash(generated),
            'synthetic.json',
          ),
        );
        throw new Error('Expected junction install to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OrcaInstallError);
        expect(error).toMatchObject({ code: 'pathRestricted' });
      }
    }
    return;
  }

  if (vector === 'executableShapedContent') {
    for (const file of ['orca/gcode-shaped.json', 'orca/script-shaped.json']) {
      const result = await runOrcaDiscovery([file]);
      expect(result.profiles).toEqual([]);
      expect(result.diagnostics.map(({ code }) => code)).toContain(
        'invalidJson',
      );
      await expectWindowsInstallRejects(
        await readFile(fixturePath(file), 'utf8'),
      );
    }
    return;
  }

  if (vector === 'unsafeNumericValues') {
    for (const file of [
      'orca/unsafe-number.json',
      'orca/unsafe-integer.json',
      'orca/negative-size.json',
    ]) {
      const result = await runOrcaDiscovery([file]);
      expect(result.profiles).toEqual([]);
      expect(result.diagnostics.map(({ code }) => code)).toContain(
        'unsafeNumber',
      );
      await expectWindowsInstallRejects(
        await readFile(fixturePath(file), 'utf8'),
      );
    }
    return;
  }

  const fixture = cases[vector];
  if (!fixture) throw new Error(`Missing Orca case for ${vector}`);
  const result = await runOrcaDiscovery(fixture[0]);
  expect(result.profiles).toEqual([]);
  expect(result.diagnostics.map(({ code }) => code)).toContain(fixture[1]);
  await expectWindowsInstallRejects(
    await readFile(fixturePath(fixture[0][0]!), 'utf8'),
  );
  const publicRoot = path.join(sandbox, 'orca-public-contract');
  await mkdir(publicRoot);
  for (const file of fixture[0]) {
    await copyFixture(file, path.join(publicRoot, path.basename(file)));
  }
  expect(
    await discoverLocalOrcaFilamentProfiles(orcaContext(), {
      userRoots: [publicRoot],
      systemRoots: [],
    }),
  ).toEqual([]);
}

function assetManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    entries: [
      {
        method: 'SyntheticMethod',
        enabled: true,
        disabledReason: null,
        sourceUrl: 'https://example.invalid/synthetic',
        author: 'PrintFarmerDesktop tests',
        license: 'AGPL-3.0-only',
        attribution: 'Synthetic issue #158 fixture',
        expectedFilename: null,
        contentType: 'model/stl',
        expectedExtension: 'stl',
        expectedSha256: null,
        minSizeBytes: 6,
        maxSizeBytes: 1024,
        validationRules: {},
        ...overrides,
      },
    ],
  };
}

async function assetService(overrides: Record<string, unknown> = {}) {
  const manifestPath = path.join(sandbox, `manifest-${randomUUID()}.json`);
  await writeFile(manifestPath, JSON.stringify(assetManifest(overrides)));
  return new CalibrationAssetManifestService(manifestPath);
}

async function stageAsset(
  service: CalibrationAssetManifestService,
  source: string,
  name = path.basename(source),
): Promise<string> {
  const selected = path.join(sandbox, name);
  await copyFile(source, selected);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
    canceled: false,
    filePaths: [selected],
  });
  const picked = await service.pickFile(
    [path.extname(name).slice(1)],
    'Synthetic asset',
  );
  if (picked.status !== 'ok')
    throw new Error(`Asset staging: ${picked.status}`);
  return picked.approvalId;
}

async function validateAssetFixture(
  relativePath: string,
  expectedReason: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const service = await assetService(overrides);
  const approvalId = await stageAsset(service, fixturePath(relativePath));
  const result = await withDeadlockGuard(
    service.validateFile(approvalId, 'SyntheticMethod'),
  );
  expect(result).toMatchObject({
    status: 'invalid',
    reason: expectedReason,
  });
}

async function assertAssetPositiveControl(): Promise<void> {
  const service = await assetService({ minSizeBytes: 134 });
  const approvalId = await stageAsset(
    service,
    fixturePath('asset/valid.stl'),
    `valid-${randomUUID()}.stl`,
  );
  await expect(
    withDeadlockGuard(service.validateFile(approvalId, 'SyntheticMethod')),
  ).resolves.toMatchObject({ status: 'ok', contentType: 'model/stl' });
  expect(service.getLastValidationMetrics().bytesRead).toBe(134);
}

async function runAssetCell(vector: Vector): Promise<void> {
  await assertAssetPositiveControl();
  if (vector === 'oversized') {
    const service = await assetService();
    const atLimit = path.join(sandbox, 'asset-at-limit.stl');
    await writeFile(
      atLimit,
      materialize('asset-at-limit', Buffer.from('solid ', 'ascii'), 0),
    );
    let approvalId = await stageAsset(service, atLimit, 'at-limit-copy.stl');
    await expect(
      service.validateFile(approvalId, 'SyntheticMethod'),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(service.getLastValidationMetrics().bytesRead).toBe(1024);

    const overLimit = path.join(sandbox, 'asset-over-limit.stl');
    await writeFile(
      overLimit,
      materialize('asset-over-limit', Buffer.from('solid ', 'ascii'), 0),
    );
    approvalId = await stageAsset(service, overLimit, 'over-limit-copy.stl');
    await expect(
      service.validateFile(approvalId, 'SyntheticMethod'),
    ).resolves.toMatchObject({ status: 'invalid', reason: 'tooLarge' });
    expect(service.getLastValidationMetrics().bytesRead).toBe(0);
    return;
  }

  if (vector === 'symlinkOrJunctionEscape') {
    const service = await assetService({ minSizeBytes: 134 });
    const target = path.join(outside, 'asset-target.stl');
    const linked = path.join(sandbox, 'asset-linked.stl');
    await symlink(target, linked, 'file');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [linked],
    });
    const picked = await service.pickFile(['stl'], 'Synthetic asset');
    if (picked.status !== 'ok')
      throw new Error(`Asset staging: ${picked.status}`);
    await expect(
      service.validateFile(picked.approvalId, 'SyntheticMethod'),
    ).resolves.toMatchObject({
      status: 'invalid',
      reason: 'pathRestricted',
    });
    expect(service.getLastValidationMetrics().bytesRead).toBe(0);
    return;
  }

  if (vector === 'mimeExtensionMismatch') {
    await validateAssetFixture(
      'asset/mime-mismatch.3mf',
      'contentTypeMismatch',
      {
        expectedExtension: '3mf',
        contentType: 'model/stl',
        minSizeBytes: 4,
      },
    );
    return;
  }

  if (vector === 'wrongMagicBytes') {
    await validateAssetFixture('asset/wrong-magic.stl', 'badMagicBytes');
    return;
  }

  if (vector === 'executableShapedContent') {
    await validateAssetFixture('asset/gcode-shaped.stl', 'badMagicBytes');
    await validateAssetFixture('asset/script-shaped.stl', 'badMagicBytes');
    return;
  }

  throw new Error(`Missing asset case for ${vector}`);
}

async function proveInapplicable(
  entryPoint: EntryPoint,
  vector: Vector,
): Promise<void> {
  const assetSource = await readFile(
    fixturePath('../../../src/main/calibrationAssetManifest.ts'),
    'utf8',
  );
  const orcaSource = await readFile(
    fixturePath('../../../src/main/orcaProfileValidation.ts'),
    'utf8',
  );
  if (entryPoint === 'orca' && vector === 'mimeExtensionMismatch') {
    expect(orcaSource).not.toMatch(/\b(?:mime|contentType)\b/i);
    return;
  }
  if (entryPoint === 'orca' && vector === 'malformedBase64DataUrl') {
    expect(orcaSource).not.toMatch(/base64|data:/i);
    return;
  }
  if (entryPoint !== 'asset') throw new Error('Unexpected inapplicable cell');

  if (vector === 'deeplyNestedJson' || vector === 'duplicateKeys') {
    expect(assetSource).not.toMatch(/JSON\.parse\(\s*content/);
    return;
  }
  if (vector === 'cyclicInheritance') {
    expect(assetSource).not.toContain('inherits');
    return;
  }
  if (vector === 'pathTraversal') {
    expect(assetSource).not.toMatch(/\b(?:unzipper|yauzl|adm-zip|extract)\b/);
    return;
  }
  if (vector === 'unsafeNumericValues') {
    expect(assetSource).toContain('readUInt32LE');
    expect(assetSource).not.toMatch(/read(?:Int|Float|Double)/);
    return;
  }
  if (vector === 'malformedBase64DataUrl') {
    expect(assetSource).not.toMatch(/base64|data:/i);
    return;
  }
  throw new Error(`Missing absence proof for ${entryPoint}:${vector}`);
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'pfd-corpus-'));
  sandbox = path.join(testRoot, 'sandbox');
  outside = path.join(testRoot, 'outside');
  await mkdir(sandbox);
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'unchanged');
  originalAppData = process.env['APPDATA'];
});

afterEach(async () => {
  if (originalAppData === undefined) delete process.env['APPDATA'];
  else process.env['APPDATA'] = originalAppData;
  vi.clearAllMocks();
  await rm(testRoot, { recursive: true, force: true });
});

describe('calibration malicious-input fixture provenance', () => {
  it('matches every committed fixture hash and byte length', async () => {
    expect(manifest.provenance).toContain('Synthetic hostile inputs');
    for (const fixture of manifest.fixtures) {
      const bytes = await readFile(fixturePath(fixture.file));
      expect(bytes.byteLength, fixture.file).toBe(fixture.byteLen);
      expect(hash(bytes), fixture.file).toBe(fixture.sha256);
    }
  });

  it('contains exactly one declared cell for all 11 vectors and 3 entry points', () => {
    expect(manifest.matrix).toHaveLength(33);
    expect(
      new Set(
        manifest.matrix.map(
          ({ vector, entryPoint }) => `${vector}:${entryPoint}`,
        ),
      ).size,
    ).toBe(33);
    expect(new Set(manifest.matrix.map(({ vector }) => vector)).size).toBe(11);
  });

  it('keeps the legacy depth fixture beyond the production boundary', async () => {
    const text = await readFile(
      fixturePath('legacy/deeply-nested.json'),
      'utf8',
    );
    expect(text.match(/"child":/g)?.length).toBeGreaterThan(
      MAX_JSON_NESTING_DEPTH,
    );
  });
});

describe('calibration malicious-input vector x entry-point matrix', () => {
  it.each(manifest.matrix)(
    '$vector x $entryPoint',
    async ({ vector, entryPoint, applicable, reason }) => {
      expect(reason === undefined).toBe(applicable);
      if (vector === 'symlinkOrJunctionEscape') {
        await copyFixture(
          'legacy/valid.json',
          path.join(outside, 'legacy-target.json'),
        );
        await copyFixture(
          'orca/valid.json',
          path.join(outside, 'outside-profile.json'),
        );
        await copyFixture(
          'asset/valid.stl',
          path.join(outside, 'asset-target.stl'),
        );
      }
      const outsideBefore = await snapshotTree(outside);

      if (!applicable) {
        await proveInapplicable(entryPoint, vector);
      } else if (entryPoint === 'legacy') {
        await runLegacyCell(vector);
      } else if (entryPoint === 'orca') {
        await runOrcaCell(vector);
      } else {
        await runAssetCell(vector);
      }

      expect(await snapshotTree(outside)).toEqual(outsideBefore);
    },
  );
});

describe('Orca hostile inheritance and structure shapes', () => {
  it('rejects a chain just beyond the inheritance budget', async () => {
    const files = Array.from(
      { length: 12 },
      (_, index) => `orca/inheritance-depth-${index}.json`,
    );
    const result = await runOrcaDiscovery(files);
    expect(result.profiles).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'inheritanceTooDeep',
    );
    expect(result.metrics.filesInspected).toBe(12);
  });

  it('rejects dangling inheritance with a typed diagnostic', async () => {
    const result = await runOrcaDiscovery(['orca/dangling-inheritance.json']);
    expect(result.profiles).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'missingParent' }),
    ]);
    expect(result.metrics.filesInspected).toBe(1);
  });

  it.each(['orca/empty-inheritance.json', 'orca/wide-profile.json'])(
    'handles bounded non-cyclic shape %s',
    async (file) => {
      const result = await runOrcaDiscovery([file]);
      expect(result.profiles).toHaveLength(1);
      expect(result.diagnostics).toEqual([]);
      expect(result.metrics.filesInspected).toBe(1);
      expect(result.metrics.bytesRead).toBeLessThanOrEqual(
        ORCA_PROFILE_MAX_BYTES,
      );
    },
  );
});
