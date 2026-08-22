# Decide #187: squad review is advisory; add PrintFarmer's SHA-pinned verdict evidence

## The problem, confirmed live against this repository

Every squad agent authenticates as the same GitHub account (`jpapiez`), and
that account opens every PR. GitHub refuses self-review unconditionally:

```
gh api -X POST repos/OlyForge3D/PrintFarmerDesktop/pulls/149/reviews -f event=REQUEST_CHANGES
  422  "Review Can not request changes on your own pull request"
gh api -X POST repos/OlyForge3D/PrintFarmerDesktop/pulls/149/reviews -f event=APPROVE
  422  "Review Can not approve your own pull request"
```

`development`'s branch protection, read live at the time of this decision:

```
required_approving_review_count : 0
dismiss_stale_reviews           : true    <- governs a state that cannot exist here
require_code_owner_reviews      : false
enforce_admins                  : false
allow_force_pushes              : false
required contexts               : 7 (Desktop x2, Sidecar x2, Release package x2,
                                      Dependency advisories, Closing-reference declaration)
```

Zero approvals are required, and no approval is obtainable. #149
accumulated nine blocking verdicts from a dedicated reviewer session,
including two unrepaired blockers, all posted as `gh pr comment`, and was
mergeable the instant its required checks went green — `reviews: []`
throughout. The interim fix (converting #149 to draft) stopped that one
merge but is not a repeatable control.

## Prior decisions on record, read before proposing anything

- **#111** (cited throughout `scripts/check-protection-assumptions.mjs` and
  `tests/protectionAssumptions.test.ts`) already declined
  `required_approving_review_count: 1` and `enforce_admins: true` as
  _impossible_ rather than merely undesirable: the sole collaborator is the
  sole admin, GitHub forbids self-approval, and either setting would deadlock
  every merge in the repository permanently, not just squad-authored ones.
  #111 named its own revisit trigger — a second collaborator or a non-admin
  automation account — and `check-protection-assumptions.mjs` already fails
  CI the day that premise moves. This decision does not reopen #111; it
  formalizes what #111 already implied (review cannot be a native GitHub
  mechanism here today) and gives it a real, written status plus a concrete
  artifact.
- **`scripts/check-review-head-coverage.mjs`** already exists, already ships,
  and says so explicitly in its own text: _"This is a reading, not a gate. It
  reports absence and blocks nothing."_ The repository has already built and
  accepted an advisory-only review-coverage report as correct design. This
  decision is consistent with that precedent, not a reversal of it.
- **`.squad/decisions/inbox/ripley-held-branch-force-push-control.md`**
  (#151-adjacent) establishes the working rule for this single-identity
  repository: controls phrased as _who may act_ bind nobody here, because
  there is one principal; controls phrased as _which operation is permitted_
  bind regardless of identity. The mechanism adopted below is closer to the
  second kind than the first — it does not depend on GitHub recognizing a
  second identity, it depends on a workflow run's own server-generated
  metadata being internally consistent and independently checkable.
- **`.squad/decisions/inbox/ripley-a-hold-must-state-how-it-ends.md`**: any
  hold needs an evaluable release condition, not a party that might not
  outlive the session that named it. The mechanism below is evaluated by
  reading facts off the GitHub API (the workflow run and the commit status),
  not by trusting a party's later say-so.
- No hits found for issues #206 or #501 anywhere in `.squad/` (grepped
  `.squad/decisions.md` and every file under `.squad/decisions/inbox/`).
  Nothing here supersedes a decision filed under those numbers.

## Why this decision follows OlyForge3D/PrintFarmer instead of inventing a new mechanism

PrintFarmer hit the identical structural problem under issue **#1116**
("policy: reconcile the squad pre-PR gate with repository merge-evidence
requirements") and shipped a fix in **PR #1187** ("policy: add trusted squad
verdict evidence"). The repositories share an owner, a squad convention, and
— critically — the exact same single-collaborator identity constraint. Per
explicit instruction, this decision ports that shipped mechanism rather than
inventing a competing one (an earlier draft of this decision proposed
draft-PR gating; it was rejected in favor of matching PrintFarmer exactly).

PrintFarmer's fix does not attempt native GitHub review and does not rely on
convention. It records a verdict as a **commit status pinned to an exact
head SHA**, where the provenance of that status is the **workflow run that
created it**, not the account that happened to trigger the run:

- `.github/workflows/squad-review-verdict.yml` — `workflow_dispatch`-only.
  A human supplies `pr_number`, the exact 40-character `reviewed_head_sha`,
  and a `verdict`. The job rejects reruns (`run_attempt !== 1` or an
  actor/triggering-actor mismatch), requires the PR to be open and
  same-repository, **rejects if the dispatching actor is the PR author**,
  requires the dispatching actor to hold **admin** collaborator permission,
  and requires the PR's _current_ head to equal the reviewed SHA before it
  will post anything. It then posts a commit status
  (`context: squad/pre-pr-verdict`) on that SHA, with `target_url` pointing
  at the workflow run itself.
- `scripts/verify-squad-verdict.mjs` — does not trust the status at face
  value. It requires the status to have been created by
  `github-actions[bot]`; its `target_url` to resolve to a real, completed,
  successful run of exactly `.github/workflows/squad-review-verdict.yml`;
  that run's `run_attempt`, `triggering_actor`, `head_branch`, and
  `default_branch_contains_run` to hold; and the run's own **server-generated,
  attacker-unwritable** `display_title` to encode the same PR number, SHA,
  and actor as the status description. It rejects the case where the
  recording actor equals the PR author. It classifies each PR as `APPROVED`,
  `CHANGES_REQUESTED`, `SUPERSEDED` (a rebase or force-push moved the head
  since the verdict was recorded — checked for _both_ an approval and a
  rejection, so a stale block cannot survive but also cannot silently expire
  the wrong way), `MISSING`, or `INVALID`.

This is what "real, not convention" means in the shape #187 asks for: an
author-written PR comment claiming "the panel approved this" and a verified
`squad/pre-pr-verdict` status are not the same artifact, and the verifier
distinguishes them by checking facts the author cannot fabricate (the
workflow run's own recorded actor and attempt number), not by trusting
attribution.

## Decision

1. **Identity model: (b), advisory-only, stated in writing — with the same
   honesty PrintFarmer used.** Distinct GitHub identities per squad persona
   are not adopted; that is org-level account provisioning, out of this
   squad's scope to decide unilaterally, and #111 already declined the
   premises that would make native GitHub review meaningful here. This is
   not silently accepted: **author-opened squad PRs require a human GitHub
   approval, or a verified `squad/pre-pr-verdict` status, before merge.**
   Today, on this repository, only the first is achievable — the workflow
   above exists so that the day #111/#151's already-tracked revisit trigger
   fires (a second collaborator or a non-admin automation account), the
   second becomes achievable without further engineering.
2. **The control that ships now:** `.github/workflows/squad-review-verdict.yml`
   and `scripts/verify-squad-verdict.mjs`, ported near-verbatim from
   PrintFarmer PR #1187, adapted only for this repository's flat
   `scripts/*.mjs` layout and vitest test harness (PrintFarmer uses
   `scripts/ci/` and `node:test`). Full test port in
   `tests/squadReviewVerdict.test.ts`.
3. **Deliberately not wired as a required branch-protection status check.**
   Nobody can dispatch it automatically — it is `workflow_dispatch`-only by
   design, so that only a specific, accountable, non-author administrator
   act can produce a verdict. Requiring its context would deadlock every
   merge exactly the way this repository's own
   `scripts/check-merge-queue-contexts.mjs` already documents and guards
   against ("a required status context that no workflow emits under a
   merge_group event leaves the queue entry Pending forever"). PrintFarmer
   made the identical choice: `development` there carries no review-related
   branch protection at all. The workflow is classified
   `# merge-queue: publication` in its own header for the same reason that
   classification exists — it never runs on `pull_request`, so requiring it
   would deadlock every PR immediately, queue or no queue.
4. **Reconcile `development` branch protection with reality.** Drop the
   `required_pull_request_reviews` block (`required_approving_review_count: 0`,
   `dismiss_stale_reviews: true`) entirely rather than leaving it in place.
   `dismiss_stale_reviews: true` currently governs a review state — a
   recorded GitHub review object — that structurally cannot occur on this
   repository; a setting that describes a nonexistent process reads as
   evidence the process exists, which is worse than no setting at all. This
   mirrors PrintFarmer's own choice not to configure a review requirement
   that can never be satisfied. The 7 existing required status contexts
   (Desktop, Sidecar, Release package, Dependency advisories,
   Closing-reference declaration) are untouched.
5. **Not resolved by asking reviewers for more diligence.** The artifact
   here is the same one PrintFarmer shipped for the identical problem: a
   verifiable, non-forgeable, SHA-pinned record plus an honest written
   statement of today's fallback, not a request for more care from anyone
   already being diligent (#149's nine verdicts were rigorous; the mechanism
   consuming them was the defect, not the reviewer).

## What this does and does not claim

It does not claim review is currently mechanically enforced for
author-opened squad PRs on this repository — it is not, and this document
says so in the same sentence PrintFarmer used. It does claim: (a) the
non-enforcement is now a written decision rather than an implicit gap, (b)
the infrastructure for a real, non-forgeable verdict record exists and is
tested, ready for the moment a second identity exists, and (c) nothing here
was resolved by asking anyone to be more careful.

## Validation

```
npx vitest run tests/squadReviewVerdict.test.ts tests/scriptReachability.test.ts \
  tests/mergeQueueReadiness.test.ts tests/ciWorkflowTriggers.test.ts
```

`development` branch protection change verified by read-back after the `PUT`,
not by the write response (per
`ripley-held-branch-force-push-control.md`'s own warning that the write
response is not evidence).

---

## Update, 2026-08-22 (#740): items 2 and 3 above are superseded; item 1's premise was wrong

**Kept:** the diagnosis (§"The problem"), the identity model (advisory, not
native GitHub review), and the decision *not* to make `squad/pre-pr-verdict` a
required status check. All three still hold.

**Superseded:** the mechanism. This decision shipped PrintFarmer PR #1187's
`workflow_dispatch`-only workflow requiring a **non-author repository
administrator** to dispatch it by hand, and reasoned that it would become
achievable "the day #111/#151's revisit trigger fires". That reasoning was
wrong in a way this document could have caught at the time: `jpapiez` is the
only collaborator *and* the only admin *and* the author of every agent PR, so
"administrator AND not-the-author" had an empty solution set from the first day.
Measured 2026-08-22: `gh run list --workflow squad-review-verdict.yml` returns
**zero runs, ever**. The control this decision shipped never fired once, and
"ready for the moment a second identity exists" was doing the work that
"currently inert" should have been doing.

PrintFarmer found the identical defect on its own issue **#1310** and replaced
the mechanism in **PR #1316**: the record is now a PR comment carrying a
`<!-- squad-verdict -->` block, and the workflow subscribes to
`pull_request_target` / `issue_comment` / `pull_request_review` and publishes the
status against the **live** head SHA. #740 ports that. Item 3's conclusion is
unaffected and was re-derived independently — the status stays out of branch
protection.

**Item 4 is unaffected** and is not re-litigated here; see #206's control note
for the later measurement of `development`'s `required_pull_request_reviews`
sub-resource disagreeing with GraphQL.

Full reasoning, including a point-by-point engagement with #206:
`.squad/decisions/inbox/copilot-740-squad-verdict-semantics.md`.
