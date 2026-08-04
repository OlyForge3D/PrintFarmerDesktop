# Holds

How to recognise a deliberately held pull request, and what to do about it.

## The problem this solves

A held PR and a stalled PR look identical from the outside. Both are green, or
nearly green, and neither has been merged. An agent session that arrives with no
prior context sees a PR that looks finished and unattended, and the helpful
thing to do — sync it, rebase it, merge it — is exactly the wrong thing.

The reasoning behind a hold normally lives in chat between sessions. **Chat is
not in the repository and cannot be reconstructed from it.** A session reading
only this repo and a PR's metadata has no way to tell the two cases apart. This
document plus the `hold:sequenced` label is what makes the difference visible.

## `hold:sequenced`

> Held by the lead. BEHIND is intentional; do not rebase, sync or merge.

### What it asserts

The PR is **deliberately** not being merged, and its being behind `development`
is **deliberate too**. Someone is sequencing it against other work — usually
because two PRs touch the same paths and the order of landing matters, or
because a decision the PR depends on has not been made yet.

It asserts nothing about the PR's quality. A held PR may be complete, reviewed
and green. Held is not the same as unfinished, and the label does not mean
"needs work".

### What it does **not** do

**It prevents nothing.** Read that precisely, because one half of it changed and
the other half did not.

**What now exists:** a check run named **`Sequencing hold`**
(`.github/workflows/sequencing-hold.yml`, `scripts/check-sequencing-hold.mjs`).
It runs on every pull request and re-runs on `labeled` and `unlabeled`, so it
tracks the hold with no push. A held PR shows a **red check whose name says
`Sequencing hold`**, and whose output says the red is deliberate and lists the
actions not to take. That is the part that reaches a session which was never
told this document exists — it appears in `gh pr checks`, which every session
already runs.

**What still does not exist:** it is **not a required context** and is wired to
no branch protection rule. It cannot be, yet: a `merge_group` entry carries no
pull request and therefore no labels, so the check does not report there, and a
required context that never reports blocks a queue entry forever instead of
failing it. So any session with push access can still rebase, sync, force-push
or merge a PR carrying the label, and **the check will not be what stops them.**
It makes the hold _legible_, not _binding_.

**"The label enforces nothing" is not the same as "nothing is enforced."**
Ordinary branch protection on `development` applies to a held PR exactly as it
does to any other — `strict: true` means a PR that is `BEHIND` cannot be merged
until it is brought up to date, and the required contexts must pass. Those are
real and they will refuse the merge. **They have nothing to do with the hold**,
they would apply identically if the label were removed, and they do not make the
hold safe.

The trap is the inverse reading: seeing a held PR blocked by strict-mode
behind-ness and concluding the hold is being enforced. It is not. Bring the
branch up to date — which the hold asks you not to do — and the only thing left
between that PR and `development` is somebody's restraint.

**One measured warning, because these settings do not behave the way they read.**
Do not conclude from `enforce_admins: false` that an admin account can therefore
force-push a protected branch. Measured on a scratch branch:
`allow_force_pushes: false` **rejects a rewrite by a repo-admin and org-admin
account even with `enforce_admins: false`**, while an _empty_ push allowlist —
nobody permitted at all — does not stop that same account from pushing at all.
The two behave opposite to the way the surrounding configuration suggests.
Reason about them from measurement, not from the shape of the settings page.

This is stated plainly because the alternative is worse: a label that reads like
a lock, but isn't, invites exactly the confident action it appears to forbid.
**If you are relying on this label to stop something, it will not.**

The question of whether any control _could_ restrain a held branch is tracked
separately, along with a measured answer for the force-push case. This document
describes the signal; it is not the control and should not be read as one.

### Who may apply it

The lead (Ripley). In practice, whoever is sequencing the work — but the label
asserts that a specific person is holding it, so applying it without being that
person makes the assertion false.

### Who may lift it

The person who applied it, or the lead. **Removing this label is a decision, not
housekeeping.** If it looks stale, see the escalation path below rather than
removing it because nothing seems to be happening — nothing seeming to happen is
what a hold looks like.

### When the PR **merges**, the hold is over — and this is now automatic

**This was the one lift that is housekeeping, and it was the one nobody did.**
Every other rule above exists to stop a stranger clearing a live assertion. This
rule is the opposite: once the PR is merged, the assertion _"do not merge this
yet"_ is not contested, not delicate, and not lift-by-decision. It is simply
**false**, and it is false permanently, because a merged pull request cannot be
reopened and nothing downstream will ever revisit it.

**`.github/workflows/lift-sequencing-hold.yml` now removes it for you**, on
`pull_request: closed` with `merged: true`. You do not need to remember this
rule, which is the point — a rule you have to remember is not a control.

**Correction: "merged" and "closed" are not interchangeable, and the earlier
version of this section said "merges or closes".** Both produce
`state: "closed"`, so it is an easy conflation, but only one of them is
terminal. A **closed** pull request can be reopened, so its hold may still be
live and stripping it would produce exactly the state this document exists to
prevent — a held PR with nothing saying so — introduced by the automation meant
to fix it. **A merged one cannot be reopened.** The workflow therefore acts only
on a merge, and reports what it left alone when it declines.

**Why this had to be automated rather than remembered.** Measured on this
repository:

| event              | what happened                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| 07:47:07–07:47:15Z | `hold:sequenced` removed from #154, #169, #172, #174 — a manual sweep, four PRs, eight seconds |
| —                  | #175 was still **open**, so the sweep correctly left it                                        |
| 13:21:27Z          | #175 merged, and carried the label afterwards                                                  |

**The sweep did not fail. It expired.** It was correct when it ran and was
falsified five and a half hours later by an event nobody was watching for. The
defect regenerates on every merge, so the correct action has a shorter shelf
life than the interval between sweeps. That is not something diligence fixes.

**One consequence to know about, and it matters more now that the lift is
automatic.**

> **Any audit of holds must read the timeline, not the current labels.**
> Current labels are a mutable summary of an immutable log.

Removing a label erases it from the label list _and from label search_ — a
label is a current-state field, not a record. The `labeled` and `unlabeled`
events in the timeline are permanent and survive removal, so the timeline is the
only durable evidence that a hold ever existed:

```powershell
gh api repos/OlyForge3D/PrintFarmerDesktop/issues/<N>/events `
  --jq '.[]|select(.label.name|startswith("hold:"))|"\(.created_at) \(.event) \(.label.name)"'
```

**The automation above will erase this evidence class from the label field by
design**, which is correct — the label's job is to say what is true now — but it
means an auditor who queries labels will increasingly find nothing and conclude
no hold was ever applied. **That conclusion will be wrong, and it will get more
wrong over time.** Query the events.

**A worked example of why the distinction is not academic.** A count of held PRs
taken with `--state open` returns zero, while the same query with `--state all`
returns five. The defect being counted is _holds surviving into merged_, so the
filter that felt natural — look at open PRs — excludes the entire population by
construction. **The defect and the failure to measure it have the same cause:
merging is the moment attention leaves.**

### The instrument, which is a second lagged copy — and the worked example above uses it

Read the two paragraphs above carefully and they disagree with each other. The
rule says _query the events, not the labels_, and the code block it offers does
exactly that, at the object. Then the worked example demonstrates the point with
`gh pr list --label` — **which is neither the events nor the labels. It is a
search index built over the labels.** The section teaching the good instrument
illustrates itself with the worst one available. That was mine, and it is left
here rather than quietly swapped, because the substitution is so natural that
the author of the rule made it three paragraphs after stating it.

There are three renderings of a hold, not two:

| rendering                          | what it is                               |
| ---------------------------------- | ---------------------------------------- |
| `issues/{n}/timeline` label events | the immutable log — authoritative        |
| `issues/{n}/labels`                | a mutable summary of the log             |
| `gh pr list --label` / search API  | a **lagged copy of the mutable summary** |

**The third one has a cell that does not reconcile.** Measured on this
repository, all four combinations of operation and pull-request state:

|               | label **add** | label **remove**           |
| ------------- | ------------- | -------------------------- |
| **open** PR   | < 20 s        | ~12 min                    |
| **merged** PR | < 20 s        | **> 11 h, not reconciled** |

Three cells are healthy, which is what makes the fourth worth stating precisely.
It is **not** that closed pull requests are stale — an add on a merged PR
appeared in twenty seconds. It is **not** that removals are broken — a removal
on an open PR reconciled in twelve minutes. It is **not** general lag — twelve
minutes and eleven hours are not the same process. **Only the intersection
fails**, and a hypothesis that survives one observation looks identical, from
inside that observation, to one that survives four.

**Removing a hold label from a merged pull request is that intersection**, and
it is precisely and exclusively what the automation above does.

Two consequences worth knowing before you audit anything:

- **The error direction is over-reporting.** The index lists holds that have
  already been lifted, so it errs toward _don't touch that_ — and inaction on a
  merged PR produces no symptom, no complaint and no bug report. Nobody escalates
  because a merged pull request looked held.
- **The wrong answer is stable across re-runs.** The obvious response to a
  surprising result — run it again — returns the same populated, well-formed,
  plausible list, and reads as confirmation.

So a backfill that reports **_selected five candidates, lifted zero_** is a
healthy backfill seeing phantom rows, not a broken one. `gh api
repos/OWNER/REPO/issues/{n}/labels` settles it in one call and is authoritative.

If you find a **closed but unmerged** PR still carrying the label, that is the
case the workflow deliberately does not touch. Decide whether it will be
reopened before removing it by hand.

### What a session encountering it must do

1. **Stop.** Do not sync, rebase, force-push or merge the branch. Do not offer to
   do any of those as a suggested next step.
2. **Read the PR's comments**, not just its metadata. The hold's reason,
   its owner and its lift condition should be in a comment on the PR. If they
   are not, that is a defect in how the hold was applied — say so.
3. **Say what you found** rather than acting on it. "This PR carries
   `hold:sequenced`, applied by X, waiting on Y" is a complete and useful
   answer. Merging it is not.
4. **Work on something else.** A held PR is not an invitation to help.

### Applying it properly

Applying the label alone leaves the next reader with a signal and no content.
Whoever applies it should also comment on the PR with:

- **who** is holding it,
- **what** it is waiting on — ideally an issue or PR number, not a description,
- **what condition lifts it**, so a reader can tell whether that condition has
  already been met.

A hold whose lift condition is unwritten cannot be evaluated by anyone except
its owner, which is the failure the escalation path below exists to handle.

### Why applying it cannot be automated, and lifting can

**Asked directly: find the moment a hold becomes real and put the label there,
so the label is a consequence of holding rather than a second thing to remember.
There is no such moment, and the reason is structural rather than a gap in the
tooling.**

**A hold is an abstention, and an abstention emits no event.** Merging produces
`pull_request: closed`. Reviewing produces a review. Pushing produces a push.
_Deciding not to merge_ produces nothing at all — it is indistinguishable, in
every API this repository can read, from not having looked at the PR. There is
no webhook for a decision that was taken and then not acted on.

**The nearest thing that exists is the merge driver's skip list** — a variable
in the operator's shell naming the PRs it will not merge this cycle. That is a
real record of a real hold, and it has precisely the defect this document was
written about: it lives in an ephemeral session, so it cannot be read by anyone
else and does not survive the session that holds it.

**What it would cost to fix, stated plainly.** Make the driver read its skip
list _from the label_ instead of from a variable, so skipping and labelling are
one act. That is worth doing: it reduces two records to one, and moves the
surviving one into the repository where a stranger can read it. **But it does
not remove the remembering.** Someone still decides, by hand, that a PR goes on
the list. It relocates the discretionary act; it does not eliminate it. Anyone
describing that change as making the hold automatic is overstating it, and this
paragraph exists so that nobody has to take the claim on trust.

**Lifting is different, and that asymmetry is the whole reason the automation
sits on the lift side.** A hold ends at a real event — the merge — which GitHub
emits, which is unambiguous, and which is terminal. **Arming has no such event,
so no honest mechanism can be built there.** Saying so is a better answer than a
procedure that asks people to be diligent, because a rule you have to remember
is not a control and dressing one up as a control is worse than having none.

**One hypothesis worth recording as falsified, so nobody re-derives it:** held
PRs are not stacked PRs, so `base.ref` cannot serve as an arming signal. All six
PRs that have ever carried this label (#154, #169, #172, #174, #175, #212)
targeted `development`, and at the time of measurement **zero** open PRs
repository-wide had any other base.

## Escalation when the owner is unreachable

"Ask the owner" is not a procedure when the owner is an ended session. Agent
sessions end, and a hold applied by one that has finished has no one to ask.

In order:

1. **Re-read the lift condition** on the PR. If it names a concrete artifact — an
   issue closed, a PR merged, a file present — **evaluate it yourself.** A hold
   whose stated condition is demonstrably met is a hold that has already expired,
   and saying so with the evidence is better than waiting.
2. **If the condition is met, say so and ask the lead to lift it.** Do not lift
   it yourself. The label asserts someone is holding it; removing it on your own
   judgement replaces their assertion with yours, silently.
3. **If there is no stated condition**, treat that as the defect and report it.
   Do not infer one. Guessing at a lift condition and acting on the guess is how
   a hold gets broken by someone who believed they were being careful.
4. **If nobody can be reached at all and the work is genuinely blocking**,
   escalate to the human maintainer. That is a decision with a name attached,
   which is the point.

## When not to use this label

- **Not for "needs review".** Use a review request.
- **Not for "unfinished".** Use a draft PR, which GitHub already enforces.
- **Not for "I am not sure about this".** Say so in a comment; a hold asserts a
  sequencing decision, not doubt.
- **Not on someone else's PR without telling them.** The label is visible; the
  reason is not, unless it is written down.
