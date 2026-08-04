# A field that is occasionally informative is worse than one that never is

**Measured on `development` at `0b54313`, all 185 commits, not a sample.**

Nobody here can tell from a commit which session produced it, and the reason is
not that the identity fields are empty. It is that they are populated, and
populated with values that look like answers.

## The author field does not partition sessions

```
git log origin/development --format=%an   (185 commits)

  139  Jeff Papiez
   39  jpapiez
    5  Inspector Agent
    1  Bishop
    1  Ripley
```

This clone has **22 worktrees**, and every one of them inherits `user.name` and
`user.email` from the main checkout's `.git/config`. So every agent session on
this machine commits as `Inspector Agent <inspectoragent@example.com>`. **The
field takes the same value for every member of the population it appears to
partition.** Against the question _"which session wrote this"_ it carries **zero
bits**, and it carries them while looking like the archetype of an identifier.

**That much is merely useless. Here is what makes it harmful.**

Two of the 185 commits are authored `Bishop` and `Ripley`. One is
`Inspector Agent`, five times. **The field is not uniformly uninformative — it is
_occasionally_ informative**, and those few rows are proof to any reader that
role identity does travel in `%an`. A reader who spot-checks will find the
`Bishop` commit, conclude the mechanism works, and then read `Jeff Papiez` on 139
commits as a fact about who wrote them.

> **A field that is uniformly wrong gets discovered. A field that is right 4% of
> the time gets trusted, because the check that would falsify it succeeds.**

**Do not build an attribution detector on `%an` or `%ae` here.** It will match
every agent equally and it will always return a name, which is what makes it feel
like it works. **The branch name is the discriminating field** — one branch, one
worktree, one session — and it survives into the PR record even when the commit
does not.

## Squash-merge deletes the remaining signal, and this is the majority path

80 of the 185 commits have committer `GitHub` — the squash-merge signature. A
squash rewrites the author to the merging user, so **an agent's identity does not
reach `development` through the author field at all on the majority path.** Three
of the four most recent merges show `Jeff Papiez` / `GitHub`.

What survives is a **trailer in the commit message** — `Copilot-Session: <uuid>`
— placed there by convention. **It is the only field on `development` that
distinguishes one session from another**, and nothing produces it, validates it,
or notices its absence.

## The convention's coverage, measured, because "by convention" is a rate

```
Copilot-Session: present   160 / 185   86.5%
                 absent     25 / 185   13.5%
```

**One commit in seven on `development` cannot be attributed to a session by any
mechanism at all.**

**And the gaps are not where you would want them.** Every author bucket is at
100% except the largest:

```
  jpapiez           39/39   100%
  Inspector Agent     5/5   100%
  Bishop              1/1   100%
  Ripley              1/1   100%
  Jeff Papiez     114/139    82%      <- all 25 gaps are here
```

**The trailer fails precisely in the bucket where the author field has already
been flattened by squash** — so the two mechanisms do not cover each other's
failures, they fail on the same rows. Attribution is missing exactly where it is
the only thing that could have supplied it.

### The obvious objection, tested

_"The gaps are historical — the convention was adopted later and is at 100% now."_
That would make this a closed problem, so it is the first thing to check.

```
earliest commit with no trailer   2026-07-23
latest commit with no trailer     2026-08-03      <- today

by day:  08-03  17/20   85%
         07-30   4/4   100%
         07-29   3/3   100%
         07-28   1/1   100%
         07-27   9/19   47%
         07-26   5/5   100%
         07-25  40/41   98%
         07-24   7/17   41%
```

**Not historical.** Three commits landed today without a session identifier, and
coverage oscillates between 41% and 100% with no trend. **The convention is not
converging on adherence; it is sampling from a distribution.**

## Why this note exists rather than a fix

The fix is mechanical and cheap — reject a commit with no `Copilot-Session`
trailer, or stop inheriting `user.name` into worktrees — and **neither is mine to
impose.** Both are squad-wide policy with a cost borne by everyone, and one of
them is a required-check change, which is a control and therefore a decision.

What is filed here is the measurement, so that whoever takes the decision is not
choosing between two mechanisms that both look adequate.

**Bearing on #187.** That issue records that squad reviews carry no mechanical
weight — self-review is impossible, zero approvals required. This is the same
audit trail losing its other end: **#187 is who approved it, this is who wrote
it, and both fail silently.** They are not the same defect — one is a platform
setting and one is a convention — but a reviewer reconstructing an incident needs
both, and today neither is reliable.

## The general form

**Ask what a field's value would be if the mechanism were absent.** For `%an`
here the answer is _"the same name,"_ so the field cannot distinguish presence
from absence and no amount of reading it will reveal that. The tell is not that
the value looks wrong — it looks entirely right — but that **it is the value you
would get either way.**

The corollary is the part that catches people, this note's author included:
**verifying such a field succeeds.** Every spot-check returns a plausible name.
The check that would expose it is not _"is this value correct"_ but **"does this
value vary across cases I know to be different"** — which is a query over a
population and cannot be run on the single row in front of you.
