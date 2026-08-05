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
import { readFileSync } from 'node:fs';

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

// Reads a `- `sha` — text` list under a heading, from any of the artifacts.
const readBlock = (heading) => {
  const found = new Map();
  for (const f of FILES) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
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
const cited = new Map();
for (const f of FILES) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const m of text.matchAll(/`([0-9a-f]{7,40})`/g)) {
    if (!cited.has(m[1])) cited.set(m[1], []);
    cited.get(m[1]).push(f);
  }
}

// The verdict is computed from exactly two things a reader also has: what is reachable from the
// reader's revisions, and what the artifacts say. Local object presence is never consulted for a
// pass, so the author and the reader get the same answer.
const classify = (sha, { twinMap = twins } = {}) => {
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
  if (full) {
    const q = patchIdOf(full);
    if (q) {
      for (const c of (git(['rev-list', 'HEAD', '--no-merges']) ?? '')
        .split('\n')
        .filter(Boolean)) {
        if (patchIdOf(c) === q) {
          hint = `unreachable; candidate twin ${c.slice(0, 8)} - declare it under "${TWIN_HEADING}"`;
          break;
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
  const withoutDeclaration = classify(someTwinned, { twinMap: new Map() });
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
// The `?? ''` is load-bearing: `git()` returns null when the command fails, and on a repository
// whose HEAD is unborn `rev-list` fails. Splitting null throws, which exits 1 - and 1 is the
// code for "orphans found", not for "the instrument broke". The pre-existing unborn-HEAD test
// caught exactly that: crashing here would have replaced a withheld verdict with a wrong one.
const [controlRevA, controlRevB] = (
  git(['rev-list', '--no-merges', '-n', '2', 'HEAD']) ?? ''
).split('\n');
const linesA = controlRevA ? addedLinesOf(controlRevA) : null;
const linesB = controlRevB ? addedLinesOf(controlRevB) : null;
if (linesA && linesB) {
  const contains = (a, b) => [...a].every((l) => b.has(l));
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
    'control: the twin comparison was NOT EXERCISED - this reader holds fewer than two non-merge revisions',
  );
}

if (failures.length) {
  for (const f of failures) console.error('CONTROL FAILED - ' + f);
  console.error('verdict withheld.');
  process.exit(2);
}

// --- the run -----------------------------------------------------------------------------
console.log(
  `\nreader revisions: ${readerRevs.join(' ')}  (${reachable.size} commits reachable)`,
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
