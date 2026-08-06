// Shared refusal mechanism for citation-reachability checks (#481).
//
// The defect this exists for, measured on the shipping harness: renaming
// `.squad/fact-checker/audit-trail.md` made `check-citation-reachability.mjs`
// print `OK - every cited revision is reachable, twinned, or declared` and exit
// 0, with REACHABLE 0 / TWIN 0 / DECLARED 0 / ORPHAN 0 and every self-control
// green. An empty corpus satisfies "every cited revision is reachable"
// vacuously, and self-supplied controls certify the classifier rather than the
// input, so they are structurally incapable of detecting that there was no
// input.
//
// This module is deliberately the *mechanism* and never the *number*. The
// corpora it will serve are disjoint - the incumbent check scans the
// fact-checker artifacts, and the cross-repository arm in #421 scans the admin
// guide, which carries a different count entirely - so a shared floor constant
// would be wrong for one consumer by construction. Each caller states its own
// floor and justifies it against its own measurement; they share only the way a
// refusal is expressed and the guarantee that a root cannot be skipped.

import { readFileSync } from 'node:fs';

/**
 * The exit code for "could not look", as distinct from 1, "the thing I checked
 * is broken". Callers must not collapse these: a repair instruction attached to
 * the wrong one sends someone to fix citations that are fine, and a check that
 * fails for the wrong reason teaches people to ignore it.
 */
export const INCONCLUSIVE = 2;

/**
 * Refuses to publish a verdict, naming the reason. Never returns.
 */
export function refuse(headline, detail = []) {
  console.error(`INCONCLUSIVE: ${headline}`);
  for (const line of detail) console.error(line);
  process.exit(INCONCLUSIVE);
}

/**
 * Reads every scan root once, up front, and reports which could not be read.
 *
 * One read site, deliberately. The defect was two separate `catch { continue; }`
 * blocks that each silently skipped a missing file, so a root could fail in two
 * places and be swallowed in both. Consumers take the returned text rather than
 * re-reading, which makes a swallowed read impossible rather than merely absent.
 */
export function loadCorpus(files) {
  const sources = new Map();
  const unreadable = [];

  for (const file of files) {
    try {
      sources.set(file, readFileSync(file, 'utf8'));
    } catch (error) {
      unreadable.push(`${file} (${error.code ?? error.message})`);
    }
  }

  return { sources, unreadable };
}

/**
 * Refuses if any scan root is missing or unreadable.
 *
 * This is not subsumed by a corpus floor, and the incumbent check's own roots
 * prove it: at 6a8bc7a0 `audit-trail.md` carries all 122 cited SHAs and
 * `policy.md` carries none, so losing `policy.md` changes no count at all. A
 * floor cannot see a root whose absence costs nothing. Only this can.
 */
export function requireScanRoots({ sources, unreadable }) {
  if (unreadable.length === 0) return sources;

  refuse(
    'a scan root is missing or unreadable, so the citation corpus cannot be assembled.',
    [
      ...unreadable.map((entry) => `  ${entry}`),
      'Restore the artifact, or update the scan roots if it moved -- do not read the empty result as a pass.',
    ],
  );
}

/**
 * Every distinct backticked commit-SHA in the corpus, mapped to the files it
 * appears in.
 */
export function collectCitations(sources) {
  const cited = new Map();

  for (const [file, text] of sources) {
    for (const match of text.matchAll(/`([0-9a-f]{7,40})`/g)) {
      if (!cited.has(match[1])) cited.set(match[1], []);
      cited.get(match[1]).push(file);
    }
  }

  return cited;
}

/**
 * Refuses if the corpus is present but has collapsed.
 *
 * `requireScanRoots` catches a root that vanished. It cannot catch a root that
 * still exists and no longer carries citations - a truncation, a botched merge,
 * or an edit that strips the backticked pins leaves the file readable and the
 * corpus empty, and the verdict is vacuous in exactly the same way.
 *
 * The floor belongs to the caller. It must be justified against a measurement
 * of that caller's own corpus and sit far enough below it that ordinary editing
 * does not trip it, because a gate that fires on routine work is removed within
 * a week and a floor that always refuses is exactly as useless as one that
 * always passes.
 */
export function requireCorpusFloor({ count, floor, subject = 'cited SHAs' }) {
  if (count >= floor) return;

  refuse(`only ${count} ${subject} were found, below the floor of ${floor}.`, [
    'The scan roots are readable but carry far fewer citations than the corpus this check was',
    'calibrated against, so a clean result here would describe the sample and not the ledger.',
    'Investigate the artifacts; if the corpus shrank legitimately, re-justify and lower the floor.',
  ]);
}
