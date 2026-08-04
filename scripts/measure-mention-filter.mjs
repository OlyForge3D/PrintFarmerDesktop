// Tests two candidate mechanical discriminators for mention-vs-use in this repo's prose,
// against the enumeration step in `.squad/fact-checker/policy.md`.
//
// Why this exists. A cross-artifact enumeration greps for a figure and gets hits. Some of
// those hits are *renderings* (the file asserts the value) and some are *mentions* (the file
// quotes another artifact, often in order to withdraw or correct it). Counting hits instead
// of reading them therefore over-counts, and a retraction is the worst case: it necessarily
// contains the sentence it withdraws, so a grep for a refuted claim scores a hit on the
// document that refutes it.
//
// Candidate A - fenced code blocks. Proposed as a convention: quote withdrawn text inside
// ``` fences so it is separable. Measured below.
//
// Candidate B - the `_"..."_` span. Already in use across `.squad/` and `docs/` to mark
// text belonging to another artifact. Requires no new convention and applies retroactively.
//
// The output reports raw occurrences, occurrences after stripping fences, and occurrences
// after additionally stripping quotation spans, so the marginal contribution of each is
// visible separately. It also prints every occurrence the quotation filter removed, so the
// suppression can be checked by hand rather than trusted - that check is the point, and its
// result belongs in the audit trail, not in this file's comments.
//
// Run:  node scripts/measure-mention-filter.mjs
import { execFileSync } from 'node:child_process';

const FIGS = ['49,150', '32,767', '16,383', '16,384'];

const show = (rev, path) =>
  execFileSync('git', ['show', `${rev}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });

const stripFences = (s) => s.replace(/^```[\s\S]*?^```/gm, '');
const stripQuoted = (s) => s.replace(/_"[^"]*"_/g, '');

const countHits = (text, fig) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = text.indexOf(fig, i);
    if (j < 0) return n;
    n += 1;
    i = j + fig.length;
  }
};

const TARGETS = [
  [
    'origin/development',
    '.squad/decisions/inbox/ripley-false-outcome-invented-mechanism.md',
  ],
  [
    'origin/development',
    '.squad/decisions/inbox/ripley-falsifier-before-publishing.md',
  ],
  ['origin/development', '.squad/decisions/inbox/ripley-go-and-look.md'],
  ['origin/development', '.squad/decisions.md'],
  ['origin/development', '.squad/skills/test-discipline/SKILL.md'],
  ['origin/development', 'docs/security/THREAT_MODEL.md'],
  ['HEAD', '.squad/fact-checker/audit-trail.md'],
];

console.log(
  'file                                           fig       raw  -fence  -quoted',
);
console.log('-'.repeat(79));

let totalRaw = 0;
let afterFence = 0;
let afterQuote = 0;
const suppressed = [];

const missing = [];

for (const [rev, path] of TARGETS) {
  let text;
  try {
    text = show(rev, path);
  } catch {
    console.log(`  MISSING ${rev}:${path}`);
    missing.push(`${rev}:${path}`);
    continue;
  }
  const a = stripFences(text);
  const b = stripQuoted(a);

  text.split('\n').forEach((line, idx) => {
    const stripped = stripQuoted(line);
    for (const fig of FIGS) {
      const gone = countHits(line, fig) - countHits(stripped, fig);
      for (let k = 0; k < gone; k += 1) {
        suppressed.push(
          `${path.split('/').pop()}:${idx + 1}  ${fig}  ${line.trim().slice(0, 96)}`,
        );
      }
    }
  });

  for (const fig of FIGS) {
    const raw = countHits(text, fig);
    if (raw === 0) continue;
    totalRaw += raw;
    afterFence += countHits(a, fig);
    afterQuote += countHits(b, fig);
    const short = path
      .replace(/^\.squad\/decisions\/inbox\//, 'inbox/')
      .slice(0, 45);
    console.log(
      `${short.padEnd(46)} ${fig.padEnd(9)} ${String(raw).padStart(3)}  ${String(countHits(a, fig)).padStart(5)}  ${String(countHits(b, fig)).padStart(6)}`,
    );
  }
}

console.log('-'.repeat(79));
console.log(
  `occurrences   raw ${totalRaw}   after fences ${afterFence}   after quotation spans ${afterQuote}`,
);
console.log(
  `candidate A (fences)          suppressed ${totalRaw - afterFence}`,
);
console.log(
  `candidate B (quotation spans) suppressed ${afterFence - afterQuote}`,
);
console.log('\nevery occurrence candidate B removed, for checking by hand:');
for (const s of suppressed) console.log(`  ${s}`);

// Every row of this table is read from `origin/development`, so in any checkout without that
// ref -- a CI job, a fresh clone, a branch-only fetch -- the whole table is MISSING and the
// script previously still exited 0. A measurement instrument that cannot reach its inputs and
// reports success is the same defect this repository has now catalogued six times: the output
// is indistinguishable from a run that found nothing to report. The condition is announced in
// the exit status so a caller can tell the two apart without parsing prose.
if (missing.length > 0) {
  console.log(
    `\nINCOMPLETE: ${missing.length} of ${TARGETS.length} revisions could not be read.`,
  );
  console.log(
    'The figures above are a partial table. Fetch the missing revision and re-run:',
  );
  console.log('  git fetch origin development:refs/remotes/origin/development');
  process.exit(2);
}
