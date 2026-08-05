// Review head-coverage: does a merged pull request carry a review rendered
// against the commit that actually merged?
//
// #280 asked for this and it is not the same question as "was it approved".
// Measured over the whole merged population on 2026-08-05:
//
//   200 merged PRs · 13 carrying any review · 187 carrying none
//     6 with a review AT the merged head
//     7 where every review sits on a head that was later superseded
//     COMMENTED 48 · APPROVED 0 · CHANGES_REQUESTED 0
//
// The `APPROVED 0` is structural, not a discipline failure: this repository has
// one collaborator, GitHub refuses self-approval, and
// `required_approving_review_count` is 0. So a verdict figure is unavailable and
// arming one would deadlock every PR permanently. Coverage is computable today,
// needs no permission change, and cannot deadlock anything — it reports.
//
// The trap this file exists to avoid: "no approving review covered the head" is
// trivially entailed by "there are no approving reviews", and reads exactly like
// the much stronger "no review covered the head". A coverage figure inferred
// from a verdict figure is not a measurement of coverage. This checks
// `commit_id` against the head, which is the only field that carries the
// revision a verdict was rendered against — an issue comment has no such field,
// so "cite a comment id" records THAT a verdict was given and not WHAT AGAINST.
//
// Both controls below run against the live corpus on every invocation and gate
// the report, because the finding here is an ABSENCE and an absence produced by
// a broken matcher is byte-identical to one produced by an empty corpus.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERDICT_COVERED = 'covered';
export const VERDICT_SUPERSEDED = 'superseded';
export const VERDICT_UNREVIEWED = 'unreviewed';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_UNCOVERED = 1;
export const EXIT_UNVERIFIABLE = 2;

// A 40-hex string that is not a commit in any repository we query. The negative
// control asserts it matches nothing; if it ever matches, the comparison is
// saturating and every "covered" verdict in the run is worthless.
export const FABRICATED_HEAD = '0123456789abcdef0123456789abcdef01234567';

/**
 * A SHA is untrusted input. GitHub renders `commit_id` as a 40-hex string, but
 * a null, an abbreviation or a differently-cased value must not silently
 * compare unequal to an otherwise identical head — nor silently compare EQUAL
 * by being coerced to the same falsy value. Anything that is not a full 40-hex
 * string is `null`, and `null` never matches, including another `null`.
 */
export function normalizeSha(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * The single comparison the whole instrument rests on. Both controls call this
 * rather than re-implementing it, so a control cannot pass while the real
 * matcher is broken — the failure mode where a control tests apparatus it
 * shares with nothing.
 */
export function reviewCoversHead(review, head) {
  const reviewSha = normalizeSha(review?.commit_id);
  const headSha = normalizeSha(head);
  if (reviewSha === null || headSha === null) {
    return false;
  }
  return reviewSha === headSha;
}

export function classifyCoverage({ prNumber, mergedHead, reviews } = {}) {
  const head = normalizeSha(mergedHead);
  const list = Array.isArray(reviews) ? reviews : [];

  if (head === null) {
    return {
      prNumber,
      verdict: VERDICT_UNVERIFIABLE,
      reason: `#${prNumber} reports no usable head sha (${JSON.stringify(mergedHead)}), so coverage cannot be read either way`,
      reviewCount: list.length,
      coveringReviews: [],
      states: [],
    };
  }

  const states = list.map((review) => review?.state ?? 'UNKNOWN');

  if (list.length === 0) {
    return {
      prNumber,
      verdict: VERDICT_UNREVIEWED,
      reason: `#${prNumber} merged at ${head.slice(0, 8)} carrying no review of any state`,
      reviewCount: 0,
      coveringReviews: [],
      states,
    };
  }

  const covering = list.filter((review) => reviewCoversHead(review, head));

  if (covering.length > 0) {
    return {
      prNumber,
      verdict: VERDICT_COVERED,
      reason: `#${prNumber} merged at ${head.slice(0, 8)} with ${covering.length} review(s) rendered against that commit`,
      reviewCount: list.length,
      coveringReviews: covering.map((review) => review.id),
      states,
    };
  }

  const seen = [
    ...new Set(
      list
        .map((review) => normalizeSha(review?.commit_id))
        .filter((sha) => sha !== null)
        .map((sha) => sha.slice(0, 8)),
    ),
  ];

  return {
    prNumber,
    verdict: VERDICT_SUPERSEDED,
    reason: `#${prNumber} merged at ${head.slice(0, 8)}; all ${list.length} review(s) sit on ${seen.length} superseded head(s) [${seen.join(', ')}] — covered at submission, stale at merge`,
    reviewCount: list.length,
    coveringReviews: [],
    states,
  };
}

/**
 * Both controls, over the corpus actually collected in this run.
 *
 * NEGATIVE: a head present in no review must be covered by no review. If the
 * fabricated head matches anything, the matcher is saturating.
 *
 * POSITIVE: every review must cover its own `commit_id`. If any does not, the
 * matcher is dead and every `superseded`/`unreviewed` verdict is an artefact
 * rather than a finding. A negative control alone cannot catch this — a matcher
 * that never matches passes it perfectly.
 */
export function evaluateControls({ reviews, fabricatedHead } = {}) {
  const list = Array.isArray(reviews) ? reviews : [];
  const fabricated = fabricatedHead ?? FABRICATED_HEAD;

  const falsePositives = list.filter((review) =>
    reviewCoversHead(review, fabricated),
  );

  const usable = list.filter((review) => normalizeSha(review?.commit_id));
  const selfMisses = usable.filter(
    (review) => !reviewCoversHead(review, review.commit_id),
  );

  const failures = [];
  if (falsePositives.length > 0) {
    failures.push(
      `negative control failed: ${falsePositives.length} review(s) matched a fabricated head, so the comparison is saturating`,
    );
  }
  if (selfMisses.length > 0) {
    failures.push(
      `positive control failed: ${selfMisses.length} review(s) did not match their own commit_id, so the comparison is dead`,
    );
  }
  // A positive control over an empty corpus establishes nothing. Reporting
  // "0 covered" from 0 reviews is the vacuous pass this file exists to prevent.
  if (usable.length === 0) {
    failures.push(
      'positive control unavailable: no review in this run carries a usable commit_id, so no absence reading from it means anything',
    );
  }

  return {
    passed: failures.length === 0,
    falsePositives: falsePositives.length,
    selfMatched: usable.length - selfMisses.length,
    usableReviews: usable.length,
    failures,
  };
}

export function evaluateSweep(results) {
  const list = Array.isArray(results) ? results : [];
  const bucket = (verdict) =>
    list.filter((result) => result.verdict === verdict);

  const covered = bucket(VERDICT_COVERED);
  const superseded = bucket(VERDICT_SUPERSEDED);
  const unreviewed = bucket(VERDICT_UNREVIEWED);
  const unverifiable = bucket(VERDICT_UNVERIFIABLE);

  // A bucket count that fails to sum to its own total is the cheapest detector
  // for a mis-specified predicate, and it is omitted because the buckets and
  // the total come from the same query and therefore feel like one measurement.
  const partitioned =
    covered.length +
    superseded.length +
    unreviewed.length +
    unverifiable.length;
  if (partitioned !== list.length) {
    throw new Error(
      `verdict buckets sum to ${partitioned} over a population of ${list.length}: a result carries a verdict this sweep does not enumerate`,
    );
  }

  return {
    total: list.length,
    covered,
    superseded,
    unreviewed,
    unverifiable,
    reviewed: covered.length + superseded.length,
  };
}

/**
 * Exit code for a sweep (census) run.
 *
 * The controls in `evaluateControls` are a *population* check — "does any
 * review in this run carry a usable commit_id" — and one usable review
 * anywhere satisfies them for the entire sweep. That is a wider scope than
 * the claim a zero exit licenses, so a run whose every review sits on a
 * superseded head clears the controls and still reports success. Exiting 0
 * there puts "the census ran" on the same channel a verified gate uses, and
 * the exit code is what a caller reads, not the banner.
 *
 * This does not make the census complete. The same controls passed on a run
 * that received one review where an authenticated run received three, so
 * `selfMatched/usableReviews` certifies that the matcher works on the reviews
 * it was given and says nothing about whether it was given all of them.
 *
 * `total === 0` is unreachable through `main`, because passing controls
 * requires a usable review, which requires a result. It is handled here and
 * exercised by calling this function directly.
 */
export function sweepExitCode(sweep) {
  if (
    !sweep ||
    typeof sweep.total !== 'number' ||
    !Array.isArray(sweep.covered)
  )
    return EXIT_UNVERIFIABLE;
  if (sweep.total === 0) return EXIT_UNVERIFIABLE;
  if (sweep.covered.length === 0) return EXIT_UNCOVERED;
  return EXIT_OK;
}

export function formatSweep(sweep, options = {}) {
  const lines = [];
  const readAt = options.readAt ?? new Date().toISOString();

  lines.push(`review head-coverage over ${sweep.total} merged pull request(s)`);
  lines.push(`  read at ${readAt}`);
  lines.push('');
  lines.push(
    `  covered      ${String(sweep.covered.length).padStart(4)}  a review rendered against the merged head`,
  );
  lines.push(
    `  superseded   ${String(sweep.superseded.length).padStart(4)}  reviewed, but every review on an older head`,
  );
  lines.push(
    `  unreviewed   ${String(sweep.unreviewed.length).padStart(4)}  no review of any state`,
  );
  lines.push(
    `  unverifiable ${String(sweep.unverifiable.length).padStart(4)}  no usable head sha`,
  );

  if (sweep.covered.length > 0) {
    lines.push('');
    lines.push(
      `  covered: ${sweep.covered.map((result) => `#${result.prNumber}`).join(' ')}`,
    );
  }
  if (sweep.superseded.length > 0) {
    lines.push(
      `  superseded: ${sweep.superseded.map((result) => `#${result.prNumber}`).join(' ')}`,
    );
  }

  // The denominator moved 98 -> 122 -> 143 -> 200 in a single night. A coverage
  // figure without its read time is not a quantity anyone can check later.
  lines.push('');
  lines.push(
    '  This is a reading, not a gate. It reports absence and blocks nothing;',
  );
  lines.push(
    '  arming an approval requirement here would deadlock every PR, because',
  );
  lines.push(
    '  GitHub refuses self-approval and this repo has one collaborator.',
  );

  return lines.join('\n');
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = git(['remote', 'get-url', 'origin']);
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) {
    throw new Error(
      `cannot resolve a repository from origin (${remote || 'unset'})`,
    );
  }
  return match[1];
}

async function requestJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'check-review-head-coverage',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${url}`);
  }
  return response.json();
}

export async function fetchMergedPulls({ repository, token, limit = 30 }) {
  const pulls = await requestJson(
    `https://api.github.com/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(100, Math.max(1, limit) * 2)}`,
    token,
  );
  return pulls
    .filter((pull) => pull.merged_at !== null && pull.merged_at !== undefined)
    .slice(0, limit);
}

export async function fetchReviews({ repository, token, prNumber }) {
  const reviews = await requestJson(
    `https://api.github.com/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
    token,
  );
  return reviews.map((review) => ({
    id: review.id,
    state: review.state,
    commit_id: review.commit_id,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  let limit = 30;
  const explicit = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--limit') {
      limit = Number.parseInt(args[index + 1], 10);
      index += 1;
    } else if (/^\d+$/.test(arg)) {
      explicit.push(Number.parseInt(arg, 10));
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-review-head-coverage [--limit <n>] [pr-number...]`,
      );
    }
  }

  const repository = resolveRepository();
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

  const pulls =
    explicit.length > 0
      ? await Promise.all(
          explicit.map((prNumber) =>
            requestJson(
              `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
              token,
            ),
          ),
        )
      : await fetchMergedPulls({ repository, token, limit });

  const results = [];
  const allReviews = [];
  for (const pull of pulls) {
    let reviews = [];
    try {
      reviews = await fetchReviews({
        repository,
        token,
        prNumber: pull.number,
      });
    } catch {
      reviews = [];
    }
    allReviews.push(...reviews);
    results.push(
      classifyCoverage({
        prNumber: pull.number,
        mergedHead: pull.head?.sha,
        reviews,
      }),
    );
  }

  const controls = evaluateControls({ reviews: allReviews });
  if (!controls.passed) {
    for (const failure of controls.failures) {
      console.error(`[review-coverage] ${failure}`);
    }
    console.error(
      '[review-coverage] refusing to report: an absence from a broken matcher is indistinguishable from a real one',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const sweep = evaluateSweep(results);
  console.log(formatSweep(sweep));
  console.log(
    `\n  controls: fabricated head matched ${controls.falsePositives} review(s) (expect 0); ${controls.selfMatched}/${controls.usableReviews} reviews matched their own commit_id (expect all)`,
  );

  if (explicit.length > 0) {
    const uncovered = results.filter(
      (result) => result.verdict !== VERDICT_COVERED,
    );
    for (const result of uncovered) {
      console.error(`[review-coverage] ${result.reason}`);
    }
    process.exitCode = uncovered.length > 0 ? EXIT_UNCOVERED : EXIT_OK;
    return;
  }

  const code = sweepExitCode(sweep);
  if (code === EXIT_UNCOVERED) {
    console.error(
      `[review-coverage] no PR in this sweep of ${sweep.total} is covered at its merged head; a zero-coverage census is not a pass`,
    );
  } else if (code === EXIT_UNVERIFIABLE) {
    console.error(
      '[review-coverage] sweep produced no results; there is nothing to have measured',
    );
  }
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[review-coverage] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
