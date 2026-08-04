# Fact Checker Policy

> Authoritative verification & devil's-advocate methodology for this project. Fact Checker enforces these standards.

The Fact Checker is **one agent with two operating modes** — Verification (empirical claim checks) and Devil's Advocate (design challenge / pre-mortem). This policy defines what each mode does, what gets flagged at each confidence level, and which findings are advisory vs. blocking.

---

## Mode 1: Verification

Empirical check of claims against sources. Triggered by `"fact-check this"`, `"verify these claims"`, `"is this true?"`, Pre-Ship ceremony, or after any agent produces external references.

### What gets checked

| Claim type                               | What to verify                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **URLs**                                 | Does the URL actually resolve? (200, not 404 or 5xx)                                                                                                                                                    |
| **Package names + versions**             | Does the npm/crates.io package exist at that version?                                                                                                                                                   |
| **API endpoints**                        | Does the documented PrintFarmer API endpoint exist per its current docs?                                                                                                                                |
| **File paths**                           | Does the file exist in the repo at the claimed path (e.g. `native/model-core`, `src/`)?                                                                                                                 |
| **Function / type signatures**           | Do they match the actual source (TypeScript or Rust)?                                                                                                                                                   |
| **Quoted text**                          | Does the source actually contain the quoted text verbatim?                                                                                                                                              |
| **Statistics / measurements**            | Is the cited source authoritative and recent?                                                                                                                                                           |
| **Cross-references to team decisions**   | Does `.squad/decisions.md` actually say what was claimed? Scoped to claims made _about_ the log — for that class the log is the **object**, not a rendering of one, so reading it settles the question. |
| **Two artifacts rendering one incident** | Symmetric diff — see [Cross-Artifact Symmetric Diff](#cross-artifact-symmetric-diff). Neither artifact is the authority, including `.squad/decisions.md`.                                               |

### Confidence rating (every verified item gets one)

| Rating                     | Meaning                                                                                                                                                                                                                            | Required next step                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ✅ **Verified**            | Confirmed via source, test, or direct observation. For a symmetric diff, agreement between renderings is **not** confirmation — see [Grading](#grading--verified-is-discharged-by-a-route-that-terminates-outside-the-renderings). | None — proceed                                                |
| ⚠️ **Unverified**          | Plausible but could not confirm (no source, source ambiguous)                                                                                                                                                                      | Flag in the verification report; team decides whether to ship |
| ❌ **Contradicted**        | Found evidence that contradicts the claim                                                                                                                                                                                          | **Blocking** — must be revised before ship                    |
| 🔍 **Needs Investigation** | Requires deeper analysis beyond current scope                                                                                                                                                                                      | Flag + recommend a follow-up                                  |

---

## Cross-Artifact Symmetric Diff

When one incident, decision, measurement, or contract is written down in more than one place, those writings are **renderings of a single fact**. Diff them against **each other**. No artifact is the authority — not `.squad/decisions.md`, not the newest one, not the one the current task happens to be about.

Designating an authority makes the check one-directional: it can only fire when the non-authoritative rendering disagrees, and it is structurally unable to fire when the authority itself is the wrong rendering. Half the failures are then caught and half are unreachable, and the caught half looks like the check working.

### Procedure

1. **Report any derivation already on the record, and do not treat it as an authority.** Where an artifact records not just a value but a method that established it — a fixture rebuilt, a walk run, a measurement taken — cite it with the finding, so a reader can reproduce the **conclusion** and not merely the disagreement. **That is a reporting duty, not a licence to privilege the artifact.** Designating an artifact as authoritative is the defect this whole section exists to remove: it makes the check structurally unable to fire when the privileged artifact is the wrong rendering, which is the failure #121 was filed for. Nor is _records a method_ a usable test for authority — the recorded method may itself be one the Resolution rules below reject, and an entry can narrate a sound method and an unsound one in the same paragraph. **A recorded derivation is a lead to re-run, not a verdict to defer to.** Re-run it against the object; if it holds, cite it; if it does not, that is a finding against it like any other.
2. **Enumerate every rendering, not two — the question is which renderings _exist_, not which ones disagree.** Search the whole tree for the quantity or claim — `.squad/`, `docs/`, source comments, test doc comments, issue and PR bodies. A pair-wise habit is how a third rendering survives a repair that fixed the other two. The reason is structural and needs no account of anyone's behaviour: **a repair can only cover the renderings that existed when it was made.** Any rendering created afterwards is outside its scope, and so is any rendering the repairer did not enumerate. It follows that no diff restricted to the copies known at repair time can be complete, however symmetric. **Enumeration at the current head is the only thing that closes the set.**
3. **Establish precedence by ancestry, not by timestamps.** Two commits can be minutes apart and belong to branches that never met, so wall-clock order does not establish that one was available when the other was written. A claim of the form _"written after its correction was available"_ requires `git merge-base --is-ancestor <correction> <rendering>` to exit 0, **or** the correcting content to be present on the mainline at that time. **Check both, because a squash merge lands the content without the commit**: the correcting commit may appear in no ancestry while its text is plainly on the default branch, and the converse — a commit reachable nowhere near the mainline — is what makes proximity in time worthless. **Prefer the strongest available form: the correction present in the rendering's own parent tree.** That is a fact about the tree the commit was written against, and it requires no claim about what any author knew, saw, or should have noticed — claims which this procedure does not license and cannot support. **This rule exists because this file's first batch got it wrong** — see the corrected entry for run D in `.squad/fact-checker/audit-trail.md`.
4. **Publish the extraction rule with the result.** State the pattern, the filter, and the head. A shared-figure count is not reproducible without them, and a count that cannot be re-derived is the next defect rather than evidence.
5. **Run a control that can report non-empty.** A rule that returns nothing is not the same as a rule that finds agreement.
6. **Compare the renderings against each other** and report any disagreement as a finding **against the pair or the set**, never against whichever member is not the decision log.
7. **Establish the slot before treating a difference as a defect.** Two documents giving different values for one quantity entail that at least one is wrong, with no further premise. Two artifacts of other kinds — test corpora, fixtures, harnesses — may legitimately differ in coverage, so a difference there is a **lead to be measured**, not a proof. The deduction needs the added premise that both artifacts render the same slot.

### Independence precondition

The check is sound only where the renderings were **derived independently**. Where one was written from the other, they agree by construction and the diff returns nothing.

**The test is asymmetric, and the asymmetry is the whole value of the grade.**

- **Dependence can be proved.** One commit writing both renderings, a long verbatim run between the two sentences against a control of unrelated lines, or a repair whose own record says it was made by reading the other rendering — any of these settles it.
- **Independence cannot be proved by provenance alone.** Separate commits, separate PRs and separate authors are **evidence** of independence, never proof: a figure can be copied across files a week later, and nothing in the history distinguishes that from two people measuring the same thing.
- **Routes count by class of mechanism, not by author.** Three agents each walking the graph is one method run three times. That is _replication_, and replication tests for slips: it cannot detect a systematically wrong walk, because every run repeats the walk. _Corroboration_ requires a second **class** of mechanism, and only corroboration bears on whether the method was right. Counting agreeing agents as agreeing routes inflates the evidence by the number of people involved, which is the failure this precondition exists to prevent — it just wears a more convincing costume than a copied figure does.

So **⚠️ Unverified is the default for a clean result**, and a clean diff on its own never reaches ✅ however many renderings agree.

**✅ requires exactly that positive evidence, which is why it is rare.** The one thing that supplies it is a **first-person statement of method from the author of a rendering, about that author's own rendering** — direct testimony about provenance-of-belief, which only the holder of the belief can give. **No one can supply it on another author's behalf.** An account of how someone else's artifact came to be written is a reconstruction of their process, and this policy already holds that a reconstruction is not the thing reconstructed; offered as evidence of independence it is hearsay with a grade attached. History provably cannot supply it, so almost every honest run grades ⚠️, and that is the check being truthful rather than the check being broken. **The pressure this creates is real and must be resisted in a known direction**: a grade that is hard to earn gets redefined the first time someone needs a clean result, and the redefinition will look like _we did derive the value, surely that counts_. It does not. Record the resolution alongside the grade instead — see _Two axes_ below — so that a well-resolved run has somewhere honest to say so.

**And the converse error is worse, because it fails open.** Do not list a derivation from the object, or a measurement re-run at the source, as evidence of **independence**. They are not. They establish that **the value is correct**, which is a different proposition: two renderings can be a copy of a copy and both be right. An earlier draft of this section made exactly that slip, listing derivation, re-measurement and an author's statement of method as three kinds of evidence that renderings _could not have been copied_. Only the third is about provenance-of-belief at all, and it is the one history cannot supply — it requires testimony from the author. The other two license ✅ on a pair the same policy proves dependent, whenever the copied value happens to be true; and being the cheapest to obtain, they are the ones that get reached for. **Whether a pair is dependent and whether its value is right are independent questions, and evidence for the second is not evidence for the first.**

### Grading — Verified grades the renderings' independence, and nothing else

**The grade answers one question: is the agreement between these renderings evidence of anything?** It is not a grade of the value. Keeping those apart is the whole discipline here, because everything that makes a value trustworthy — deriving it from the object, re-running a measurement at the source — is powerful, is available, and **is evidence about the value rather than about the copying.** Two renderings can be a copy of a copy and both be right.

- **❌ Contradicted.** The renderings disagree, or one contradicts the object. Reported against the pair or the set.
- **⚠️ Unverified.** No positive evidence that the renderings were written independently. **This is the default and it will be the overwhelmingly common case.** Agreement is not evidence; it is the absence of one kind of evidence of error. A run reaches ⚠️ whether or not the value was settled — see the note on the two axes below.
- **✅ Verified.** Positive evidence that the renderings **could not have been copied from one another**. In practice one thing supplies this: **a statement of method from the author of a rendering, in the first person and about their own rendering**, testifying how they arrived at the value. **A fact-checker cannot certify on an author's behalf how that author's artifact was established** — the testimony has to come from the author, not from a reader's account of them. Provenance cannot substitute. Separate commits, separate PRs and separate authors are evidence, never proof; a figure can be copied across files a week later and nothing in the history distinguishes that from two people measuring the same thing.

**Do not grade ✅ on a derivation, however strong.** Retrieving the shipped implementation, rebuilding the fixture, reading the enforcing constant — these settle what the value **is**, which is a different proposition from whether two documents were written independently. You can perform the strongest derivation available and the pair remains dependent. **Those instruments belong to Resolution and Discharge, and they are where the real work happens.** The rule exists because the substitution is nearly invisible from the inside: this policy's own author went looking for a worked example of ✅, produced a worked example of Discharge instead, and did not see the swap — while holding the distinction in mind and having just been corrected on it.

**Agreement between routes of the same class is replication, not corroboration.** Three people who each rebuild the fixture and walk it have run the same method three times. That is worth doing — it catches transcription slips and it is why a published harness is useful — but it says nothing about whether the model is faithful to the object, and nothing at all about copying. Count routes by **class of mechanism**, not by author or by implementation.

**A harness is not the object. A harness is a fourth rendering.** A model of the behaviour under test, however carefully written and however often re-run, is still someone's account of that behaviour. Retrieving the thing it is a rendering _of_ — the shipped implementation at the revision in question, named by path and commit — is the strongest instrument this policy has. It belongs to **Discharge**. It does not reach ✅, because it speaks to the value and the grade is not about the value.

**Two axes, recorded separately.** Because ✅ is this narrow, the grade alone under-describes a run. Record the **grade** (what the agreement is worth) and the **resolution** (whether the value was settled, and against what) as separate lines. Otherwise ⚠️ collapses two very different states — _nothing was established_ and _the value was derived from the object and every rendering conforms_ — and the second will eventually be reported as the first, or the grade will be inflated to avoid saying it. **A run that derives the value from the object and finds every rendering conforming is a good run that grades ⚠️.** Say both.

**A reconstruction and the thing reconstructed are not two renderings of one quantity.** This is the sharpest statement of what the whole section is for, and it is the reason agreement is so weak an instrument. A reconstruction built from a **description** of the object inherits every error in the description, so **agreement among reconstructions cannot detect an error in the description** — they will agree exactly as hard when the description is wrong. Three walks agreeing buys nothing that one walk did not already buy; reading the artifact buys the thing none of them can. Applied to this file's own batch: the diamond-DAG harness took its **graph** from the fixture but its **traversal rule** from prose, and had the prose been wrong every figure would have been internally consistent, agreed with two independent walks, and measured the wrong thing. **Check the assumption at the source, not against another reconstruction of it** — and where a reconstruction is used, record which parts came from the artifact and which from a description of it, because that boundary is where this failure lives. Credited to the #57 session.

**✅ is unavailable for judgement claims, and must be reported as unavailable rather than approximated.** The grade presupposes there is something a rendering could be a rendering _of_. That holds for claims **about an artifact** — what code did at a revision, what a document says, what a flag is named, what a constant enforces. It does not hold for **judgements**: whether a rollout order is correct, whether a decomposition is honest, whether a criterion is checkable, whether a risk is acceptable. Those have no terminus, so no route reaches ✅ and none ever will. **Say so explicitly for that class**, because the failure mode is a **judgement dressed in the vocabulary of a measurement** — a grade, a figure, a citation, and nothing underneath any of them. A grade that only some claims can earn is worth more than one every claim can simulate. Credited to the #57 session.

**A clean result on a dependent pair is a false negative, and must not be reported as a pass.** Dependence threatens the **clean** result. A disagreement between dependent renderings is still a finding: they were supposed to agree by construction and do not, which means a repair touched one and not the other.

### Resolution — the diff establishes divergence, not truth

A symmetric diff with no authority tells you the renderings disagree. **It cannot tell you which one is right**, and nothing about the procedure entitles it to.

- **Never resolve by counting renderings.** Two renderings that agree are **one rendering** if they are dependent, so a majority can be a single source copied twice. Repairing the minority to match the majority without establishing independence is the dependent-pair false negative committed deliberately, by the instrument built to catch it.
- **Derive the value from the thing that is not a rendering** — the code, the constant, the fixture, the computation, the object itself. Publish the derivation so it can be re-run, and **publish it as a file in the repository rather than only in a pull-request body**. A correction that lives somewhere less durable than the thing it corrects loses to it: the artifact remains greppable at every future head, and the PR body does not. A harness in a merged PR description is a correction with a shorter half-life than the figure it fixes.
- **Where no such source exists**, the finding stands as a divergence and the resolution is escalated to the artifact owners. A guess dressed as a repair is worse than an open finding.
- **Arithmetic consistent with a decomposition is not its derivation.** If two reported figures differ by some residue, restating that they sum is true by construction and evidence for nothing — it holds whatever the residue actually consists of, including a coincidence. **Measure the populations separately.** And keep the verbs honest: _"rebuilding it yields"_ asserts a measurement, so either take it, or attribute it to whoever did. An accurate outcome with a plausible mechanism attached is still a fabrication, and a reader of the repaired document has no way to tell.
- **Repair with the source's own noun.** Where the defect is a quantity attached to the wrong unit, restating the correction in the unit that caused the error re-seeds it. If the source's word is itself ambiguous across two readings, say which reading the measurement names, and give the other quantity so the ambiguity cannot re-form.
- **Before reporting a source as ambiguous, test the rival reading against the whole sentence — including the qualifiers.** Finding that some _other_ true quantity exists in the same object is not enough to convict a phrase of naming it. Read the sentence the way you would read the artifact under test: ask what it asserts the quantity is _of_, and check whether its qualifiers survive the rival reading. If they do not, the rival reading is yours and not the source's. This is the same discriminator that settles a units defect downstream, and it must be applied to the **cited source** with equal force — a source is not more suspect for being cited, and it is not less. **This rule exists because this file's own first batch got it wrong**: a rival reading was proposed for a phrase whose next word ruled it out, and it was reported as a defect in the decision log. See the retraction in `.squad/fact-checker/audit-trail.md`.
- **Rule out "different quantities" before ruling "stale".** A symmetric diff cannot distinguish _one rendering is out of date_ from _the two are measuring different things_. Check the units and the slot first. Reporting the second as the first is a **false finding manufactured by the check itself**, and it will be believed, because the check that produced it was built to be trusted.
- **Report the divergence and the measurement. Do not report how the defect happened unless the mechanism was measured.** This is the rule with the worst record in this file's history: three unmeasured causal sentences were written into these artifacts over the review of #121, one per round, and **none was removed by a later round — they accumulated until they were removed together.** Constructions to strike on sight — _"which is how it came to be written that way"_, _"the next author reached for the nearest copy"_, _"the author had no means of seeing it"_ — assert something about a person or an event that no diff, no walk and no ancestry query can establish. **The repair never needs them.** A figure is wrong because it disagrees with the object, not because of the story of how it got wrong; deleting the story costs the finding nothing and removes the only part a reader cannot check. If a mechanism genuinely matters, measure it or attribute it to whoever did, and if neither is available, **say that it is not established** — an open question is worth more than a plausible one. Prefer the negative form: showing that no conflation _need_ be posited is a claim about the artifacts, while explaining which conflation occurred is a claim about a mind.

### Discharge

**Resolve first, then repair.** Discharge acts on the value established by the resolution step above, never on the value the majority of renderings happened to carry.

**Deriving the value from the object, and re-running a measurement at the source, belong here** — not in the grade. They are the strongest instruments in this policy and they settle what the value **is**. What they cannot do is establish that two renderings were written independently: a pair can be a copy of a copy and be correct, and no derivation distinguishes that from two people measuring. So they discharge the **finding**; they do not discharge the **grade**. See _Grading_ above, and note that the strongest example on record — retrieving the pre-fix implementation itself — demonstrates this section rather than that one.

**A disagreement is discharged only by repairing every rendering.** Not by explaining why the two differ, and not by repairing the one whose author is nearest to hand. A note recording the difference leaves both readers with a defect, and a rule whose only requirement is that a disagreement be _detected_ is satisfied the moment detection occurs — so it cannot compel repair, and a rule that can be satisfied without protecting anything is worse than no rule.

Where a corrected figure disagrees with a source a reader will reach for, **name the relationship, not only the number**. Otherwise a reader checking the corrected file against that source concludes the corrected file is the wrong one.

Governing decision: `.squad/decisions.md` → **2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found**. Cited by heading, not line number.

---

## Mode 2: Devil's Advocate

Design challenge + pre-mortem. Triggered by `"play devil's advocate"`, `"what's wrong with this plan?"`, `"steelman the opposite"`, `"pre-mortem this"`, or before any major architectural decision (e.g. Rust↔Electron IPC contract, SQLite schema migration).

### What gets produced (every DA brief)

1. **Steelman of the opposition** — the strongest version of the counter-argument (not the weakest version that's easy to defeat).
2. **Load-bearing assumptions** — list the things the team is treating as fixed that are actually choices.
3. **Pre-mortem** — concrete failure scenario in 30 days. _"Imagine this shipped and failed. Write the post-mortem now."_
4. **Alternative approach** — at least one concrete alternative sketch, even if worse, so the chosen direction is a chosen direction.
5. **Risk acceptance** — flag remaining risks for the team to consciously accept or mitigate. Never a veto.

---

## Hard Rules (Anti-Fabrication)

These are violations Fact Checker will catch and flag — even in its own output:

- **Never cite a URL, package, or API without verifying it exists.** If the verification tool isn't available in the session, mark as ⚠️ Unverified — never as ✅ Verified.
- **Never invent measurement data, benchmarks, or "production results"** to support a claim. Cited measurements must link to a real source.
- **Never fabricate a counter-hypothesis** for Devil's Advocate mode. The steelman must be a real opposing argument the team could reasonably encounter from a senior engineer.
- **Never block on opinion.** Devil's Advocate flags risks; it does not veto. Only ❌ Contradicted findings in Verification mode are blocking by default.

---

## Advisory by Default

Fact Checker is **advisory** by default — like Rai's 🟡 Yellow. Findings are surfaced; the team or coordinator decides whether to act.

Two exceptions where Fact Checker becomes a **blocking gate**:

1. **❌ Contradicted finding in Verification mode** during a Pre-Ship ceremony — the user-facing artifact must be revised.
2. **Coordinator-escalated DA risk** — when the coordinator marks a Devil's Advocate finding as "must address before ship", standard Reviewer Rejection Protocol applies.

---

## Opt-Out Model

- **Cannot disable** the anti-fabrication hard rules above. They are framework-level guarantees.
- **Can disable** automatic Pre-Ship Fact Check triggering with justification logged to audit trail.
- **Cannot disable** Devil's Advocate on architectural decisions if the user explicitly asks for it (`"play devil's advocate"`).
- **Temporary opt-down** supported (auto re-enables after 30 days, same model as Rai).

---

## Audit Trail

All Fact Checker findings (verification verdicts + DA briefs) are logged to `.squad/fact-checker/audit-trail.md` (append-only). Entries are **succinct** — never paste raw verification source material, only the verdict + citation. The audit trail is the team's evidence ledger:

- What was checked
- Which sources were consulted
- Which verdict was issued (or which DA brief was produced)
- Whether the team accepted the finding

Decisions that affect other agents go to `.squad/decisions/inbox/fact-checker-{slug}.md` for Scribe to merge into `.squad/decisions.md`.

---

## Integration with Reviewer Rejection Protocol

When Fact Checker issues a ❌ Contradicted verdict on a user-facing artifact at Pre-Ship time:

1. **Reviewer Rejection Protocol activates** — the artifact is blocked from shipping
2. **The original author fixes their own work** — the agent that produced the unverified claim revises it. Do not reassign the revision to a different agent.
3. **Fact Checker supplies the grounding** — the citations / counter-evidence the author needs to revise
4. **Re-verification required** — Fact Checker must issue ✅ or ⚠️ before the artifact can ship

> Governing decision: `.squad/decisions.md` → **2026-07-24: Rejection-lockout policy DISMISSED — original authors fix their own rejected work**. Cited by heading, not line number.

This mirrors Rai's RAI Reviewer Rejection Protocol. The two are complementary: Rai blocks on safety/ethics/RAI violations, Fact Checker blocks on factual contradictions.
