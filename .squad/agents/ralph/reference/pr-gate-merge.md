# Ralph reference — PR ownership, verdict gate, merge safety (§7, §9)

> Loaded when the round is about to read a verdict, judge checks, sync a base, merge, or scope a
> conflict review. Not loaded otherwise. `.squad/agents/ralph/loop.md` §1 and §2 remain in force and
> are not restated.

---

## 7. PR lifecycle ownership

**The session that implements an issue owns that issue's lifecycle until its PR is merged or
definitively closed.** Opening a PR is a milestone, not completion.

- While a PR is open, keep the owning session alive.
- On failing checks or requested changes, **message the owning session** to address them, then move
  on. Do not wait for a reply, and do not fix it yourself — Ralph delegates all code work.
- Ownership ends only when the PR is merged or definitively closed and that final status is
  recorded. How the finished session is then surfaced for cleanup is `reaping.md` §8.

---

## 9. Merge safety

Immediately before acting, re-read `headRefOid`, `isDraft`, `mergeable`, `mergeStateStatus`,
`reviewDecision`, and the checks rollup. Green CI alone never authorizes a merge.

### 9.0 The verdict gate, read mechanically

Require an explicit approval, or a recorded reviewer verdict, **at the current head SHA**. An
approval attached to an older SHA is invalid.

Read the verdict from `squad/pre-pr-verdict` **mechanically**, branching on the exit code — not on
the colour of the status, and not by reading the comment thread yourself:

```bash
npm run check:squad-verdict -- --repo OlyForge3D/PrintFarmerDesktop --pr <n> --json
```

| exit | classification                       | action                                         |
| ---- | ------------------------------------ | ---------------------------------------------- |
| 0    | `REVIEWED` / `APPROVED`              | usable merge evidence at the reported head SHA |
| 2    | `CHANGES_REQUESTED`                  | a live rejection — route back to the author    |
| 3    | `MISSING` / `INVALID` / `SUPERSEDED` | no usable evidence — owner approval only       |
| 4    | `NOT_APPLICABLE`                     | **out of scope — never merge unattended**      |

Parse `--json` for `classification`, `reviewedHeadSha` and `blockedReason` so the report quotes the
exact reason rather than paraphrasing it.

**Exit 4 is not permission.** The commit status is green, but green there means "no review was
required because this is not a squad PR", not "reviewed". A PR without the `squad` label is merged
by a human, deliberately. This coupling is what makes the gate's opt-in scoping safe at all —
`scripts/squad-verdict-gate.mjs`'s `squadScopeLabel` names this clause as its counterparty. If this
is ever relaxed, that scoping becomes a hole. Keep them together.

**`REVIEWED` is self-attested, not independent.** Every squad agent runs under the owner's single
identity, so it records that a reviewer agent examined that exact commit — not that a second party
approved it. What the gate genuinely buys is SHA binding, presence, and an audit trail. Only
`APPROVED` (`APPROVE (owner)`) is an authorisation by a distinct principal. Never report a
`REVIEWED` result as independent review, and never describe it as four-eyes.

**The gate already does carry-forward — do not re-derive it by hand.** It decides whether a record
reviewed at an older SHA still covers the current head, and it carries a verdict forward only when
**all three** hold: the reviewed SHA is a **strict ancestor** of the current head; the **diff against
the base is byte-for-byte identical** between the two; and the intervening merge commits fingerprint
as **clean merge-parents** (no hand-resolved content — §9.4). Any one of the three failing drops the
carry-forward. Trust its classification. Do NOT commission a fresh review merely because the head
SHA moved, and never commission a full review over an entire feature diff for a base sync — that
re-litigates approved code and burns three dispatches. Quote `reviewedHeadSha` when explaining a
carry-forward.

`squad/pre-pr-verdict` is deliberately **not** a required status check and must not be made one.
Enforcement lives here, in the merge logic. Never modify branch protection.

### 9.1 Verifying a merge landed — this repo squash-merges

**This repo squash-merges.** Verified: PR #588's merge commit `b903757` and PR #593's `9da33a9` each
have exactly one parent; `scripts/check-merge-landed.mjs` records that **23 of 29 merges here take
the squash path**.

A squash merge creates a **new commit on `development`**; the branch's own commits never land. So
`git log origin/development..HEAD` still lists commits on a fully-merged branch, and any naive "are
the branch's commits on `development`?" test concludes the work is unmerged. It is wrong, and wrong
in the direction that keeps a merged session alive and re-driven — the same instrument measured
head-based checks crying loss on 8 of 30 healthy merges.

Never use branch-commit containment as the merge test. Prefer the repo's own instrument:

```bash
npm run check:merge-landed
```

Manually — ask the PR, then confirm the merge commit:

```bash
gh pr view {n} --repo OlyForge3D/PrintFarmerDesktop --json state,mergeCommit
git fetch origin development
git merge-base --is-ancestor <mergeCommit.oid> origin/development   # exit 0 = landed
git branch -r --contains <mergeCommit.oid> --list 'origin/development'
```

Merged means **both**: `state == "MERGED"`, and step 2 lists `origin/development`. Scope
`--list 'origin/development'` explicitly — an unscoped `--contains` reports refs from remotes that
do not exist here (#289). A merged branch is routinely deleted from the remote afterwards; its
absence is expected and is not evidence of lost work once the merge commit is confirmed.

### 9.2 Re-deriving a merge gate's premises — never restate a remembered SHA

**#536:** a merge/coordination session spent six consecutive relay rounds gating PR #423 on a head
SHA (`cd512223`) that had not been the branch tip for hours. Every round re-confirmed the same stale
premises because every check it ran was an EXISTENCE check against a value nobody re-derived. The PR
was `state=closed`, `merged=true` the entire time; its merge commit **was** the tip of
`development`. Nothing incorrect merged — the cost was six rounds gating a PR already in the trunk.

The procedure is `loop.md` §2, which is always in force. Its merge-gate instance adds one bound:
**if this round's premises are identical to the last two rounds' with no new observation, that
repetition is itself the signal** to stop restating and re-derive every input from scratch.

```bash
npm run check:gate-premises -- --pr <n> --repo OlyForge3D/PrintFarmerDesktop
```

Exit `0` no gate owed or the gate holds with agreement confirmed; `1` the gate is required and a
position mismatch was found — re-derive before acting; `2` inputs could not be resolved, never read
as either answer. The generalized cross-role form lives in
`.squad/skills/agent-collaboration/SKILL.md`.

### 9.3 Base freshness and serializing base-syncs — #263

Branch protection on `development` sets **`strict: true`**: a PR must be UP TO DATE with its base
before it can merge. Combined with a fast-moving `development`, a stale base is the largest source of
wasted work here.

**Be fresh early, not late.** Two rules:

- **Refresh the local `development` ref before dispatching.** It has been observed 11 commits behind
  `origin/development`; sessions created with `base_branch: development` inherit that and are born
  behind. `git fetch origin development:development` updates the ref without checking it out and
  fails safely if the update would not be a fast-forward. If it errors because `development` is
  checked out somewhere, fall back to `git fetch origin` and report that the local ref could not be
  advanced. Report before/after SHAs and commits advanced.
- **Every dispatched session syncs before it opens its PR.** Syncing before the PR exists is free —
  no CI has run, so nothing is invalidated.

Once a PR is open, green, and merely `BEHIND`, prefer to **merge it promptly** rather than re-sync.
Re-sync only when it is the sole remaining blocker, and never re-sync the same PR more than twice in
one round — report it as blocked instead.

**#263:** six `CI` runs entered within eleven seconds against the shared GitHub-hosted runner pool
(~40 jobs fanned out), and the PR whose jobs queued behind that burst took 2x as long wall-clock as
one that entered cleanly the same second — same total job time, all of the difference was start
spread waiting for a free runner. More than one base-sync in a round — **even against different base
branches; the runner pool is one pool** — reintroduces that burst, and each starved sync stays BEHIND
longer and is likelier to need another.

```bash
npm run plan:behind-sync-order
```

It reports the single next PR to sync, oldest-first across every base combined, and whether a lease
is already in flight for some other PR. If a lease is active, do not dispatch or recommend another
base-sync this round regardless of which PR or base it would target. The session that actually
performs the sync (never Ralph, which delegates all code work) passes `--claim`.

**Do not read PR health from `mergeStateStatus`.** Under `strict: true` it saturates to `BEHIND` and
cannot distinguish 7 green jobs from 2 red ones. Read checks at `head_sha`, and verify required
contexts by set containment against the live list — never by counting passing rows.

### 9.4 The one exception to "never review" — a hand-resolved conflict

`loop.md` §1 forbids Ralph reviewing PRs and spawning review sessions. **This is the only carve-out,
and it is deliberately narrow.** It exists because a merge commit can introduce hand-authored content
that no reviewer has ever seen, while the gate reports only that the head moved.

Distinguish the two cases **mechanically**, judging from the diff BODY (`diff --cc` sections) and
never the stat line — `git show --cc --stat` is misleading:

```bash
git show --cc <merge-commit>
```

- **Combined diff body EMPTY** → clean merge. Every file matched one parent exactly; nothing new was
  authored. **Do not order any review.**
- **Combined diff shows resolved hunks** → hand-resolved merge. Commission a review **scoped to
  those hunks only**, never the whole feature diff. Tell the reviewers the pre-merge content is
  already approved and ask exactly one question: was each conflict resolved correctly without
  silently dropping either side's intent?

Everything else about reviewing stays forbidden from the workflow. In particular this carve-out does
not authorize a general re-review after a base sync, after a head move, or on a PR the gate merely
reports as `MISSING`.

**Reviewers are `task` calls, never sessions** (`agent_type: general-purpose`, `mode: background`),
spawned in parallel in one turn. They are read-only and need no worktree; spawning them as sessions
consumes implementation slots and leaves stale checkouts — 21 reviewer clones consuming 7.56 GB had
to be swept by hand. Instruct them to read the diff via `gh pr diff`, never `git clone`.

**Pass `model:` and `reasoning_effort:` explicitly on every reviewer call.** Nothing applies this
automatically: `.squad/config.json` defines no reviewer overrides, and a `task` call that omits
`model:` silently runs the platform default, collapsing the panel onto one model with no warning and
no error. Use these ids exactly — `task` hard-errors on an unknown id and that reviewer never runs:

| Reviewer | `model`                  | `reasoning_effort` |
| -------- | ------------------------ | ------------------ |
| Bishop   | `claude-opus-5`          | `medium`           |
| Hicks    | `gpt-5.6-sol`            | `medium`           |
| Vasquez  | `gemini-3.1-pro-preview` | `medium`           |

The spread across three vendors is the whole point of calling the review adversarial: three
instances of one model share training and blind spots, miss the same defects, and agree with each
other, so their unanimous APPROVE is far weaker evidence than it appears while looking identical to a
real consensus. Vasquez's id keeps its `-preview` suffix; plain `gemini-3.1-pro` does not exist and
is rejected. Do not "tidy" these ids.

**Reviewers must not build, install dependencies, or run tests — state this in every reviewer
prompt.** Forbid `npm install`, `npm test`, `npm run build`, `npx vitest`, `npx playwright`,
`cargo build`, `cargo test` and every equivalent. Three reasons, each sufficient: CI already runs the
required checks and the authoring session already ran targeted tests, so a reviewer build gates
nothing; a `task` sub-agent inherits its parent's working directory, so reviewers start inside the
author's worktree and parallel installs collide on the same `node_modules/` and `native/**/target/`
paths, churn `package-lock.json`, and mutate the tree the author is still editing; and it is
expensive — `node_modules` alone measured 2.65 GB across six worktrees here. Reviewers MAY read
anything (`gh pr diff`, `git log`, `git show`, any file). If a conclusion depends on runtime
behaviour that cannot be determined by reading, that is a legitimate finding: name it as a specific
evidence request for the author.

A reviewer may never review its own authored work, including conflict resolutions; the gate enforces
this (`BLOCKED: reviewer <member> is the PR author`). Reviewer count follows
`.squad/skills/agent-collaboration/SKILL.md`: documentation-only PRs need one reviewer, everything
else the full panel — and its carve-outs (workflow YAML, security/API-contract prose, and any change
altering an agent safety boundary, merge-safety rule, or destructive-operation permission) take the
full panel even when only markdown changed. When only one reviewer is required, still pass an
explicit `model:` for the reviewer whose domain matches.

### 9.5 When a PR is mergeable by Ralph

**All** of: not draft; `mergeable` is `MERGEABLE` (not `CONFLICTING`); every required check green at
the current `head_sha`; and `check:squad-verdict` exits 0. Re-read `headRefOid` immediately before
merging and re-run the check if it moved.

- **Serialize merges.** Verify one merge landed (§9.1) and its linked issue closed before starting
  another. Two `gh pr merge` calls seconds apart have already orphaned a commit here.
- **CONFLICTING or dirty PRs are not mergeable** and no amount of review changes that. Delegate a
  fresh fix session from `development`; never mutate the branch from the main checkout. Re-run the
  gate afterwards.
- **Know which refusals are mechanical and which are advisory.** A `hold:*` label and draft state
  are enforced by the platform — they refuse the merge whatever else is green. A blocking review
  COMMENT is advisory: nothing stops the merge mechanically, so honouring it is Ralph's obligation,
  not the platform's. Never report an advisory refusal as though the platform had enforced it, and
  never merge past one because the API said `MERGEABLE`.
- **CodeQL:** **this repository configures no CodeQL workflow and no CodeQL setup today**, so there
  is nothing to require and nothing to wait for. Handle CodeQL only if a configuration is actually
  present when you look. Do not assert a CodeQL requirement, do not add one, and do not infer one
  from an alert list or from another repository's setup.
