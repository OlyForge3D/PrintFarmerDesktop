# #414 decided: `/pulls/{n}/reviews` and `reviewDecision` do not carry review state here — restated with a fresh, dated measurement; `dismiss_stale_reviews` is not the live setting the issue measured

**By:** Ripley, per the `squad:ripley` routing on #414.

## The measurement, taken today (2026-08-09)

- **40 most recent merged pull requests, `GET /pulls/{n}/reviews`:** 0 review objects of any state across all 40 (re-run independently of the issue's own count, which found 2 `COMMENTED` reviews among a different/older 40; both counts are consistent with the underlying claim — review objects are rare-to-absent and never `APPROVED`).
- **Live branch protection on `development`, GraphQL (`branchProtectionRules`, treated as authoritative per `.squad/decisions/inbox/ripley-206-review-verdicts-cannot-bind.md`'s control note):** `requiresApprovingReviews: false`, `requiredApprovingReviewCount: null`, `dismissesStaleReviews: false`.
- **Same setting, REST (`GET /branches/development/protection/required_pull_request_reviews`), same moment:** `required_approving_review_count: 1`, `dismiss_stale_reviews: false`.

Both surfaces disagree with each other on `required_approving_review_count` (`null`/false-requirement via GraphQL vs. `1` via REST) — the identical REST/GraphQL divergence #206 already named and resolved in GraphQL's favor, because `gh pr view` on live open PRs shows `reviewDecision: ""` (never `REVIEW_REQUIRED`, the value GitHub sets when an approving-review count is actually enforced) and PRs merge without ever satisfying a count of 1. **On `dismiss_stale_reviews` specifically, both surfaces now agree: `false`.** This is a live, dated reading distinct from #414's own opening measurement (which quoted `dismiss_stale_reviews: true` from a REST read at an earlier moment) — the setting has since changed, drifted between API surfaces, or was read at a moment the two endpoints disagreed; today, right now, neither surface reports it as `true`.

## Decision

1. **Restated, with today's measurement, for future sweeps:** `/pulls/{n}/reviews` and `reviewDecision` do **not** carry real review state in this repository. Review happens in prose — issue comments, PR comments, cross-session messages — not through GitHub's native review mechanism. This was already decided in `.squad/decisions/inbox/ripley-206-review-verdicts-cannot-bind.md` (178 PRs, 45 reviews, 0 `APPROVED`, 0 `CHANGES_REQUESTED` — that issue's population) and is reaffirmed here with an independent, dated re-measurement (40 merged PRs, 0 reviews of any state, today) so a sweep landing on #414 specifically finds the statement without having to cross-reference #206.
2. **`required_approving_review_count: 1` is not proposed and is out of scope for this decision**, per #414's own instruction and unchanged from #206/#151/#187/#480: the sole human collaborator cannot self-approve (`422`), so arming any approval requirement above 0 would deadlock every merge, not gate them.
3. **`dismiss_stale_reviews` is not currently `true` on either API surface as of this measurement**, so there is nothing to remove. Recorded here rather than silently dropped: it lacks written justification regardless of its current value, because zero approving reviews have ever been submitted for it to dismiss — a control with no subject population is undocumented risk whether it currently reads `true` or `false`. If it is ever set to `true` again (by the repository owner; this session cannot write branch protection), it must be re-justified against an actual subject population at that time, not re-enabled by default drift between API surfaces.

## Where this is filed

This entry, `.squad/decisions.md` (once merged by Scribe), and `.squad/skills/agent-collaboration/SKILL.md` (see the addition made alongside this entry) are the three places a future sweep asking "was this reviewed?" or "is `dismiss_stale_reviews` justified?" should find the answer, per #414's own regression criteria.

## The trigger to revisit

Unchanged from #206/#480: the moment a second reviewing principal exists whose verdict is not structurally inert (self-review is no longer the wall), re-open this decision, #206, and #151 together.
