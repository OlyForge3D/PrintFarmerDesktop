# A hold must state how it ends

Every hold — a merge pause, a required status context, an applied branch
protection, a request to stop and wait — must carry either an expiry, or a
release authority that outlives the session issuing it. A hold with neither is
defective at the moment it is issued, not at the moment it strands. The defect
is in the text of the hold and it is visible there, before any work is blocked.

A hold worded "in force until an explicit release is broadcast" names no party.
While its author is present this reads as unremarkable, because the author is
obviously the one who will broadcast. Once that session is gone the sentence has
no referent, and there is nobody who can satisfy the release condition. The hold
does not expire, cannot be lifted, and every actor who arrives afterwards
refuses correctly and indefinitely.

The general form is a gate whose release depends on something that no longer
exists. It has appeared three times in this repository through three unrelated
mechanisms. A repository-wide merge pause was issued by a workflow run that
could not afterwards be reconciled against the workflow inventory. A required
status context was configured that no workflow emits, leaving the pull request
Pending forever. A branch protection was applied to freeze a branch under review
by a session that ended before lifting it, leaving the rewrite refused with no
lifter. In all three the gate is working exactly as specified. Nothing is
broken. The release condition is simply unsatisfiable, and that is not a state
the gate can detect or report.

The distinction the rule actually draws is between a hold released by a state and
a hold released by an act. A hold whose release condition is a state of the
repository — this issue closes when its children are closed, this branch unlocks
when the review concludes — is evaluable by anyone at any time, needs no
authority, and cannot strand, because the thing that discharges it is a fact
rather than a party. A hold whose release condition is an act by a party is only
as durable as that party. This is why the rule does not condemn every hold, and
why an expiry is an acceptable substitute for an authority: a deadline is a state
too. Where a hold must be released by an act, name a party that outlives the
session, or convert the condition into a state that a reader can check.

The medium matters, and one of the two obvious candidates cannot work. A label
cannot carry a release condition, for a structural reason rather than a stylistic
one: the label is a single repository-scoped object with one description shared
by every item carrying it. Five pull requests carried `hold:sequenced`
concurrently against one description string, so any expiry or condition written
there would apply to all five at once or to none. Per-hold data would require
minting a label per hold, which grows the namespace without bound and still
cannot express a condition that is not a date.

A label is also a current-state field rather than a record. A hold applied to
#212 at 01:43:20Z and lifted at 02:09:30Z leaves no trace afterwards: the label
list shows nothing, and a label search does not return the item. The hold
survives only in the events timeline, which is not where anyone looks. So the
label can say that a hold exists, but neither how it ends nor that it ever
existed — which disqualifies it as the medium for the release condition and as
an audit record at the same time. The body is the only per-item medium available,
and the condition must be written there.

One limitation on that conclusion should be recorded rather than glossed. The
property wanted is that a party other than the issuer can lift the hold, and on
this repository that can never be demonstrated by attribution, because there is
one account and every actor reads the same. So it cannot be established by
observing who lifted a hold; it has to be established as a property of the text —
whether the release condition can be evaluated from the artifact alone, without
contacting anyone. That is checkable by reading, which is weaker evidence than a
measurement and is the strongest available here.

What makes this expensive is that refusing looks like rigour. An actor that
declines to proceed because it cannot verify an authorization is behaving well,
and its refusal is indistinguishable from correct caution. So the failure
accumulates behind conduct nobody wants to criticise, and is defended by the
people encountering it. Compare a gate that fails open: it is noticed within
minutes, because something happened that should not have. A gate that fails
closed on an unsatisfiable condition is noticed only when someone asks why a
finished piece of work never shipped.

A second rule follows for the auditor rather than the issuer. When a hold is
issued outside the repository, a repository-side search for its release returns
empty whether or not the release happened, because the medium leaves no artifact
either way. That emptiness must not be read as absence. A check that returns the
same answer in both worlds is not a check, and it is at its most misleading when
it is asked to distinguish precisely the two worlds it cannot separate. The
honest report is that the question was not answered, under a different
diagnostic from the case where the release was searched for in a medium that
would have contained it and did not.

Relaying the release does not repair this, and the reason is worth stating
because the temptation is strongest for whoever is most inconvenienced. An actor
who received an authorization can restate it, but the restatement is not
evidence to a third party. On this repository it can never become evidence:
there is one account, so authorship, review attribution and `mergedBy` cannot
distinguish the coordinator from anyone else. The record cannot be repaired
after the fact. It has to be written at the time, by the actor holding the
authority, into a medium the auditor can read.

Recorded from the merge-queue work on #173, which fail-closed on a pause whose
release condition named no durable authority, and stayed blocked while ordinary
merges continued around it. The instances predate that issue and are not
specific to merges; the rule governs any instruction to stop.
