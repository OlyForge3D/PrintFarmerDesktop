// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MakerDMG } from '@electron-forge/maker-dmg';
import forgeConfig from '../forge.config';
import { resolveAppIconPath } from '../src/main/appIcon';

const repoRoot = path.resolve(import.meta.dirname, '..');
const assetPath = (extension: string): string =>
  path.join(repoRoot, 'assets', `icon.${extension}`);

function isForgeMaker(value: unknown): value is {
  name: string;
  config: unknown;
  prepareConfig: (arch: 'x64') => Promise<void>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'prepareConfig' in value &&
    typeof value.prepareConfig === 'function'
  );
}

describe('application icon packaging', () => {
  it('uses a Retina background and an unclipped drag-to-install layout for universal builds', async () => {
    const dmg = forgeConfig.makers?.find(
      (maker): maker is MakerDMG => maker instanceof MakerDMG,
    );
    expect(dmg).toBeDefined();
    if (!dmg) throw new Error('DMG maker is missing');
    await dmg.prepareConfig('universal');
    const config = dmg.config;
    expect(config.name).toBeUndefined();
    expect(config.title).toBe('Install PrintFarmer Desktop');
    expect(config.background).toBe(
      path.join(repoRoot, 'assets', 'dmg', 'background.png'),
    );
    expect(config.iconSize).toBe(96);
    const { scripts } = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(scripts['generate:dmg-background']).toBe(
      'electron scripts/generate-dmg-background.mjs',
    );
    expect(config.additionalDMGOptions?.window?.size).toEqual({
      width: 680,
      height: 460,
    });
    for (const [suffix, scale] of [
      ['', 1],
      ['@2x', 2],
    ] as const) {
      const png = readFileSync(
        path.join(repoRoot, 'assets', 'dmg', `background${suffix}.png`),
      );
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(680 * scale);
      expect(png.readUInt32BE(20)).toBe(460 * scale);
    }
    expect(typeof config.contents).toBe('function');
    if (typeof config.contents !== 'function') {
      throw new Error('DMG contents must resolve the packaged app path');
    }
    const appPath = path.join(
      repoRoot,
      'out',
      'PrintFarmer Desktop-darwin-universal',
      'PrintFarmer Desktop.app',
    );
    const contents = config.contents({ appPath, name: 'PrintFarmer Desktop' });
    expect(contents).toEqual([
      { x: 180, y: 280, type: 'file', path: appPath },
      { x: 500, y: 280, type: 'link', path: '/Applications' },
    ]);
    for (const { x, y } of contents) {
      // Allow a 200px label and 48px below the icon, clear of footer and edges.
      expect(x - 100).toBeGreaterThan(0);
      expect(x + 100).toBeLessThan(680);
      expect(y - 48).toBeGreaterThan(174);
      expect(y + 48 + 48).toBeLessThan(399);
    }
  });

  it('ships a transparent 1024px PNG source', () => {
    const png = readFileSync(assetPath('png'));

    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(png[25]).toBe(6);
  });

  it('ships multi-resolution Windows and macOS containers', () => {
    const ico = readFileSync(assetPath('ico'));
    const icns = readFileSync(assetPath('icns'));
    const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const width = ico[6 + index * 16];
      return width === 0 ? 256 : width;
    });

    expect(ico.readUInt16LE(2)).toBe(1);
    expect(icoSizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.includes(Buffer.from('ic10'))).toBe(true);
  });

  it('uses the icon for packaging, the installer, windows, and the macOS dock', async () => {
    expect(forgeConfig.packagerConfig?.icon).toBe(
      path.join(repoRoot, 'assets', 'icon'),
    );
    expect(forgeConfig.packagerConfig?.extraResource).toContain(
      './assets/icon.png',
    );
    expect(forgeConfig.packagerConfig?.extraResource).toEqual(
      expect.arrayContaining([
        './resources/target-profiles',
        './resources/compliance',
      ]),
    );
    const squirrel = forgeConfig.makers
      ?.filter(isForgeMaker)
      .find((maker) => maker.name === 'squirrel');
    await squirrel?.prepareConfig('x64');
    expect(squirrel?.config).toMatchObject({
      setupIcon: assetPath('ico'),
    });
    const dmg = forgeConfig.makers
      ?.filter(isForgeMaker)
      .find((maker) => maker.name === 'dmg');
    await dmg?.prepareConfig('x64');
    expect(dmg?.config).toMatchObject({
      icon: assetPath('icns'),
    });
    expect(resolveAppIconPath('C:\\app', 'C:\\resources', false)).toBe(
      path.join('C:\\app', 'assets', 'icon.png'),
    );
    expect(resolveAppIconPath('C:\\app', 'C:\\resources', true)).toBe(
      path.join('C:\\resources', 'icon.png'),
    );
  });
});
