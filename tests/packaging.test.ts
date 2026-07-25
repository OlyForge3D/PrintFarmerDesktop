// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(forgeConfig.packagerConfig?.extraResource).toContain(
      './resources/target-profiles',
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
