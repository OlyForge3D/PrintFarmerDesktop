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

If any changed path is design surface (`src/renderer/**` markup or styles, or
`DESIGN.md`/`PRODUCT.md`; the definition is `scripts/design-surface.mjs`), run
the impeccable skill's `shape` on the feature before writing UI code and put the
resulting brief in the PR description. Fix `Design detector` findings rather
than suppressing them; a suppression needs a stated reason. The PR also needs a
`lambert` design review (`.squad/skills/agent-collaboration/SKILL.md`).

When your PR is merged (or definitively closed) and you have verified the merge
landed and the linked issue closed, report your final status as your last action
and stop. Do NOT attempt to archive yourself or another session. Cleanup reports
candidates only and never delete or archive sessions.
