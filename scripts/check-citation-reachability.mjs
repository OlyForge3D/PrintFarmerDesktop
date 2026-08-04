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
//   TWIN       a commit on the branch has the same `git patch-id --stable`. The pin names a
//              revision that was rewritten, and the rewritten copy carries the same change, so
//              the citation is repairable by substitution rather than lost. Reported with the
//              twin so the ledger can name it.
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

// Revisions a reader is assumed to hold. `origin/development` may be absent in a shallow or
// branch-only checkout; the branch head alone still gives a usable, if stricter, answer.
const readerRevs = ['HEAD', 'origin/development'].filter((r) =>
  git(['rev-parse', '--verify', `${r}^{commit}`]),
);

const reachable = new Set(
  (git(['rev-list', ...readerRevs]) ?? '').split('\n').filter(Boolean),
);

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

// Patch-id index over the branch's own commits. Merges are excluded: a merge's diff depends on
// which parent it is taken against, so its patch-id is not a stable identity for the change.
const twinIndex = new Map();
for (const c of (git(['rev-list', 'HEAD', '--no-merges']) ?? '')
  .split('\n')
  .filter(Boolean)) {
  const q = patchIdOf(c);
  if (q && !twinIndex.has(q)) twinIndex.set(q, c);
}

const declared = new Map();
for (const f of FILES) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const at = text.indexOf(DECLARATION_HEADING);
  if (at < 0) continue;
  const rest = text.slice(at + DECLARATION_HEADING.length);
  const end = rest.indexOf('\n## ');
  const block = end < 0 ? rest : rest.slice(0, end);
  for (const m of block.matchAll(
    /`([0-9a-f]{7,40})`\s*[-\u2014:]\s*([^\n]+)/g,
  )) {
    declared.set(m[1], m[2].trim());
  }
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

const classify = (sha) => {
  const full = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (!full) {
    // Unresolvable even locally. If it is declared, the declaration is the whole record we
    // have and it stands; otherwise nobody - author included - can check it.
    return declared.has(sha)
      ? { k: 'DECLARED', d: declared.get(sha) }
      : { k: 'ORPHAN', d: 'does not resolve' };
  }
  if (reachable.has(full)) return { k: 'REACHABLE', d: '' };
  const twin = twinIndex.get(patchIdOf(full));
  if (twin) return { k: 'TWIN', d: twin.slice(0, 8) };
  if (declared.has(sha)) return { k: 'DECLARED', d: declared.get(sha) };
  return { k: 'ORPHAN', d: 'unreachable, no twin, undeclared' };
};

// --- control arm -------------------------------------------------------------------------
const controlPresent = git(['rev-parse', 'HEAD']);
const controlAbsent = '0123456789abcdef0123456789abcdef01234567';
const cp = classify(controlPresent);
const ca = classify(controlAbsent);
console.log('control: known-present SHA classifies', cp.k);
console.log('control: known-absent  SHA classifies', ca.k);
if (cp.k !== 'REACHABLE' || ca.k !== 'ORPHAN') {
  console.error(
    'CONTROL FAILED - the instrument cannot produce both outcomes; verdict withheld.',
  );
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
  process.exit(1);
}

console.log('\nOK - every cited revision is reachable, twinned, or declared.');
