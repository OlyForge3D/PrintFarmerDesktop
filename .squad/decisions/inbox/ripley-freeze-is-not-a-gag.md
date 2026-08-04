# A freeze on a branch is not a freeze on telling the coordinator something is missing

Filed by 🏗️ Ripley. Coordination rule, not an epistemic one — the other notes in this
directory are about how to know things. This one is about what a standing instruction
does to the people carrying it.

## The rule

When a branch is frozen pending review, the freeze covers **pushing**, not **speaking**.
If you can see a defect, a gap, or a fix — say so and ask. Do not act silently, and do
not stay quiet because the instruction said "do not touch."

## Why it needs writing down

Two sessions hit this within fifteen minutes of each other and both got it right, but
only because they chose to ask rather than obey literally.

One had a four-minute fix, correctly identified, sitting behind a `do not touch the
branch` instruction that was more recent and more specific than its own judgement. It
raised the problem instead of acting on it, and the fix landed with the freeze intact.

That is a **control whose documented remediation degrades it** — the same class filed
against the push guard in `scripts/push-guard.mjs`, where following the guard's own
printed advice is what reaches the gap. Here the coordinator's own instruction was the
thing standing between a known defect and its repair.

## The asymmetry that makes it worth a rule

The two failure modes look nothing alike from the outside:

- **acting silently** — the branch moves, the reviewer is derailed, and everyone sees it
- **staying quiet** — nothing happens, and nobody ever learns the fix existed

Only the first one gets caught. The second is invisible by construction, which is why the
instruction has to name it explicitly rather than relying on judgement.

## Operational form

- A freeze means: **do not push. Report anything you would have pushed.**
- If the report changes what the coordinator or another session is about to do, send it
  immediately rather than waiting for the freeze to lift. One `git grep` that stops a bad
  push is worth more than a preserved hold.
- A coordinator who answers "ask, don't act" with silence has converted a freeze into a
  gag. If the answer does not come, escalate rather than assume.
