---
name: testing
description: The validation commands for PrintFarmer Desktop and the traps that make CI fail after they pass locally. Read before running validation or claiming a change is green.
---

# Testing and validation

Run the **smallest complete** validation that covers your change. Complete matters more than small: a targeted run that skips the layer you changed is not validation.

**Before reporting a negative result — "that path is unreachable", "this is safe", "I could not reproduce it" — state the observation that would have produced the opposite finding.** If you cannot name one, you measured a case, not the class. An experiment that _confirms_ a prediction and one that _risked_ it are both real measurements, and only the second licenses a claim about a class. This is the same rule as "an assertion that cannot fail proves nothing", pointed at reports rather than at tests, where nothing else is checking. See `.squad/decisions/inbox/vasquez-falsifiable-negatives.md` — it cost PR #149 two retractions, one of them a shared conclusion the lead had already ratified.

## A positive control validates the instrument, not the operationalisation

The rule above — pair a zero-result search with a positive control that fires — answers one question: **can the instrument speak?** It cannot answer a second, independent question: **is the searched artifact a place this evidence would necessarily appear?** Nothing in "run a control that fires" examines that mapping from claim to instrument, so when the mapping is wrong, a firing control converts a bad proxy into a _confident_ null. A controlled zero then carries more authority than an uncontrolled one, while being no more true.

So before reporting any zero as a null, ask both questions and answer the second one by name, not by assumption:

1. **Can the instrument speak?** — a positive control fires on a known-present case, using the same method. (unchanged)
2. **Is the searched artifact a place this evidence would _necessarily_ appear?** — name the mechanism by which the evidence would have arrived there. If you cannot name the mechanism, the search is not evidence and must not be reported as a null at all — with or without a control.

Three instances from a single review session (issue #361), each with a control that fired and a null that was worthless because question 2 had no answer:

- **Grepping the wrong artifact for the wrong layer.** Claim: a package is darwin-only. Instrument: grep the CI job log for `darwin`. Result: 0, control (`EPERM`) fires at 2. The control was sound; the null was worthless — a platform constraint lives in the **dependency tree**, not in a job log's output, so the log had no mechanism by which the word would ever appear. It later turned out the constraint was a **path property** inherited from an ancestor package, while the failing nodes declared no `os` restriction of their own — so even grepping the _lockfile_ near the failing package would have returned a controlled zero. No text search at either end could see it; only walking the dependency path could.
- **Confusing absence-from-disk with absence-from-the-tree.** Claim: a residue is invisible to `npm ls --omit=dev --all --json`. Instrument: run it, count occurrences. Result: 0, control (`version`) fires at 11. The package was never installed on the machine — the zero measured its absence from disk, not its absence from the dependency tree the claim was actually about.
- **Reconstructing a case from analogy instead of from the artifact that defines it.** Having caught the second instance, the same reviewer reconstructed the residue by characterising it from an analogy they built — and still got it wrong, twice — because nothing independent fixed the reconstruction's identity. Only characterising it from the lockfile's own paths and versions reproduced the reported case, and reversed the conclusion.

**Corollary: an unsound-operationalisation zero is worse than an uncontrolled one.** An uncontrolled zero at least advertises its own uncertainty. A controlled zero over the wrong artifact reads as diligence — it ran the extra step, it has a passing control to point to — and that apparent rigor is exactly what stops the next reader from asking whether the artifact could ever have shown the signal. The control should raise your confidence in the _instrument_; it must never be read as raising your confidence in the _mapping_ between the claim and what you searched.

### The positive control itself must be aimed at the question's axis, not merely its corpus

The two questions above are about whether the searched artifact is the right place to look. A separate failure survives even when the artifact is right: **the positive control that is supposed to validate the instrument (question 1) can itself be aimed at the wrong axis of the same file, and passing it then certifies nothing about the axis the question actually turns on.**

**When a zero result is load-bearing, the positive control must be aimed at the same axis as the question, not merely at the same corpus.** Concretely, for a search:

- state the question in words before writing the pattern;
- ask what shape the answer would take **if the claim were false**, and confirm the pattern could match it;
- prefer a control that would fail if the pattern were misaimed — a known instance of the thing being denied, not an unrelated string that merely happens to share the file.

**Worked instance (#197).** Claim: no CI job named `package` exists. Instrument: enumerate `name:` lines in `ci.yml`, using a pattern shaped like `name: <label>`. Result: zero hits for `package`. Positive control: the same `name:`-line pattern matched `advisories` elsewhere in the file, four hits — the control fired, so the instrument was declared sound. The conclusion was still wrong: `ci.yml` declares `jobs.package:` as a job **key**, and job keys are not on `name:` lines at all. The control and the original query shared a corpus (the same file) and even a mechanism (grep for a string), but they sampled the **same wrong axis** — rendered display names — while the question was about job keys. A control aimed at the right axis, `git grep -n '^  package:' ci.yml`, returns the job key directly and refutes the claim; the control that was actually run could never have, no matter how many times it was rerun. Confirming that a query fires on *some* known-present string in the file is not the same as confirming it fires on a known-present instance of **the thing being asked about** — only the latter licenses trusting the zero.

## TypeScript / renderer / main

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run format      # prettier --check .
npm run test        # vitest run
```

`npm run format:write` (`prettier --write .`) fixes formatting; `npm run format` only checks.

## Rust (`native/`)

Run whichever cover your change:

```powershell
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml -p model-core --all-targets -- -D warnings
cargo clippy --manifest-path native/Cargo.toml -p model-core --all-targets --features sqlite -- -D warnings
cargo test --manifest-path native/Cargo.toml -p model-core
cargo test --manifest-path native/Cargo.toml -p model-core --features sqlite
```

If you touch the lib3mf path, also:

```powershell
cargo build --manifest-path native/Cargo.toml -p model-core --features lib3mf
cargo test  --manifest-path native/Cargo.toml -p model-core --features lib3mf
```

**Feature variants are not optional.** Code can compile and pass under default features and fail under `sqlite` or `lib3mf`. CI runs them; so should you.

## Traps that turn a green local run into a red CI run

**`npm run format` is `prettier --check .` over the whole repo — including markdown.** An unformatted `.md` file fails CI just as hard as broken code. This has bitten `.squad/decisions.md` more than once. Before committing docs:

```powershell
npx prettier --write <file>
```

**Each PowerShell call is a fresh process.** Working directory, environment variables, and virtualenv activation do not persist between calls. `cd` into your worktree at the start of every call.

**`GH_TOKEN` lacks the `workflow` scope.** Run `Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue` in every call that uses `gh` or `git push`.

**Do not clear an npm-tree or downstream SBOM completeness failure with a direct re-run.** On Windows, `npm ci` can report an `EPERM` cleanup failure as a warning and exit 0 while leaving a partial `node_modules` tree. `scripts/npm-ci-strict.mjs` retries only the directories npm itself requested, then validates the production tree; an unrecoverable failure is recorded durably on #274. The only authorized re-run path is `.github/workflows/npm-cleanup-recovery.yml`, with the exact run id, full head SHA, and a substantive justification. It verifies that every failed job's `Install dependencies` step failed and contains the discriminating anchor `could not finish removing node_modules`, records the authorization before rerunning, and refuses mixed failures. A downstream SBOM, licence, notice, advisory, test, or unrelated install failure is never eligible. See `docs/npm-cleanup-recovery.md`.

**The gate's bounded directory retry is not the forbidden job re-run (#274).** It acts only on npm-recorded `EPERM` / `rmdir` entries in the same job and still requires the production-tree check. A job re-run starts on a fresh runner and can orphan the failed attempt from ordinary commit queries, which is why it requires the durable, justified workflow above.

**`git grep` uses basic regex.** `|` is a literal unless you pass `-E`. This produced false "no matches" results while verifying acceptance criteria.

**PowerShell has no heredocs.** Use a single-quoted here-string piped to a command (`@'` … `'@ | python -`), or write the file with a file tool.

**`&&` only chains external commands** in PowerShell. Use `;` before PowerShell keywords.

Disable pagers: `git --no-pager ...`.

## CI gate

Eight required checks must pass:

- Closing-reference declaration
- Desktop (windows-latest)
- Desktop (macos-latest)
- Sidecar (windows-latest)
- Sidecar (macos-latest)
- Release package (windows-latest)
- Release package (macos-latest)
- Dependency advisories

**This list is a transcription, and the authoritative source is the branch-protection
endpoint — not this file.** It has been wrong before (see #152: it named the packaging job by a
name `ci.yml` had already renamed, and omitted `Dependency advisories`), and every agent reads
this file on activation, so a stale copy here misleads everyone at once. That transcription was
accurate the day it was written — the job was renamed afterwards, in an unrelated commit, and
nothing updated this file — so re-verify even when the list looks settled. A citation does not
have to be wrong when written to be wrong now:

```powershell
gh api repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection `
  --jq '.required_status_checks.contexts[]'
```

If that output disagrees with the list above, the endpoint wins — fix this file.

### "How many checks?" conflates three different numbers

| number                       | on an open PR | after it closes | is it a gate?     |
| ---------------------------- | ------------- | --------------- | ----------------- |
| required contexts            | 8             | 8               | **yes, this one** |
| distinct check-run names     | varies        | varies          | no                |
| check-run objects on the SHA | varies        | varies          | no                |

Advisory workflows add names that are not part of the gate, and that roster changes independently
of branch protection. `Lift sequencing hold` appears only after the PR closes, while workflows
subscribing to `edited` can add new run objects without changing the head SHA.

**Run objects are not names.** `pr-closure-scope.yml` also triggers on `edited`, so editing a
title or body adds another run object under a name that is already there. Historical totals are
not reusable readiness facts; only the required names from live branch protection bind.

**Watching a PR tells you what ran, not what binds**, and neither number is derivable from
the other.

**Promoting an advisory check would not tighten the gate; it would jam it.** These workflows
subscribe to `pull_request` or `closed` only, because a `merge_group` event carries no pull
request number and no `closingIssuesReferences` — there is nothing for them to read. A
required context that no workflow emits for an event does not fail that entry, it leaves it
**Pending forever** (issue 122). `Lift sequencing hold` is the sharpest case: requiring it
would make every open PR wait for a check that cannot report until after the merge it is
blocking.

Ask both questions in one call, and read them as two answers rather than one:

```powershell
$req = gh api repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection/required_status_checks --jq '.contexts[]'
$sha = gh pr view <N> --repo OlyForge3D/PrintFarmerDesktop --json headRefOid --jq .headRefOid
$run = @(gh api "repos/OlyForge3D/PrintFarmerDesktop/commits/$sha/check-runs?per_page=100" --jq '.check_runs[].name') | Sort-Object -Unique
"required=$($req.Count)  distinct emitted=$($run.Count)"
"required but never emitted (deadlock risk): $(($req | Where-Object { $_ -notin $run }) -join ', ')"
```

**Assert the required names, not a total.** A gate written as `emitted -ge 9` answers _at
least this many succeeded_ — narrower than _which required contexts are green on this commit_
— and passes identically on nine names, nine names plus a duplicate, or eight names plus two
reruns. Check the eight by name. No total is a safety property.

```powershell
gh pr checks <N> --repo OlyForge3D/PrintFarmerDesktop --watch --interval 20
```

Never hand back a red PR. If a check fails, read the failing job log, fix the cause, and push again.

### Reading a failing job log after a re-run

**`gh run view --log --job <id>` serves the _latest_ attempt's log regardless of which attempt
the job id belongs to.** It exits 0 and returns a complete, well-formed log naming the right
job — it is simply the wrong object. If the run was re-run and passed, you get a clean log for
a job that failed, and the investigation ends there.

Measured against run `30880293283` (attempt 1 failed 05:18:39Z, attempt 2 passed 05:54:42Z):

| command                                    | job id asked for   | `##[error]` | first timestamp |
| ------------------------------------------ | ------------------ | ----------- | --------------- |
| `gh run view --log --job 91900014923`      | the **failed** one | 0           | 05:54:49Z       |
| `gh run view --log --job 91905697047`      | the **passed** one | 0           | 05:54:49Z       |
| `gh api .../actions/jobs/91900014923/logs` | the **failed** one | 2           | 05:18:45Z       |

The two CLI outputs are **byte-identical**, so no diff, length anomaly or truncation marker
distinguishes them. (Control: the token `checkout` appears 8 times in all three, so the zero
counts are a property of the content, not of a broken search.)

The tell is free and already in the output:

> **A log whose first timestamp postdates the attempt you asked for is serving something else.**

Use the REST endpoints instead, which are attempt-correct:

```powershell
gh api repos/OlyForge3D/PrintFarmerDesktop/actions/runs/<run-id>/attempts/<n>/jobs   # per-attempt job ids
gh api repos/OlyForge3D/PrintFarmerDesktop/actions/jobs/<job-id>/logs                # true log for that job id
```

Check `attempt` before trusting any log: `gh run list --json attempt`. Only 1 of the 200 most
recent runs has `attempt >= 2` — but re-runs are concentrated on exactly the failures someone
cared enough to re-run, which is the population an investigation samples from. See #261.

`mergeStateStatus: UNSTABLE` means CI is still running or has failed — it is **not** ready to merge. `CLEAN` plus every required context green by name is the bar.

## Fixture traps

**A fixture built from a repeated byte does not test the limit it is named for.** Padding made of one byte repeated compresses roughly 1000:1, so it trips the **compression-ratio** guard long before the **size** guard it was written to exercise. The test keeps passing while testing a different control entirely. Two people hit this independently, which makes it a trap rather than a mistake.

Three rules follow:

- Pad with incompressible bytes (a seeded PRNG, deterministic across platforms) when the size limit is the thing under test.
- Size the fixture to the **named constant** — `COMPRESSION_RATIO_FLOOR_BYTES` — not to a round number that happens to sit near it. A round number stops tracking the limit the moment the limit moves.
- Assert the violating **part name** alongside the diagnostic code, so the test cannot pass by tripping a neighbouring guard that emits the same code.

This is the shadowing problem from `test-discipline`: when two guards defend the same budget, the cheaper one fires first on every honest input, and the guard you meant to test is live, correct, and untested.

## Green CI is necessary, not sufficient

CI stayed green for hours while `development` was missing an entire native engine, because the tests covering it mocked the sidecar rather than invoking the real binary. Ask what your tests would _fail_ to notice.
