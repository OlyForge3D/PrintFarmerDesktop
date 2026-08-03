# git hands the pre-push hook the remote-advertised tip, not the tracking ref

**By:** Vasquez — from issue #81 / PR #149.

This is the durable half of that work. The guard is an artifact; this is a fact
about git that anyone reasoning about `--force-with-lease` in this repo needs,
and it is expensive to rediscover. It was measured by instrumenting a real push,
not read off documentation, and it **contradicted the premise the work started
from** — including an explicit instruction from the TL, which was withdrawn once
the measurement was in.

## The finding

Two behaviours, both verified against a real remote:

1. **The `<remote sha1>` git writes on the hook's stdin is the value the remote
   advertised**, not `refs/remotes/<remote>/<branch>`. A tracking ref left stale
   by a background fetch does **not** produce a stale value on hook stdin.
2. **When a lease has already failed, git omits that ref from the hook's stdin
   entirely.** Observed directly: the same push before a fetch delivered an
   `ARGS:` line and no ref lines at all; after the fetch it delivered the ref
   line carrying the true remote tip.

## Two consequences, and the second is the trap

**The hook sees only pushes git is _willing_ to perform.** It is not a second
opinion on the lease; it is a check on what survives the lease. PR #78 is exactly
that case: git was willing.

**A guard cannot defend against a stale tracking ref at the pre-push hook,
because at that point there is no stale value to catch.** Any design that tries
— including reordering checks so a "fast-forward" case short-circuits a
"stale-lease" case — is defending a window that does not exist. The real
defensible property is different, and is what #149 implements: treat _"this push
destroys commits"_ as the thing needing authorisation, enumerate the destroyed
commits against a live `git ls-remote`, and refuse unless the pusher names the
tip being overwritten.

## Why `--force-with-lease` is still weak, since the above could be misread as saying it is fine

It is weak for a reason this finding does not touch: the **lease itself** is
computed from the tracking ref, so a background fetch satisfies it against
commits never read (PR #78 — `254fd9e` and `b9f1dea` destroyed). And the explicit
form `--force-with-lease=<ref>:<sha>` is only as good as the SHA supplied, which
on `squad-name-audit` was invented by extending a seven-character prefix. The
default lease cannot catch that second case **by construction** — it never
consults the pusher's belief at all.

## Corollary, established the same way

If the remote tip is **not in the local object store**, the destroyed set cannot
be enumerated (`git log <live> ^<local>` fails `fatal: bad object`). In that
state _"this push is non-destructive"_ is **not determinable**, so failing closed
is the only honest option — not a conservative choice between two workable ones.
A fast-forward can never reach that state, since a fast-forward's remote tip is
by definition an ancestor of local `HEAD` and therefore present. Recorded so that
nobody later "fixes" the fail-closed behaviour by widening it.

## Where that corollary was over-generalised, and what corrected it

The paragraph above was measured and it was **not general**, and the gap is the
durable lesson. The failure of the live query was tested with an _unreachable
remote_, found to be unreachable in practice, and the whole class was concluded
unreachable from that one sample. Review found the case never sampled: **`git
push` resolves `remote.<name>.pushurl`; `git ls-remote <name>` resolves
`remote.<name>.url`.** They differ **by design** in any clone that fetches over
HTTPS and pushes over SSH (`pushurl`, `url.<base>.pushInsteadOf`). Every push
from such a clone was refused — including the push carrying the fix. A permanent
lockout, and the victim could not ship the repair.

Two things follow, and the second is worth more than the first:

- **`git ls-remote --push` does not exist.** The supported spelling is
  `git remote get-url --push <remote>`, which is what the guard now uses.
- **"I measured it" and "I measured the general case" are different claims.** An
  artifact never exercised in the failure direction you have not yet tried is an
  assumption wearing an artifact's clothes. The remedy is to go and configure the
  case, not to reason about whether it exists.

The fail-closed _principle_ survives intact — what changed is that the guard now
answers "is this provably non-destructive?" from the **advertised tip it was
handed**, using `git merge-base --is-ancestor`, before it refuses. In the pushurl
case that resolves with **no network at all**, because the advertised tip is
present locally precisely because the update is a fast-forward. `--is-ancestor`
is a **tri-state**: `0` ancestor, `1` not an ancestor, `128` object absent. Only
`0` is evidence; `1` and `128` are collapsed into one refusal deliberately.

## What installing the hook does to the clone

Stated because it is invisible and it fails in the unguarded direction.
`core.hooksPath` is written **clone-wide**, so it covers every worktree, while
`.githooks/` is **per-worktree** — a worktree on a branch without that directory
is silently unguarded, since git skips a missing hook without error (#164). And
setting `core.hooksPath` **disables every pre-existing `.git/hooks/*`**,
including personal hooks. `node` on `PATH` becomes a precondition of pushing.

---

# Branch ownership is asserted at the push, not at the assignment

**Decision (closes #81 item 2).** Two sessions writing one branch is caught by a
`pre-push` hook (`.githooks/pre-push` → `scripts/push-guard.mjs`, wired by the
`prepare` npm script) rather than by a rule about which flag to type. A push that
would destroy commits carrying a `Copilot-Session` trailer absent from the
commits being pushed is refused, naming the foreign session id and listing every
commit that would have been lost. The trailer is the discriminator per
`decisions.md:152`; committer and author identity are per-worktree config and
prove nothing.

**Why the obvious answer was rejected.** #81 could have been closed by writing
"use `--force-with-lease=<branch>:<sha>`" into the git-workflow skill. That is a
commitment, not a control — `decisions.md` → _A commitment is not a control_ —
and it is a commitment whose only possible breacher is the person making it, with
nothing watching the ref. Both incidents on #81 were committed by people who knew
the rule.

**Honest limits.** `--no-verify` bypasses any hook, and a hook only binds clones
where `npm install` has run. The guard converts a silent accident into a
deliberate, legible act; it is not a server-side control. Ownership is asserted
at push time, not assignment time: nothing repo-local can stop a coordinator from
_assigning_ two sessions the same branch. Server-side coverage of feature
branches is filed as #151 rather than claimed here — `development` is protected
against force-pushes and deletions, but no feature branch is protected by
anything, and every #81 incident happened on a feature branch.

**A control that cries wolf on the safe case gets disarmed on the dangerous one.**
The first version computed "commits you are pushing" as `local ^live`, which is
**empty whenever the local tip is an ancestor of the live tip** — an ordinary solo
rollback. Every discarded commit was then classified foreign, so the guard named
_the pusher's own session_ as "another session" and printed the override
instruction with their own id in it. Fail-closed, so not a bypass — but it trains
the override habit on pushes where no second writer exists, which is the failure
mode #81 exists to prevent, reintroduced by the fix for it. The set is now taken
from everything reachable from the local tip. Cost was measured, not feared:
32–56 ms against the 515 ms `ls-remote` already paid on every push.

**Evidence, not assertion.** `tests/pushGuard.test.ts` drives a real push through
the real hook against a real remote and pins the counterfactual: the identical
push with the hook removed succeeds and destroys the other session's commit. A
suite without that half would also pass against a hook git never runs. Both
defects above were found by writing the **passing**-side cases the first suite
lacked — that is the argument for the requirement, not coverage hygiene.
