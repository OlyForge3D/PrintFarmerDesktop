# A merge gate held against a remembered SHA is a memory, not a gate

**By:** Hicks, for issue #536.

## The worked example

A merge/coordination session spent **six consecutive relay rounds** gating PR #423 on a
head SHA (`cd512223`) that had not been the branch tip for hours. Every round restated the
same four premises, and every one of them was independently confirmed as stated:

| Premise                                         | What was actually true                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| "#423 is draft/frozen"                          | `state=closed`, `merged=true`, `draft=false`             |
| "head is `cd512223`"                            | head was `3bfa78f2`; `cd512223` was `ahead=0 behind=158` |
| "reviews are pinned only to `9119b5df`"         | 9 review objects existed, at 3 different SHAs            |
| "`squad/366-freshness-timing` is at `cd512223`" | `ls-remote` said `3bfa78f2`                              |

Live, separately-obtained measurement resolved it in one shot:

```
git ls-remote https://github.com/OlyForge3D/PrintFarmerDesktop.git
  3bfa78f2722455ae626d77ada6281beaf1dd53fa   refs/heads/squad/366-freshness-timing

gh api .../pulls/423
  state=closed  merged=true  merge_commit_sha=9eccb0d4...

git ls-remote https://github.com/OlyForge3D/PrintFarmerDesktop.git refs/heads/development
  9eccb0d4abe5add39f972289d9b471c5d64529a5
```

`merge_commit_sha == refs/heads/development`. PR #423 did not merge INTO the branch being
held — it HAD BECOME it. Nothing incorrect was merged and the freeze behaviour was
conservative and correct given its inputs; the cost was six rounds spent gating a PR that
was already in the trunk before the first of them.

## Why every round confirmed the stale premise instead of catching it

1. **A stale view is internally consistent, so every check run against it confirms it.**
   `cd512223` is a real commit — real message, real author, real date. It is genuinely one
   of #423's own commits, and it passes every EXISTENCE check. The only property that
   distinguishes it from the true head is POSITIONAL — where it sits relative to the
   current tip — and an existence check cannot report position. A commit being real and a
   commit being current are independent facts, and confirming the first feels like
   confirming the second.

2. **A reflexive comparison was read as corroboration.** One round reported
   `identical ahead=0 behind=0` as confirmation. That compared a remembered value TO
   ITSELF, which returns `identical` for every possible input and has zero discriminating
   power. `compare/A...B` is informative only when `A` and `B` were obtained separately.

3. **Two mechanisms sharing a target are not two mechanisms.** Rounds cited "confirmed by
   both `ls-remote` and the GitHub API." When `ls-remote` targets a remote NAME (`origin`)
   that resolves to a local clone, it faithfully reports that clone's last-fetched refs.
   Two protocols pointed at the same stale source agree perfectly, and per this file's own
   `decisions.md` history, agreement only counts when the mechanisms are independent —
   mechanisms sharing a target are not independent, however different their protocols look.

4. **The explanation became unfalsifiable.** A later round adopted "the local refs are
   stale, the remote has `cd512223`" — structurally the right KIND of explanation, applied
   with the direction reversed, explaining away the very observation that would have
   corrected it. Once a model predicts that contradicting evidence is itself the error, it
   has stopped being testable.

## The corrected procedure

1. **Print the target, not just the query.** `git ls-remote --get-url origin` before any
   ref read. A remote name is a variable; a check that reads an unprinted variable is not a
   check.
2. **Re-derive at the moment of decision.** Any SHA older than the current turn is an INPUT
   to re-verify, not a fact. A gate evaluated against a remembered SHA is a recollection
   with a command prompt in front of it.
3. **Ask position, not existence.** Use `compare/<A>...<B>` between two SEPARATELY
   obtained values, or read `state`/`merged`/`merge_commit_sha` directly. Never compare a
   value to itself.
4. **Check terminal state first.** `state`/`merged` are cheap and dispositive. A closed,
   merged PR needs no review gate, no sync check, and no freeze check — checking this first
   would have ended the #423 incident at round one.
5. **Bound the loop.** If N consecutive rounds produce the same premises with no new
   observation, that repetition is itself the signal to re-derive from scratch, not to
   restate.

Codified in `scripts/check-gate-premises.mjs` (`npm run check:gate-premises -- --pr <n>`):
`classifyTerminalState` enforces (4) before anything else runs; `classifyPosition` refuses
a comparison whose two sides name the same source, enforcing (3); `classifyRoundBudget`
implements (5) by flagging a premise hash that has repeated past a threshold with no new
observation. (1) and (2) are structural to the script's `main()` — it prints
`git ls-remote --get-url origin` before any other read, and every invocation performs a
fresh `gh api` read rather than accepting a value from the caller. See
`.squad/agents/ralph/loop.md` §9.2 for the procedure wired into Ralph's own merge-safety
checklist.

**Why this is a distinct instrument from `check-merge-landed.mjs`.** That script answers
"did a reported merge actually reach the target" (#391's incident — a merge that reported
success but the ref moved past its own merge commit). This answers a prior question: "is a
gate — review, sync, freeze — still owed on this PR at all, right now." #423 never had a
`check-merge-landed.mjs`-shaped problem; its merge commit was reachable exactly as
reported. The defect was entirely upstream of that check, in the premises fed into six
rounds of gating that never asked whether a gate was still owed.

**Why this is a distinct case from `vasquez-a-sha-is-a-perishable-claim.md` and
`hicks-status-is-not-a-memory.md`, and confirms both.** Those entries establish that a SHA
or a status read correctly decays the moment something later moves, and that the fix is to
re-derive at the moment of assertion rather than quote a prior reading. #423 is the sharpest
recorded instance of exactly that failure, six rounds deep, plus two further mechanisms this
entry adds: a reflexive comparison that manufactures false corroboration (item 2 above), and
an unfalsifiable "the OTHER reading is the stale one" explanation that survives contradicting
evidence by construction (item 4). Both are new failure modes worth naming on their own,
not merely restatements of "the SHA got old."
