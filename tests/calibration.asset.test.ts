/**
 * Unit tests for calibrationAsset.ts — main-process local model validation (A-04, A-08).
 *
 * Uses real temp files (production-backed) for inspectCalibrationModel tests,
 * consistent with calibration.photo-staging.test.ts. No filesystem mocks.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  CalibrationModelApprovalStore,
  inspectCalibrationModel,
  MAX_CALIBRATION_MODEL_BYTES,
  MIN_CALIBRATION_MODEL_BYTES,
} from '../src/main/calibrationAsset';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir, rm, open as fsOpen } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

// ─── Scratch directory for real temp files ────────────────────────────────────

const scratch = join(
  process.cwd(),
  'tests',
  `.calibration-asset-test-${process.pid}-${randomUUID().slice(0, 8)}`,
);

/** Minimal valid 3MF bytes (ZIP magic + '3D/3dmodel.model'). */
function make3mfBytes(padTo = 620): Buffer {
  const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const content = Buffer.from('3D/3dmodel.model some content here');
  const base = Buffer.concat([magic, content]);
  return padTo > base.length
    ? Buffer.concat([base, Buffer.alloc(padTo - base.length)])
    : base;
}

beforeAll(async () => {
  await mkdir(scratch, { recursive: true });

  // wrong.obj — invalid extension test
  await writeFile(join(scratch, 'wrong.obj'), Buffer.alloc(1024));

  // small.3mf — below MIN_CALIBRATION_MODEL_BYTES
  await writeFile(
    join(scratch, 'small.3mf'),
    Buffer.alloc(MIN_CALIBRATION_MODEL_BYTES - 1),
  );

  // bad_magic.3mf — ZIP-sized but first 4 bytes are zeros
  await writeFile(
    join(scratch, 'bad_magic.3mf'),
    Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('3D/3dmodel.model'),
      Buffer.alloc(620),
    ]),
  );

  // no_model.3mf — ZIP magic but no '3D/3dmodel.model' path in contents
  await writeFile(
    join(scratch, 'no_model.3mf'),
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('content without model entry'),
      Buffer.alloc(620),
    ]),
  );

  // valid.3mf — minimal valid 3MF
  await writeFile(join(scratch, 'valid.3mf'), make3mfBytes());

  // valid.stl — any file above MIN with .stl extension (no magic check)
  await writeFile(
    join(scratch, 'valid.stl'),
    Buffer.alloc(MIN_CALIBRATION_MODEL_BYTES + 100),
  );

  // large.3mf — sparse/truncated file > MAX_CALIBRATION_MODEL_BYTES
  const fd = await fsOpen(join(scratch, 'large.3mf'), 'w');
  await fd.truncate(MAX_CALIBRATION_MODEL_BYTES + 1024);
  await fd.close();

  // dir.3mf — a directory with a .3mf name (should fail isFile check)
  await mkdir(join(scratch, 'dir.3mf'), { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

// ─── CalibrationModelApprovalStore ───────────────────────────────────────────

/** Helper: assert that fn() throws an error with the given typed code property. */
function expectThrowsWithCode(fn: () => void, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
}

describe('CalibrationModelApprovalStore', () => {
  it('approve returns a UUID and consume returns the path', () => {
    const store = new CalibrationModelApprovalStore();
    const approvalId = store.approve('/test/file.3mf', 1);
    expect(approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const path = store.consume(approvalId, 1);
    expect(path).toBe('/test/file.3mf');
  });

  it('consume throws with CALIBRATION_MODEL_NOT_APPROVED after approval is used', () => {
    const store = new CalibrationModelApprovalStore();
    const id = store.approve('/test/file.3mf', 1);
    store.consume(id, 1);
    expectThrowsWithCode(
      () => store.consume(id, 1),
      'CALIBRATION_MODEL_NOT_APPROVED',
    );
  });

  it('consume throws with CALIBRATION_MODEL_NOT_APPROVED for wrong ownerId', () => {
    const store = new CalibrationModelApprovalStore();
    const id = store.approve('/test/file.3mf', 1);
    expectThrowsWithCode(
      () => store.consume(id, 2),
      'CALIBRATION_MODEL_NOT_APPROVED',
    );
  });

  it('consume throws with CALIBRATION_MODEL_NOT_APPROVED for expired approval', () => {
    let now = 0;
    const store = new CalibrationModelApprovalStore({
      now: () => now,
      ttlMs: 1000,
    });
    const id = store.approve('/test/file.3mf', 1);
    now = 2000; // advance past TTL
    expectThrowsWithCode(
      () => store.consume(id, 1),
      'CALIBRATION_MODEL_NOT_APPROVED',
    );
  });
});

// ─── inspectCalibrationModel ──────────────────────────────────────────────────

describe('inspectCalibrationModel — A-04 validation rejection codes', () => {
  it('A-08: invalidExtension — .obj file returns invalidExtension', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'wrong.obj'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('invalidExtension');
      expect(result.detail).toContain('.obj');
    }
  });

  it('A-08: notARegularFile — non-existent path returns notARegularFile', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'does_not_exist.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('notARegularFile');
    }
  });

  it('A-08: notARegularFile — directory with .3mf name returns notARegularFile', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'dir.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('notARegularFile');
    }
  });

  it('A-08: fileTooLarge — sparse file > 50 MiB returns fileTooLarge', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'large.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('fileTooLarge');
    }
  });

  it('A-08: fileTooSmall — file under MIN bytes returns fileTooSmall', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'small.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('fileTooSmall');
    }
  });

  it('A-08: invalidMagicBytes — wrong magic bytes in .3mf returns invalidMagicBytes', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'bad_magic.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('invalidMagicBytes');
    }
  });

  it('A-08: geometryOutOfBounds — ZIP magic but no model part returns geometryOutOfBounds', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'no_model.3mf'),
      null,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('geometryOutOfBounds');
    }
  });

  it('A-08: checksumMismatch — valid 3MF with wrong expected SHA-256 returns checksumMismatch', async () => {
    const wrongSha256 = 'a'.repeat(64);
    const result = await inspectCalibrationModel(
      join(scratch, 'valid.3mf'),
      wrongSha256,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('checksumMismatch');
      expect(result.detail).toContain(wrongSha256);
    }
  });

  it('A-08: valid 3MF returns valid with correct fields', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'valid.3mf'),
      null,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.detectedType).toBe('3mf');
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.byteSize).toBeGreaterThanOrEqual(
        MIN_CALIBRATION_MODEL_BYTES,
      );
    }
  });

  it('A-08: checksum accepted — valid 3MF with matching SHA-256 returns valid', async () => {
    const bytes = make3mfBytes();
    await writeFile(join(scratch, 'checksum_match.3mf'), bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await inspectCalibrationModel(
      join(scratch, 'checksum_match.3mf'),
      expectedSha256,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.sha256).toBe(expectedSha256);
    }
  });

  it('A-08: valid STL file returns valid (no magic check for STL)', async () => {
    const result = await inspectCalibrationModel(
      join(scratch, 'valid.stl'),
      null,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.detectedType).toBe('stl');
    }
  });
});

// ─── A-06: Backend-generated methods are reviewed; no external file needed ─────

describe('A-06: Manifest distinguishes backend-generated from user-provided methods', () => {
  function readManifest() {
    return JSON.parse(
      readFileSync(
        join(process.cwd(), 'compliance', 'calibration-asset-manifest.json'),
        'utf-8',
      ),
    ) as {
      methods: Array<{
        methodId: string;
        reviewed: boolean;
        generationMode?: string;
        reviewerNotes?: string;
        disabledReason?: string | null;
      }>;
    };
  }

  it('pressureAdvanceTower is reviewed with generationMode backendGenerated (A-06)', () => {
    const manifest = readManifest();
    const pa = manifest.methods.find(
      (m) => m.methodId === 'pressureAdvanceTower',
    );
    expect(pa).toBeDefined();
    expect(pa?.reviewed).toBe(true);
    expect(pa?.generationMode).toBe('backendGenerated');
    expect(pa?.disabledReason).toBeFalsy();
    expect(pa?.reviewerNotes).toBeTruthy();
  });

  it('flowCoarse is reviewed with generationMode backendGenerated (A-06)', () => {
    const manifest = readManifest();
    const fc = manifest.methods.find((m) => m.methodId === 'flowCoarse');
    expect(fc).toBeDefined();
    expect(fc?.reviewed).toBe(true);
    expect(fc?.generationMode).toBe('backendGenerated');
    expect(fc?.disabledReason).toBeFalsy();
  });

  it('temperatureTower is reviewed with generationMode backendGenerated (A-06)', () => {
    const manifest = readManifest();
    const t = manifest.methods.find((m) => m.methodId === 'temperatureTower');
    expect(t).toBeDefined();
    expect(t?.reviewed).toBe(true);
    expect(t?.generationMode).toBe('backendGenerated');
    expect(t?.disabledReason).toBeFalsy();
  });

  it('flowStandard is reviewed with generationMode backendGenerated (A-06)', () => {
    const manifest = readManifest();
    const fs = manifest.methods.find((m) => m.methodId === 'flowStandard');
    expect(fs).toBeDefined();
    expect(fs?.reviewed).toBe(true);
    expect(fs?.generationMode).toBe('backendGenerated');
    expect(fs?.disabledReason).toBeFalsy();
  });

  it('all methods have generationMode field distinguishing backend from user-provided (A-06)', () => {
    const manifest = readManifest();
    for (const method of manifest.methods) {
      expect(['backendGenerated', 'userProvided']).toContain(
        method.generationMode,
      );
    }
  });
});
