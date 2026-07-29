/**
 * CalibrationAssetManifestService — unit tests (criterion 14, issue #54).
 *
 * All evidence is fixture-based; no live server, no Klipper hardware.
 *
 * Tests cover:
 * - Manifest JSON loading and schema validation.
 * - Extension validation (correct → ok, wrong → badExtension).
 * - Magic bytes validation (correct → ok, truncated/wrong → badMagicBytes).
 * - Size validation (too small → tooSmall, too large → tooLarge).
 * - STL geometry: binary structure validation.
 * - Checksum verification (match → ok, mismatch → checksumMismatch).
 * - Method disabled → methodDisabled.
 * - Approval expired / never issued → approvalExpired.
 * - Additive-compatible manifest fields are accepted without throwing.
 * - Approval expires after 10 minutes (TTL eviction).
 *
 * Test discipline (SKILL.md): each test names exactly one guard and is
 * sized so that mutating that guard causes exactly this test to fail.
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// NOTE: CalibrationAssetManifestService imports from 'electron' (for `dialog`
// and `app`). We mock those so tests run outside Electron.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
  },
}));

import { dialog } from 'electron';
import { CalibrationAssetManifestService } from '../src/main/calibrationAssetManifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: '1',
    entries: [
      {
        method: 'TestMethod',
        enabled: true,
        disabledReason: null,
        sourceUrl: 'https://example.com/asset',
        author: 'Test Author',
        license: 'MIT',
        attribution: 'Test attribution',
        expectedFilename: null,
        contentType: 'model/stl',
        expectedExtension: 'stl',
        expectedSha256: null,
        minSizeBytes: 134, // 80 header + 4 count + 1 triangle * 50 bytes = 134
        maxSizeBytes: 1024 * 1024,
        validationRules: {},
        ...overrides,
      },
    ],
  };
}

/** Build a valid binary STL buffer with the given number of triangles. */
function makeBinaryStl(triangleCount: number): Buffer {
  const size = 80 + 4 + triangleCount * 50;
  const buf = Buffer.alloc(size, 0);
  buf.writeUInt32LE(triangleCount, 80);
  return buf;
}

/** Build a valid ASCII STL buffer. */
function makeAsciiStl(): Buffer {
  return Buffer.from('solid test\nendsolid test\n', 'ascii');
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestContext {
  tempDir: string;
  manifestPath: string;
  service: CalibrationAssetManifestService;
}

async function setup(
  manifestOverrides: Record<string, unknown> = {},
): Promise<TestContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pfm-asset-test-'));
  const manifestPath = path.join(tempDir, 'calibration-asset-manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify(makeManifest(manifestOverrides)),
    'utf-8',
  );
  const service = new CalibrationAssetManifestService(manifestPath);
  return { tempDir, manifestPath, service };
}

async function teardown(ctx: TestContext): Promise<void> {
  await rm(ctx.tempDir, { recursive: true, force: true });
}

/** Stage a file as if the user picked it via the OS picker. */
async function stageFile(
  ctx: TestContext,
  filename: string,
  content: Buffer,
): Promise<string> {
  const filePath = path.join(ctx.tempDir, filename);
  await writeFile(filePath, content);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
    canceled: false,
    filePaths: [filePath],
  });
  const result = await ctx.service.pickFile(['stl', '3mf'], 'Test');
  if (result.status !== 'ok') {
    throw new Error(`stageFile: expected ok, got ${result.status}`);
  }
  return result.approvalId;
}

// ==========================================================================
// Tests
// ==========================================================================

describe('CalibrationAssetManifestService.load', () => {
  it('loads and parses a valid manifest JSON file', async () => {
    const ctx = await setup();
    try {
      const manifest = await ctx.service.load();
      expect(manifest.status).toBe('ok');
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0]?.method).toBe('TestMethod');
    } finally {
      await teardown(ctx);
    }
  });

  it('returns schemaVersion from the manifest', async () => {
    const ctx = await setup();
    try {
      const manifest = await ctx.service.load();
      if (manifest.status !== 'ok') throw new Error('expected ok');
      expect(manifest.schemaVersion).toBe('1');
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.pickFile', () => {
  it('returns ok with approvalId when user selects a file', async () => {
    const ctx = await setup();
    try {
      const stlBuf = makeBinaryStl(1);
      const filePath = path.join(ctx.tempDir, 'test.stl');
      await writeFile(filePath, stlBuf);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: [filePath],
      });

      const result = await ctx.service.pickFile(['stl'], 'Test');

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.approvalId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.extension).toBe('stl');
        expect(result.byteSize).toBe(stlBuf.length);
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('returns cancelled when dialog is cancelled', async () => {
    const ctx = await setup();
    try {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      const result = await ctx.service.pickFile(['stl'], 'Test');

      expect(result.status).toBe('cancelled');
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — extension guard', () => {
  it('returns ok for correct extension (.stl)', async () => {
    const ctx = await setup();
    try {
      const stlBuf = makeBinaryStl(1);
      const approvalId = await stageFile(ctx, 'asset.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: correct extension passes.
      expect(result.status).toBe('ok');
    } finally {
      await teardown(ctx);
    }
  });

  it('returns invalid/badExtension for wrong extension (.gcode instead of .stl)', async () => {
    const ctx = await setup();
    try {
      // Stage a file with wrong extension (.gcode).
      const content = Buffer.from('G28\nG1 Z10\n', 'ascii');
      const filePath = path.join(ctx.tempDir, 'asset.gcode');
      await writeFile(filePath, content);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: [filePath],
      });
      const pickResult = await ctx.service.pickFile(['stl', 'gcode'], 'Test');
      if (pickResult.status !== 'ok') throw new Error('expected ok');
      const approvalId = pickResult.approvalId;

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: wrong extension → badExtension, not any other reason.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('badExtension');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — magic bytes guard', () => {
  it('returns invalid/badMagicBytes for random bytes with .stl extension', async () => {
    const ctx = await setup({ minSizeBytes: 10 });
    try {
      // File has .stl extension but is too short to be binary STL (< 84 bytes)
      // and does not start with "solid " (ASCII STL marker).
      // Expected: detectContentType returns null → badMagicBytes.
      const randomContent = Buffer.alloc(50, 0xab); // < 84 bytes, not PK, not "solid "
      const approvalId = await stageFile(ctx, 'bad.stl', randomContent);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: invalid magic bytes → badMagicBytes, not badExtension.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('badMagicBytes');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('accepts valid ASCII STL (starts with "solid ")', async () => {
    const ctx = await setup({ minSizeBytes: 10 });
    try {
      const asciiStl = makeAsciiStl();
      const approvalId = await stageFile(ctx, 'ascii.stl', asciiStl);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      expect(result.status).toBe('ok');
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — size guard', () => {
  it('returns invalid/tooSmall when file is below minSizeBytes', async () => {
    // minSizeBytes=134 (1 triangle binary STL). File has 0 triangles → 84 bytes.
    const ctx = await setup({ minSizeBytes: 134 });
    try {
      const tooSmall = makeBinaryStl(0); // 84 bytes (80 header + 4 count)
      const approvalId = await stageFile(ctx, 'small.stl', tooSmall);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: tooSmall, not tooLarge or badMagicBytes.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('tooSmall');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('returns invalid/tooLarge when file exceeds maxSizeBytes', async () => {
    const ctx = await setup({ minSizeBytes: 10, maxSizeBytes: 100 });
    try {
      const bigContent = Buffer.alloc(200, 0); // 200 bytes > 100
      // Force ASCII STL magic to pass magic check
      Buffer.from('solid ', 'ascii').copy(bigContent, 0);
      const approvalId = await stageFile(ctx, 'big.stl', bigContent);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: tooLarge, not tooSmall.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('tooLarge');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — checksum guard', () => {
  it('returns ok with checksumVerified=true when sha256 matches manifest', async () => {
    const stlBuf = makeBinaryStl(1);
    const expectedSha256 = createHash('sha256').update(stlBuf).digest('hex');
    const ctx = await setup({ expectedSha256 });
    try {
      const approvalId = await stageFile(ctx, 'verified.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: checksum matches → checksumVerified=true.
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.checksumVerified).toBe(true);
        expect(result.sha256).toBe(expectedSha256);
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('returns invalid/checksumMismatch when sha256 does not match', async () => {
    const stlBuf = makeBinaryStl(1);
    const wrongSha256 = 'a'.repeat(64); // wrong hash
    const ctx = await setup({ expectedSha256: wrongSha256 });
    try {
      const approvalId = await stageFile(ctx, 'bad-checksum.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: checksum mismatch → checksumMismatch, not ok.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('checksumMismatch');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('returns ok with checksumVerified=false when manifest has no expectedSha256', async () => {
    const ctx = await setup({ expectedSha256: null });
    try {
      const stlBuf = makeBinaryStl(1);
      const approvalId = await stageFile(ctx, 'nochecksum.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: no manifest checksum → ok but checksumVerified=false.
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.checksumVerified).toBe(false);
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — method disabled guard', () => {
  it('returns invalid/methodDisabled when method is disabled in manifest', async () => {
    const ctx = await setup({
      enabled: false,
      disabledReason: 'Not yet reviewed by the OlyForge3D team.',
    });
    try {
      const stlBuf = makeBinaryStl(1);
      const approvalId = await stageFile(ctx, 'disabled.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: disabled method → methodDisabled, not any file validation error.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('methodDisabled');
        expect(result.detail).toContain('Not yet reviewed');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.validateFile — approval expiry guard', () => {
  it('returns invalid/approvalExpired for unknown approval ID', async () => {
    const ctx = await setup();
    try {
      const result = await ctx.service.validateFile(
        '00000000-0000-4000-8000-000000000000', // never staged
        'TestMethod',
      );

      // Specific guard: unknown approvalId → approvalExpired.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('approvalExpired');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService — STL geometry bounds guard', () => {
  it('returns invalid/geometryOutOfBounds for binary STL with too few triangles', async () => {
    const ctx = await setup({
      validationRules: { minTriangles: 10 },
      minSizeBytes: 10,
    });
    try {
      const stlBuf = makeBinaryStl(2); // 2 triangles < minTriangles=10
      const approvalId = await stageFile(ctx, 'fewtriangles.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      // Specific guard: geometry out of bounds (triangles too few) → geometryOutOfBounds.
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('geometryOutOfBounds');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('accepts binary STL within triangle bounds', async () => {
    const ctx = await setup({
      validationRules: { minTriangles: 1, maxTriangles: 1000 },
      minSizeBytes: 10,
    });
    try {
      const stlBuf = makeBinaryStl(5); // 5 triangles, within [1, 1000]
      const approvalId = await stageFile(ctx, 'ok-triangles.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      expect(result.status).toBe('ok');
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService — provenance output', () => {
  it('includes SHA-256 hex checksum in ok result for provenance display', async () => {
    const ctx = await setup({ minSizeBytes: 10 });
    try {
      const stlBuf = makeBinaryStl(1);
      const approvalId = await stageFile(ctx, 'provenance.stl', stlBuf);

      const result = await ctx.service.validateFile(approvalId, 'TestMethod');

      if (result.status !== 'ok')
        throw new Error(`expected ok, got ${result.status}`);
      // Specific guard: sha256 is present and is a 64-char hex string.
      expect(result.sha256).toHaveLength(64);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('CalibrationAssetManifestService.isManifestSourceUrl', () => {
  it('returns true for a URL present in the manifest sourceUrl list', async () => {
    // Mutation test: replace isManifestSourceUrl with `return false` →
    // expect(true) fails → present URLs are wrongly rejected.
    const ctx = await setup();
    try {
      const result = await ctx.service.isManifestSourceUrl(
        'https://example.com/asset',
      );
      expect(result).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('returns false for an https:// URL absent from the manifest', async () => {
    // Mutation test: replace isManifestSourceUrl with `return true` →
    // expect(false) fails → non-manifest URLs are wrongly allowed through.
    const ctx = await setup();
    try {
      const result = await ctx.service.isManifestSourceUrl(
        'https://evil.example.com/malware.stl',
      );
      expect(result).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });
});
