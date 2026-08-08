// Checks that every commit-SHA cited in the fact-checker's artifacts can be resolved by a
// *reader*, not merely by the author who wrote the citation.
//
// Why this exists. On a machine where several worktrees share one object database, every
// superseded head resolves forever for whoever created it. `git show <sha>` succeeds for the
// author and fails in a fresh clone, and there is no local symptom of the difference: the
// lookup does not error, hesitate, or warn. A pin orphaned by a rebase is therefore invisible
// from the position of the person responsible for it, which is the one position from which it
// is never checked. Two rebases and a sync merge on this branch orphaned sixteen pins that
// were the branch head, or an ancestor of it, at the moment each was written. The citations
// were correct when made and the history operation invalidated them afterwards.
//
// The reader model is deliberately conservative: a reader has the mainline and the branch under
// review, and nothing else. Anything not reachable from those two is treated as unreachable
// even if it happens to sit in some other namespace, because reaching it then requires a route
// the reader has to be told about. That is exactly what the declaration block supplies.
//
// A cited SHA passes if any of:
//   REACHABLE  reachable from the branch head or from the mainline - the reader just has it.
//   TWIN       the ledger *declares* a live twin for the pin, and that twin is itself reachable
//              from the reader's revisions. The pin names a revision that was rewritten, and the
//              rewritten copy carries the same change, so the citation is repairable by
//              substitution rather than lost.
//
//              This class is deliberately read from the repository rather than computed. An
//              earlier version discovered twins with `git patch-id --stable` over the cited
//              commit, which requires *having* that commit - so it returned TWIN 16 / exit 0 for
//              the author and TWIN 0 / ORPHAN 16 / exit 1 in a virgin clone, with both controls
//              passing in both runs. That is this file's own subject reproduced inside the tool
//              written to close it: the repair was computable only from the position that cannot
//              see the defect. Found by a reviewer who ran it in a fresh clone rather than
//              reading it. A twin is therefore evidence only when it is written down, because
//              only then can the reader check the same thing the author checked.
//
//              THOSE FOUR NUMBERS DESCRIBE THE SUPERSEDED VERSION AND DO NOT REPRODUCE HERE.
//              They are retained because they are the evidence for the design, and they have
//              since been quoted back at this file's author as a measurement of the shipped
//              version - so the current figure is stated beside them rather than left to be
//              inferred. Measured by cloning the mainline into an empty directory, confirming
//              `git cat-file -e` fails for a known orphan, and running this file unmodified:
//              REACHABLE 61 / TWIN 44 / DECLARED 17 / ORPHAN 0, exit 0, both controls firing.
//              The reader position and the author position now agree, which is the property the
//              rewrite was for. An undated number in a design note is read as a present-tense
//              measurement, and this file exists because pins decay - so its own prose must
//              carry the same anchor it demands of the ledger.
//   DECLARED   listed in the ledger's declaration block with a reason. Two reasons are valid:
//              the object's *absence* is the finding being recorded (run F is entirely about
//              commits that are not in this PR - demanding they be reachable would delete the
//              entry's subject), or a fetch route is documented at the citation site.
//
// Anything else is an ORPHAN and fails the run.
//
// The control arm matters more than the pass. An instrument that reports every SHA reachable
// is indistinguishable from one that cannot report anything else, and this file's whole subject
// is checks that return clean because they cannot see. So the run asserts both outcomes are
// producible: a SHA known present must classify REACHABLE, and a synthetic SHA known absent
// must classify ORPHAN. If either control fails the run aborts without reporting a verdict.
//
// Run:  node scripts/check-citation-reachability.mjs
import { execFileSync } from 'node:child_process';
import { isDocumentationPath } from './docs-only-change.mjs';
import {
  collectCitations,
  loadCorpus,
  refuse,
  requireCorpusFloor,
  requireScanRoots,
} from './citation-corpus.mjs';

const FILES = [
  '.squad/fact-checker/audit-trail.md',
  '.squad/fact-checker/policy.md',
];

const DECLARATION_HEADING =
  '## Citations whose object is not reachable from this repository';

const TWIN_HEADING = '## Superseded citations and their live twins';

const git = (args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

// A shallow clone truncates history, so `rev-list` cannot see commits that exist and are
// reachable in a complete one. Every ORPHAN this check reports would then be an artifact of
// the clone depth rather than a property of the citation -- measured on this repository, a
// `--depth 50` clone reported 47 orphans where a full clone of the same commit reported 36.
// The two runs are indistinguishable in their output, which is the same silent degradation
// this check exists to make impossible. Refuse the verdict instead of publishing a wrong one.
if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
  console.error(
    'INCONCLUSIVE: this is a shallow clone, so reachability cannot be decided here.',
  );
  console.error('Deepen the checkout and re-run:');
  console.error('  git fetch --unshallow');
  console.error('  actions/checkout@v4 with: { fetch-depth: 0 }');
  process.exit(2);
}

// A scan root that is absent or unreadable yields an empty corpus, and an empty corpus satisfies
// "every cited revision is reachable" vacuously. Measured on the shipping script: renaming
// `.squad/fact-checker/audit-trail.md` printed `OK` and exited 0 with REACHABLE 0 / TWIN 0 /
// DECLARED 0 / ORPHAN 0 -- while all four self-controls still passed, because the controls
// certify the classifier and never the corpus. That is this file's own subject again: a check
// that reports clean because it cannot see, in a second blind arm the shallow guard above does
// not cover. The roots below are hardcoded paths, so any `.squad/` rename, move or restructure
// disarms the check silently and nothing reports it. Read them once, here, and refuse the
// verdict rather than publish one about the empty set.
//
// The mechanism lives in citation-corpus.mjs so #421's cross-repository arm imports it rather
// than reimplementing it. The number stays here: that corpus is disjoint from this one.
const sources = requireScanRoots(loadCorpus(FILES));

// Revisions a reader is assumed to hold. `origin/development` may be absent in a shallow or
// branch-only checkout; the branch head alone still gives a usable, if stricter, answer.
const readerRevs = ['HEAD', 'origin/development'].filter((r) =>
  git(['rev-parse', '--verify', `${r}^{commit}`]),
);

const reachable = new Set(
  (git(['rev-list', ...readerRevs]) ?? '').split('\n').filter(Boolean),
);

// Not every citation is a revision. Blob identity is this ledger's own instrument for a claim
// about the contents of a file, and it is a *stronger* anchor than a commit: a rebase rewrites
// commits and leaves blobs untouched. An earlier version of this check resolved every backticked
// hex as `sha^{commit}` and so reported a blob citation as an orphan, which pushed authors away
// from the best anchor available to them. The object walk is deferred because it is only needed
// when a citation is not a commit, and it is memoised because it is the expensive call here.
let objectSet = null;
const reachableObjects = () => {
  if (objectSet) return objectSet;
  objectSet = new Set(
    (git(['rev-list', '--objects', ...readerRevs]) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[0]),
  );
  return objectSet;
};

// `git patch-id --stable` of a revision. Used only to *suggest* a twin for an undeclared orphan
// when the author happens to hold the object; it takes no part in the verdict, because it cannot
// be computed by a reader who does not have the orphaned commit. That asymmetry is the defect
// this class of citation is about, and it is not permitted to decide the result.
const patchIdOf = (rev) => {
  try {
    const show = execFileSync('git', ['show', rev], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    const out = execFileSync('git', ['patch-id', '--stable'], {
      input: show,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    return out.split(' ')[0] || null;
  } catch {
    return null;
  }
};

// The lines a revision contributed, keyed by path, with everything a rebase may legitimately
// change discarded: hunk offsets and context. Content is only collected after a `@@`, so a
// removed line that itself begins with `--` is never mistaken for a file header.
//
// `null` for a merge, deliberately. `git show` renders a merge as a *combined* diff whose rows
// carry one column per parent, so every line reads as doubly-prefixed and a single-column
// parser silently returns nonsense. Measured on `e5a90df7`, a merge declared in this ledger: it
// scored 0 of 41 lines against its own declared twin, which is the signature of an unrelated
// commit. A merge contributes no lines of its own; saying so is better than scoring it.
const addedLinesOf = (rev) => {
  const parents = git(['rev-list', '--parents', '-n', '1', rev]);
  if (parents === null) return null;
  if (parents.trim().split(/\s+/).length > 2) return null;

  const show = git(['show', rev, '--format=', '--unified=0', '--no-color']);
  if (show === null) return null;
  const lines = new Set();
  let file = null;
  let inHunks = false;
  for (const line of show.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = line;
      inHunks = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunks = true;
      continue;
    }
    if (inHunks && line.startsWith('+')) lines.add(`${file}\u0000${line}`);
  }
  return lines.size ? lines : null;
};

// Reads a `- `sha` — text` list under a heading, from any of the artifacts. The text comes from
// the preflight map rather than a fresh read, so a root that disappears mid-run cannot be
// swallowed here: there is exactly one place a scan root can fail, and it refuses.
const readBlock = (heading) => {
  const found = new Map();
  for (const text of sources.values()) {
    const at = text.indexOf(heading);
    if (at < 0) continue;
    const rest = text.slice(at + heading.length);
    const end = rest.indexOf('\n## ');
    const block = end < 0 ? rest : rest.slice(0, end);
    for (const m of block.matchAll(
      /`([0-9a-f]{7,40})`\s*[-\u2014:]\s*([^\n]+)/g,
    )) {
      found.set(m[1], m[2].trim());
    }
  }
  return found;
};

const declared = readBlock(DECLARATION_HEADING);

// Declared twins. The value carries prose; the twin is the first backticked revision in it.
const twins = new Map();
for (const [sha, note] of readBlock(TWIN_HEADING)) {
  const m = /`([0-9a-f]{7,40})`/.exec(note);
  if (m) twins.set(sha, m[1]);
}

// Cited SHAs. Only backticked tokens count: prose that happens to contain a hex-looking word is
// not a citation, and treating it as one manufactures findings.
const cited = collectCitations(sources);

// The verdict is computed from exactly two things a reader also has: what is reachable from the
// reader's revisions, and what the artifacts say. Local object presence is never consulted for a
// pass, so the author and the reader get the same answer.
const classify = (
  sha,
  { twinMap = twins, includeAuthoringHint = true } = {},
) => {
  const full = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (full && reachable.has(full)) return { k: 'REACHABLE', d: '' };

  // A non-commit object -- typically a blob pinning the contents of a file -- counts as reachable
  // when the reader's own revisions carry it. Same rule as for commits: presence in the author's
  // object store is never consulted, only what the declared reader revisions reach.
  if (!full) {
    const obj = git(['rev-parse', '--verify', sha]);
    if (obj && reachableObjects().has(obj)) {
      const type = git(['cat-file', '-t', obj]) ?? 'object';
      return {
        k: 'REACHABLE',
        d: `${type}, carried by the reader's revisions`,
      };
    }
  }

  const twin = twinMap.get(sha);
  if (twin) {
    const twinFull = git(['rev-parse', '--verify', `${twin}^{commit}`]);
    if (twinFull && reachable.has(twinFull)) {
      // What this may and may not do is the whole of the design.
      //
      // It may not *require* a content match. The reader this check speaks for does not hold
      // the orphaned object and never can, so requiring one would put the verdict back under
      // the local object store, which the rule above forbids.
      //
      // It may not *refute* on a content mismatch either, and that is the part measurement
      // settled rather than judgement. Every declaration in this repository's ledger names a
      // squash: 41 commits of #162 collapsed into one, so the twin's content is the union of
      // its inputs and equal to none of them. Requiring equality refused 34 of 44 correct
      // rows. Requiring containment still refused 30, because a 41-commit squash legitimately
      // loses the intermediate states -- rows measured at 155 of 196, 55 of 66, 48 of 50 lines
      // surviving. Any rule strict enough to refuse an arbitrary commit refuses those too, so
      // a refutation here buys a little safety by reddening correct work, which is #146 again.
      //
      // What is left is sound and worth having: containment can only ever be *evidence for*
      // twinship, so it upgrades the label and never withdraws the pass. A reader is told
      // which of these two things they are looking at instead of being told neither.
      const cited = full ? addedLinesOf(full) : null;
      const claimed = cited ? addedLinesOf(twinFull) : null;
      if (cited && claimed && [...cited].every((l) => claimed.has(l))) {
        return {
          k: 'TWIN',
          d: `${twin.slice(0, 8)} (declared, reachable, content verified: every line the cited revision added is present)`,
        };
      }
      // Said plainly rather than implied. The previous wording named its own two properties -
      // "declared, reachable" - and twinship was not among them, so the single thing the
      // verdict asserted was the single thing nothing had checked.
      return {
        k: 'TWIN',
        d: `${twin.slice(0, 8)} (declared, reachable; TWINSHIP UNVERIFIED - accepted on the declaration alone)`,
      };
    }
    return {
      k: 'ORPHAN',
      d: `declared twin ${twin.slice(0, 8)} is not itself reachable`,
    };
  }

  if (declared.has(sha)) return { k: 'DECLARED', d: declared.get(sha) };

  // Authoring aid only, and clearly labelled as such: if the author happens to hold the object,
  // suggest a twin to declare. This never turns an ORPHAN into a pass.
  let hint = 'unreachable, no declared twin, undeclared';
  if (full && includeAuthoringHint) {
    const candidates = (git(['rev-list', 'HEAD', '--no-merges']) ?? '')
      .split('\n')
      .filter(Boolean);

    const q = patchIdOf(full);
    if (q) {
      for (const c of candidates) {
        if (patchIdOf(c) === q) {
          hint = `unreachable; candidate twin ${c.slice(0, 8)} (identical patch-id) - declare it under "${TWIN_HEADING}"`;
          break;
        }
      }
    }

    // #413: `git patch-id --stable` hashes context lines, so a true twin that landed after
    // somebody else appended has a different id. Measured on a purpose-built fixture: an
    // identical twelve-line block appended to a ledger at two different offsets produces two
    // patch-ids, while every added line is still present. The verdict never depended on this -
    // it uses the containment test above, which is why ARM B has been exercising this hazard
    // since before it was filed - but the *hint* did, and it degrades on exactly the
    // append-only ledger every citation here points at.
    //
    // The failure is not a false ORPHAN. The revision is an orphan either way: undeclared and
    // unreachable. What is lost is the one line that tells the author which commit to declare,
    // and a bare orphan carrying no candidate reads as "there is no twin" - the opposite of the
    // truth. So the fallback restores the remedy, not the verdict, and says which instrument
    // found it so the two grades of evidence are never confused.
    if (!hint.includes('candidate twin')) {
      const cited = addedLinesOf(full);
      if (cited) {
        for (const c of candidates) {
          const candidate = addedLinesOf(c);
          if (candidate && [...cited].every((l) => candidate.has(l))) {
            hint = `unreachable; candidate twin ${c.slice(0, 8)} (every added line present; patch-id differs, which an append-only ledger causes) - declare it under "${TWIN_HEADING}"`;
            break;
          }
        }
      }
    }
  }
  return { k: 'ORPHAN', d: hint };
};

// --- control arm -------------------------------------------------------------------------
// Two outcome controls, and two mutation controls. The outcome controls show the instrument can
// produce both answers. The mutation controls show *where the answer comes from* - which is the
// thing the previous version got wrong while both of its outcome controls passed. A positive
// control proves the data is live; it does not prove the predicate asks what you think it asks.
const controlPresent = git(['rev-parse', 'HEAD']);
const controlAbsent = '0123456789abcdef0123456789abcdef01234567';
const cp = classify(controlPresent);
const ca = classify(controlAbsent);
console.log('control: known-present SHA classifies', cp.k);
console.log('control: known-absent  SHA classifies', ca.k);

const failures = [];
if (cp.k !== 'REACHABLE')
  failures.push('known-present SHA did not classify REACHABLE');
if (ca.k !== 'ORPHAN')
  failures.push('known-absent SHA did not classify ORPHAN');

// The non-commit arm gets its own pair, because a branch nothing exercises is a branch nothing
// checks. The positive case uses a blob the reader demonstrably holds - this file's own tree
// entry - and the negative case a syntactically valid hash that no object walk will contain.
const controlBlob = git(['rev-parse', '--verify', 'HEAD:package.json']);
if (controlBlob) {
  const cb = classify(controlBlob);
  console.log('control: a blob carried by the reader classifies', cb.k);
  if (cb.k !== 'REACHABLE')
    failures.push('a reader-reachable blob did not classify REACHABLE');
}
const cbAbsent = classify('89abcdef0123456789abcdef0123456789abcdef');
console.log('control: an absent non-commit object classifies', cbAbsent.k);
if (cbAbsent.k !== 'ORPHAN')
  failures.push('an unreachable object did not classify ORPHAN');

const [someTwinned] = [...twins.keys()];
if (someTwinned) {
  // Withdrawing the declaration must withdraw the pass: TWIN has to come from the text.
  const withoutDeclaration = classify(someTwinned, {
    twinMap: new Map(),
    includeAuthoringHint: false,
  });
  console.log(
    'control: a twinned SHA with its declaration removed classifies',
    withoutDeclaration.k,
  );
  if (withoutDeclaration.k === 'TWIN') {
    failures.push(
      'a twinned SHA still classified TWIN with no declaration - the pass is coming from the local object store',
    );
  }
  // A declared twin that a reader cannot reach must not pass either.
  const unreachableTwin = classify(someTwinned, {
    twinMap: new Map([[someTwinned, controlAbsent]]),
  });
  console.log(
    'control: a declared twin that is unreachable classifies',
    unreachableTwin.k,
  );
  if (unreachableTwin.k !== 'ORPHAN') {
    failures.push('an unreachable declared twin was accepted');
  }
}

// The upgrade above is only worth having if the comparison behind it can tell two revisions
// apart, and can recognise a revision as containing itself. Neither is safe to assume: a
// comparison that always matched would stamp "content verified" on every declaration, which is
// the same false reassurance in a new costume, and one that never matched would silently
// downgrade every correct row. Both arms run against revisions this reader demonstrably holds.
// The revisions are chosen with --no-merges rather than as HEAD and HEAD~1. `git show` renders a
// merge as a combined diff, one column per parent, so every line arrives `++`-prefixed and
// addedLinesOf reports null for it. HEAD is a merge commit in any checkout of a branch that was
// updated from its base - which is the ordinary case here - so the earlier HEAD/HEAD~1 form
// skipped this whole block in silence, printed nothing, and let the run pass. A control that
// cannot run in the repository it ships in is not a weaker control; it is an absent one, and its
// silence is indistinguishable from success.
//
// --no-merges alone was still the wrong subject set, and the cost was paid on real work. The two
// LATEST non-merge revisions are whatever happened to land last, and documentation work lands in
// runs: `style: format loop.md` added exactly one blank line to a file whose previous commit had
// also added blank lines, so the newer revision's added-line set was {"+"} and the older one's
// contained it. Subset, so `contains(linesA, linesB)` was true, so the control "failed", so the
// harness withheld its verdict with exit 2 and blocked #577 on a correct change. That red was
// about the SUBJECT, not the instrument: a commit that adds no content cannot demonstrate that a
// content comparison separates content, and neither can two commits that only reformat.
//
// The fix is to choose subjects that can carry the signal, not to relax the assertion. A revision
// qualifies only if it adds at least one line with non-whitespace content: a commit that adds no
// content cannot demonstrate that a content comparison separates content, and two commits that
// only reformat cannot either. That predicate is independent of the comparison being tested -- it
// asks "does this revision contain real content" and never "do these two revisions differ" -- so
// it selects a fair subject rather than manufacturing a pass. The assertion itself is unchanged
// and still fails loudly if the comparator cannot separate two genuine changes.
//
// Among the qualifying revisions, ones that touch something outside documentation are PREFERRED,
// because "the control still proves it works on real content changes" is the point of having it,
// and documentation work is where the near-duplicate added lines that make a fair test hard tend
// to cluster. Preferred, not required, and the difference is the same principle the paragraph
// above turns on. A hard requirement makes the control unrunnable in a checkout whose recent
// history is all prose -- which is a real state of this repository and the ordinary state of the
// fixtures under tests/citationReachability.test.ts -- and a control that cannot run is not a
// stricter control, it is an absent one whose silence reads as a pass. So the search takes the
// best two subjects available and says in the transcript which grade it got.
//
// `isDocumentationPath` is imported rather than restated so this file and the CI fast path cannot
// drift into two different meanings of "documentation".
const SELF_TEST_WINDOW = 100;

// Added lines with something in them. The keys addedLinesOf builds are `<diff header>\0+<text>`,
// so the added text is everything after the NUL and the leading `+`.
const substantiveAddedLinesOf = (rev) => {
  const lines = addedLinesOf(rev);
  if (!lines) return null;
  const kept = new Set(
    [...lines].filter(
      (entry) => entry.slice(entry.indexOf('\u0000') + 2).trim() !== '',
    ),
  );
  return kept.size ? kept : null;
};

const changedPathsOf = (rev) => {
  // `-z` because core.quotePath would C-escape a non-ASCII path, and an escaped path matches no
  // suffix rule - so it would read as source, which is the safe direction for this decision.
  const out = git(['show', rev, '--format=', '--name-only', '-z']);
  return out === null ? null : out.split('\0').filter(Boolean);
};

const substantive = [];
for (const rev of (
  git(['rev-list', '--no-merges', '-n', String(SELF_TEST_WINDOW), 'HEAD']) ?? ''
)
  .split('\n')
  .filter(Boolean)) {
  const lines = substantiveAddedLinesOf(rev);
  if (!lines) continue;
  const paths = changedPathsOf(rev);
  const touchesSource =
    paths !== null &&
    paths.length > 0 &&
    !paths.every((p) => isDocumentationPath(p));
  substantive.push({ rev, lines, touchesSource });
  // Nothing later in history can improve on two preferred subjects, so stop walking. The window
  // is the only other bound, and it is what keeps a long prose-only stretch from walking the
  // whole graph.
  if (substantive.filter((s) => s.touchesSource).length === 2) break;
}

const preferred = substantive.filter((s) => s.touchesSource);
const usingPreferred = preferred.length === 2;
const selfTestSubjects = (usingPreferred ? preferred : substantive).slice(0, 2);

const [subjectA, subjectB] = selfTestSubjects;
const linesA = subjectA?.lines ?? null;
const linesB = subjectB?.lines ?? null;
if (linesA && linesB) {
  const contains = (a, b) => [...a].every((l) => b.has(l));
  console.log(
    `control: twin-comparison subjects ${subjectA.rev.slice(0, 8)} and ${subjectB.rev.slice(0, 8)}` +
      (usingPreferred
        ? ' (both change non-documentation content)'
        : ' (documentation only; no two non-documentation revisions in the window)'),
  );
  console.log(
    'control: the twin comparison separates two distinct revisions',
    !contains(linesA, linesB),
  );
  console.log(
    'control: the twin comparison recognises a revision as containing itself',
    contains(linesA, linesA),
  );
  if (contains(linesA, linesB))
    failures.push(
      'the twin content comparison cannot separate two distinct revisions',
    );
  if (!contains(linesA, linesA))
    failures.push(
      'the twin content comparison does not recognise a revision as containing itself',
    );
} else {
  // Reported rather than failed. A reader holding fewer than two measurable revisions is a
  // narrow checkout, not a broken instrument, and reddening it would be the false red this
  // whole change exists to avoid. But the run must not read as though the arm had passed.
  console.log(
    `control: the twin comparison was NOT EXERCISED - the last ${SELF_TEST_WINDOW} non-merge revisions hold fewer than two that add non-whitespace content`,
  );
}

if (failures.length) {
  for (const f of failures) console.error('CONTROL FAILED - ' + f);
  console.error('verdict withheld.');
  process.exit(2);
}

// --- corpus floor ------------------------------------------------------------------------
// The preflight above catches a scan root that vanished. It cannot catch a root that still
// exists and no longer carries citations: a truncation, a botched merge, or an edit that strips
// the backticked pins leaves both files readable and the corpus empty or nearly so, and the
// verdict is vacuous in exactly the same way. Same shape as `MAINLINE_FLOOR: 250` in #399.
//
// The floor is a number and therefore expires, so it is justified against a series rather than
// a single reading. Unique cited SHAs across the two roots, measured over all 46 commits that
// have touched audit-trail.md:
//
//   2026-07-23  0  (file created)      2026-08-04 17:51   89
//   2026-08-04 12:29   65               2026-08-04 19:37   96
//   2026-08-04 14:23   74               2026-08-04 21:28  101
//   2026-08-04 15:59   86               2026-08-05 01:33  115
//                                       2026-08-05 01:51  122   <- 6a8bc7a0
//
// The series is monotonically non-decreasing across all 46 commits: this corpus only ever
// grows. That matters more than the endpoint, because it fixes the direction a fixed floor
// drifts. It drifts toward *under*-protection - a floor of 90 guards 26% of today's corpus and
// proportionally less every day - and never toward false alarms. Given the choice, that is the
// correct direction for a gate to age in: an advisory check that quietly protects less is worth
// more than one that fires on routine work and gets deleted in a week.
//
// 90 is chosen to sit below every reading from 2026-08-04 17:51 onward while remaining far
// above the failure mode this exists to catch, which lands at or near zero. Re-derive it if the
// corpus is ever legitimately pruned; do not raise it to track growth, which would reintroduce
// exactly the false-alarm risk the margin buys off.
const CITATION_FLOOR = 90;

// The floor is calibrated against *this* repository's corpus, so a synthetic fixture with a
// hand-built ledger of two citations trips it legitimately. `--floor=N` lets such a fixture say
// so explicitly. It is a flag and not an environment variable on purpose: a flag cannot arrive
// ambiently from CI configuration, it appears in the diff of whatever invokes the check, and
// `states a guarantee its own guards actually deliver` asserts that neither the npm script nor
// the workflow passes one. An override is also announced on stdout, so a run that lowered its
// own bar cannot look like a run that cleared it.
const floorArg = process.argv.find((a) => a.startsWith('--floor='));
const floor = floorArg
  ? Number(floorArg.slice('--floor='.length))
  : CITATION_FLOOR;
if (!Number.isInteger(floor) || floor < 0) {
  refuse(
    `--floor expects a non-negative integer, got ${JSON.stringify(floorArg)}.`,
  );
}
if (floor !== CITATION_FLOOR) {
  console.log(
    `citation floor overridden: ${floor} (calibrated floor is ${CITATION_FLOOR})`,
  );
}
requireCorpusFloor({ count: cited.size, floor });

// --- the run -----------------------------------------------------------------------------
console.log(
  `\nreader revisions: ${readerRevs.join(' ')}  (${reachable.size} commits reachable)`,
);
console.log(
  'scope: refs/heads only. ORPHAN means "no route from these revisions", never "does not exist" -',
);
console.log(
  '  refs/pull/N/head still resolves after a squash merge deletes the branch, and the forge serves',
);
console.log(
  '  single commits by SHA from a store that outlives every ref. Neither is consulted here: this',
);
console.log(
  '  check gates pull requests and must not turn a network outage into a red.',
);
console.log(`cited SHAs: ${cited.size}   declared: ${declared.size}\n`);

const tally = { REACHABLE: 0, TWIN: 0, DECLARED: 0, ORPHAN: 0 };
const orphans = [];
for (const sha of [...cited.keys()].sort()) {
  const r = classify(sha);
  tally[r.k] += 1;
  if (r.k !== 'REACHABLE') {
    console.log(`  ${sha.padEnd(10)} ${r.k.padEnd(10)} ${r.d}`);
  }
  if (r.k === 'ORPHAN') orphans.push(`${sha} (${cited.get(sha).join(', ')})`);
}

console.log(
  `\nREACHABLE ${tally.REACHABLE}   TWIN ${tally.TWIN}   DECLARED ${tally.DECLARED}   ORPHAN ${tally.ORPHAN}`,
);

// A twin declaration repairs a citation the graph can no longer reach - but the twin is itself a
// commit, and a twin that exists only on this branch is destroyed by the same rewrite that would
// orphan anything else here. So a rebase or squash removes the citation *and* the repair in one
// motion, and the number of orphans it produces exceeds the number of branch-local citations by
// exactly the number of branch-local twins. That was measured the hard way: a forecast of 17
// orphans, made by counting cited revisions unique to a branch, came out at 33 when the rewrite
// was actually performed in a throwaway clone, and the gap was the declared twins.
//
// Reported, not gated. It describes a rewrite nobody has performed, so it can neither grant nor
// withhold a pass; the operator about to rewrite is the one who needs the number, and the party
// who rewrites history is never the party who can see what it broke.
//
// And the advice this block used to give - "merge, do not rebase" - is forbidden by the branch it
// gives it about. Measured on `development`: `required_linear_history` is TRUE, all three merge
// strategies are enabled, `enforce_admins` is FALSE, and 41 of the last 60 commits on that branch
// are two-parent. So the setting forbids the shape the repository overwhelmingly uses, and the
// exception that permits it is granted per-merge by whoever presses the button.
//
// ⇒ a setting contradicted by 41 of 60 commits is not a policy, it is a label - and a control
// routinely bypassed cannot be cited as a guarantee in either direction. An ancestry-based repair
// is therefore betting on a human's choice at the merge button. Declare the twins; and where the
// claim is about the contents of a file, cite the blob, which no merge strategy can rewrite.
const baseRev = git(['rev-parse', '--verify', 'origin/development^{commit}'])
  ? 'origin/development'
  : null;
if (baseRev && twins.size) {
  const baseReachable = new Set(
    (git(['rev-list', baseRev]) ?? '').split('\n').filter(Boolean),
  );
  const fragile = [];
  for (const [sha, twin] of twins) {
    const full = git(['rev-parse', '--verify', `${twin}^{commit}`]);
    if (full && reachable.has(full) && !baseReachable.has(full)) {
      fragile.push(`${sha.slice(0, 8)} -> ${twin.slice(0, 8)}`);
    }
  }
  if (fragile.length) {
    console.log(
      `\nPRECONDITION: ${fragile.length} of ${twins.size} declared twins are reachable only from this branch,`,
    );
    console.log(
      `  not from ${baseRev}. Rewriting this branch destroys the citation and its repair together,`,
    );
    console.log(
      '  so the resulting orphan count exceeds the number of branch-local citations. A two-parent',
    );
    console.log(
      '  merge preserves them; squash and rebase do not - but see the note on required_linear_history',
    );
    console.log(
      '  in this file: the branch setting forbids the only strategy that works, so declare the twins',
    );
    console.log(
      '  and do not rely on the merge shape you get. Blob citations survive every strategy.',
    );
    for (const f of fragile.slice(0, 8)) console.log(`    ${f}`);
    if (fragile.length > 8) {
      console.log(`    ... and ${fragile.length - 8} more`);
    }
  }
}

if (orphans.length) {
  console.error(
    '\nORPHANED CITATIONS - unreachable to a reader, and not accounted for:',
  );
  for (const o of orphans) console.error(`  ${o}`);
  console.error(
    '\nRepair by naming the live twin, documenting a fetch route, or declaring the absence under:',
  );
  console.error(`  ${DECLARATION_HEADING}`);
  // ORPHAN means "no route through the commit graph", which is narrower than "gone". The forge
  // serves single commits by SHA from a content-addressed store that outlives every ref, so an
  // object no branch reaches and no `git fetch` route recovers is often still retrievable -
  // measured on this repository against three revisions whose branch was deleted on merge, all
  // three served, with a synthetic SHA rejected as the negative control. That route is printed
  // rather than taken: this check gates pull requests, and a verdict that depends on the network
  // would turn an outage into a red and could not run in a clone with no remote. The instrument
  // stays hermetic; the operator gets told where else to look.
  console.error(
    '\nA graph route is not the only route. To test whether the forge still serves one:',
  );
  console.error(
    '  gh api repos/<owner>/<repo>/commits/<sha> --jq .sha   # non-zero exit means genuinely gone',
  );
  process.exit(1);
}

console.log('\nOK - every cited revision is reachable, twinned, or declared.');
