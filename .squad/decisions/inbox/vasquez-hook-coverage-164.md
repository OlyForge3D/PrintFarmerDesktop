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

### The structural facts — invariant, and what the fix actually rests on

Read from the clone at `D:/s/PrintFarmerDesktop/.git`:

| measurement                       | value                                        |
| --------------------------------- | -------------------------------------------- |
| `core.hooksPath`                  | `.githooks`, in the clone-wide `.git/config` |
| `extensions.worktreeConfig`       | unset — no per-worktree override exists      |
| resolution of that relative value | against each worktree's own top level        |

These do not move, and the defect follows from them alone: one clone-wide setting,
resolved per worktree, naming a directory whose existence is decided by whichever
branch is checked out there.

### The coverage counts — and why no single figure is filed

Three readings of the same clone, same command, same control:

| reading | when (UTC)           | worktrees | armed | unarmed | control (`package.json`) |
| ------- | -------------------- | --------- | ----- | ------- | ------------------------ |
| 1       | ≤ 2026-08-04T13:52Z  | 27        | 5     | 22      | 27 / 27                  |
| 2       | ~2026-08-04T20:52Z   | 18        | 10    | 8       | 18 / 18                  |
| 3       | 2026-08-04T20:54:46Z | 18        | 10    | 8       | 18 / 18                  |

Reading 2 is Ripley's, taken independently; 1 and 3 are this session's. Reading 1's
timestamp is an upper bound — the commit that acted on it, `5848e21`.

**No count is filed as the finding.** In seven hours the total fell by nine and the
armed set doubled. A document asserting "22 of 27 worktrees are unguarded" would
have been false the same afternoon, and the mechanism would likely have been
discarded along with the number.

**But the variation is state drift, not measurement noise, and the distinction is
load-bearing.** Readings 2 and 3 are two minutes apart, taken by different
operators, and agree _exactly_ — including the control. Readings hours apart do
not. So the instrument is not unreliable; the quantity simply has a short
half-life, because worktrees are created and deleted continuously and each one
arrives armed or unarmed according to the branch placed in it.

That distinction decides the remedy. For a noisy instrument the remedy is to
measure again and average. Here that would be actively wrong: averaging two true
readings of different states manufactures a number that was never the case.
The remedy is the opposite — timestamp every reading, never average, and never let
a count carry an argument the mechanism can carry instead.

**This is the argument for detection over audit, made by the audit.** An audit
publishes a number that expires. The install-time check re-derives the answer in
the only place it is ever true: the worktree being used, at the moment it is used.

`hookOnDisk` and `trackedAtHEAD` agreed in every worktree in every reading, so
branch content is the sole determinant — there are no stray untracked hooks
propping anything up.

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
`.githooks/` right there. It trades a partial silent failure for a total one — at
reading 1, 22 of 27 would have become 27 of 27 — and it fails in the same
undetectable direction, with the added property that the directory it depends on
belongs to nobody and its deletion raises nothing.

Detection has no equivalent failure mode: it fails at install time, which is the
one moment a human is present.

**Recorded so it is not rediscovered as an unexplored option.** The mechanism
exists, in `.githooks/pre-push`, and it works. The combination of "ready-made shim

- absolute `core.hooksPath`" was considered in full and rejected on the reasoning
  above — not overlooked, and not blocked by missing work. A later session finding
  that comment should read this paragraph before treating it as an easy win.

## Why `prepare` still exits 0

Failing the build is the loudest option and was rejected on measurement, not
taste: at the time of the decision a **majority of worktrees were unarmed**
(reading 1: 22 of 27), so a non-zero `prepare` would break `npm ci` in all of them
and block work rather than surface a risk. The ratio has since moved (reading 3:
8 of 18) and the decision does not rest on it — any non-trivial unarmed population
makes a hard-failing lifecycle hook a work stoppage rather than a signal. The lifecycle
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

---

## The acceptance criterion, driven on the shipped script

Criterion 2 of #164 asks that the failure direction be driven, not merely
described. Run against a throwaway repository (never the shared clone, whose
`core.hooksPath` 18 worktrees depend on), both arms measured with no pipeline
between the process and its exit code:

| arm | repo state                                       | output                                                                                          | exit  |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----- |
| 1   | `core.hooksPath=.githooks`, directory **absent** | `WARNING: this worktree is NOT guarded` + `resolves to …\.githooks, which contains no pre-push` | **1** |
| 2   | identical repo, `.githooks/pre-push` **present** | `armed: …\.githooks\pre-push`                                                                   | **0** |

Arm 2 is what makes arm 1 evidence: the same script, same repository, one
variable, opposite verdicts. Without it, arm 1's exit 1 could be a script that
always exits 1.

**A measurement note that nearly cost this result.** The first run of arm 1
reported exit 0, which would have been a defect in the deliverable. It was not —
the exit code had been read through a `| Select-Object -First 4`, which stops the
pipeline before the process's status is recorded and leaves the previous
command's value in place. Reproduced deliberately afterwards: a process emitting
ten lines and exiting 1, read through the same truncating pipe, reports 0.

The instrument converted a failure into a success **silently and in the
reassuring direction** — the exact shape of the defect this whole issue is about,
occurring in the tooling used to verify the fix for it. Worth recording because
the first instinct was to file it against the script.
