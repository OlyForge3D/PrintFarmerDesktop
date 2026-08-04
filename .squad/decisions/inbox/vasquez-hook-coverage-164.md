## 2026-08-04: Setting `core.hooksPath` is not arming the hook (#164)

**By:** #174 reviewer session, assigned #164 by Ripley

**Decision:** take option 1 of the three in #164 — **detect and report at install
time** — and add an explicit `--verify` mode that exits non-zero so the check can
be used as a gate. Options 2 and 3 are addressed as far as they go: the
documentation already landed (`.squad/skills/git-workflow/SKILL.md`), and
"make absence non-silent" is what the install-time report does at the only moment
anyone is looking.

---

## What was measured before deciding

Across the 27 worktrees sharing `D:/s/PrintFarmerDesktop/.git`:

| measurement                         | value                                        |
| ----------------------------------- | -------------------------------------------- |
| `core.hooksPath`                    | `.githooks`, in the clone-wide `.git/config` |
| `extensions.worktreeConfig`         | unset — no per-worktree override exists      |
| worktrees with `.githooks/pre-push` | **5**                                        |
| worktrees without                   | **22**                                       |
| control (`package.json` present)    | 27 / 27                                      |

`hookOnDisk` and `trackedAtHEAD` agreed in all 27, so branch content is the sole
determinant — there are no stray untracked hooks propping anything up.

Four arms, same clone, same setting, pushing to a throwaway local bare repo. The
detector is that the guard prints `[push-guard] ok (...)` on **allowed** pushes
too, so absence of that string means git ran nothing:

| arm | worktree | operation                | guard output      | exit | outcome                  |
| --- | -------- | ------------------------ | ----------------- | ---- | ------------------------ |
| A   | unarmed  | new branch               | none              | 0    | pushed                   |
| B   | armed    | new branch               | `[push-guard] ok` | 0    | pushed                   |
| C   | unarmed  | force-push discarding 45 | **none**          | 0    | **45 commits destroyed** |
| D   | armed    | identical force-push     | `REFUSED`         | 1    | ref unchanged            |

C and D are the same command, same source and target SHAs, same remote, same
`core.hooksPath`. The only variable is whether the checked-out tree contains
`.githooks/`.

A fifth arm returned a null: pushing from a **subdirectory** of an armed worktree
still fires the hook, so git resolves a relative `core.hooksPath` against the
worktree top level, not the process cwd. The verifier resolves it the same way.

---

## Why not the absolute-path fix

Pointing `core.hooksPath` at an absolute `.githooks/` would raise coverage to
every worktree at once, and `.githooks/pre-push` was already written to support
it — it resolves `push-guard.mjs` relative to its own location, commenting that
"a hooksPath pointed here from elsewhere works."

It was rejected because it **converts a localised silent no-op into a global
one**. The absolute path names one worktree; delete or move that worktree and
every worktree in the clone is silently unguarded, including the ones that have
`.githooks/` right there. That trades 22 quiet failures for 27, and it fails in
the same undetectable direction. Detection has no equivalent failure mode.

## Why `prepare` still exits 0

Failing the build is the loudest option and was rejected on measurement, not
taste: **22 of 27 worktrees were unarmed**, so a non-zero `prepare` would break
`npm ci` in all of them and block work rather than surface a risk. The lifecycle
path therefore reports on stderr and exits 0; `npm run hooks:verify` performs the
identical check and exits 1, so anything that wants a gate has one.

The two paths sharing a single check matters — a report and a gate that could
disagree would be two controls, one of which is wrong.

---

## What the test suite has to do, and what the existing one could not

Acceptance criterion 2 of #164 asks that a test drive the **failure** direction.
`tests/installGitHooks.test.ts` does, and every positive assertion in it exists as
the control for a negative one.

The reason it is a new file rather than an addition to `tests/pushGuard.test.ts`:
every integration case in that suite sets `core.hooksPath` to
`path.join(repoRoot, HOOKS_PATH)` — an **absolute** path — while `installGitHooks`
writes a **relative** one. That suite is structurally incapable of detecting this
defect, because it overwrites the very value whose production form causes it. It
is not that the coverage case was overlooked; it is that it was unreachable.

The assertion that encodes the issue itself creates two worktrees of one clone,
one carrying `.githooks/pre-push` and one not, and requires `verifyHooksArmed` to
return opposite verdicts under an identical clone-wide setting.

---

## The general form worth keeping

**A silent no-op is only detectable by an observation you were not making for that
purpose.** #164 was found because an ordinary fast-forward push _also_ produced no
guard output, which cannot be true if the hook is wired — noticed incidentally,
not by a control. That is why the fix is a control at install time rather than a
recommendation to be careful: carefulness has no falsifier, and this failure mode
is specifically invisible to it.

Its sibling, from the same day's work: **a green is not a result until the
mutation has been shown to take.** Every assertion added here was mutated and
observed to go red before being trusted.
