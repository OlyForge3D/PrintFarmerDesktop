// No shebang: this module is imported by tests/datedMeasurement.test.ts, and
// vite's transform does not strip one the way node does (see
// check-body-edit-triggers.mjs for the same note). Invoked via
// `node scripts/check-dated-measurement.mjs`, so a shebang buys nothing here.
//
// Gives a citation of a mutable GitHub object (an issue/PR body, its labels,
// its review state, its comment count, `updated_at` itself) a dated anchor a
// reader can mechanically re-verify, instead of a remembered value nobody can
// re-check later.
//
// #462: six incidents in one night, four of them datable, all one shape --
// an object was read accurately, a claim was composed from the read, and the
// object changed before the claim was sent. Two examples from the issue:
//
//   comment 5188687270 created   2026-08-05T07:09:33Z
//   assertion sent                2026-08-05T07:10:52Z     <- 79s later, wrong
//
//   gh issue list --label squad --state open   37 issues, #459 absent (read)
//   issue 459 updated_at                        2026-08-05T07:13:31Z  <- fixed
//   assertion sent                               2026-08-05T07:14:16Z  <- 45s
//
// Both reads were true when taken. Neither claim carried anything a reader
// could compare against the object's current state, so a stale claim and a
// fresh one were the same shape on the page.
//
// THE RULE THIS FILE ENFORCES (#462's own proposal): "Cite the read time with
// the reading... a reader can then compare it against the object's current
// `updated_at` in one call, which is not possible for an undated claim."
//
//   gh api repos/OWNER/REPO/issues/459 --jq '{updated_at, comments}'
//
// A CITATION IS AN IDENTITY CLAIM, NOT A SIZE COMPARISON (#462 repair 1): this
// file does not diff bodies or count characters. It compares one timestamp
// against another under one stated equivalence -- the same instant, as
// measured by `Date.parse`, not by string equality (a `Z` suffix and a
// `+00:00` suffix name the same instant and must not be reported as
// different; #462's own route 5 names exactly this kind of frame mismatch:
// an ISO string silently coerced across a comparison boundary).
//
// THE LIVE VALUE IS COMPUTED WHERE THE DATA LIVES (#462 repair 2): `--jq
// '.updated_at'` on the GitHub API response, not through a client-side copy
// (a clone, a cached issue list, a session's memory of the object) that can
// itself go stale between the copy and the comparison.
//
// THE STAMP, NOT THE CLOCK (#462 repair 6): "the stamp and the clock are not
// equivalent: 'I read this at 08:04:10Z' records when you looked; 'updated_at
// = 08:03:22Z' records what you looked at." This file only ever compares a
// cited `updated_at` against a freshly-read `updated_at` -- never against
// `Date.now()`, which would only prove when the check ran, not whether the
// object had moved.
//
// A SELF-REFERENTIAL MEASUREMENT IS STALE THE MOMENT YOU ACT ON IT (#462
// repair 6, second half): this file's own report -- the PR body or comment
// that cites this check's verdict -- is itself a measurement of a mutable
// object and subject to the identical hazard. Verify any repair made in
// response to a STALE verdict by re-running this check against the object
// AFTER the write-up describing the repair, not before: the write-up is part
// of the object under test on a body-carrying citation, and a check run
// before the write-up lands says nothing about the state the write-up
// describes.
//
// CONTROLS, so a check that has never fired is not indistinguishable from one
// that cannot fire (#462 repair 8, and the same requirement #473 named for
// check-stale-checkout-head.mjs): `evaluateControls` below runs a positive
// arm (a citation compared against itself must read FRESH) and a negative arm
// (a citation compared against a fabricated, deliberately-later timestamp
// must read STALE) on every invocation, self-contained and independent of
// whatever object this run happens to be checking.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERDICT_FRESH = 'fresh';
export const VERDICT_STALE = 'stale';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_STALE = 1;
export const EXIT_UNVERIFIABLE = 2;
export const EXIT_CONTROLS_FAILED = 3;

/**
 * A fixed instant used only to drive `evaluateControls`. It is never compared
 * against anything read from a live object, so its particular value carries
 * no meaning beyond "some valid, parseable timestamp".
 */
export const SAMPLE_TIMESTAMP_FOR_CONTROLS = '2024-01-01T00:00:00Z';

/**
 * An instant guaranteed to be later than any real `updated_at` this check
 * will ever be asked to compare against, for as long as this file remains in
 * use. This is the "known-stale" fixture the negative control feeds in --
 * mirrors `FABRICATED_SHA` in check-stale-checkout-head.mjs, which exists for
 * exactly the same reason (#473).
 */
export const FABRICATED_LATER_TIMESTAMP = '2999-01-01T00:00:00Z';

/**
 * Parses a citation timestamp under ONE stated equivalence: same instant, as
 * `Date.parse` resolves it. `2026-08-05T07:13:31Z` and
 * `2026-08-05T07:13:31.000+00:00` normalize to the same value here and MUST,
 * because they name the same instant -- treating them as different would be
 * exactly the frame mismatch #462 catalogues as route 5 (an ISO string
 * silently coerced across a comparison boundary, inflating or deflating a
 * result by the zone offset).
 *
 * Returns null for anything that does not parse to a finite instant,
 * including non-strings -- this is the identity's equivalence, and an
 * unparseable value has no instant to be identical to.
 */
export function normalizeTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The one comparison this whole mechanism rests on. `citedUpdatedAt` is the
 * timestamp a report quoted alongside its measurement; `liveUpdatedAt` is a
 * freshly-read `updated_at` for the same object, read as an output of this
 * run rather than trusted from anyone's memory.
 *
 * `updated_at` is monotonic non-decreasing on a GitHub object, so there are
 * exactly three cases:
 *
 *   cited == live   the object has not changed since the citation: FRESH.
 *   live  >  cited  the object mutated after the citation was taken: STALE.
 *   live  <  cited  the citation names an instant later than what is live
 *                   right now -- either the wrong object, a clock that ran
 *                   ahead, or a citation copied from a different revision.
 *                   Never reported FRESH: a claim this check cannot make
 *                   sense of is not evidence the claim is current.
 */
export function classifyMeasurementFreshness({
  citedUpdatedAt,
  liveUpdatedAt,
} = {}) {
  const cited = normalizeTimestamp(citedUpdatedAt);
  const live = normalizeTimestamp(liveUpdatedAt);

  if (cited === null || live === null) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      reason:
        `cannot compare: cited updated_at ${JSON.stringify(citedUpdatedAt)} and live updated_at ` +
        `${JSON.stringify(liveUpdatedAt)} do not both normalize to a usable instant`,
    };
  }

  if (live > cited) {
    return {
      verdict: VERDICT_STALE,
      exitCode: EXIT_STALE,
      reason:
        `the object's live updated_at (${new Date(live).toISOString()}) is later than the cited ` +
        `updated_at (${new Date(cited).toISOString()}); the object mutated after the citation was ` +
        'taken, and any claim quoting the cited value as current is describing a revision that no ' +
        'longer exists',
    };
  }

  if (live < cited) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      reason:
        `the cited updated_at (${new Date(cited).toISOString()}) is later than the object's live ` +
        `updated_at (${new Date(live).toISOString()}); updated_at only moves forward, so this citation ` +
        'cannot describe the object it claims to -- check the object identifier, not the clock',
    };
  }

  return {
    verdict: VERDICT_FRESH,
    exitCode: EXIT_OK,
    reason: `cited updated_at (${new Date(cited).toISOString()}) matches the object's live updated_at`,
  };
}

/**
 * Both controls, self-contained and run on every invocation regardless of
 * what object this run is checking -- mirrors `evaluateControls` in
 * check-stale-checkout-head.mjs (#473) for the identical reason: a check that
 * has never fired is indistinguishable from one that cannot.
 *
 * POSITIVE: a citation compared against itself must read FRESH. A negative
 * control alone cannot catch a comparator that never matches anything --
 * that passes a negative-only suite perfectly while being useless.
 *
 * NEGATIVE: a citation compared against a deliberately later, fabricated
 * timestamp must read STALE. If it does not, the comparison never fires and
 * every FRESH verdict this run could produce is worthless.
 */
export function evaluateControls() {
  const failures = [];

  const positive = classifyMeasurementFreshness({
    citedUpdatedAt: SAMPLE_TIMESTAMP_FOR_CONTROLS,
    liveUpdatedAt: SAMPLE_TIMESTAMP_FOR_CONTROLS,
  });
  if (positive.verdict !== VERDICT_FRESH) {
    failures.push(
      `positive control failed: a citation did not match itself (${positive.verdict}), so the comparison is dead`,
    );
  }

  const negative = classifyMeasurementFreshness({
    citedUpdatedAt: SAMPLE_TIMESTAMP_FOR_CONTROLS,
    liveUpdatedAt: FABRICATED_LATER_TIMESTAMP,
  });
  if (negative.verdict !== VERDICT_STALE) {
    failures.push(
      'negative control failed: a fabricated, known-later updated_at was not reported STALE against ' +
        'the real cited timestamp, so the comparison is saturating',
    );
  }

  return { passed: failures.length === 0, failures };
}

export function formatResult(result, { repo, number } = {}) {
  const label =
    result.exitCode === EXIT_OK
      ? 'FRESH'
      : result.exitCode === EXIT_STALE
        ? 'STALE'
        : 'UNVERIFIABLE';
  const lines = [`[dated-measurement] ${label} (${result.verdict})`];
  if (repo) lines.push(`  object  ${repo}#${number}`);
  lines.push(`  ${result.reason}`);
  if (result.verdict === VERDICT_STALE) {
    lines.push(
      '  Do not trust this citation. Re-read the object fresh before acting: ' +
        `\`gh api repos/${repo ?? '<owner>/<repo>'}/issues/${number ?? '<n>'} --jq '{updated_at}'\`.`,
    );
  }
  return lines.join('\n');
}

// --- citation parsing --------------------------------------------------------

/**
 * The citation format this file expects a report to use: a fenced block whose
 * info string is exactly `measured`, containing `key: value` lines. Modelled
 * on the existing `closes` fenced-block convention (.github/PR_CLOSES.md) so
 * a reader already knows how to spot one.
 *
 *   ```measured
 *   repo: OlyForge3D/PrintFarmerDesktop
 *   number: 462
 *   updated_at: 2026-08-08T07:00:00Z
 *   ```
 *
 * Required keys are `repo`, `number` and `updated_at`; any other key is kept
 * verbatim in `fields` but not otherwise interpreted. A block missing a
 * required key is returned with `incomplete: true` and the missing keys
 * named, rather than silently dropped -- a citation that declares nothing
 * checkable must be reported as such, not treated as an absence of citations.
 */
export function parseMeasurementCitations(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const blockPattern = /```measured\r?\n([\s\S]*?)```/g;
  const citations = [];
  let match;
  while ((match = blockPattern.exec(text)) !== null) {
    const fields = {};
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key) fields[key] = value;
    }
    const missing = ['repo', 'number', 'updated_at'].filter(
      (key) => !(key in fields),
    );
    citations.push({
      repo: fields.repo,
      number: fields.number !== undefined ? Number(fields.number) : undefined,
      updatedAt: fields.updated_at,
      fields,
      incomplete: missing.length > 0,
      missing,
    });
  }
  return citations;
}

// --- effects -----------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

/**
 * The live `updated_at`, computed where the data lives (#462 repair 2):
 * `--jq` runs server-side against the response GitHub sends, never through an
 * intermediate client-side copy of the issue that this process might hold
 * from an earlier call. Works for both issues and pull requests -- every PR
 * is also an issue in GitHub's model, and the issues endpoint reports
 * `updated_at` for both.
 */
export function fetchLiveUpdatedAt({ repo, number, run = gh } = {}) {
  return run([
    'api',
    `repos/${repo}/issues/${number}`,
    '--jq',
    '.updated_at',
  ]).trim();
}

function parseArgs(argv) {
  const args = { citations: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      args.repo = argv[index + 1];
      index += 1;
    } else if (arg === '--number') {
      args.number = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--cited-updated-at') {
      args.citedUpdatedAt = argv[index + 1];
      index += 1;
    } else if (arg === '--file') {
      args.file = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-dated-measurement.mjs ` +
          '(--repo <owner/repo> --number <n> --cited-updated-at <iso> | --file <path>)',
      );
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    readFile = (path) => readFileSync(path, 'utf8'),
    fetchLive = fetchLiveUpdatedAt,
  } = deps;

  const controls = evaluateControls();
  if (!controls.passed) {
    for (const failure of controls.failures) {
      console.error(`[dated-measurement] ${failure}`);
    }
    console.error(
      '[dated-measurement] refusing to report: a FRESH verdict from a broken comparator is indistinguishable from a real one',
    );
    process.exitCode = EXIT_CONTROLS_FAILED;
    return;
  }

  const args = parseArgs(argv);

  let citations;
  if (args.file) {
    const text = readFile(args.file);
    citations = parseMeasurementCitations(text);
    if (citations.length === 0) {
      console.error(
        `[dated-measurement] no \`\`\`measured fenced block found in ${args.file}`,
      );
      process.exitCode = EXIT_UNVERIFIABLE;
      return;
    }
  } else if (args.repo && args.number !== undefined && args.citedUpdatedAt) {
    citations = [
      { repo: args.repo, number: args.number, updatedAt: args.citedUpdatedAt },
    ];
  } else {
    console.error(
      'usage: check-dated-measurement.mjs (--repo <owner/repo> --number <n> --cited-updated-at <iso> | --file <path>)',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  let worstExitCode = EXIT_OK;
  for (const citation of citations) {
    if (citation.incomplete) {
      console.error(
        `[dated-measurement] citation for ${citation.repo ?? '<unknown>'}#${citation.number ?? '?'} ` +
          `is missing required field(s): ${citation.missing.join(', ')}`,
      );
      worstExitCode = Math.max(worstExitCode, EXIT_UNVERIFIABLE);
      continue;
    }

    let liveUpdatedAt;
    try {
      liveUpdatedAt = await fetchLive({
        repo: citation.repo,
        number: citation.number,
      });
    } catch (error) {
      console.error(
        `[dated-measurement] could not fetch a live updated_at for ${citation.repo}#${citation.number}: ${error.message}`,
      );
      worstExitCode = Math.max(worstExitCode, EXIT_UNVERIFIABLE);
      continue;
    }

    const result = classifyMeasurementFreshness({
      citedUpdatedAt: citation.updatedAt,
      liveUpdatedAt,
    });
    const rendered = formatResult(result, {
      repo: citation.repo,
      number: citation.number,
    });
    if (result.exitCode === EXIT_OK) {
      console.log(rendered);
    } else {
      console.error(rendered);
    }
    worstExitCode = Math.max(worstExitCode, result.exitCode);
  }

  process.exitCode = worstExitCode;
}

export { main };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[dated-measurement] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
