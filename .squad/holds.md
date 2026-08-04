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

**It prevents nothing.** It is a convention with no mechanical enforcement. Any
session with push access can rebase, sync, force-push or merge a PR carrying
this label, and nothing in GitHub will stop it. There is no required status
check behind it, no branch protection tied to it, and no automation watching for
it.

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
