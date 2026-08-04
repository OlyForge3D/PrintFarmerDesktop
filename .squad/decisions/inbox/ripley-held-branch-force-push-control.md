# The only control that binds this squad is the one that names a verb

Every restraint proposed for a held branch until now attached to an identity:
a push allowlist, a required approving review, a prohibition on merging your own
work. None of them can bind this squad, and the reason is not that they are
badly configured. There is one principal. Every agent authenticates as the same
account, so a rule phrased as _who may act_ has nobody to exclude, and a record
phrased as _who acted_ has nothing to distinguish. Controls phrased as _which
operation is permitted_ do not share that defect, because the operation is
visible to the server regardless of who asks for it. That is the whole finding,
and it is predictive rather than descriptive: it says in advance which proposals
are worth building and which will read as controls in the interface while
restraining nothing.

The candidate this squad was about to adopt was a push allowlist, and it does
not work. Measured on a scratch branch cut from `development`, with the
strictest possible setting — an allowlist naming no users, no teams and no apps,
so that nobody at all is permitted to push — an ordinary fast-forward push was
accepted. Turning `enforce_admins` on did not change it. The account is both
repository admin and organisation admin, and the allowlist mechanism does not
reach it. Adopting that setting would have produced a control that appears in
the branch-protection interface, that a reviewer would cite, and that stops
nothing. That is worse than having no control, because a commitment does not
claim to be enforced and this would have.

A different field on the same protection object does bind. With
`allow_force_pushes` set to `false`, a force-push carrying a real history
rewrite was refused by the server, and the refusal is the ordinary protected-ref
rejection: `GH006: Protected branch update failed`, `Cannot force-push to this
branch`. The result is attributable to that field and not to the branch merely
being protected, because the identical rewrite at the identical configuration
succeeds the moment the field is flipped back to `true`. Without that arm the
two rejections would have been consistent with almost anything.

Two properties make it usable rather than merely real. It does not require
`enforce_admins`, which matters because enabling that on `development` has a
live cost of its own; the rejection was measured with `enforce_admins` off.
And it gates the destructive verb rather than the visible one. The incident that
prompted this work was not a merge, it was a sync of a head branch — an agent
offering to rebase a branch it was asked to leave alone. A rebase is a
force-push. Every merge-side control ever proposed here would have watched that
happen without firing.

The cost this squad feared is inverted, and that is worth stating plainly
because the fear is what kept the control unadopted. The worry was that
restricting pushes to a held branch blocks its author too, leaving a branch on
which no work can continue for as long as the hold lasts. The measurement says
the opposite: ordinary fast-forward pushes were accepted at every configuration
tested, and only rewrites were refused. A branch held this way is one where
work continues exactly as before and only history rewriting is refused, which
is the thing the hold was about.

Applying it is a single call against the branch's protection object, and lifting
it is the same call with the field flipped:

```
gh api -X PUT repos/{owner}/{repo}/branches/{branch}/protection \
  -F allow_force_pushes=false ...      # apply
  -F allow_force_pushes=true  ...      # lift
gh api repos/{owner}/{repo}/branches/{branch}/protection \
  --jq .allow_force_pushes.enabled     # read back, always
```

The permission required is repository administration, which on this repository
every squad session already holds, because there is one account. That is
convenient and it is the same fact that makes the identity-based controls
useless, so it should not be read as a safeguard: anyone who can apply the hold
can lift it, including the agent the hold was applied against. The control is
therefore a guard against an unconsidered rewrite, not against a determined one,
and it should be described that way rather than as an authorisation boundary.

The failure mode worth naming is the applier's session ending before the hold is
lifted. It is real, and it is much cheaper than it looked while the
author-blocking cost was assumed. A stranded `allow_force_pushes: false` on a
feature branch costs nothing to anybody still working normally on it; commits
land, pull requests update, review proceeds. The only operation that stays
refused is a rewrite, and the recovery is one API call by any session. This is
the same shape as a hold whose issuing session no longer exists, which this
squad met twice in one day from opposite directions, and the general rule is the
same: a restraint that can outlive its issuer must be liftable by somebody who
is still here, or carry an expiry. This one is, so it does not need one.

The mechanism is not fully pinned and the claim should not be stretched. It has
not been separated whether the allowlist bypass comes from repository admin or
organisation admin, because both are this principal and the operational
conclusion is identical either way. That is a limit on the explanation, not on
the result.
