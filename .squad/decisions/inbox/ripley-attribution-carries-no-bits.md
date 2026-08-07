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
Copilot-Session trailer present   160 / 185   86.5%
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

---

# Correction (a second Ripley session, measuring the remedy)

**Nothing above is deleted. The phrasing that produced the error is the specimen,
and a rule with no specimen teaches nothing.**

**The central finding of this note stands unchanged and is not in question:**
`%an` is occasionally informative and therefore trusted, and _"a field that is
right 4% of the time gets trusted, because the check that would falsify it
succeeds"_ survives everything below.

**An explanation for the 4% residue is in circulation and this correction
refutes it** — it is not the direct-push population and it does not indicate
skipped review. See _"The `%an` half"_ below. **I asserted it in this very
paragraph in the first draft of this correction, before running the check that
disproves it**, which is worth leaving on the record: the claim is attractive
enough that the person writing the refutation repeated it two screens above the
refutation.

**What is corrected is the trailer-coverage section: its causal attribution and
its convergence conclusion.** Both were measured on a population that includes
rows where the convention was structurally impossible to follow.

## The defect: a merge commit's message is composed by GitHub

**What the reader must find:** any merge commit on `development` — one with two
parents — has a message of the form `Merge pull request #N from <branch>`
followed by the PR title, and nothing else. No author typed it.

**A trailer cannot be present in a message no author wrote.** By this note's own
general form — _ask what the field's value would be if the mechanism were
absent_ — a merge commit's trailer is absent **either way**, so those rows
cannot distinguish adherence from non-adherence and do not belong in a
measurement of adherence.

**This note contains the rule that disqualifies eleven of its own twenty-five
rows.** The general form was stated at the bottom and not applied to the table at
the top. That is not a subtle miss: the section was written first and the rule
was derived afterwards, which is the ordinary way a paper comes to contradict
itself.

## The 25 gaps, split by write route

Classify by parent count rather than by committer name. **Committer `GitHub`
covers both squashes and merge commits**, which is what merges the two routes;
`%P` separates them.

```
route                        total  missing    rate
merge-commit (generated)        14       11    78.6%   <- message written by GitHub
squash                         116       13    11.2%
true direct push                76        1     1.3%
imported by merge-commit PR     22        0     0.0%
                                       ----
                                         25
```

**A fourth route had to be separated out, and missing it was my own first error
here.** When a PR is merged with a _merge commit_, its branch commits enter
`development` verbatim — single parent, original author, original committer. They
are indistinguishable from a direct push by `%cn` and `%P` alone. Separating them
requires asking which commits each merge introduced
(`git rev-list <merge>^2 --not <merge>^1`). **They are the best-attributed
population in the repository: 22 of 22 carry the trailer.**

**The note attributes all 25 to squash-flattening. Eleven are merge commits.**
Both routes land in the `Jeff Papiez` bucket, so the bucket table above is a
correct measurement — the _cause_ it is read as showing is the part that is
wrong.

Excluding the rows where the convention could not have been followed:

```
author-composed commits    213
real gaps                   14      6.6%
```

## The convergence test, re-run on the corrected population

This is the section the note is strongest on, and it is the one most affected.

```
day          | as published (all)  | corrected (authored only)
2026-07-21   | 12/12  100%         | 12/12  100%
2026-07-22   | 42/42  100%         | 42/42  100%
2026-07-23   | 20/21   95%         | 20/21   95%
2026-07-24   |  7/17   41%         |  7/17   41%     <- real, and 10 of the 14 gaps
2026-07-25   | 40/41   98%         | 40/41   98%
2026-07-26   |  5/5   100%         |  5/5   100%
2026-07-27   |  9/19   47%         |  6/6   100%     <- ARTIFACT: all 13 were merge commits
2026-07-28   |  1/1   100%         |  1/1   100%
2026-07-29   |  3/3   100%         |  3/3   100%
2026-07-30   |  4/4   100%         |  4/4   100%
2026-08-03   | 18/21   86%         | 18/20   90%
2026-08-04   |  (after this note)  | 30/30  100%
```

**The note's evidence for _"oscillates between 41% and 100% with no trend"_ is
three dips. One of them is not a dip.** `07-27` is 100% on every commit a human
composed. Remove it and the series is one bad day and otherwise 90–100%, with
the day following publication at 30/30.

> **A measurement that includes rows which cannot vary will understate adherence,
> and it will do so worst on the days with the most merge activity — which are
> the busy days, which is where you look.**

**The conclusion changes.** _"Not converging; sampling from a distribution"_ is
not supported by the corrected series. The trailer half of this note describes a
historical artifact — **10 of the 14 real gaps are 2026-07-24** — and the single
direct-push gap is:

```
1aef046d  2026-07-23  chore: initialize Squad team
```

**The only direct-push violation is the commit that created the convention**, and
it necessarily predates it.

## Bearing on the remedy this note declined to choose

The note deliberately filed a measurement and left the remedy open, which was
right. The two candidate remedies were a **push-time control** and a
**squad-wide convention change**. The route split decides against both:

- **A push-time control catches 1 gap in 25**, and that one is the bootstrap
  commit. The direct-push route is the _most_ compliant path in the repository at
  1.0%, not the least.
- **A convention change has nothing to correct**: 30 of 30 authored commits on
  the day after publication carry the trailer.

**Neither is warranted.** The honest action on the trailer half is to strike it
rather than remedy it.

## The `%an` half: the finding stands, the mechanism offered for it does not

A reading of this note now circulating is that **the 4% where `%an` still works
is the population that bypassed review** — so a spot-checker who finds `Bishop`
has sampled exactly the commits that skipped the process. **That is a compelling
sentence and it is false.** All seven surviving-identity commits, checked against
the PRs that introduced them:

```
sha       author            PR that brought it in
6b62199   Inspector Agent   #140
66b7007   Inspector Agent   #140
3aa8943   Inspector Agent   #140
52c64cb   Inspector Agent   #140
9390ddf   Inspector Agent   (none — true direct push)
e62f677   Bishop            #126
df1b083   Ripley            #103
```

**Six of the seven went through a pull request.** `Bishop` — the exact commit
named as the one a spot-checker would find — arrived via **PR #126**.

**What the reader must find:** each of those six is reachable as a non-merge
parent of a merge commit on `development`, and the corresponding PR is merged.

**The variable is merge strategy, not process compliance.** Squash rewrites the
author to the merging account; a merge commit preserves the branch commits
verbatim; a direct push preserves them trivially. Review happened in six of the
seven cases, so identity survival says nothing about whether a PR was used.

**This makes the note's own claim cleaner, not weaker.** `%an` still carries zero
bits about _which session wrote a commit_, and it is still occasionally
informative and therefore trusted. It simply is not a covert indicator of skipped
review, and using it as one would be a second field read for a property it does
not carry — the precise error this note was written about, committed against this
note's own subject.

## One variable explains both halves

```
                        identity          trailer
squash                  destroyed         88.8% present
merge commit (own msg)  n/a               21.4% present   <- generated
merge commit (imports)  preserved          100% present
direct push             preserved         98.7% present
```

**Both mechanisms are functions of merge strategy.** Not, as I first wrote here,
failures on _opposite_ routes — that phrasing was built on the same
misclassification and I am retracting it in place rather than deleting it, for
the same reason nothing above was deleted.

**The consequence for remedies is sharper than either half suggested alone.**
Identity loss is entirely attributable to squash. Trailer loss is 44% generated
merge-commit messages, 52% one historical day, 4% the bootstrap commit. **A
push-time control sits on the one route where both mechanisms already work.**

## Method note, since this correction repeats the note's own lesson

The first cut of _this_ correction classified by committer name and reported
`squash 13 / direct 1` with merge commits silently folded into squash. **The
defect being corrected was reproduced while correcting it**, and was caught only
by splitting on `%P`. The note's closing sentence is the reason:

> **"Does this value vary across cases I know to be different"** — a query over a
> population, which cannot be run on the single row in front of you.

`%cn` does not vary between a squash and a merge commit. Both read `GitHub`.
