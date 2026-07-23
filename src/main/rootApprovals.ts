import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const STORE_VERSION = 1;
const MAX_ROOTS = 256;
const MAX_STORE_BYTES = 512 * 1024;

const ApprovalStore = z
  .object({
    version: z.literal(STORE_VERSION),
    roots: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            canonicalPath: z.string().min(1).max(4096),
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
}

const nodeFileSystem: RootApprovalFileSystem = {
  readFile: (filePath) => fs.readFile(filePath),
  writeFile: (filePath, data) => fs.writeFile(filePath, data, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
  mkdir: (directory) =>
    fs.mkdir(directory, { recursive: true }).then(() => undefined),
  unlink: (filePath) => fs.unlink(filePath),
  realpath: (filePath) => fs.realpath(filePath),
};

export class RootApprovalError extends Error {
  constructor(
    readonly code:
      'APPROVAL_REQUIRED' | 'CORRUPT_APPROVAL_STORE' | 'INVALID_ROOT',
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
}

export class RootApprovalStore {
  private readonly fileSystem: RootApprovalFileSystem;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly storePath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RootApprovalStoreOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.storePath = path.join(options.userDataPath, 'approved-roots.v1.json');
  }

  async approveFromPicker(selectedPath: string): Promise<{
    id: string;
    canonicalPath: string;
  }> {
    return this.withLock(async () => {
      let canonicalPath: string;
      try {
        canonicalPath = await this.fileSystem.realpath(selectedPath);
      } catch {
        throw new RootApprovalError(
          'INVALID_ROOT',
          'The selected folder is no longer available.',
        );
      }
      const store = await this.readStore();
      const existing = store.roots.find((root) =>
        samePath(root.canonicalPath, canonicalPath),
      );
      if (existing) {
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
    try {
      current = await this.fileSystem.realpath(approval.canonicalPath);
    } catch {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The approved catalog folder is no longer available. Reauthorize it.',
      );
    }
    if (!samePath(current, approval.canonicalPath)) {
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
    let canonicalFile: string;
    try {
      canonicalFile = await this.fileSystem.realpath(filePath);
    } catch {
      throw new RootApprovalError(
        'APPROVAL_REQUIRED',
        'The catalog source is unavailable or no longer approved.',
      );
    }

    const store = await this.readStore();
    for (const root of store.roots) {
      let currentRoot: string;
      try {
        currentRoot = await this.fileSystem.realpath(root.canonicalPath);
      } catch {
        continue;
      }
      if (
        samePath(currentRoot, root.canonicalPath) &&
        isWithinRoot(currentRoot, canonicalFile)
      ) {
        return { sourcePath: filePath, canonicalPath: canonicalFile };
      }
    }
    throw new RootApprovalError(
      'APPROVAL_REQUIRED',
      'This catalog location must be reauthorized with the native folder picker before it can be uploaded.',
    );
  }

  async canonicalizePickerFile(filePath: string): Promise<string> {
    try {
      return await this.fileSystem.realpath(filePath);
    } catch {
      throw new RootApprovalError(
        'INVALID_ROOT',
        'The selected model file is no longer available.',
      );
    }
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
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
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
