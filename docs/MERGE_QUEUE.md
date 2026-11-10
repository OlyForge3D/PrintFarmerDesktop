# Development merge queue

Scope: `OlyForge3D/PrintFarmerDesktop`, `development` only. This migration does
not activate itself, enqueue existing PRs, release, or deploy. The independent
merger lands the implementation under the existing strict policy first.

## Contract

The owner selected combined-change testing without manual branch updates.
GitHub's native queue supplies the latest target plus the source changes.
Squash is compatible with the existing linear-history requirement.
One build and one merge at a time preserve serialized integration and make the
Sequencing hold workflow's PR attribution unambiguous. `ALLGREEN` retains
verification for every entry; `HEADGREEN` is not allowed.

The nine required contexts remain bound to GitHub Actions (`app_id: 15368`):
Desktop, Sidecar, and Release package on both windows-latest and macos-latest;
Dependency advisories; Sequencing hold; Design detector. Every effective extra
required context must also have merge-group workflow coverage. No fake statuses,
skipped required jobs, admin token on PR/group code, or reduced required set.
CI's existing merge-group path performs full combined-result verification.

Source reviews stay bound to the exact source SHA. The synthetic merge-group
SHA is CI evidence, not a new author revision or a substitute review. The
required Sequencing hold context uses scripts checked out from the group's base
with a read-only token to verify live queue membership, source containment,
review, labels and resolved threads. The local queue checker additionally
verifies live protection, app bindings and check-run event attribution. Review
records retain the repository's existing self-attested/owner distinction.

## Owner activation (after implementation lands)

Serialize settings changes with the independent merger: pause merge/enqueue
actions, save fresh full protection and ruleset JSON outside the repository,
and record their exact values. Re-read before each write; stop if another actor
changed them. Do not copy a stale full protection document back over live state.

1. Confirm this implementation is reachable from current development and
   `npm run check:merge-queue-contexts` passes against live protection. Run
   `npm run check:protection-assumptions`; preserve all nine names and their
   app bindings. Confirm Actions is enabled, runner capacity is available and
   queue CI can finish within the 120-minute timeout.
2. Read ruleset `20361532` again. It was disabled at implementation time.
   Preserve its name, exact development-only condition, and empty bypass list.
   PUT `/repos/OlyForge3D/PrintFarmerDesktop/rulesets/20361532` using its
   writable fields with `enforcement: "active"` and this queue rule:

   ```json
   {
     "type": "merge_queue",
     "parameters": {
       "merge_method": "SQUASH",
       "max_entries_to_build": 1,
       "min_entries_to_merge": 1,
       "max_entries_to_merge": 1,
       "min_entries_to_merge_wait_minutes": 0,
       "grouping_strategy": "ALLGREEN",
       "check_response_timeout_minutes": 120
     }
   }
   ```

   Minimal difference from the inspected disabled ruleset: activate it,
   `max_entries_to_merge: 5 -> 1`, timeout `60 -> 120`. Keep unrelated rules
   if any appeared; investigate new constraints instead of deleting them.
   Confirm GET `/rules/branches/development` contains this effective queue
   rule and full ruleset detail reports `current_user_can_bypass: "never"`.

3. Only once the queue requirement is active, PATCH
   `/repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection/required_status_checks`
   with **only** `{"strict": false}`. The PATCH endpoint preserves the live
   checks array and its app bindings. Read it back and compare the entire
   before/after check set. Never replace checks with a contexts-only list.
4. Verify the queue checker accepts the live queue policy (a PR can still
   correctly fail for unready CI/review). The old behind guard must now return
   4, never direct-merge permission; the sync planner must exclude development.
   Run the protection and workflow coverage checks again. Resume admission.

Do not change `enforce_admins: false`, linear history, conversation resolution,
review settings, force-push/deletion settings, or any other branch/repository.
The queue ruleset itself has **no bypass actors**, including admins.
Strict can remain true during the short activation overlap; strict=false
without a verified active queue fails closed.

## Independent merger operation

Re-derive live gate premises and usable review at the exact source head. After
all existing gates, checks, holds and threads permit it:

```sh
npm run check:development-queue -- --pr N --head REVIEWED_SOURCE_SHA
npm run check:development-queue -- --pr N --head REVIEWED_SOURCE_SHA --enqueue
```

The wrapper never enables auto-merge and uses `expectedHeadOid` to reject a
concurrent source push. It rechecks policy, source, base and membership around
admission. An error after admission means inspect live membership before
retrying; never infer that an uncertain request failed to enqueue. GitHub
rebuilds groups when their inputs change and only merges after required checks
pass. A waiting entry or unfinished/missing group check is not "ready" and is
not a reason to rebase. Conflicts still need resolution and reviewed fixes.

Do not push, change review disposition or apply a hold to a queued PR without
first removing it from the queue and confirming removal. After such changes,
revalidate and explicitly enqueue again. Queue evidence is per observation:
changes to source SHA, live target, group or policy invalidate prior readings.
Never reuse a green from another group, another event, another app or an
earlier source revision. Do not jump the queue or bypass it with `--admin`.
After GitHub merges, verify the **merge commit** landed with
`npm run check:merge-landed -- N`, not ancestry of the squashed source SHA.

For the first existing authorized PR, the owner/independent merger must verify
real `merge_group` runs produce all nine successful app-bound contexts at the
entry's actual head; confirm source-review/hold verification succeeds, GitHub
merges it without a manual freshness update and the merge commit remains
reachable from development. No dummy PR is needed. Actual queue execution
cannot be claimed from offline tests or pre-activation PR CI.

## Rollback

Pause admission, remove/confirm removal of any queued entries, then restore
`strict: true` using the same narrow PATCH. Confirm all nine app-bound checks
are unchanged **before** disabling the queue ruleset. Restore only the settings
changed above, retaining unrelated concurrent changes. Re-run policy checks;
the behind guard must resume ancestry-based refusal and the manual sync lease
procedure applies again. Never disable the queue while strict=false.

## Official references

- [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue):
  native combined-change testing, merge-group triggers, ALLGREEN, squash and
  queue reconstruction after failures.
- [Repository rules REST API](https://docs.github.com/en/rest/repos/rules):
  effective branch rules and merge_queue ruleset parameters.
- [Branch protection REST API](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection):
  narrow PATCH of strict while retaining checks and app bindings.
- [GraphQL pull request API](https://docs.github.com/en/graphql/reference/pulls):
  MergeQueueEntry and enqueuePullRequest with expectedHeadOid.
- [gh pr merge](https://cli.github.com/manual/gh_pr_merge):
  native queue behavior and why `--admin` must not be used.
