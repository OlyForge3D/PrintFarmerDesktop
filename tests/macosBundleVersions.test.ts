// @vitest-environment node

import type { ForgeConfig } from '@electron-forge/shared-types';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  configureMacBundleVersions,
  macBundleVersionOptions,
  macHelperAppPaths,
  verifyMacBundleVersions,
} from '../scripts/macos-bundle-versions.mjs';

describe('macOS bundle version mapping', () => {
  it.each([
    ['0.1.0-beta.5', '0.1.0', '6.0.3'],
    ['0.1.0-beta.6', '0.1.0', '6.0.4'],
    ['0.1.0', '0.1.0', '6.3.8'],
    ['0.0.0-alpha.0', '0.0.0', '1.0.0'],
    ['1.0.0-alpha.0', '1.0.0', '50.0.0'],
    ['1.9.9', '1.9.9', '98.9.9'],
  ])('maps %s without changing its release core', (semver, app, build) => {
    expect(macBundleVersionOptions(semver)).toEqual({
      appVersion: app,
      buildVersion: build,
    });
  });

  it('is injective and strictly increasing across every supported version', () => {
    const stages = [
      ...Array.from({ length: 8 }, (_, number) => `-alpha.${number}`),
      ...Array.from({ length: 30 }, (_, number) => `-beta.${number}`),
      ...Array.from({ length: 10 }, (_, number) => `-rc.${number}`),
      '',
    ];
    const builds = new Set<string>();
    let previous = 99;

    for (let major = 0; major <= 1; major += 1) {
      for (let minor = 0; minor <= 9; minor += 1) {
        for (let patch = 0; patch <= 9; patch += 1) {
          const core = `${major}.${minor}.${patch}`;
          for (const stage of stages) {
            const options = macBundleVersionOptions(`${core}${stage}`);
            if (
              options.appVersion !== core ||
              !/^(?:[1-9]|[1-9]\d)\.\d\.\d$/.test(options.buildVersion)
            ) {
              throw new Error(`Invalid mapping for ${core}${stage}`);
            }
            const [first, second, third] = options.buildVersion
              .split('.')
              .map(Number) as [number, number, number];
            const numeric = first * 100 + second * 10 + third;
            if (numeric <= previous || builds.has(options.buildVersion)) {
              throw new Error(`Non-increasing mapping for ${core}${stage}`);
            }
            previous = numeric;
            builds.add(options.buildVersion);
          }
        }
      }
    }
    expect(builds.size).toBe(9_800);
    expect(previous).toBe(9_899);
  });

  it.each([
    '2.0.0',
    '0.10.0',
    '0.0.10',
    '0.0.0-alpha.8',
    '0.0.0-beta.30',
    '0.0.0-rc.10',
    '0.0.0-dev.1',
    '0.0.0-beta',
    '0.0.0-beta.01',
    '00.1.0',
    '0.01.0',
    '0.1.00',
    '0.1.0+build',
    '0.1.0-beta.6+build',
    '0.1.0\n',
    ' 0.1.0',
    '0.1',
    'v0.1.0',
    '999999999999999999999999.0.0',
    '0.0.0-beta.999999999999999999999999',
  ])('rejects invalid or unrepresentable version %j', (version) => {
    expect(() => macBundleVersionOptions(version)).toThrow(
      'Unsupported macOS bundle version',
    );
  });

  it('changes only darwin packaging and leaves the version source untouched', () => {
    const config: ForgeConfig = {
      packagerConfig: { name: 'Example', asar: true },
    };
    const readVersion = vi.fn(() => '0.1.0-beta.6');

    configureMacBundleVersions(config, 'win32', readVersion);
    configureMacBundleVersions(config, 'linux', readVersion);
    expect(readVersion).not.toHaveBeenCalled();
    expect(config.packagerConfig).toEqual({ name: 'Example', asar: true });

    configureMacBundleVersions(config, 'darwin', readVersion);
    expect(readVersion).toHaveBeenCalledOnce();
    expect(config.packagerConfig).toEqual({
      name: 'Example',
      asar: true,
      appVersion: '0.1.0',
      buildVersion: '6.0.4',
    });
  });

  it('does not partially change packager configuration for an invalid version', () => {
    const config: ForgeConfig = { packagerConfig: { name: 'Example' } };
    expect(() =>
      configureMacBundleVersions(config, 'darwin', () => '0.1.0-beta.30'),
    ).toThrow('Unsupported macOS bundle version');
    expect(config.packagerConfig).toEqual({ name: 'Example' });
  });
});

describe('packaged macOS plist validation', () => {
  const output = path.join('out', 'PrintFarmer Desktop-darwin-universal');
  const app = path.join(output, 'PrintFarmer Desktop.app');
  const helper = path.join(
    app,
    'Contents',
    'Frameworks',
    'PrintFarmer Desktop Helper.app',
  );
  const gpu = path.join(
    app,
    'Contents',
    'Frameworks',
    'PrintFarmer Desktop Helper (GPU).app',
  );

  it('finds only helper application directories in the packaged framework', () => {
    const readDirectory = vi.fn(() => [
      { name: 'Electron Framework.framework', isDirectory: () => true },
      { name: 'PrintFarmer Desktop Helper (GPU).app', isDirectory: () => true },
      { name: 'PrintFarmer Desktop Helper.app', isDirectory: () => true },
      { name: 'PrintFarmer Desktop Helper Fake.app', isDirectory: () => false },
    ]);
    expect(macHelperAppPaths(app, readDirectory)).toEqual([gpu, helper]);
    expect(readDirectory).toHaveBeenCalledWith(
      path.join(app, 'Contents', 'Frameworks'),
    );
  });

  it('checks both fields on the main app and every helper', () => {
    const readPlistValueImplementation = vi.fn((_: string, key: string) =>
      key === 'CFBundleVersion' ? '6.0.4' : '0.1.0',
    );
    verifyMacBundleVersions([output], '0.1.0-beta.6', {
      listHelpersImplementation: () => [helper, gpu],
      readPlistValueImplementation,
    });
    for (const bundle of [app, helper, gpu]) {
      const plist = path.join(bundle, 'Contents', 'Info.plist');
      expect(readPlistValueImplementation).toHaveBeenCalledWith(
        plist,
        'CFBundleShortVersionString',
      );
      expect(readPlistValueImplementation).toHaveBeenCalledWith(
        plist,
        'CFBundleVersion',
      );
    }
    expect(readPlistValueImplementation).toHaveBeenCalledTimes(6);
  });

  it.each(['CFBundleShortVersionString', 'CFBundleVersion'])(
    'fails closed when a helper has an incorrect %s',
    (badKey) => {
      expect(() =>
        verifyMacBundleVersions([output], '0.1.0-beta.6', {
          listHelpersImplementation: () => [helper],
          readPlistValueImplementation: (plist, key) => {
            if (plist.startsWith(helper) && key === badKey) return 'wrong';
            return key === 'CFBundleVersion' ? '6.0.4' : '0.1.0';
          },
        }),
      ).toThrow(`${badKey} is "wrong"`);
    },
  );

  it('rejects missing output and missing helpers', () => {
    expect(() => verifyMacBundleVersions([], '0.1.0')).toThrow(
      'No packaged macOS application',
    );
    expect(() =>
      verifyMacBundleVersions([output], '0.1.0', {
        listHelpersImplementation: () => [],
      }),
    ).toThrow('No packaged macOS helper applications');
  });

  it('propagates failures to read a packaged plist', () => {
    expect(() =>
      verifyMacBundleVersions([output], '0.1.0', {
        listHelpersImplementation: () => [helper],
        readPlistValueImplementation: () => {
          throw new Error('missing plist');
        },
      }),
    ).toThrow('missing plist');
  });
});
