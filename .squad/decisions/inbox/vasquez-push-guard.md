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

**Evidence, not assertion.** `tests/pushGuard.test.ts` drives a real push through
the real hook against a real remote and pins the counterfactual: the identical
push with the hook removed succeeds and destroys the other session's commit. A
suite without that half would also pass against a hook git never runs.
