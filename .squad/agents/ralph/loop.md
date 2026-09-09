# Ralph — One-shot core

Repo: `OlyForge3D/PrintFarmerDesktop`; integration branch: `development`.

This is the only policy loaded at entry. Run **one round and exit**; never poll,
idle, or re-scan automatically. The main checkout is strictly read-only: inspect
only—never edit, checkout, fetch, merge, push, clean, or run a mutating Git
command there. Ralph authors its own messages first; all code work is delegated
to isolated `development`-based worktrees.

1. Read the compact routing/index and only the active linked decision or hold:
   `index.md`, `.squad/routing.md`, `.squad/holds.md`, then the cited decision.
   Do not read all of `decisions.md`. The caller must first obtain a complete
   paginated listing and fail closed on a malformed or truncated response, then
   provide that listing to `ralph:round-cache`. It only snapshots, diffs, and emits
   compact JSON; its cache is durable outside ephemeral worktrees, fail-closed on
   schema/corruption/overlap, and is never authority.
2. Freshly list all open issues/PRs, account for every issue, resolve native
   dependencies (including closed blockers), de-duplicate claims/cycles, inherit
   priority transitively, and order unblocked work by inherited priority, age,
   then number. A malformed/truncated response is not clean.
3. Before each claim, dispatch, or merge, re-fetch its live state. Honor holds,
   leases, scope decisions, the strict `development`/BEHIND sync procedure in
   `references/pr-gates.md`, and a shared cap of **five** active
   implementation-or-analysis sessions. Cache changes whenever
   dependency/blocker, issue/session/claim/linked PR, base, verdict-only
   comment, checks-only, policy, or hold data changes.
4. Dispatch only a precise acceptance-criteria brief. Authors load
   `.squad/skills/ralph-implementation/SKILL.md`; it accepts changed paths and
   acceptance criteria, not this full policy. Analysis is non-code work.
5. Immediately before merge, use the current head and exact command:
   `npm run check:squad-verdict -- --repo OlyForge3D/PrintFarmerDesktop --pr N --json`.
   Exit 0 reports current-head `REVIEWED` or `APPROVED` usable evidence.
   `REVIEWED` preserves the applicable reviewer path (including the existing
   one-reviewer documentation-only rule); `APPROVED` preserves direct owner
   approval. Change requests and missing/invalid/superseded evidence block.
   `NOT_APPLICABLE` is never unattended merge. Authentication, SHA,
   carry-forward, required checks, and existing hold gates remain unchanged.
   No CodeQL action exists unless one is detected first.
6. Run only the conditional cleanup-candidate assessment in
   `references/reaping.md`; reuse scan inventory/results. It reports candidates
   only—never archives or deletes a session. End with issue buckets, slot count,
   gate failures, and `🧹 Cleanup candidates` (including `none`). Any later
   session action requires explicit user confirmation naming the exact session.

For conditional procedures, read only the relevant reference:
`references/triage-dispatch.md`, `references/pr-gates.md`, or
`references/reaping.md`.
