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

If the change needs design review — any `src/renderer/**` file, root
`index.html`, or design-governance file (`isDesignReviewPath` in
`scripts/design-surface.mjs`; the detector scans only the narrower
`isDesignSurfacePath` markup/style set) — run
the impeccable skill's `shape` on the feature before writing UI code and put the
resulting brief in the PR description. Fix `Design detector` findings rather
than suppressing them; a suppression needs a stated reason. The PR also needs a
`lambert` design review (`.squad/skills/agent-collaboration/SKILL.md`).

Before opening that PR, look at what you built: stage the sidecar
(`npm run build:sidecar`, or `npm run stage:sidecar` if one is already built),
run the app with `npm start`, and screenshot every view the change touches in
the states it changes (empty, loading, error, narrow width where relevant).
`e2e/mvp.spec.ts` shows how to drive the app with Playwright's `_electron`, and
`impeccable detect --cdp <port>` can scan the running window. Attach the
screenshots to the PR under `## Screenshots (UI changes)` through the GitHub
UI or a PR-media tool (`gh` cannot upload images); never commit them. If the
app cannot launch in your environment, say so in that section instead of
skipping it silently. This is self-attested evidence, not a deterministic check.

When your PR is merged (or definitively closed) and you have verified the merge
landed and the linked issue closed, report your final status as your last action
and stop. Do NOT attempt to archive yourself or another session. Cleanup reports
candidates only and never delete or archive sessions.
