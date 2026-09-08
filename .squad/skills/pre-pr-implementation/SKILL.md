---
name: pre-pr-implementation
description: The complete pre-PR checklist for an author implementing a squad-assigned issue in PrintFarmerDesktop — format/lint/typecheck, targeted tests, base sync, the adversarial review round, verdict records, and the gate confirmation. Load this when you have been dispatched to implement an issue and are working toward opening a pull request. It is author-facing only; it carries none of Ralph's routing, dispatch, merge or reaping policy.
---

# Pre-PR implementation — PrintFarmerDesktop

> **A dispatch hands you a path and acceptance criteria, not a policy dump.** Your kickoff prompt
> names this file and the issue's acceptance criteria; everything an author needs is here. Ralph's
> triage, dispatch, merge-gate and reaping rules are Ralph's, not yours — you do not need them, and
> pasting them into a kickoff is the transcription cost this file exists to remove.

**Complete all of these, in order, BEFORE you create the pull request.** Do not open a PR until every
step has passed. Opening early wastes a ~15-minute CI matrix and forces reviewers to examine code
that is still moving.

---

## 0. Know what "done" is before you start

Your kickoff gives you the issue's **acceptance criteria**. Restate them in your own words in your
first report. If they are ambiguous, say so on the issue and proceed on a stated assumption —
guessing silently is what produces a PR that passes review and does not close its issue.

Branch: `squad/{issue}-{kebab-slug}`, from `development`. Your PR must link back to the issue.

## 1. Format, lint, typecheck

This repository is TypeScript/Electron with a Rust `native/` layer. **There is no .NET here**, so no
`dotnet` command applies.

```bash
npm install            # a fresh worktree starts without node_modules
npm run format:write   # prettier — reflows files you never opened
npm run format         # confirm clean
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
```

All three are required checks; any of them failing blocks the PR. Running only `test` and
`typecheck` is the single most common cause of a red PR here, because `format` is what catches
people out.

If your change touches `native/`, remember bare `cargo test` does not test the feature-gated
sidecar — `sqlite_catalog`, `step`, and `lib3mf` sit behind Cargo features and are dropped entirely
without the flag. From `native/`:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --features sqlite
```

## 2. Migrations — not applicable here

This repository has **no EF Core and no database migration system**; there are no migration
directories. Do not invent a migration step. If your change alters a persisted schema or an on-disk
format, cover it with a round-trip or backward-compatibility test instead, and say so in your report.

## 3. Targeted tests — run narrow, never COMMIT the narrowing

Run only the vitest tests covering your changed surface, by passing paths on the CLI:

```bash
npx vitest run tests/yourArea.test.ts
```

Do not run the full suite; it is slow and buries the signal. If your change touches e2e behaviour,
also run the relevant `npx playwright test` spec.

**CRITICAL:** passing a narrowing on the command line is fine; **committing one is not**. Do not add
`-t <pattern>` to the `test` script in `package.json`, and do not add `testNamePattern` to
`vitest.config.ts`. A committed narrowing silently shrinks what the suite verifies for everyone.
`npm run check:test-narrowing` exists to catch it (#518, #537).

**You** run the tests. Your reviewers will not — see step 5.

Any product change runs the unit tests covering it; **add them if none exist.**

## 4. Sync to base before review

This repo sets **`strict: true`**: a PR must be UP TO DATE with `development` to merge. Sync BEFORE
the PR exists — no CI has run yet, so nothing is invalidated and it is free. Syncing after review
costs a re-run and can cost a re-review.

If you are ever asked to rebase a PR that is already open and BEHIND, run
`npm run plan:behind-sync-order -- --claim` first and stand down if it reports a lease in flight for
a different PR. Concurrent syncs stampede one shared runner pool (#263).

## 5. Mandatory adversarial review, in parallel, before the PR exists

Dispatch **Bishop, Hicks and Vasquez as three parallel `task` calls in a single turn**
(`agent_type: general-purpose`, `mode: background`) — never as sessions, never sequentially. Give
each the branch name, the exact head SHA, and the diff.

**Pass `model:` and `reasoning_effort:` explicitly on every call.** Nothing applies these
automatically; a call that omits `model:` silently falls back to the platform default and collapses
all three onto one model with no warning. Use these ids exactly — `task` hard-errors on an unknown id
and that reviewer simply never runs:

| Reviewer | `model`                  | `reasoning_effort` |
| -------- | ------------------------ | ------------------ |
| Bishop   | `claude-opus-5`          | `medium`           |
| Hicks    | `gpt-5.6-sol`            | `medium`           |
| Vasquez  | `gemini-3.1-pro-preview` | `medium`           |

The vendor spread is what makes the review adversarial: three instances of one model share blind
spots, miss the same defects, and agree with each other, so a unanimous APPROVE from them looks
identical to a real consensus while being far weaker evidence. Vasquez's id keeps its `-preview`
suffix; plain `gemini-3.1-pro` does not exist and is rejected. Do not "tidy" these ids.

**You are the author, so you must not review your own work** — the verdict gate rejects a reviewer
who is the PR author (`BLOCKED: reviewer <member> is the PR author`).

**Documentation-only** changes need ONE reviewer per `.squad/skills/agent-collaboration/SKILL.md` —
but its carve-outs (workflow YAML, security or API-contract prose, and anything altering an agent
safety boundary, merge-safety rule, or destructive-operation permission) take the full panel even
when only markdown changed. With one reviewer, still pass an explicit `model:` — pick the domain
match: Bishop for storage/integration, Hicks for testing and contracts, Vasquez for security and
concurrency.

**Tell each reviewer, in its prompt, not to build or test.** Use wording equivalent to:

> "Do not build, compile, install dependencies, or run any test suite. Do not run `npm install`,
> `npm test`, `npm run build`, `npx vitest`, `npx playwright`, `cargo build` or `cargo test`. Read
> the diff and reason about it. If a conclusion depends on runtime behaviour you cannot determine by
> reading, say so explicitly in your verdict as an evidence request rather than running anything."

A `task` sub-agent **inherits your working directory**: your reviewers all start inside YOUR
worktree. If they install or build in parallel they collide on the same `node_modules/` and
`native/**/target/` paths, corrupt each other's output, churn `package-lock.json`, and mutate the
tree while you are still working in it. CI and your step-3 run already cover compilation and tests; a
reviewer build gates nothing. Reviewers MAY read anything — the prohibition is on executing.

## 6. Fix every blocking finding, then re-review

Address each blocking issue. A fix changes your head SHA, so re-request review **at the new SHA**.
Repeat until all reviewers APPROVE at the SAME current head. If a finding is wrong, rebut it with
evidence — never just re-push hoping for a different verdict.

## 7. Declare your closing reference

If your PR body contains `Closes #N`, the branch must **also** add
`.github/pr-closes/<branch-name>.md` declaring that issue, **in the same push**. Without it the
required **Closing-reference declaration** check fails, and it fails confusingly: the run falls back
to a stale shared legacy file and reports an unrelated issue number. See `.github/PR_CLOSES.md`;
validate with `npm run check:closing-references`.

## 8. Create the PR, then record the verdicts so the gate can see them

Post each reviewer's verdict as **its own PR comment**, with the record block FIRST in the comment,
in exactly this format:

```
<!-- squad-verdict -->
Squad-Reviewer: bishop
Squad-Verdict: APPROVE
Squad-Head-SHA: <exact 40-character lowercase PR head SHA>
```

Repeat for `hicks` and `vasquez`. All must name the SAME SHA and it must be the PR's live head. The
`<!-- squad-verdict -->` marker is REQUIRED. Fenced code blocks (including an unterminated fence),
quoted `>` lines and other HTML comments are stripped before parsing, so never wrap a real record in
a code fence and never let an unterminated fence appear earlier in the comment — sanitisation fails
closed and would hide your record.

## 9. Confirm the gate actually went green — do not assume

```bash
npm run check:squad-verdict -- --repo OlyForge3D/PrintFarmerDesktop --pr <your PR> --json
```

Exit 0 means usable evidence. If it reports BLOCKED, read `blockedReason` and fix the cause — common
causes are a stale SHA after a later push, a reviewer who is the PR author, or a malformed or hidden
record block.

Also ensure the PR carries the **`squad`** scope label. Without it the gate reports
`NOT_APPLICABLE`, which is green but means "not a squad PR" — and it will then never be merged
unattended.

## 10. Run the CI gate locally before you push

CI's `Desktop` job (windows + macos, both required) runs these in order:

```bash
npm run verify:target-profiles
npm run check:script-reachability
npm run check:inert-class-field-seams
npm run typecheck
npm run lint
npm run format
npm run test
```

## 11. Report, push, and stop

Report the PR number, the head SHA, the model each reviewer ran under, whether the base merge was
clean or conflicted, and the gate's final classification.

Then, per your kickoff's closing clause: push your branch first if you have any commits, report your
final status as your last action, and stop. Never leave committed work unpushed — an unpushed local
branch is invisible on GitHub and is lost when the worktree is reaped. Do **not** attempt to archive
yourself or any other session; the runtime refuses it and the call fails. Cleanup is handled by
Ralph's `🧹 Ready to reap` report.
