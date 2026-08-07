// Render a pull-request snapshot so that a stale read cannot pass as a live one.
//
// The defect (#496). A squad session relayed a PR snapshot in which every value
// was true, just not now: `state=OPEN`, `mergedAt=null`, `MERGEABLE/BEHIND`, 13
// contexts `COMPLETED/SUCCESS`. The PR had merged 2h18m earlier. The report was
// internally consistent, carried no error, and could not be distinguished from a
// live read BY READING IT. That is the same shape as a green run whose cause is
// ambiguous at the call site: the output is identical whether the instrument
// looked or not.
//
// What this refuses to be: an age threshold. The intuitive repair is "refuse to
// render an observation older than N seconds", and it is wrong because N is a
// magic number over a quantity that varies by orders of magnitude. `development`
// in this repo moved ~1.5 commits/minute while #496 was being investigated,
// while a PR's `state` can flip in under a second. No constant serves both, and
// a threshold that is wrong for one of them fails in the direction that renders.
//
// The correction: staleness is a property of the CLAIM, not of the object. One
// fetch of one PR yields both kinds at once —
//
//     "its merge commit lists 48 files"   durable, true forever
//     "it is open"                        volatile, expires in minutes
//
// so this classifies FIELDS, and renders a volatile field only when the
// observation carrying it was made inside the same action that is rendering it.
// That is a structural test — same fetch or not — with no number in it.
//
// The latch, which is why `merged` discriminates and `state` does not:
//
//     merged is volatile while false and durable once true.
//
// `state=closed` answers whether it is over, never how it ended. Measured by
// Ripley over the last 100 closed PRs in this repo: 92 merged, 8
// closed-and-unmerged (#463, #458, #444, #401, #396, #342, ...), and a
// closed-unmerged PR can reopen — so `closed` is volatile in both directions.
// `merged=true` is an event that has already happened and cannot un-happen, so
// every field whose value that event fixes inherits its durability. The rule is
// one-directional and carries no judgement: a stale `merged=true` is safe, a
// stale `open` never is.
//
// Refusals are emitted as refusals. A reporter that declines quietly is
// indistinguishable from one still working — the same absence-reads-as-success
// shape the whole file exists for. Every field present in a snapshot produces
// exactly one entry, so nothing is dropped on the floor.
//
// Measured while building this, and the reason the guard is worth having:
// `required_approving_review_count` on `development` is 0 and all 8 required
// contexts are automated jobs, so no gate reads a review, a comment, or a hold label
// (#480). A verdict relayed from a stale snapshot therefore has nothing
// downstream that would catch it.
//
// No shebang: this module is imported by tests/prSnapshotReport.test.ts, and
// vite's transform does not strip one the way node does.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * How each field's truth decays.
 *
 * `durable`  fixed at creation; no event changes it.
 * `volatile` can change at any moment, in either direction.
 * `latch`    volatile until the latching field is true, durable afterwards.
 *
 * A field absent from this table is REFUSED rather than guessed. An unknown
 * field is the one case where rendering is a coin flip, and the whole point of
 * the module is to not flip it.
 */
export const FIELD_CLASSES = {
  number: { kind: 'durable' },
  title: { kind: 'volatile' },
  state: { kind: 'volatile' },
  merged: { kind: 'latch', latchedBy: 'merged' },
  mergedAt: { kind: 'latch', latchedBy: 'merged' },
  mergeCommitSha: { kind: 'latch', latchedBy: 'merged' },
  changedFiles: { kind: 'latch', latchedBy: 'merged' },
  additions: { kind: 'latch', latchedBy: 'merged' },
  deletions: { kind: 'latch', latchedBy: 'merged' },
  headRefOid: { kind: 'volatile' },
  baseRefName: { kind: 'volatile' },
  mergeable: { kind: 'volatile' },
  mergeStateStatus: { kind: 'volatile' },
  reviewDecision: { kind: 'volatile' },
};

/**
 * Every outcome this reporter can emit.
 *
 * The test suite asserts that a fixture produces each one. An outcome that no
 * fixture reaches is a branch nobody has run, which is the same defect as an
 * uninvoked check: it cannot be told apart from one that always passes.
 */
export const OUTCOMES = [
  'durable',
  'fresh',
  'latched',
  'refused-stale',
  'refused-latch-open',
  'refused-unclassified',
];

/** Outcomes that withhold a value. */
export const REFUSALS = OUTCOMES.filter((outcome) =>
  outcome.startsWith('refused-'),
);

/**
 * Open an action. Volatile claims may only be rendered from a fetch stamped
 * with this token, which is what replaces the age threshold: the question is
 * "did I look, here, now", not "how long ago did someone look".
 */
export function beginAction(now = () => new Date().toISOString()) {
  return { id: randomUUID(), startedAt: now() };
}

/**
 * Take an observation inside an action.
 *
 * The action id is stamped by this function rather than supplied by the caller,
 * so a snapshot cannot be relabelled as current by whoever relays it.
 */
export function observe(
  fetchFields,
  action,
  now = () => new Date().toISOString(),
) {
  if (!action || typeof action.id !== 'string') {
    throw new Error('observe requires an action from beginAction()');
  }
  const fields = fetchFields();
  return { actionId: action.id, observedAt: now(), fields };
}

/**
 * Rebuild a snapshot that arrived from somewhere else — a message, a file, a
 * previous run. It deliberately gets no action id, so every volatile field in
 * it is refused. This is the constructor for the case the module exists for.
 */
export function relayedSnapshot({ observedAt, fields }) {
  return { actionId: null, observedAt: observedAt ?? null, fields };
}

/**
 * Classify one field of one snapshot.
 *
 * `sameAction` is passed in rather than recomputed so that the caller cannot
 * accidentally evaluate half the report against one action and half against
 * another.
 */
export function classifyField(field, snapshot, sameAction) {
  const spec = FIELD_CLASSES[field];
  if (!spec) {
    return {
      outcome: 'refused-unclassified',
      reason: `${field} is not in FIELD_CLASSES; its volatility is unknown and this will not guess`,
    };
  }

  if (spec.kind === 'durable') {
    return { outcome: 'durable', reason: 'fixed at creation' };
  }

  if (spec.kind === 'latch') {
    if (snapshot.fields[spec.latchedBy] === true) {
      return {
        outcome: 'latched',
        reason: `${spec.latchedBy}=true is an event that cannot un-happen`,
      };
    }
    if (sameAction) {
      return {
        outcome: 'fresh',
        reason: `${spec.latchedBy} is still open; observed in this action`,
      };
    }
    return {
      outcome: 'refused-latch-open',
      reason: `${spec.latchedBy} is not true, so this is volatile, and the observation is not from this action`,
    };
  }

  return sameAction
    ? { outcome: 'fresh', reason: 'observed in this action' }
    : {
        outcome: 'refused-stale',
        reason: 'volatile, and the observation is not from this action',
      };
}

/**
 * Build the report. Every field present in the snapshot yields exactly one
 * entry — a refusal is an entry, never an omission.
 */
export function report(snapshot, action) {
  const sameAction =
    Boolean(snapshot.actionId) &&
    Boolean(action?.id) &&
    snapshot.actionId === action.id;

  const entries = Object.keys(snapshot.fields).map((field) => {
    const { outcome, reason } = classifyField(field, snapshot, sameAction);
    const withheld = outcome.startsWith('refused-');
    return {
      field,
      outcome,
      reason,
      withheld,
      value: withheld ? null : snapshot.fields[field],
    };
  });

  return {
    observedAt: snapshot.observedAt,
    actionId: snapshot.actionId,
    sameAction,
    entries,
  };
}

/** Human-readable form. The observation stamp is on every report, always. */
export function renderLines(result) {
  const lines = [
    `[pr-snapshot] observed ${result.observedAt ?? 'UNKNOWN'} ` +
      `(${result.sameAction ? 'this action' : 'RELAYED — volatile claims withheld'})`,
  ];
  for (const entry of result.entries) {
    lines.push(
      entry.withheld
        ? `  REFUSED ${entry.field}: ${entry.reason}`
        : `  ${entry.field} = ${JSON.stringify(entry.value)}  [${entry.outcome}]`,
    );
  }
  return lines;
}

/** Read one PR through `gh`. Injected in tests; never exercised by them. */
export function ghFetcher(repo, number) {
  return () => {
    const raw = execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pr = JSON.parse(raw);
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: pr.merged,
      mergedAt: pr.merged_at,
      mergeCommitSha: pr.merge_commit_sha,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      headRefOid: pr.head?.sha,
      baseRefName: pr.base?.ref,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeable_state,
    };
  };
}

export function parseArgs(argv) {
  let repo = null;
  let number = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      repo = argv[index + 1] ?? null;
      index += 1;
    } else if (/^\d+$/.test(arg)) {
      number = arg;
    } else {
      throw new Error(`unrecognised argument: ${arg}`);
    }
  }
  if (!repo) throw new Error('--repo <owner/name> is required');
  if (!number) throw new Error('a pull request number is required');
  return { repo, number };
}

export function main(argv = process.argv.slice(2), out = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out.error(`[pr-snapshot] ${/** @type {Error} */ (error).message}`);
    out.error(
      '[pr-snapshot] usage: node scripts/pr-snapshot-report.mjs --repo <owner/name> <pr-number>',
    );
    return 2;
  }

  const action = beginAction();
  let snapshot;
  try {
    snapshot = observe(ghFetcher(options.repo, options.number), action);
  } catch (error) {
    out.error(
      `[pr-snapshot] could not fetch ${options.repo}#${options.number}: ${/** @type {Error} */ (error).message}`,
    );
    return 2;
  }

  const result = report(snapshot, action);
  for (const line of renderLines(result)) out.log(line);
  return result.entries.some((entry) => entry.withheld) ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
