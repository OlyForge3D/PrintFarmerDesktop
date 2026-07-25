import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RetargetProfile } from '@shared/ipc';
import type { RetargetTargetReference, SidecarClient } from './sidecar.js';

const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 200;
const MAX_WARNINGS = 100;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const importedId = (sha256: string): string => `imported:${sha256}`;
const boundedRecord = <T extends z.ZodTypeAny>(value: T, maximum: number) =>
  z.record(value).superRefine((record, context) => {
    if (Object.keys(record).length > maximum)
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum,
        type: 'array',
        inclusive: true,
        message: 'Too many entries.',
      });
  });

const nativeError = z
  .object({
    code: z.string().max(128),
    message: z.string().max(2048),
    action: z.string().max(2048),
    part: z.string().max(2048).nullable().optional(),
    setting: z.string().max(2048).nullable().optional(),
  })
  .strict();
const nativeOutcome = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), value }).strict(),
    z
      .object({
        status: z.literal('blocked'),
        blockers: z.array(z.unknown()).max(100),
        warnings: z.array(z.unknown()).max(100),
        value: value.nullable().optional(),
      })
      .strict(),
    z.object({ status: z.literal('error'), error: nativeError }).strict(),
  ]);
const importedDetails = z
  .object({
    profileId: z.string().regex(/^imported:[a-f0-9]{64}$/),
    sha256: z.string().regex(SHA),
    machineName: z.string().min(1).max(512),
    processName: z.string().min(1).max(512),
    filamentNames: z.array(z.string().min(1).max(512)).max(100),
    layerHeight: z.number().finite().positive(),
    settingCount: z.number().int().nonnegative().max(10_000),
    capabilities: z
      .object({
        nozzleCount: z.number().int().positive().max(16),
        maxFilamentSlots: z.number().int().positive().max(100),
        objectExclusion: z.boolean(),
        motionGuardrails: z.boolean(),
      })
      .strict(),
  })
  .strict();
const bundledSummary = z
  .object({
    profileId: z.string().min(1).max(512),
    displayName: z.string().min(1).max(512),
    rootPath: z.string().max(4096),
    layerHeight: z.number().finite().positive(),
    category: z.string().max(128),
    bundleCommit: z.string().max(128),
  })
  .strict();
const bundledDetails = z
  .object({
    profileId: z.string().min(1).max(512),
    displayName: z.string().min(1).max(512),
    rootPath: z.string().max(4096),
    layerHeight: z.number().finite().positive(),
    category: z.string().max(128),
    bundleCommit: z.string().max(128),
    settingCount: z.number().int().nonnegative().max(10_000),
    settingsSummary: boundedRecord(
      z.union([
        z.string().max(1024),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(1024)).max(100),
      ]),
      10_000,
    ),
    machine: z.object({ name: z.string().min(1).max(512) }).passthrough(),
    compatibleFilaments: z
      .array(z.object({ name: z.string().min(1).max(512) }).passthrough())
      .max(100),
    profileHashes: boundedRecord(z.string().regex(SHA), 100),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z
      .array(
        z
          .object({
            id: z.string().regex(/^imported:[a-f0-9]{64}$/),
            sha256: z.string().regex(SHA),
            importedAt: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(MAX_CATALOG_ENTRIES),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
type NativeError = z.infer<typeof nativeError>;

export class TargetProfileNativeError extends Error {
  readonly failure;

  constructor(error: NativeError) {
    super(error.message);
    this.name = 'TargetProfileNativeError';
    this.failure = {
      domain: 'native' as const,
      code: error.code,
      message: error.message,
      action: error.action,
      part: error.part ?? null,
      setting: error.setting ?? null,
    };
  }
}

export interface TargetProfileServiceOptions {
  userDataPath: string;
  sidecar: Pick<
    SidecarClient,
    | 'listRetargetProfiles'
    | 'inspectRetargetProfile'
    | 'inspectImportedRetargetProfile'
  >;
  now?: () => number;
  maxProfileBytes?: number;
}

export interface PublicCatalog {
  profiles: RetargetProfile[];
  warnings: Array<{
    domain: 'electron';
    code: 'profileStoreCorrupt';
    message: string;
    action: string;
    part: null;
    setting: null;
  }>;
}

/** Owns profile storage and makes the renderer-facing catalog deliberately path-free. */
export class TargetProfileService {
  private readonly root: string;
  private readonly objects: string;
  private readonly manifestPath: string;
  private readonly now: () => number;
  private readonly maxProfileBytes: number;
  private bundled = new Map<string, RetargetProfile>();
  private imported = new Map<
    string,
    { profile: RetargetProfile; path: string; sha256: string }
  >();
  private warnings: PublicCatalog['warnings'] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TargetProfileServiceOptions) {
    this.root = path.join(options.userDataPath, 'retarget', 'profiles', 'v1');
    this.objects = path.join(this.root, 'objects', 'sha256');
    this.manifestPath = path.join(this.root, 'manifest.json');
    this.now = options.now ?? Date.now;
    this.maxProfileBytes = options.maxProfileBytes ?? MAX_PROFILE_BYTES;
  }

  async initialize(): Promise<void> {
    await mkdir(this.objects, { recursive: true });
    await this.removeTemps(this.root);
    await this.refresh();
  }

  async refresh(): Promise<PublicCatalog> {
    return this.withMutation(() => this.refreshLocked());
  }

  private async refreshLocked(): Promise<PublicCatalog> {
    this.warnings = [];
    await this.loadBundled();
    try {
      await this.loadImported();
    } catch {
      this.imported.clear();
      this.warnings.push(
        storeWarning(
          'The imported-profile manifest is corrupt; imported targets were excluded.',
          'Restore or remove the imported-profile manifest, then import the references again.',
        ),
      );
    }
    return this.catalog();
  }

  catalog(): PublicCatalog {
    const profiles = [...this.imported.values()]
      .map(({ profile }) => profile)
      .sort(compareProfiles)
      .concat([...this.bundled.values()].sort(compareProfiles));
    return { profiles, warnings: this.warnings.slice(0, MAX_WARNINGS) };
  }

  async importFile(
    sourcePath: string,
  ): Promise<{ profile: RetargetProfile; duplicate: boolean }> {
    return this.withMutation(() => this.importFileLocked(sourcePath));
  }

  private async importFileLocked(
    sourcePath: string,
  ): Promise<{ profile: RetargetProfile; duplicate: boolean }> {
    await mkdir(this.objects, { recursive: true });
    if (path.extname(sourcePath).toLowerCase() !== '.3mf') {
      throw new Error('profileImportFailed');
    }
    const staging = path.join(this.root, `.import-${randomUUID()}.tmp`);
    try {
      await copyBoundedRegularFile(sourcePath, staging, this.maxProfileBytes);
      const sha256 = await hashRegularFile(staging);
      const inspected = nativeOutcome(importedDetails).parse(
        await this.options.sidecar.inspectImportedRetargetProfile(staging),
      );
      if (
        inspected.status !== 'ok' ||
        inspected.value.sha256 !== sha256 ||
        inspected.value.profileId !== importedId(sha256)
      ) {
        throw new Error('profileImportFailed');
      }
      const manifest = await this.readManifest(true);
      const existingIndex = manifest.entries.findIndex(
        (entry) => entry.sha256 === sha256,
      );
      const existing =
        existingIndex === -1 ? undefined : manifest.entries[existingIndex];
      const importedCapacity = Math.max(
        0,
        MAX_CATALOG_ENTRIES - this.bundled.size,
      );
      if (
        existingIndex >= importedCapacity ||
        (!existing && manifest.entries.length >= importedCapacity)
      ) {
        throw new Error('profileCatalogFull');
      }
      const finalPath = this.objectPath(sha256);
      await mkdir(path.dirname(finalPath), { recursive: true });
      try {
        await rename(staging, finalPath);
      } catch (error: unknown) {
        if (!(await exists(finalPath))) throw error;
        if ((await hashRegularFile(finalPath)) !== sha256)
          throw new Error('profileStoreCorrupt');
        await rm(staging, { force: true });
      }
      if (existing) {
        await this.loadImported();
        return {
          profile: this.imported.get(existing.id)!.profile,
          duplicate: true,
        };
      }
      const entry = { id: importedId(sha256), sha256, importedAt: this.now() };
      await this.writeManifest({
        schemaVersion: 1,
        entries: [...manifest.entries, entry],
      });
      await this.loadImported();
      return {
        profile: this.imported.get(entry.id)!.profile,
        duplicate: false,
      };
    } finally {
      await rm(staging, { force: true });
    }
  }

  getPrivateReference(id: string): RetargetTargetReference | null {
    if (this.bundled.has(id)) return { kind: 'bundled', targetProfileId: id };
    const entry = this.imported.get(id);
    return entry
      ? { kind: 'imported', path: entry.path, expectedSha256: entry.sha256 }
      : null;
  }

  getFingerprint(id: string): string | null {
    return (
      this.imported.get(id)?.profile.fingerprint ??
      this.bundled.get(id)?.fingerprint ??
      null
    );
  }

  private async loadBundled(): Promise<void> {
    const listed = nativeOutcome(
      z.array(bundledSummary).max(MAX_CATALOG_ENTRIES),
    ).parse(await this.options.sidecar.listRetargetProfiles());
    if (listed.status === 'error')
      throw new TargetProfileNativeError(listed.error);
    if (listed.status !== 'ok') throw new Error('sidecarUnavailable');
    const next = new Map<string, RetargetProfile>();
    for (const summary of listed.value) {
      const inspected = nativeOutcome(bundledDetails).parse(
        await this.options.sidecar.inspectRetargetProfile(summary.profileId),
      );
      if (inspected.status === 'error')
        throw new TargetProfileNativeError(inspected.error);
      if (inspected.status !== 'ok') throw new Error('sidecarUnavailable');
      const value = inspected.value;
      next.set(value.profileId, {
        id: value.profileId,
        source: 'bundled',
        displayName: value.displayName,
        processName: value.displayName,
        machineName: value.machine.name,
        compatibleFilaments: value.compatibleFilaments.map((item) => item.name),
        layerHeight: value.layerHeight,
        category: value.category,
        bundleCommit: value.bundleCommit,
        settingCount: value.settingCount,
        settingsSummary: value.settingsSummary,
        importedAt: null,
        fingerprint: hashText(JSON.stringify(value.profileHashes)),
      });
    }
    this.bundled = next;
  }

  private async loadImported(): Promise<void> {
    this.imported.clear();
    const manifest = await this.readManifest(true);
    const referenced = new Set(manifest.entries.map((entry) => entry.sha256));
    const importedCapacity = Math.max(
      0,
      MAX_CATALOG_ENTRIES - this.bundled.size,
    );
    const activeEntries = manifest.entries.slice(0, importedCapacity);
    if (activeEntries.length !== manifest.entries.length) {
      this.warnings.push(
        storeWarning(
          'Imported targets beyond the catalog capacity were excluded.',
          'Remove unused imported targets before adding another reference.',
        ),
      );
    }
    for (const entry of activeEntries) {
      const objectPath = this.objectPath(entry.sha256);
      try {
        if (
          !isInTree(this.objects, objectPath) ||
          (await hashRegularFile(objectPath)) !== entry.sha256
        )
          throw new Error('invalid object');
        const inspected = nativeOutcome(importedDetails).parse(
          await this.options.sidecar.inspectImportedRetargetProfile(objectPath),
        );
        if (
          inspected.status !== 'ok' ||
          inspected.value.sha256 !== entry.sha256 ||
          inspected.value.profileId !== entry.id
        )
          throw new Error('invalid native inspection');
        this.imported.set(entry.id, {
          path: objectPath,
          sha256: entry.sha256,
          profile: importedProfile(inspected.value, entry.importedAt),
        });
      } catch {
        this.warnings.push(corruptWarning(entry.id));
      }
    }
    await this.recoverOrphans(referenced, manifest);
  }

  private async recoverOrphans(
    referenced: Set<string>,
    manifest: Manifest,
  ): Promise<void> {
    const recovered = [...manifest.entries];
    const importedCapacity = Math.max(
      0,
      MAX_CATALOG_ENTRIES - this.bundled.size,
    );
    for (const file of await walkFiles(this.objects)) {
      const name = path.basename(file, '.3mf');
      if (!SHA.test(name) || referenced.has(name)) continue;
      if (recovered.length >= importedCapacity) {
        await rm(file, { force: true });
        this.warnings.push(
          storeWarning(
            `Discarded unreferenced profile ${importedId(name)} because the target catalog is full.`,
            'Remove an imported target before importing this reference again.',
          ),
        );
        continue;
      }
      try {
        if ((await hashRegularFile(file)) !== name)
          throw new Error('bad orphan');
        const inspected = nativeOutcome(importedDetails).parse(
          await this.options.sidecar.inspectImportedRetargetProfile(file),
        );
        if (
          inspected.status !== 'ok' ||
          inspected.value.sha256 !== name ||
          inspected.value.profileId !== importedId(name)
        )
          throw new Error('bad orphan');
        recovered.push({
          id: importedId(name),
          sha256: name,
          importedAt: this.now(),
        });
        this.warnings.push(
          storeWarning(
            `Recovered imported profile ${importedId(name)} after an interrupted write.`,
            'Review the recovered target before using it.',
          ),
        );
      } catch {
        await rm(file, { force: true });
        this.warnings.push(
          storeWarning(
            `Discarded invalid unreferenced recovery object ${name}.`,
            'Re-import the original U1 reference if it is still needed.',
          ),
        );
      }
    }
    if (recovered.length !== manifest.entries.length) {
      await this.writeManifest({ schemaVersion: 1, entries: recovered });
      // The recovery is deterministic and only considers unreferenced objects.
      await this.loadImported();
    }
  }

  private async readManifest(recoverEmpty: boolean): Promise<Manifest> {
    try {
      const info = await lstat(this.manifestPath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > MAX_MANIFEST_BYTES
      ) {
        throw new Error('profileStoreCorrupt');
      }
      return manifestSchema.parse(
        JSON.parse(await readFile(this.manifestPath, 'utf8')),
      );
    } catch {
      if (!(await exists(this.manifestPath)) && recoverEmpty)
        return { schemaVersion: 1, entries: [] };
      throw new Error('profileStoreCorrupt');
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    const validated = manifestSchema.parse(manifest);
    const temporary = path.join(this.root, `.manifest-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, this.manifestPath);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private objectPath(sha256: string): string {
    return path.join(this.objects, sha256.slice(0, 2), `${sha256}.3mf`);
  }

  private async removeTemps(root: string): Promise<void> {
    for (const file of await walkFiles(root)) {
      if (path.basename(file).startsWith('.')) await rm(file, { force: true });
    }
  }
}

function importedProfile(
  value: z.infer<typeof importedDetails>,
  importedAt: number,
): RetargetProfile {
  return {
    id: value.profileId,
    source: 'imported',
    displayName: value.processName,
    processName: value.processName,
    machineName: value.machineName,
    compatibleFilaments: value.filamentNames,
    layerHeight: value.layerHeight,
    category: null,
    bundleCommit: null,
    settingCount: value.settingCount,
    settingsSummary: {},
    importedAt,
    fingerprint: value.sha256,
  };
}
function corruptWarning(id: string): PublicCatalog['warnings'][number] {
  return storeWarning(
    `Imported profile ${id} is corrupt and was excluded.`,
    'Re-import the referenced profile.',
  );
}
function storeWarning(
  message: string,
  action: string,
): PublicCatalog['warnings'][number] {
  return {
    domain: 'electron',
    code: 'profileStoreCorrupt',
    message,
    action,
    part: null,
    setting: null,
  };
}
function compareProfiles(a: RetargetProfile, b: RetargetProfile): number {
  return a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
}
function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function copyBoundedRegularFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
): Promise<void> {
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error('profileImportFailed');
    }
    const destination = await open(destinationPath, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > maximumBytes) throw new Error('profileImportFailed');
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            buffer,
            written,
            bytesRead - written,
            null,
          );
          written += result.bytesWritten;
        }
      }
      await destination.sync();
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}
async function hashRegularFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROFILE_BYTES)
    throw new Error('invalid file');
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
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
function isInTree(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}
async function walkFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const child = path.join(root, entry.name);
          if (entry.isDirectory()) return walkFiles(child);
          return entry.isFile() ? [child] : [];
        }),
      )
    ).flat();
  } catch {
    return [];
  }
}
