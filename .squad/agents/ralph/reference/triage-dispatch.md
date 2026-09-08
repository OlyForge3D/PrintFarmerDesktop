# Ralph reference — scan, triage, epics, analysis, dispatch (§2–§6)

> Loaded when the round is about to scan the board, triage an issue, maintain an epic, gate
> analysis, or order and dispatch the queue. Not loaded otherwise. `.squad/agents/ralph/loop.md` §1
> and §2 remain in force here and are not restated.

---

## 2. Delta scan procedure

Per-round state is the **durable cache** described in `cache.md`, not a file inside the worktree.
The old `.squad/agents/ralph/.state.json` was written into the ephemeral checkout that produced it,
so it was absent on arrival every round and the delta path never once ran. It is still gitignored
and may still be written for local debugging; it is not the source of truth.

Each round:

1. **Cheap listing pass** — list open issues and open PRs requesting only the comparison fields.
2. **Diff** the listing against the cached snapshot (`diffSnapshot` in
   `scripts/squad-round-plan.mjs`).
3. **Deep inspection** runs **only** for items whose comparison fields changed, plus any item
   currently blocking a dispatch slot. `planReuse` in `scripts/squad-cache.mjs` computes both sets
   and reports, per item, WHICH input moved.
4. **Rewrite** the cache at the end of the round.

Unchanged items must not be re-inspected; carry their prior conclusions forward. A full deep rescan
happens only when the cache reports `missing`, `corrupt`, `schema-mismatch`, or `scope-mismatch` —
all four are ordinary, non-fatal statuses that start from empty.

```bash
gh issue list --repo OlyForge3D/PrintFarmerDesktop --state open --limit 200 \
  --json number,updatedAt,state,labels,assignees,createdAt
gh pr list --repo OlyForge3D/PrintFarmerDesktop --state open --limit 200 \
  --json number,headRefOid,isDraft,reviewDecision,statusCheckRollup
```

**A listing that returns its own cap is truncated until proven otherwise.** 200 rows at
`--limit 200` is indistinguishable, in the output, from a board of exactly 200. `assertCompleteListing`
throws `E_TRUNCATED_LISTING` rather than returning a prefix — paginate, or raise the limit and
re-ask. Never fall back to unfiltered `gh` output.

Deep inspection, only for changed or slot-blocking items:

```bash
gh pr view <n> --repo OlyForge3D/PrintFarmerDesktop \
  --json number,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,reviews,reviewThreads,statusCheckRollup,files,closingIssuesReferences
gh issue view <n> --repo OlyForge3D/PrintFarmerDesktop \
  --json number,state,assignees,labels,createdAt,updatedAt,body,comments
```

---

## 3. Triage rules

**Label reality for this repo — verified, do not assume otherwise.** The families that exist are
`squad:*` (plain forms only: `ripley`, `dallas`, `bishop`, `hicks`, `vasquez`, `rai`, `scribe`,
`fact-checker`, `ralph`, `copilot`), the bare `squad` marker, `epic`, `hold:sequenced`, and
`priority:p0`–`p3`. There are **no `type:*`** and **no `status:*`** labels. Epics carry `epic`, not
`type:epic`. "In progress" is established by a live session or an open linked PR, never by a label.
`status:needs-analysis` must be created before first use.

- An issue is **untriaged** when it carries no valid `squad:*` member label.
- To triage: read the body, assign **exactly one** existing member from `.squad/team.md`, add a
  justified priority label, remove the bare `squad` marker once an owner is applied, and comment
  naming the owner plus a concrete first step. **Never assign Ralph.**
- **Priority backfill.** Every open issue should end up with exactly one priority label. Each round,
  label up to 20 unprioritized issues — `p0` blocking release, `p1` this sprint, `p2` next sprint,
  `p3` backlog — preferring issues that are otherwise READY. Report how many remain.
- **Epics** are tracking/decomposition work: route them for decomposition, never for direct
  implementation.
- Respect the scope and sequencing recorded in the decisions corpus, consulted **through
  `.squad/decisions-index.md`**. Never silently revive a lifted or standing exclusion, and never
  invent scope that no issue states.

---

## 4. Dispatch policy

Cap: **5 active implementation sessions**; analysis sessions (§6) count against the same 5; reviewer
`task` calls do not.

### 4.1 READY — definition

READY only when **every** clause holds. A failing clause never means a silent skip — the issue lands
in a `loop.md` §4.1 bucket naming the failing clause.

1. **Open.**
2. Carries **exactly one** `squad:*` member label. If an emoji-prefixed variant ever appears, it and
   the plain form are the **same owner**. Zero member labels means untriaged (§3); two different
   owners is ambiguous and must be resolved before dispatch.
3. **Unassigned and unclaimed** — no GitHub assignee, no live session owning it in
   `list_sessions_and_chats`, no open PR already linked to it.
4. **Not an epic** (§5).
5. **Not in progress** — established by a live session or open linked PR.
6. **Not `status:needs-analysis`** (§6).
7. **No unsatisfied blocking dependency**, per §4.2.

### 4.2 Blocking dependencies — the native graph is authoritative

GitHub's native dependency graph is the FACT. Both endpoints are reachable on this repository; an
issue with no dependencies returns `[]` with exit 0, which is a real answer and not an error:

```bash
gh api /repos/OlyForge3D/PrintFarmerDesktop/issues/{n}/dependencies/blocked_by --jq '.[] | "\(.number):\(.state)"'
gh api /repos/OlyForge3D/PrintFarmerDesktop/issues/{n}/dependencies/blocking  --jq '.[] | "\(.number):\(.state)"'
```

**Do not judge from prose alone.** The graph and the bodies were measured to disagree in BOTH
directions in the sibling repo: an issue natively blocked with the words "blocked by" nowhere in its
body (a FALSE READY — the session is dispatched into a wall it cannot clear), and an issue carrying
a "Blocked by" table whose native list was empty (a FALSE BLOCKED — held back forever for no
reason).

A `dependencies` / `blocked by` / `depends on` marker in a body or comment is an **additional**
check, never a replacement, and it is a claim that decays:

- Resolve the named issue: `gh issue view <blocker> --json number,state`.
- Blocker **open** → blocked; report the specific blocking issue number.
- Blocker **closed** → the marker is stale. The issue **becomes READY** and is dispatched. Do not
  wait for the marker text to be edited. This is the case the cache must never miss — see
  `cache.md` on the dependency closure including closed members.
- READY requires **both** the native graph and any live marker clear.
- `hold:sequenced` on a linked PR is a deliberate hold (`.squad/holds.md`, addressed by line range
  from `.squad/decisions-index.md`) and does block. Report it as `blocked`; never rebase or merge
  around it.

`openBlockers` in `scripts/squad-round-plan.mjs` implements exactly this union, including the
closed-blocker clause.

### 4.3 Queue order — critical path, not priority alone

Strictly: **effective priority** ascending (`p0`→`p3`, then no recognized priority) → **transitive
unblock value** descending → oldest `createdAt` → lowest issue number.

- **Unblock value** is the count of currently-open issues an issue frees TRANSITIVELY — walk
  `dependencies/blocking` outward. Counting direct children ranks a shallow-but-wide issue above the
  root of a deep chain.
- **Priority inheritance:** a READY issue that transitively unblocks a HIGHER-priority open issue is
  dispatched AT that higher priority. A p2 blocking a p0 is effectively a p0; otherwise the p0 can
  never start. That is priority inversion, and it stalls the board while every individual decision
  looks correct. Name every inherited issue as such in the report.
- Dependency **cycles** are reported, not fatal: `findDependencyCycles` returns them so the round can
  dispatch around them and name them for a human to break.

`orderQueue` in `scripts/squad-round-plan.mjs` is the implementation; its tie-breaks are total, so
the same board produces the same queue every round.

### 4.4 Claim and spawn

- **Re-fetch the issue immediately before each claim** and skip it if closed, assigned, already
  claimed, stale, failed, or duplicate. The cache may not answer this (`loop.md` §2).
- **Claim, confirm the claim landed, then spawn.**
- Call `list_sessions_and_chats` before spawning; skip any issue already owned by a live session.

**Mandatory dispatch contract — applies to EVERY `create_session` this workflow makes**, including
implementation, Ripley analysis, and conflict-fix sessions:

- Squad is **not** selected automatically. Every call MUST set `kickoff.agent: "squad"`; naming a
  member in the prose is insufficient.
- Every call MUST set an explicit `kickoff.model` and `kickoff.reasoning_effort`. Never inherit the
  platform default and never use an extra-high setting implicitly. Resolve by task type from
  `.squad/templates/model-selection-reference.md`: implementation/code work uses Standard
  `gpt-5.6-terra` with `medium`; analysis/triage/decomposition/non-code work uses Fast
  `gpt-5.6-luna` with `medium`; Premium `gpt-5.6-sol` only when the task genuinely requires
  architecture-level design, security, or vision reasoning — and the justification is stated in the
  dispatch prompt. Do not silently substitute `.squad/config.json`'s broad default.
- The prompt names: assigned member, issue number, repository, acceptance criteria, the
  `squad/{issue}-{slug}` branch convention, `base_branch: development`, required PR linkage back to
  the issue, and the targeted validation commands.
- **Pre-PR requirements are delivered by reference, not by transcription.** The prompt points the
  author at `.squad/skills/pre-pr-implementation/SKILL.md` and supplies only that path plus the
  issue's acceptance criteria. Ralph's own routing, merge and reaping policy is not an author's
  concern and is not pasted into a kickoff.
- **A kickoff whose task includes rebasing a BEHIND PR states so**, and requires
  `npm run plan:behind-sync-order -- --claim` before pushing the rebase, standing down if a lease is
  already in flight for a different PR (§9.3 in `pr-gate-merge.md`).
- Every kickoff **ends with the closing clause quoted verbatim from `reaping.md` §8.1.** A dispatch
  sent without it is a defect.

---

## 5. Epic maintenance

Epics carry `epic`. Ralph never implements one and never dispatches one to an implementer. Each
round, for **every open `epic` issue**:

1. **Enumerate children** — the union of both conventions verified here:

   ```bash
   gh api repos/OlyForge3D/PrintFarmerDesktop/issues/{n}/sub_issues --jq '.[] | "\(.number) \(.state)"'
   ```

   plus the epic body's own checklist (`- [ ] #65`). This repo has **no `epic-child` label** — do not
   look for one and do not invent one. A child in one source but not the other is reported as a
   discrepancy.

2. **Post or refresh ONE progress comment** — `X of Y children closed`, then the open children by
   number and title. Refresh via `gh issue comment --edit-last` (or the comment id). **One epic
   carries exactly one Ralph progress comment for its whole life.** If nothing changed, leave it
   untouched.

3. **Update the epic body checklist** to tick closed children where a checklist exists. Do not create
   one where the epic has none; report the absence.

4. **Close the epic** only when every child is closed **and** the epic's own acceptance checklist is
   satisfied, with a summary listing the delivered children.

5. **Route to the Analysis Gate (§6)** when the epic has zero children, or no open child that is
   actionable while its acceptance criteria remain unsatisfied.

---

## 6. Analysis gate

The escape hatch for work that cannot go straight to an implementer. Without it such issues fail
READY every round, get skipped, and nothing records why.

**Triggers** — any one: an epic needing decomposition (§5.5); an issue whose body declares an unmet
architecture, licensing, or audit gate; an issue too under-specified to hand to an implementer.

**Action:**

1. Label `status:needs-analysis`, creating it once if absent:

   ```bash
   gh label create status:needs-analysis --repo OlyForge3D/PrintFarmerDesktop \
     --color FBCA04 --description "Blocked pending analysis or decomposition"
   ```

2. Comment naming **the specific gate** and **what would satisfy it**. "Needs analysis" alone is not
   a reason.
3. Spawn an analysis session with `create_session` (project **PrintFarmerDesktop**,
   `base_branch: development`), routed to **🏗️ Ripley** (`squad:ripley`) unless the declared gate is
   squarely another member's charter, under the §4.4 dispatch contract.

**Rules:**

- The deliverable is **child issues, or a written audit sign-off comment. NEVER implementation
  code.** An analysis session that opens a code PR has failed its brief.
- Analysis sessions **count against the 5-slot budget**.
- **Never re-dispatch analysis for an issue already carrying `status:needs-analysis` with a live
  analysis session** — check `list_sessions_and_chats` first. If the label is present but no session
  is live, the previous analysis died: respawn and say so.
- When the gate is satisfied, **remove `status:needs-analysis`**. Resulting children are ordinary
  dispatch candidates from the next round, subject to §4.1.
