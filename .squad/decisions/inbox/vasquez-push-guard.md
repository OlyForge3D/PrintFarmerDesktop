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

## The same over-generalisation again, in the fix for it

Worth recording because it is the **third** instance in one session and the first
two did not prevent it.

"Is this commit mine?" was first answered by reachability from the local tip,
which is a **proxy**: it actually answers "do I still hold some other commit of
the same session?" That comes apart in both directions — too permissive when you
keep one commit of another session, too strict on a **full rollback**, where every
commit carrying your id is exactly what you are removing, so your own retreat is
announced as another session's work with an override naming yourself.

The replacement was the reflog, justified by a measurement: **a commit that
arrives by `git fetch` does not enter `HEAD`'s or the branch's reflog.** That is
true. It is also the wrong class. **`git checkout` of a fetched branch DOES write
a reflog entry naming the other session's tip** — so merely _looking at_ another
session's branch laundered their commits into "mine" and silenced the foreign
alarm on precisely the scenario #81 exists for: two sessions on one branch.

The config that was never varied was whether the branch had also been checked
out. Same shape as the `pushurl` gap: one point sampled, a class named.

So reflog entries are filtered to those that **created** a commit here — only a
`commit` entry is evidence of local authorship; `checkout`, `reset`, `merge`,
`pull`, `rebase` and `cherry-pick` all record a commit arriving or being copied.
This fails toward more refusals, never fewer.

**Why not read the session id directly, which would not be a proxy at all?**
Measured, and it does not work. `COPILOT_AGENT_SESSION_ID` exists in the agent's
environment, but it holds a **different id from the one written into the
`Copilot-Session` trailers** — so comparing against it would classify every
commit as foreign, including the pusher's own. It is also process-scoped, so a
human pushing from an ordinary terminal has nothing at all. The direct answer is
not merely unavailable; taking it would have been worse than the proxy.

## A third time, on the tool rather than the data: `git ls-remote --get-url`

`git ls-remote <remote>` resolves `remote.<n>.url`; `git push` resolves
`remote.<n>.pushurl`. A repo configured with a broken fetch URL and a working
push URL therefore pushes fine while the guard's probe dies — the guard refuses
a push git itself would have accepted.

Two of the obvious repairs are worse than the bug. **`git ls-remote --push`
does not exist — exit 129**, so it raises on every invocation and refuses every
push in every configuration. **`git ls-remote --get-url` returns the _fetch_
URL**, which is precisely the wrong quantity; git's own usage text names only
`url.<base>.insteadOf` and never `pushInsteadOf`. That one is the dangerous
repair, because it reads as correct in a diff and passes a suite that samples
only `remote.<n>.pushurl`.

The correct spelling is `git remote get-url --push <remote>`, falling back to
the literal argument when the remote is a bare URL.

The over-generalisation was mine again, one layer out: the suite exercised
`pushurl` and the comment claimed `pushInsteadOf`. They are different mechanisms
— a per-remote override versus a global URL rewrite — and one sampled config
does not establish the class. **The reason the correct spelling is correct was
written in a comment, which is a commitment; the control is the `pushInsteadOf`
case that fails when the trap is substituted.** Substituting it fails both
push-URL tests now and failed neither before.

## The rescue itself had a config I had not varied

The reflog is what stops a total rollback of your own work being called another
session's. It is not always there: `core.logAllRefUpdates=false` disables it,
entries expire, and a fresh clone has none for work it did not do.

With that config as the only variable, the fixed guard reproduced the original
defect exactly — `foreign-session`, _"written by another session"_, naming the
pusher's own id, printing the override for it. One writer, instructed to
acknowledge themselves as a second.

**The reason it went unnoticed is a comment I wrote asserting it was safe:** an
empty reflog "fails toward MORE refusals". That is true and it is not a defence.
**More refusals is only conservative when the extra refusals are correct.** Here
the extra refusals are false, they land on the most ordinary destructive push a
solo session makes, and the remedy they print is `PF_PUSH_ACK_FOREIGN` — the
flag that turns this check off. A false alarm whose remedy is disabling the alarm
does not fail safe; it trains the bypass. The habit is global, while the check it
buys is local.

**The general rule, which is the transferable part:** an absence is only evidence
when the instrument that would have recorded the presence was running. The guard
now measures that separately (`ownershipEvidence`, from whether the reflog
produced any entry at all, independent of what the entries say) and splits the
two cases:

- reflog present, id absent → a finding. `foreign-session`, override offered.
- reflog absent, id absent → not a finding. `unattributed-discard`: still
  refuses, states that it _cannot_ attribute the commits, and offers the tip
  acknowledgement instead of the foreign override.

The cost is stated rather than hidden: on a clone with no reflog, a genuine
second writer is now refused with the weaker message, so the tip acknowledgement
alone is enough to proceed. That is a real reduction in the two-session control,
accepted because the alternative was teaching every solo developer that the
foreign override is a routine step.

## The decision function's purity is now enforced, not promised

`evaluateRefUpdate` must stay pure because `protected-ref` and the delete refusal
are decided **inside** it: anything deciding upstream — a fallback allow in
`main()`, or a fact the function fetches for itself — bypasses the highest
-severity checks. That rule was protected by nothing but the author noticing, and
it had already been broken once with nothing to catch it, because the unit tests
supply `facts` directly.

The control runs the decision function in a process with **`PATH` emptied**, so
`git` cannot be resolved at all, and drives every branch. The first attempt at
this control patched `execFileSync` on the `child_process` namespace before
importing the guard — and **did not work**: a named ESM import is a snapshot, so
the guard kept the original binding. It passed against a decision function
deliberately made to shell out. Caught only by mutating the code and watching the
test stay green, which is the reason to mutate every new assertion: a control
that cannot fail is indistinguishable from one that works.

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
mode #81 exists to prevent, reintroduced by the fix for it.

**The first repair was still a proxy, and the proxy broke on the case that
matters most.** Widening the set to "sessions reachable from the local tip" fixes
a _partial_ rollback, because your other commits still carry your id. It does not
fix a **full** one: roll back all of your work and every commit carrying your
session id is exactly what you are removing, so it is reachable from nothing and
you are named a second writer again — on "that branch was wrong, take it all
back", the most likely destructive push a lone session ever makes. Reachability
answers _"do I still have some other commit from the same session?"_, which is
**correlated** with ownership and not equal to it.

**The reflog answers it directly.** A commit that arrived by `git fetch` does not
enter `HEAD`'s or the branch's reflog — measured in a two-clone repro, not
assumed — while a commit written in this worktree does. The guard now takes the
union of reachability and the reflogs, and both directions are pinned by
mutation: drop the reflog source and the full-rollback case is misnamed again;
widen it to `--all` and the two-session refusal stops firing. Cost is 32–56 ms
for the walk plus ~30 ms per reflog, against the 515 ms `ls-remote` already paid.

**Evidence, not assertion.** `tests/pushGuard.test.ts` drives a real push through
the real hook against a real remote and pins the counterfactual: the identical
push with the hook removed succeeds and destroys the other session's commit. A
suite without that half would also pass against a hook git never runs. Both
defects above were found by writing the **passing**-side cases the first suite
lacked — that is the argument for the requirement, not coverage hygiene.
