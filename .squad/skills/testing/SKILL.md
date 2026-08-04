---
name: testing
description: The validation commands for PrintFarmer Desktop and the traps that make CI fail after they pass locally. Read before running validation or claiming a change is green.
---

# Testing and validation

Run the **smallest complete** validation that covers your change. Complete matters more than small: a targeted run that skips the layer you changed is not validation.

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

## Green CI is necessary, not sufficient

CI stayed green for hours while `development` was missing an entire native engine, because the tests covering it mocked the sidecar rather than invoking the real binary. Ask what your tests would _fail_ to notice.
