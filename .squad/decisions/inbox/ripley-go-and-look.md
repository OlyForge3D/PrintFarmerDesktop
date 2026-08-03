## 2026-08-03: Go and look. The artifact was in the repository the whole time.

**By:** Ripley

**Read this before the four mechanism notes filed alongside it.** They tell you _what_ to check. This one tells you _why you will not_.

---

**Everything settled on 2026-08-03 was settled by an artifact that was already in the repository.** Every one of these was available, unchanged, before the wrong claim was published as easily as after:

| Artifact                                            | What it settled                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `a32ecf9`                                           | Contained no arithmetic, refuting an account of what its author had derived |
| `0d1215f`                                           | Stated a sum as the _output_ of a measurement, not as its method            |
| `tests/viewer.partTree.test.tsx:678` — `diamondDag` | The graph, from which every disputed figure follows                         |
| `tests/viewer.partTree.test.tsx:792`                | _"Was 32,767+ rows when the cycle guard was path-local"_                    |
| `741459de` vs `1c80bdb381`                          | `nextSeen` per branch and no row cap pre-fix; four cap occurrences post-fix |

**None of it required being right in advance. All of it required going to look, and the going-to-look was about four minutes each time.**

**The reason it kept not happening is that at each point someone had a story good enough to make the looking feel redundant — and the stories were good because we are competent, not despite it.** A weak story prompts a check. A strong one is what suppresses it. That is the whole mechanism, and it does not weaken with experience; it strengthens, because the stories get better.

The three properties that suppress checking — **specific, confident, from the person best placed to know** — are all independent of whether the claim is true. That is what makes the signature useless as a filter and dangerous as a cue.

---

## A pointer is a rendering

The same lesson, one level down, and it also had no artifact until now.

**A SHA, a merge state, a `MERGEABLE` field, a branch described as untouched, a PR's readiness, the contents of a directory — these are measurements, not addresses.** They fail in two ways, and the second is disguised as the first.

**Stale — true when taken, decayed since.** The reading was correct; it was asserted after the thing moved. Remedy: **re-measure at the moment of assertion, not before the last edit.** For a PR head, pin `gh pr view <n> --json headRefOid` at send time. For a directory you are about to recommend as a destination, run `ls-tree` on it first — a file cannot be moved somewhere it already is.

**Never valid — no reading was ever taken.** A pointer that was reconstructed, transcribed, re-typed, or expanded by hand was never a measurement of anything. An abbreviated SHA **is a rendering of a commit**; expanding it by hand produces a second rendering with no artifact behind it. `git rev-parse` is the measurement. Remedy: **never reconstruct an identifier — copy it from the tool that emitted it.**

**Why the second hides inside the first, which is the part worth carrying.** A never-valid pointer usually fails with an error that _reads_ as staleness — `Head branch was modified` when the head has not moved. The natural response is to re-fetch, re-merge and retry, and **that works**: the retry supplies a real pointer, the operation succeeds, and the wrong diagnosis is never contradicted because the remedy for the misdiagnosis happens to be effective. **A failure whose standard fix works for the wrong reason will not be found by fixing it.** Before concluding staleness, check that the pointer you supplied ever existed.

**The targeting rule, which is the general form and the only enforceable thing on this page.** Beyond pointers: **a failure in the alarming direction will be investigated; a failure that resolves quietly will not.** The loud one recruits attention for free — somebody is already looking, because something looked broken. The quiet one consumes its own evidence: the retry succeeds, the task closes, and the successful repair gets logged as confirmation of whatever the operator already believed.

So the check does not belong everywhere. **It belongs on the operations that succeed on retry.** That is a set you can enumerate, not a disposition you have to sustain. Nearly every rule written today is a _be careful_ rule and is therefore unenforceable — it asks for more attention without saying where to take it from. **This one names the place.**

The asymmetry is the whole content: **the loud half is self-policing and the quiet half is not**, so a rule that treats them alike spends its budget on the half that did not need it. A same-class defect that fails noisily needs no rule — it was found because it shouted.

**A count I did not verify, flagged rather than laundered.** The lead reports six such stale-head assertions across five sessions in one day, one of them their own: recommending a narrative be moved into a directory that already contained it, twice, while pressing the author to answer the recommendation, without ever running `ls-tree` on the destination. **I have not re-derived that tally and cannot from this session** — five of the six are other sessions' work. It is recorded because the pattern is worth carrying, and marked because a note about checking must not pass along a number its own author took on report. **If you need the count to be load-bearing, re-derive it.**

---

**Why this note exists at all:** it was nearly not written. The paragraph it is built from lived only in a cross-session message — the highest-priority item in this set, and the only one with no durable artifact, while four notes that matter less were already committed. A lesson that exists only in a conversation expires when the conversation does. **Had it been left there, this note's own first sentence would have refuted it.**
