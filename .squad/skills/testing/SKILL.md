---
name: testing
description: The validation commands for PrintFarmer Desktop and the traps that make CI fail after they pass locally. Read before running validation or claiming a change is green.
---

# Testing and validation

Run the **smallest complete** validation that covers your change. Complete matters more than small: a targeted run that skips the layer you changed is not validation.

**Before reporting a negative result — "that path is unreachable", "this is safe", "I could not reproduce it" — state the observation that would have produced the opposite finding.** If you cannot name one, you measured a case, not the class. An experiment that _confirms_ a prediction and one that _risked_ it are both real measurements, and only the second licenses a claim about a class. This is the same rule as "an assertion that cannot fail proves nothing", pointed at reports rather than at tests, where nothing else is checking. See `.squad/decisions/inbox/vasquez-falsifiable-negatives.md` — it cost PR #149 two retractions, one of them a shared conclusion the lead had already ratified.

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
| distinct check-run names     | 9             | 10              | no                |
| check-run objects on the SHA | 9 or more     | 10 or more      | no                |

The two extra names on an open PR are `Sequencing hold` and `PR closure scope`, advisory by
design and carrying a `# merge-queue: advisory` header saying so. The tenth name appears only
after the PR closes: `Lift sequencing hold` runs on `closed` only, so it does not exist on an
open PR at all.

**Run objects are not names.** `pr-closure-scope.yml` also triggers on `edited`, so editing a
title or body adds another run object under a name that is already there. Measured on this
file's own pull request: 10 run objects, 9 distinct names, `PR closure scope` twice.

That is why the count keeps moving, and it moved twice while this section was being written:

| reading                              | got | why                                            |
| ------------------------------------ | --- | ---------------------------------------------- |
| a merged PR's head, called it "a PR" | 10  | `Lift sequencing hold` only exists after close |
| an open PR, counted run objects      | 10  | `PR closure scope` ran twice, from `edited`    |
| an open PR, counted distinct names   | 9   | the honest answer to the question asked        |

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

`mergeStateStatus: UNSTABLE` means CI is still running or has failed — it is **not** ready to merge. `CLEAN` plus seven passes is the bar.

## Fixture traps

**A fixture built from a repeated byte does not test the limit it is named for.** Padding made of one byte repeated compresses roughly 1000:1, so it trips the **compression-ratio** guard long before the **size** guard it was written to exercise. The test keeps passing while testing a different control entirely. Two people hit this independently, which makes it a trap rather than a mistake.

Three rules follow:

- Pad with incompressible bytes (a seeded PRNG, deterministic across platforms) when the size limit is the thing under test.
- Size the fixture to the **named constant** — `COMPRESSION_RATIO_FLOOR_BYTES` — not to a round number that happens to sit near it. A round number stops tracking the limit the moment the limit moves.
- Assert the violating **part name** alongside the diagnostic code, so the test cannot pass by tripping a neighbouring guard that emits the same code.

This is the shadowing problem from `test-discipline`: when two guards defend the same budget, the cheaper one fires first on every honest input, and the guard you meant to test is live, correct, and untested.

## Green CI is necessary, not sufficient

CI stayed green for hours while `development` was missing an entire native engine, because the tests covering it mocked the sidecar rather than invoking the real binary. Ask what your tests would _fail_ to notice.
