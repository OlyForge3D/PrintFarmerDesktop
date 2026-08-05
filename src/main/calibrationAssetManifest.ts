/**
 * CalibrationAssetManifestService
 *
 * Manages the external calibration asset manifest: reads the static manifest
 * shipped with the app, validates user-supplied asset files, and provides an
 * OS file-picker with allowlisted extensions.
 *
 * The manifest is a curated list of approved external calibration files
 * (e.g., 3MF models, STL files) that can be used with specific calibration
 * methods. Each entry is reviewed before being added — methods whose entry is
 * not yet reviewed remain disabled with a concrete reason.
 *
 * Local validation checks (in order):
 *   1. Extension: must match CalibrationAssetManifestEntry.expectedExtension
 *   2. Magic bytes: must match known byte signatures for the content type
 *   3. Size: must be within [minSizeBytes, maxSizeBytes]
 *   4. Geometry / method-specific bounds (if present in validationRules)
 *   5. Checksum: if expectedSha256 is non-null, must match file content
 *
 * NOTE: This service handles only the local copy of the manifest shipped
 * in assets/calibration-asset-manifest.json. It never fetches external
 * content; it only validates files the user explicitly selects via the
 * OS file picker (after navigation to a URL is allowlisted by the app).
 *
 * NOTE: inspectCalibrationPhoto (in calibrationWire.ts) is a separate
 * photo validator and is NOT related to asset manifest coverage.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  lstat,
  open,
  readFile,
  stat,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dialog, app } from 'electron';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Manifest schema (mirrors CalibrationAssetManifestEntry in ipc.ts)
// ---------------------------------------------------------------------------

const ManifestEntry = z
  .object({
    method: z.string().min(1).max(128),
    enabled: z.boolean(),
    disabledReason: z.string().max(512).nullable(),
    sourceUrl: z.string().url().max(2048),
    author: z.string().max(512),
    license: z.string().max(256),
    attribution: z.string().max(1024),
    expectedFilename: z.string().max(256).nullable(),
    contentType: z.string().max(128),
    expectedExtension: z.string().max(32),
    expectedSha256: z.string().max(64).nullable(),
    minSizeBytes: z.number().int().positive(),
    maxSizeBytes: z.number().int().positive(),
    validationRules: z.record(z.unknown()).optional().default({}),
  })
  .passthrough();
type ManifestEntry = z.infer<typeof ManifestEntry>;

const ManifestFile = z
  .object({
    schemaVersion: z.string(),
    entries: z.array(ManifestEntry).max(100),
  })
  .passthrough();
type ManifestFile = z.infer<typeof ManifestFile>;

// ---------------------------------------------------------------------------
// Magic byte detection
// ---------------------------------------------------------------------------

/**
 * Detect content type from magic bytes and format-defining structure.
 * Returns the detected type string or null if unknown.
 */
function detectContentType(
  buffer: Buffer,
  expectedExtension: string,
): string | null {
  const ext = expectedExtension.toLowerCase();
  if (ext === '3mf' || ext === 'zip') {
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04
    ) {
      return 'application/vnd.ms-3mfdocument';
    }
    return null;
  }
  if (ext === 'stl') {
    // ASCII STL
    if (
      buffer.length >= 6 &&
      buffer.slice(0, 6).toString('ascii') === 'solid '
    ) {
      return 'model/stl';
    }
    // Binary STL has no fixed magic marker. Its type discriminator is the
    // exact 80-byte header + uint32 count + count*50-byte record structure.
    if (buffer.length >= 84) {
      const triangleCount = buffer.readUInt32LE(80);
      if (buffer.length === 84 + triangleCount * 50) return 'model/stl';
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Staged file store (approvalId → absolute path, per-process lifetime)
// ---------------------------------------------------------------------------

/** Approval entries expire after 10 minutes to prevent stale replay. */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

interface StagedFile {
  filePath: string;
  extension: string;
  byteSize: number;
  stagedAt: number;
}

type AssetReadFailure = {
  readonly status: 'invalid';
  readonly reason: 'pathRestricted' | 'tooLarge';
  readonly detail: string;
};

async function readBoundedRegularAsset(
  filePath: string,
  maximumBytes: number,
): Promise<
  { readonly status: 'ok'; readonly content: Buffer } | AssetReadFailure
> {
  let selectedInfo;
  try {
    selectedInfo = await lstat(filePath);
  } catch {
    return {
      status: 'invalid',
      reason: 'pathRestricted',
      detail: 'Selected asset is inaccessible.',
    };
  }
  if (selectedInfo.isSymbolicLink() || !selectedInfo.isFile()) {
    return {
      status: 'invalid',
      reason: 'pathRestricted',
      detail: 'Selected asset must be a regular, non-symlink file.',
    };
  }
  if (selectedInfo.size > maximumBytes) {
    return {
      status: 'invalid',
      reason: 'tooLarge',
      detail: `File is ${selectedInfo.size} bytes, maximum is ${maximumBytes} bytes.`,
    };
  }

  let file;
  try {
    file = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return {
      status: 'invalid',
      reason: 'pathRestricted',
      detail: 'Selected asset could not be opened without following links.',
    };
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) {
      return {
        status: 'invalid',
        reason: 'pathRestricted',
        detail: 'Selected asset is not a regular file.',
      };
    }
    if (before.size > maximumBytes) {
      return {
        status: 'invalid',
        reason: 'tooLarge',
        detail: `File is ${before.size} bytes, maximum is ${maximumBytes} bytes.`,
      };
    }
    const content = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && before.ino !== after.ino)
    ) {
      return {
        status: 'invalid',
        reason: 'pathRestricted',
        detail: 'Selected asset changed while it was read.',
      };
    }
    if (content.byteLength > maximumBytes) {
      return {
        status: 'invalid',
        reason: 'tooLarge',
        detail: `File is ${content.byteLength} bytes, maximum is ${maximumBytes} bytes.`,
      };
    }
    return { status: 'ok', content };
  } finally {
    await file.close();
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CalibrationAssetManifestService {
  /**
   * Staged file approvals. Keys are UUIDs returned to the renderer.
   * The renderer never receives raw file paths — it only receives an
   * opaque approval ID.
   */
  private readonly _staged = new Map<string, StagedFile>();

  /**
   * Path to the static manifest shipped with the app.
   */
  private readonly _manifestPath: string;

  /** Cached parsed manifest (lazy). */
  private _manifest: ManifestFile | null = null;
  private _lastValidationBytesRead = 0;

  constructor(manifestPath?: string) {
    this._manifestPath =
      manifestPath ??
      path.join(
        // In dev (Vite), assets live in project root; in packaged, in resources.
        app.isPackaged
          ? process.resourcesPath
          : path.join(process.cwd(), 'assets'),
        'calibration-asset-manifest.json',
      );
  }

  /** Main-process diagnostic seam used to verify bounded validation reads. */
  getLastValidationMetrics(): { readonly bytesRead: number } {
    return { bytesRead: this._lastValidationBytesRead };
  }

  /** Load (and cache) the manifest. */
  async load(): Promise<{
    status: 'ok';
    schemaVersion: string;
    entries: ManifestEntry[];
  }> {
    const manifest = await this._loadManifest();
    return {
      status: 'ok',
      schemaVersion: manifest.schemaVersion,
      entries: manifest.entries,
    };
  }

  /**
   * Return true only if `url` is listed as a `sourceUrl` in the manifest.
   *
   * This is the allowlist check for external navigation (criterion 14b):
   * only URLs that appear as reviewed manifest entries are permitted.
   * A scheme check alone is not sufficient — this method enforces that the
   * URL originates from the reviewed and shipped manifest.
   *
   * Mutation test: replace with `return true` → any https:// URL is accepted
   * → test for non-manifest https:// URL fails (expects false).
   */
  async isManifestSourceUrl(url: string): Promise<boolean> {
    const manifest = await this._loadManifest();
    return manifest.entries.some((e) => e.sourceUrl === url);
  }

  /**
   * Open an OS file picker restricted to the given extensions.
   * On success returns an opaque approvalId, file size, and extension.
   * The renderer never receives the file path.
   */
  async pickFile(
    allowedExtensions: string[],
    title: string,
  ): Promise<
    | { status: 'ok'; approvalId: string; byteSize: number; extension: string }
    | { status: 'cancelled' }
    | { status: 'error'; message: string }
  > {
    this._lastValidationBytesRead = 0;
    const filters = [
      {
        name: 'Calibration Asset',
        extensions: allowedExtensions.map((e) => e.replace(/^\./, '')),
      },
    ];
    const result = await dialog.showOpenDialog({
      title,
      filters,
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    const filePath = result.filePaths[0];
    if (!filePath) {
      return { status: 'cancelled' };
    }
    try {
      const stats = await stat(filePath);
      const rawExt = path.extname(filePath);
      const ext = rawExt.replace(/^\./, '').toLowerCase();
      const approvalId = randomUUID();
      this._staged.set(approvalId, {
        filePath,
        extension: ext,
        byteSize: stats.size,
        stagedAt: Date.now(),
      });
      return { status: 'ok', approvalId, byteSize: stats.size, extension: ext };
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not stat selected file.',
      };
    }
  }

  /**
   * Validate a previously staged file against the manifest entry for the
   * given method. Returns a typed result — never throws to the renderer.
   */
  async validateFile(
    approvalId: string,
    method: string,
  ): Promise<
    | {
        status: 'ok';
        sha256: string;
        byteSize: number;
        extension: string;
        contentType: string;
        checksumVerified: boolean;
        validationNotes: string[];
      }
    | {
        status: 'invalid';
        reason:
          | 'badExtension'
          | 'badMagicBytes'
          | 'contentTypeMismatch'
          | 'tooSmall'
          | 'tooLarge'
          | 'geometryOutOfBounds'
          | 'checksumMismatch'
          | 'methodDisabled'
          | 'approvalExpired'
          | 'pathRestricted';
        detail: string;
      }
    | { status: 'error'; message: string }
  > {
    // Expire stale approvals
    this._evictExpired();
    const staged = this._staged.get(approvalId);
    if (!staged) {
      return {
        status: 'invalid',
        reason: 'approvalExpired',
        detail:
          'The file approval has expired or was never issued. Please re-select the file.',
      };
    }

    let manifest: ManifestFile;
    try {
      manifest = await this._loadManifest();
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Manifest load failed.',
      };
    }

    const entry = manifest.entries.find((e) => e.method === method);
    if (!entry) {
      return {
        status: 'error',
        message: `No manifest entry found for method "${method}".`,
      };
    }

    if (!entry.enabled) {
      return {
        status: 'invalid',
        reason: 'methodDisabled',
        detail:
          entry.disabledReason ??
          `Method "${method}" is not yet enabled in the asset manifest.`,
      };
    }

    // 1. Extension check
    const fileExt = staged.extension.toLowerCase();
    const expectedExt = entry.expectedExtension.toLowerCase();
    if (fileExt !== expectedExt) {
      return {
        status: 'invalid',
        reason: 'badExtension',
        detail: `Expected extension ".${expectedExt}", got ".${fileExt}".`,
      };
    }

    // Bound and verify the selected file before allocating its contents.
    const readResult = await readBoundedRegularAsset(
      staged.filePath,
      entry.maxSizeBytes,
    );
    if (readResult.status === 'invalid') return readResult;
    const content = readResult.content;
    this._lastValidationBytesRead = content.byteLength;

    // 2. Magic bytes check
    const detectedType = detectContentType(content, entry.expectedExtension);
    if (detectedType === null) {
      return {
        status: 'invalid',
        reason: 'badMagicBytes',
        detail: `File does not have the expected signature for ".${expectedExt}" content.`,
      };
    }
    if (detectedType !== entry.contentType) {
      return {
        status: 'invalid',
        reason: 'contentTypeMismatch',
        detail: `Detected ${detectedType}, but the manifest declares ${entry.contentType}.`,
      };
    }

    // 3. Size check (use actual bytes, not stat, in case of race)
    const byteSize = content.length;
    if (byteSize < entry.minSizeBytes) {
      return {
        status: 'invalid',
        reason: 'tooSmall',
        detail: `File is ${byteSize} bytes, minimum is ${entry.minSizeBytes} bytes.`,
      };
    }
    if (byteSize > entry.maxSizeBytes) {
      return {
        status: 'invalid',
        reason: 'tooLarge',
        detail: `File is ${byteSize} bytes, maximum is ${entry.maxSizeBytes} bytes.`,
      };
    }

    // 4. Method-specific geometry / bounds
    const validationNotes: string[] = [];
    const rules = entry.validationRules ?? {};
    const geometryResult = validateGeometryRules(content, fileExt, rules);
    if (geometryResult.type === 'invalid') {
      return {
        status: 'invalid',
        reason: 'geometryOutOfBounds',
        detail: geometryResult.detail,
      };
    }
    validationNotes.push(...geometryResult.notes);

    // 5. Checksum (if manifest specifies one)
    const sha256 = createHash('sha256').update(content).digest('hex');
    let checksumVerified = false;
    if (entry.expectedSha256) {
      if (sha256 !== entry.expectedSha256.toLowerCase()) {
        return {
          status: 'invalid',
          reason: 'checksumMismatch',
          detail: `SHA-256 mismatch. Expected ${entry.expectedSha256}, got ${sha256}.`,
        };
      }
      checksumVerified = true;
    }

    // Remove from staged after successful validation
    this._staged.delete(approvalId);

    return {
      status: 'ok',
      sha256,
      byteSize,
      extension: fileExt,
      contentType: detectedType,
      checksumVerified,
      validationNotes,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _loadManifest(): Promise<ManifestFile> {
    if (this._manifest !== null) return this._manifest;
    const raw = await readFile(this._manifestPath, 'utf-8');
    this._manifest = ManifestFile.parse(JSON.parse(raw));
    return this._manifest;
  }

  private _evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this._staged) {
      if (now - entry.stagedAt > APPROVAL_TTL_MS) {
        this._staged.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry / method-specific validation rules
// ---------------------------------------------------------------------------

/**
 * Validate method-specific geometry and bound rules read from the manifest.
 *
 * Returns `{ type: 'ok', notes }` or `{ type: 'invalid', detail }`.
 */
function validateGeometryRules(
  content: Buffer,
  extension: string,
  rules: Record<string, unknown>,
): { type: 'ok'; notes: string[] } | { type: 'invalid'; detail: string } {
  const notes: string[] = [];

  if (extension === 'stl') {
    // Binary STL: validate triangle count matches file size
    // Format: 80-byte header, 4-byte uint32 count, then count * 50 bytes
    if (
      content.length >= 84 &&
      content.slice(0, 6).toString('ascii') !== 'solid '
    ) {
      const triangleCount = content.readUInt32LE(80);
      const expectedSize = 80 + 4 + triangleCount * 50;
      if (content.length !== expectedSize) {
        return {
          type: 'invalid',
          detail: `Binary STL size mismatch. Header claims ${triangleCount} triangles (expected ${expectedSize} bytes), but file is ${content.length} bytes.`,
        };
      }
      // Check method-specific triangle count bounds
      const minTriangles =
        typeof rules['minTriangles'] === 'number'
          ? rules['minTriangles']
          : null;
      const maxTriangles =
        typeof rules['maxTriangles'] === 'number'
          ? rules['maxTriangles']
          : null;
      if (minTriangles !== null && triangleCount < minTriangles) {
        return {
          type: 'invalid',
          detail: `STL has ${triangleCount} triangles; minimum required by method is ${minTriangles}.`,
        };
      }
      if (maxTriangles !== null && triangleCount > maxTriangles) {
        return {
          type: 'invalid',
          detail: `STL has ${triangleCount} triangles; maximum allowed by method is ${maxTriangles}.`,
        };
      }
      notes.push(`Binary STL: ${triangleCount} triangles, structure valid.`);
    }
  }

  // Method-specific file size bounds (if present, more specific than manifest
  // level minSizeBytes/maxSizeBytes).
  const minBytes =
    typeof rules['minBytes'] === 'number' ? rules['minBytes'] : null;
  const maxBytes =
    typeof rules['maxBytes'] === 'number' ? rules['maxBytes'] : null;
  if (minBytes !== null && content.length < minBytes) {
    return {
      type: 'invalid',
      detail: `File is ${content.length} bytes; method requires at least ${minBytes} bytes.`,
    };
  }
  if (maxBytes !== null && content.length > maxBytes) {
    return {
      type: 'invalid',
      detail: `File is ${content.length} bytes; method allows at most ${maxBytes} bytes.`,
    };
  }

  return { type: 'ok', notes };
}
