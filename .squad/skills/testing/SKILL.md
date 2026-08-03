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

**Do not clear an npm-tree or downstream SBOM completeness failure by re-running it.** On Windows, `npm ci` can report an `EPERM` cleanup failure as a warning and exit 0 while leaving a partial `node_modules` tree. That is an environment or install failure, not evidence that the supply-chain policy is flaky. Preserve the first-attempt log and investigate the install. Every workflow that installs dependencies runs `scripts/npm-ci-strict.mjs`, which must stop a damaged tree at `Install dependencies`; if the same symptom reaches an SBOM step again, the install guard itself has failed and the run must not be dismissed.

**`git grep` uses basic regex.** `|` is a literal unless you pass `-E`. This produced false "no matches" results while verifying acceptance criteria.

**PowerShell has no heredocs.** Use a single-quoted here-string piped to a command (`@'` … `'@ | python -`), or write the file with a file tool.

**`&&` only chains external commands** in PowerShell. Use `;` before PowerShell keywords.

Disable pagers: `git --no-pager ...`.

## CI gate

Seven required checks must pass:

- Desktop (windows-latest)
- Desktop (macos-latest)
- Sidecar (windows-latest)
- Sidecar (macos-latest)
- Release package (windows-latest)
- Release package (macos-latest)
- Dependency advisories

**This list is a transcription, and the authoritative source is the branch-protection
endpoint — not this file.** It has been wrong before (see #152: it named a packaging job that
has never existed, and omitted `Dependency advisories`), and every agent reads this file on
activation, so a stale copy here misleads everyone at once. Re-verify rather than trust it:

```powershell
gh api repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection `
  --jq '.required_status_checks.contexts[]'
```

If that output disagrees with the list above, the endpoint wins — fix this file.

```powershell
gh pr checks <N> --repo OlyForge3D/PrintFarmerDesktop --watch --interval 20
```

Never hand back a red PR. If a check fails, read the failing job log, fix the cause, and push again.

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
