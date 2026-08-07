# npm-ci-strict Cleanup Recurrence Advisory

> **Document:** Operational interpretation of the cleanup-recurrence advisory.
> **Owner:** Vasquez (`squad:vasquez`)
> **Closes:** #450

## What This Advisory Does

The cleanup-recurrence advisory (`scripts/check-cleanup-recurrence.mjs`) scans
the durable record on tracking issue [#274] for `npm-ci-strict` cleanup-failure
evidence and classifies whether the same failure signature has appeared on two
or more distinct commit SHAs, each on their own first attempt (`run_attempt=1`).

It is surfaced by the **Cleanup recurrence advisory** workflow
(`.github/workflows/cleanup-recurrence-advisory.yml`), which runs on a weekly
schedule and can be triggered manually with `workflow_dispatch`.

### Exit codes

| Exit code | Meaning                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | No recurrence — fewer than two distinct first-attempt SHAs carry the cleanup signature in the scanned window.                                       |
| `1`       | **Recurrence confirmed** — two or more distinct first-attempt SHAs carry the cleanup signature. This is an environmental signal, not a code defect. |
| `2`       | **Undetermined** — the scan could not complete cleanly (API error, rate-limit, malformed response). Treat as unknown, not as clean.                 |

---

## What the Advisory Proves

A **recurrence confirmed** result proves that:

1. The `npm-ci-strict` cleanup detector fired on at least two commits that each
   had no prior recorded cleanup failure on a rerun attempt — these were
   independent first-attempt run failures, not reruns of one event.
2. Each failure was followed by a later green run on a different commit with no
   lockfile, dependency, workflow, or guard change that would explain the
   recovery (per the measurements in #450).
3. The sequence matches the environmental recurrence pattern identified in #450:
   the condition is a property of the runner's disk state, not of any commit's
   source changes. A green run after a red one is a different machine drawing a
   clean disk, not a fixed bug.

---

## What the Advisory Does NOT Prove

- **It does not prove the condition is ongoing.** The tracked evidence is
  historical. The most recent comment on issue #274 gives the last known
  occurrence, not the current state.
- **It does not calculate a recurrence rate.** Four occurrences in a seven-hour
  window (as measured in #450) is a data point, not a stable frequency.
- **It does not prove the condition has stopped.** A clean result means no
  evidence was found in the scanned window — absence of evidence is not
  evidence of absence.
- **It does not identify the root cause.** The `EPERM: operation not permitted,
rmdir` error is a runner-state condition. This advisory measures its
  prevalence; it does not diagnose or fix it.
- **It is not a merge blocker.** The advisory is non-blocking. A recurrence
  finding does not prevent any PR from merging.

---

## How Separate First-Attempt Runs Differ from Reruns

The repository already has tooling for a related but distinct hazard:
`check-rerun-masked-failures.mjs` (issues [#356], [#580]) detects when a
required context failed on a **superseded attempt** of the same run — a rerun
laundering one run's red into a green.

This advisory addresses a different laundering agent: **the next commit**.

|           | Rerun masking (#356/#580)                         | Commit-step masking (#450)             |
| --------- | ------------------------------------------------- | -------------------------------------- |
| Mechanism | Rerun of the same run                             | Next push on a different commit        |
| Agent     | `run_attempt = 2, 3, …` overwriting `attempt = 1` | Later green `attempt = 1` on a new SHA |
| Tool      | `check-rerun-masked-failures.mjs`                 | `check-cleanup-recurrence.mjs`         |
| Hazard    | Required context failure erased by rerun          | True positive disguised as a flake     |

A rerun of a run that already carried a cleanup failure does **not** add a
new entry to the distinct-SHA count, because it is not evidence of a second
independent commit being affected. This is enforced explicitly: only entries
with `attempt=1` in the published comment marker are counted.

---

## Bounded History Window

The scan examines at most `HISTORY_COMMENT_LIMIT` (200) of the most recent
comments on the tracking issue. This is sufficient to cover the measurements
in #450 by a wide margin. If the scan reaches the limit, it reports `bounded`
in its output and the bound is noted in the advisory text.

The bound exists so the tool's runtime is predictable and the API call count
is explicit. An unbounded scan could page through arbitrarily large issue
histories without a declared stopping condition.

Pagination within the bound is handled comment-by-comment: the tool requests
at most `PAGE_SIZE` (100) comments per page and stops when the issue is
exhausted or the limit is reached.

---

## How Maintainers Should Respond

**If the advisory exits 1 (recurrence confirmed):**

1. Check the listed SHAs and run IDs in the output against the tracking issue
   comments to confirm the evidence is current and complete.
2. Do **not** mark the occurrence as a flake in any CI status dashboard. It is
   a true positive.
3. If recurrence frequency is increasing, consider filing a follow-up issue to
   track the runner-state root cause (see #195 for prior history).
4. The `npm-ci-strict` guard remains unchanged and continues to catch the
   condition. The only thing that changes when recurrence is confirmed is that
   a maintainer reading the run list now has a machine-verified signal that the
   red run was not a one-off.
5. If a recovery rerun is needed, use the **NPM cleanup recovery** workflow
   (`npm-cleanup-recovery.yml`) — not a manual re-run. That workflow records
   the authorization on tracking issue #274 before requesting the rerun.

**If the advisory exits 2 (undetermined):**

1. Check the workflow run log for the specific API error.
2. If the cause is rate-limiting, wait and trigger `workflow_dispatch` again.
3. If the cause is a malformed response, open an issue for investigation.
4. Do **not** treat an undetermined result as a clean result.

---

## Related Infrastructure

| Document                                             | Purpose                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `scripts/npm-ci-strict.mjs`                          | The guard that detects the cleanup failure and writes evidence. **Not changed by this work.** |
| `scripts/publish-npm-cleanup-evidence.mjs`           | Publishes the durable comment to issue #274. The data this advisory reads.                    |
| `scripts/discharge-npm-cleanup-failure.mjs`          | Authorized recovery workflow — required before any rerun of a cleanup failure.                |
| `docs/npm-cleanup-recovery.md`                       | Runbook for the recovery procedure.                                                           |
| `scripts/check-rerun-masked-failures.mjs`            | The separate rerun-masking detector (issues #356/#580).                                       |
| `.github/workflows/publish-npm-cleanup-evidence.yml` | Posts evidence to #274 on each cleanup failure.                                               |

[#274]: https://github.com/OlyForge3D/PrintFarmerDesktop/issues/274
[#356]: https://github.com/OlyForge3D/PrintFarmerDesktop/issues/356
[#580]: https://github.com/OlyForge3D/PrintFarmerDesktop/issues/580
