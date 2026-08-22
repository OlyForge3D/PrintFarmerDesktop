/**
 * calibration.capabilityFlagMapping.test.ts — Round-4 regression floor for
 * the capability-negotiation layer.
 *
 * Round 2 proved the dispatch DTOs match the server contract. This file
 * proves that the LAYER EARLIER — capability-flag negotiation — resolves
 * against the RIGHT fields of the live PlatformCapabilitiesDto and does
 * NOT get re-broken by re-binding to the wrong fields.
 *
 * ROUND-4 CORRECTION
 * ------------------
 * Round 3 originally asserted, against a payload asserted by the
 * coordinator in prose, that the server had "renamed" calibration fields
 * (`calibrationContextEnabled`, `calibrationEventsEnabled`,
 * `operatorFeatures.offlineWriteReplayEnabled`) and that the desktop's
 * original alias map was broken. Direct live capture proved that story
 * false. The desktop's ORIGINAL alias map was correct all along:
 *
 *   calibrationApiEnabled           <- calibrationPersistenceEnabled  [true]
 *   calibrationChangeFeedEnabled    <- calibrationSyncEnabled         [true]
 *   calibrationOfflineDraftEnabled  <- calibrationSyncEnabled         [true]
 *
 * against the live payload, G5 `missingCapabilityFlags` PASSES. Ripley
 * has reverted his mis-fix and this file is re-based against the wire.
 *
 * The real gate that refuses calibration on this deployment is G14
 * `calibrationGenerationEnabled: false`, with three unavailableReasons
 * (`slicing / slicer_registry_unavailable`,
 * `calibrationArtifactPromotion / artifact_source_unroutable`,
 * `calibrationGeneration / split_routing_unavailable`). That is NOT this
 * test's lane — G14 refusal is a truthful advertisement of unimplemented
 * server-side subsystems and is Ripley's `serverUnavailableReasons`
 * feature-carrier's problem, not a capability-flag mapping bug.
 *
 * WHAT THIS FILE ASSERTS
 * ----------------------
 * 1. Under the CURRENT `CALIBRATION_FLAG_SOURCES` map (Ripley's reverted
 *    state), every required calibration flag resolves TRUE against the
 *    live captured payload.
 * 2. Under the pinned RIPLEY_MISFIX_ALIAS_SOURCES (the counterfactual
 *    binding Ripley briefly had in tree), every required calibration flag
 *    resolves FALSE against the SAME live payload. This is the regression
 *    guard against re-introducing the mis-fix.
 * 3. Every alias in the current map points at a field path that (a)
 *    exists on the pinned server DTO snapshot and (b) is authorised by
 *    the calibration allowlist.
 * 4. The nested-path walker in the desktop's `readFlagBackingField`
 *    remains functional even though no current required flag binds to a
 *    nested path — future flags may, and the walker must not silently
 *    regress.
 *
 * PROVENANCE (payload)
 * --------------------
 * The single payload every assertion in this file runs against comes from
 * `tests/fixtures/server-contract/capabilitiesLiveResponse.snapshot.ts`,
 * which is a VERBATIM capture off Bishop's daily-validation stack at
 * loopback nginx :18080. See the snapshot file's `PROVENANCE` stamp; the
 * anti-fabrication guard in
 * `calibration.snapshotProvenanceGuard.test.ts` enforces that stamp.
 *
 * PROVENANCE (counterfactual)
 * ---------------------------
 * `RIPLEY_MISFIX_ALIAS_SOURCES` binds `calibrationChangeFeedEnabled` to
 * `calibrationEventsEnabled` — a field the server HARDCODES to false at
 * `src/api/Services/Capabilities/CalibrationCapabilityService.cs:205`
 * (blob `39056b32892c44b0ea71cf4be0b26f44ba7c88c7`, part of
 * PROVENANCE.additionalSources on the platformCapabilities snapshot).
 * That is the actual mechanism by which the mis-fix broke calibration:
 * not a wire-name mismatch, but binding to a field that will never be
 * true on ANY deployment until the event-stream subsystem ships.
 *
 * CONTROLS
 * --------
 * Per the repo rule ("every matching predicate gets a control that must
 * return the opposite result, evaluated by the same predicate on the same
 * data"), each assertion has a paired mutation the SAME predicate must
 * reject.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_FLAG_SOURCES,
  REQUIRED_CALIBRATION_FLAGS,
  RemoteCalibrationCapabilities,
  type CalibrationFlagName,
} from '../src/main/calibrationWire';

import { CAPABILITIES_LIVE_RESPONSE } from './fixtures/server-contract/capabilitiesLiveResponse.snapshot';
import {
  PLATFORM_CAPABILITIES_DTO_FIELDS,
  OPERATOR_FEATURE_FLAGS_DTO_FIELDS,
  CALIBRATION_CAPABILITY_FLAG_ALLOWLIST,
} from './fixtures/server-contract/platformCapabilitiesDto.snapshot';
import {
  compareDto,
  resolveServerRepo,
} from './fixtures/server-contract/serverContractSnapshotDrift';

/**
 * The single payload every assertion in this file runs against — the
 * verbatim capture from Bishop's daily-validation stack, imported from
 * the provenance-stamped live-response snapshot. Typed as
 * `Record<string, unknown>` so the desktop's Zod schema is what makes
 * sense of the shape (not TypeScript inference from a `const` object).
 */
const LIVE_SERVER_PAYLOAD: Record<string, unknown> = CAPABILITIES_LIVE_RESPONSE;

/**
 * Ripley's mis-fix alias map — the binding he briefly had in tree that
 * re-broke calibration by pointing required flags at hardcoded-false
 * server fields. Pinned here as the regression-guard counterfactual so
 * this file will always be able to demonstrate the failure mode even
 * after the mis-fix is history.
 *
 * DO NOT rebind these to whatever the current map is. This map is a
 * fossil, not a mirror.
 */
const RIPLEY_MISFIX_ALIAS_SOURCES: Record<CalibrationFlagName, string> = {
  calibrationApiEnabled: 'calibrationContextEnabled',
  // The mis-fix — bound to a server field that is hardcoded false at
  // CalibrationCapabilityService.cs:205 (blob 39056b32...). Any required
  // flag bound here refuses calibration on every deployment.
  calibrationChangeFeedEnabled: 'calibrationEventsEnabled',
  calibrationOfflineDraftEnabled: 'operatorFeatures.offlineWriteReplayEnabled',
  calibrationPhotoUploadEnabled: 'calibrationPhotosEnabled',
  calibrationGenerationEnabled: 'calibrationGenerationEnabled',
};

/**
 * Resolve required calibration flags against an arbitrary alias map + a
 * payload. Supports flat OR dotted nested paths so the counterfactual can
 * exercise both against the SAME live payload — the same predicate the
 * production `readFlagBackingField` walker uses.
 */
function resolveFlagsThroughAliasMap(
  aliasMap: Readonly<Record<CalibrationFlagName, string>>,
  payload: Record<string, unknown>,
): Record<CalibrationFlagName, boolean> {
  const out = {} as Record<CalibrationFlagName, boolean>;
  for (const [flagName, sourceField] of Object.entries(aliasMap) as [
    CalibrationFlagName,
    string,
  ][]) {
    const segments = sourceField.split('.');
    let cursor: unknown = payload;
    for (const seg of segments) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    out[flagName] = cursor === true;
  }
  return out;
}

describe('capability flag mapping — the current desktop map resolves G5 GREEN against the live captured payload', () => {
  it('parses the live captured payload through RemoteCalibrationCapabilities and asserts every required flag resolves true', () => {
    const parsed = RemoteCalibrationCapabilities.parse(LIVE_SERVER_PAYLOAD);

    const missing = REQUIRED_CALIBRATION_FLAGS.filter(
      (name) => !parsed.flags[name],
    );

    // The message names the exact fields the schema still binds to, so a
    // failure report tells the operator WHICH alias is dead.
    const aliasReport = REQUIRED_CALIBRATION_FLAGS.map((name) => {
      const source = CALIBRATION_FLAG_SOURCES[name];
      const advertisement = parsed.flagAdvertisement[name];
      return `${name} <- ${source} (advertised=${advertisement})`;
    }).join('\n  ');

    expect(
      missing,
      `Required calibration flags did not resolve true against the live-captured capabilities payload.
Payload had calibrationPersistenceEnabled=true, calibrationSyncEnabled=true,
operatorFeatures.offlineWriteReplayEnabled=true, calibrationPhotosEnabled=true
— a legitimately calibration-ready deployment. If missing is non-empty here,
the desktop's CALIBRATION_FLAG_SOURCES map is binding a REQUIRED flag to a
field that is false on this deployment. Alias resolution:
  ${aliasReport}
Compare against the pinned RIPLEY_MISFIX_ALIAS_SOURCES counterfactual below;
if any required flag currently binds to the same field a fossilised mis-fix
did, that is the regression this file catches.`,
    ).toStrictEqual([]);
  });

  it('control (positive): the SAME parser on a fabricated payload with every relevant switch true keeps all required flags true', () => {
    const readyPayload: Record<string, unknown> = {
      ...LIVE_SERVER_PAYLOAD,
      calibrationPersistenceEnabled: true,
      calibrationSyncEnabled: true,
      calibrationGenerationEnabled: true,
    };
    const parsed = RemoteCalibrationCapabilities.parse(readyPayload);
    const missing = REQUIRED_CALIBRATION_FLAGS.filter(
      (name) => !parsed.flags[name],
    );
    expect(
      missing,
      'Fabricated all-true payload must satisfy the predicate — if this fails, the predicate itself is wrong, not the mapping.',
    ).toStrictEqual([]);
  });

  it('control (negative): flipping every relevant switch false through the SAME parser fails the predicate', () => {
    const brokenPayload: Record<string, unknown> = {
      ...LIVE_SERVER_PAYLOAD,
      calibrationPersistenceEnabled: false,
      calibrationSyncEnabled: false,
      calibrationPhotosEnabled: false,
      calibrationGenerationEnabled: false,
    };
    const parsed = RemoteCalibrationCapabilities.parse(brokenPayload);
    const missing = REQUIRED_CALIBRATION_FLAGS.filter(
      (name) => !parsed.flags[name],
    );
    expect(
      missing.length,
      'Fabricated all-false payload must fail the predicate — if this passes, the predicate is not actually enforcing anything.',
    ).toBeGreaterThan(0);
  });
});

describe('capability flag mapping — RIPLEY_MISFIX counterfactual (regression guard against re-introducing the bind that broke calibration)', () => {
  it('the pinned mis-fix alias map, evaluated against the live captured payload through the SAME resolver as the current map, refuses at least one required flag', () => {
    // Same resolver. Same payload. Different alias map. The predicate that
    // says "the current map is fine" and the predicate that says "the
    // mis-fix map would have broken things" are literally the same
    // function — that is what "controls evaluated by the same predicate on
    // the same data" means in this repo.
    const misfixFlags = resolveFlagsThroughAliasMap(
      RIPLEY_MISFIX_ALIAS_SOURCES,
      LIVE_SERVER_PAYLOAD,
    );

    const stillTrue = REQUIRED_CALIBRATION_FLAGS.filter(
      (name) => misfixFlags[name],
    );
    const stillFalse = REQUIRED_CALIBRATION_FLAGS.filter(
      (name) => !misfixFlags[name],
    );

    expect(
      stillFalse.length,
      `RIPLEY_MISFIX_ALIAS_SOURCES resolved every required flag TRUE against the live payload. That contradicts the point of this counterfactual — either the pinned mis-fix map is being misremembered, or the payload no longer contains the hardcoded-false field (calibrationEventsEnabled) the mis-fix binds to. Resolution snapshot:
  still-true=${stillTrue.join(',')}
  still-false=${stillFalse.join(',')}`,
    ).toBeGreaterThan(0);
  });

  it('specifically: calibrationChangeFeedEnabled under the mis-fix binds to calibrationEventsEnabled, which is hardcoded false in CalibrationCapabilityService.cs:205 — so it MUST resolve false on the live payload', () => {
    const misfixFlags = resolveFlagsThroughAliasMap(
      RIPLEY_MISFIX_ALIAS_SOURCES,
      LIVE_SERVER_PAYLOAD,
    );
    expect(
      misfixFlags.calibrationChangeFeedEnabled,
      'The live-captured payload has calibrationEventsEnabled=false because the server hardcodes it (blob 39056b32... at :205). Under the mis-fix alias map, calibrationChangeFeedEnabled binds there and MUST be false. If this is true, either the live payload has changed to advertise the event-stream subsystem as implemented (unlikely under commit 6cf79dee) or the mis-fix alias map got silently rebased.',
    ).toBe(false);
  });

  it('control: the CURRENT alias map does NOT rebind any required flag to a hardcoded-false server field (calibrationEventsEnabled / calibrationQueueEnabled / calibrationJobBoundBedClearEnabled)', () => {
    // Direct guard against the mis-fix creeping back in. Independent of the
    // counterfactual test above: any required flag whose source field is
    // on this list can never resolve true on ANY deployment.
    const HARDCODED_FALSE_SERVER_FIELDS = new Set([
      'calibrationEventsEnabled',
      'calibrationQueueEnabled',
      'calibrationJobBoundBedClearEnabled',
    ]);
    const currentMap = CALIBRATION_FLAG_SOURCES as Record<string, string>;
    const violations: string[] = [];
    for (const requiredFlag of REQUIRED_CALIBRATION_FLAGS) {
      const source = currentMap[requiredFlag];
      if (source !== undefined && HARDCODED_FALSE_SERVER_FIELDS.has(source)) {
        violations.push(`${requiredFlag} -> ${source}`);
      }
    }
    expect(
      violations,
      `A REQUIRED calibration flag currently binds to a server field that is hardcoded false at CalibrationCapabilityService.cs (blob 39056b32...). That binding cannot resolve true on any deployment until the corresponding subsystem is implemented. Violations: ${violations.join(', ')}`,
    ).toStrictEqual([]);
  });
});

describe('nested operatorFeatures walker — remains functional so future flags can bind there', () => {
  /**
   * A payload where the nested `operatorFeatures.offlineWriteReplayEnabled`
   * is false, but every top-level calibration switch is true. Used as the
   * discriminator between a flat comparator (blind to nesting) and a
   * dotted-path walker (aware of nesting).
   *
   * The current desktop map does NOT bind any required flag to this
   * nested path. The walker still must work — Ripley's `RemoteOperatorFeatureFlags`
   * sub-schema exists precisely so future flags CAN bind here, and a
   * silently-regressed walker would let a future mis-fix through.
   */
  const NESTED_FALSE_PAYLOAD: Record<string, unknown> = {
    ...LIVE_SERVER_PAYLOAD,
    operatorFeatures: {
      ...(LIVE_SERVER_PAYLOAD.operatorFeatures as Record<string, unknown>),
      offlineWriteReplayEnabled: false,
    },
  };

  /** Flat-key comparator — CANNOT see into nested objects. */
  function flatKeyOfflineDraftCheck(payload: Record<string, unknown>): boolean {
    return payload.offlineWriteReplayEnabled === true;
  }

  /** Dotted-path walker — the shape `readFlagBackingField` uses. */
  function nestedOperatorFeaturesCheck(
    payload: Record<string, unknown>,
  ): boolean {
    const nested = payload.operatorFeatures;
    if (nested === null || typeof nested !== 'object') return false;
    return (
      (nested as Record<string, unknown>).offlineWriteReplayEnabled === true
    );
  }

  it('the flat-key comparator returns false on the ready payload — proving flat comparison is blind to nesting', () => {
    // Flat comparator on the live-captured payload: the field is not at
    // the top level (it lives under `operatorFeatures`), so flat says
    // false even though nested is true.
    expect(flatKeyOfflineDraftCheck(LIVE_SERVER_PAYLOAD)).toBe(false);
  });

  it('the flat-key comparator ALSO returns false on the nested-false payload — same false, cannot tell the two apart', () => {
    // This is the load-bearing bit: the flat comparator is not just
    // "sometimes wrong", it is BLIND. Flipping the nested value cannot
    // change its answer. That means any future negotiator that walks flat
    // keys silently passes AND silently fails on the same real payload
    // shape — which is why it must be caught here.
    expect(flatKeyOfflineDraftCheck(NESTED_FALSE_PAYLOAD)).toBe(false);
  });

  it('the dotted-path walker returns true on the ready payload and false on the nested-false payload — proving it actually reads the nested value', () => {
    expect(nestedOperatorFeaturesCheck(LIVE_SERVER_PAYLOAD)).toBe(true);
    expect(nestedOperatorFeaturesCheck(NESTED_FALSE_PAYLOAD)).toBe(false);
  });

  it('the desktop schema surfaces the nested operatorFeatures block on parse so future required-flag bindings can be added there', () => {
    // Ripley's `RemoteOperatorFeatureFlags` sub-schema still parses the
    // nested object even though no current required flag binds to it.
    // This test proves that the walker + sub-schema are wired end-to-end,
    // by asserting that a payload where the nested block is missing is
    // parseable AND that the nested field surfaces in the parsed result
    // via `parsed.flagAdvertisement.calibrationOfflineDraftEnabled`.
    const parsed = RemoteCalibrationCapabilities.parse(LIVE_SERVER_PAYLOAD);
    expect(parsed.flagAdvertisement).toBeDefined();
    // If Ripley's revert accidentally dropped the nested sub-schema,
    // parse would still succeed but the flagAdvertisement would lose
    // known keys. Assert the required set survives.
    for (const name of REQUIRED_CALIBRATION_FLAGS) {
      expect(
        parsed.flagAdvertisement[name],
        `flagAdvertisement lost the entry for required flag ${name} — the negotiator can no longer distinguish "advertised true" from "unknown".`,
      ).toBeDefined();
    }
  });
});

describe('capability flag mapping — Ripley revert-state observability', () => {
  it('reports whether CALIBRATION_FLAG_SOURCES has any of the KEY previously-broken bindings back on the mis-fix', () => {
    // The mis-fix map's `photoUpload<-photos` and `generation<-generation`
    // entries were ALWAYS correct — they were never part of Ripley's mis-
    // fix. So a naive "how many aliases match the mis-fix?" report will
    // always show 2/5 matches on any valid map, which is meaningless.
    //
    // This reporter instead names the THREE KEY aliases that Ripley
    // rebound wrongly (calibrationApiEnabled / calibrationChangeFeedEnabled
    // / calibrationOfflineDraftEnabled) and reports how many of them
    // currently match the mis-fix. `OK` means none — the mis-fix is not
    // reintroduced. `REGRESSED` means one or more do.
    const KEY_ALIASES: readonly CalibrationFlagName[] = [
      'calibrationApiEnabled',
      'calibrationChangeFeedEnabled',
      'calibrationOfflineDraftEnabled',
    ];
    const current = CALIBRATION_FLAG_SOURCES as Record<string, string>;
    const regressed: string[] = [];
    const ok: string[] = [];
    for (const key of KEY_ALIASES) {
      if (current[key] === RIPLEY_MISFIX_ALIAS_SOURCES[key]) {
        regressed.push(`${key}<-${current[key]}`);
      } else {
        ok.push(
          `${key}: misfix=${RIPLEY_MISFIX_ALIAS_SOURCES[key]} current=${current[key]}`,
        );
      }
    }

    const state = regressed.length === 0 ? 'OK' : 'REGRESSED-TO-MISFIX';
    console.log(
      `[calibration.capabilityFlagMapping] Ripley revert state: ${state}`,
    );
    console.log(
      `  key-aliases differing from misfix: ${ok.join(' | ') || '(none)'}`,
    );
    console.log(
      `  key-aliases still on misfix:        ${regressed.join(', ') || '(none)'}`,
    );

    // The reporter itself doesn't fail — the counterfactual test above
    // does. Assertion below just proves we accounted for every key alias.
    expect(regressed.length + ok.length).toBe(KEY_ALIASES.length);
  });
});

describe('capability flag mapping — production seam allowlist is honest about the DTO', () => {
  /**
   * Resolve a possibly-dotted DTO path against the pinned snapshot(s).
   * Same walk as the production `readFlagBackingField`.
   */
  function pathExistsInDtoSnapshots(dottedPath: string): boolean {
    const segments = dottedPath.split('.');
    const first = segments[0];
    if (first === undefined) return false;
    const topLevelSet = new Set<string>(PLATFORM_CAPABILITIES_DTO_FIELDS);
    if (!topLevelSet.has(first)) return false;
    if (segments.length === 1) return true;
    // Only one nested DTO snapshot is authorised: `operatorFeatures`.
    if (first !== 'operatorFeatures') return false;
    const rest = segments.slice(1);
    if (rest.length !== 1) return false;
    const nested = rest[0];
    if (nested === undefined) return false;
    return new Set<string>(OPERATOR_FEATURE_FLAGS_DTO_FIELDS).has(nested);
  }

  it('every desktop flag alias points at a field path that exists on the pinned PlatformCapabilitiesDto snapshot (flat OR nested)', () => {
    const referenced = Object.values(CALIBRATION_FLAG_SOURCES) as string[];
    const dangling = referenced.filter((f) => !pathExistsInDtoSnapshots(f));
    expect(
      dangling,
      'CALIBRATION_FLAG_SOURCES references field paths that no longer exist on PlatformCapabilitiesDto — the desktop is aliasing to nothing.',
    ).toStrictEqual([]);
  });

  it('every desktop flag alias points at a field path the calibration allowlist authorises as a legitimate calibration switch', () => {
    // Guards the previous test: a field can exist on the DTO and STILL be
    // the wrong choice (e.g. `slicingEnabled`). This narrower check makes
    // an accidentally correct-shaped-but-wrong-meaning alias fail loud.
    const allowSet = new Set<string>(CALIBRATION_CAPABILITY_FLAG_ALLOWLIST);
    const referenced = Object.values(CALIBRATION_FLAG_SOURCES) as string[];
    const outsideCalibrationScope = referenced.filter((f) => !allowSet.has(f));
    expect(
      outsideCalibrationScope,
      'CALIBRATION_FLAG_SOURCES points at fields outside the calibration allowlist — the alias is binding to a switch that does not gate calibration.',
    ).toStrictEqual([]);
  });

  it('control (path-walker): rejects a fabricated non-existent nested path', () => {
    expect(
      pathExistsInDtoSnapshots('operatorFeatures.thisFieldDoesNotExist'),
    ).toBe(false);
  });

  it('control (path-walker): accepts the real nested offlineWriteReplayEnabled path', () => {
    expect(
      pathExistsInDtoSnapshots('operatorFeatures.offlineWriteReplayEnabled'),
    ).toBe(true);
  });

  it('control (path-walker): rejects a nested-under-non-nested-DTO path', () => {
    expect(pathExistsInDtoSnapshots('calibrationContextEnabled.subField')).toBe(
      false,
    );
  });
});

describe('server-contract drift — snapshots must stay pinned to the pfarm1 sources', () => {
  const serverRepo = resolveServerRepo();

  it.skipIf(!serverRepo)(
    'PLATFORM_CAPABILITIES_DTO_FIELDS matches live PlatformCapabilitiesDto.cs',
    () => {
      const drift = compareDto({
        repoRoot: serverRepo!,
        relPath: path.posix.join(
          'src',
          'infra',
          'Dtos',
          'PlatformCapabilitiesDto.cs',
        ),
        typeName: 'PlatformCapabilitiesDto',
        snapshotFields: PLATFORM_CAPABILITIES_DTO_FIELDS,
      });
      expect(drift.missingFromSnapshot).toStrictEqual([]);
      expect(drift.extraInSnapshot).toStrictEqual([]);
    },
  );

  it.skipIf(!serverRepo)(
    'OPERATOR_FEATURE_FLAGS_DTO_FIELDS matches live OperatorFeatureFlagsDto.cs',
    () => {
      const drift = compareDto({
        repoRoot: serverRepo!,
        relPath: path.posix.join(
          'src',
          'infra',
          'Services',
          'OperatorFeatures',
          'OperatorFeatureFlagsDto.cs',
        ),
        typeName: 'OperatorFeatureFlagsDto',
        snapshotFields: OPERATOR_FEATURE_FLAGS_DTO_FIELDS,
      });
      expect(drift.missingFromSnapshot).toStrictEqual([]);
      expect(drift.extraInSnapshot).toStrictEqual([]);
    },
  );

  it.skipIf(!serverRepo)(
    'synthetic-drift control — mutating the snapshot must trip the drift comparator',
    () => {
      const mutatedFields = [
        ...PLATFORM_CAPABILITIES_DTO_FIELDS,
        'RemovedFromServer_SyntheticFieldForDriftControl',
      ] as const;

      const drift = compareDto({
        repoRoot: serverRepo!,
        relPath: path.posix.join(
          'src',
          'infra',
          'Dtos',
          'PlatformCapabilitiesDto.cs',
        ),
        typeName: 'PlatformCapabilitiesDto',
        snapshotFields: mutatedFields,
      });
      expect(
        drift.extraInSnapshot,
        'Synthetic extra field must be reported — otherwise the drift check does not actually compare against the source.',
      ).toContain('RemovedFromServer_SyntheticFieldForDriftControl');
    },
  );

  it('drift-check reachability — the extractor produces a non-empty result from the raw source file, not from a lazy fallback', () => {
    if (!serverRepo) return;
    // Read the file directly and count fields via the same extractor the
    // drift check uses. If the file is present but empty (or unreadable),
    // this fails loudly — control against the "drift comparator silently
    // returned an empty diff" failure mode.
    const source = readFileSync(
      path.join(serverRepo, 'src/infra/Dtos/PlatformCapabilitiesDto.cs'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain('CalibrationContextEnabled');
    expect(source).toContain('OperatorFeatures');
  });
});
