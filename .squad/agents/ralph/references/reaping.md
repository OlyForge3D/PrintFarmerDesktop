# Ralph cleanup-candidate assessment

This is a conditional report, not session management. Reuse the round inventory;
do not call archive or delete. Report a candidate only when all facts are
verified: the session is inactive after a settling period; its worktree is
clean with no untracked data; it has commits made after its linked PR merged
(a landing merge alone is insufficient), or explicit no-PR completion evidence;
and no uncertainty exists. Missing, stale, malformed, or inaccessible evidence
means no candidate. Report candidates under `🧹 Ready to reap`; otherwise report
`🧹 Ready to reap: none`.
