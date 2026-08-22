# #740 decided: port PrintFarmer's post-#1316 verdict semantics; the record binds to a commit, and it still does not bind a merge

**By:** Copilot coding agent, per the `squad` routing on #740.

**Decision.** Replace this repository's `workflow_dispatch`-only
`squad-review-verdict.yml` with PrintFarmer's post-#1316 shape: a review record
is a PR **comment** carrying a `<!-- squad-verdict -->` marker and exactly-once
`Squad-Reviewer:` / `Squad-Verdict:` / `Squad-Head-SHA:` lines, and the workflow
subscribes to `pull_request_target`, `issue_comment`, `pull_request_review` and
`workflow_dispatch` to republish it as a `squad/pre-pr-verdict` **commit status
bound to the live head SHA**. `squad/pre-pr-verdict` is **not** added to
`development`'s required status checks, and branch protection is not touched at
all. Enforcement is Ralph's merge logic (`.squad/agents/ralph/loop.md` §9), which
now branches on `npm run check:squad-verdict`'s exit code.

## Why the previous gate had to be replaced: it could not fire, ever

Not a design preference — a measurement, taken 2026-08-22 before any code was
written:

- `gh run list --workflow squad-review-verdict.yml -R OlyForge3D/PrintFarmerDesktop`
  returns **zero runs, for the workflow's entire lifetime**.
- Its guard required a repository **administrator who is not the PR author**.
  `jpapiez` is the only collaborator and the only admin (#206 measured that
  population-complete: 178 PRs, 45 reviews, 0 `APPROVED`, 0
  `CHANGES_REQUESTED`, 1 collaborator), and authors every agent PR.

So the conjunction "administrator AND not-the-author" has an empty solution set
here. `.squad/decisions/inbox/vasquez-187-squad-verdict-evidence.md` said as much
in its own §1 — "Today, on this repository, only the first is achievable" — and
parked the mechanism until a second identity appeared. It has not appeared, and
#111/#151/#206/#414 each independently concluded it will not appear on this
repository's current configuration. PrintFarmer hit the identical defect on its
own issue #1310 and fixed it in PR #1316; this is that fix, ported.

## Engaging #206 point by point, because this does not override it

`.squad/decisions/inbox/ripley-206-review-verdicts-cannot-bind.md` decided that
**binding reviews cannot work here and arming a verdict-shaped required check is
worse than not**. That conclusion stands unchanged. Its three specific technical
objections, answered in its own terms:

1. **"`reviewDecision` can never move off empty; `required_approving_review_count:
   1` is a deadlock trap."** Untouched and unreopened. This design does not use
   GitHub review objects as the carrier at all. It reads them only on the
   **owner-override** path — an administrator's own native approval or change
   request at the current head — which is exactly the one case #206 agrees is
   real, because that principal is distinct from the agents. No approving-review
   requirement is configured or proposed, and `required_approving_review_count`
   stays at 0.

2. **"A check reading the PR body is not re-armed by a body edit unless its
   workflow subscribes to `edited`."** Honoured directly: the workflow subscribes
   to `pull_request_target: [..., edited, labeled, unlabeled]` as well as
   `issue_comment: [created, edited, deleted]`. #436's general fix
   (`scripts/check-body-edit-triggers.mjs`) is the same requirement, and this
   workflow satisfies it rather than working around it.

3. **The central objection — "a comment produces no new head, so there is no
   re-run point bound to the commit a merge would certify — a required check
   built on it could pass while certifying a revision of the conversation that
   no longer reflects the live state."** This is the one thing the ported design
   actually changes, and it changes it precisely:

   - The re-run point exists. `issue_comment: [created, edited, deleted]` is that
     re-run point. Posting, editing or deleting a record re-evaluates the gate.
   - The binding to the commit exists. Each run reads the PR's **live** head SHA
     from the API and writes the status against *that* SHA — not against the SHA
     the comment names, and not against a remembered value. A record whose
     `Squad-Head-SHA:` is not the live head is **stale by construction** and
     contributes nothing.
   - The "certifying a stale revision of the conversation" failure is therefore
     inverted: a comment that no longer reflects the live state cannot produce a
     passing status, because the status is recomputed from the whole live
     comment list at the live head on every relevant event, and a `synchronize`
     push re-runs it too.

   That closes the mechanism gap #206 identified. It does **not** license the
   conclusion #206 struck, and this decision does not take it. See below.

4. **"Arming it as a merge requirement would reintroduce the exact trap struck
   for #151's Option 3 and paid for again at #280: a control that reads as
   enforced in the checks list and cannot fire."** Accepted in full, and it is
   the reason `squad/pre-pr-verdict` stays out of branch protection. Two further
   reasons of its own, on top of #206's:
   - The gate reports `NOT_APPLICABLE` (green) for any PR without the `squad`
     label. As a required context that is a control that passes for exactly the
     PRs nobody reviewed — the #151 shape again.
   - It is classified `# merge-queue: publication` because it never runs on
     `pull_request`. `scripts/check-merge-queue-contexts.mjs` already refuses to
     let a `publication` context be required: it would hold every entry at
     "Expected — waiting for status" forever (#122).
   - PrintFarmer, which has run this design longer, likewise does **not** require
     it: its required contexts are `CI summary`, `CI tooling tests`,
     `path-casing`, `Select affected tests`, `Build (iOS)`.

5. **"Restraint by choice, with the alternatives named."** #206 adopted that for
   *blocking* verdicts, and it remains the answer for them: as of #480 the only
   mechanical merge refusals here are a `hold:*` label (a required context) and
   draft state. What #740 adds is on the other side of the ledger — evidence of
   **presence**, machine-readable and commit-bound, so "nothing reviewed this at
   all" stops being indistinguishable from "reviewed thoroughly", which is
   #414's finding and #149's original incident. That is a strictly additive
   reading, not a new gate.

## What this is honest about, and must stay honest about

**Self-attested. No separation of duties.** Every squad agent — Bishop, Hicks,
Vasquez, and every author agent — runs under the owner's authority and posts
through the owner's token. A reviewer agent "approving" an author agent is the
owner approving the owner's own work. The reviewer-is-not-the-author rule in the
gate is a **quality heuristic** (a second agent with fresh context catches more
than the author re-reading its own output), not an independence guarantee. The
status wording enforces the distinction mechanically rather than by convention:
agent records emit `REVIEWED (self-attested)`, and only a repository
administrator's own decision emits `APPROVE (owner)`.
`scripts/verify-squad-verdict.mjs` classifies those separately (`REVIEWED` vs
`APPROVED`) so nothing downstream can present one as the other, and
`tests/squadVerdictGate.test.ts` asserts the workflow keeps saying so.

**No bot hop.** Posting the record as `github-actions[bot]` to make the metadata
imply a second party is explicitly rejected. It adds no judgement; it only
launders identity. `hasWriteAccess` allowlists no bot identity, and the test
suite pins that.

## The security properties that had to survive the port, and where each lives

This repository is **public** and Ralph merges autonomously using the owner's
write access, so a forgeable record would hand a stranger the owner's privileges.

| property                     | implementation                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| SHA binding                  | status written against the live head; `collectVerdicts` pools current vs stale separately                     |
| authenticated authors        | live `getCollaboratorPermissionLevel`; `admin`/`maintain`/`write` only; `read` and `triage` rejected           |
| fail closed                  | any API error, rate limit or unexpected shape resolves to `unresolved`, which `hasWriteAccess` rejects         |
| identity from the API only   | `parseVerdictComment` takes the login from `comment.user.login`, never from the comment text                   |
| sanitisation                 | fenced blocks (including an unterminated fence), `>` quotes and every other HTML comment stripped before parse |
| forks never self-attest      | fork PRs take the administrator-only path; auto-scoping refuses forks outright                                |
| a PR cannot judge itself     | gate logic checked out from the default branch; `pull_request` (head-ref) is deliberately not a trigger        |
| the job never fails the PR   | the job always succeeds; the result is carried by the commit status                                           |

## Deliberate divergences from PrintFarmer, and why

1. **Layout.** `scripts/squad-verdict-gate.mjs` + `.d.mts` twin, not
   `scripts/ci/`. This repository's convention is flat `scripts/*.mjs` with
   declaration twins (`check-run-verdicts`, `verify-squad-verdict`), and
   `scripts/check-script-reachability.mjs` enumerates `scripts/` specifically.
2. **Harness.** Both suites are vitest under `tests/*.test.ts`, not `node:test`.
   Every case is carried across; none is dropped.
3. **No YAML parser.** PrintFarmer's label-write capability test parses each
   workflow with `js-yaml` after three rounds of regexes being defeated by valid
   YAML. This repository ships no YAML parser by policy — the header of
   `scripts/check-merge-queue-contexts.mjs` makes that choice explicitly for the
   same class of question — so the test uses a small structured reader instead,
   and pins it with a control (`permissionShapes`) that asserts it returns the
   same answer for all three shapes that defeated the regexes, and the opposite
   answer for seven non-granting forms.
4. **Documentation classifier reused, not re-derived.** `classifyChangeScope`
   delegates to `isDocumentationPath` in `scripts/docs-only-change.mjs` — this
   repository's single executable definition of "documentation" — and layers the
   carve-outs from `.squad/skills/agent-collaboration/SKILL.md` on top, rather
   than copying PrintFarmer's independent prose list. Two lists drift; one
   cannot.
5. **Carve-out 4 added.** `isDocumentationPath` admits `docs/**/*.png`, which is
   right for build compute and wrong for reviewer count: the one-reviewer
   exemption is justified by "one person read the prose". The gate intersects it
   with a prose-extension list, which is strictly narrower and can only fail
   toward the full panel. Documented in the SKILL as carve-out 4.
6. **Reviewer-count policy points at the SKILL,** not at
   `.github/copilot-instructions.md`, because that is where this repository
   defines it. The docs↔code agreement test points there too.
7. **Roster is plain.** This repository's labels are `squad:bishop`, not
   `squad:🔍 bishop`. `normalizeMember` handles both; the fixtures use the real
   shape and keep one decorated entry so the emoji path stays covered.

## The coupling that must not be broken

The gate's opt-in `squad` scoping is safe **only** because a PR outside that
scope is not merged unattended. `exitCodeFor('NOT_APPLICABLE')` is 4, not 0, and
`.squad/agents/ralph/loop.md` §9 now states that exit 4 is never permission to
merge. `scripts/squad-verdict-gate.mjs`'s `squadScopeLabel` names that section as
its counterparty. If either side is relaxed without the other, forgetting a label
stops meaning "a human merges this by hand" and starts meaning "unreviewed agent
code auto-lands". Keep them together.

## What this does not reopen

Does not revisit #111 (`enforce_admins: false`, no required approving review),
#151's ruleset question, #206's conclusion that binding reviews cannot work here,
or #480's choice of `Sequencing hold` as the one binding channel. Branch
protection is not modified by this change in any respect.

## The trigger to revisit

Unchanged from #206 and #151: the moment a second reviewing principal exists
whose verdict is not structurally inert. At that point `REVIEWED` could become a
genuine second-party signal rather than a self-attested one, and the question of
whether `squad/pre-pr-verdict` should bind can be reopened together with #111,
#151 and #206 — not before.

## Validation

```
npx vitest run tests/squadVerdictGate.test.ts tests/squadReviewVerdict.test.ts \
  tests/scriptReachability.test.ts tests/mergeQueueReadiness.test.ts \
  tests/ciWorkflowTriggers.test.ts
npm run check:script-reachability
npm run typecheck && npm run lint && npm run format
```
