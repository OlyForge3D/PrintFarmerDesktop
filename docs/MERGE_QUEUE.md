# Development merge queue

Scope: `OlyForge3D/PrintFarmerDesktop`, `development` only. This migration does
not activate itself, enqueue existing PRs, release, or deploy. The independent
merger lands the implementation under the existing strict policy first.

## Contract

The owner selected combined-change testing without manual branch updates.
GitHub's native queue supplies the latest target plus the source changes.
Squash is compatible with the existing linear-history requirement.
**SQUASH groups do not preserve the source head's ancestry.** A diverged
source/group comparison is normal and cannot establish or refute combined
content. Never require `behind_by === 0` between source and group.
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
with a read-only token to verify live queue membership, combined-tree equality,
review, labels and resolved threads. The local queue checker additionally
verifies live protection, app bindings and check-run event attribution. Review
records retain the repository's existing self-attested/owner distinction.
The required context runs after the original source-policy checks and fails
explicitly if they fail or skip. Only its trusted, base-owned job receives
Actions read access; PR-controlled scripts keep their prior read permissions.

### Evidence tiers

GitHub omits `bypass_actors` from ruleset detail for unauthenticated callers
and the job's `GITHUB_TOKEN`; an omitted field is **not** an empty bypass list.
No admin-scoped secret is supplied to `pull_request` or `merge_group` jobs.

- **Per-entry CI (`--event`):** verifies the effective queue rule and its
  matching active, development-only ruleset have serialized `ALLGREEN` squash
  parameters, then verifies single-PR membership, squash-tree equality, review, holds and
  threads. It re-reads queue policy and entry evidence before returning.
  Omitted bypass actors are explicitly reported as `not-checked-no-scope`,
  not verified. If visible, bypass actors must be an explicit empty array;
  present malformed/nonempty values, unreadable policy, or drift fail closed.
- **Privileged admission/assessment:** the local queue checker and
  `npm run check:protection-assumptions` require authenticated ruleset detail
  with an explicit `bypass_actors: []`. Missing detail is a failed assessment,
  never inferred safe from CI success. The assumption check's public tier
  checks feature-branch ruleset coverage but lists `development.merge_queue`
  as `not-checked-no-scope`; it makes no bypass claim either way.

Non-bypassability is therefore an owner activation and privileged admission
premise, **not an assertion made by the CI token**. CI success alone does not
authorize admission or prove this premise remains true. Pause admission and
roll back if the privileged policy cannot be corroborated. The native queue
still requires the combined-result checks for every normally admitted entry.

### Squash combined-result proof

Both `--event` and the local check of an already-built group use the same
production verifier. It fetches the immutable base and group plus the current
`refs/pull/N/head` from this public repository into a fresh isolated bare Git
repository, then requires the fetched source to equal the API/review head.
It never checks out source files, runs source code, uses admin credentials,
or writes remote state. Git environment overrides, global/system config,
templates, replacement refs and external merge-driver configuration are excluded.
Failure to fetch, unsupported Git options, or any ambiguity refuses verification.

The group must be **exactly one commit whose sole parent is the exact event
base**. The verifier derives the unique true merge base of source and base,
runs `git merge-tree --write-tree --merge-base=M BASE SOURCE`, requires a clean
merge, and compares its complete tree SHA to the group's tree SHA. This includes
files both sides changed, file modes, deletions and every directory; a file list
or source-ancestry heuristic is not evidence. Multiple merge bases, conflicts,
missing objects, extra parents/commits and tree mismatches fail closed.

Live verification additionally requires the exact anchored
`refs/heads/gh-readonly-queue/development/pr-N-BASE_SHA` ref and a complete
queue-entry enumeration with exactly one entry for the group, matching the PR
number, current source head and entry identity. Serialized max-one policy
remains mandatory. Entry/source/base and policy are re-read after content and
exact-source-head review verification. A source push invalidates the proof.
The offline proof below intentionally makes **no live membership, policy or
review claim**, and cannot authorize admission or merge.

#### Pre-activation dry run (required)

With the required commit objects available in a local repository, this read-only,
offline-capable command runs the identical content verifier:

```sh
npm run check:queue-squash -- \
  --base e0f8cfef8dd6c321ebfee419039eb22dd4ab7f50 \
  --head 5ba796028512895996c04d0fb72cae2e08c8f33b \
  --group 03b8178c9f4183622589109990170111c0c5927d \
  --repository .
```

These are the real failed #865 group facts, also recorded in
`tests/fixtures/failedSquashGroup.json`. The expected merge base is
`4b7def8d944b048efac8c0e0b054b25f15e8ac5d` and expected tree is
`cea77a7007243b291e093d29a221316f7df6dd1d`. Exit 0 reports
`SQUASH_TREE_VERIFIED`; any absent object exits 2, never a skip/pass. If needed,
fetch the three explicit SHAs from origin first (an inbound, read-only remote
operation), then disconnect and run the proof. Preserve the output and Git
version. The runner must support `merge-tree --write-tree --merge-base`; the
actual production invocation tests capability and refuses unsupported Git.

The method-specific audit covers the entire path: `verifyQueueEvent` no longer
compares source/group ancestry; `checkDevelopmentQueue` applies the same tree
proof to built groups; queue-run checks bind statuses to the exact group SHA,
Actions app and `merge_group` event without a source-parent assumption.
`assertGroupBinding`, `readQueuePull`, the source-head review verifier and
`fingerprint` retain their live identity checks. The workflow retains its
base-owned sparse checkout and read-only job token; only objects, not source
code, are fetched for the proof. Offline tests exercise the production event,
local built-group and dry-run paths using real behind-source squash histories.

## Owner activation (after implementation lands)

Serialize settings changes with the independent merger: pause merge/enqueue
actions, save fresh full protection and ruleset JSON outside the repository,
and record their exact values. Re-read before each write; stop if another actor
changed them. Do not copy a stale full protection document back over live state.

1. Confirm this implementation is reachable from current development and
   `npm run check:merge-queue-contexts` passes against live protection. Run
   `npm run check:protection-assumptions` with an admin credential outside CI;
   preserve all nine names and their
   app bindings. Confirm Actions is enabled, runner capacity is available and
   queue CI can finish within the 120-minute timeout.
   **Before changing settings**, run the pre-activation dry run above against
   the real failed squash group and confirm the exact expected tree/merge base.
   Missing historical objects or a failed proof blocks activation; recover the
   evidence rather than weakening verification.
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
   rule and authenticated full ruleset detail explicitly reports
   `bypass_actors: []` (and `current_user_can_bypass: "never"` for the owner).

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

After re-activation, the first real entry **must be a low-risk, docs-only PR**,
not a feature PR. Prepare or select a genuinely useful documentation change and
complete its normal review/check gates; no synthetic status or dummy success.
The owner/independent merger must verify
real `merge_group` runs produce all nine successful app-bound contexts at the
entry's actual head; confirm source-review/hold verification succeeds, GitHub
merges it without a manual freshness update and the merge commit remains
reachable from development. Actual queue execution
cannot be claimed from offline tests or pre-activation PR CI.
Inspect the trusted `Sequencing hold` job's `--event` output: it must verify
configuration, single-PR membership, squash-tree equality and source-head review with the job token while
explicitly reporting bypass actors `not-checked-no-scope`. Corroborate the
empty bypass list with the privileged assessment immediately before admission
and again after the first real group; retain its source head, base/group SHAs
and workflow run links as evidence. A failed or missing required context is
not successful activation: pause admission, investigate and use rollback if
necessary. The guard comes from the group's base SHA, so this fix must land
under strict protection before creating that group.

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
