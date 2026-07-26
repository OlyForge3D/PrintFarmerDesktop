// @vitest-environment node

/**
 * Runtime tamper / load-integrity fuses in `forge.config.ts` — #21 slice 4.
 *
 * SCOPE NOTE. #21 asks for "update-signature tests". PrintFarmer Desktop has no
 * auto-updater: there is no `electron-updater`/`autoUpdater` dependency or code,
 * so there is no update artifact to verify a signature over. That gap — code
 * signing and update-artifact verification — needs signing certificates and is
 * dispositioned out of this epic in `docs/security/THREAT_MODEL.md`, tracked by
 * #22. These tests therefore pin the integrity control that DOES exist in the
 * shipped binary: the Electron fuses that lock the packaged runtime. They are
 * NOT a substitute for update signing; they are the adjacent, currently
 * unproven control (`packaging.test.ts` asserts icons and installers but never
 * the fuses, so any of them could be flipped and CI would stay green).
 *
 * Each fuse is asserted by its semantic `FuseV1Options` name rather than the
 * numeric key electron-forge stores it under, so reordering the config cannot
 * make an assertion silently target the wrong fuse. Non-vacuity: flip any fuse
 * in `forge.config.ts:97-102` and exactly its row here turns RED.
 */

import { describe, expect, it } from 'vitest';
import { FuseV1Options } from '@electron/fuses';
import forgeConfig from '../forge.config';

/** The fuse map electron-forge builds from the `new FusesPlugin({...})` call. */
function fuseConfig(): Record<number, unknown> {
  const plugins = forgeConfig.plugins ?? [];
  const fusesPlugin = plugins.find(
    (plugin): plugin is { name: string; fusesConfig: Record<number, unknown> } =>
      typeof plugin === 'object' &&
      plugin !== null &&
      (plugin as { name?: unknown }).name === 'fuses' &&
      'fusesConfig' in plugin,
  );
  if (!fusesPlugin) {
    throw new Error('forge.config.ts registers no FusesPlugin');
  }
  return fusesPlugin.fusesConfig;
}

describe('packaged runtime fuses', () => {
  it('registers a fuses plugin at all (guards every assertion below)', () => {
    // If the plugin were dropped, reading `fusesConfig` would throw here rather
    // than letting the per-fuse tests pass vacuously against `undefined`.
    expect(() => fuseConfig()).not.toThrow();
  });

  it.each([
    // fuse                                        expected  why it matters
    [FuseV1Options.RunAsNode, false], // no ELECTRON_RUN_AS_NODE arbitrary-Node escape
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false], // no NODE_OPTIONS injection
    [FuseV1Options.EnableNodeCliInspectArguments, false], // no --inspect debugger attach
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true], // validate the ASAR hash
    [FuseV1Options.OnlyLoadAppFromAsar, true], // refuse to load app code off-ASAR
    [FuseV1Options.EnableCookieEncryption, true], // encrypt the cookie store at rest
  ])('fuse %s is set to %s', (fuse, expected) => {
    expect(fuseConfig()[fuse]).toBe(expected);
  });

  it('pairs ASAR integrity validation with only-load-from-ASAR', () => {
    // The two are only meaningful together: validating the embedded ASAR hash
    // does nothing if the runtime will still load app code from outside it, and
    // refusing off-ASAR code does nothing if the ASAR itself is unvalidated.
    // Asserting the pair prevents a future edit from keeping one while dropping
    // the other and reading as "still hardened".
    const fuses = fuseConfig();
    expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
  });
});
