import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  inspectCalibrationPhoto,
  MAX_CALIBRATION_PHOTO_BYTES,
} from '../src/main/calibrationWire.js';
import {
  CalibrationPhotoApprovalStore,
  stagePrivateCalibrationPhoto,
} from '../src/main/calibrationPhotos.js';

const scratch = path.join(
  process.cwd(),
  'tests',
  `.calibration-photo-test-${process.pid}-${randomUUID()}`,
);

beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe('calibration photo inspection', () => {
  it.each([
    {
      name: 'JPEG',
      filename: 'photo.bin',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01]),
      mimeType: 'image/jpeg',
      extension: 'jpg',
    },
    {
      name: 'PNG',
      filename: 'photo.jpg',
      bytes: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
      ]),
      mimeType: 'image/png',
      extension: 'png',
    },
    {
      name: 'WebP',
      filename: 'photo.png',
      bytes: Buffer.from('RIFF1234WEBPdata', 'ascii'),
      mimeType: 'image/webp',
      extension: 'webp',
    },
  ])('detects $name from magic bytes, not extension', async (fixture) => {
    const filename = path.join(scratch, `${fixture.name}-${fixture.filename}`);
    await writeFile(filename, fixture.bytes);

    const result = await inspectCalibrationPhoto(filename);

    expect(result.mimeType).toBe(fixture.mimeType);
    expect(result.extension).toBe(fixture.extension);
    expect(result.contentHash).toBe(
      createHash('sha256').update(fixture.bytes).digest('hex'),
    );
    expect(result.bytes).toEqual(fixture.bytes);
  });

  it('rejects non-image bytes and non-regular paths', async () => {
    const invalid = path.join(scratch, 'invalid.png');
    await writeFile(invalid, 'not an image');

    await expect(inspectCalibrationPhoto(invalid)).rejects.toThrow(
      /JPEG, PNG, and WebP/,
    );
    await expect(inspectCalibrationPhoto(scratch)).rejects.toThrow(
      /regular, non-symlink/,
    );
  });

  it('rejects files larger than 20 MB before reading them', async () => {
    const oversized = path.join(scratch, 'oversized.jpg');
    const file = await open(oversized, 'w');
    try {
      await file.truncate(MAX_CALIBRATION_PHOTO_BYTES + 1);
    } finally {
      await file.close();
    }

    await expect(inspectCalibrationPhoto(oversized)).rejects.toThrow(
      /invalid size/,
    );
  });

  it('rejects paths containing a symlink or reparse point', async () => {
    const targetDirectory = path.join(scratch, 'symlink-target');
    const linkedDirectory = path.join(scratch, 'symlink-photo');
    const target = path.join(targetDirectory, 'photo.png');
    const linked = path.join(linkedDirectory, 'photo.png');
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    await mkdir(targetDirectory);
    await writeFile(target, bytes);
    await symlink(
      targetDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const direct = await stagePrivateCalibrationPhoto(
      target,
      path.join(scratch, 'private'),
      '11111111-1111-4111-8111-111111111111',
      randomUUID(),
    );
    expect(direct.bytes).toEqual(bytes);
    expect(direct.created).toBe(true);

    await expect(
      stagePrivateCalibrationPhoto(
        linked,
        path.join(scratch, 'private'),
        '11111111-1111-4111-8111-111111111111',
        randomUUID(),
      ),
    ).rejects.toThrow(/symlink|reparse/i);
  });

  it('atomically copies image bytes to private storage and replays by hash', async () => {
    const source = path.join(scratch, 'atomic-source.bin');
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    await writeFile(source, bytes);
    const root = path.join(scratch, 'private-copy');
    const profileId = '11111111-1111-4111-8111-111111111111';
    const photoId = randomUUID();

    const first = await stagePrivateCalibrationPhoto(
      source,
      root,
      profileId,
      photoId,
    );
    const replay = await stagePrivateCalibrationPhoto(
      source,
      root,
      profileId,
      photoId,
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.localPath).toBe(first.localPath);
    expect(await readFile(first.localPath)).toEqual(bytes);
    expect(path.basename(first.localPath)).toBe(`${photoId}.png`);
  });
});

describe('calibration photo approvals', () => {
  it('is sender-bound, expiring, and consumed exactly once', () => {
    let now = 1_000;
    const approvals = new CalibrationPhotoApprovalStore({
      now: () => now,
      ttlMs: 100,
    });
    const approvalId = approvals.approve('C:\\selected\\photo.png', 7);

    expect(() => approvals.consume(approvalId, 8)).toThrow(/another window/);
    expect(approvals.consume(approvalId, 7)).toBe('C:\\selected\\photo.png');
    expect(() => approvals.consume(approvalId, 7)).toThrow(/missing|expired/);

    const expiredId = approvals.approve('C:\\selected\\old.png', 7);
    now += 101;
    expect(() => approvals.consume(expiredId, 7)).toThrow(/missing|expired/);
    approvals.clear();
  });
});
