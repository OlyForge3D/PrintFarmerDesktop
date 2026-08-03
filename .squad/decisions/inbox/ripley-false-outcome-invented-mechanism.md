## 2026-08-03: A false outcome with an invented mechanism is a distinct failure from `:309`, and worse

**By:** Ripley

**What:** `.squad/decisions.md` `:309` records that *an accurate outcome with a plausible mechanism attached is still a fabrication*. It stipulates an accurate outcome. The neighbouring case — a **false** outcome with an invented mechanism — is not covered by it and should not be filed under it.

**Why they are different, structurally, and not as a matter of degree.** In the `:309` case the mechanism is decoration: the conclusion is right, and removing the invented reasoning leaves a true statement standing with no support. In this case the mechanism is **load-bearing** — it is the only thing that makes the false conclusion reachable. Remove it and there is nothing left, because there was never an observation underneath. That difference predicts where each one is caught. A `:309` fabrication survives review because the conclusion checks out and nobody audits the derivation. This one survives review because **the reviewer checks the conclusion against the offered mechanism rather than against the object** — and the mechanism was built to support the conclusion, so it always agrees. The agreement is manufactured, not found.

This is stated on its form rather than on a tally, per the precedent in `.squad/decisions.md` that a structural claim *"takes no instances, gains nothing from a second and loses nothing to one."*

**Worked example — my own, published and retracted within the hour.**

I claimed `:309` named a quantity with the wrong noun: that *"32,767 counts paths through the `m` chain alone"* was wrong because 32,767 is a row count and the path count is 16,384. I supplied a mechanism — that a squadmate had inherited the bad noun by faithful citation, making it the citation-inheritance sub-case `:309` itself names. The mechanism was tidy, it fit the day's theme, it explained everything I was looking at, and I published it on an open PR.

Then I transcribed `diamondDag` from `tests/viewer.partTree.test.tsx` and walked it. Under a path-local `seen` set every row emission is in bijection with a distinct root-to-node path, so `m`-node rows and distinct paths ending at an `m`-node are **necessarily the same number**: both 32,767. `16,384` is the path count *to the tail specifically* — a different set, not a rival measurement of the same one. Both nouns are true. There was no defect, no inherited error, and nothing to repair. The mechanism I supplied was the entire content of the finding.

**What recovered it, and what did not.** I had attached a falsifier to the claim — *"if this is read as a path count rather than loose phrasing, there is no defect"* — and then argued that reading was unavailable. **The falsifier did not stop me publishing.** What it did was name the measurement that would settle it, so when I finally enumerated paths-to-any-`m`-node alongside paths-to-tail, the refutation was immediate. Had I measured only the quantity my conclusion required, the walk would have returned `16,384`, agreed with me, and left me more confident and still wrong.

**So: state the falsifier, and then take the measurement it names.** Writing the condition down is what makes the error recoverable. It is not what makes it not happen.

**One more thing this instance shows.** It occurred *inside* an investigation that had just correctly overturned someone else's false finding, and while I was drafting this entry. **Having checked one claim carefully confers nothing on the next one.** Verification is per-claim; the confidence it produces is not.
