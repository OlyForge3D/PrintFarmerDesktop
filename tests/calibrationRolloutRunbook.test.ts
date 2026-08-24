// @vitest-environment node

/**
 * Runbook/code parity for the calibration capability rollout (issue #161).
 *
 * All evidence is repository-local: no live PrintFarmer server, no Klipper
 * hardware. This test does not establish that a rollout happened — it
 * establishes that `docs/runbooks/calibration-rollout.md` still describes the
 * flags this repository actually defines.
 *
 * Three properties, each asserted separately, per
 * `.squad/decisions/inbox/ripley-doc-code-parity-vacuity.md`:
 *
 * 1. Symmetric diff — both directions, with a *distinct* diagnostic for each,
 *    so a failure names which side is wrong.
 * 2. Non-empty ground truth — the code-derived sets are asserted non-empty
 *    before any comparison. Symmetry defeats one side going empty; it does not
 *    defeat both. The code side is therefore resolved *dynamically*, by name,
 *    rather than statically imported: a renamed or restructured export yields
 *    an empty set and trips this guard with a readable message, instead of
 *    failing at import time with a stack trace about the test file.
 * 3. Observed failure in both directions — recorded in the PR, not here. It is
 *    evidence about the test as written at that commit and is not transferable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as ipc from '../src/shared/ipc';
import * as wire from '../src/main/calibrationWire';

const repoRoot = path.resolve(import.meta.dirname, '..');

const RUNBOOK_PATH = path.join(
  repoRoot,
  'docs',
  'runbooks',
  'calibration-rollout.md',
);

const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

/**
 * The eight stages of #57's required enablement order, as headings. Order is
 * part of the contract, so this is a sequence and not a set.
 */
const REQUIRED_STAGE_HEADINGS = [
  'Stage 1 — Migrations, permissions, contract versions and secure hubs/artifacts',
  'Stage 2 — Calibration printer context',
  'Stage 3 — Authoritative persistence, sync, photos and profile history',
  'Stage 4 — Production upstream-Orca worker path and artifact promotion',
  'Stage 5 — Idempotent calibration queue and shared safe dispatch',
  'Stage 6 — PFD transport and offline support',
  'Stage 7 — Workspace, job workflow, profile workflow and importer',
  'Stage 8 — Packaged cross-platform acceptance',
] as const;

/**
 * Resolves a Zod object's own property names by module export name, returning
 * `[]` — never throwing — when the export is missing or is no longer an object
 * schema. Returning empty is deliberate: it routes every structural failure
 * into the non-empty guard, which reports it in the vocabulary of this test.
 *
 * `.transform()` wraps the object in a `ZodEffects`, so the source schema is
 * unwrapped first.
 */
function shapeKeysOf(
  namespace: Record<string, unknown>,
  exportName: string,
): string[] {
  let schema: unknown = namespace[exportName];
  while (schema instanceof z.ZodEffects) {
    schema = (schema as z.ZodEffects<z.ZodTypeAny>).innerType();
  }
  if (!(schema instanceof z.ZodObject)) {
    return [];
  }
  const shape: unknown = (schema as z.ZodObject<z.ZodRawShape>).shape;
  if (typeof shape !== 'object' || shape === null) {
    return [];
  }
  return Object.keys(shape).sort();
}

/** The client-side flag vocabulary PFD's feature gate reasons about. */
function codeClientFlags(): string[] {
  return shapeKeysOf(ipc, 'CalibrationCapabilityFlags');
}

/**
 * The server-side switches an operator actually sets, as documented in the
 * runbook. Derived from `CALIBRATION_FLAG_SOURCES` — the single production
 * source of truth for the client→server flag mapping — rather than from
 * every `*Enabled` key on the raw wire schema. The schema still declares
 * some historical switches (`calibrationPersistenceEnabled`,
 * `calibrationSyncEnabled`) for strict validation of legacy fields, but the
 * runbook must only document the switches PFD actually reads today. Reading
 * every `*Enabled` key would demand the runbook keep documenting the flags
 * PFD deliberately does not consume, and would drift back into the wrong
 * vocabulary the 2026-08-21 fix corrected.
 */
function codeServerSwitches(): string[] {
  const map = wire.CALIBRATION_FLAG_SOURCES;
  return [...new Set(Object.values(map) as string[])].sort();
}

/** Every backticked token on the runbook's per-stage capability-flag lines. */
function runbookStageFlags(): string[] {
  const lines = runbook
    .split('\n')
    .filter((line) => line.includes('**Capability flags:**'));
  const flags = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1];
      if (token !== undefined) {
        flags.add(token);
      }
    }
  }
  return [...flags].sort();
}

/**
 * The runbook's flag-vocabulary table, as `[clientFlag, serverSwitch]` pairs.
 * Only rows whose first two cells are each a single backticked token are
 * taken, which excludes the header and separator rows without matching on
 * their text.
 */
function runbookMappingRows(): { client: string; server: string }[] {
  const rows: { client: string; server: string }[] = [];
  for (const line of runbook.split('\n')) {
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    const [firstCell, secondCell] = cells;
    if (firstCell === undefined || secondCell === undefined) {
      continue;
    }
    const client = /^`([^`]+)`$/.exec(firstCell);
    const server = /^`([^`]+)`$/.exec(secondCell);
    const clientName = client?.[1];
    const serverName = server?.[1];
    if (clientName !== undefined && serverName !== undefined) {
      rows.push({ client: clientName, server: serverName });
    }
  }
  return rows;
}

function missing(expected: string[], actual: string[]): string[] {
  const have = new Set(actual);
  return expected.filter((name) => !have.has(name));
}

describe('calibration rollout runbook — ground truth is non-empty', () => {
  // Property 2. These run first and are asserted on their own, because every
  // comparison below is vacuous if either side can silently become empty.
  it('resolves at least one client capability flag from src/shared/ipc.ts', () => {
    expect(
      codeClientFlags(),
      'CalibrationCapabilityFlags resolved to no properties. The export was ' +
        'renamed, is no longer a Zod object, or its shape moved. Every parity ' +
        'assertion in this file is vacuous until this is fixed — do not ' +
        'delete this test to make the suite green.',
    ).not.toHaveLength(0);
  });

  it('resolves at least one server capability switch from src/main/calibrationWire.ts', () => {
    expect(
      codeServerSwitches(),
      'RemoteCalibrationCapabilities resolved to no *Enabled properties. The ' +
        'export was renamed, is no longer a Zod object under its transform, ' +
        'or the switch naming convention changed. The mapping-table ' +
        'assertion is vacuous until this is fixed.',
    ).not.toHaveLength(0);
  });

  it('reads at least one mapping row out of the runbook', () => {
    expect(
      runbookMappingRows(),
      'The runbook flag-vocabulary table produced no rows. Its shape changed ' +
        'and the extractor no longer matches it.',
    ).not.toHaveLength(0);
  });
});

describe('calibration rollout runbook — stage flags match the code', () => {
  // Property 1, direction A: code -> doc.
  it('documents every capability flag defined in CalibrationCapabilityFlags', () => {
    const undocumented = missing(codeClientFlags(), runbookStageFlags());
    expect(
      undocumented,
      `Capability flags exist in src/shared/ipc.ts but no rollout stage in ` +
        `${path.relative(repoRoot, RUNBOOK_PATH)} names them: ` +
        `${undocumented.join(', ')}. A flag nobody can find in the runbook is ` +
        `a flag that will be enabled out of order.`,
    ).toEqual([]);
  });

  // Property 1, direction B: doc -> code. Distinct diagnostic on purpose —
  // "the runbook invented a flag" and "the runbook forgot a flag" are
  // different defects with different fixes.
  it('names no capability flag that does not exist in CalibrationCapabilityFlags', () => {
    const invented = missing(runbookStageFlags(), codeClientFlags());
    expect(
      invented,
      `${path.relative(repoRoot, RUNBOOK_PATH)} names capability flags on a ` +
        `stage line that do not exist in CalibrationCapabilityFlags: ` +
        `${invented.join(', ')}. Either the flag was renamed in code, or the ` +
        `runbook describes a capability this build cannot negotiate.`,
    ).toEqual([]);
  });
});

describe('calibration rollout runbook — the flag vocabulary table', () => {
  it('maps exactly the client flags the code defines', () => {
    const documented = [
      ...new Set(runbookMappingRows().map((row) => row.client)),
    ].sort();
    expect(
      documented,
      'The runbook flag-vocabulary table and CalibrationCapabilityFlags ' +
        'disagree about which client flags exist. The table is what tells an ' +
        'operator which switch to set, so a wrong row is an operational ' +
        'error, not a documentation one.',
    ).toEqual(codeClientFlags());
  });

  it('maps exactly the server switches the capabilities schema defines', () => {
    const documented = [
      ...new Set(runbookMappingRows().map((row) => row.server)),
    ].sort();
    expect(
      documented,
      'The runbook flag-vocabulary table and RemoteCalibrationCapabilities ' +
        'disagree about which server switches exist. Note this compares the ' +
        "runbook against PFD's model of the server, not the server — see " +
        'the closing section of the runbook and issue #138.',
    ).toEqual(codeServerSwitches());
  });

  it('records that offline draft and change feed share one server switch', () => {
    // The single fact in the runbook that changes what an operator can do:
    // there is no server state where one is on and the other is off. Both
    // gates are backed by `calibrationSyncEnabled` — the sync/change-feed
    // subsystem — so if the wire mapping ever separates them, this fails
    // and the runbook's stage 6 paragraph becomes wrong and must be
    // rewritten. `operatorFeatures.offlineWriteReplayEnabled` is a related
    // but distinct operator-features field, not the load-bearing bit here;
    // see `CALIBRATION_FLAG_SOURCES` and its docblock for why.
    const byClient = new Map(
      runbookMappingRows().map((row) => [row.client, row.server]),
    );
    expect(byClient.get('calibrationChangeFeedEnabled')).toBe(
      byClient.get('calibrationOfflineDraftEnabled'),
    );
  });
});

describe('calibration rollout runbook — the eight stages', () => {
  it('lists all eight stages in the order #57 requires', () => {
    const found = REQUIRED_STAGE_HEADINGS.map((heading) => ({
      heading,
      index: runbook.indexOf(`### ${heading}`),
    }));

    const absent = found.filter((entry) => entry.index < 0);
    expect(
      absent.map((entry) => entry.heading),
      'Rollout stage headings are missing from the runbook. The enablement ' +
        'order is the deliverable; a stage that is not a heading is a stage ' +
        'nobody will follow.',
    ).toEqual([]);

    const indices = found.map((entry) => entry.index);
    expect(
      indices,
      'The rollout stages appear in the runbook in the wrong order. #57 ' +
        'specifies the order as a requirement, not a suggestion.',
    ).toEqual([...indices].sort((a, b) => a - b));
  });

  it('gives every stage a capability-flag line, a precondition, a health signal and a rollback', () => {
    for (const heading of REQUIRED_STAGE_HEADINGS) {
      const start = runbook.indexOf(`### ${heading}`);
      const rest = runbook.slice(start + heading.length);
      const nextHeading = rest.search(/\n#{2,3} /);
      const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);

      for (const field of [
        '**Capability flags:**',
        '**Precondition:**',
        '**Health signal:**',
        '**Rollback:**',
      ]) {
        expect(
          section.includes(field),
          `"${heading}" has no ${field} entry. Every stage needs all four: ` +
            `what to enable, what must hold first, how to tell it worked, ` +
            `and how to undo it. A stage missing one of those is a stage ` +
            `nobody can safely start.`,
        ).toBe(true);
      }
    }
  });
});
