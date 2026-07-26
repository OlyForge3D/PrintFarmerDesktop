// @vitest-environment node

/**
 * Runtime tamper / load-integrity fuses in `forge.config.ts` — #21 slice 4.
 *
 * SCOPE NOTE. #21 asks for "update-signature tests". PrintFarmer Desktop has no
 * auto-updater: there is no `electron-updater`/`autoUpdater` dependency or code,
 * so there is no update artifact to verify a signature over. That gap — code
 * signing and update-artifact verification — needs signing certificates and is
 * dispositioned out of this epic in `docs/security/THREAT_MODEL.md`, tracked by
 * #22. These tests therefore pin the integrity control that DOES exist: the
 * Electron fuses that lock the packaged runtime. They are NOT a substitute for
 * update signing; they are the adjacent, currently unproven control
 * (`packaging.test.ts` asserts icons and installers but never the fuses, so any
 * of them could be flipped and CI would stay green). SCOPE: these assert the
 * fuse values declared in `forge.config.ts` (build-time config), not that the
 * shipped binary was actually built with them — there is no launch-time tamper
 * check, and verifying the packaged artifact carries these fuses is also #22.
 *
 * Each fuse is asserted by its semantic `FuseV1Options` name rather than the
 * numeric key electron-forge stores it under, so reordering the config cannot
 * make an assertion silently target the wrong fuse. Non-vacuity (config axis):
 * flip any fuse in `forge.config.ts:97-102` and its row here turns RED. The two
 * ASAR fuses additionally trip the redundant pairing assertion below, so while
 * their `it.each` rows exist they are never sole-detected by it — but that
 * scope matters: delete an ASAR fuse's row (a silent edit) and the pairing
 * assertion becomes the *only* detector left for that fuse (measured; see its
 * comment below).
 */

import { describe, expect, it } from 'vitest';
import { FuseV1Options } from '@electron/fuses';
import forgeConfig from '../forge.config';

/** The fuse map electron-forge builds from the `new FusesPlugin({...})` call. */
function fuseConfig(): Record<number, unknown> {
  const plugins = forgeConfig.plugins ?? [];
  const fusesPlugin = plugins.find(
    (
      plugin,
    ): plugin is { name: string; fusesConfig: Record<number, unknown> } =>
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
    // Redundant-but-clearer diagnostic, not a vacuity guard: `fuseConfig()`
    // throws when no FusesPlugin is registered, so a dropped plugin already
    // turns every per-fuse row below RED on its own (measured: dropping the
    // plugin fails all 8 tests, none pass vacuously against `undefined`). This
    // row names that cause up front so the failure reads as "no fuses plugin"
    // rather than seven identical `fuseConfig` throws (the six `it.each` rows
    // plus the pairing test below, which also calls `fuseConfig()`).
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
    // Intent-documenting assertion AND the file's only cross-check. On the
    // config axis it is redundant: each of these two fuses has its own row in
    // the table above, so flipping either in `forge.config.ts` turns that row
    // AND this one RED together. On the test-file axis it is NOT redundant — it
    // is the sole backstop (measured: delete the fuse-4 or fuse-5 `it.each` row,
    // a completely silent edit, then flip that fuse, and only "pairs ASAR…"
    // goes RED). That is not true of the other four fuses, which have no
    // cross-check at all: delete their row and flip them and the suite stays
    // GREEN. So do not read "redundant" as "safe to delete" — deleting this
    // assertion drops fuses 4 and 5 to that same zero-backup state. Its value is
    // naming the invariant in one place — validating the embedded ASAR hash is
    // meaningless if the runtime still loads app code from outside it, and
    // refusing off-ASAR code is meaningless if the ASAR itself is unvalidated.
    const fuses = fuseConfig();
    expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(
      true,
    );
    expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
  });
});
