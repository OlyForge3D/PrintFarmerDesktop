# Ralph cleanup-candidate assessment

This is the sole lazy cleanup assessment, not session management or a handoff to
a reaper. Reuse the round inventory; never call archive or delete. Report a
candidate only when all facts are verified: the session is inactive after a
settling period; its worktree is clean with no dirty or untracked data and no
unpushed work; it has commits made after its linked PR merged (a landing merge
alone is insufficient), or explicit no-PR completion evidence; and no
uncertainty exists. Missing, stale, malformed, or inaccessible evidence means
no candidate.

Report only under `🧹 Cleanup candidates`; otherwise report `🧹 Cleanup
candidates: none`. Ralph never performs a later action. Any separate user
action needs explicit confirmation that names each specific session.
