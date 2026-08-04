import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The #68 diamond-DAG blowup is quoted as a figure in four places. Twice it has
 * diverged: `.squad/skills/test-discipline/SKILL.md` carried the `m`-chain
 * subtotal as if it were the row total, and `docs/security/THREAT_MODEL.md`
 * carried the same wrong figure for longer. Both were found by a human reading
 * two documents side by side, months apart, and nothing would have found the
 * third.
 *
 * The defect is not that a number was wrong. It is that four renderings of one
 * measured quantity existed with **no control between them**, so agreement and
 * disagreement were equally invisible. This file supplies the control: it
 * rebuilds the fixture, walks it, and pins every documented rendering to the
 * computed value. A figure can now only diverge by failing CI.
 *
 * Deliberately not a scan for the numerals. `.squad/decisions.md` discusses
 * `32,767` as a *token* in a shared-token set, and a scanner that treated every
 * occurrence as a claim about the fixture would report that as a divergence. The
 * claims below are anchored on their prose and enumerated by hand, which is the
 * same choice `scripts/check-script-reachability.mjs` makes for the same reason:
 * an occurrence count cannot tell a claim from a mention.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** Levels in the fixture under discussion — `diamondDag(14)`. */
const LEVELS = 14;

/**
 * `tests/viewer.partTree.test.tsx:678`, rebuilt as an adjacency map: `m{i}`
 * reaches `m{i+1}` both directly and through `s{i}`.
 *
 * This is a second rendering of the fixture, which is the very hazard this file
 * exists to police, so `the fixture definition still has this shape` below pins
 * it to the source rather than trusting the copy.
 */
function diamondDagAdjacency(levels: number): ReadonlyMap<string, string[]> {
  const objects = new Map<string, string[]>();
  for (let i = 0; i <= levels; i += 1) {
    objects.set(`m${i}`, i < levels ? [`s${i}`, `m${i + 1}`] : []);
  }
  for (let i = 0; i < levels; i += 1) {
    objects.set(`s${i}`, [`m${i + 1}`]);
  }
  return objects;
}

interface Walk {
  readonly objects: number;
  readonly totalRows: number;
  readonly mChainRows: number;
  readonly sNodeRows: number;
  readonly pathsToTail: number;
}

/**
 * Walks with a **path-local** `seen` set — the pre-fix behaviour in
 * `partTreeModel.ts` that produced the blowup. The figures in the documents
 * describe that walk, not today's, so reproducing it is the point rather than a
 * regression risk.
 */
function walkPathLocal(levels: number): Walk {
  const objects = diamondDagAdjacency(levels);
  const tail = `m${levels}`;
  let totalRows = 0;
  let mChainRows = 0;
  let sNodeRows = 0;
  let pathsToTail = 0;

  const visit = (id: string, seen: ReadonlySet<string>): void => {
    if (seen.has(id)) return;
    totalRows += 1;
    if (id.startsWith('m')) mChainRows += 1;
    else sNodeRows += 1;
    if (id === tail) pathsToTail += 1;
    const next = new Set(seen);
    next.add(id);
    for (const child of objects.get(id) ?? []) visit(child, next);
  };
  visit('m0', new Set());

  return {
    objects: objects.size,
    totalRows,
    mChainRows,
    sNodeRows,
    pathsToTail,
  };
}

const WALK = walkPathLocal(LEVELS);

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Pulls the first grouped-or-plain integer that follows `anchor`. Returns
 * `null` when the anchor is absent, so a drifted anchor is distinguishable from
 * a figure that disagrees — the two need different repairs and a boolean cannot
 * carry the difference.
 */
export function figureAfter(
  source: string,
  anchor: string,
):
  { readonly found: false } | { readonly found: true; readonly value: number } {
  const at = source.indexOf(anchor);
  if (at < 0) return { found: false };
  const rest = source.slice(at + anchor.length);
  const match = /\d{1,3}(?:,\d{3})+|\d+/.exec(rest);
  if (!match) return { found: false };
  return { found: true, value: Number(match[0].replace(/,/g, '')) };
}

interface Claim {
  readonly file: string;
  readonly anchor: string;
  readonly quantity: keyof Walk;
  readonly note: string;
}

/**
 * Every place the repository states one of these quantities in prose. Adding a
 * fifth rendering without adding it here is not detected — that is the honest
 * boundary of this control, and it is why the entries carry the quantity they
 * claim rather than a bare number.
 */
const CLAIMS: readonly Claim[] = [
  {
    file: 'docs/security/THREAT_MODEL.md',
    anchor: 'a 29-node diamond DAG expanded to',
    quantity: 'totalRows',
    note: 'T2.2 — cites the blowup as the motivating example for superlinear output.',
  },
  {
    file: '.squad/skills/test-discipline/SKILL.md',
    anchor: 'A 29-node diamond DAG expanded to',
    quantity: 'totalRows',
    note: 'The coverage checklist for structures whose output is superlinear.',
  },
  {
    file: 'tests/viewer.partTree.test.tsx',
    anchor: 'With 14 levels that is 29 objects but 2^15-1 =',
    quantity: 'mChainRows',
    note: 'The fixture doc comment, which states the sub-quantity, not the total.',
  },
];

describe('the diamond-DAG figures quoted in prose match the fixture', () => {
  it('has a non-empty claim registry covering distinct files', () => {
    // Vacuous-pass guard. `it.each([])` registers no tests and the file still
    // exits 0, so emptying CLAIMS deletes the entire point of this suite while
    // leaving it green — which is the failure mode the suite is about, one
    // level up. Found by mutating the registry to empty and watching 8 tests
    // become 5 with no signal.
    expect(CLAIMS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(CLAIMS.map((claim) => claim.file)).size).toBe(CLAIMS.length);
    for (const claim of CLAIMS) {
      expect(claim.anchor.length).toBeGreaterThan(10);
    }
  });

  it('measures the fixture rather than restating it', () => {
    // The decomposition is the whole content of the disagreement: 32,767 is a
    // real quantity, it is simply not the one the prose claimed. Assert the
    // parts sum, so a walk that silently lost a branch cannot pass.
    expect(WALK.objects).toBe(29);
    expect(WALK.mChainRows + WALK.sNodeRows).toBe(WALK.totalRows);
    expect(WALK.totalRows).toBe(49_150);
    expect(WALK.mChainRows).toBe(32_767);
    expect(WALK.sNodeRows).toBe(16_383);

    // Paths *to the tail* is a fourth quantity that has been confused with the
    // third in review. Pinned so the distinction survives.
    expect(WALK.pathsToTail).toBe(16_384);
    expect(WALK.pathsToTail).not.toBe(WALK.mChainRows);
  });

  it('keeps the four quantities distinct, so a mix-up cannot pass', () => {
    const values = [
      WALK.totalRows,
      WALK.mChainRows,
      WALK.sNodeRows,
      WALK.pathsToTail,
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('every documented claim states the quantity it names', () => {
    // Counted inside the loop rather than registered with `it.each`. An empty
    // `it.each` silently registers no tests and the file still exits 0 — three
    // assertions vanish with no signal. Asserting the number *actually
    // verified*, in the same test that verifies it, is the only form that
    // cannot be satisfied by checking nothing.
    let checked = 0;
    for (const claim of CLAIMS) {
      const found = figureAfter(read(claim.file), claim.anchor);

      // Control, and the reason it is a separate assertion: an anchor that has
      // drifted returns the same "no mismatch" as a document that agrees.
      // Assert the claim was located before asserting anything about its value.
      expect(
        found.found,
        `anchor not found in ${claim.file}: ${JSON.stringify(claim.anchor)}. ` +
          'The prose moved; re-point the claim rather than deleting it.',
      ).toBe(true);
      if (!found.found) continue;

      expect(
        found.value,
        `${claim.file} claims ${claim.quantity}: ${claim.note}`,
      ).toBe(WALK[claim.quantity]);
      checked += 1;
    }

    expect(checked).toBe(CLAIMS.length);
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('reports a mismatch on a document carrying the wrong figure', () => {
    // Injected counterfactual, in the same shape as the real documents. Without
    // it, every assertion above is satisfied by an extractor that returns the
    // expected value unconditionally — and the corpus being correct is exactly
    // when that cannot be noticed.
    const wrong = 'in #68 a 29-node diamond DAG expanded to 32,767 rows';
    const extracted = figureAfter(wrong, 'a 29-node diamond DAG expanded to');
    expect(extracted).toEqual({ found: true, value: 32_767 });
    expect(extracted.found && extracted.value).not.toBe(WALK.totalRows);

    // And the historical defect specifically: the figure that was live on
    // trunk is the m-chain subtotal, so this control reproduces the exact
    // confusion rather than an arbitrary wrong number.
    expect(extracted.found && extracted.value).toBe(WALK.mChainRows);
  });

  it('reports a missing anchor as missing rather than as agreement', () => {
    expect(
      figureAfter(
        'a 29-node diamond DAG expanded to 49,150 rows',
        'no such anchor',
      ),
    ).toEqual({ found: false });
    expect(
      figureAfter(
        'a 29-node diamond DAG expanded to no digits here',
        'expanded to',
      ),
    ).toEqual({
      found: false,
    });
  });

  it('the fixture definition still has the shape this file rebuilds', () => {
    // The adjacency map above is a second rendering of the fixture, which is
    // the hazard this file polices. Pin it to the source: if the fixture's
    // child lists change, the copy is stale and the figures are about a shape
    // that no longer exists.
    const source = read('tests/viewer.partTree.test.tsx');
    expect(source).toContain('function diamondDag(');
    expect(source).toContain(
      'children: i < levels ? [`s${i}`, `m${i + 1}`] : []',
    );
    expect(source).toContain(
      'object(`s${i}`, `S${i}`, { children: [`m${i + 1}`] })',
    );

    // The levels the documented figures describe. `diamondDag` is called with
    // other values elsewhere; this pins that 14 is still among them.
    expect(source).toContain(`diamondDag(${LEVELS})`);
  });
});
