import { describe, expect, it } from 'vitest';

import {
  EXIT_CLEAN,
  EXIT_FAILED,
  EXIT_UNDETERMINED,
  VERDICT_FAILED,
  VERDICT_PASSED,
  VERDICT_PENDING,
  VERDICT_SUPERSEDED,
  buildVerdicts,
  classifyConclusion,
  fetchCheckRuns,
  formatReport,
  latestCheckRunsByName,
  main,
  resolveRepo,
} from '../scripts/check-run-verdicts.mjs';

function stub(
  handler: (
    command: string,
    argv: readonly string[],
  ) => { status: number; stdout?: string; stderr?: string },
) {
  return ((command: string, argv: readonly string[]) => {
    const result = handler(command, argv);
    return {
      ...result,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }) as never;
}

function checkRun(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: 'some check',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-08-06T15:58:00Z',
    started_at: '2026-08-06T15:58:29Z',
    completed_at: '2026-08-06T15:59:29Z',
    ...overrides,
  };
}

describe('classifyConclusion', () => {
  it.each([
    ['success', VERDICT_PASSED],
    ['neutral', VERDICT_PASSED],
    ['skipped', VERDICT_PASSED],
  ])(
    'NEGATIVE CONTROL: %s reports %s, never failed',
    (conclusion, expected) => {
      expect(classifyConclusion(conclusion)).toBe(expected);
    },
  );

  it.each([
    ['failure', VERDICT_FAILED],
    ['timed_out', VERDICT_FAILED],
    ['action_required', VERDICT_FAILED],
    ['startup_failure', VERDICT_FAILED],
  ])('POSITIVE CONTROL: %s reports %s', (conclusion, expected) => {
    expect(classifyConclusion(conclusion)).toBe(expected);
  });

  it.each([
    ['cancelled', VERDICT_SUPERSEDED],
    ['stale', VERDICT_SUPERSEDED],
  ])(
    'THE #562 FIX: %s reports %s, and specifically NOT failed',
    (conclusion, expected) => {
      const observed = classifyConclusion(conclusion);
      expect(observed).toBe(expected);
      expect(observed).not.toBe(VERDICT_FAILED);
    },
  );

  it('an unfinished run (null conclusion) reports pending', () => {
    expect(classifyConclusion(null)).toBe(VERDICT_PENDING);
  });

  it('refuses to guess a verdict for an unrecognized conclusion', () => {
    expect(() => classifyConclusion('some_future_conclusion')).toThrow(
      /unrecognized check-run conclusion/,
    );
  });
});

describe('latestCheckRunsByName', () => {
  it('reproduces the issue witness: "Sequencing hold" latest run is cancelled, not failure', () => {
    // Verbatim from #562's measurement at PR #560 head 0fe7384d...:
    //   2026-08-06T15:58:29Z | conclusion=cancelled
    //   2026-08-06T15:58:30Z | conclusion=cancelled
    //   2026-08-06T15:59:53Z | conclusion=success
    //   2026-08-06T16:00:16Z | conclusion=success
    //   2026-08-06T16:21:37Z | conclusion=cancelled   <- latest
    // There is no `failure` conclusion anywhere in this set. `gh pr checks`
    // still rendered this name as `fail`.
    const checkRuns = [
      checkRun({
        id: 1,
        created_at: '2026-08-06T15:58:20Z',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:58:35Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 2,
        created_at: '2026-08-06T15:58:22Z',
        started_at: '2026-08-06T15:58:30Z',
        completed_at: '2026-08-06T15:58:40Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 3,
        created_at: '2026-08-06T15:59:45Z',
        started_at: '2026-08-06T15:59:53Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 4,
        created_at: '2026-08-06T16:00:10Z',
        started_at: '2026-08-06T16:00:16Z',
        completed_at: '2026-08-06T16:00:30Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 5,
        created_at: '2026-08-06T16:21:30Z',
        started_at: '2026-08-06T16:21:37Z',
        completed_at: '2026-08-06T16:21:50Z',
        conclusion: 'cancelled',
      }),
    ].map((run) => ({ ...run, name: 'Sequencing hold' }));

    const latest = latestCheckRunsByName(checkRuns);
    const run = latest.get('Sequencing hold');
    expect(run?.id).toBe(5);
    expect(run?.conclusion).toBe('cancelled');
    expect(classifyConclusion(run!.conclusion)).toBe(VERDICT_SUPERSEDED);
    expect(classifyConclusion(run!.conclusion)).not.toBe(VERDICT_FAILED);
  });

  it('REGRESSION: fails closed (throws) rather than trusting id when completed_at AND started_at both tie', () => {
    // If both timestamps this API guarantees are identical between two
    // completed runs, there is no signal left to determine which is truly
    // latest -- id is not a safe way to break that tie (the entire reason
    // id ordering was abandoned as this file's primary signal). Guessing
    // via id risks silently picking the stale run, so this must fail
    // closed instead of resolving to a (possibly wrong) verdict.
    const checkRuns = [
      checkRun({
        id: 10,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 11,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it("REGRESSION: a later, unambiguously-newer run resolves an earlier ambiguous tie between two now-superseded runs (doesn't throw)", () => {
    // Ripley (round 7): the prior reduce-based implementation compared
    // pairwise against only the single "current best" and threw as soon as
    // it saw an ambiguous tie -- even if a later run in the input array was
    // unambiguously newer than both tied candidates. Two OLDER completed
    // runs that tie on both started_at and completed_at, followed by a
    // THIRD, later, completed run that clearly started and finished after
    // both of them: the third run is the real answer, and its existence
    // means the earlier tie between the first two never needed to be
    // resolved at all. This must not throw, and must report run 3's own
    // verdict (a genuine failure, not masked as undetermined).
    const checkRuns = [
      checkRun({
        id: 20,
        name: 'Desktop',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 21,
        name: 'Desktop',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 22,
        name: 'Desktop',
        created_at: '2026-08-06T16:59:50Z',
        started_at: '2026-08-06T17:00:00Z',
        completed_at: '2026-08-06T17:00:05Z',
        conclusion: 'failure',
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('Desktop')?.id).toBe(22);
    expect(classifyConclusion(latest.get('Desktop')!.conclusion)).toBe(
      VERDICT_FAILED,
    );
  });

  it('REGRESSION (end-to-end): main() correctly reports the real verdict when an earlier ambiguous tie is resolved by a later unambiguous run', () => {
    const checkRuns = [
      checkRun({
        id: 20,
        name: 'Desktop',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 21,
        name: 'Desktop',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 22,
        name: 'Desktop',
        created_at: '2026-08-06T16:59:50Z',
        started_at: '2026-08-06T17:00:00Z',
        completed_at: '2026-08-06T17:00:05Z',
        conclusion: 'failure',
      }),
    ];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload(checkRuns),
      })),
      () => {},
    );
    expect(result).toBe(EXIT_FAILED);
  });

  it('REGRESSION: breaks a completed_at tie by created_at, not id, when a later rerun has a LOWER id', () => {
    // `completed_at` is only second-resolution, so two reruns of a fast job
    // can genuinely finish in the same reported second. Live Checks API
    // data on this repo showed exactly that (two "Stacked base" completions
    // tied on completed_at) with the later rerun carrying a LOWER id than
    // the earlier one -- falling back to id at that point is exactly as
    // unsound as ordering by id everywhere. `created_at` is the sole
    // recency signal now (see compareCheckRunRecency), and the
    // later-created run is, definitionally, the later attempt regardless
    // of its id or how its completed_at happens to compare.
    const checkRuns = [
      checkRun({
        id: 42,
        created_at: '2026-08-06T15:59:55Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'failure',
      }),
      checkRun({
        id: 7,
        created_at: '2026-08-06T15:59:58Z',
        started_at: '2026-08-06T16:00:03Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    // The lower-id run (7) was created later, so it is the true latest
    // attempt -- picking it means the earlier failure is correctly
    // superseded rather than left standing as the reported verdict.
    expect(latest.get('some check')?.id).toBe(7);
    expect(latest.get('some check')?.conclusion).toBe('success');
  });

  it('an in-progress run (status != completed) reports pending regardless of a stray conclusion field', () => {
    const checkRuns = [
      checkRun({
        id: 1,
        status: 'in_progress',
        conclusion: null,
        completed_at: null,
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('some check')?.conclusion).toBeNull();
  });

  it('REGRESSION: a queued run with started_at: null is a normal pending case, not malformed input', () => {
    // GitHub reports `started_at: null` for a run that has been created but
    // not yet begun executing. That is a legitimate, common shape -- not an
    // error -- and must not be rejected the way a genuinely malformed run is.
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Queued check',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).not.toThrow();
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('Queued check')?.startedAt).toBeNull();
    expect(latest.get('Queued check')?.conclusion).toBeNull();
    expect(classifyConclusion(latest.get('Queued check')!.conclusion)).toBe(
      VERDICT_PENDING,
    );
  });

  it("REGRESSION: a run whose created_at field is null or absent (GitHub's real Checks API shape) is parsed successfully, not rejected as malformed", () => {
    // `created_at` is not documented on the check-run object at all --
    // confirmed both by GitHub's REST API reference and by live
    // `commits/<sha>/check-runs` responses from this repo's own PRs, which
    // return `created_at: null` for every run, including completed ones.
    // An earlier revision of this comparator (round 8) mistakenly started
    // reading and validating `created_at`, which meant it threw "invalid
    // created_at" on every real check run in production, while every test
    // fixture (which always set `created_at` explicitly) stayed green.
    // Verdict logic must only ever depend on the fields GitHub's docs and
    // live data actually guarantee: `started_at` / `completed_at` / `id`.
    const withNullCreatedAt = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
        created_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(withNullCreatedAt)).not.toThrow();

    const fullRun: Record<string, unknown> = checkRun({
      id: 2,
      name: 'Desktop (no field at all)',
      status: 'completed',
      conclusion: 'success',
    });
    delete fullRun.created_at;
    expect(() => latestCheckRunsByName([fullRun])).not.toThrow();
  });

  it('still refuses a completed run that carries no started_at at all, which is genuinely malformed', () => {
    const checkRuns = [
      checkRun({
        status: 'completed',
        conclusion: 'success',
        started_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /"completed" but no started_at/,
    );
  });

  it('refuses an in_progress run that carries no started_at, since in_progress means work has begun', () => {
    const checkRuns = [
      checkRun({
        status: 'in_progress',
        conclusion: null,
        started_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /"in_progress" but no started_at/,
    );
  });

  it('still refuses a completed run that carries no completed_at at all, which is genuinely malformed', () => {
    const checkRuns = [
      checkRun({
        status: 'completed',
        conclusion: 'success',
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /completed but has no completed_at/,
    );
  });

  it('REGRESSION: refuses a still-open run carrying a non-null completed_at instead of silently accepting it', () => {
    // The same contradiction as a non-null conclusion on a still-open run,
    // just on the timestamp instead of the verdict field: GitHub only sets
    // `completed_at` once `status` becomes `completed`. A queued/in_progress
    // run reporting one anyway is not a real API shape, and silently
    // accepting it risks a caller inferring the run has finished (from
    // completed_at) when status says otherwise.
    const checkRuns = [
      checkRun({
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /has status "in_progress" but a non-null completed_at/,
    );
  });

  it.each(['', '   ', '\t', '\n'])(
    'REGRESSION: refuses a whitespace-only check name %j instead of silently accepting it',
    (name) => {
      const checkRuns = [checkRun({ name })];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(
        /has no non-empty name/,
      );
    },
  );

  it.each([
    '\x1b',
    '\x00\x1b',
    '\x7f\x07',
    '\x9b',
    '\x80\x9f',
    '\u202e',
    '\u202a\u202b\u202c\u202d',
    '\u2066\u2067\u2068\u2069',
  ])(
    'REGRESSION: refuses a check name %j that is entirely control characters once sanitized',
    (name) => {
      // A name made up only of control characters (no printable content)
      // passes the raw non-whitespace check -- control bytes are not
      // whitespace per String.prototype.trim -- but becomes an empty
      // string once the ANSI/control-character sanitization strips them.
      // That must still be rejected as an empty name, not silently
      // reported as a check with no visible label. Covers the C0/DEL
      // range, the C1 range (\x80-\x9f), and the Unicode bidi-control
      // overrides/embeddings (U+202A-U+202E) and isolates (U+2066-U+2069).
      // (U+2028/U+2029 are deliberately not included here: unlike the other
      // control characters, they are LineTerminator code points that
      // String.prototype.trim already strips, so a name made up only of
      // those two characters is caught by the earlier raw-name check
      // instead -- see the dedicated forged-line regression test below for
      // how they are actually exercised, embedded in real content.)
      const checkRuns = [checkRun({ name })];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(
        /has no non-empty name once control characters are stripped/,
      );
    },
  );

  it('REGRESSION: strips ANSI escape sequences and other control characters from an attacker-controlled check name', () => {
    // A check-run `name` is not a trusted string -- anyone who can create a
    // check run against a commit (e.g. a workflow triggered from a fork PR)
    // controls it, and it is interpolated straight into terminal report
    // output. A name containing an ANSI escape sequence (ESC + CSI, here
    // "move cursor" / "clear screen" bytes) must have its control bytes
    // stripped before it is ever surfaced, so it cannot rewrite or corrupt
    // the terminal output a human or agent is reading. Grouping/keying,
    // though, must stay on the raw name -- see the collision regression
    // test below -- so look this run up by its raw (unsanitized) name.
    const maliciousName = '\x1b[31mDANGER\x1b[0m\x07 Desktop';
    const checkRuns = [checkRun({ name: maliciousName })];
    const latest = latestCheckRunsByName(checkRuns);
    const parsed = latest.get(maliciousName);
    expect(parsed).toBeDefined();
    expect(parsed?.displayName).toBe('[31mDANGER[0m Desktop');
    // eslint-disable-next-line no-control-regex -- asserting the absence of control characters is the point of this regression test.
    expect(parsed?.displayName).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('REGRESSION: two distinct raw names that sanitize to the same display string do not collide/alias in grouping', () => {
    // If runs were grouped/keyed by the *sanitized* name, an
    // attacker-controlled check name containing control characters could be
    // crafted to sanitize to the exact same string as a different,
    // legitimately-named check (e.g. "Desktop" vs "De\x07sktop" both
    // sanitize to "Desktop"), silently aliasing one check's tracked run
    // onto another's and masking its real verdict. Grouping must use the
    // raw name as the identity, so these two remain two distinct entries.
    const checkRuns = [
      checkRun({ id: 1, name: 'Desktop', conclusion: 'success' }),
      checkRun({ id: 2, name: 'De\x07sktop', conclusion: 'failure' }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.size).toBe(2);
    expect(latest.get('Desktop')?.conclusion).toBe('success');
    expect(latest.get('De\x07sktop')?.conclusion).toBe('failure');
    expect(latest.get('De\x07sktop')?.displayName).toBe('Desktop');
  });

  it('REGRESSION: refuses a completed run whose completed_at is earlier than its started_at', () => {
    // A completed run's own two timestamps are internally contradictory --
    // it claims to have finished before it started, a negative duration
    // that cannot happen for a genuine run. Silently accepting it wouldn't
    // just misreport this one run: a corrupt completed_at could feed
    // isNewerCheckRun's "latest attempt" comparison and cause it to pick
    // the wrong run for a name entirely.
    const checkRuns = [
      checkRun({
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T15:00:00Z',
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /has completed_at .* earlier than started_at/,
    );
  });

  it.each([
    ['started_at', 'Thu, 06 Aug 2026 16:00:00 GMT'],
    ['completed_at', 'Thu, 06 Aug 2026 16:05:00 GMT'],
  ] as const)(
    'REGRESSION: refuses a %s in RFC 2822 shape instead of accepting anything Date.parse can make sense of',
    (field, rfc2822Value) => {
      // GitHub's Checks API always emits started_at/completed_at in strict
      // ISO 8601 with a literal Z suffix. Date.parse alone is far more
      // permissive than that -- it also accepts RFC 2822 and other shapes
      // GitHub never actually sends. A drifted/malformed response carrying
      // a non-ISO-8601 (but still Date.parse-able) timestamp must fail
      // closed rather than silently being treated as valid.
      const checkRuns = [checkRun({ [field]: rfc2822Value })];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(
        new RegExp(`has an invalid ${field}`),
      );
    },
  );

  it.each([
    ['started_at', '2026-02-30T00:00:00Z'],
    ['completed_at', '2026-02-30T00:00:00Z'],
    ['started_at', '2026-08-06T24:00:00Z'],
    ['completed_at', '2026-08-06T24:00:00Z'],
  ] as const)(
    'REGRESSION: refuses a %s of %s -- shape matches ISO 8601 but the calendar/time value is impossible',
    (field, impossibleValue) => {
      // Date.parse does not reject an out-of-range calendar date or time
      // component -- it silently *normalizes* it into an adjacent valid
      // one instead (Feb 30 becomes Mar 2, hour 24 becomes the next
      // midnight). A regex checking only the shape (four digits, dash,
      // two digits, ...) cannot catch this, and Date.parse itself cannot
      // be used to catch it either, since it never throws for these
      // inputs -- it just quietly returns a different, shifted date. Both
      // must be rejected as the same class of malformed input as an
      // unparseable timestamp.
      const checkRuns = [checkRun({ [field]: impossibleValue })];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(
        new RegExp(`has an invalid ${field}`),
      );
    },
  );

  it('REGRESSION: accepts Feb 29 on a leap year but refuses it on a non-leap year', () => {
    // Feb 29 is a real calendar date in a leap year (2024) but not in a
    // non-leap year (2026) -- the impossible-date check must be sensitive
    // to the year it is paired with, not just reject Feb 29 outright.
    const leapYearRuns = [
      checkRun({
        started_at: '2024-02-29T00:00:00Z',
        completed_at: '2024-02-29T01:00:00Z',
      }),
    ];
    expect(() => latestCheckRunsByName(leapYearRuns)).not.toThrow();

    const nonLeapYearRuns = [
      checkRun({
        started_at: '2026-02-29T00:00:00Z',
        completed_at: '2026-02-29T01:00:00Z',
      }),
    ];
    expect(() => latestCheckRunsByName(nonLeapYearRuns)).toThrow(
      /has an invalid started_at/,
    );
  });

  it('REGRESSION: refuses a completed run with conclusion: null instead of silently reporting it pending', () => {
    // GitHub documents `conclusion` as always set once a run's `status` is
    // `completed` -- `completed` with `conclusion: null` is not a real API
    // shape. `classifyConclusion` treats `null` as "pending" for the
    // legitimate not-yet-completed case, so if this were allowed through
    // unchanged it would read as "still running" for a run that has, in
    // fact, already finished with no recorded verdict -- and `main` would
    // exit clean instead of failing closed. This must be rejected as
    // malformed the same way a missing started_at/completed_at is.
    const checkRuns = [
      checkRun({
        status: 'completed',
        conclusion: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /completed but has no conclusion/,
    );
  });

  it('REGRESSION: refuses a queued run carrying a non-null conclusion instead of silently normalizing it away', () => {
    // The inverse contract violation: GitHub only sets `conclusion` once a
    // run reaches `status: "completed"`. A still-`queued` (or in-progress)
    // run reporting a non-null conclusion such as "failure" should not
    // happen per the documented API contract, but a malformed or buggy
    // response could send it. The prior behaviour silently discarded the
    // conclusion and normalized the run to `pending` -- exactly the kind
    // of "plausible-looking but wrong" misreporting this file exists to
    // prevent, since `main` would then exit clean instead of failing
    // closed on a structurally invalid input.
    const checkRuns = [
      checkRun({
        status: 'queued',
        conclusion: 'failure',
        started_at: null,
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /has status "queued" but a non-null conclusion/,
    );
  });

  it.each([
    ['completed', null, /completed but has no conclusion/],
    ['queued', 'failure', /has status "queued" but a non-null conclusion/],
    ['queued', 'success', /has status "queued" but a non-null conclusion/],
    [
      'in_progress',
      'cancelled',
      /has status "in_progress" but a non-null conclusion/,
    ],
  ] as const)(
    'REGRESSION (table-driven): rejects the impossible status=%s/conclusion=%s pairing rather than normalizing it to a plausible-looking verdict',
    (status, conclusion, expectedMessage) => {
      const overrides: Record<string, unknown> = { status, conclusion };
      if (status !== 'completed') {
        overrides.started_at = null;
        overrides.completed_at = null;
      }
      const checkRuns = [checkRun(overrides)];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(expectedMessage);
    },
  );

  it.each(['queued_up', 'started', 'done', 'COMPLETED', ''])(
    'REGRESSION: rejects an unrecognized status %j instead of silently treating it as pending',
    (status) => {
      // GitHub documents a fixed set of status values (queued, in_progress,
      // completed, waiting, requested, pending). A typo, API-version drift,
      // or malformed response could send anything else. Prior behaviour let
      // any string other than "completed" fall through the completed-only
      // checks and resolve to a normal-looking `pending` run -- exactly the
      // kind of structurally invalid input this file must fail closed on
      // instead of reporting a plausible-looking verdict for.
      const checkRuns = [
        checkRun({
          status,
          conclusion: null,
          started_at: null,
          completed_at: null,
        }),
      ];
      expect(() => latestCheckRunsByName(checkRuns)).toThrow(
        status === '' ? /has no status/ : /has an unrecognized status/,
      );
    },
  );

  it('REGRESSION: an in-progress rerun outranks an older completed run for the same name, even with a lower id', () => {
    // Live Checks API data showed the opposite of what id-ordering assumes:
    // a later-started rerun can carry a LOWER check-run id than an older,
    // already-completed run for the same name. An in-flight run is always
    // the live state of that check regardless of id, so it must win here
    // even though its id (2) is lower than the completed run's id (9) --
    // because it was created after that completed run (see
    // compareCheckRunRecency, which compares created_at as the sole
    // recency signal).
    const checkRuns = [
      checkRun({
        id: 9,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:05:00Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-08-06T16:09:50Z',
        started_at: '2026-08-06T16:10:00Z',
        completed_at: null,
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('Desktop')?.id).toBe(2);
    expect(latest.get('Desktop')?.conclusion).toBeNull();
    expect(classifyConclusion(latest.get('Desktop')!.conclusion)).toBe(
      VERDICT_PENDING,
    );
  });

  it("REGRESSION: a stale in-progress run that started before a newer completed rerun does not mask that rerun's real verdict", () => {
    // The "open always wins" heuristic must be bounded: a genuinely stale
    // in_progress run -- e.g. a hung runner that never reported back --
    // that started BEFORE some later rerun both started and finished must
    // not be reported as the latest attempt just because it is still open.
    // If it were, latestCheckRunsByName would report this check `pending`
    // forever, hiding the completed rerun's real (possibly failing)
    // verdict behind a run that will never resolve.
    const checkRuns = [
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-08-06T14:59:50Z',
        started_at: '2026-08-06T15:00:00Z',
        completed_at: null,
      }),
      checkRun({
        id: 9,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-08-06T15:59:50Z',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:05:00Z',
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('Desktop')?.id).toBe(9);
    expect(classifyConclusion(latest.get('Desktop')!.conclusion)).toBe(
      VERDICT_FAILED,
    );
  });

  it('REGRESSION: an in-progress run that started in the same reported second as a completed run does not outrank it -- an exact-second tie on started_at is ambiguous, not a win for either side (fails closed rather than reporting a possibly-wrong pending)', () => {
    // Vasquez (round 8, still valid after the round-10 fix that switched
    // the primary recency signal from completed_at to started_at, see
    // compareCheckRunRecency's doc comment): the Checks API only reports
    // second-resolution timestamps, so two runs for the same name --
    // whether or not either has completed -- can genuinely report the
    // same started_at to the second. An exact tie on the one signal this
    // comparator trusts does not prove either run is newer, so this must
    // fail closed (throw), not silently pick a side.
    const checkRuns = [
      checkRun({
        id: 9,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:05:00Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it('REGRESSION: main() exits undetermined (not a clean pass) when an in-progress run ties a completed run to the second on started_at', () => {
    const checkRuns = [
      checkRun({
        id: 9,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:05:00Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: null,
      }),
    ];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload(checkRuns),
      })),
      () => {},
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: a completed run that started earlier but took longer to finish does not outrank a completed rerun that started later but finished faster (Ripley, round 10)', () => {
    // Comparing by completed_at alone (the prior design) let a slow job
    // that started FIRST but ran long finish AFTER a fast rerun that
    // started SECOND -- so the older attempt "won" purely because it took
    // longer, even though the newer attempt (by started_at, the one true
    // signal for "which attempt is newer" regardless of how long each
    // took) had already superseded it. Concrete repro (Ripley): a
    // completed failure that started at 12:00 and ran 10 minutes vs a
    // completed success rerun that started at 12:05 (definitely the
    // later attempt) but finished in 1 minute. The later-started run must
    // win regardless of which one completed later in wall-clock time.
    const olderSlower = checkRun({
      id: 1,
      name: 'Desktop',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-08-06T12:00:00Z',
      completed_at: '2026-08-06T12:10:00Z',
    });
    const newerFaster = checkRun({
      id: 2,
      name: 'Desktop',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-08-06T12:05:00Z',
      completed_at: '2026-08-06T12:06:00Z',
    });
    for (const checkRuns of [
      [olderSlower, newerFaster],
      [newerFaster, olderSlower],
    ]) {
      const latest = latestCheckRunsByName(checkRuns);
      expect(latest.get('Desktop')?.id).toBe(2);
      expect(latest.get('Desktop')?.conclusion).toBe('success');
    }
  });

  it('REGRESSION: two runs created in the exact same second -- a completed failure and a queued rerun -- cannot be safely ordered, and must not silently mask the failure behind a false pending (Ralph round-8 repro, restated for the created_at-only design)', () => {
    // Vasquez (round 8): under the pre-rewrite design, a still-queued run's
    // `created_at` was bounded against the completed run's `completed_at`
    // using `>=`, so a queued run created in the exact same second a
    // completed `failure` finished would unconditionally "win", printing
    // `pending` and exiting clean (0) instead of surfacing the real
    // failure -- a merge-gate bypass.
    //
    // After the round-8 architectural rewrite (compareCheckRunRecency now
    // compares `created_at` alone, for every run regardless of status --
    // see that function's doc comment for why), the equivalent genuine
    // tie is two runs sharing the exact same `created_at`: a batch of
    // check runs dispatched in the same second, one of which happens to
    // already be `completed` while another of the same name is still
    // `queued`. Neither run's own creation timestamp proves it is the
    // newer attempt, so this must fail closed (throw) rather than
    // resolving in favor of either side.
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-08-06T15:58:00Z',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        created_at: '2026-08-06T15:58:00Z',
        started_at: null,
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it("REGRESSION (end-to-end): main() exits undetermined, not a clean pass, on Ralph round-8's exact-created_at queued-vs-completed-failure tie", () => {
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-08-06T15:58:00Z',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        created_at: '2026-08-06T15:58:00Z',
        started_at: null,
        completed_at: null,
      }),
    ];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload(checkRuns),
      })),
      () => {},
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: a queued run with no started_at yet cannot be safely ordered against a completed run for the same name, and fails closed rather than guessing either way', () => {
    // Before the round-8 rewrite (and its since-reverted `created_at`
    // follow-up, see compareCheckRunRecency's doc comment for why that was
    // wrong), a still-queued run's `created_at` was used to bound it
    // against a completed run's own timestamp -- if the queued run was
    // created after the completed run finished, the queued run "won";
    // otherwise the completed run did. `created_at` is not a field the
    // Checks API actually returns on a check-run object at all, so that
    // bound cannot exist anymore: a run that has not started yet carries
    // no timestamp whatsoever the API guarantees. There is therefore no
    // sound basis to say the queued run is newer OR older than the
    // completed run -- confidently picking either side would be an
    // unfounded assumption, so this must fail closed (throw), the same as
    // any other genuinely unresolvable pair.
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it('REGRESSION: a queued run with no started_at yet does not mask a completed failure behind a false pending -- it fails closed instead of silently winning', () => {
    // The specific false-pass shape Vasquez originally flagged (round 7):
    // an orphaned queued run for a name that already has a completed
    // `failure` must not be reported as "the latest attempt" just because
    // it is still open, since that would print `pending` and let `main`
    // exit clean (0) when a real check actually failed. Without any
    // timestamp for the queued run (see the test above for why), the fix
    // is not to swap in a different winner -- it is to refuse to pick a
    // winner at all, which is exactly as safe a non-outcome as reporting
    // the failure would be: either way, `main` does NOT exit clean.
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it('REGRESSION (end-to-end): main() does not exit clean when a queued run with no started_at coexists with a completed failure -- it exits undetermined, never a false pass', () => {
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
      checkRun({
        id: 2,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:59:29Z',
      }),
    ];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload(checkRuns),
      })),
      () => {},
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: fails closed (throws) when two still-open runs for the same name have neither started yet', () => {
    // Two queued runs for the same check, neither started: there is no
    // timestamp signal at all to order them by, and id is not a safe
    // substitute (same reasoning as the completed/completed tie above).
    const checkRuns = [
      checkRun({
        id: 5,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
      checkRun({
        id: 6,
        name: 'Desktop',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });

  it('REGRESSION: fails closed (throws) when two still-open runs for the same name share an identical started_at', () => {
    const checkRuns = [
      checkRun({
        id: 7,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: null,
      }),
      checkRun({
        id: 8,
        name: 'Desktop',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /cannot determine the latest attempt/,
    );
  });
});

describe('buildVerdicts', () => {
  it('classifies the positive control, negative control, and the cancelled case together', () => {
    const checkRuns = [
      checkRun({ id: 1, name: 'Citation reachability', conclusion: 'failure' }),
      checkRun({ id: 2, name: 'Stacked base', conclusion: 'success' }),
      checkRun({ id: 3, name: 'Sequencing hold', conclusion: 'cancelled' }),
    ];
    const verdicts = buildVerdicts(checkRuns);
    expect(verdicts).toEqual([
      {
        name: 'Citation reachability',
        conclusion: 'failure',
        verdict: VERDICT_FAILED,
      },
      {
        name: 'Sequencing hold',
        conclusion: 'cancelled',
        verdict: VERDICT_SUPERSEDED,
      },
      { name: 'Stacked base', conclusion: 'success', verdict: VERDICT_PASSED },
    ]);
  });

  it('rejects an empty check-run list rather than reporting an empty clean verdict', () => {
    expect(() => buildVerdicts([])).toThrow(/no check runs/);
  });
});

describe('formatReport', () => {
  it('calls out superseded checks as carrying no verdict, distinct from failed', () => {
    const report = formatReport('abc123', [
      {
        name: 'Sequencing hold',
        conclusion: 'cancelled',
        verdict: VERDICT_SUPERSEDED,
      },
    ]);
    expect(report).toContain('superseded');
    expect(report).toContain('not a failure, no verdict');
  });
});

describe('resolveRepo', () => {
  it('falls back to gh repo view when nothing else is set', () => {
    const repo = resolveRepo(
      undefined,
      {},
      stub(() => ({ status: 0, stdout: 'o/r\n' })),
    );
    expect(repo).toBe('o/r');
  });
});

function pageObj(rows: unknown[], totalCount = rows.length) {
  return { total_count: totalCount, check_runs: rows };
}

// `fetchCheckRuns` now issues a single `gh api ... --paginate --slurp` call
// and lets `gh` itself follow the API's `Link` header across every page
// (see the comment on `fetchCheckRuns`). `--slurp` wraps every page `gh`
// fetched into one outer JSON array, so the stub's `stdout` here always
// represents *all* pages `gh` would have returned for a given scenario --
// there is no separate stub invocation per page.
function pagePayload(rows: unknown[], totalCount = rows.length) {
  return JSON.stringify([pageObj(rows, totalCount)]);
}

function slurpPayload(pages: ReturnType<typeof pageObj>[]) {
  return JSON.stringify(pages);
}

describe('fetchCheckRuns', () => {
  it('parses the check_runs array from gh api', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub((_command, argv) => {
        expect(argv[1]).toBe(
          'repos/o/r/commits/abc123/check-runs?per_page=100',
        );
        expect(argv).toContain('--paginate');
        expect(argv).toContain('--slurp');
        return {
          status: 0,
          stdout: pagePayload([checkRun({ id: 1 })]),
        };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.checkRuns).toHaveLength(1);
  });

  it('reports undetermined when gh api fails', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('HTTP 404');
  });

  it('reports undetermined on an empty check-runs array', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 0, stdout: pagePayload([], 0) })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'no check runs found',
    );
  });

  it('reports undetermined when gh returns no pages at all', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 0, stdout: slurpPayload([]) })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('no pages');
  });

  it('REGRESSION: pages through a commit with more than 100 check runs instead of silently dropping the rest', () => {
    // `--paginate --slurp` means `gh` itself made every request and handed
    // back one page object per request it followed via the Link header --
    // this simulates the two page objects `gh` would slurp for 137 rows.
    const totalRows = 137;
    const allRuns = Array.from({ length: totalRows }, (_, i) =>
      checkRun({ id: i + 1, name: `check ${i + 1}` }),
    );
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({
        status: 0,
        stdout: slurpPayload([
          pageObj(allRuns.slice(0, 100), totalRows),
          pageObj(allRuns.slice(100), totalRows),
        ]),
      })),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.checkRuns).toHaveLength(totalRows);
  });

  it('REGRESSION: fails closed when a full first page hides a real check-run behind an under-reported total_count', () => {
    // The API reports total_count=100 but `gh`'s own Link-header-driven
    // pagination still followed a real "next" link to a second page
    // holding one more row (e.g. a still-running or newly failed check).
    // `total_count` never accounted for it. This must report undetermined
    // rather than a (possibly clean) verdict based on the stale total.
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({
        status: 0,
        stdout: slurpPayload([
          pageObj(
            Array.from({ length: 100 }, (_, i) => checkRun({ id: i + 1 })),
            100,
          ),
          pageObj(
            [
              checkRun({
                id: 101,
                name: 'late failure',
                conclusion: 'failure',
              }),
            ],
            100,
          ),
        ]),
      })),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'reported total_count=100 but pagination',
    );
  });

  it('REGRESSION: fails closed when a full page then an empty page hides a real check-run on a would-be third page', () => {
    // Round-4 finding: a prior row-count-based implementation trusted an
    // empty page (0 rows) as proof pagination was complete once
    // collected.length matched total_count, even though an empty page does
    // not, by itself, rule out further real data. Here `gh`'s own
    // Link-header-driven pagination still followed a "next" link past the
    // empty page to a real third page holding a genuine failure -- exactly
    // the scenario an empty-page-trusting implementation would silently
    // miss. Because this implementation no longer decides "done" itself at
    // all (gh's Link header already decided that before slurping), the
    // hidden row is present in the collected set, and the total_count
    // cross-check (100 reported vs. 101 actually collected) still catches
    // the inconsistency and fails closed.
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({
        status: 0,
        stdout: slurpPayload([
          pageObj(
            Array.from({ length: 100 }, (_, i) => checkRun({ id: i + 1 })),
            100,
          ),
          pageObj([], 100),
          pageObj(
            [
              checkRun({
                id: 102,
                name: 'hidden failure past an empty page',
                conclusion: 'failure',
              }),
            ],
            100,
          ),
        ]),
      })),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'reported total_count=100 but pagination',
    );
  });

  it('reports undetermined when total_count changes mid-page rather than trusting a moving target', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({
        status: 0,
        stdout: slurpPayload([
          pageObj(
            Array.from({ length: 100 }, (_, i) => checkRun({ id: i + 1 })),
            150,
          ),
          pageObj(
            Array.from({ length: 50 }, (_, i) => checkRun({ id: i + 101 })),
            200,
          ),
        ]),
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'total_count changed',
    );
  });

  it('reports undetermined when the response spans an implausible number of pages', () => {
    const pages = Array.from({ length: 1001 }, (_, i) =>
      pageObj([checkRun({ id: i + 1 })], 1001),
    );
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 0, stdout: slurpPayload(pages) })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('safety cap');
  });
});

describe('main', () => {
  it('exits clean when the only non-passing conclusion is cancelled (the #562 regression)', () => {
    const output: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({ id: 1, name: 'Sequencing hold', conclusion: 'cancelled' }),
          checkRun({ id: 2, name: 'Stacked base', conclusion: 'success' }),
        ]),
      })),
      (text: string) => output.push(text),
    );

    expect(result).toBe(EXIT_CLEAN);
    expect(output.join('\n')).not.toContain('failed     Sequencing hold');
  });

  it('POSITIVE CONTROL: exits failed when a genuine failure is present', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Citation reachability',
            conclusion: 'failure',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_FAILED);
  });

  it('NEGATIVE CONTROL: exits clean when everything is success', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({ id: 1, name: 'Stacked base', conclusion: 'success' }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_CLEAN);
  });

  it('exits undetermined when the check-runs query cannot be executed', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('exits undetermined when --sha is missing', () => {
    const result = main(
      ['--repo', 'o/r'],
      {},
      stub(() => ({ status: 0, stdout: pagePayload([], 0) })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a completed run with conclusion: null, rather than a clean exit', () => {
    // This drives the real `main()` entry point rather than just
    // `parseCheckRun`/`latestCheckRunsByName` in isolation -- the thing
    // that was originally wrong was the *process-level* outcome (main
    // exiting 0/clean on this malformed shape), not merely that a lower
    // -level helper failed to throw.
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed completed check',
            status: 'completed',
            conclusion: null,
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a queued run carrying a non-null conclusion, rather than a clean exit', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed queued check',
            status: 'queued',
            conclusion: 'failure',
            started_at: null,
            completed_at: null,
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for an unrecognized status value, rather than treating it as pending', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed status check',
            status: 'started', // not a status GitHub documents
            conclusion: null,
            started_at: null,
            completed_at: null,
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a still-open run carrying a non-null completed_at', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed in-progress check',
            status: 'in_progress',
            conclusion: null,
            started_at: '2026-08-06T15:58:29Z',
            completed_at: '2026-08-06T15:59:29Z',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a whitespace-only check name', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([checkRun({ id: 1, name: '   ' })]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a completed run with completed_at earlier than started_at', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed timestamp-order check',
            started_at: '2026-08-06T16:00:00Z',
            completed_at: '2026-08-06T15:00:00Z',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a completed_at in RFC 2822 shape instead of GitHub-documented ISO 8601', () => {
    // Date.parse alone would accept this shape; GitHub's Checks API never
    // actually emits it, so it must fail closed the same as any other
    // drifted/malformed API response this file already guards against.
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Malformed timestamp-shape check',
            started_at: '2026-08-06T16:00:00Z',
            completed_at: 'Thu, 06 Aug 2026 16:05:00 GMT',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: exits undetermined end-to-end for a completed_at with an impossible calendar date (Feb 30)', () => {
    // The ISO 8601 shape regex alone accepts this string -- "2026-02-30"
    // matches \d{4}-\d{2}-\d{2} -- but Feb 30 is not a real date.
    // Date.parse would silently normalize it to March 2nd instead of
    // rejecting it, so this must be caught by explicit calendar
    // validation, not by shape or Date.parse alone.
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 1,
            name: 'Impossible calendar date check',
            started_at: '2026-02-01T00:00:00Z',
            completed_at: '2026-02-30T00:00:00Z',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('REGRESSION: end-to-end, a stale in-progress run does not mask a newer completed failure behind a pending exit', () => {
    // End-to-end version of the isNewerCheckRun bound: without it, this
    // scenario would exit EXIT_CLEAN (the stale in_progress run reads as
    // "pending", never as the genuine failure that actually happened),
    // exactly the false-negative "everything's fine" misreporting this
    // file exists to prevent.
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({
            id: 2,
            name: 'Desktop',
            status: 'in_progress',
            conclusion: null,
            created_at: '2026-08-06T14:59:50Z',
            started_at: '2026-08-06T15:00:00Z',
            completed_at: null,
          }),
          checkRun({
            id: 9,
            name: 'Desktop',
            status: 'completed',
            conclusion: 'failure',
            created_at: '2026-08-06T15:59:50Z',
            started_at: '2026-08-06T16:00:00Z',
            completed_at: '2026-08-06T16:05:00Z',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_FAILED);
  });

  it('REGRESSION: end-to-end, an ANSI-escape-laden check name is sanitized before it reaches the report', () => {
    const written: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({ id: 1, name: '\x1b[31mDANGER\x1b[0m Desktop' }),
        ]),
      })),
      (text) => {
        written.push(text);
      },
    );
    expect(result).toBe(EXIT_CLEAN);
    const report = written.join('\n');
    // Exclude \n (0x0a) from the control-character check: formatReport
    // legitimately emits multi-line output. The property under test is
    // that no OTHER control byte (in particular ESC, 0x1b) survives.
    // eslint-disable-next-line no-control-regex -- asserting the absence of control characters is the point of this regression test.
    expect(report).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(report).toContain('[31mDANGER[0m Desktop');
  });

  it('REGRESSION: end-to-end, a C1 control character (e.g. the single-byte CSI) in a check name is sanitized before it reaches the report', () => {
    // C0 controls (\x00-\x1f) and DEL (\x7f) are not the only control
    // bytes ANSI terminals act on -- the C1 range (\x80-\x9f) includes a
    // single-byte form of CSI (\x9b) that can introduce the same escape
    // sequences as ESC + '[' can. A sanitizer that only strips C0/DEL
    // would let this class through untouched.
    const written: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({ id: 1, name: '\x9b31mDANGER\x9b0m Desktop' }),
        ]),
      })),
      (text) => {
        written.push(text);
      },
    );
    expect(result).toBe(EXIT_CLEAN);
    const report = written.join('\n');
    // eslint-disable-next-line no-control-regex -- asserting the absence of control characters is the point of this regression test.
    expect(report).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(report).toContain('31mDANGER0m Desktop');
  });

  it('REGRESSION: end-to-end, a Unicode bidi-control character (U+202E RIGHT-TO-LEFT OVERRIDE) in a check name is sanitized before it reaches the report', () => {
    // U+202A-U+202E (bidi embeddings/overrides) and U+2066-U+2069 (bidi
    // isolates) are not C0/C1/DEL control bytes, so the byte-range-only
    // sanitizer let them through -- an attacker-controlled name containing
    // one can still visually reorder or override the displayed order of
    // surrounding text in any terminal or renderer that honors Unicode
    // bidi controls, the same class of "attacker name spoofs what is
    // read" attack the ANSI/control-byte stripping above was added to
    // close, just via a different mechanism.
    const written: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([
          checkRun({ id: 1, name: '\u202eDesktop (evil)\u202c' }),
        ]),
      })),
      (text) => {
        written.push(text);
      },
    );
    expect(result).toBe(EXIT_CLEAN);
    const report = written.join('\n');
    expect(report).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(report).toContain('Desktop (evil)');
  });

  it('REGRESSION: end-to-end, Unicode line/paragraph separators (U+2028, U+2029) in a check name are sanitized so they cannot forge an extra visual report row', () => {
    // Vasquez (round 17): U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
    // SEPARATOR) are real newline-equivalent characters honored by many
    // terminals/renderers, but sat outside the C0/C1/DEL/bidi ranges the
    // sanitizer covered. A name embedding one -- e.g.
    // "safe\u2028  passed     Desktop" -- could make a renderer display an
    // apparent second, fabricated report line ("  passed     Desktop") that
    // never came from `buildVerdicts`, the same "attacker name spoofs what
    // is read" attack class the rest of this sanitization exists to close.
    const maliciousName = 'safe\u2028  passed     Desktop';
    const written: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([checkRun({ id: 1, name: maliciousName })]),
      })),
      (text) => {
        written.push(text);
      },
    );
    expect(result).toBe(EXIT_CLEAN);
    const report = written.join('\n');
    expect(report).not.toMatch(/[\u2028\u2029]/);
    // The sanitized name still appears intact as ordinary printable text --
    // this is sanitization (character removal), not corruption of the rest
    // of the label.
    expect(report).toContain('safe  passed     Desktop');
    // Splitting the actual output on real newlines must not produce a
    // fabricated extra line that looks like its own check result -- proving
    // the report has exactly the one line this single check run should
    // produce (plus the two-line header), not a forged second row.
    const reportLines = report.split('\n');
    const checkLines = reportLines.filter(
      (line) => line.includes('safe') || line.includes('passed     Desktop'),
    );
    expect(checkLines).toHaveLength(1);
  });

  it('REGRESSION: end-to-end, Unicode zero-width characters and the byte-order mark in a check name are sanitized via the general Cf (format) category, not just enumerated bidi code points', () => {
    // Vasquez (round 8, adversarial): the bidi-control fix only enumerated
    // specific code points (U+202A-U+202E, U+2066-U+2069). Zero-width
    // space/joiners (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ) and the
    // byte-order mark (U+FEFF) are a distinct invisible-character attack
    // class -- not visual reordering, but invisible insertion/splicing --
    // that sat outside those enumerated ranges and so still reached report
    // output unstripped. Rather than enumerate yet another one-off list of
    // code points, `CONTROL_CHARS_PATTERN` now matches the whole Unicode
    // "Cf" (format) general category via `\p{Cf}`, which covers these
    // characters (and any other invisible/format codepoint in that
    // category) in one pass.
    const maliciousName = 'Desktop\u200B\u200C\u200D\uFEFF (evil)';
    const written: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: pagePayload([checkRun({ id: 1, name: maliciousName })]),
      })),
      (text) => {
        written.push(text);
      },
    );
    expect(result).toBe(EXIT_CLEAN);
    const report = written.join('\n');
    expect(report).not.toMatch(/\u200b|\u200c|\u200d|\ufeff/);
    expect(report).toContain('Desktop (evil)');
  });
});
