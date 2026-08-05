// @vitest-environment node

/**
 * One malicious-input corpus across the untrusted calibration entry points
 * (#158).
 *
 * #158 lists thirteen vectors and asks that the *same* vector be proven
 * rejected at *every* entry point that can receive it. Two of the thirteen —
 * `zip / archive decompression bomb` and `decompression-bomb image in a staged
 * photo` — are excused-and-enforced in
 * `tests/calibrationUntrustedInputNoExpansion.test.ts`, because nothing on this
 * path expands its input. That guard is not repeated here; this file asserts
 * only that it still exists, and covers the other eleven.
 *
 * ## The three traps this file is built around
 *
 * **1. A malformed fixture rejects for schema reasons and looks exactly like
 * the entry point refusing the vector.** Every covered cell therefore runs a
 * `control` first: the *same* fixture with the vector removed, which must be
 * accepted. A cell whose control fails cannot bank as coverage, because the
 * attack fixture is then not demonstrably reaching the code under test.
 *
 * **2. "Typed rejection" is not one assertion, because the entry points reject
 * differently.** There is deliberately no shared `assertRejected` helper:
 *
 *   - `runLegacyBackupPreflight` throws `Error` with `.code = LEGACY_BACKUP_*`,
 *     and also classifies per project rather than throwing for content that is
 *     structurally valid but internally bad;
 *   - `installOrcaProfileWindows` / `computeInstallPath` /
 *     `canonicalizeSaveTarget` throw `OrcaInstallError` with a typed `code`;
 *   - `discoverLocalOrcaFilamentProfiles` **returns `[]` and skips bad
 *     profiles**, so its correct assertion is exclusion from results plus no
 *     writes plus bounded time — not a thrown code;
 *   - `CalibrationAssetManifestService.validateFile` returns
 *     `{ status: 'invalid', reason }` and never throws to the renderer.
 *
 * Each cell declares which of the four dispositions it expects, and the
 * disposition is produced by entry-point-specific code, not a shared helper.
 *
 * **3. A half-built corpus reports coverage it does not have.** The cell
 * registry below declares every (vector × entry point) pair exactly once, and
 * `the corpus is complete` fails if any pair is missing or duplicated. A pair
 * that is not applicable is `excused`, and an excused cell still runs an
 * assertion that the excuse is *currently true* — never a bare comment.
 *
 * ## Scope of the "no write outside the sandbox" check
 *
 * Each cell gets its own temporary `cellRoot` containing `sandbox/` (the only
 * tree the code under test may write to) and `outside/` (the escape target the
 * path-traversal and reparse-point fixtures aim at). The whole of `cellRoot`
 * *except* `sandbox/` is snapshotted before and after and must be byte-for-byte
 * identical afterwards. This is a comparison of an actual tree, not a reading
 * of the code path.
 *
 * The Orca entry points derive their roots from `APPDATA` / `HOME` /
 * `XDG_CONFIG_HOME` **at call time**, so those are redirected into `sandbox/`
 * and each Orca cell asserts the redirect took effect before running. That
 * assertion is what makes the tree comparison meaningful: without it the code
 * would be writing into the developer's real OrcaSlicer directory and the
 * sandbox would be trivially unchanged.
 *
 * ## Nothing in the corpus is executed
 *
 * No fixture is interpreted as G-code, applied as a profile, or run. The
 * `nothing in the corpus is executed` block below pins that structurally.
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => path.join(os.tmpdir(), 'pfd-corpus-userdata')),
  },
}));

import { dialog } from 'electron';
import {
  LegacyBackupProjectOutcome,
  OrcaProfileOperationError,
} from '@shared/ipc';
import {
  MAX_BACKUP_FILE_BYTES,
  mapImportError,
  runLegacyBackupPreflight,
} from '../src/main/calibrationImportV4.js';
import {
  discoverLocalOrcaFilamentProfiles,
  orcaUserDataRoots,
} from '../src/main/orcaProfileDiscovery.js';
import {
  OrcaInstallError,
  canonicalizeSaveTarget,
  computeInstallPath,
  getWindowsOrcaInstallRoot,
  installOrcaProfileWindows,
} from '../src/main/orcaProfileInstall.js';
import { CalibrationAssetManifestService } from '../src/main/calibrationAssetManifest.js';
import { RemoteCalibrationPrinterContext } from '../src/main/calibrationWire.js';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * A vector that neither completes nor rejects inside this budget has produced
 * the timeout #158 explicitly counts as a failure, not a pass.
 */
const TIME_BUDGET_MS = 5_000;

/**
 * Heap growth cap across one operation. Every fixture in this corpus is a few
 * kilobytes on disk; the largest thing any entry point should ever hold is the
 * file itself. A cap this generous cannot fire on ordinary parse churn, and any
 * amplification step large enough to matter blows straight past it.
 */
const HEAP_BUDGET_BYTES = 128 * 1024 * 1024;

/** Nothing in a synthetic corpus needs to be large. */
const MAX_COMMITTED_FIXTURE_BYTES = 8 * 1024;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mainDir = path.join(repoRoot, 'src', 'main');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'malicious-input');

function fixture(name: string): Buffer {
  const file = path.join(fixturesDir, name);
  if (!existsSync(file)) {
    throw new Error(`missing committed corpus fixture: ${name}`);
  }
  return readFileSync(file);
}

function fixtureText(name: string): string {
  return fixture(name).toString('utf8');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function mainSource(file: string): string {
  return readFileSync(path.join(mainDir, `${file}.ts`), 'utf8');
}

function relativeImportsOf(file: string): string[] {
  return [...mainSource(file).matchAll(/\bfrom\s+['"](\.[^'"]*)['"]/g)].map(
    (m) => m[1]!,
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const VECTORS = [
  'oversized',
  'deepJson',
  'cyclicInheritance',
  'duplicateKeys',
  'pathTraversal',
  'symlinkJunctionEscape',
  'wrongMagicBytes',
  'mimeExtensionMismatch',
  'unsafeNumerics',
  'malformedBase64',
  'gcodeOrScriptShaped',
] as const;
type Vector = (typeof VECTORS)[number];

/**
 * The two vectors settled by PR #357 as excused-and-enforced. They are listed
 * so the completeness check below can say *why* the matrix is 11 wide and not
 * 13, rather than silently being short by two.
 */
const VECTORS_SETTLED_ELSEWHERE: readonly string[] = [
  'archiveDecompressionBomb',
  'decompressionBombImage',
];

const ENTRY_POINTS = [
  'calibrationImportV4',
  'orcaProfileDiscovery',
  'orcaProfileInstall',
  'calibrationAssetManifest',
] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

/**
 * The four shapes a rejection takes across these entry points. Collapsing these
 * into one assertion is trap 2: `discoverLocalOrcaFilamentProfiles` never
 * throws, so a shared "expect it to throw a typed code" helper would pass
 * vacuously there.
 */
type Disposition =
  | { kind: 'threwTypedCode'; code: string }
  | { kind: 'typedInvalidResult'; reason: string }
  | { kind: 'excludedFromResults' }
  | { kind: 'classifiedContained'; note: string };

const EXCUSE_HOLDS = 'excuseHolds' as const;

interface CellContext {
  readonly cellRoot: string;
  readonly sandbox: string;
  readonly outside: string;
  /**
   * Re-take the "before" snapshot of everything outside the sandbox.
   *
   * Some cells have to *place* the escape target outside the sandbox before
   * they can attack it — a secret file to be read, a profile to be linked to.
   * Those writes are the test's own, not the code's, so the cell arms the guard
   * once its setup is finished and immediately before it calls the entry point.
   * A cell that never arms is measured from the empty sandbox, which is
   * strictly stricter, so forgetting to arm can only fail, never pass.
   */
  readonly armTreeGuard: () => Promise<void>;
}

interface Cell {
  readonly vector: Vector;
  readonly entryPoint: EntryPoint;
  /**
   * Present only on excused cells. The string is the reason the pair cannot
   * occur; `run` still has to prove that reason is true today.
   */
  readonly excusedBecause?: string;
  /** Platform gate, with the reason it exists, printed in the test name. */
  readonly onlyOn?: NodeJS.Platform;
  readonly onlyOnBecause?: string;
  readonly expect: Disposition | typeof EXCUSE_HOLDS;
  /**
   * The same fixture with the vector removed. Must be accepted. This is the
   * precondition that the attack fixture actually reaches the code under test.
   */
  readonly control?: (ctx: CellContext) => Promise<void>;
  readonly run: (
    ctx: CellContext,
  ) =>
    | Promise<Disposition | typeof EXCUSE_HOLDS>
    | Disposition
    | typeof EXCUSE_HOLDS;
}

// ---------------------------------------------------------------------------
// Sandbox, tree snapshot, environment redirection
// ---------------------------------------------------------------------------

const REDIRECTED_ENV = [
  'APPDATA',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
] as const;

async function makeCell(): Promise<{
  ctx: CellContext;
  armed: { snapshot: Map<string, string> | null };
  restore: () => Promise<void>;
}> {
  const cellRoot = await mkdtemp(path.join(os.tmpdir(), 'pfd-corpus-'));
  const sandbox = path.join(cellRoot, 'sandbox');
  const outside = path.join(cellRoot, 'outside');
  await mkdir(sandbox, { recursive: true });
  await mkdir(outside, { recursive: true });

  const saved = new Map<string, string | undefined>();
  for (const key of REDIRECTED_ENV) saved.set(key, process.env[key]);
  process.env['APPDATA'] = path.join(sandbox, 'appdata');
  process.env['HOME'] = path.join(sandbox, 'home');
  process.env['USERPROFILE'] = path.join(sandbox, 'home');
  process.env['XDG_CONFIG_HOME'] = path.join(sandbox, 'xdg');
  // Neutralise the system-install roots so discovery cannot wander into a real
  // Program Files tree and time out on someone's actual machine.
  process.env['PROGRAMFILES'] = path.join(sandbox, 'programfiles');
  process.env['PROGRAMFILES(X86)'] = path.join(sandbox, 'programfiles-x86');

  const armed: { snapshot: Map<string, string> | null } = { snapshot: null };
  const ctx: CellContext = {
    cellRoot,
    sandbox,
    outside,
    armTreeGuard: async () => {
      armed.snapshot = await snapshotOutsideSandbox(ctx);
    },
  };

  return {
    ctx,
    armed,
    restore: async () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cellRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * Snapshot every path under `cellRoot` that is NOT under `sandbox`, as
 * `relativePath -> size:mtime:kind`. Reparse points are recorded but never
 * followed, so a junction that escapes cannot hide a write by making the walk
 * loop.
 */
async function snapshotOutsideSandbox(
  ctx: CellContext,
): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (full === ctx.sandbox || full.startsWith(ctx.sandbox + path.sep)) {
        continue;
      }
      const rel = path.relative(ctx.cellRoot, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        seen.set(rel, 'reparse-point');
        continue;
      }
      if (entry.isDirectory()) {
        seen.set(rel, 'dir');
        await walk(full);
        continue;
      }
      const info = await stat(full);
      seen.set(rel, `file:${info.size}:${info.mtimeMs}`);
    }
  };
  await walk(ctx.cellRoot);
  return seen;
}

function expectNoWriteOutsideSandbox(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  expect(
    Object.fromEntries([...after].sort()),
    'the tree outside the temporary sandbox root changed',
  ).toEqual(Object.fromEntries([...before].sort()));
}

/**
 * Create a reparse point at `link` pointing at `target`.
 *
 * Windows junctions are directory-only and need no privilege; file symlinks
 * need `SeCreateSymbolicLinkPrivilege`, which a GitHub Actions Windows runner
 * may not grant. So on Windows we try a file symlink and fall back to a
 * junction over the target's directory. Either way the path under test is a
 * reparse point, which is the thing #158 asks to be handled — and the junction
 * fallback is specifically the Windows case the issue calls out.
 */
async function makeReparsePoint(
  target: string,
  link: string,
): Promise<'symlink' | 'junction'> {
  if (process.platform !== 'win32') {
    await symlink(target, link);
    return 'symlink';
  }
  try {
    await symlink(target, link, 'file');
    return 'symlink';
  } catch {
    await symlink(path.dirname(target), link, 'junction');
    return 'junction';
  }
}

async function makeDirReparsePoint(
  targetDir: string,
  link: string,
): Promise<'symlink' | 'junction'> {
  if (process.platform === 'win32') {
    await symlink(targetDir, link, 'junction');
    return 'junction';
  }
  await symlink(targetDir, link, 'dir');
  return 'symlink';
}

// ---------------------------------------------------------------------------
// Entry point 1 — legacy v4 backup. Throws Error with .code = LEGACY_BACKUP_*.
// ---------------------------------------------------------------------------

async function writeBackup(
  ctx: CellContext,
  name: string,
  bytes: Buffer | string,
): Promise<string> {
  const file = path.join(ctx.sandbox, name);
  await writeFile(file, bytes);
  return file;
}

/**
 * Run preflight and report the typed code it threw.
 *
 * A throw with no string `code` is a generic throw, which #158 counts as a
 * failure. `mapImportError` is asserted alongside because that is what turns
 * the thrown code into the renderer-facing error union: its fallback branch is
 * `serverError`, so a code it does not recognise would surface as a server
 * fault rather than a typed rejection of the input.
 */
async function v4ThrownCode(filePath: string): Promise<Disposition> {
  try {
    await runLegacyBackupPreflight(filePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    expect(error, 'preflight threw a non-Error').toBeInstanceOf(Error);
    expect(
      typeof code,
      `preflight threw without a typed code: ${String(error)}`,
    ).toBe('string');
    expect(String(code)).toMatch(/^LEGACY_BACKUP_/);
    expect(
      mapImportError(error).code,
      'the thrown code falls through mapImportError to the generic serverError branch',
    ).toBe('invalidData');
    return { kind: 'threwTypedCode', code: String(code) };
  }
  throw new Error('preflight accepted a fixture that carries the vector');
}

/**
 * Warnings a control fixture is allowed to carry.
 *
 * `findFirstDuplicateKey` in calibrationImportV4 scans key names *globally*
 * rather than per object (see the comment at its second pass), so any backup
 * that contains both a project and a photo repeats the key name `id` and earns
 * a duplicate-key warning even though no single object has a duplicate. That is
 * a false positive in a warning-only detector, not a rejection, so the control
 * still proves arrival — but it has to be named here rather than silently
 * tolerated, otherwise a real duplicate-key regression would hide behind it.
 */
const V4_CONTROL_KNOWN_WARNINGS = /^Duplicate JSON key detected: "id"/;

/** Preflight must accept the control fixture and classify it importable. */
async function v4ControlAccepted(
  ctx: CellContext,
  name: string,
  options: { readonly allowsGlobalIdKeyWarning?: boolean } = {},
): Promise<void> {
  const file = await writeBackup(ctx, `control-${name}`, fixture(name));
  const result = await runLegacyBackupPreflight(file);
  expect(
    result.importableCount,
    `control fixture ${name} did not reach the code under test as importable`,
  ).toBe(1);
  if (options.allowsGlobalIdKeyWarning) {
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(V4_CONTROL_KNOWN_WARNINGS);
  } else {
    expect(result.warnings).toEqual([]);
  }
}

// ---------------------------------------------------------------------------
// Entry point 2 — Orca discovery. Returns [] / excludes; never throws.
// ---------------------------------------------------------------------------

const CORPUS_PROFILE_NAME = 'PFD Corpus Filament';

function corpusPrinterContext() {
  return RemoteCalibrationPrinterContext.parse({
    printerId: 'printer-corpus-1',
    displayName: 'Corpus Printer',
    firmware: { firmware: 'Klipper', gcodeDialect: 'Klipper' },
    orcaProfileId: CORPUS_PROFILE_NAME,
    snapshotAt: '2026-07-01T12:00:00.000Z',
    configurationId: 'configuration-corpus-1',
    configurationRevision: 1,
    snapshotId: 'snapshot-corpus-1',
    contentHash: null,
    toolheads: [
      {
        toolId: 'tool-1',
        toolheadId: 'toolhead-1',
        extruderType: 'directDrive',
        nozzle: { id: 'nozzle-1', diameterMm: 0.4, material: 'hardened steel' },
      },
    ],
  });
}

/**
 * Seed the sandboxed OrcaSlicer user-data root, replacing whatever was there.
 *
 * Asserts the redirect took effect first. Without that assertion this helper
 * would happily seed the developer's real OrcaSlicer directory, and every
 * discovery cell would then be measuring the wrong tree.
 */
async function seedOrcaRoot(
  ctx: CellContext,
  files: Record<string, Buffer | string>,
): Promise<string> {
  const root = orcaUserDataRoots()[0];
  expect(root, 'no OrcaSlicer user data root resolved').toBeDefined();
  expect(
    root!.startsWith(ctx.sandbox + path.sep),
    `OrcaSlicer root ${root} is not inside the sandbox; the env redirect did not take`,
  ).toBe(true);
  await rm(root!, { recursive: true, force: true });
  await mkdir(root!, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root!, name), content);
  }
  return root!;
}

async function discoverNames(): Promise<string[]> {
  const entries = await discoverLocalOrcaFilamentProfiles(
    corpusPrinterContext(),
  );
  return entries.map((entry) => entry.orcaProfileId);
}

/** Discovery must find the control profile, or nothing below proves anything. */
async function discoveryControlFound(
  ctx: CellContext,
  files: Record<string, Buffer | string>,
): Promise<void> {
  await seedOrcaRoot(ctx, files);
  expect(
    await discoverNames(),
    'the control profile was not discovered, so no attack fixture below is reaching discovery',
  ).toEqual([CORPUS_PROFILE_NAME]);
}

// ---------------------------------------------------------------------------
// Entry point 3 — Orca install. Throws OrcaInstallError with a typed code.
// ---------------------------------------------------------------------------

/**
 * Report the typed code an install-path operation threw, and prove the code is
 * a member of the shared `OrcaProfileOperationError` union rather than a
 * free-form string.
 */
async function installThrownCode(
  operation: () => unknown,
): Promise<Disposition> {
  try {
    await operation();
  } catch (error) {
    expect(
      error,
      `install path threw something other than OrcaInstallError: ${String(error)}`,
    ).toBeInstanceOf(OrcaInstallError);
    const typed = error as OrcaInstallError;
    expect(() =>
      OrcaProfileOperationError.parse({
        code: typed.code,
        message: typed.message,
        retryable: typed.retryable,
      }),
    ).not.toThrow();
    return { kind: 'threwTypedCode', code: typed.code };
  }
  throw new Error('the install path accepted input that carries the vector');
}

async function installRoot(ctx: CellContext): Promise<string> {
  const root = getWindowsOrcaInstallRoot();
  expect(
    root.startsWith(ctx.sandbox + path.sep),
    `install root ${root} is not inside the sandbox; the APPDATA redirect did not take`,
  ).toBe(true);
  await mkdir(root, { recursive: true });
  return root;
}

const INSTALL_CONTROL_JSON = fixtureText('install-control.json');

/** The install pipeline must accept the control payload. */
async function installControlAccepted(ctx: CellContext): Promise<void> {
  const root = await installRoot(ctx);
  const result = await installOrcaProfileWindows(
    INSTALL_CONTROL_JSON,
    sha256(INSTALL_CONTROL_JSON),
    'pfd-corpus-control.json',
  );
  expect(result.installedHash).toBe(sha256(INSTALL_CONTROL_JSON));
  expect(existsSync(path.join(root, 'pfd-corpus-control.json'))).toBe(true);
}

// ---------------------------------------------------------------------------
// Entry point 4 — asset manifest. Returns { status: 'invalid', reason }.
// ---------------------------------------------------------------------------

const ASSET_METHOD = 'CorpusMethod';

const ASSET_INVALID_REASONS = [
  'badExtension',
  'badMagicBytes',
  'tooSmall',
  'tooLarge',
  'geometryOutOfBounds',
  'checksumMismatch',
  'methodDisabled',
  'approvalExpired',
] as const;

async function assetService(
  ctx: CellContext,
  entryOverrides: Record<string, unknown> = {},
): Promise<CalibrationAssetManifestService> {
  const manifestPath = path.join(ctx.sandbox, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      entries: [
        {
          method: ASSET_METHOD,
          enabled: true,
          disabledReason: null,
          sourceUrl: 'https://example.invalid/corpus-asset',
          author: 'PFD corpus (synthetic)',
          license: 'CC0-1.0',
          attribution: 'Synthetic fixture authored for this test corpus.',
          expectedFilename: null,
          contentType: 'model/stl',
          expectedExtension: 'stl',
          expectedSha256: null,
          minSizeBytes: 134,
          maxSizeBytes: 1024,
          validationRules: {},
          ...entryOverrides,
        },
      ],
    }),
    'utf8',
  );
  return new CalibrationAssetManifestService(manifestPath);
}

/** Stage a file through the picker exactly as the renderer flow would. */
async function assetStage(
  ctx: CellContext,
  service: CalibrationAssetManifestService,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const filePath = path.join(ctx.sandbox, filename);
  await writeFile(filePath, bytes);
  return assetStageExisting(service, filePath);
}

async function assetStageExisting(
  service: CalibrationAssetManifestService,
  filePath: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked needs the method reference itself; it is never called detached.
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: [filePath],
  });
  const picked = await service.pickFile(['stl', '3mf'], 'corpus');
  expect(picked.status).toBe('ok');
  return (picked as { approvalId: string }).approvalId;
}

/** Report the typed invalid reason, proving it is in the declared union. */
function assetInvalidReason(result: {
  status: string;
  reason?: string;
  detail?: string;
  message?: string;
}): Disposition {
  expect(
    result.status,
    `asset validation did not return a typed invalid result: ${JSON.stringify(result)}`,
  ).toBe('invalid');
  const reason = String(result.reason);
  expect(ASSET_INVALID_REASONS as readonly string[]).toContain(reason);
  return { kind: 'typedInvalidResult', reason };
}

/** The asset validator must accept the control asset. */
async function assetControlAccepted(ctx: CellContext): Promise<void> {
  const service = await assetService(ctx);
  const approvalId = await assetStage(
    ctx,
    service,
    'control.stl',
    fixture('asset-control.stl'),
  );
  const result = await service.validateFile(approvalId, ASSET_METHOD);
  expect(
    result.status,
    'the control asset was not accepted, so no asset cell below proves anything',
  ).toBe('ok');
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const CELLS: Cell[] = [
  // -------------------------------------------------------------------------
  // calibrationImportV4
  // -------------------------------------------------------------------------
  {
    vector: 'oversized',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_TOO_LARGE' },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) => {
      // Materialised rather than committed: a 50 MiB blob in git costs more
      // than the property it proves, and the bytes are irrelevant because the
      // size gate runs on lstat before a single byte is read.
      const file = path.join(ctx.sandbox, 'oversized.json');
      const handle = await open(file, 'w');
      await handle.truncate(MAX_BACKUP_FILE_BYTES + 1);
      await handle.close();
      return v4ThrownCode(file);
    },
  },
  {
    vector: 'deepJson',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_TOO_DEEP' },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) =>
      v4ThrownCode(
        await writeBackup(ctx, 'deep.json', fixture('v4-deep-nesting.json')),
      ),
  },
  {
    vector: 'cyclicInheritance',
    entryPoint: 'calibrationImportV4',
    excusedBecause:
      'a v4 backup has no profile inheritance graph. `generatedProfile.exactJson` ' +
      'is an opaque JSON string that is parsed and hashed but never resolved ' +
      'against any other profile, so there is no chain for a cycle to form in.',
    expect: EXCUSE_HOLDS,
    run: () => {
      expect(mainSource('calibrationImportV4')).not.toMatch(/\binherits\b/);
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'duplicateKeys',
    entryPoint: 'calibrationImportV4',
    // Preflight does not throw here: it accepts last-value-wins and surfaces
    // the duplicate as a warning. Asserting a thrown code would be asserting
    // behaviour this entry point does not have.
    expect: {
      kind: 'classifiedContained',
      note: 'duplicate key surfaced as a warning, last value wins',
    },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) => {
      const file = await writeBackup(
        ctx,
        'duplicate.json',
        fixture('v4-duplicate-keys.json'),
      );
      const result = await runLegacyBackupPreflight(file);
      expect(result.warnings.join(' ')).toMatch(/Duplicate JSON key/);
      expect(result.summary.projectCount).toBe(1);
      return {
        kind: 'classifiedContained',
        note: 'duplicate key surfaced as a warning, last value wins',
      };
    },
  },
  {
    vector: 'pathTraversal',
    entryPoint: 'calibrationImportV4',
    expect: {
      kind: 'classifiedContained',
      note: 'traversal-shaped fields stay data and are never dereferenced',
    },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) => {
      const secretPath = path.join(ctx.outside, 'secret.txt');
      await writeFile(secretPath, 'PFD_CORPUS_SECRET_MARKER\n', 'utf8');
      const file = await writeBackup(
        ctx,
        'traversal.json',
        fixtureText('v4-path-traversal-fields.json').replace(
          '__PFD_TRAVERSAL_TARGET__',
          secretPath.split('\\').join('\\\\'),
        ),
      );
      await ctx.armTreeGuard();
      const result = await runLegacyBackupPreflight(file);
      const outcome = result.projectOutcomes[0]!;
      expect(() => LegacyBackupProjectOutcome.parse(outcome)).not.toThrow();
      // The traversal strings survive verbatim as field data, which is the
      // point: they were never treated as paths.
      expect(outcome.name).toBe('../../../../etc/passwd');
      expect(JSON.stringify(result)).not.toContain('PFD_CORPUS_SECRET_MARKER');
      return {
        kind: 'classifiedContained',
        note: 'traversal-shaped fields stay data and are never dereferenced',
      };
    },
  },
  {
    vector: 'symlinkJunctionEscape',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_INVALID_FILE' },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) => {
      const target = path.join(ctx.outside, 'escaped.json');
      await writeFile(target, fixture('v4-control.json'));
      const link = path.join(ctx.sandbox, 'escape-link.json');
      await makeReparsePoint(target, link);
      await ctx.armTreeGuard();
      return v4ThrownCode(link);
    },
  },
  {
    vector: 'wrongMagicBytes',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_INVALID_MARKER' },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) =>
      v4ThrownCode(
        await writeBackup(ctx, 'magic.json', fixture('v4-wrong-magic.json')),
      ),
  },
  {
    vector: 'mimeExtensionMismatch',
    entryPoint: 'calibrationImportV4',
    // The MIME surface here is the staged photo's data URL, not the backup
    // file's extension: the photo declares image/png and carries JPEG magic.
    expect: {
      kind: 'classifiedContained',
      note: 'photo MIME/magic mismatch classified requiresAction',
    },
    control: (ctx) =>
      v4ControlAccepted(ctx, 'v4-photo-control.json', {
        allowsGlobalIdKeyWarning: true,
      }),
    run: async (ctx) => {
      const file = await writeBackup(
        ctx,
        'mime.json',
        fixture('v4-photo-mime-mismatch.json'),
      );
      const result = await runLegacyBackupPreflight(file);
      const outcome = result.projectOutcomes[0]!;
      expect(() => LegacyBackupProjectOutcome.parse(outcome)).not.toThrow();
      expect(outcome.outcome).toBe('requiresAction');
      expect(outcome.issues.join(' ')).toMatch(/PNG magic bytes do not match/);
      expect(outcome.photoCount).toBe(0);
      return {
        kind: 'classifiedContained',
        note: 'photo MIME/magic mismatch classified requiresAction',
      };
    },
  },
  {
    vector: 'unsafeNumerics',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_INVALID_SCHEMA' },
    control: (ctx) =>
      v4ControlAccepted(ctx, 'v4-control-number.json', {
        allowsGlobalIdKeyWarning: true,
      }),
    run: async (ctx) =>
      v4ThrownCode(
        await writeBackup(
          ctx,
          'numeric.json',
          fixture('v4-nonfinite-number.json'),
        ),
      ),
  },
  {
    vector: 'malformedBase64',
    entryPoint: 'calibrationImportV4',
    expect: {
      kind: 'classifiedContained',
      note: 'malformed data URL classified requiresAction',
    },
    control: (ctx) =>
      v4ControlAccepted(ctx, 'v4-photo-control.json', {
        allowsGlobalIdKeyWarning: true,
      }),
    run: async (ctx) => {
      const file = await writeBackup(
        ctx,
        'base64.json',
        fixture('v4-photo-malformed-base64.json'),
      );
      const result = await runLegacyBackupPreflight(file);
      const outcome = result.projectOutcomes[0]!;
      expect(() => LegacyBackupProjectOutcome.parse(outcome)).not.toThrow();
      expect(outcome.outcome).toBe('requiresAction');
      expect(outcome.issues.join(' ')).toMatch(/Invalid data URL format/);
      expect(outcome.photoCount).toBe(0);
      return {
        kind: 'classifiedContained',
        note: 'malformed data URL classified requiresAction',
      };
    },
  },
  {
    vector: 'gcodeOrScriptShaped',
    entryPoint: 'calibrationImportV4',
    expect: { kind: 'threwTypedCode', code: 'LEGACY_BACKUP_INVALID_MARKER' },
    control: (ctx) => v4ControlAccepted(ctx, 'v4-control.json'),
    run: async (ctx) =>
      v4ThrownCode(
        await writeBackup(ctx, 'gcode.json', fixture('v4-gcode-shaped.json')),
      ),
  },

  // -------------------------------------------------------------------------
  // orcaProfileDiscovery — returns [] / excludes, never throws
  // -------------------------------------------------------------------------
  {
    vector: 'oversized',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      // Materialised rather than committed for the same reason as the v4
      // oversized cell: only the size matters, and it is above MAX_FILE_BYTES.
      const oversized = JSON.stringify({
        type: 'filament',
        name: CORPUS_PROFILE_NAME,
        filament_type: 'PLA',
        pad: 'x'.repeat(1_100_000),
      });
      await seedOrcaRoot(ctx, { 'profile.json': oversized });
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },
  {
    vector: 'deepJson',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-deep-nesting.json'),
      });
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },
  {
    vector: 'cyclicInheritance',
    entryPoint: 'orcaProfileDiscovery',
    // The cycle is broken rather than rejected: resolution stops on a revisit
    // and the leaf profile is still returned. Bounded termination is the
    // property, and the time budget is what actually asserts it.
    expect: {
      kind: 'classifiedContained',
      note: 'inheritance cycle terminated, leaf still resolved',
    },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'a.json': fixture('orca-cycle-a.json'),
        'b.json': fixture('orca-cycle-b.json'),
      });
      expect(await discoverNames()).toEqual([CORPUS_PROFILE_NAME]);
      return {
        kind: 'classifiedContained',
        note: 'inheritance cycle terminated, leaf still resolved',
      };
    },
  },
  {
    vector: 'duplicateKeys',
    entryPoint: 'orcaProfileDiscovery',
    expect: {
      kind: 'classifiedContained',
      note: 'duplicate key resolved last-wins, deterministically',
    },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-duplicate-keys.json'),
      });
      const entries = await discoverLocalOrcaFilamentProfiles(
        corpusPrinterContext(),
      );
      expect(entries).toHaveLength(1);
      // Deterministic, not merged and not doubled: the later key wins.
      expect(entries[0]!.material).toBe('ABS');
      return {
        kind: 'classifiedContained',
        note: 'duplicate key resolved last-wins, deterministically',
      };
    },
  },
  {
    vector: 'pathTraversal',
    entryPoint: 'orcaProfileDiscovery',
    expect: {
      kind: 'classifiedContained',
      note: 'inherits is a name lookup, never a path',
    },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      // A profile outside the root that the traversal string names. If
      // `inherits` were ever resolved as a path, this content would merge in.
      await writeFile(
        path.join(ctx.outside, 'orca-outside.json'),
        fixture('orca-outside.json'),
      );
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-traversal-inherits.json'),
      });
      await ctx.armTreeGuard();
      const entries = await discoverLocalOrcaFilamentProfiles(
        corpusPrinterContext(),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.material).toBe('PLA');
      expect(entries[0]!.material).not.toBe('ESCAPED');
      return {
        kind: 'classifiedContained',
        note: 'inherits is a name lookup, never a path',
      };
    },
  },
  {
    vector: 'symlinkJunctionEscape',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      const escapedDir = path.join(ctx.outside, 'orca-escaped');
      await mkdir(escapedDir, { recursive: true });
      await writeFile(
        path.join(escapedDir, 'profile.json'),
        fixture('orca-outside.json'),
      );
      const root = await seedOrcaRoot(ctx, {});
      const kind = await makeDirReparsePoint(
        escapedDir,
        path.join(root, 'linked'),
      );
      expect(['symlink', 'junction']).toContain(kind);
      await ctx.armTreeGuard();
      // The escaped profile carries the same name as the control, so if
      // traversal followed the reparse point it would appear here.
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },
  {
    vector: 'wrongMagicBytes',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-wrong-magic.json'),
      });
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },
  {
    vector: 'mimeExtensionMismatch',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      // Byte-identical to the control, offered under a non-JSON extension.
      await seedOrcaRoot(ctx, { 'profile.txt': fixture('orca-control.json') });
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },
  {
    vector: 'unsafeNumerics',
    entryPoint: 'orcaProfileDiscovery',
    expect: {
      kind: 'classifiedContained',
      note: 'non-finite profile numbers never reach the emitted entry',
    },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-nonfinite-number.json'),
      });
      const entries = await discoverLocalOrcaFilamentProfiles(
        corpusPrinterContext(),
      );
      expect(entries).toHaveLength(1);
      // The emitted entry is built from the printer context, not from the
      // profile's numbers, and `OrcaProfileEntry` is finite-checked. A
      // non-finite value in the file cannot become a non-finite value here.
      expect(Number.isFinite(entries[0]!.nozzleDiameterMm)).toBe(true);
      expect(entries[0]!.nozzleDiameterMm).toBe(0.4);
      expect(JSON.stringify(entries)).not.toContain('null,null');
      return {
        kind: 'classifiedContained',
        note: 'non-finite profile numbers never reach the emitted entry',
      };
    },
  },
  {
    vector: 'malformedBase64',
    entryPoint: 'orcaProfileDiscovery',
    excusedBecause:
      'discovery never decodes base64 or data URLs. An Orca profile is JSON ' +
      'read as UTF-8 text; there is no encoded payload for a malformed encoding ' +
      'to be malformed in.',
    expect: EXCUSE_HOLDS,
    run: () => {
      // The closure is the module plus its single relative import, which is
      // type-only. Both are checked so the excuse covers everything discovery
      // can reach in this repository's own source.
      expect(relativeImportsOf('orcaProfileDiscovery')).toEqual([
        './calibrationWire.js',
      ]);
      for (const file of ['orcaProfileDiscovery', 'calibrationWire']) {
        expect(mainSource(file)).not.toMatch(/base64|atob\(|data:[a-z]+\//i);
      }
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'gcodeOrScriptShaped',
    entryPoint: 'orcaProfileDiscovery',
    expect: { kind: 'excludedFromResults' },
    control: (ctx) =>
      discoveryControlFound(ctx, {
        'profile.json': fixture('orca-control.json'),
      }),
    run: async (ctx) => {
      await seedOrcaRoot(ctx, {
        'profile.json': fixture('orca-gcode-shaped.json'),
      });
      expect(await discoverNames()).toEqual([]);
      return { kind: 'excludedFromResults' };
    },
  },

  // -------------------------------------------------------------------------
  // orcaProfileInstall — throws OrcaInstallError with a typed code
  // -------------------------------------------------------------------------
  {
    vector: 'oversized',
    entryPoint: 'orcaProfileInstall',
    onlyOn: 'win32',
    onlyOnBecause:
      'installOrcaProfileWindows is the only path that writes, and it refuses to run off Windows',
    expect: { kind: 'threwTypedCode', code: 'verificationFailed' },
    control: installControlAccepted,
    run: async (ctx) => {
      await installRoot(ctx);
      // Measured and stated plainly: install applies no size cap of its own.
      // The bound on what it will write is the content-hash gate — the caller
      // must already hold the hash of exactly these bytes — and that gate runs
      // before anything is created on disk.
      const oversized = JSON.stringify({
        type: 'filament',
        name: 'PFD Corpus Oversized',
        pad: 'x'.repeat(2_000_000),
      });
      return installThrownCode(() =>
        installOrcaProfileWindows(
          oversized,
          sha256(INSTALL_CONTROL_JSON),
          'pfd-corpus-oversized.json',
        ),
      );
    },
  },
  {
    vector: 'deepJson',
    entryPoint: 'orcaProfileInstall',
    excusedBecause:
      'install never interprets profile structure. It hashes the bytes, writes ' +
      'them, reads them back, and runs a single JSON.parse validity check — so ' +
      'there is no structural walk for nesting depth to exhaust. Structural ' +
      'bounds belong to generation, and the bytes are pinned by the hash gate.',
    expect: EXCUSE_HOLDS,
    run: () => {
      const source = mainSource('orcaProfileInstall');
      expect(source.match(/JSON\.parse\(/g) ?? []).toHaveLength(1);
      expect(source).not.toMatch(/\bzod\b|safeParse/);
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'cyclicInheritance',
    entryPoint: 'orcaProfileInstall',
    excusedBecause:
      'install resolves no inheritance chain. It writes one file and never ' +
      'reads a second profile, so there is no graph for a cycle to form in.',
    expect: EXCUSE_HOLDS,
    run: () => {
      expect(mainSource('orcaProfileInstall')).not.toMatch(/\binherits\b/);
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'duplicateKeys',
    entryPoint: 'orcaProfileInstall',
    excusedBecause:
      'install reads no keys. Duplicate keys change what a parser yields, and ' +
      'install parses only to check validity, discarding the result.',
    expect: EXCUSE_HOLDS,
    run: () => {
      const source = mainSource('orcaProfileInstall');
      // The single JSON.parse is a validity check whose value is discarded.
      expect(source).toMatch(/JSON\.parse\(readBack\);/);
      expect(source.match(/JSON\.parse\(/g) ?? []).toHaveLength(1);
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'pathTraversal',
    entryPoint: 'orcaProfileInstall',
    expect: { kind: 'threwTypedCode', code: 'pathRestricted' },
    control: async (ctx) => {
      const root = await installRoot(ctx);
      expect(computeInstallPath('pfd-corpus-control.json', root)).toBe(
        path.join(root, 'pfd-corpus-control.json'),
      );
    },
    run: async (ctx) => {
      const root = await installRoot(ctx);
      const disposition = await installThrownCode(() =>
        computeInstallPath(
          `..${path.sep}..${path.sep}outside${path.sep}evil.json`,
          root,
        ),
      );
      // Every separator shape, not just the platform's own.
      for (const attempt of [
        '../../outside/evil.json',
        '..\\..\\outside\\evil.json',
        '/etc/cron.d/evil.json',
        'C:\\Windows\\Temp\\evil.json',
        'evil\0.json',
      ]) {
        expect(() => computeInstallPath(attempt, root)).toThrow(
          OrcaInstallError,
        );
      }
      return disposition;
    },
  },
  {
    vector: 'symlinkJunctionEscape',
    entryPoint: 'orcaProfileInstall',
    expect: { kind: 'threwTypedCode', code: 'pathRestricted' },
    control: async (ctx) => {
      // A plain, non-reparse destination is accepted by the same guard.
      // Compared against the *canonical* parent because macOS resolves the
      // temp root through /private, so a literal comparison would fail there
      // for a reason that has nothing to do with the vector.
      const root = await installRoot(ctx);
      const plain = path.join(root, 'pfd-corpus-plain.json');
      await writeFile(plain, INSTALL_CONTROL_JSON, 'utf8');
      expect(await canonicalizeSaveTarget(plain)).toBe(
        path.join(await realpath(root), 'pfd-corpus-plain.json'),
      );
    },
    run: async (ctx) => {
      const root = await installRoot(ctx);
      const target = path.join(ctx.outside, 'escaped-profile.json');
      await writeFile(target, INSTALL_CONTROL_JSON, 'utf8');

      if (process.platform === 'win32') {
        // The Windows case #158 singles out: the destination the installer is
        // about to write is a reparse point aimed outside the sandbox. This is
        // where install writes actually happen, so it is the one that matters.
        const dest = path.join(root, 'pfd-corpus-escape.json');
        await makeReparsePoint(target, dest);
        await ctx.armTreeGuard();
        return installThrownCode(() =>
          installOrcaProfileWindows(
            INSTALL_CONTROL_JSON,
            sha256(INSTALL_CONTROL_JSON),
            'pfd-corpus-escape.json',
          ),
        );
      }
      // On macOS the writing path is the save-dialog export, guarded by
      // canonicalizeSaveTarget rather than by installOrcaProfileWindows.
      const link = path.join(ctx.sandbox, 'escape-save-target.json');
      await makeReparsePoint(target, link);
      await ctx.armTreeGuard();
      return installThrownCode(() => canonicalizeSaveTarget(link));
    },
  },
  {
    vector: 'wrongMagicBytes',
    entryPoint: 'orcaProfileInstall',
    onlyOn: 'win32',
    onlyOnBecause:
      'the write-then-verify pipeline this vector exercises exists only on Windows',
    expect: { kind: 'threwTypedCode', code: 'verificationFailed' },
    control: installControlAccepted,
    run: async (ctx) => {
      const root = await installRoot(ctx);
      const payload = fixture('install-zip-magic.bin').toString('utf8');
      const disposition = await installThrownCode(() =>
        installOrcaProfileWindows(
          payload,
          sha256(payload),
          'pfd-corpus-magic.json',
        ),
      );
      // Rejected *and* rolled back: no destination, no orphaned temp file.
      expect(existsSync(path.join(root, 'pfd-corpus-magic.json'))).toBe(false);
      expect(
        (await readdir(root)).filter((n) => n.startsWith('.pfd-tmp-')),
      ).toEqual([]);
      return disposition;
    },
  },
  {
    vector: 'mimeExtensionMismatch',
    entryPoint: 'orcaProfileInstall',
    expect: { kind: 'threwTypedCode', code: 'pathRestricted' },
    control: async (ctx) => {
      const root = await installRoot(ctx);
      expect(computeInstallPath('pfd-corpus-control.json', root)).toBe(
        path.join(root, 'pfd-corpus-control.json'),
      );
    },
    run: async (ctx) => {
      const root = await installRoot(ctx);
      const disposition = await installThrownCode(() =>
        computeInstallPath('pfd-corpus-control.exe', root),
      );
      for (const attempt of [
        'pfd-corpus.json.exe',
        'pfd-corpus.bat',
        'pfd-corpus.ps1',
        'pfd-corpus.3mf',
      ]) {
        expect(() => computeInstallPath(attempt, root)).toThrow(
          OrcaInstallError,
        );
      }
      return disposition;
    },
  },
  {
    vector: 'unsafeNumerics',
    entryPoint: 'orcaProfileInstall',
    excusedBecause:
      'install performs no arithmetic on profile content and makes no decision ' +
      'from a number in it. The only numbers it handles are byte counts it ' +
      'measures itself.',
    expect: EXCUSE_HOLDS,
    run: () => {
      const source = mainSource('orcaProfileInstall');
      expect(source).not.toMatch(/parseFloat|parseInt|Number\(/);
      expect(source.match(/JSON\.parse\(/g) ?? []).toHaveLength(1);
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'malformedBase64',
    entryPoint: 'orcaProfileInstall',
    excusedBecause:
      'install decodes nothing. Bytes arrive as a UTF-8 string, are hashed and ' +
      'written verbatim; there is no encoded payload on this path.',
    expect: EXCUSE_HOLDS,
    run: () => {
      // No relative imports at all, so the module *is* its own closure and this
      // single-file check is not narrower than the property it claims.
      expect(relativeImportsOf('orcaProfileInstall')).toEqual([]);
      expect(mainSource('orcaProfileInstall')).not.toMatch(
        /base64|atob\(|data:[a-z]+\//i,
      );
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'gcodeOrScriptShaped',
    entryPoint: 'orcaProfileInstall',
    onlyOn: 'win32',
    onlyOnBecause:
      'the write-then-verify pipeline this vector exercises exists only on Windows',
    expect: { kind: 'threwTypedCode', code: 'verificationFailed' },
    control: installControlAccepted,
    run: async (ctx) => {
      const root = await installRoot(ctx);
      const payload = fixtureText('install-gcode-payload.txt');
      const disposition = await installThrownCode(() =>
        installOrcaProfileWindows(
          payload,
          sha256(payload),
          'pfd-corpus-gcode.json',
        ),
      );
      expect(existsSync(path.join(root, 'pfd-corpus-gcode.json'))).toBe(false);
      expect(
        (await readdir(root)).filter((n) => n.startsWith('.pfd-tmp-')),
      ).toEqual([]);
      return disposition;
    },
  },

  // -------------------------------------------------------------------------
  // calibrationAssetManifest — { status: 'invalid', reason }
  // -------------------------------------------------------------------------
  {
    vector: 'oversized',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'tooLarge' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      // Structurally valid binary STL, above the manifest's maxSizeBytes.
      const triangles = 100;
      const big = Buffer.alloc(80 + 4 + triangles * 50, 0);
      big.writeUInt32LE(triangles, 80);
      const approvalId = await assetStage(ctx, service, 'big.stl', big);
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'deepJson',
    entryPoint: 'calibrationAssetManifest',
    // Note what the reason is: a *structural STL* rejection, not a JSON one.
    // This entry point never parses the asset as JSON, which is exactly why a
    // nesting depth cannot be reached.
    expect: { kind: 'typedInvalidResult', reason: 'geometryOutOfBounds' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      const approvalId = await assetStage(
        ctx,
        service,
        'deep.stl',
        fixture('asset-deep-nesting.stl'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'cyclicInheritance',
    entryPoint: 'calibrationAssetManifest',
    excusedBecause:
      'a calibration asset is a model file, not a profile, and the manifest ' +
      'entries are a flat reviewed list. Nothing on this path follows a ' +
      'reference from one document to another, so there is no chain to cycle.',
    expect: EXCUSE_HOLDS,
    run: () => {
      expect(relativeImportsOf('calibrationAssetManifest')).toEqual([]);
      expect(mainSource('calibrationAssetManifest')).not.toMatch(
        /\binherits\b|\bextends\b/,
      );
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'duplicateKeys',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'badMagicBytes' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      const approvalId = await assetStage(
        ctx,
        service,
        'duplicate.stl',
        fixture('asset-duplicate-keys.stl'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'pathTraversal',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'approvalExpired' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      // Stage a real file so the store is non-empty: the rejection below has to
      // be the traversal failing to name anything, not an empty map.
      await assetStage(
        ctx,
        service,
        'staged.stl',
        fixture('asset-control.stl'),
      );
      const secret = path.join(ctx.outside, 'secret.stl');
      await writeFile(secret, fixture('asset-control.stl'));
      await ctx.armTreeGuard();

      const disposition = assetInvalidReason(
        await service.validateFile(
          `..${path.sep}..${path.sep}outside${path.sep}secret.stl`,
          ASSET_METHOD,
        ),
      );
      // The renderer cannot name a path at all: the only handle it holds is an
      // opaque approval id, and an absolute path is just as unknown as a
      // relative one.
      for (const attempt of [
        secret,
        '../../etc/passwd',
        'C:\\Windows\\win.ini',
      ]) {
        const result = await service.validateFile(attempt, ASSET_METHOD);
        expect(result.status).toBe('invalid');
        expect((result as { reason: string }).reason).toBe('approvalExpired');
      }
      return disposition;
    },
  },
  {
    vector: 'symlinkJunctionEscape',
    entryPoint: 'calibrationAssetManifest',
    // Measured and stated plainly: this entry point does NOT reject reparse
    // points. It is a read-only validator over a file the user chose in the OS
    // picker, so following a link the user themselves selected is not an
    // escape. What has to hold instead is that it writes nothing anywhere and
    // discloses no path back across the IPC boundary — which is what this cell
    // asserts, and what the tree comparison around it enforces.
    expect: {
      kind: 'classifiedContained',
      note: 'read-only through the reparse point, no write and no path disclosed',
    },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      const escapedDir = path.join(ctx.outside, 'asset-escaped');
      await mkdir(escapedDir, { recursive: true });
      await writeFile(
        path.join(escapedDir, 'escaped.stl'),
        fixture('asset-control.stl'),
      );
      const link = path.join(ctx.sandbox, 'linked');
      const kind = await makeDirReparsePoint(escapedDir, link);
      expect(['symlink', 'junction']).toContain(kind);
      await ctx.armTreeGuard();

      const approvalId = await assetStageExisting(
        service,
        path.join(link, 'escaped.stl'),
      );
      const result = await service.validateFile(approvalId, ASSET_METHOD);
      expect(result.status).toBe('ok');
      // No path, absolute or otherwise, crosses back to the renderer.
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('escaped.stl');
      expect(serialised).not.toContain(ctx.outside.split('\\').join('\\\\'));
      expect(Object.keys(result)).not.toContain('filePath');
      return {
        kind: 'classifiedContained',
        note: 'read-only through the reparse point, no write and no path disclosed',
      };
    },
  },
  {
    vector: 'wrongMagicBytes',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'badMagicBytes' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      const approvalId = await assetStage(
        ctx,
        service,
        'magic.stl',
        fixture('asset-wrong-magic.stl'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'mimeExtensionMismatch',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'badExtension' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      // Byte-identical to the control asset, offered under the wrong extension.
      expect(fixture('asset-extension-mismatch.3mf')).toEqual(
        fixture('asset-control.stl'),
      );
      const approvalId = await assetStage(
        ctx,
        service,
        'mismatch.3mf',
        fixture('asset-extension-mismatch.3mf'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'unsafeNumerics',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'geometryOutOfBounds' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      // Header declares 0xFFFFFFFF triangles in a 134-byte file. The declared
      // count is attacker-controlled and is never trusted to size anything.
      const approvalId = await assetStage(
        ctx,
        service,
        'overflow.stl',
        fixture('asset-triangle-count-overflow.stl'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
  {
    vector: 'malformedBase64',
    entryPoint: 'calibrationAssetManifest',
    excusedBecause:
      'the asset path decodes nothing. A staged file is read as raw bytes and ' +
      'compared to magic signatures; there is no encoded payload to malform.',
    expect: EXCUSE_HOLDS,
    run: () => {
      expect(relativeImportsOf('calibrationAssetManifest')).toEqual([]);
      expect(mainSource('calibrationAssetManifest')).not.toMatch(
        /base64|atob\(|data:[a-z]+\//i,
      );
      return EXCUSE_HOLDS;
    },
  },
  {
    vector: 'gcodeOrScriptShaped',
    entryPoint: 'calibrationAssetManifest',
    expect: { kind: 'typedInvalidResult', reason: 'badMagicBytes' },
    control: assetControlAccepted,
    run: async (ctx) => {
      const service = await assetService(ctx);
      const approvalId = await assetStage(
        ctx,
        service,
        'gcode.stl',
        fixture('asset-gcode-shaped.stl'),
      );
      return assetInvalidReason(
        await service.validateFile(approvalId, ASSET_METHOD),
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cellTitle(cell: Cell): string {
  const base = `${cell.vector} × ${cell.entryPoint}`;
  if (cell.excusedBecause !== undefined)
    return `${base} — excused, and the excuse still holds`;
  if (cell.onlyOn !== undefined) {
    return `${base} [${cell.onlyOn} only: ${cell.onlyOnBecause}]`;
  }
  return base;
}

describe('malicious-input corpus (#158)', () => {
  for (const cell of CELLS) {
    const runner =
      cell.onlyOn === undefined
        ? it
        : it.runIf(process.platform === cell.onlyOn);

    runner(
      cellTitle(cell),
      async () => {
        const { ctx, armed, restore } = await makeCell();
        try {
          const before = await snapshotOutsideSandbox(ctx);

          // Trap 1: the fixture has to arrive before its rejection means anything.
          if (cell.control) await cell.control(ctx);

          const heapBefore = process.memoryUsage().heapUsed;
          const startedAt = performance.now();
          const disposition = await cell.run(ctx);
          const elapsedMs = performance.now() - startedAt;
          const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

          expect(disposition).toEqual(cell.expect);
          expect(
            elapsedMs,
            `the vector took ${elapsedMs.toFixed(0)}ms; a timeout is a failure, not a pass`,
          ).toBeLessThan(TIME_BUDGET_MS);
          expect(
            heapGrowth,
            `the vector grew the heap by ${heapGrowth} bytes`,
          ).toBeLessThan(HEAP_BUDGET_BYTES);

          expectNoWriteOutsideSandbox(
            armed.snapshot ?? before,
            await snapshotOutsideSandbox(ctx),
          );
        } finally {
          await restore();
        }
      },
      TIME_BUDGET_MS * 4,
    );
  }
});

// ---------------------------------------------------------------------------
// The corpus is complete, and honest about what it is
// ---------------------------------------------------------------------------

describe('the corpus is complete', () => {
  it('declares every (vector × entry point) pair exactly once', () => {
    const declared = CELLS.map((c) => `${c.vector}::${c.entryPoint}`).sort();
    const required = VECTORS.flatMap((v) =>
      ENTRY_POINTS.map((e) => `${v}::${e}`),
    ).sort();
    expect(declared).toEqual(required);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('accounts for the two vectors settled outside this file', () => {
    // #158 lists thirteen vectors and this matrix is eleven wide. Without this
    // assertion the shortfall is indistinguishable from having forgotten two.
    expect(VECTORS_SETTLED_ELSEWHERE).toHaveLength(2);
    const guard = path.join(
      repoRoot,
      'tests',
      'calibrationUntrustedInputNoExpansion.test.ts',
    );
    expect(existsSync(guard)).toBe(true);
    const source = readFileSync(guard, 'utf8');
    expect(source).toContain('decompression bomb');
    expect(source).toContain('MAX_PHOTO_DECODED_BYTES');
  });

  it('gives every excused pair a stated reason', () => {
    for (const cell of CELLS) {
      if (cell.expect !== EXCUSE_HOLDS) continue;
      expect(
        cell.excusedBecause ?? '',
        `${cell.vector} × ${cell.entryPoint} is excused without a reason`,
      ).not.toBe('');
      expect((cell.excusedBecause ?? '').length).toBeGreaterThan(60);
    }
  });

  it('gives every covered pair a control that proves the fixture arrives', () => {
    for (const cell of CELLS) {
      if (cell.expect === EXCUSE_HOLDS) continue;
      expect(
        cell.control,
        `${cell.vector} × ${cell.entryPoint} has no control, so it could pass for having never arrived`,
      ).toBeTypeOf('function');
    }
  });

  it('gives every platform-gated pair a stated reason', () => {
    for (const cell of CELLS) {
      if (cell.onlyOn === undefined) continue;
      expect(cell.onlyOn).toBe('win32');
      expect(cell.onlyOnBecause ?? '').not.toBe('');
    }
  });
});

describe('the fixtures are synthetic and committed', () => {
  it('is a committed directory, not something generated at import time', () => {
    expect(existsSync(fixturesDir)).toBe(true);
    expect(
      readFileSync(path.join(fixturesDir, 'asset-control.stl')).length,
    ).toBe(134);
  });

  it('holds nothing large enough to be a real model or a real user profile', () => {
    const files = readdirSyncSorted(fixturesDir);
    expect(files.length).toBeGreaterThan(20);
    for (const name of files) {
      const size = readFileSync(path.join(fixturesDir, name)).length;
      expect(size, `${name} is ${size} bytes`).toBeLessThanOrEqual(
        MAX_COMMITTED_FIXTURE_BYTES,
      );
    }
  });

  it('carries the marker that says the STL fixtures are authored, not harvested', () => {
    for (const name of [
      'asset-control.stl',
      'asset-triangle-count-overflow.stl',
    ]) {
      expect(fixture(name).subarray(0, 39).toString('ascii')).toBe(
        'PFD synthetic binary STL corpus fixture',
      );
    }
  });
});

function readdirSyncSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}

// ---------------------------------------------------------------------------
// Nothing in the corpus is executed
// ---------------------------------------------------------------------------

/**
 * Execution primitives, as a source-level pattern.
 *
 * Deliberately *not* `\bexec\w*\(`: that matches `RegExp.prototype.exec`, which
 * every one of these files uses for parsing and which executes nothing. The
 * pattern below names the primitives themselves — process creation, dynamic
 * evaluation, and the vm module — so a false positive cannot be argued away and
 * a real one cannot hide behind a regex call.
 */
const EXECUTION_PRIMITIVE =
  /\bchild_process\b|\bexecFile\b|\bexecSync\b|\bspawn(?:Sync)?\s*\(|\beval\s*\(|\bnew Function\b|\bnode:vm\b/;

describe('nothing in the corpus is executed', () => {
  const NEVER_EXECUTES = [
    'calibrationImportV4',
    'orcaProfileDiscovery',
    'calibrationAssetManifest',
  ];

  it('the execution-primitive pattern actually fires', () => {
    // Positive control: without this, a pattern that matched nothing would look
    // exactly like four clean files.
    for (const sample of [
      "import { execFile } from 'node:child_process';",
      'const child = spawn("cmd");',
      'eval(untrusted);',
      'const f = new Function(untrusted);',
      "await import('node:vm');",
    ]) {
      expect(sample).toMatch(EXECUTION_PRIMITIVE);
    }
    // Negative control: a regex `.exec` call is not execution.
    expect('const m = PATTERN.exec(text);').not.toMatch(EXECUTION_PRIMITIVE);
  });

  for (const file of NEVER_EXECUTES) {
    it(`${file} reaches no execution primitive`, () => {
      expect(mainSource(file)).not.toMatch(EXECUTION_PRIMITIVE);
    });
  }

  it('orcaProfileInstall runs exactly one subprocess, and never one derived from input', () => {
    const source = mainSource('orcaProfileInstall');
    // Install is the one entry point that does spawn something: `tasklist`, to
    // check whether OrcaSlicer holds the file open. The property that matters
    // is that the command and its whole argv are literals, so no byte of a
    // profile can become a command or an argument.
    const calls = source.match(/execFileAsync\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).toMatch(
      /execFileAsync\(\s*'tasklist',\s*\[\s*'\/FI',\s*'IMAGENAME eq OrcaSlicer\.exe',\s*'\/NH',\s*'\/FO',\s*'CSV',?\s*\]/,
    );
    expect(source).not.toMatch(
      /\bexecSync\b|\bspawn\w*\(|\beval\(|new Function|node:vm/,
    );
    expect(source).not.toMatch(/\bshell\s*:/);
  });

  it('no entry point writes a fixture anywhere it could later be run', () => {
    // The only entry point that writes at all is install, and it writes exactly
    // one destination computed by computeInstallPath, which refuses anything
    // that is not a bare `.json` name.
    for (const file of [
      'calibrationImportV4',
      'orcaProfileDiscovery',
      'calibrationAssetManifest',
    ]) {
      expect(mainSource(file)).not.toMatch(
        /\bwriteFile\(|\bappendFile\(|\bcreateWriteStream\(/,
      );
    }
  });
});
