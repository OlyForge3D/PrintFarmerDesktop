# Inbox — #275: generalizing the merge-gate re-derivation discipline to boards

**By:** Ripley, for issue #275.

## What #275 found

Six same-day instances of one shape, filed from the merge queue: a status board is
produced by measuring, then read later as if it were still measuring, and nothing in
its presentation distinguishes the two. A five-row board where five rows had moved by
read time, a claim re-measured immediately before sending that still arrived false
(the send-to-read interval alone falsified it), and a "not yet merged" note a merge
falsified nine minutes after it was written are three instances from one afternoon;
Ralph's own merge queue treating a rebase-freshness check as a health check is a
fourth (see #274). Related: #202 (cross-session claims arrive undated), #214 and #253
(verification commands that answer a neighbouring question and return a confident,
well-formed value instead of erroring).

## What already existed vs. what's newly added here

Two existing inbox entries already cover the **single-value** version of three of the
four proposed conventions in depth:

- `.squad/decisions/inbox/hicks-status-is-not-a-memory.md` — re-measure at the moment
  of assertion, not the moment the work finished; report a value at a reference the
  reader can resolve independently ("seven contexts green at `45c1db4`" vs. "CI is
  green").
- `.squad/decisions/inbox/vasquez-a-sha-is-a-perishable-claim.md` — "write the clock
  with the value, `X at HH:MM` or do not write it"; "the receiver re-derives, the
  receiver never quotes."

And `.squad/agents/ralph/loop.md` §9.2 already codifies receiver-side re-derivation
discipline for **Ralph's merge gate specifically** (`scripts/check-gate-premises.mjs`,
re-fetch at moment of use, check terminal state first, re-derive never quote).

What was **not** already covered anywhere in the squad's docs:

1. A **board-level** (multi-row, multi-column) generalization stated in the file
   every role actually reads for collaboration mechanics
   (`.squad/skills/agent-collaboration/SKILL.md`), rather than only in single-value
   inbox essays or in Ralph's merge-gate-specific loop file.
2. **Convention 4 — distinguish `RED` from `PENDING` explicitly.** Nothing existing
   addressed the two-state-collapse failure mode (a control that cannot tell "not yet
   run" from "ran and failed," which is how a not-yet-started check reads as a pass).
   This is genuinely new content added by this entry.

## What changed

- **`.squad/skills/agent-collaboration/SKILL.md`** gained a new section, "A status
  board is a memory wearing the costume of a measurement," stating all four
  conventions from #275 (timestamp-or-omit, terminal phrasing, receiver-re-derives
  with a pointer to loop.md §9.2 as the merge-gate instance, and the new RED-vs-PENDING
  requirement — expose at least three states, treat an API's absent/boolean field as
  `PENDING` rather than silently defaulting it to `PASS` or `RED`, and document the
  legend). It cross-references rather than duplicates the two existing single-value
  entries and the related issues above.
- **`.squad/agents/ralph/loop.md` §9.2** gained a one-sentence cross-reference (same
  pattern used for #568) pointing from the merge-gate-specific procedure to the new
  general SKILL.md section, so a reader of Ralph's loop discovers the generalization
  without it being restated in loop.md a second time.

## Scope

Documentation only — no application code or workflow change. Checked for a concrete
status-board script whose output the timestamp/terminal-phrasing convention could be
applied to directly; none exists in `scripts/` (no `status-board`, `scoreboard`, or
equivalent). If one is added later, its output should follow the conventions codified
here.
