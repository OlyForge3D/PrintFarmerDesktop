// Checks that squad ownership labels on open issues are bidirectionally consistent, and — more
// importantly — reports how much of the board no squad selector can see at all.
//
// Why this exists. Ownership is carried by two labels that are supposed to move together: a base
// `squad` label and a member label `squad:<name>`. A scan written as `label:squad` silently drops
// every issue that carries only the member label, and a scan written as `label:squad:<name>`
// silently drops every issue that carries only the base. Neither scan errors on the issues it
// cannot see, so both report a clean, plausible, and short list. Twenty-two open issues were in
// the first blind spot when this file was written.
//
// The reconciliation that found those twenty-two had the same shape as the bug it found. It
// enumerated issues that already carried *some* squad label and checked those against each other,
// so its denominator was the labelled population rather than the board: it could only ever find
// disagreements among issues that were already visible, and by construction reported nothing
// about the fifty-seven open issues carrying no squad label at all — 46% of the board, unownable
// by any selector, base or member. It also drew its set from a stale snapshot and reported five
// closed issues as live findings. So this check fixes the denominator first and the agreement
// second: it enumerates every open issue, and treats "carries no squad label" as a reportable
// class rather than as absence of evidence.
//
// Classes, per open issue:
//   OWNED         base `squad` and exactly the member labels — consistent, nothing to do.
//   MISSING_BASE  `squad:<name>` without base `squad`  — invisible to a `label:squad` scan. FAILS.
//   ORPHAN_BASE   base `squad` without any member label — owned by nobody nameable. FAILS.
//   UNOWNED       neither label — invisible to every squad scan. Ratcheted, see below.
//
// UNOWNED is not failed outright, because it was 57 on the day this landed and a check that is
// red on arrival gets muted rather than fixed. It is ratcheted instead: the baseline is recorded
// below and the run fails if the count rises. Triage lowers the number and the baseline with it;
// nothing can quietly add to it.
//
// The control arm is the point. An instrument that reports zero inconsistencies is
// indistinguishable from one that cannot express an inconsistency, and "0 findings" was exactly
// the reading the blind scans produced. So each of the four classes is asserted producible from
// a synthetic input before any real issue is classified, and the PR filter is asserted to
// actually reject a PR-shaped record — if any control fails the run aborts with no verdict.
//
// Run:  node scripts/check-squad-label-consistency.mjs
import { execFileSync } from 'node:child_process';

const REPO = process.env.SQUAD_LABEL_REPO ?? 'OlyForge3D/PrintFarmerDesktop';

// Open issues carrying no squad label, measured 2026-08-05 over 123 open issues. Lower this as
// triage lands. Raising it requires saying so in a commit message.
const UNOWNED_BASELINE = 57;

const BASE = 'squad';
const MEMBER = /^squad:.+/;

// An issue is a PR in the issues API when it carries a `pull_request` key. Ownership labels are
// an issue-board concern, so PRs are out of scope; the filter is control-tested below because a
// filter that never fires is a filter nobody has checked.
const isIssue = (item) => item != null && item.pull_request == null;

const classify = (labels) => {
  const hasBase = labels.includes(BASE);
  const members = labels.filter((l) => MEMBER.test(l));
  if (hasBase && members.length) return { k: 'OWNED', d: members.join(' ') };
  if (!hasBase && members.length)
    return {
      k: 'MISSING_BASE',
      d: `${members.join(' ')} — no base \`${BASE}\``,
    };
  if (hasBase && !members.length)
    return { k: 'ORPHAN_BASE', d: `base \`${BASE}\` — no member owner` };
  return { k: 'UNOWNED', d: labels.length ? labels.join(' ') : '(no labels)' };
};

// --- control arm ---------------------------------------------------------------------------
// Synthetic inputs only: these prove what the predicate asks, independently of what the board
// happens to contain today. A live-data positive control cannot do that — if the board were
// clean, a data-driven control would have nothing to fire on and would pass by vacancy.
const controls = [
  [['squad', 'squad:hicks'], 'OWNED'],
  [['squad:hicks'], 'MISSING_BASE'],
  [['squad'], 'ORPHAN_BASE'],
  [['bug'], 'UNOWNED'],
  [[], 'UNOWNED'],
];

const failures = [];
for (const [labels, expected] of controls) {
  const got = classify(labels).k;
  console.log(
    `control: [${labels.join(',') || '∅'}] classifies ${got} (expect ${expected})`,
  );
  if (got !== expected)
    failures.push(
      `[${labels.join(',') || '∅'}] classified ${got}, expected ${expected}`,
    );
}

// The PR filter must reject something, or it is decoration.
const prAccepted = isIssue({ number: 1, pull_request: { url: 'x' } });
const issueAccepted = isIssue({ number: 2 });
console.log(
  `control: PR-shaped record accepted=${prAccepted} (expect false); issue accepted=${issueAccepted} (expect true)`,
);
if (prAccepted)
  failures.push('the pull_request filter did not reject a PR-shaped record');
if (!issueAccepted)
  failures.push('the pull_request filter rejected a plain issue');

if (failures.length) {
  for (const f of failures) console.error('CONTROL FAILED — ' + f);
  console.error('verdict withheld.');
  process.exit(2);
}

// --- the run -------------------------------------------------------------------------------
let raw;
try {
  raw = execFileSync(
    'gh',
    [
      'api',
      `repos/${REPO}/issues?state=open&per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {number, pull_request, labels: [.labels[].name]}',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (e) {
  // An unrunnable check must not report OK. Withhold, as the control arm does.
  console.error(
    'could not enumerate issues via `gh` — ' + (e.shortMessage ?? e.message),
  );
  console.error('verdict withheld.');
  process.exit(2);
}

const items = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const issues = items.filter(isIssue);

// A denominator of zero would make every class below read clean. That is the failure this file
// exists to prevent, so it is checked rather than assumed.
if (!issues.length) {
  console.error(
    'enumerated 0 open issues — the query cannot see the board. verdict withheld.',
  );
  process.exit(2);
}

const tally = { OWNED: 0, MISSING_BASE: 0, ORPHAN_BASE: 0, UNOWNED: 0 };
const bad = { MISSING_BASE: [], ORPHAN_BASE: [], UNOWNED: [] };
for (const it of issues.sort((a, b) => a.number - b.number)) {
  const r = classify(it.labels);
  tally[r.k] += 1;
  if (r.k !== 'OWNED') bad[r.k].push(`#${it.number}  ${r.d}`);
}

console.log(
  `\n${REPO}: ${issues.length} open issues (${items.length - issues.length} PRs excluded)\n`,
);
console.log(
  `OWNED ${tally.OWNED}   MISSING_BASE ${tally.MISSING_BASE}   ORPHAN_BASE ${tally.ORPHAN_BASE}   UNOWNED ${tally.UNOWNED} (baseline ${UNOWNED_BASELINE})`,
);

for (const k of ['MISSING_BASE', 'ORPHAN_BASE']) {
  if (!bad[k].length) continue;
  console.error(`\n${k}:`);
  for (const line of bad[k]) console.error('  ' + line);
}

const verdict = [];
if (tally.MISSING_BASE)
  verdict.push(
    `${tally.MISSING_BASE} issue(s) carry a member label without base \`${BASE}\` — add the base label`,
  );
if (tally.ORPHAN_BASE)
  verdict.push(
    `${tally.ORPHAN_BASE} issue(s) carry base \`${BASE}\` with no member owner — assign one`,
  );
if (tally.UNOWNED > UNOWNED_BASELINE)
  verdict.push(
    `UNOWNED rose to ${tally.UNOWNED} from a baseline of ${UNOWNED_BASELINE} — triage the new issues or move the baseline deliberately`,
  );

if (verdict.length) {
  console.error('\n' + verdict.map((v) => '- ' + v).join('\n'));
  process.exit(1);
}

console.log(
  `\nOK — squad labels agree in both directions; ${tally.UNOWNED} unowned issue(s) at or below baseline.`,
);
