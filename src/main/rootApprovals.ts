import path from 'node:path';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  requireStandaloneModelPath,
  zipMemberPath,
  zipMemberSource,
} from '../shared/modelSource.js';

const STORE_VERSION = 1;
const MAX_ROOTS = 256;
const MAX_STORE_BYTES = 512 * 1024;
const AUTHORIZE_FILES_CONCURRENCY = 32;

const ApprovalStore = z
  .object({
    version: z.literal(STORE_VERSION),
    roots: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            canonicalPath: z.string().min(1).max(4096),
            deviceId: z.string().regex(/^\d+$/).nullable().default(null),
            fileId: z.string().regex(/^\d+$/).nullable().default(null),
            approvedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(MAX_ROOTS),
  })
  .strict();

type ApprovalStore = z.infer<typeof ApprovalStore>;

export interface RootApprovalFileSystem {
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  realpath(filePath: string): Promise<string>;
  lstat?(filePath: string): Promise<BigIntStats>;
  open?(filePath: string, flags: number): Promise<FileHandle>;
}

const nodeFileSystem: RootApprovalFileSystem = {
  readFile: (filePath) => fs.readFile(filePath),
  writeFile: (filePath, data) => fs.writeFile(filePath, data, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
  mkdir: (directory) =>
    fs.mkdir(directory, { recursive: true }).then(() => undefined),
  unlink: (filePath) => fs.unlink(filePath),
  realpath: (filePath) => fs.realpath(filePath),
  lstat: (filePath) => fs.lstat(filePath, { bigint: true }),
  open: (filePath, flags) => fs.open(filePath, flags),
};

export interface ApprovedFile {
  handle: FileHandle;
  canonicalPath: string;
  size: number;
}

export class RootApprovalError extends Error {
  constructor(
    readonly code:
      | 'APPROVAL_REQUIRED'
      | 'APPROVAL_CHECK_FAILED'
      | 'CORRUPT_APPROVAL_STORE'
      | 'INVALID_ROOT',
    message: string,
  ) {
    super(message);
    this.name = 'RootApprovalError';
  }
}

export interface RootApprovalStoreOptions {
  userDataPath: string;
  fileSystem?: RootApprovalFileSystem;
  createId?: () => string;
  now?: () => number;
  beforeApprovedOpen?: () => Promise<void>;
  afterApprovedOpen?: () => Promise<void>;
}

export class RootApprovalStore {
  private readonly fileSystem: RootApprovalFileSystem;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly storePath: string;
  private readonly beforeApprovedOpen: (() => Promise<void>) | undefined;
  private readonly afterApprovedOpen: (() => Promise<void>) | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RootApprovalStoreOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.storePath = path.join(options.userDataPath, 'approved-roots.v1.json');
    this.beforeApprovedOpen = options.beforeApprovedOpen;
    this.afterApprovedOpen = options.afterApprovedOpen;
  }

  async approveFromPicker(selectedPath: string): Promise<{
    id: string;
    canonicalPath: string;
  }> {
    return this.withLock(async () => {
      let canonicalPath: string;
      let identity: BigIntStats;
      try {
        canonicalPath = await this.fileSystem.realpath(selectedPath);
        identity = await this.lstatBigInt(canonicalPath);
      } catch {
        throw new RootApprovalError(
          'INVALID_ROOT',
          'The selected folder is no longer available.',
        );
      }
      if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new RootApprovalError(
          'INVALID_ROOT',
          'The selected folder is a symbolic link or reparse point.',
        );
      }
      const store = await this.readStore();
      const existing = store.roots.find((root) =>
        samePath(root.canonicalPath, canonicalPath),
      );
      if (existing) {
        if (
          existing.deviceId !== identity.dev.toString() ||
          existing.fileId !== identity.ino.toString()
        ) {
          existing.deviceId = identity.dev.toString();
          existing.fileId = identity.ino.toString();
          existing.approvedAt = new Date(this.now()).toISOString();
          await this.writeStore(store);
        }
        return { id: existing.id, canonicalPath: existing.canonicalPath };
      }
      if (store.roots.length >= MAX_ROOTS) {
        throw new RootApprovalError(
          'INVALID_ROOT',
          'Too many approved folders are saved. Remove an old approval first.',
        );
      }
      const approval = {
        id: this.createId(),
        canonicalPath,
        deviceId: identity.dev.toString(),
        fileId: identity.ino.toString(),
        approvedAt: new Date(this.now()).toISOString(),
      };
      store.roots.push(approval);
      await this.writeStore(store);
      return { id: approval.id, canonicalPath };
    });
  }

  async resolve(approvalId: string): Promise<string> {
    const store = await this.readStore();
    const approval = store.roots.find((root) => root.id === approvalId);
    if (!approval) {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'This catalog folder must be reauthorized with the native folder picker.',
      );
    }
    let current: string;
    let identity: BigIntStats;
    try {
      current = await this.fileSystem.realpath(approval.canonicalPath);
      identity = await this.lstatBigInt(current);
    } catch {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The approved catalog folder is no longer available. Reauthorize it.',
      );
    }
    if (
      !samePath(current, approval.canonicalPath) ||
      !matchesStoredIdentity(approval, identity)
    ) {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The approved catalog folder changed identity. Reauthorize it.',
      );
    }
    return current;
  }

  async authorizeFile(filePath: string): Promise<{
    sourcePath: string;
    canonicalPath: string;
  }> {
    const canonicalFile = await this.canonicalCatalogFile(filePath);
    if (canonicalFile === null) {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The catalog source is unavailable or no longer approved.',
      );
    }

    const store = await this.readStore();
    let checkFailure: RootApprovalError | undefined;
    for (const root of store.roots) {
      try {
        const approved = await this.currentApprovedRoot(root);
        if (approved && isWithinRoot(approved.canonicalPath, canonicalFile)) {
          return { sourcePath: filePath, canonicalPath: canonicalFile };
        }
      } catch (error) {
        if (
          !(error instanceof RootApprovalError) ||
          error.code !== 'APPROVAL_CHECK_FAILED'
        ) {
          throw error;
        }
        checkFailure ??= error;
      }
    }
    if (checkFailure) throw checkFailure;
    throw new RootApprovalError(
      'APPROVAL_REQUIRED',
      'This catalog location must be reauthorized with the native folder picker before it can be uploaded.',
    );
  }

  /**
   * Batch form of {@link authorizeFile} for catalog listings. Bounded
   * concurrency avoids exhausting file handles, and the approval snapshot is
   * rechecked before returning. A `null` entry means the file is unavailable
   * or outside every currently approved root.
   */
  async authorizeFiles(
    filePaths: readonly string[],
  ): Promise<Array<{ sourcePath: string; canonicalPath: string } | null>> {
    if (filePaths.length === 0) return [];
    return this.withLock(async () => {
      const results: Array<{
        sourcePath: string;
        canonicalPath: string;
      } | null> = Array.from({ length: filePaths.length }, () => null);
      const approvedRoots = await this.currentApprovedRoots();
      if (approvedRoots.length === 0) return results;
      let next = 0;
      let failure: Error | undefined;
      const worker = async (): Promise<void> => {
        while (next < filePaths.length && !failure) {
          const index = next;
          next += 1;
          const filePath = filePaths[index]!;
          try {
            const canonicalFile = await this.canonicalCatalogFile(filePath);
            if (
              canonicalFile !== null &&
              approvedRoots.some((root) =>
                isWithinRoot(root.canonicalPath, canonicalFile),
              )
            ) {
              results[index] = {
                sourcePath: filePath,
                canonicalPath: canonicalFile,
              };
            }
          } catch (error) {
            failure ??=
              error instanceof Error
                ? error
                : new Error('Library file checks failed.', { cause: error });
          }
        }
      };
      const workers = Math.min(AUTHORIZE_FILES_CONCURRENCY, filePaths.length);
      await Promise.all(Array.from({ length: workers }, worker));
      if (failure) throw failure;

      const verifiedRoots = await this.currentApprovedRoots();
      if (
        approvedRoots.length !== verifiedRoots.length ||
        approvedRoots.some(
          (root, index) => !sameApprovedRoot(root, verifiedRoots[index]!),
        )
      ) {
        throw new RootApprovalError(
          'APPROVAL_REQUIRED',
          'Approved folders changed while checking the library. Reauthorize the affected folder or retry.',
        );
      }
      return results;
    });
  }

  private async canonicalCatalogFile(filePath: string): Promise<string | null> {
    try {
      const member = zipMemberSource(filePath);
      if (member) {
        const canonicalArchive = await this.fileSystem.realpath(
          member.archivePath,
        );
        return zipMemberPath(member, canonicalArchive);
      }
      return await this.fileSystem.realpath(filePath);
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw new RootApprovalError(
        'APPROVAL_CHECK_FAILED',
        'Library files could not be checked. Verify drive access and file permissions, then retry.',
      );
    }
  }

  private async currentApprovedRoot(
    root: ApprovalStore['roots'][number],
  ): Promise<CurrentApprovedRoot | null> {
    try {
      const currentPath = await this.fileSystem.realpath(root.canonicalPath);
      const identity = await this.lstatBigInt(currentPath);
      if (
        matchesStoredIdentity(root, identity) &&
        samePath(currentPath, root.canonicalPath)
      ) {
        return {
          canonicalPath: currentPath,
          deviceId: identity.dev.toString(),
          fileId: identity.ino.toString(),
        };
      }
      return null;
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw new RootApprovalError(
        'APPROVAL_CHECK_FAILED',
        'An approved folder could not be checked. Verify drive access and folder permissions, then retry.',
      );
    }
  }

  private async currentApprovedRoots(): Promise<CurrentApprovedRoot[]> {
    const store = await this.readStore();
    const approved: CurrentApprovedRoot[] = [];
    for (const root of store.roots) {
      const current = await this.currentApprovedRoot(root);
      if (current) approved.push(current);
    }
    return approved;
  }

  async openApprovedFile(filePath: string): Promise<ApprovedFile> {
    requireStandaloneModelPath(filePath);
    const lstat = (candidate: string): Promise<BigIntStats> =>
      this.lstatBigInt(candidate);
    const open = (candidate: string, flags: number): Promise<FileHandle> =>
      this.fileSystem.open
        ? this.fileSystem.open(candidate, flags)
        : fs.open(candidate, flags);
    let beforePath: string;
    let before: BigIntStats;
    try {
      [beforePath, before] = await Promise.all([
        this.fileSystem.realpath(filePath),
        lstat(filePath),
      ]);
    } catch {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The catalog source is unavailable or no longer approved.',
      );
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'Symbolic-link or reparse-point model sources cannot be uploaded.',
      );
    }
    const store = await this.readStore();
    let approved = false;
    for (const root of store.roots) {
      try {
        const currentRoot = await this.fileSystem.realpath(root.canonicalPath);
        const rootIdentity = await lstat(currentRoot);
        if (
          samePath(currentRoot, root.canonicalPath) &&
          matchesStoredIdentity(root, rootIdentity) &&
          isWithinRoot(currentRoot, beforePath)
        ) {
          approved = true;
          break;
        }
      } catch {
        // An unavailable root cannot authorize a source.
      }
    }
    if (!approved) {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'This catalog location must be reauthorized before it can be uploaded.',
      );
    }
    await this.beforeApprovedOpen?.();
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle: FileHandle | null = null;
    try {
      handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
      await this.afterApprovedOpen?.();
      const [afterPath, after, opened] = await Promise.all([
        this.fileSystem.realpath(filePath),
        lstat(filePath),
        handle.stat({ bigint: true }),
      ]);
      if (
        !samePath(beforePath, afterPath) ||
        after.isSymbolicLink() ||
        !after.isFile() ||
        !opened.isFile() ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, opened)
      ) {
        throw new RootApprovalError(
          'APPROVAL_REQUIRED',
          'The catalog source changed while its approved handle was opened.',
        );
      }
      if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RootApprovalError(
          'APPROVAL_REQUIRED',
          'The approved catalog source size is unsupported.',
        );
      }
      return {
        handle,
        canonicalPath: afterPath,
        size: Number(opened.size),
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof RootApprovalError) throw error;
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The approved catalog source could not be opened securely.',
      );
    }
  }

  async canonicalizePickerFile(filePath: string): Promise<string> {
    try {
      const member = zipMemberSource(filePath);
      if (member) {
        return zipMemberPath(
          member,
          await this.fileSystem.realpath(member.archivePath),
        );
      }
      return await this.fileSystem.realpath(filePath);
    } catch {
      throw new RootApprovalError(
        'INVALID_ROOT',
        'The selected model file is no longer available.',
      );
    }
  }

  private lstatBigInt(filePath: string): Promise<BigIntStats> {
    return this.fileSystem.lstat
      ? this.fileSystem.lstat(filePath)
      : fs.lstat(filePath, { bigint: true });
  }

  async reset(): Promise<void> {
    await this.withLock(async () => {
      try {
        await this.fileSystem.unlink(this.storePath);
      } catch (error) {
        if (!isMissing(error)) {
          throw new RootApprovalError(
            'CORRUPT_APPROVAL_STORE',
            'Approved folders could not be reset.',
          );
        }
      }
    });
  }

  private async readStore(): Promise<ApprovalStore> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fileSystem.readFile(this.storePath);
    } catch (error) {
      if (isMissing(error)) return { version: STORE_VERSION, roots: [] };
      throw new RootApprovalError(
        'CORRUPT_APPROVAL_STORE',
        'Approved folders could not be read. Reset approvals to recover.',
      );
    }
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new RootApprovalError(
        'CORRUPT_APPROVAL_STORE',
        'Approved folder data exceeds its safety limit. Reset approvals to recover.',
      );
    }
    const parsed = ApprovalStore.safeParse(
      parseJson(Buffer.from(bytes).toString('utf8')),
    );
    if (!parsed.success) {
      throw new RootApprovalError(
        'CORRUPT_APPROVAL_STORE',
        'Approved folder data is corrupt. Reset approvals to recover.',
      );
    }
    return parsed.data;
  }

  private async writeStore(store: ApprovalStore): Promise<void> {
    const payload = JSON.stringify(ApprovalStore.parse(store));
    const temporaryPath = `${this.storePath}.tmp`;
    try {
      await this.fileSystem.mkdir(path.dirname(this.storePath));
      await this.fileSystem.writeFile(temporaryPath, payload);
      await this.fileSystem.rename(temporaryPath, this.storePath);
    } catch {
      try {
        await this.fileSystem.unlink(temporaryPath);
      } catch {
        // The existing approval store remains authoritative.
      }
      throw new RootApprovalError(
        'CORRUPT_APPROVAL_STORE',
        'The folder approval could not be saved.',
      );
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedCandidate = path.normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(
      normalizedRoot.endsWith(path.sep)
        ? normalizedRoot
        : `${normalizedRoot}${path.sep}`,
    )
  );
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

interface CurrentApprovedRoot {
  canonicalPath: string;
  deviceId: string;
  fileId: string;
}

function sameApprovedRoot(
  left: CurrentApprovedRoot,
  right: CurrentApprovedRoot,
): boolean {
  return (
    samePath(left.canonicalPath, right.canonicalPath) &&
    left.deviceId === right.deviceId &&
    left.fileId === right.fileId
  );
}

export function sameFileIdentity(
  left: Pick<BigIntStats, 'dev' | 'ino'>,
  right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matchesStoredIdentity(
  root: { deviceId: string | null; fileId: string | null },
  current: BigIntStats,
): boolean {
  return (
    root.deviceId !== null &&
    root.fileId !== null &&
    root.deviceId === current.dev.toString() &&
    root.fileId === current.ino.toString()
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
