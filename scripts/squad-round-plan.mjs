// Deterministic planning for one Ralph round: what changed, what is blocked,
// and what order to dispatch in.
//
// WHY THIS IS CODE AND NOT PROSE. Every rule here was previously a paragraph a
// model re-derived from scratch each round, and each re-derivation is an
// opportunity to derive it differently. Three of them are genuinely easy to get
// wrong by hand and produce a confident, well-formed, wrong answer:
//
//   PRIORITY INHERITANCE. A p2 that blocks a p0 is effectively a p0. Sorting by
//   the label alone dispatches leaves while the root blocker sits idle, and the
//   p0 can never start — priority inversion that stalls the board with every
//   individual decision looking correct.
//
//   TRANSITIVE UNBLOCK VALUE. "How many issues does this free" is a reachability
//   question over the `blocking` edges, not a count of direct children. Counting
//   direct children ranks a shallow-but-wide issue above the root of a deep
//   chain.
//
//   TRUNCATED LISTINGS. `gh issue list --limit 200` returning exactly 200 rows
//   is indistinguishable, in the output, from a board with exactly 200 issues.
//   The failure is silent and one-directional: the round plans confidently over
//   a prefix of the board and reports full accounting for it. So a listing at
//   its cap is an ERROR here, never a result — `assertCompleteListing` refuses
//   to return, rather than returning something a caller might use.
//
// The dependency source of truth is GitHub's NATIVE dependency graph. Prose
// markers ("blocked by #12") are an ADDITIONAL, weaker check: a claim that
// decays. Both were measured to disagree in both directions, so this module
// takes both and treats an issue as blocked when EITHER names a still-open
// blocker, and as unblocked only when both are clear. A closed blocker never
// blocks, from either source.
//
// No shebang: imported by tests/squadRoundPlan.test.ts.

import path from 'node:path';
import process from 'node:process';

export const ERR_TRUNCATED_LISTING = 'E_TRUNCATED_LISTING';
export const ERR_MALFORMED_RESPONSE = 'E_MALFORMED_RESPONSE';
export const ERR_DEPENDENCY_CYCLE = 'E_DEPENDENCY_CYCLE';

export const PRIORITY_ORDER = Object.freeze([
  'priority:p0',
  'priority:p1',
  'priority:p2',
  'priority:p3',
]);

/** Rank of an unrecognised or absent priority. Sorts after every real one. */
export const NO_PRIORITY_RANK = PRIORITY_ORDER.length;

export class RoundPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoundPlanError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Refuse a listing that may be a prefix of the board.
 *
 * Explicit over three separate signals because any one of them alone can be
 * absent: a `hasNextPage` the caller did not request, a row count equal to the
 * cap, or a caller that forgot to say what the cap was. The last is itself an
 * error — a completeness check with no cap cannot conclude anything, and
 * returning "looks complete" from it is the exact defect this guards.
 */
export function assertCompleteListing({ items, limit, hasNextPage, source }) {
  const where = source ?? 'listing';
  if (!Array.isArray(items)) {
    throw new RoundPlanError(
      ERR_MALFORMED_RESPONSE,
      `${where}: expected an array of items, received ${typeof items}`,
      { source: where },
    );
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RoundPlanError(
      ERR_MALFORMED_RESPONSE,
      `${where}: no usable page limit was supplied, so completeness cannot be decided`,
      { source: where, limit },
    );
  }
  if (hasNextPage === true) {
    throw new RoundPlanError(
      ERR_TRUNCATED_LISTING,
      `${where}: the API reports a further page; paginate before planning`,
      { source: where, received: items.length, limit },
    );
  }
  if (items.length >= limit) {
    throw new RoundPlanError(
      ERR_TRUNCATED_LISTING,
      `${where}: returned ${items.length} rows at a limit of ${limit}; ` +
        'a listing at its cap is indistinguishable from a truncated one',
      { source: where, received: items.length, limit },
    );
  }
  return items;
}

function requireNumber(value, field, source) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RoundPlanError(
      ERR_MALFORMED_RESPONSE,
      `${source}: ${field} is not a positive integer (received ${JSON.stringify(value)})`,
      { source, field, value },
    );
  }
  return parsed;
}

/**
 * Normalise raw issue rows: reject malformed ones loudly, collapse duplicates.
 *
 * Duplicates are real — the same issue arrives from a listing page and from a
 * dependency expansion in the same round. Collapsing keeps the LAST occurrence,
 * which is the more recently fetched one, and records the collapse so a caller
 * can report it rather than silently double-counting the issue in its buckets.
 */
export function normalizeIssues(rows, { source = 'issues' } = {}) {
  if (!Array.isArray(rows)) {
    throw new RoundPlanError(
      ERR_MALFORMED_RESPONSE,
      `${source}: expected an array, received ${typeof rows}`,
      { source },
    );
  }
  const byNumber = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new RoundPlanError(
        ERR_MALFORMED_RESPONSE,
        `${source}: an entry is not an object`,
        { source, row },
      );
    }
    const number = requireNumber(row.number, 'number', source);
    if (byNumber.has(number)) {
      duplicates.push(number);
    }
    byNumber.set(number, {
      number,
      state: String(row.state ?? 'open').toLowerCase(),
      title: typeof row.title === 'string' ? row.title : '',
      labels: [
        ...new Set((row.labels ?? []).map((label) => String(label))),
      ].sort(),
      assignees: [
        ...new Set((row.assignees ?? []).map((a) => String(a))),
      ].sort(),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    });
  }
  return {
    issues: [...byNumber.values()].sort((a, b) => a.number - b.number),
    duplicates: [...new Set(duplicates)].sort((a, b) => a - b),
  };
}

export function priorityRank(labels) {
  const index = PRIORITY_ORDER.findIndex((label) =>
    (labels ?? []).includes(label),
  );
  return index === -1 ? NO_PRIORITY_RANK : index;
}

/**
 * Build the dependency graph from the native `blocked_by` lists.
 *
 * Edges are deduplicated and self-edges dropped: an issue listed as blocking
 * itself is a data defect that would otherwise report as a cycle and take the
 * whole round down with it.
 */
export function buildDependencyGraph(
  dependencies,
  { source = 'dependencies' } = {},
) {
  if (
    dependencies === null ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    throw new RoundPlanError(
      ERR_MALFORMED_RESPONSE,
      `${source}: expected an object keyed by issue number`,
      { source },
    );
  }
  const blockedBy = new Map();
  const blocking = new Map();
  const states = new Map();

  for (const [key, entry] of Object.entries(dependencies)) {
    const number = requireNumber(key, 'issue key', source);
    if (!Array.isArray(entry)) {
      throw new RoundPlanError(
        ERR_MALFORMED_RESPONSE,
        `${source}: dependencies for #${number} is not an array`,
        { source, number },
      );
    }
    const seen = new Set();
    for (const blocker of entry) {
      if (blocker === null || typeof blocker !== 'object') {
        throw new RoundPlanError(
          ERR_MALFORMED_RESPONSE,
          `${source}: a blocker of #${number} is not an object`,
          { source, number },
        );
      }
      const blockerNumber = requireNumber(
        blocker.number,
        'blocker number',
        source,
      );
      if (blockerNumber === number || seen.has(blockerNumber)) {
        continue;
      }
      seen.add(blockerNumber);
      states.set(blockerNumber, String(blocker.state ?? 'open').toLowerCase());
      if (!blocking.has(blockerNumber)) blocking.set(blockerNumber, new Set());
      blocking.get(blockerNumber).add(number);
    }
    blockedBy.set(number, seen);
  }

  return { blockedBy, blocking, states };
}

/**
 * Cycles among OPEN issues, reported rather than thrown.
 *
 * A cycle is a board defect a human must break; a round that aborted on one
 * would stop reporting on the other ninety issues, so this returns the cycles
 * and lets the caller both dispatch around them and name them.
 */
export function findDependencyCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  const visit = (node) => {
    state.set(node, 'active');
    stack.push(node);
    for (const next of graph.blockedBy.get(node) ?? []) {
      if (state.get(next) === 'active') {
        const at = stack.indexOf(next);
        cycles.push(stack.slice(at).concat(next));
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const node of [...graph.blockedBy.keys()].sort((a, b) => a - b)) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}

/**
 * Open blockers of an issue, from the native graph and from prose markers.
 *
 * A CLOSED blocker never blocks, from either source — that is the clause that
 * turns a stale "blocked by #12" marker into a dispatchable issue the moment
 * #12 closes, without waiting for anyone to edit the text.
 */
export function openBlockers(number, { graph, issueStates, markers = {} }) {
  const stateOf = (candidate) =>
    String(
      issueStates?.get?.(candidate) ?? graph.states.get(candidate) ?? 'open',
    ).toLowerCase();

  const native = [...(graph.blockedBy.get(number) ?? [])].filter(
    (blocker) => stateOf(blocker) === 'open',
  );
  const prose = [...new Set((markers[number] ?? []).map(Number))].filter(
    (blocker) =>
      Number.isInteger(blocker) &&
      blocker !== number &&
      stateOf(blocker) === 'open',
  );

  return {
    native: native.sort((a, b) => a - b),
    prose: prose.sort((a, b) => a - b),
    all: [...new Set([...native, ...prose])].sort((a, b) => a - b),
  };
}

/**
 * How many currently-open issues an issue frees, transitively.
 *
 * Walks `blocking` outward with a visited set, so a cycle terminates rather
 * than recursing forever, and a diamond counts each freed issue once.
 */
export function transitiveUnblockValue(number, { graph, issueStates }) {
  const seen = new Set();
  const queue = [...(graph.blocking.get(number) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === number || seen.has(next)) continue;
    seen.add(next);
    for (const onward of graph.blocking.get(next) ?? []) {
      if (!seen.has(onward)) queue.push(onward);
    }
  }
  return [...seen].filter(
    (candidate) =>
      String(issueStates?.get?.(candidate) ?? 'open').toLowerCase() === 'open',
  ).length;
}

/**
 * Effective priority after inheritance: an issue is at least as urgent as the
 * most urgent OPEN issue it transitively unblocks.
 *
 * Computed over the transitive closure rather than direct edges, because a
 * two-hop chain into a p0 inverts just as thoroughly as a one-hop one.
 */
export function effectivePriority(number, { graph, issues }) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const own = priorityRank(byNumber.get(number)?.labels ?? []);

  const seen = new Set();
  const queue = [...(graph.blocking.get(number) ?? [])];
  let best = own;
  let inheritedFrom = null;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === number || seen.has(next)) continue;
    seen.add(next);
    const downstream = byNumber.get(next);
    if (downstream && String(downstream.state).toLowerCase() === 'open') {
      const rank = priorityRank(downstream.labels);
      if (rank < best) {
        best = rank;
        inheritedFrom = next;
      }
    }
    for (const onward of graph.blocking.get(next) ?? []) {
      if (!seen.has(onward)) queue.push(onward);
    }
  }

  return { rank: best, ownRank: own, inheritedFrom };
}

/**
 * The dispatch queue, in loop.md's order, with inheritance applied.
 *
 * Every tie-break is total: effective priority, then unblock value descending,
 * then oldest createdAt, then lowest number. A partial order here produces a
 * queue that differs between rounds over identical data, which is unauditable.
 */
export function orderQueue(candidates, { graph, issues, issueStates }) {
  const decorated = candidates.map((issue) => {
    const priority = effectivePriority(issue.number, { graph, issues });
    return {
      number: issue.number,
      title: issue.title,
      priorityRank: priority.rank,
      ownPriorityRank: priority.ownRank,
      inheritedFrom: priority.inheritedFrom,
      unblockValue: transitiveUnblockValue(issue.number, {
        graph,
        issueStates,
      }),
      createdAt: issue.createdAt,
    };
  });

  return decorated.sort((a, b) => {
    if (a.priorityRank !== b.priorityRank)
      return a.priorityRank - b.priorityRank;
    if (a.unblockValue !== b.unblockValue)
      return b.unblockValue - a.unblockValue;
    const aAt = Date.parse(a.createdAt ?? '') || Number.MAX_SAFE_INTEGER;
    const bAt = Date.parse(b.createdAt ?? '') || Number.MAX_SAFE_INTEGER;
    if (aAt !== bAt) return aAt - bAt;
    return a.number - b.number;
  });
}

/**
 * Compare this round's cheap listing against the stored snapshot.
 *
 * `changed` is decided on the comparison fields only. An item absent from the
 * previous snapshot is `added`, not `changed`, so a first round after a cache
 * loss reports honestly instead of claiming everything moved.
 */
export function diffSnapshot(previous, next) {
  const before = new Map(
    Object.entries(previous ?? {}).map(([key, value]) => [key, value]),
  );
  const after = new Map(
    Object.entries(next ?? {}).map(([key, value]) => [key, value]),
  );

  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];

  for (const [key, value] of after) {
    if (!before.has(key)) {
      added.push(key);
    } else if (JSON.stringify(before.get(key)) !== JSON.stringify(value)) {
      changed.push(key);
    } else {
      unchanged.push(key);
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
    removed: removed.sort(),
  };
}

/**
 * The whole round's actionable plan, compact enough to paste into a prompt.
 *
 * Deliberately omits titles longer than a line and every field a decision does
 * not read. The output is consumed by a model with a finite context; a plan
 * that reproduces the API payload has moved the cost rather than removed it.
 */
export function buildRoundPlan({
  issues,
  dependencies,
  markers = {},
  slots = { capacity: 5, active: 0 },
  reuse = { reuse: [], inspect: [] },
}) {
  const normalized = normalizeIssues(issues);
  const graph = buildDependencyGraph(dependencies);
  const issueStates = new Map(
    normalized.issues.map((issue) => [issue.number, issue.state]),
  );
  const cycles = findDependencyCycles(graph);

  const open = normalized.issues.filter((issue) => issue.state === 'open');
  const blocked = [];
  const ready = [];

  for (const issue of open) {
    const blockers = openBlockers(issue.number, {
      graph,
      issueStates,
      markers,
    });
    if (blockers.all.length > 0) {
      blocked.push({
        number: issue.number,
        blockers: blockers.all,
        sources: {
          native: blockers.native,
          prose: blockers.prose.filter((n) => !blockers.native.includes(n)),
        },
      });
    } else {
      ready.push(issue);
    }
  }

  const queue = orderQueue(ready, {
    graph,
    issues: normalized.issues,
    issueStates,
  });
  const free = Math.max(0, (slots.capacity ?? 5) - (slots.active ?? 0));

  return {
    openIssues: open.length,
    duplicatesCollapsed: normalized.duplicates,
    cycles,
    blocked,
    queue,
    dispatch: queue.slice(0, free).map((entry) => entry.number),
    slots: { capacity: slots.capacity ?? 5, active: slots.active ?? 0, free },
    cache: {
      reused: reuse.reuse.map((entry) => entry.number),
      reinspect: reuse.inspect.map((entry) => ({
        number: entry.number,
        why: entry.reason,
      })),
    },
    accounting: {
      open: open.length,
      blocked: blocked.length,
      ready: ready.length,
      balanced: blocked.length + ready.length === open.length,
    },
  };
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------ */

export function formatPlan(plan) {
  return JSON.stringify(plan, null, 2);
}

async function main() {
  const inputPath = process.argv
    .slice(2)
    .find((token) => !token.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: node scripts/squad-round-plan.mjs <round-input.json>\n' +
        '  input: { issues: [...], dependencies: {...}, markers: {...}, slots: {...} }\n',
    );
    return 2;
  }
  const { readFileSync } = await import('node:fs');
  const input = JSON.parse(readFileSync(path.resolve(inputPath), 'utf8'));
  process.stdout.write(`${formatPlan(buildRoundPlan(input))}\n`);
  return 0;
}

if (
  process.argv[1] &&
  path
    .resolve(process.argv[1])
    .endsWith(path.join('scripts', 'squad-round-plan.mjs'))
) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `squad-round-plan: ${error.code ?? 'E_FAILED'}: ${error.message}\n`,
      );
      process.exit(error.code === ERR_TRUNCATED_LISTING ? 3 : 2);
    });
}
