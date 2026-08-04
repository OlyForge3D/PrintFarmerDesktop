/**
 * Measures the diamond-DAG row explosion from #68, so the figure that appears in
 * `docs/security/THREAT_MODEL.md`, `.squad/decisions.md` and
 * `.squad/skills/test-discipline/SKILL.md` can be re-derived instead of copied.
 *
 * Run it:  node scripts/measure-diamond-dag.mjs
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This file is a *model* of the pre-fix `flattenPartTree`, which makes it a
 * rendering like any other. It is not the authority for these numbers and must
 * not be cited as one. The authority is the shipped pre-fix implementation at
 * commit 741459dee50af3a0dd387253cfbf8b9ddc71315f, in
 * `src/renderer/library/partTreeModel.ts`. Three properties of that revision are
 * what this model reproduces, and each is checkable there directly:
 *
 *   1. one `rows.push` per visit, so rows are visits and not distinct nodes.
 *      There are three `rows.push` sites at that revision (:107, :134, :176).
 *      The first two are inside `pushObject` and mutually exclusive per
 *      invocation — the cycle-hit branch at :107 is followed by `return` at
 *      :126 — and the third emits a *plate* row, outside the object walk. The
 *      fixture calls `flatten({ objects, rootObjectIds, plates: [] })`, so the
 *      plate site never fires and the object walk is the whole row count.
 *   2. `const nextSeen = new Set(seen).add(objectId)` at :157 — the cycle guard
 *      is path-local, so a node reached by two paths is expanded twice;
 *   3. no `MAX_PART_TREE_ROWS` in that revision (0 occurrences; 4 at the fix,
 *      1c80bdb381), so the output is uncapped.
 *
 * PROVENANCE OF THIS MODEL'S TWO HALVES — read this before trusting it.
 *
 * The *graph* is transcribed from the fixture, so it comes from an artifact.
 * The *traversal rule* — items 1 to 3 above — originally came from a prose
 * description of the pre-fix walk, and only later from the blob. That matters:
 * a reconstruction and the thing reconstructed are not two renderings of one
 * quantity, so agreement between this model and any other model built from the
 * same description could never have detected an error in the description. Had
 * the prose been wrong, every figure below would have been internally
 * consistent, would have agreed with independently written walks, and would
 * have measured the wrong thing. Each item above is now cited to a line at
 * 741459de and is checkable with `git grep`. Verify there, not here.
 *
 * A derivation is only discharged when it terminates in an artifact that is not
 * itself a rendering. That artifact is 741459de, not this file. Agreement between
 * this model and the prose is therefore evidence about the model; disagreement
 * between either of them and 741459de is evidence about them.
 *
 * The fixture is `diamondDag` from `tests/viewer.partTree.test.tsx`, transcribed
 * rather than imported so this runs under plain `node` with no build step and no
 * test runner. If that fixture changes, this file is stale — check it there.
 */

/** Transcribed from `diamondDag` in `tests/viewer.partTree.test.tsx`. */
function diamondDag(levels) {
  const objects = [];
  for (let i = 0; i <= levels; i += 1) {
    objects.push({
      id: `m${i}`,
      children: i < levels ? [`s${i}`, `m${i + 1}`] : [],
    });
  }
  for (let i = 0; i < levels; i += 1) {
    objects.push({ id: `s${i}`, children: [`m${i + 1}`] });
  }
  return { objects, rootObjectIds: ['m0'] };
}

/**
 * The pre-fix walk: one row per visit, path-local `seen`, no cap.
 * Counts each population separately rather than deriving one by subtracting
 * the other — a sum consistent with a decomposition is not its derivation.
 */
function pathLocalWalk({ objects, rootObjectIds }) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  let total = 0;
  const perId = new Map();
  const stack = rootObjectIds.map((id) => ({ id, path: new Set() }));

  while (stack.length > 0) {
    const { id, path } = stack.pop();
    if (path.has(id)) continue;
    total += 1;
    perId.set(id, (perId.get(id) ?? 0) + 1);
    const next = new Set(path).add(id);
    for (const child of byId.get(id)?.children ?? []) {
      stack.push({ id: child, path: next });
    }
  }

  return { total, perId };
}

const LEVELS = 14;
const fixture = diamondDag(LEVELS);
const { total, perId } = pathLocalWalk(fixture);

let mRows = 0;
let sRows = 0;
for (const [id, count] of perId) {
  if (id.startsWith('m')) mRows += count;
  else sRows += count;
}
const tailPaths = perId.get(`m${LEVELS}`) ?? 0;

/**
 * Enumerates root-to-node paths as *sequences*, independently of the row walk above —
 * no row counter, distinctness by the path itself. This exists to settle which quantity
 * the phrase "paths through the `m` chain alone" names, a question on which this
 * repository has already recorded one false finding.
 */
function enumeratePaths({ objects, rootObjectIds }) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const paths = [];
  const stack = rootObjectIds.map((id) => [id]);
  while (stack.length > 0) {
    const path = stack.pop();
    paths.push(path);
    for (const child of byId.get(path[path.length - 1])?.children ?? []) {
      if (!path.includes(child)) stack.push([...path, child]);
    }
  }
  return paths;
}

const allPaths = enumeratePaths(fixture);
const pathsEndingAtM = allPaths.filter((p) =>
  p[p.length - 1].startsWith('m'),
).length;
const toTail = allPaths.filter((p) => p[p.length - 1] === `m${LEVELS}`);
const toTailViaS = toTail.filter((p) =>
  p.some((n) => n.startsWith('s')),
).length;

const results = [
  ['objects in fixture', fixture.objects.length, 29],
  ['TOTAL rows emitted', total, 49150],
  ['rows for m-chain nodes', mRows, 32767],
  ['rows for s nodes', sRows, 16383],
  ['distinct paths to tail', tailPaths, 16384],
  ['paths ending at an m node', pathsEndingAtM, 32767],
  ['...of paths to tail, via s', toTailViaS, 16383],
];

let ok = true;
for (const [label, actual, expected] of results) {
  const pass = actual === expected;
  if (!pass) ok = false;
  console.log(
    `${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(26)}: ${actual} (expected ${expected})`,
  );
}

console.log('');
console.log(
  '`2^15-1 = 32,767` is paths through the m chain summed over the chain, each',
);
console.log(
  `emitting one row — not the ${tailPaths} distinct paths to its tail, and not the`,
);
console.log(
  `${total} row total. The threat model's sentence claimed the total.`,
);
console.log('');
console.log(
  `Paths ending at an m node (${pathsEndingAtM}) equals the m-chain row count`,
);
console.log(
  '(%d): under a path-local `seen` set every row IS a distinct path, so 32,767',
  mRows,
);
console.log(
  `is both. And of the ${toTail.length} paths to the tail, ${toTailViaS} traverse an s node and`,
);
console.log(
  `${toTail.length - toTailViaS} stays in the m chain alone — so "alone" cannot name ${toTail.length}.`,
);

if (!ok) {
  console.error(
    '\nA figure moved. Check the fixture and 741459de before editing any prose.',
  );
  process.exitCode = 1;
}
