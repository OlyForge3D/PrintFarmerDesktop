# Empty query results are not answers

A query that returns nothing is satisfied by two different states: the thing
does not exist, and the thing is not stored where the query looked. Nothing in
an empty result distinguishes them. Report what was observed — "no review
object found by `gh pr view --json reviews`" — rather than what it was taken to
mean — "no review yet". The first invites the follow-up that the second
forecloses.

The worked example is from this repository's own review process. Independent
reviewers here post verdicts as pull request **comments**, not as GitHub review
objects. So `gh pr view <n> --json reviews` returns `[]` and `reviewDecision`
returns `""` on a pull request that has been reviewed thoroughly and approved.
PR #147 was reported twice as awaiting review on that basis while an approval
sat in its comment thread. `gh pr view <n> --comments` finds it.

The general form is worth stating because the consequence scales past one
misread. An audit built on `reviews` — "list pull requests merged without
review" — returns clean forever, and returns clean most loudly when the
practice it audits is universal. The field cannot represent the thing being
asked about, so the check cannot fail.

That connects this to the rule about assertions that cannot fail, and the two
are the same defect reached from opposite ends. There, an assertion is placed
downstream of the code that already enforces its property, so it passes
regardless of the state of the world. Here, a query is aimed at a field that
never holds the property, so it comes back empty regardless of the state of the
world. Both produce a green result that is independent of the thing being
checked, and neither announces itself. Before trusting either, ask what
observation would make it come out the other way; if no reachable state would,
it is measuring nothing.

The practical test for a query is cheap. Construct the positive case and
confirm the query finds it. If a review is known to exist and `reviews` is
still `[]`, the query is wrong rather than the world being empty.
