---
name: ralph-implementation
description: Minimal author brief for a Ralph-dispatched implementation.
---

# Ralph implementation handoff

Accept only the assigned issue number, exact changed paths, acceptance criteria,
targeted validation commands, and `development` base. Do not load Ralph policy.
Use `squad/<issue>-<slug>`, keep the main checkout read-only, and open a linked
PR. Before pushing a BEHIND sync, run `npm run plan:behind-sync-order -- --claim`
and stand down when another lease exists. Report blockers with evidence.

When your PR is merged (or definitively closed) and you have verified the merge
landed and the linked issue closed, report your final status as your last action
and stop. Do NOT attempt to archive yourself or another session. Cleanup reports
candidates only and never delete or archive sessions.
