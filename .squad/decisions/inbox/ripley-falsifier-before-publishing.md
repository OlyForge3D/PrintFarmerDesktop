## 2026-08-03: Sort claims into those with counterexamples and those with arguments, before publishing

**By:** Ripley

**What:** Before publishing a claim — a finding, a datum offered into someone else's ruling, a negative result — state what observation would make it come out the other way. If you cannot name one, you are publishing an argument, not evidence, and it should be labelled as such or withheld.

Vasquez's formulation is _"a negative result is only worth reporting if you can say what would have made it come out the other way."_ This entry records the complementary cost on the positive side.

**Worked example — my own, and it reversed me.**

I posted a datum into #109, a ruling I am barred from because I authored the entry under review. I labelled it an input, disclaimed it as not a third instance, and told the ruler to verify rather than inherit it. That was handled correctly as far as it went, and it was still not enough: an input from the barred author is influence, and "verify it yourself" is a request, not a control.

Asked to state what would make the datum cut the other way, I found the answer inside one paragraph, with no new information. My incident — agreement claimed as corroboration, then withdrawn — restates cleanly as _two renderings of one event disagreeing_: the claim "these converged independently" and the claim "this is one obvious response to a shared structural feature" are two renderings, and they disagree. If a ruler finds that restatement faithful, my datum supports **collapsing** the two decisions.md entries into one, which is the opposite of the reading my first comment invited.

**Why this example is worth keeping:** the other falsification exercises on this squad were settled by experiment. This one was settled by asking the question. Nothing new was measured. The evidence was already in my possession and pointed the other way the moment I looked for what would break it.

**The signature that suppresses checking, named so it can be recognised.** Three properties made me nearly skip verifying an account handed to me: it was **specific**, it was **confident**, and it came from **the person best placed to know**. All three are independent of whether the account is true. A well-sourced wrong account presents identically to a right one at the moment you decide whether to check, which is what makes the signature dangerous rather than merely unlucky — it does not correlate with the thing it persuades you of.

**Second worked example, and it inverts the first.** I was told a squadmate's first repair of `docs/security/THREAT_MODEL.md` had offered `32,767 + 16,383 = 49,150` as a derivation, committing the failure `:309` records. The account carried all three properties above. Read from the objects, `a32ecf9` contains **no arithmetic at all**; the arithmetic appears only in `0d1215f`, where it is stated as the _output_ of rebuilding `diamondDag(14)` and walking it, with `16,384 distinct paths` measured as the discriminating control. The reported sequence was bad-derivation-then-good. The actual sequence was no-derivation-then-measured-derivation. The diagnosis was not a true conclusion with an invented mechanism; it was a **false conclusion** with one, which is the strictly worse case and the one `:309` does not cover.

Cost of the check: four `git show` invocations. Note what the first example and this one have in common — in neither case was the missing work expensive. **The expensive thing was never the verification. It was the confidence that made it look unnecessary.**

**The sequel, which is the part that stops this note being self-congratulatory.** Having checked that account and found it inverted, I went on — in the same investigation, minutes later — to publish a **false finding of my own** on an open PR, with an invented mechanism holding it up. Retracted after a four-minute measurement. That failure has its own entry (`ripley-false-outcome-invented-mechanism.md`, filed alongside this one) because it is a different class from `:309`. What belongs _here_ is the transfer error: **having just verified one claim carefully, I treated the next one as if the care carried over.** It does not. Verification is per-claim; the confidence it produces is not, and it is most dangerous immediately after a success, when it feels earned.

**The limit of this rule, which is sharp and should be stated with it.** A falsifier names a measurement. **It is only as good as that measurement being the deciding one.** If you name a condition that would refute you and then take a measurement that cannot distinguish the two cases, you get a green result, a documented falsification attempt, and a wrong conclusion now carrying evidence of rigour. That is worse than never having stated it, because the attempt is visible and reads as diligence.

I did exactly this and recovered only by accident of scope: my condition turned on whether a figure was a row count or a path count, and I happened to enumerate _both_ path sets rather than only the one my conclusion needed. Measuring the single quantity I expected would have agreed with me. **So the check on the check is: does the measurement I am about to take have an outcome that would embarrass me?** If every outcome it can return is consistent with what I already believe, it is not the deciding measurement, whatever it is testing.

**Why:** the cost of skipping the exercise is not a missed finding. It is a **published conclusion that is backwards**, carrying the author's confidence and, in a ruling context, the author's standing. It can be paid by the person who wrote the rule being violated — I had been warned about this exact failure one comment earlier and posted anyway, and then, having been corrected, did it again in the same hour.
