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
offering to rebase a branch it was asked to leave alone. Every merge-side
control ever proposed here would have watched that happen without firing.

That a rebase is refused was originally argued here rather than shown, on the
reasoning that a rebase is a force-push. The reasoning is sound and the
demonstration was still owed, because the incident this note exists to prevent
is a rebase specifically and an argument is not an observation. It has now been
run: a branch created on an older base, two commits, a genuine `git rebase`
onto `development` rewriting both, pushed by the branch's own author with
`--force-with-lease`. The server refused with `GH006: Protected branch update
failed`, `Cannot force-push to this branch`, and the remote reference did not
move. Flipping `allow_force_pushes` to `true` and repeating the identical push
from the identical local head succeeded, so the refusal is attributable to that
field. With the hold reapplied, an ordinary commit pushed forward normally,
which is the inverted-cost claim above holding for the rebase case and not only
for an amended commit.

The cost this squad feared is inverted, and that is worth stating plainly
because the fear is what kept the control unadopted. The worry was that
restricting pushes to a held branch blocks its author too, leaving a branch on
which no work can continue for as long as the hold lasts. The measurement says
the opposite: ordinary fast-forward pushes were accepted at every configuration
tested, and only rewrites were refused. A branch held this way is one where
work continues exactly as before and only history rewriting is refused, which
is the thing the hold was about.

Applying it is one call against the branch's protection object and lifting it is
one call to remove it, and the commands below are the ones that were run rather
than a sketch of them. This matters more than it looks. The first version of
this note wrote the call with an ellipsis standing in for the rest of the body,
and that ellipsis was hiding four fields the endpoint requires. The command as
originally written returns `422 Invalid request`, naming `enforce_admins`,
`required_pull_request_reviews`, `required_status_checks` and `restrictions` as
missing, and applies nothing.

```powershell
# apply — every field below is required; omitting any returns 422
'{"required_status_checks":null,"enforce_admins":false,
  "required_pull_request_reviews":null,"restrictions":null,
  "allow_force_pushes":false,"allow_deletions":true}' |
  gh api repos/{owner}/{repo}/branches/{branch}/protection -X PUT --input -

# read back — the write response is not the evidence
gh api repos/{owner}/{repo}/branches/{branch}/protection `
  --jq .allow_force_pushes.enabled            # -> false

# lift — only when the hold is the branch's ONLY protection
gh api repos/{owner}/{repo}/branches/{branch}/protection -X DELETE
```

The failure is worth stating in the direction that hurts. On apply it fails
closed: the call errors, nothing is protected, and the person notices because
they were trying to make something happen. On lift it fails in the dangerous
direction — the call errors and the hold stays on. Somebody following this note
to release a branch would get a 422, and the branch they were unblocking would
remain blocked. That is the stranded-applier failure mode arriving through the
documentation rather than through a session ending, and it was latent in this
note from the moment it was written.

`DELETE` removes the protection object entirely, so it is the right lift only
when the hold is the only thing protecting that branch, which is the ordinary
case for a held feature branch. If the branch carries other protection, flip the
single field with the full `PUT` body above instead. And note that after a
`DELETE` lift the read-back command returns `404 Branch not protected` rather
than `false`: the verification errors on success, which reads like a failed
lift. Confirm a lift by performing the rewrite, not by reading the field.

Every claim in this section was executed against a scratch branch, including the
422 and the 404.

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

A second mechanism binds, and recording it matters because the paragraphs above
would otherwise read as an exhaustive survey when they are a survey of one
object. A repository ruleset carrying the `non_fast_forward` rule with an empty
`bypass_actors` refuses a history rewrite by this account, with the distinct
`GH013: Repository rule violations found`, and the refusal is attributable to
enforcement rather than to the ruleset's existence because flipping that single
field to `disabled` lets the identical rewrite through. Ordinary fast-forward
pushes are accepted throughout, so the inverted cost described above holds on
this instrument too. This is a second independent instance of the finding this
note opens with, arrived at through a different API against a different kind of
object, which is what moves the rule from a generalisation over one measurement
to something worth predicting from.

It also sharpens the unresolved question rather than leaving it. The allowlist's
failure to reach this account cannot be attributed to admin status as such,
because a ruleset with no bypass actors reaches the same account at the same
privilege. Being admin does not confer a general exemption; the allowlist
mechanism specifically does not bind, and the two facts were previously
indistinguishable.

For holding a single named branch the two instruments cost the same — one call
to apply, one to lift, either way — so nothing above needs revising. They
diverge when the question is coverage rather than a hold: a ruleset's reference
pattern matches branches that did not exist when it was written, verified by
creating a branch after the fact and having its rewrite refused, so blanket
protection of feature branches needs no applier at creation and no lifter at
merge and cannot be stranded at all. That is the shape #151 is asking about, and
the tension it raises there is real and unresolved: a rule broad enough to cover
the branches where work has actually been destroyed would also refuse the stack
repair that `.squad/skills/git-workflow/SKILL.md` documents, and naming this
principal as a bypass actor returns the whole thing to a control that reads as
enforced and cannot fire. That decision belongs in #151 and is not taken here.

What has not been separated is whether the allowlist bypass would come from
repository or organisation admin, because both are this principal and the
operational conclusion is identical either way. That is a limit on the
explanation, not on the result.
