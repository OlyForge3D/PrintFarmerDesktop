# #480 decided: `Sequencing hold` becomes the one enforcement channel for a blocking verdict; two owner-only prerequisites remain unmet, so the gate is documented and instrumented but not yet live

**By:** Ripley, per the `squad:ripley` routing on #480 and Ralph's dispatch, which asked for exactly one enforcement channel to be chosen and documented, a live demonstration on a test PR, and — because the acceptance criteria's core setting change requires repository-owner permissions this session does not have — a clear statement of exactly what remains for the owner plus as much verifiable work around that gap as possible.

**Decision.** Of the two channels #480 names, only one is structurally possible in this repository: **(a) add `Sequencing hold` to `development`'s `required_status_checks.contexts`.** Channel (b) — `required_approving_review_count >= 1` — is categorically ruled out, not merely undesirable, for the same reason #111/#151/#206/#187 already found: `jpapiez` is the sole collaborator, and GitHub returns `422` on both self-approval and self-request-changes. No workflow change fixes an API refusal; only a second reviewing identity would, and that identity does not exist here. Channel (a) is adopted instead because it is content/operation-based (it reads a label a required check can evaluate) rather than identity-based (it does not need a second account to ever approve anything).

Channel (a) is **not live today.** It has exactly two prerequisites, both unmet, and both outside what this session can perform:

1. **`.github/workflows/sequencing-hold.yml` must subscribe to `merge_group` and reclassify from `# merge-queue: advisory` to `# merge-queue: reports`.** Today it triggers only on `pull_request: [opened, synchronize, reopened, labeled, unlabeled]`. A required status context whose workflow never reports under `merge_group` does not fail a queued entry — it hangs it in `Pending` forever, with no red anywhere to investigate (#122, and this is exactly the shape `scripts/check-merge-queue-contexts.mjs` already refuses: it independently flags `"Sequencing hold"` as an unsafe required context today, and `tests/mergeQueueReadiness.test.ts` already pins that exact scenario). **No change is needed to `scripts/check-sequencing-hold.mjs` itself** — its `resolvePullRequestNumber` (shared with `check-pr-closure-scope.mjs`) already parses a merge-queue head ref (`refs/heads/gh-readonly-queue/<branch>/pr-<N>-<sha>`) into a PR number, and label-fetching is a plain REST call keyed on that number. The gap is the workflow file's trigger declaration alone — a two-line YAML diff, not new logic.
2. **The repository owner adds `"Sequencing hold"` to `development`'s `required_status_checks.contexts`**, alongside the 8 names already required. Exact call, appending to the existing set (do not drop any of the 8 already-required contexts):

   ```
   gh api -X PUT repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection/required_status_checks \
     -f strict=true \
     -F "contexts[]=Desktop (windows-latest)" \
     -F "contexts[]=Desktop (macos-latest)" \
     -F "contexts[]=Sidecar (windows-latest)" \
     -F "contexts[]=Sidecar (macos-latest)" \
     -F "contexts[]=Release package (windows-latest)" \
     -F "contexts[]=Release package (macos-latest)" \
     -F "contexts[]=Dependency advisories" \
     -F "contexts[]=Closing-reference declaration" \
     -F "contexts[]=Sequencing hold"
   ```

   This is a branch-protection admin write. `gh api repos/.../permissions` shows the active token as `admin: true`, but per this task's own explicit instruction, that capability is deliberately not exercised in this session — the setting change is left to the repository owner, named here rather than made silently.

## Why prerequisite 1 cannot be done from this session either (measured, not assumed)

A scratch branch adding a trivial new file under `.github/workflows/` was pushed and rejected server-side: `"refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope"`. `gh auth status` confirms the active `GH_TOKEN` lacks the `workflow` OAuth scope; a separate, non-active keyring credential has it, but is not the one `git push` uses. This is the same limitation already recorded in `.squad/decisions.md` (#388, remedy 3) for a different script, and in `scripts/check-script-reachability.mjs`'s `UNENFORCED_CHECKS` entries for `check:closed-head-dispatch` and `check:direct-push-artifact`. It is a property of this session's credential, not a property of the repository, and is recorded here rather than routed around silently.

## What was built as verifiable work around the gap

`scripts/check-hold-gate-readiness.mjs` (new) reads the three live facts this decision depends on — the workflow's declared classification/triggers, `development`'s required contexts, and whether the `"development merge queue"` ruleset is actually enforced — and reports exactly which of the two prerequisites remain, plus an urgent escalation if the unsafe combination (context required, workflow still advisory, queue actually active) is ever true simultaneously. `tests/holdGateReadiness.test.ts` pins its evaluator against the real, on-disk `sequencing-hold.yml`: as of this decision, it correctly reports **NOT ready**. `npm run check:hold-gate-readiness` runs it live against `development`; deliberately not wired into a workflow (would require the same missing `workflow` scope), so it is recorded in `check-script-reachability.mjs`'s `UNENFORCED_CHECKS` allowlist alongside the other two entries with the identical blocker, with the same discharge path: once both prerequisites land, delete that entry and the script reports ready under `npm run test`.

## Live demonstration (negative control), captured before either prerequisite exists

Because neither prerequisite is met, the demonstration this decision can produce today is the **baseline** the acceptance criteria asks to contrast against a future "after": a PR carrying the `hold:sequenced` label is not currently blocked from merging (`mergeable_state` is not `blocked` on account of the label; the `Sequencing hold` check runs and can go red, but nothing in `required_status_checks.contexts` reads it). This is recorded as a comment on the demonstration PR opened alongside this decision, with the raw API response, and removing the label is the same PR's own negative control (no change to `mergeable_state`, because neither state was ever governed by the label). The genuine positive demonstration — `mergeable_state: blocked` while the marker is present, flipping to mergeable once removed, both driven by the required-context mechanism itself rather than by CI simply going red — cannot be produced until prerequisite 2 lands, and is named as exactly that in the PR body and in the #480 comment, not silently substituted.

## What this does not reopen

Does not revisit #111 (`enforce_admins: false`, no required approving review), #151's ruleset findings, #206/#187's self-review finding, or #388's decision not to require `Sequencing hold` or `PR closure scope` **as they exist today** (unmodified, `pull_request`-only workflows) — that decision is correct for the workflow's current trigger set and remains true until prerequisite 1 lands. This decision is additive to #388, not a reversal of it: #388 declined requiring the context _given the workflow as it was_; this decision names the two changes that would make requiring it safe, and does not claim either has happened yet.

## What comment-only verdicts remain (acceptance criterion 5)

Unchanged from #206/#187: a comment-only verdict is explicitly advisory. Nothing in this decision, or in the `Sequencing hold` mechanism it adopts, reads free-text PR/issue comments as an input — the check reads the `hold:sequenced` label (an operation on the PR, not prose), which is exactly why it can be evaluated by a required status check at all. `.squad/holds.md` and `.squad/skills/agent-collaboration/SKILL.md` are updated alongside this decision to state this plainly for a reviewer: today, the only channel that mechanically refuses a merge is converting a PR to draft; a hold label or a BLOCKING comment is a request to do that, not itself binding, until prerequisites 1 and 2 above both land.

## The trigger to revisit

The moment both prerequisites land — a `workflow`-scoped credential adds `merge_group:` support and the `reports` classification to `sequencing-hold.yml`, and the repository owner adds `"Sequencing hold"` to `development`'s required contexts — `npm run check:hold-gate-readiness` will report ready, `check-script-reachability.mjs`'s allowlist entry should be deleted, and the genuine positive/negative-control demonstration this decision could not yet produce should be captured and posted to #480 before it is closed.
