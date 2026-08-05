import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type {
  BrowserWindow,
  OpenDialogOptions,
  SaveDialogOptions,
} from 'electron';
import type { SidecarClient } from './sidecar.js';
import { TargetProfileService } from './targetProfiles.js';

const TTL_MS = 30 * 60 * 1000;
const OWNER_MARKER = '.printfarmer-retarget-owner.json';
const instanceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownerMarker = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().regex(instanceIdPattern),
    pid: z.number().int().positive(),
  })
  .strict();
const sha = /^[a-f0-9]{64}$/;
const token = (): string => randomBytes(32).toString('base64url');
const nativeOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), value: z.unknown() }).strict(),
  z
    .object({
      status: z.literal('blocked'),
      blockers: z.array(z.unknown()).max(100),
      warnings: z.array(z.unknown()).max(100),
      value: z.unknown().nullable().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      error: z
        .object({
          code: z.string().max(128),
          message: z.string().max(2048),
          action: z.string().max(2048),
          part: z.string().max(2048).nullable().optional(),
          setting: z.string().max(2048).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
]);
const models = z
  .array(
    z
      .object({
        hash: z.string().regex(sha),
        format: z.enum(['stl', 'threeMf', 'obj']),
        locations: z
          .array(
            z
              .object({
                rootId: z.string().min(1).max(256),
                path: z.string().min(1).max(4096),
                rootRelative: z.string().max(4096),
                available: z.boolean(),
              })
              .passthrough(),
          )
          .max(100),
      })
      .passthrough(),
  )
  .max(100_000);

type Sidecar = Pick<
  SidecarClient,
  | 'listModels'
  | 'preflightRetarget'
  | 'buildRetarget'
  | 'validateRetargetOutput'
  | 'loadRetargetScene'
  | 'scanRoot'
>;
export interface Dialogs {
  showSaveDialog(
    owner: BrowserWindow,
    options: SaveDialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(
    owner: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}
interface ArtifactRecord {
  owner: number;
  sourcePath: string;
  sourceHash: string;
  modelHash: string;
  rootId: string;
  objectExclusion: boolean;
  profileId: string;
  fingerprint: string;
  createdAt: number;
  dir: string;
  phase: 'preflight' | 'review';
  outputPath?: string;
  outputHash?: string;
  busy: boolean;
}
export interface RetargetArtifactServiceOptions {
  sidecar: Sidecar;
  profiles: Pick<
    TargetProfileService,
    'getPrivateReference' | 'getFingerprint'
  >;
  dialogs: Dialogs;
  tempPath?: string;
  now?: () => number;
}

export class RetargetArtifactService {
  private readonly appRoot: string;
  private readonly parentRoot: string;
  private readonly root: string;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly records = new Map<string, ArtifactRecord>();
  constructor(private readonly options: RetargetArtifactServiceOptions) {
    this.appRoot = path.join(options.tempPath ?? os.tmpdir(), 'PrintFarmer');
    this.parentRoot = path.join(this.appRoot, 'retarget');
    this.instanceId = randomUUID();
    this.root = path.join(this.parentRoot, this.instanceId);
    this.now = options.now ?? Date.now;
  }
  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.appRoot);
    await ensurePrivateDirectory(this.parentRoot);
    for (const entry of await readdir(this.parentRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !instanceIdPattern.test(entry.name)) continue;
      const candidate = path.join(this.parentRoot, entry.name);
      const marker = await readOwnerMarker(candidate);
      if (!marker || isProcessRunning(marker.pid)) continue;
      // Reaping another instance's leftovers is opportunistic. A directory that
      // is merely busy is left for a later sweep; only a temp root the
      // filesystem cannot serve at all aborts startup.
      try {
        await removeOwnedInstance(candidate, marker.instanceId);
      } catch (error) {
        if (isBrokenTempRootError(error)) throw error;
        // Left for a later sweep, by this process or another one.
      }
    }
    await mkdir(this.root, { mode: 0o700 });
    await writeFile(
      path.join(this.root, OWNER_MARKER),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: this.instanceId,
        pid: process.pid,
      }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  }
  async disposeArtifacts(): Promise<void> {
    await Promise.all(
      [...this.records.keys()].map((value) => this.dispose(value)),
    );
  }

  async disposeAll(): Promise<void> {
    await this.disposeArtifacts();
    await removeOwnedInstance(this.root, this.instanceId);
  }

  async preflight(
    owner: number,
    request: {
      modelHash: string;
      rootId: string;
      profileId: string;
      objectExclusion: boolean;
    },
  ): Promise<unknown> {
    if (!sha.test(request.modelHash)) return error('invalidRequest');
    await this.disposeOwner(owner);
    const reference = this.options.profiles.getPrivateReference(
      request.profileId,
    );
    const fingerprint = this.options.profiles.getFingerprint(request.profileId);
    if (!reference || !fingerprint) return error('profileNotFound');
    const source = await this.resolveSource(request.modelHash, request.rootId);
    if (!source) return error('invalidRequest');
    const sourceHash = await hashFile(source);
    if (sourceHash !== request.modelHash) return error('sourceChanged');
    const raw = nativeOutcome.parse(
      await this.options.sidecar.preflightRetarget(
        source,
        reference,
        request.objectExclusion,
      ),
    );
    if (raw.status !== 'ok' && raw.status !== 'blocked')
      return nativeFailure(raw.error);
    if (raw.status === 'blocked' && !raw.value) {
      return {
        status: 'blocked',
        blockers: sanitizeIssues(raw.blockers),
        warnings: sanitizeIssues(raw.warnings),
        value: null,
      };
    }
    const report = sanitizePreflight(raw.value);
    const artifactToken = token();
    const dir = path.join(this.root, artifactToken);
    await mkdir(dir, { recursive: true });
    this.records.set(artifactToken, {
      owner,
      sourcePath: source,
      sourceHash,
      modelHash: request.modelHash,
      rootId: request.rootId,
      objectExclusion: request.objectExclusion,
      profileId: request.profileId,
      fingerprint,
      createdAt: this.now(),
      dir,
      phase: 'preflight',
      busy: false,
    });
    return raw.status === 'ok'
      ? { status: 'ok', value: { token: artifactToken, report } }
      : {
          status: 'blocked',
          blockers: sanitizeIssues(raw.blockers),
          warnings: sanitizeIssues(raw.warnings),
          value: { token: artifactToken, report },
        };
  }

  async build(
    owner: number,
    request: { token: string; profileId: string; objectExclusion: boolean },
  ): Promise<unknown> {
    const record = await this.lock(owner, request.token);
    if ('status' in record) return record;
    try {
      if (
        record.phase !== 'preflight' ||
        record.profileId !== request.profileId ||
        record.objectExclusion !== request.objectExclusion ||
        record.fingerprint !==
          this.options.profiles.getFingerprint(request.profileId)
      )
        return error('invalidRequest');
      const reference = this.options.profiles.getPrivateReference(
        request.profileId,
      );
      if (
        !reference ||
        (await hashFile(record.sourcePath)) !== record.sourceHash
      )
        return error('sourceChanged');
      const outputPath = path.join(record.dir, `${randomUUID()}.3mf`);
      const built = nativeOutcome.parse(
        await this.options.sidecar.buildRetarget(
          record.sourcePath,
          outputPath,
          reference,
          request.objectExclusion,
        ),
      );
      if (built.status !== 'ok')
        return built.status === 'blocked'
          ? {
              status: 'blocked',
              blockers: sanitizeIssues(built.blockers),
              warnings: sanitizeIssues(built.warnings),
              value: null,
            }
          : nativeFailure(built.error);
      const validated = nativeOutcome.parse(
        await this.options.sidecar.validateRetargetOutput(
          record.sourcePath,
          outputPath,
          reference,
          request.objectExclusion,
        ),
      );
      if (
        validated.status !== 'ok' ||
        !validValidation(validated.value, record.sourceHash)
      ) {
        await rm(outputPath, { force: true });
        await this.dispose(request.token);
        return validated.status === 'blocked'
          ? {
              status: 'blocked',
              blockers: sanitizeIssues(validated.blockers),
              warnings: sanitizeIssues(validated.warnings),
              value: null,
            }
          : validated.status === 'error'
            ? nativeFailure(validated.error)
            : error('internalError');
      }
      const outputHash = await hashFile(outputPath);
      if (
        readString(built.value, 'sourceSha256') !== record.sourceHash ||
        readString(built.value, 'outputSha256') !== outputHash
      ) {
        await this.dispose(request.token);
        return error('internalError');
      }
      record.outputPath = outputPath;
      record.outputHash = outputHash;
      record.phase = 'review';
      return { status: 'ok', value: sanitizeBuild(built.value) };
    } catch {
      return error('internalError');
    } finally {
      record.busy = false;
    }
  }

  async loadScene(
    owner: number,
    request: { token: string; source: 'source' | 'output' },
  ): Promise<unknown> {
    const record = await this.lock(owner, request.token);
    if ('status' in record) return record;
    try {
      const file =
        request.source === 'source'
          ? record.sourcePath
          : record.phase === 'review'
            ? record.outputPath
            : undefined;
      if (!file) return error('artifactNotFound');
      return {
        status: 'ok',
        value: await this.options.sidecar.loadRetargetScene(file),
      };
    } catch {
      return error('sidecarUnavailable');
    } finally {
      record.busy = false;
    }
  }

  async saveAs(
    owner: number,
    artifactToken: string,
    window: BrowserWindow,
  ): Promise<unknown> {
    const record = await this.lock(owner, artifactToken);
    if ('status' in record) return record;
    try {
      if (record.phase !== 'review' || !record.outputPath)
        return error('artifactNotFound');
      const picked = await this.options.dialogs.showSaveDialog(window, {
        title: 'Save retargeted Snapmaker U1 project',
        defaultPath: path.join(
          path.dirname(record.sourcePath),
          `${path.basename(record.sourcePath, path.extname(record.sourcePath))}-Snapmaker-U1.3mf`,
        ),
        filters: [{ name: '3MF project', extensions: ['3mf'] }],
      });
      if (picked.canceled || !picked.filePath) return { status: 'canceled' };
      const destination = picked.filePath;
      if (path.extname(destination).toLowerCase() !== '.3mf')
        return error('saveFailed');
      const sourcePath = await realpath(record.sourcePath);
      const destinationParent = await realpath(path.dirname(destination));
      const normalizedDestination = path.join(
        destinationParent,
        path.basename(destination),
      );
      if (
        samePath(normalizedDestination, sourcePath) ||
        ((await exists(destination)) &&
          samePath(await realpath(destination), sourcePath))
      )
        return error('saveSourceConflict');
      if (await exists(destination)) return error('saveDestinationExists');
      if (!(await lstat(destinationParent)).isDirectory())
        return error('saveFailed');
      await copyExclusive(record.outputPath, normalizedDestination);
      const refreshWarning = await this.refreshCatalog(normalizedDestination);
      await this.dispose(artifactToken);
      return {
        status: 'ok',
        fileName: path.basename(normalizedDestination),
        refreshWarning,
      };
    } catch {
      return error('saveFailed');
    } finally {
      record.busy = false;
    }
  }

  async dispose(artifactToken: string): Promise<{ disposed: boolean }> {
    const record = this.records.get(artifactToken);
    if (!record) return { disposed: false };
    this.records.delete(artifactToken);
    await rm(record.dir, { recursive: true, force: true });
    return { disposed: true };
  }
  async disposeForOwner(
    owner: number,
    artifactToken: string,
  ): Promise<{ disposed: boolean }> {
    const record = this.records.get(artifactToken);
    return !record || record.owner !== owner
      ? { disposed: false }
      : this.dispose(artifactToken);
  }
  async disposeOwner(owner: number): Promise<void> {
    await Promise.all(
      [...this.records.entries()]
        .filter(([, record]) => record.owner === owner)
        .map(([value]) => this.dispose(value)),
    );
  }

  private async lock(
    owner: number,
    artifactToken: string,
  ): Promise<ArtifactRecord | ReturnType<typeof error>> {
    const record = this.records.get(artifactToken);
    if (!record) return error('artifactNotFound');
    if (record.owner !== owner) return error('artifactForbidden');
    if (this.now() - record.createdAt > TTL_MS) {
      await this.dispose(artifactToken);
      return error('artifactExpired');
    }
    if (record.busy) return error('artifactBusy');
    record.busy = true;
    return record;
  }
  private async resolveSource(
    modelHash: string,
    rootId: string,
  ): Promise<string | null> {
    const listed = models.parse(await this.options.sidecar.listModels());
    const location = listed
      .find((model) => model.hash === modelHash && model.format === 'threeMf')
      ?.locations.find((item) => item.rootId === rootId && item.available);
    if (!location) return null;
    const info = await lstat(location.path);
    return info.isFile() && !info.isSymbolicLink()
      ? await realpath(location.path)
      : null;
  }
  private async refreshCatalog(destination: string): Promise<unknown> {
    try {
      const listed = models.parse(await this.options.sidecar.listModels());
      const root = listed
        .flatMap((model) => model.locations)
        .map((item) => ({
          ...item,
          rootPath: catalogRoot(item.path, item.rootRelative),
        }))
        .find((item) => isWithin(item.rootPath, destination));
      if (!root) return null;
      await this.options.sidecar.scanRoot(root.rootId, root.rootPath);
      return null;
    } catch {
      return electronFailure(
        'internalError',
        'The model was saved, but the catalog could not be refreshed.',
        'Refresh the catalog when convenient.',
      );
    }
  }
}

function error(
  code:
    | 'invalidRequest'
    | 'sidecarUnavailable'
    | 'profileNotFound'
    | 'artifactNotFound'
    | 'artifactExpired'
    | 'artifactForbidden'
    | 'artifactBusy'
    | 'sourceChanged'
    | 'saveSourceConflict'
    | 'saveDestinationExists'
    | 'saveFailed'
    | 'internalError',
): { status: 'error'; error: unknown } {
  return { status: 'error', error: electronFailure(code, code, 'Try again.') };
}
function electronFailure(
  code: string,
  message: string,
  action: string,
): unknown {
  return {
    domain: 'electron',
    code,
    message,
    action,
    part: null,
    setting: null,
  };
}
function nativeFailure(value: {
  code: string;
  message: string;
  action: string;
  part?: string | null | undefined;
  setting?: string | null | undefined;
}): unknown {
  return {
    status: 'error',
    error: {
      domain: 'native',
      ...value,
      part: value.part ?? null,
      setting: value.setting ?? null,
    },
  };
}
function sanitizeIssues(value: unknown[]): unknown[] {
  return value.map((item) => {
    const issue = item as globalThis.Record<string, unknown>;
    return {
      code: issue.code,
      severity: issue.severity,
      title: issue.title,
      message: issue.message,
      action: issue.action,
      part: issue.part ?? null,
      setting: issue.setting ?? null,
    };
  });
}
function sanitizeChanges(value: unknown): globalThis.Record<string, unknown[]> {
  const groups = value as globalThis.Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(groups ?? {}).map(([group, changes]) => [
      group,
      Array.isArray(changes)
        ? changes.map((item) => {
            const change = item as globalThis.Record<string, unknown>;
            return {
              code: change.code,
              message: change.message,
              setting: change.setting ?? null,
              before: change.before ?? null,
              after: change.after ?? null,
            };
          })
        : [],
    ]),
  );
}
function sanitizePreflight(value: unknown): unknown {
  const report = value as globalThis.Record<string, unknown>;
  return {
    accepted: report.accepted,
    source: nullableFields(
      report.source as globalThis.Record<string, unknown>,
      [
        'fileName',
        'byteSize',
        'sha256',
        'producer',
        'machineId',
        'processId',
        'layerHeight',
        'objectCount',
        'buildItemCount',
        'plateCount',
        'materials',
        'colors',
      ],
    ),
    recommendation: report.recommendation ?? null,
    blockers: sanitizeIssues((report.blockers as unknown[]) ?? []),
    warnings: sanitizeIssues((report.warnings as unknown[]) ?? []),
    proposedChanges: sanitizeChanges(report.proposedChanges),
  };
}
function sanitizeBuild(value: unknown): unknown {
  const report = value as globalThis.Record<string, unknown>;
  const validation = report.validation as globalThis.Record<string, unknown>;
  return {
    ...nullableFields(report, [
      'sourceSha256',
      'outputSha256',
      'outputFileName',
      'targetProfileId',
      'removedPartCount',
      'preservedPartCount',
      'warnings',
    ]),
    appliedChanges: sanitizeChanges(report.appliedChanges),
    warnings: sanitizeIssues((report.warnings as unknown[]) ?? []),
    validation: {
      ...nullableFields(validation, [
        'valid',
        'sourceSha256',
        'outputSha256',
        'sourcePreserved',
        'sceneCompatibility',
        'invariants',
      ]),
      warnings: sanitizeIssues((validation.warnings as unknown[]) ?? []),
      errors: sanitizeIssues((validation.errors as unknown[]) ?? []),
    },
  };
}
function nullableFields(
  object: globalThis.Record<string, unknown>,
  keys: string[],
): globalThis.Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));
}
function validValidation(value: unknown, sourceHash: string): boolean {
  const report = value as globalThis.Record<string, unknown>;
  return (
    report.valid === true &&
    report.sourceSha256 === sourceHash &&
    report.sourcePreserved === true &&
    typeof report.outputSha256 === 'string'
  );
}
function readString(value: unknown, key: string): string | null {
  const field = (value as globalThis.Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}
async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`unsafe retarget workspace directory: ${directory}`);
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}
async function readOwnerMarker(
  directory: string,
): Promise<z.infer<typeof ownerMarker> | null> {
  try {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink())
      return null;
    const markerPath = path.join(directory, OWNER_MARKER);
    const markerMetadata = await lstat(markerPath);
    if (
      !markerMetadata.isFile() ||
      markerMetadata.isSymbolicLink() ||
      markerMetadata.size > 1024
    )
      return null;
    const parsed = ownerMarker.parse(
      JSON.parse(await readFile(markerPath, 'utf8')),
    );
    return parsed.instanceId === path.basename(directory) ? parsed : null;
  } catch {
    return null;
  }
}
async function removeOwnedInstance(
  directory: string,
  expectedInstanceId: string,
): Promise<void> {
  const marker = await readOwnerMarker(directory);
  if (!marker || marker.instanceId !== expectedInstanceId) return;
  await rm(directory, { recursive: true, force: true });
}
// The list is written on the fatal side because that is the side that is safe
// to get wrong. #330 established that the codes Windows can raise for a
// contended delete are an open set, so an allowlist of *tolerated* codes aborts
// startup on the first code nobody thought of — the #229 crash, reintroduced.
// #349 then established that a genuinely broken temp root must not be swallowed
// silently, which is a real requirement and the reason the allowlist was added.
//
// Naming the fatal codes satisfies both. The discriminator is not "did anyone
// predict this code" but "is this a property of the filesystem or of this one
// directory right now": EIO, ENOSPC and EROFS mean the temp root cannot be
// served at all, and no later sweep will do better. Everything else — including
// EACCES, ENOTDIR, EMFILE and libuv's UNKNOWN, which is by construction the code
// nobody thought of — costs one leftover directory that a later sweep collects,
// which is strictly cheaper than a process that will not start.
// Exported for tests/retargetSweepRealContention.test.ts, which compares this
// decision for an error Windows actually raised against the decision for the
// hand-authored fixture string the rest of the suite is built on (#514). That
// comparison is the point of the test, and it cannot be made through
// initialize() alone: only one of the two errors can be produced by a real
// filesystem, so there is no path that feeds both to the classifier.
export function isBrokenTempRootError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EIO', 'ENOSPC', 'EROFS'].includes(String(error.code))
  );
}
function isProcessRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      String(error.code) === 'EPERM'
    );
  }
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32'
      ? resolved.toLocaleLowerCase('en-US')
      : resolved;
  };
  return normalize(left) === normalize(right);
}
function isWithin(parent: string, child: string): boolean {
  const value = path.relative(parent, child);
  return value !== '' && !value.startsWith('..') && !path.isAbsolute(value);
}
function catalogRoot(filePath: string, rootRelative: string): string {
  const segments = rootRelative.split(/[\\/]+/).filter(Boolean);
  return path.resolve(
    path.dirname(filePath),
    ...segments.slice(0, -1).map(() => '..'),
  );
}
async function copyExclusive(
  source: string,
  destination: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await pipeline(
      createReadStream(source),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }),
    );
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isUnsupportedLinkError(error)) throw error;
      await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function isUnsupportedLinkError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
    String(error.code),
  );
}
