import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_UNCOVERED,
  EXIT_UNVERIFIABLE,
  FABRICATED_HEAD,
  VERDICT_COVERED,
  VERDICT_SUPERSEDED,
  VERDICT_UNREVIEWED,
  VERDICT_UNVERIFIABLE,
  classifyCoverage,
  evaluateControls,
  evaluateSweep,
  formatSweep,
  normalizeSha,
  reviewCoversHead,
} from '../scripts/check-review-head-coverage.mjs';

const HEAD = '9f426be0a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OLDER = 'ac7e79912345678990abcdef1234567890abcdef';

function review(commitId: unknown, state = 'COMMENTED', id = 1) {
  return { id, state, commit_id: commitId };
}

describe('normalizing a sha before comparing it', () => {
  it('accepts a full 40-hex sha', () => {
    expect(normalizeSha(HEAD)).toBe(HEAD);
  });

  it('lowercases, so a case difference is not read as a different commit', () => {
    expect(normalizeSha(HEAD.toUpperCase())).toBe(HEAD);
  });

  // An abbreviation is the shape a human pastes. Accepting it would make
  // coverage depend on how the value was typed rather than on which commit it
  // names, and prefix-matching would silently widen every comparison.
  it('rejects an abbreviation rather than prefix-matching it', () => {
    expect(normalizeSha(HEAD.slice(0, 8))).toBeNull();
  });

  it('rejects a non-string, so a missing field is never a value', () => {
    expect(normalizeSha(undefined)).toBeNull();
    expect(normalizeSha(null)).toBeNull();
    expect(normalizeSha(42)).toBeNull();
  });

  it('rejects a 40-character string that is not hex', () => {
    expect(normalizeSha('z'.repeat(40))).toBeNull();
  });
});

describe('the single comparison the instrument rests on', () => {
  it('matches a review rendered against the head', () => {
    expect(reviewCoversHead(review(HEAD), HEAD)).toBe(true);
  });

  it('does not match a review rendered against another commit', () => {
    expect(reviewCoversHead(review(OLDER), HEAD)).toBe(false);
  });

  // Two unusable values must not compare equal. `null === null` is the defect
  // that would report a PR with no head and a review with no commit_id as
  // covered — an absence on both sides read as agreement.
  it('does not let two missing values match each other', () => {
    expect(reviewCoversHead(review(undefined), undefined)).toBe(false);
    expect(reviewCoversHead(review(null), null)).toBe(false);
  });
});

describe('classifying one pull request', () => {
  it('reports covered when a review sits on the merged head', () => {
    const result = classifyCoverage({
      prNumber: 400,
      mergedHead: HEAD,
      reviews: [review(OLDER, 'COMMENTED', 1), review(HEAD, 'COMMENTED', 2)],
    });
    expect(result.verdict).toBe(VERDICT_COVERED);
    expect(result.coveringReviews).toEqual([2]);
  });

  // The population's dominant reviewed case: covered at submission, stale at
  // merge. Nothing in the merge path re-checks a review, so this is not an
  // error state — it is what a review means here by default.
  it('reports superseded when every review sits on an older head', () => {
    const result = classifyCoverage({
      prNumber: 248,
      mergedHead: HEAD,
      reviews: [review(OLDER, 'COMMENTED', 1)],
    });
    expect(result.verdict).toBe(VERDICT_SUPERSEDED);
    expect(result.coveringReviews).toEqual([]);
    expect(result.reason).toContain('superseded');
  });

  it('separates unreviewed from superseded', () => {
    const result = classifyCoverage({
      prNumber: 401,
      mergedHead: HEAD,
      reviews: [],
    });
    expect(result.verdict).toBe(VERDICT_UNREVIEWED);
    expect(result.reviewCount).toBe(0);
  });

  // "Not covered" and "could not be read" are different claims, and collapsing
  // them reports an unmeasurable PR as a finding.
  it('reports unverifiable rather than uncovered when the head is unusable', () => {
    const result = classifyCoverage({
      prNumber: 402,
      mergedHead: undefined,
      reviews: [review(HEAD)],
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
  });

  it('does not let a review with an unusable commit_id cover anything', () => {
    const result = classifyCoverage({
      prNumber: 403,
      mergedHead: HEAD,
      reviews: [review('not-a-sha')],
    });
    expect(result.verdict).toBe(VERDICT_SUPERSEDED);
    expect(result.coveringReviews).toEqual([]);
  });
});

describe('the controls, which gate the report', () => {
  it('passes on a corpus whose reviews carry real shas', () => {
    const controls = evaluateControls({
      reviews: [review(HEAD, 'COMMENTED', 1), review(OLDER, 'COMMENTED', 2)],
    });
    expect(controls.passed).toBe(true);
    expect(controls.falsePositives).toBe(0);
    expect(controls.selfMatched).toBe(2);
  });

  // NEGATIVE CONTROL, exercised: if the matcher saturates, a head present in no
  // review matches anyway. Injecting a head that IS in the corpus is how we
  // prove the arm can fire, rather than trusting that it would.
  it('fails when the fabricated head matches something', () => {
    const controls = evaluateControls({
      reviews: [review(HEAD)],
      fabricatedHead: HEAD,
    });
    expect(controls.passed).toBe(false);
    expect(controls.falsePositives).toBe(1);
    expect(controls.failures.join(' ')).toContain('saturating');
  });

  // A positive control over an empty corpus establishes nothing, and "0 of 0
  // covered" is the exact shape of a green that proves nothing.
  it('refuses to certify a corpus with no usable review at all', () => {
    const controls = evaluateControls({ reviews: [] });
    expect(controls.passed).toBe(false);
    expect(controls.failures.join(' ')).toContain(
      'positive control unavailable',
    );
  });

  it('treats reviews with unusable commit_ids as no corpus', () => {
    const controls = evaluateControls({ reviews: [review('nope')] });
    expect(controls.passed).toBe(false);
    expect(controls.usableReviews).toBe(0);
  });

  // The remaining arm — `selfMisses`, a matcher so broken it does not match a
  // value against itself — is UNREACHABLE through this API by construction: a
  // correct comparison cannot produce it, and no fixture can force it. It is
  // exercised by mutating `reviewCoversHead` to return false, which reddens
  // this suite naming the positive control. Recorded here because an assertion
  // whose failing arm is never demonstrated is indistinguishable from one that
  // cannot fail, and this file must not imply otherwise.
  it('reports the self-match count so a dead matcher is visible in the output', () => {
    const controls = evaluateControls({ reviews: [review(HEAD)] });
    expect(controls.selfMatched).toBe(1);
    expect(controls.usableReviews).toBe(1);
  });

  it('uses a fabricated head that is not the shape of a real review sha here', () => {
    expect(normalizeSha(FABRICATED_HEAD)).not.toBeNull();
    expect(FABRICATED_HEAD).not.toBe(HEAD);
  });
});

describe('sweeping a population', () => {
  const covered = classifyCoverage({
    prNumber: 1,
    mergedHead: HEAD,
    reviews: [review(HEAD)],
  });
  const superseded = classifyCoverage({
    prNumber: 2,
    mergedHead: HEAD,
    reviews: [review(OLDER)],
  });
  const unreviewed = classifyCoverage({
    prNumber: 3,
    mergedHead: HEAD,
    reviews: [],
  });

  it('partitions the population', () => {
    const sweep = evaluateSweep([covered, superseded, unreviewed]);
    expect(sweep.total).toBe(3);
    expect(sweep.covered).toHaveLength(1);
    expect(sweep.superseded).toHaveLength(1);
    expect(sweep.unreviewed).toHaveLength(1);
    expect(sweep.reviewed).toBe(2);
  });

  // A bucket count that fails to sum to its own total is the cheapest detector
  // for a mis-specified predicate. The cast is deliberate: `strict: true`
  // forbids this statically, but every result in a real run is derived from
  // JSON the compiler never saw, so the runtime guard is not redundant with
  // the type — it covers the one path the type does not reach.
  it('throws rather than silently dropping a verdict it does not enumerate', () => {
    const foreign = {
      ...superseded,
      verdict: 'something-else',
    } as unknown as typeof superseded;
    expect(() => evaluateSweep([covered, foreign])).toThrow(
      /buckets sum to 1 over a population of 2/,
    );
  });

  it('reports an empty population as empty rather than as covered', () => {
    const sweep = evaluateSweep([]);
    expect(sweep.total).toBe(0);
    expect(sweep.covered).toEqual([]);
    expect(sweep.reviewed).toBe(0);
  });

  it('renders the counts and names the PRs', () => {
    const sweep = evaluateSweep([covered, superseded, unreviewed]);
    const text = formatSweep(sweep, { readAt: '2026-08-05T10:20:00Z' });
    expect(text).toContain('3 merged pull request(s)');
    expect(text).toContain('2026-08-05T10:20:00Z');
    expect(text).toContain('#1');
    expect(text).toContain('#2');
    expect(text).toContain('blocks nothing');
  });
});

describe('exit codes are distinct', () => {
  // `unverifiable` collapsed into `uncovered` reports a run that could not
  // measure anything as a finding — the alarming direction.
  it('separates ok, uncovered and unverifiable', () => {
    expect(new Set([EXIT_OK, EXIT_UNCOVERED, EXIT_UNVERIFIABLE]).size).toBe(3);
  });
});
