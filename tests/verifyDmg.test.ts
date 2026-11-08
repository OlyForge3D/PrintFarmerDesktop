// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMountedDmg } from '../scripts/verify-dmg.mjs';

describe('built DMG branding verification', () => {
  let mountPath: string;
  const expectedBackground = Buffer.from('branded Retina TIFF');
  const title = 'Install PrintFarmer Desktop';

  beforeEach(() => {
    mountPath = mkdtempSync(path.join(os.tmpdir(), 'printfarmer-dmg-test-'));
    mkdirSync(path.join(mountPath, '.background'));
    writeFileSync(
      path.join(mountPath, '.background', 'background.tiff'),
      expectedBackground,
    );
    writeFileSync(path.join(mountPath, '.DS_Store'), 'Finder layout');
  });

  afterEach(() => {
    rmSync(mountPath, { recursive: true, force: true });
  });

  it('accepts the branded title, exact Retina artwork and Finder layout', () => {
    expect(() =>
      verifyMountedDmg(mountPath, title, expectedBackground),
    ).not.toThrow();
  });

  it('rejects the default volume title', () => {
    expect(() =>
      verifyMountedDmg(mountPath, 'PrintFarmer Desktop', expectedBackground),
    ).toThrow('Unexpected DMG volume name');
  });

  it('rejects replaced artwork even with the correct title and dimensions', () => {
    writeFileSync(
      path.join(mountPath, '.background', 'background.tiff'),
      Buffer.from('generic Retina TIFF'),
    );
    expect(() =>
      verifyMountedDmg(mountPath, title, expectedBackground),
    ).toThrow('DMG background does not match');
  });

  it('rejects the default PNG background instead of a branded Retina TIFF', () => {
    rmSync(path.join(mountPath, '.background', 'background.tiff'));
    writeFileSync(
      path.join(mountPath, '.background', 'background.png'),
      'default white background and black arrow',
    );
    expect(() =>
      verifyMountedDmg(mountPath, title, expectedBackground),
    ).toThrow('DMG background does not match');
  });

  it('rejects a missing Finder layout', () => {
    rmSync(path.join(mountPath, '.DS_Store'));
    expect(() =>
      verifyMountedDmg(mountPath, title, expectedBackground),
    ).toThrow('DMG Finder layout is missing');
  });
});
