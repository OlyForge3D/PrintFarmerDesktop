---
name: agent-collaboration
description: How PrintFarmer Desktop squad members hand work to each other, review, and merge. Read before delegating work, reviewing a commit, or acting on a review verdict.
---

# Agent collaboration

## Roles

- **Ripley** — Technical Lead. Owns triage, sequencing, review dispatch, and **all merges**.
- **Ralph** — Work Monitor. Scans the board, delegates, reports. Read-only in the main checkout.
- **Bishop** — Rust / SQLite / integration. **Dallas** — React / Electron UI.
- **Hicks** — QA / correctness reviewer. **Vasquez** — security reviewer.

Charters live in `.squad/agents/<name>/charter.md`. Standing decisions live in `.squad/decisions.md` and **override** anything here.

Before writing any verification or matching command — a substring check, a
reachability check, a status comparison — read `.squad/known-lying-commands.md`
first. It catalogues commands that answer a plausible neighbouring question
instead of the one asked, with no error to distinguish the two.

## The merge gate

A PR merges only with **unanimous reviewer approval** plus **green CI**. The author never merges their own work.

Reviews are run as independent agents against an **exact commit SHA and branch-contribution range**, not "the PR" and not a bare commit diff. Always pin both in the review request and require the reviewer to confirm them.

## Documentation-Only Changes: One Reviewer

**This section is the single definition of the documentation-only reviewer rule. Anywhere else that mentions it points here and does not restate it.**

The gate above requires **unanimous reviewer approval**. A documentation-only pull request requires **exactly one reviewer** instead.

This reduces reviewer **count**, not review **rigour**. The single reviewer runs a real review against a pinned SHA and range and ends with a `VERDICT:` line like anyone else, and every other rule in this file still holds: the author still does not merge, the branch is still frozen once review is dispatched, the verdict still has to be recorded on the pull request, and green CI still authorises nothing on its own. Rule 9 of `.squad/routing.md` is untouched — an author-opened squad PR still needs a human GitHub approval or a verified `squad/pre-pr-verdict` status, because one reviewer is still not zero reviewers and still is not the author.

### What documentation-only means

**Every** changed path must be prose or agent-instruction content. That set is already defined executably in this repo by `isDocumentationPath` in `scripts/docs-only-change.mjs`. Read it there rather than keeping a second list here — two lists drift, and the whole point of one canonical definition is that they cannot. As it stands today it recognises:

- any path ending `.md`, anywhere in the tree — this is how `.squad/**` prose qualifies, since `.squad/` is deliberately **not** registered as a directory prefix there;
- anything under `docs/**`, `.github/agents/**` or `.github/instructions/**` — of those three only `docs/**` exists in this repo today, and the other two are provisioned for rather than present;
- the root `LICENSE` file.

Everything else is source: TypeScript, Rust, tests, workflow YAML, scripts, assets, and every dependency manifest. Manifests are matched by **basename**, so a nested `packages/foo/package.json` cannot slip through as prose.

Two consequences to state plainly, because both have been argued the wrong way:

- **A pull request touching one markdown file and one source file is not documentation-only.** The test is "every path", not "mostly prose". Full gate.
- **An empty or unreadable changed-file list is not documentation-only.** "Nothing changed" and "the diff could not be computed" arrive as the same value, and only one of them is safe to act on.

### The CI classifier is necessary, never sufficient

`scripts/docs-only-change.mjs` answers a narrower question than this one: may CI stand down the expensive steps a prose edit cannot affect. Its `docs_only=true` output is **not** authority to drop to one reviewer and must never be quoted as such. A change qualifies only when it is documentation-only by that classifier **and** clear of every carve-out below.

The gap is concrete, and this repo already pins it: `tests/docsOnlyChange.test.ts` asserts that `isDocumentationPath('.squad/agents/ralph/loop.md')` is `true`. That is the right answer for build compute and the wrong answer for reviewer count — see carve-out 3.

### Carve-outs that keep the full gate even when only markdown changed

1. **Anything under `.github/workflows/**`.** Workflow YAML is not documentation to the classifier either; it is named here so the two answers cannot be argued apart later.
2. **Security policy, threat model, licensing, provenance and published contract documents** — `docs/security/THREAT_MODEL.md`, `docs/adr/0001-printer-calibration-source-provenance.md`, `docs/compliance/**`, `docs/scene-contract.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. Several of these are already CODEOWNER-gated in `.github/CODEOWNERS`; this carve-out is the reviewer-count half of the same intent.
3. **Any change that alters an agent's safety boundary, merge-safety rules, or destructive-operation permissions.** This is the carve-out that matters most in this repo, because `.squad/**` is documentation by path while governing real autonomous behaviour. A markdown edit here decides whether an unattended agent may merge, force-push, delete a branch, or write outside its own worktree. That is not low-risk prose, whatever its file extension says.

Reference example for carve-out 3: `.squad/agents/ralph/loop.md` §1 (Safety Boundary), §8 (Session Lifecycle and Reaping) and §9 (Merge Safety). A pull request that changes what Ralph is permitted to merge, push or remove takes the **full gate**, even though the file is a single `.md` and CI will correctly classify the change as documentation.

The carve-out turns on what a change **alters**, not on which file it lives in. Fixing a typo in that same file's §10 reporting format alters no permission and is documentation-only. Adding, relaxing or deleting a clause in §1, §8 or §9 is not. When the two readings are close, take the full gate: an extra reviewer on prose costs minutes, and a rule loosened without review is how an unattended merge goes wrong, which is the incident class `.squad/decisions.md` already records.

### Routing the single reviewer

Pick by domain from `.squad/routing.md`, and pick someone listed Active in `.squad/team.md`. Where the domain is unclear or the change is cross-cutting, the default is this repo's Lead, **🏗️ Ripley**.

## Generate the review target; do not select one by hand

Immediately before every dispatch, run:

```powershell
npm run review:target -- --pr <number>
```

Dispatch only from an exit-0 brief, and copy its full head SHA, base SHA, merge base, and `merge-base..head` range. The command deliberately accepts no SHA argument: it reads the current pull-request head, draft state, and current base from GitHub, derives the range through the compare API, then re-reads the mutable inputs before emitting anything.

- **Exit 1 means wait and rerun; it is not a permanent rejection.** A draft PR is not ready for review dispatch, a newly pushed valid head can briefly have zero check runs, and the head, base, or draft state can move while the brief is being derived.
- **Never dispatch a draft PR merely to obtain merge clearance.** Mark it ready through the normal process first, then rerun the guard. A stable draft defers without deriving a range; movement into or out of draft discards every value derived from the earlier read.
- **Exit 2 means no target was established.** A CLI failure, API failure, empty response, or malformed count must never be interpreted as zero.
- **A multi-parent head is not invalid.** A sync merge can be the real current branch head. Its bare commit diff is first-parent scope and can show only trunk's changes, so review `merge-base(current base, current head)..current head` instead.
- **Do not cache or reuse a generated brief.** The command closes movement during its own reads; it cannot freeze the branch after it exits. Dispatch immediately, and the reviewer must re-read the live API head and draft state before returning a verdict.

This is an executable guard only for dispatches that use its output. The repository cannot intercept the session-dispatch API, so bypassing it remains a process breach rather than a mechanically impossible action.

## Record the verdict on the pull request

**A verdict that is not on the PR does not exist.** Post every review outcome as a comment on the pull request, naming the exact head SHA it was pinned to, before communicating it anywhere else.

This is not bookkeeping. Two rejected PRs once sat at `reviewDecision: ""`, zero reviews, zero comments, **6/6 green CI** — indistinguishable, to any automation, from mergeable work. The hourly backlog driver is told to merge "green and approved" PRs, and nothing in the repository marked those two as rejected. Both carried reproduced defects.

So, when a review blocks a PR:

- **Convert it to draft** — `gh pr ready <n> --undo`. Draft is a mechanical merge block no automation can bypass, and it is reversible when the fix lands. Here draft means "blocked by review", not "unfinished".
- **Green CI is necessary but never sufficient.** Before merging anything, read `isDraft`, `reviewDecision`, `reviews` and `comments`. A PR with no recorded verdict is **unreviewed**, whatever colour CI is.
- **Verdicts are pinned to a SHA.** An approval recorded against an older head does not authorize merging a newer one.

The PR is also a delivery channel that does not drop messages. Cross-session chat demonstrably does — a fix list once sat undelivered while its author pinged asking why the PR had no reviews. Put the durable copy where the work is.

### What actually enforces a blocking verdict today, and what will (#480)

**Only one channel currently mechanically refuses a merge: converting the PR to draft** (`gh pr ready <n> --undo`). Everything else — a `BLOCKING` review comment, a `hold:*` label, the `Sequencing hold` check going red — is **advisory**: legible to any reader, refused by no API. #480 measured this directly (PR #349 merged despite a live `BLOCKING` verdict) and this file, `.squad/holds.md`, and `.squad/decisions/inbox/ripley-206-review-verdicts-cannot-bind.md` / `.../vasquez-187-squad-verdict-evidence.md` are the record of why: `required_approving_review_count` cannot move above 0 in a single-collaborator repository (self-review is `422`'d), so a bindable review state is not buildable here, and `Sequencing hold` is not yet a required context (below).

**Chosen enforcement channel for #480, not yet live:** `development`'s `required_status_checks.contexts` gains `"Sequencing hold"` — the check already goes red for any `hold:*` label (`scripts/check-sequencing-hold.mjs`), so a squad member who wants a verdict to bind, rather than merely persuade, applies a `hold:*` label rather than relying on a comment. This is decided and documented (`.squad/decisions/inbox/ripley-480-sequencing-hold-required-context.md`), **not yet enforcing**: it needs (1) `sequencing-hold.yml` to subscribe to `merge_group` and reclassify to `# merge-queue: reports` (a `.github/workflows/` edit, needs a `workflow`-scoped credential) and (2) the repository owner to add the context to branch protection (an admin write). Check `npm run check:hold-gate-readiness` for live status before telling a reviewer a hold label will be refused mechanically — until both prerequisites land, it will not be, and draft conversion remains the only thing that actually stops a merge.

**A comment-only verdict — BLOCKING or otherwise — is explicitly advisory and stays that way even once the above lands.** Nothing proposed for #480 reads free-text comments; the mechanism reads a label, which is why it can be evaluated by a required check at all. A reviewer who wants a verdict enforced must apply a `hold:*` label (today) or, once the required-context prerequisites land, rely on that label being unremovable by anyone without also un-blocking the branch protection check — a comment alone will never do either.

### `/pulls/{n}/reviews` and `reviewDecision` are not review state here (#414)

**Do not treat GitHub's native review objects or `reviewDecision` as evidence that review did or did not happen.** Measured on 2026-08-09: 0 review objects of any state across the 40 most recent merged pull requests (`GET /pulls/{n}/reviews`), consistent with #206's own population measurement (178 PRs, 45 reviews, 0 `APPROVED`, 0 `CHANGES_REQUESTED`). `required_approving_review_count` is currently `0`/unenforced (GraphQL `requiredApprovingReviewCount: null`, treated as authoritative over a diverging REST reading — see #206's control note). Review in this repository happens entirely in prose — issue comments, PR comments, cross-session messages — per the rest of this section, not through GitHub's review mechanism. A sweep that queries `/reviews` or `reviewDecision` and concludes "never reviewed" is reading an object with no subject population, not a true negative about review activity; check PR/issue comments instead. Full decision and measurement: `.squad/decisions/inbox/ripley-414-review-mechanism-has-no-subject-population.md`. **`required_approving_review_count: 1` remains out of scope**, unchanged from #206/#151/#187/#480 — the sole human collaborator cannot self-approve (`422`), so arming it would deadlock every merge. `dismiss_stale_reviews` reads `false` on both API surfaces as of the same measurement; it has never had an approving review to dismiss and is undocumented risk regardless of its value if it is ever re-enabled without a stated subject population.

## Issues and comments are their own address

GitHub issue and comment authorship identifies the shared account, not the squad session that wrote the text. A full-object comparison recorded on issue #347 found no session discriminator: identity-bearing fields were identical, while differing fields identified the comment itself. Do not infer a session from the account, surrounding conversation, or who is currently discussing the artifact.

- Cite the artifact and a stable location: issue or pull-request number plus heading, quoted text, comment URL, or comment ID. Do not name a session as the author of issue or comment text.
- Post critiques, corrections, and rejections on the issue, pull request, or comment thread where the claim lives. The artifact is the durable address; an inferred author session is not a routable address.
- Treat self-identification in body text as voluntary, untrusted metadata. It may be quoted as a claim but does not prove authorship.

This does not change commit-revision ownership or the rejection rule below. Those operate on branch and commit work, not on a GitHub comment's shared-account author field.

## Cross-session message markers are not provenance either

The agent emoji/name marker on a cross-session message (e.g. `🏗️` for Ripley) is authored prose, not an envelope field — it can be copied, summarised, or inherited when a hub session that received traffic from several agents compacts its state into a first-person checkpoint. #372 recorded a concrete case: a message reached one session bearing another agent's marker over four claims that agent states he never made, traced to exactly this mechanism. Provenance is lost at compaction, not at send.

**When refuting or correcting a cross-session claim, quote the sentence you are refuting, with its sender line** — do not address a rebuttal to an identity inferred only from a message's leading marker or sign-off. The quote is checkable against the sending session's stored turns; the marker alone is not. This is the same rule as above, applied to chat instead of GitHub comments: cite the artifact (the quoted text), not an inferred author.

Stamping origin in the envelope and preserving attribution across compaction are known, unresolved remedies (#372) — they need a platform-level change this repo does not control. Do not build a marker-based attribution detector as a substitute; `ripley-attribution-carries-no-bits.md` already showed that a field which is occasionally right (like `%an`) is trusted and therefore worse than one that is never right.

## `session_files` is not an authorship control

Do not use the Copilot session store's `session_files` table (`session_id, file_path, tool_name, turn_index, first_seen_at`) as evidence for _who changed a file_ — #420 measured it against a case with a known answer and it failed in both directions at once. It answers **"which paths did the edit/create tools touch first, per session, per worktree"**, which reads deceptively like the real question because both are tables of file paths.

- **Not sound:** it produced `create` rows for throwaway probe files that were written, read once, deleted, and never reached a branch — zero matching commits, zero on disk.
- **Not complete, and the miss lands on the substantive event:** `first_seen_at` fires once per `(session, path)` and never again, so a later, larger edit to an already-seen file produces no row at all. It also only logs this agent's own edit/create tool calls — `Set-Content`, raw `python`/PowerShell scripts, and `git checkout` are invisible, which is the _normal_ way a scripted mutation battery rewrites a file, not an edge case. And the key is a worktree-absolute path, so one repo-relative file fragments into one row per worktree that touched it, undercounting per-file activity by construction.
- **The two failure modes point the same way:** a session that rewrote a file ten times from a script can show zero or one stale row (cleared), while a session that wrote a 90-second scratch file shows a `create` row (implicated). The errors run in the exculpatory direction, which is the direction nobody audits.

**Use commit identity instead, bounded correctly.** The `Copilot-Session` trailer is a real, resolvable session id (#471), but a single trailer value can span many hours and commits copied from one shared prompt (2026-08-07 amendment above measured one value across 74 commits, 39h33m) — divergent trailers are durable positive evidence of a second writer, identical trailers are not positive evidence of one. Corroborate the trailer with `%cn != 'GitHub'` and `ownCommits`/reflog-derived ownership rather than trusting the trailer alone, and remember commit identity in any form identifies the writer of the git object, never the actor who pushed, merged, or clicked merge. Full write-up: #420.

## Freeze the branch during review

Once a review is dispatched, the branch is frozen. Any push invalidates the verdict, because the reviewer's conclusions no longer describe the commit that would be merged. Push your fix, report the new SHA, then stop until released.

If the head does move, do not silently merge the old verdict forward. Assess the delta: a purely additive test-only commit can be handled as a cheap delta review, but any production change forces a re-review.

Before reporting or acting on any PR state, **re-query the live endpoint**. A snapshot taken minutes ago may describe a head that no longer exists.

## Re-derive state at the moment of use — before routing, holding, reviewing, or publishing

**This applies to every role, not only merge review.** A backlog-routing pass, a held PR
awaiting rework, a review verdict, and a publication step all reason from a SHA or a PR
state — and each of those has an expiry the session cannot see. #568 recorded three
participants (a routing session, a reviewer, and a PR's own author) who each acted within
90 minutes of PR #561 merging, each anchored to a different, already-superseded head they
had fetched earlier in their own session and never re-checked. Every one of them was
accurate about the SHA they quoted; none of them re-fetched before acting. **Staleness has
no local symptom** — a stale value is internally consistent and passes every check run
against it, which is why nothing in any one of those sessions caught it.

**Before routing, holding, reviewing, or publishing against a PR or branch:**

1. `git fetch` and re-read the branch tip — do not reason from a value read earlier this
   session.
2. `gh pr view <n> --json state,mergedAt,mergeCommit` — a closed, merged PR needs no
   further routing, holding, review, or publication step, regardless of what an earlier
   round believed about it.
3. Answer "did my work ship" against the **merge commit**, not the branch's moving tip —
   see below.

### The `--is-ancestor` inversion on a squash-merge repo

**This repo squash-merges** (§9.1 of `.squad/agents/ralph/loop.md`). A squash merge
replays the branch's diff as a **new** commit on the target with no parent link back to
the branch's own commits. So:

```bash
git merge-base --is-ancestor <held-sha> origin/development   # exit 1
```

reads as "never shipped" — and for a squash-merged branch it is **wrong every time**,
because no commit from the branch is _ever_ an ancestor of the target, shipped or not.
This is not a check that sometimes misses; it fails in one direction only, and that
direction is a confident wrong answer, which is worse than an inconclusive one.

**The two honest predicates instead — both anchored to the merge commit, never to the
branch's moving tip:**

- **Ancestry against the merge commit** (primary — durable forever once merged): the
  merge **commit** GitHub produced (`gh pr view --json mergeCommit`) — not the branch's own
  pre-merge tip — genuinely is an ancestor of the target once merged, because it _is_ the
  commit that landed on it, and stays one permanently (barring a revert).
  `git merge-base --is-ancestor <mergeCommit.oid> origin/development` is honest; the same
  command given the branch's own last head is not. See §9.1 for this distinction in full.
- **Content diff against the merge commit** (use to confirm exactly what landed, e.g. that
  a squash reproduced your held content byte-for-byte):
  `git diff <held-sha> <mergeCommit.oid> -- <paths>`, scoped to the paths you actually
  touched. Zero output means the squash reproduced your held content exactly. **This must
  target the merge commit, not `origin/<branch>`.** Diffing against the branch's moving
  tip answers a different, time-limited question — "are these exact bytes still current at
  trunk" — and will produce a false "not shipped" the moment any later, unrelated commit
  touches the same paths, even though the original work landed intact and unmodified. The
  merge commit is a fixed point; diffing against it never decays as trunk keeps evolving.

**Negative-control requirement.** A check that always answers "not shipped" is
indistinguishable, from a single reading, in either case above from a check with real
discriminating power. Before trusting either predicate's result, run it once against a
SHA or path you know for certain is unmerged, or against `git diff <held-sha> <mergeCommit.oid>`
scoped to a path from a genuinely different, unrelated change — and confirm it reports
"not shipped." If it doesn't, the check itself is broken and its "shipped" answer is not
trustworthy either.

### Worked example: PR #561 (squash-merged, `docs/CONTRIBUTING.md` and `scripts/safe-worktree-remove.*`)

PR #561 merged `2026-08-06T19:04:41Z` as squash commit `9991065e`; its pre-merge branch
tip was `14304447`.

```bash
# 1. Dishonest check on the branch's own pre-merge head — reads as "never shipped"
git merge-base --is-ancestor 14304447 origin/development
# exit 1  <-- WRONG: PR #561 shipped hours earlier

# 2. Honest check: content diff of held head against the merge commit, scoped to owned paths
git diff 14304447 9991065e -- scripts/safe-worktree-remove.mjs scripts/safe-worktree-remove.d.mts tests/safeWorktreeRemove.test.ts docs/CONTRIBUTING.md package.json
# `package.json` is non-empty (adds one line, `probe:silent-success`) -- this is NOT
# the squash failing to reproduce held content. PR #500 landed that entry on
# development at 11:53 on merge day, after #561's branch tip (14304447, 11:24) was
# last synced but ~11 minutes before #561 itself was squash-merged (19:04). The squash
# necessarily lands on top of development's *then-current* tip, so a file also
# touched by an intervening, unrelated PR picks up that PR's change too -- this is
# base drift at merge time, distinct from the moving-tip decay described below.
# Isolate #561's *own* contribution to a shared file by diffing against the squash's
# immediate parent instead of the held branch tip:
git diff 9991065e^ 9991065e -- package.json
# adds exactly one line, `worktree:remove` -- matches `gh pr diff 561`'s own
# package.json diff exactly; this is the honest per-PR content check for a file
# also touched by other work landing around the same time.
# The other four paths are exclusively owned by #561 and diff empty against the
# held tip directly:
git diff 14304447 9991065e -- scripts/safe-worktree-remove.mjs scripts/safe-worktree-remove.d.mts tests/safeWorktreeRemove.test.ts docs/CONTRIBUTING.md
# (no output) <-- squash reproduced the held content byte-for-byte on paths #561
# alone owns; no other PR touched these before the squash landed

# CAUTION, do not substitute origin/development for 9991065e above: as trunk keeps
# evolving, the same diff against the *moving* tip instead of the fixed merge commit
# eventually goes nonzero even though this work shipped intact and was never touched
# again -- confirmed live, once other commits later touched these same paths:
git diff 14304447 origin/development -- scripts/safe-worktree-remove.mjs scripts/safe-worktree-remove.d.mts tests/safeWorktreeRemove.test.ts docs/CONTRIBUTING.md
# nonzero output <-- MISLEADING: later, unrelated commits touched these same paths
# after #561 merged; this is not evidence #561 didn't ship, it is evidence the target
# was wrong. Always diff against the merge commit, never the branch's moving tip.

# 3. Honest check: is the *merge commit* (not the branch tip) an ancestor of the target?
git merge-base --is-ancestor 9991065e origin/development
# exit 0  <-- correct: the squash commit itself is on development

# 4. Negative control: same diff shape as step 2 (a real held-ish ref vs. a real landed
# ref, scoped to one path) — applied to a path unrelated to #561
# (scripts/check-merge-landed.mjs is not in `gh pr diff 561 --name-only`'s file list).
# 5baba942 is the merge commit of PR #425, an ancestor of 9991065e that predates
# scripts/check-merge-landed.mjs's own creation entirely. Target is 9991065e, the same
# fixed merge commit as step 2 -- not origin/development, for the reason above.
git diff 5baba9420c3762e5ad68fd25baf0cd61fb8e31ce 9991065e -- scripts/check-merge-landed.mjs
# nonzero output <-- correctly reports "not shipped": the held ref has none of this
# file's content at all, confirming the predicate in step 2 has real discriminating
# power rather than always reporting "shipped"
```

Step 1 and step 3 name the same repository state and disagree only because one names the
wrong SHA — the pre-merge branch tip instead of the merge commit GitHub actually produced.
That is the entire defect: not a broken command, a command asked about the wrong object.

## A verification query asserts the property and the subject, or it asserts nothing

**This is a distinct axis from "Re-derive state at the moment of use" above and from
#214/#305 below — it is about what a single verification query itself must check, not
about when to re-fetch or how to render.** #307: PR #218 reported 9 of 9 checks passing —
every required context green at `head_sha` `dc6aaf79` — while, at that same instant,
`mergeable` was `CONFLICTING`, `mergeStateStatus` was `DIRTY`, a `merge-tree` dry run
against `development` produced six conflicts, and a schema column the merge policy
required was absent from that head. **Not one check was wrong.** They ran on `dc6aaf79`,
they passed on `dc6aaf79`, and the rollup was a true statement about that commit. The
defect is that "green at a SHA" and "safe to merge" are different claims, and only the
first one had an instrument. Six of seven instruments measured the same day shared this
shape — `gh pr checks`, `hold:sequenced`, `ls-remote refs/heads`, a freeze pin, a stacked
base ref, and `updatedAt` (`updatedAt` only partially — see the falsifier below) — each was
precisely correct about the property it checked and silent on whether its subject was
still the thing in question.

**The rule:**

> Every verification query asserts two things or it asserts nothing: that the property
> holds, and that the subject is still the one you meant.

The second assertion is a freshness/scope claim, and it must be **bracketed**, not taken
from a single read:

```
read subject identity  ->  measure property  ->  re-read subject identity  ->  compare
```

A single read _before_ the measurement only pins the start of the window — exactly the
interval in which the subject can move. #307's own worked fix: three separate `gh pr
checks` runs each reported 7/7 green against a head (`e6a8547`, `667c63d`, `5c72694`) that
had already been superseded by a base-sync while the check query was in flight. Every
green was correct for the head it measured. The remedy was bracketing the head read —
`git ls-remote` (or `gh pr view --json headRefOid`) immediately before _and_ immediately
after the checks query — so the claim becomes head-stability _across_ the read, not
head-identity _at its start_. Concretely, for a merge-readiness verification: read
`headRefOid` and `mergeable`/`mergeStateStatus`, run the checks query, re-read
`headRefOid` and `mergeable`/`mergeStateStatus`, and only trust the result if both reads
agree.

### Falsifier — #214 (predicate) vs. #305 (display) vs. #307 (subject)

Three distinct axes, distinguished by which repair actually closes the gap:

|                                                                                                                | Defect is in the...                                                                                                                                                             | Repaired by...                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **#214** ("Our verification commands use matching primitives that silently answer a neighbouring question...") | **predicate** — the command answers a neighbouring question, e.g. `--is-ancestor` on reachability instead of tip-identity                                                       | choosing a **different command**                                                               |
| **#305** ("A value whose displayed form is a lossy projection of its checked form...")                         | **display** — the right command is run, but its rendering collapses distinctions the check itself made, e.g. a REST boolean `mergeable` collapsing `CONFLICTING`/`UNKNOWN`/etc. | printing a **different projection** of output already fetched                                  |
| **#307 (this section)**                                                                                        | **subject** — the right command, correctly rendered, answers truthfully about a subject (a SHA, a PR head) that has since moved out of scope                                    | adding a **subject-liveness assertion** bracketing the property check, not substituting for it |

**#214 already names the adjacent discipline this class is missing**: its "positive
control on the subject" language — prove the corpus is live before trusting an absence —
is a control _within_ a predicate check. #307 is that same discipline being absent from
verification queries **entirely**: #214's instances pass the subject-liveness control and
fail on the predicate; #307's instances pass the predicate and have no subject-liveness
control at all. If a verification query in front of you is repaired by swapping in a
different command, it is #214, not this. If it is repaired by rendering more of the same
output, it is #305, not this. If it is repaired only by re-reading the subject's identity
after the measurement and comparing, it belongs here.

## A status board is a memory wearing the costume of a measurement

**This applies to any multi-row status display, not only a single reported value.**
#275 found six same-day instances of one shape: a board is produced by
measuring, then read later as if it were still measuring, and nothing in its
presentation marks the gap — the values were correct when written. A five-row
merge-queue board where all five rows had moved, a claim re-measured
immediately before sending that still arrived false, and a "not yet merged"
note that a merge falsified nine minutes later are three instances from one
afternoon; #202 and #214 are the same defect in cross-session messages and
verification commands, #253 catalogues the general "answers a neighbouring
question and returns a confident, well-formed value" family it belongs to, and
#274 (`npm-ci-strict`/merge queue) is the same shape with a lockfile in place of
a SHA. `.squad/decisions/inbox/hicks-status-is-not-a-memory.md` and
`.squad/decisions/inbox/vasquez-a-sha-is-a-perishable-claim.md` cover the
single-value case in full; this section is the board-level and multi-state
generalization, and the canonical conventions for **any** status board — merge
queue, CI dashboard, epic tracker, backlog snapshot — live here.

1. **Timestamp every status value, or omit it.** `X at HH:MM` — never a bare
   SHA, a bare "green", or a bare "merged" in a status line. A reader can price
   a timestamped value against how long ago it was taken; a bare one gives
   them nothing to price.
2. **Phrase terminally where possible.** `7/7 at <sha>` is a permanent fact
   about a tree and never expires. `green` is a fact about _now_, and _now_ is
   gone by the time anyone reads it. Prefer the form that stays true forever
   over the form that is only ever true at the instant it was measured.
3. **The receiver re-derives; the receiver never quotes.** Only two
   disciplines act inside the send-to-read interval — receiver-side
   re-measurement and terminal phrasing — and every other discipline is
   sender-side and structurally cannot reach that interval, no matter how
   carefully or how recently the sender measured. Before acting on any board
   row, re-query the live source (`gh`, `git ls-remote`, the workflow run) —
   do not act on the row as displayed. Ralph's merge-gate instance of this is
   codified in `.squad/agents/ralph/loop.md` §9.2 and enforced by
   `scripts/check-gate-premises.mjs`; that section is the merge-gate-specific
   procedure, and this section generalizes it to board reporting broadly.
4. **Distinguish `RED` from `PENDING` explicitly.** A status control that
   collapses "checked and failing" and "not checked yet" into one boolean
   cannot tell "not yet" from "never" — which is exactly how a run that has
   not started reads as a pass. Any status-reporting convention (a board
   column, a merge-gate check, a dashboard cell) must expose at least three
   states — `PASS`, `RED`/`FAIL`, and `PENDING`/not-yet-run — never a two-value
   boolean that forces one of the latter two to borrow the other's meaning.
   Where an underlying API only returns a boolean or an absent field, treat
   absence as `PENDING`, never silently as either `PASS` or `RED`, and say so
   in the board's own legend.

**Blame note.** In every #275 instance the sender did what the existing
protocol asked; the failures are structural, not diligence failures, which is
why "measure more carefully" is not being proposed as a fix here either.

## A rendered value is not the value that was checked

**This applies to any instrument, not only the five already found.** #305
is a class statement over four closed issues that were each fixed as a
separate instrument bug — an abbreviated SHA (#210), the REST/GraphQL
`mergeable` boolean-vs-enum split (#288), `gh run view --log --job <id>`
serving the latest re-run's log for an id naming an earlier one (#261), and
`review.state` collapsing praise, a blocker, and a clearance into the one
state (`COMMENTED`) a same-account reviewer can land (#280) — plus
`conclusion: null` collapsing _in progress_, _queued_, and _never
scheduled_ into one empty cell (on #214's thread). None generalized, so the
same shape was re-derived from scratch five times. It is **not** #214/#253
(`.squad/known-lying-commands.md`): those are instruments answering a
neighbouring question with a different command required to fix them; here
the instrument answers the right question and its **display** is lossy —
fixed by rendering a different projection of data already fetched, never by
a different command. Before trusting or shipping a new instrument, ask:

1. **How many distinct underlying values map to what I am looking at?**
   Name them if more than one.
2. **Is the type I am branching on the type the API documents?** A
   truthiness test over a string enum is always wrong and always looks
   right.
3. **Does the identifier I quoted select the thing I read, or something
   that merely resembles it?** A stale SHA is absent and says so; a stale
   line number or re-run job id resolves and returns different content with
   no error — absence is a safe failure, silent substitution is not.

Full class statement, the five-instance table, and the falsifier:
`.squad/decisions/inbox/fact-checker-305-render-check-lossy-class.md`.

## Rejected commit revisions stay with their owner

The rejection-lockout rule (requiring a _different_ author to revise rejected work) was **dismissed on 2026-07-24**. When a reviewer rejects a commit revision, its branch owner fixes it. Do not infer that owner from an issue or comment author field, and do not rotate the revision.

## Reviewer standards

**Reject only what you can demonstrate.** A finding should name the file and line, the concrete trigger, and ideally include a reproduction. Vasquez's five consecutive rejections on PR #39 were valuable precisely because each shipped real evidence — culminating in an actual working exploit (`race loops=20000 good=19999 evil=1`) rather than a theory.

**Do not hold a PR hostage to unreproduced theoretical risk.** Real-but-speculative concerns are non-blocking observations accompanying an approval.

**Verify claims; do not accept them.** If an author says "no IPC changes", check the diff for `src/preload`, `src/shared`, `src/main`. If they claim a hash matches, recompute it.

**Go beyond the author's tests.** Their tests prove the cases they thought of. Your job is the ones they did not — craft hostile inputs yourself, in `$env:TEMP`, never in the repo.

Reviews are **read-only**. End with exactly one line: `VERDICT: APPROVE` or `VERDICT: REJECT`. A review without a verdict line cannot gate a merge and must be re-run.

## Read-Only Agents Are `task` Calls, Never Sessions

**This section is the single definition of the spawning rule. Anywhere else that mentions it points here and does not restate it.**

The deciding factor is **whether the agent writes**. Nothing else.

- **An agent that writes** — one that produces commits, or that must mutate a working tree — is spawned with `create_session`, which provisions an isolated worktree. One issue, one branch, one session.
- **Every read-only agent** — pure analysis, coordination, research, verification, and above all **code review** — is spawned with the `task` tool, `agent_type: general-purpose`, `mode: background`. A read-only agent needs no worktree, so it must not be handed one.

**Code Reviewers are ALWAYS spawned with `task` and NEVER with `create_session`.** A reviewer produces a verdict, not commits — reviews are read-only and terminate in a single `VERDICT:` line, as stated above. No reviewer in this repo needs a branch.

**Session visibility never justifies a sub-session.** "I want to watch it in the sidebar" is not a write requirement. It is the reason this mistake keeps recurring, and it is explicitly not an exception.

Two costs, both measured and both already paid here:

1. **Reviewer sessions consume implementation dispatch slots.** Ralph runs a hard cap of **5 active sessions** (`.squad/agents/ralph/loop.md` §4, which counts analysis sessions against the same five). A reviewer occupying one of those slots is capacity the backlog driver cannot spend on implementation, so review activity starves the queue it exists to serve.
2. **They strand worktrees that a human has to clear by hand.** There is no automated archival path — §8 of the same file establishes that `archive_session` cannot reach another round's session and that a session cannot archive itself. On 2026-08-08 a manual sweep removed **118 orphaned worktree directories totalling roughly 3.8 GB**, **26 of them in this repo**, caused by exactly this mistake.

**This holds unchanged for a multi-reviewer round.** When a change needs several reviewers, spawn them **all** with `task`, in parallel, in one turn. There is no exception for visibility, for the size of the review, or for the number of reviewers.

## Delegating work

One issue → one branch → one PR → merged before the next starts. Never batch, never stack.

Give a delegate complete context — brevity rules do not apply to delegation prompts. State the worktree path, the read-only constraint on the main checkout, the environment traps (`GH_TOKEN`, `prettier --check`, fresh-process `cd`), the required `Closes #N`, the validation matrix, and that they must not self-merge.

**Check for an existing owner before delegating.** Duplicate delegation has caused real collisions here.

## Never take over a live session's worktree

If a delegated session appears stalled — no turns, no commits, no reply — **do not start a parallel implementation inside its worktree**. Sessions can be alive but slow to report. This was misjudged twice on 2026-07-25, putting two concurrent writers in one worktree; both converged only by luck, and either could have produced a garbled interleaved commit.

If you believe a session is dead: wait, ask again, or create a **new, separate** worktree. Never write into theirs. If you have already done so, verify the worktree is clean and the branch history is coherent before trusting anything in it.

## Close the loop on tracking

Work that ships but is not recorded looks like work that stalled. Every PR needs `Closes #N`. When an epic's tracked children are all closed, **close the epic** — do not leave it open as a container. Keep epic checklists current; a stale `[ ]` next to a long-closed issue makes a finished epic look half-done.
