import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictResolutionsFor } from '../src/main/calibrationService.js';
import type {
  CalibrationConflictKind,
  CalibrationConflictResolution,
} from '@shared/ipc';

/**
 * The per-kind resolution policy exists twice (issue #304): TypeScript
 * advertises it in `conflictResolutionsFor`, Rust enforces it in
 * `CalibrationConflictKind::available_resolutions`. Nothing failed when they
 * diverged, because each side is individually self-consistent.
 *
 * This file does not contain a third copy of the policy, and that is the whole
 * design of it. A test that restated the expected table would agree with
 * whichever side happened to be edited to match it, and would need editing
 * itself on every legitimate policy change -- at which point it records the
 * editor's belief rather than the store's behaviour. **Both sides here are
 * derived: the TypeScript half by calling the real function, the Rust half by
 * parsing the real table out of `sync.rs`.** The assertion compares two
 * measurements, so it can only pass when the tables actually agree.
 *
 * Consequently this test has no opinion about whether the policy is *correct*.
 * If someone decides `outcomeSelection` should permit `manualFieldMerge`, they
 * change the Rust table and the TypeScript branch and this test goes green
 * again without being touched. It fails on divergence, never on policy.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
}

const SYNC_RS = 'native/model-core/src/sync.rs';
const CATALOG_RS = 'native/model-core/src/sqlite_catalog.rs';

/**
 * Rust variant names to the camelCase wire spellings. `#[serde(rename_all =
 * "camelCase")]` on both enums is what makes this mapping the identity in wire
 * terms rather than a policy statement -- it maps *spelling*, never which
 * resolution belongs to which kind. `StalePrinterSnapshot` is the one place the
 * two sides genuinely disagree on spelling: the TypeScript union says
 * `staleprinterSnapshot` (no capital P), so it is transcribed from the observed
 * TS type, not from what camelCase would predict.
 */
const KIND_SPELLING: ReadonlyMap<string, CalibrationConflictKind> = new Map([
  ['ProjectMetadata', 'projectMetadata'],
  ['StepOrdering', 'stepOrdering'],
  ['StepDraft', 'stepDraft'],
  ['OutcomeSelection', 'outcomeSelection'],
  ['StalePrinterSnapshot', 'staleprinterSnapshot'],
  ['DeletionVsLocalEdit', 'deletionVsLocalEdit'],
]);

const RESOLUTION_SPELLING: ReadonlyMap<string, CalibrationConflictResolution> =
  new Map([
    ['AcceptServer', 'acceptServer'],
    ['KeepLocalAsNewRevision', 'keepLocalAsNewRevision'],
    ['ManualFieldMerge', 'manualFieldMerge'],
  ]);

/**
 * Extracts `available_resolutions`' match arms from the Rust source.
 *
 * Parsing source text is the weak link in any cross-language check, so the
 * failure mode is chosen deliberately: every step below throws with a specific
 * message rather than returning an empty or partial map. A parser that quietly
 * finds nothing would make this suite pass on an empty comparison, which is the
 * `skipped`-counts-as-success shape the repo already bans elsewhere. The
 * "parsed every kind" assertion in the suite is the backstop for that.
 */
function parseRustPolicy(): Map<CalibrationConflictKind, Set<string>> {
  const source = readText(SYNC_RS);
  const fnIndex = source.indexOf('pub fn available_resolutions(');
  if (fnIndex === -1) {
    throw new Error(
      `${SYNC_RS}: available_resolutions no longer exists under that name; ` +
        'this parser is stale and would otherwise report a false parity.',
    );
  }
  const matchIndex = source.indexOf('match self {', fnIndex);
  if (matchIndex === -1) {
    throw new Error(
      `${SYNC_RS}: available_resolutions no longer dispatches on 'match self'.`,
    );
  }
  // The arms end where the function's closing brace does. Counting braces from
  // the match keeps this correct if arms are reordered or reformatted.
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', matchIndex); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`${SYNC_RS}: unbalanced braces in available_resolutions.`);
  }
  const body = source.slice(matchIndex, end);

  const policy = new Map<CalibrationConflictKind, Set<string>>();
  // `Self::A | Self::B => &[ ...resolutions... ],`
  const armPattern = /((?:Self::\w+\s*\|\s*)*Self::\w+)\s*=>\s*&\[([^\]]*)\]/g;
  for (const arm of body.matchAll(armPattern)) {
    // Both groups are non-optional in the pattern, but the regex types do not
    // express that. Failing loudly beats `?? ''`, which would parse to an empty
    // arm and report a false parity.
    const [, variantList, resolutionList] = arm;
    if (variantList === undefined || resolutionList === undefined) {
      throw new Error(`${SYNC_RS}: match arm did not yield both groups.`);
    }
    const variants = [...variantList.matchAll(/Self::(\w+)/g)].map(
      (match) => match[1] ?? '',
    );
    const resolutions = [
      ...resolutionList.matchAll(/CalibrationConflictResolutionKind::(\w+)/g),
    ].map((match) => match[1] ?? '');
    if (resolutions.length === 0 || resolutions.some((name) => name === '')) {
      throw new Error(
        `${SYNC_RS}: arm '${variantList}' parsed to an empty resolution list.`,
      );
    }
    if (variants.length === 0 || variants.some((name) => name === '')) {
      throw new Error(`${SYNC_RS}: arm '${variantList}' yielded no variant.`);
    }
    for (const variant of variants) {
      const kind = KIND_SPELLING.get(variant);
      if (!kind) {
        throw new Error(
          `${SYNC_RS}: unmapped conflict kind 'Self::${variant}'. A new kind ` +
            'was added to Rust; add its wire spelling here so it is compared ' +
            'rather than silently skipped.',
        );
      }
      const wire = resolutions.map((name) => {
        const spelled = RESOLUTION_SPELLING.get(name);
        if (!spelled) {
          throw new Error(
            `${SYNC_RS}: unmapped resolution 'CalibrationConflictResolutionKind::${name}'.`,
          );
        }
        return spelled;
      });
      policy.set(kind, new Set(wire));
    }
  }
  return policy;
}

/**
 * The TypeScript side answers `[]` unless the transport exposes a resolve
 * capability, so the comparison needs a transport that has one. This is the
 * capability predicate's real input, not a stub of the policy: what is being
 * measured is still `conflictResolutionsFor`'s own branch.
 *
 * Scope note, so this file is not read as covering more than it does: whether
 * the *real* `SidecarCalibrationAdapter` still satisfies that predicate is a
 * different question with a different failure mode -- an own property shadowing
 * the prototype makes the probe report absent while typecheck, lint and this
 * suite all stay green. That seam is owned by
 * `tests/calibration.availability-negotiation.test.ts`, which probes the real
 * class. Duplicating it here would add a second copy of a check rather than a
 * second check.
 */
const CAPABLE_TRANSPORT = { resolveCalibrationConflict: () => undefined };

describe('calibration resolution policy: TypeScript vs Rust', () => {
  const rustPolicy = parseRustPolicy();

  it('parses every conflict kind out of the Rust table', () => {
    // Guards the parser itself. Without this, a regex that matched nothing
    // would make every parity assertion below vacuously true.
    expect([...rustPolicy.keys()].sort()).toEqual(
      [...KIND_SPELLING.values()].sort(),
    );
  });

  it.each([...KIND_SPELLING.values()])(
    'advertises exactly what the store enforces for %s',
    (kind) => {
      const enforced = rustPolicy.get(kind);
      expect(enforced, `no Rust arm covers ${kind}`).toBeDefined();
      const advertised = new Set(
        conflictResolutionsFor(CAPABLE_TRANSPORT, kind),
      );

      // Both directions are named separately because they fail differently and
      // the asymmetry is the reason issue #304 exists. Over-advertising offers
      // the user a button the store rejects; under-advertising hides a
      // permitted resolution with no error, no log line and no bug report.
      const overAdvertised = [...advertised].filter(
        (resolution) => !enforced?.has(resolution),
      );
      const underAdvertised = [...(enforced ?? [])].filter(
        (resolution) =>
          !advertised.has(resolution as CalibrationConflictResolution),
      );

      expect(
        overAdvertised,
        `${kind}: the renderer offers resolutions the store rejects — the ` +
          `user gets a button that errors. Fix ${SYNC_RS} or calibrationService.ts.`,
      ).toEqual([]);
      expect(
        underAdvertised,
        `${kind}: the store permits resolutions the renderer never offers — ` +
          'this direction is silent, which is why a test has to say it.',
      ).toEqual([]);
    },
  );

  it('keeps the store as the enforcing side', () => {
    // Parity is only worth asserting while Rust actually rejects. If this call
    // site disappears, the tables could agree while nothing enforced either,
    // and every assertion above would still pass.
    expect(readText(CATALOG_RS)).toContain(
      'if !kind.available_resolutions().contains(&params.resolution)',
    );
  });

  it('still gates advertisement on the transport capability', () => {
    // conflictResolutionsFor returns [] with no resolve capability. If that
    // ever stopped being true, the parity above would be comparing the policy
    // branch against a table the build cannot execute.
    expect(conflictResolutionsFor({}, 'projectMetadata')).toEqual([]);
  });
});
