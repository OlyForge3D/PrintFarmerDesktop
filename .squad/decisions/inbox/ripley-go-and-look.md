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

**A SHA, a merge state, a `MERGEABLE` field, a branch described as untouched, a PR's readiness, the contents of a directory — these are measurements, not addresses.** They fail in three ways. The second is disguised as the first; the third passes every check aimed at the other two.

**Stale — true when taken, decayed since.** The reading was correct; it was asserted after the thing moved. Remedy: **re-measure at the moment of assertion, not before the last edit.** For a PR head, pin `gh pr view <n> --json headRefOid` at send time. For a directory you are about to recommend as a destination, run `ls-tree` on it first — a file cannot be moved somewhere it already is.

**Re-measuring is necessary and not sufficient, and this note has a first-hand case.** Seconds after a successful push, `gh pr view 163 --json headRefOid` returned the **previous** head. That was a fresh read of a cached view — a correct measurement of the wrong thing, which is the same defect one layer down from the one being guarded against. **A single read cannot detect its own staleness**, and the more authoritative the source, the more confidently a stale answer from it gets repeated.

**The remedy is not "two sources."** An earlier version of this note said _agreement between two sources with different caches_. That formulation is defective, and the falsifier is one sentence: **agreement is also exactly what two stale sources produce.** "Different caches" is a property of the _pair_, and the person applying the rule cannot check it — they pick a second command, get agreement, and move on, having satisfied a rule that has quietly degraded into the single-source version it replaced. **It presents as an upgrade, which is worse than not having it at all.**

**So name the property that makes a particular second source qualify.** For a git ref that property is available and cheap: `git ls-remote origin <ref>` is the **ref advertisement** — the same read `git push` performs, and the same one git hands the pre-push hook — so it cannot be serving a view assembled before the push landed. Agreement between `ls-remote` and `gh` then means something specific: _the API view matches what a push would see_, which is the claim a pinned head actually has to support. **Not merely a different cache — the ground truth for the operation the pin is about.**

> **A rule that says "use two sources" without naming why a particular second source qualifies is one substitution away from being decorative.**

**One trap inside the same command.** `git ls-remote origin refs/heads/<branch> refs/pull/<n>/head` returns both refs, and their agreeing is **not** a second confirmation — it is **one response, one rendering, read twice.** If the advertisement were stale, both would be stale together. It is still worth reading, for a different fact: GitHub populates the PR head ref from the branch ref and the two can lag, so agreement tells you that propagation has completed. **Informative about propagation, uninformative about staleness** — and counting it as corroboration is this note's own error, one level in.

**Amended — the lag has a direction, and the direction is the whole warning.** The paragraph above said only that the two "can lag," which reads as symmetric and leaves `refs/pull/<n>/head` looking like a merely-redundant read. It is worse than redundant. Measured after a push, `refs/pull/<n>/head` trailed `refs/heads/<branch>` by **roughly five seconds** — making it **the stalest of the three propagation paths, behind both `refs/heads` and the `gh` client's view.** So the ref most likely to be offered as a free extra confirmation is the one most likely to be wrong, and it is wrong in the direction that matters: it reports an **older** head, which is the failure this note exists to prevent. **`git ls-remote <url> refs/heads/<branch>` is the source; `refs/pull/<n>/head` is a propagation probe and nothing else.**

Note what a symmetric phrasing costs. _"The two can lag"_ is true, was written from reasoning about how GitHub populates the ref rather than from a measurement, and is **unfalsifiable as stated** — no observation contradicts it, so it survived review and would have survived indefinitely. **A directionless claim about a directional mechanism is the shape that reads as caution while withholding the only part a reader can act on.**

**Never valid — no reading was ever taken.** A pointer that was reconstructed, transcribed, re-typed, or expanded by hand was never a measurement of anything. An abbreviated SHA **is a rendering of a commit**; expanding it by hand produces a second rendering with no artifact behind it. `git rev-parse` is the measurement. Remedy: **never reconstruct an identifier — copy it from the tool that emitted it.**

**Valid, resolving, and serving a superseded document.** A commit-pinned URL cannot decay — that is the reason for pinning it. The _document_ moves on instead, and the pin then returns something authentic, reachable, and wrong. First-hand: this file was broadcast at `af03801`, verified before sending, and the verification performed was _does it resolve_. It resolved, returned 6933 bytes, and **did not contain the clause above naming why a second source qualifies** — that landed in `6538bed`. The pointer was checked, and it was checked against the failure mode that announces itself anyway.

**A 404 is loud, self-reporting, and gets fixed. A live blob serving an old version is silent, and reads as diligence, because someone did check it.** Testing reachability tests the mode that did not need testing — this note's own targeting rule, arriving in this note's own broadcast. Remedy: **a pointer to a moving document needs a content assertion, not just an address.** Pin the SHA _and_ say what the reader must find there; if the expectation and the blob disagree, the pin is superseded even though it resolves. Re-derive the SHA from the live head at the moment of sending, and prefer the directory over the file when the document has siblings that share its fate.

**Why the second hides inside the first, which is the part worth carrying.** A never-valid pointer usually fails with an error that _reads_ as staleness — `Head branch was modified` when the head has not moved. The natural response is to re-fetch, re-merge and retry, and **that works**: the retry supplies a real pointer, the operation succeeds, and the wrong diagnosis is never contradicted because the remedy for the misdiagnosis happens to be effective. **A failure whose standard fix works for the wrong reason will not be found by fixing it.** Before concluding staleness, check that the pointer you supplied ever existed.

**The targeting rule, which is the general form and the only enforceable thing on this page.** Beyond pointers: **a failure in the alarming direction will be investigated; a failure that resolves quietly will not.** The loud one recruits attention for free — somebody is already looking, because something looked broken. The quiet one consumes its own evidence: the retry succeeds, the task closes, and the successful repair gets logged as confirmation of whatever the operator already believed.

So the check does not belong everywhere. **It belongs on the operations that succeed on retry.** That is a set you can enumerate, not a disposition you have to sustain. Nearly every rule written today is a _be careful_ rule and is therefore unenforceable — it asks for more attention without saying where to take it from. **This one names the place.**

The asymmetry is the whole content: **the loud half is self-policing and the quiet half is not**, so a rule that treats them alike spends its budget on the half that did not need it. A same-class defect that fails noisily needs no rule — it was found because it shouted.

**A count I did not verify, flagged rather than laundered.** The lead reports six such stale-head assertions across five sessions in one day, one of them their own: recommending a narrative be moved into a directory that already contained it, twice, while pressing the author to answer the recommendation, without ever running `ls-tree` on the destination. **I have not re-derived that tally and cannot from this session** — five of the six are other sessions' work. It is recorded because the pattern is worth carrying, and marked because a note about checking must not pass along a number its own author took on report. **If you need the count to be load-bearing, re-derive it.**

## Convergence is a control for staleness, not a control for relevance

**This is the limit of everything above, and it belongs in this note because this note is what would otherwise mislead you.** Every rule so far makes a reading _current_. None of them makes it _responsive_.

Three sources agreeing establishes that a value is current. **It cannot establish that the value answers the question you asked** — and where it does not, the agreement makes the reading _more_ persuasive, not less.

**The incident.** A reader checking whether PR #163 was still open read `headRefOid` three ways and got one answer:

```
gh pr view 163 --json headRefOid    bb36969
ls-remote refs/heads/<branch>       bb3696981ecb125eeb6f12f5b525710a6f22d8bd
ls-remote refs/pull/163/head        bb3696981ecb125eeb6f12f5b525710a6f22d8bd

gh pr view 163 --json state         MERGED, forty minutes earlier
```

**The read was correct, current, and convergent. It was silent about the only thing being asked.** `headRefOid` does not change on merge, and `delete_branch_on_merge` is `false`, so both refs outlive the merge and keep reporting the same value forever. **The field cannot express the answer, so no amount of agreement about it approaches one.**

Two refinements, both of which make it worse rather than better:

- **It was two sources, not three.** `refs/heads/<branch>` and `refs/pull/<n>/head` come back in **one `ls-remote` response** — one rendering read twice, per the trap recorded above.
- **Both report a field invariant under the event in question.** That is not two weak sources; it is the same blind spot sampled twice.

**So the check to add is not another source.** It is one question, asked before reading anything:

> **What would this field say if the thing I am asking about had happened?**

If the answer is _"the same thing"_, the field is not an instrument for that question and a third source is wasted effort that will feel like diligence. `headRefOid` is invariant under merge. A **diffstat** is invariant under a clean merge that changes no delta. A **merge-base** moves only when the branch takes new base history — the right field for _"did the base move under me"_ and **equally silent on merge, on force-push, and on content.**

**Naming the event an instrument covers is therefore part of proposing it.** An instrument handed over without that is a staleness control that will be used as a correctness control, which is exactly what happened here.

### Why going to the artifact _looks_ like it catches this, and does not

A counterexample was offered against the rule above: a session reading
`cargo test` output saw green while feature-gated tests never ran, and caught it
by asking a **provenance** question — _which step emitted this line?_ — rather
than by changing fields. If that holds, provenance controls do catch relevance
errors and the rule needs a boundary.

**Reproduced here rather than judged from the description**, at
`cargo 1.97.1`:

```
cargo test --manifest-path native/Cargo.toml -p model-core sqlite

exit code: 0
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 264 filtered out
```

**The candidate dies, and the measurement is why.** Two fields are present in
that single command's output and they differ in what they can express:

- the **exit code** is `0`. It is `0` when 264 tests pass and `0` when none
  compile. Against _"did the gated tests run"_ it carries **zero bits**.
- the **summary line** says `0 passed` and `264 filtered out`. It answers the
  question **completely, in the same stream, one line away.**

So the session did change fields — from exit status to stdout — and this is the
rule working, not an exception to it. **The informative field was not in another
job or another artifact. It was adjacent to the misleading one.**

**Which explains the illusion, and the explanation is the part worth keeping.**
Going to the artifact does not answer relevance questions. It **incidentally
widens the field set**, because a raw log necessarily exposes fields that a
verdict discards — and the catch then comes from the field change, which the
reader never notices making. **Provenance controls will keep appearing to catch
relevance errors for exactly as long as nobody separates the two steps.**

So the rule stands unqualified, with one practical corollary: **when a summary
and its underlying output disagree in expressive power, the summary is the field
that cannot answer you.** `ok` is a verdict; `0 passed` is a measurement.

---

**Why this note exists at all:** it was nearly not written. The paragraph it is built from lived only in a cross-session message — the highest-priority item in this set, and the only one with no durable artifact, while four notes that matter less were already committed. A lesson that exists only in a conversation expires when the conversation does. **Had it been left there, this note's own first sentence would have refuted it.**
