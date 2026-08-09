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
        started_at: '2026-08-06T15:58:29Z',
        completed_at: '2026-08-06T15:58:35Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 2,
        started_at: '2026-08-06T15:58:30Z',
        completed_at: '2026-08-06T15:58:40Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 3,
        started_at: '2026-08-06T15:59:53Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 4,
        started_at: '2026-08-06T16:00:16Z',
        completed_at: '2026-08-06T16:00:30Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 5,
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

  it('REGRESSION: breaks a completed_at tie by started_at, not id, when a later rerun has a LOWER id', () => {
    // `completed_at` is only second-resolution, so two reruns of a fast job
    // can genuinely finish in the same reported second. Live Checks API
    // data on this repo showed exactly that (two "Stacked base" completions
    // tied on completed_at) with the later rerun carrying a LOWER id than
    // the earlier one -- falling back to id at the completed_at-tie point
    // is exactly as unsound as ordering by id everywhere. started_at is an
    // independent timestamp signal not tied to that same-second collision,
    // and the later-started run is, definitionally, the later attempt.
    const checkRuns = [
      checkRun({
        id: 42,
        started_at: '2026-08-06T16:00:00Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'failure',
      }),
      checkRun({
        id: 7,
        started_at: '2026-08-06T16:00:03Z',
        completed_at: '2026-08-06T16:00:05Z',
        conclusion: 'success',
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    // The lower-id run (7) started later, so it is the true latest attempt
    // -- picking it means the earlier failure is correctly superseded
    // rather than left standing as the reported verdict.
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

  it('still refuses a completed run that carries no started_at at all, which is genuinely malformed', () => {
    const checkRuns = [
      checkRun({
        status: 'completed',
        conclusion: 'success',
        started_at: null,
      }),
    ];
    expect(() => latestCheckRunsByName(checkRuns)).toThrow(
      /completed but has no started_at/,
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
    // even though its id (2) is lower than the completed run's id (9).
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

  it('the latest-run selection still works when the newest run for a name is queued with no started_at', () => {
    const checkRuns = [
      checkRun({
        id: 1,
        name: 'Desktop',
        status: 'completed',
        conclusion: 'success',
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
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('Desktop')?.id).toBe(2);
    expect(latest.get('Desktop')?.startedAt).toBeNull();
    expect(classifyConclusion(latest.get('Desktop')!.conclusion)).toBe(
      VERDICT_PENDING,
    );
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
});
