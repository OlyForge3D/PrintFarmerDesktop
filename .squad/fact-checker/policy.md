# Fact Checker Policy

> Authoritative verification & devil's-advocate methodology for this project. Fact Checker enforces these standards.

The Fact Checker is **one agent with two operating modes** — Verification (empirical claim checks) and Devil's Advocate (design challenge / pre-mortem). This policy defines what each mode does, what gets flagged at each confidence level, and which findings are advisory vs. blocking.

---

## Mode 1: Verification

Empirical check of claims against sources. Triggered by `"fact-check this"`, `"verify these claims"`, `"is this true?"`, Pre-Ship ceremony, or after any agent produces external references.

### What gets checked

| Claim type                               | What to verify                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **URLs**                                 | Does the URL actually resolve? (200, not 404 or 5xx)                                                                                                          |
| **Package names + versions**             | Does the npm/crates.io package exist at that version?                                                                                                         |
| **API endpoints**                        | Does the documented PrintFarmer API endpoint exist per its current docs?                                                                                      |
| **File paths**                           | Does the file exist in the repo at the claimed path (e.g. `native/model-core`, `src/`)?                                                                       |
| **Function / type signatures**           | Do they match the actual source (TypeScript or Rust)?                                                                                                         |
| **Quoted text**                          | Does the source actually contain the quoted text verbatim?                                                                                                    |
| **Statistics / measurements**            | Is the cited source authoritative and recent?                                                                                                                 |
| **Cross-references to team decisions**   | Does `.squad/decisions.md` actually say what was claimed? Scoped to claims made _about_ the log — this is the only object for which the log is the authority. |
| **Two artifacts rendering one incident** | Symmetric diff — see [Cross-Artifact Symmetric Diff](#cross-artifact-symmetric-diff). Neither artifact is the authority, including `.squad/decisions.md`.     |

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

1. **Look for a derivation already on the record before choosing this instrument.** A symmetric diff is the right tool when no artifact is privileged. Where one artifact records not just the value but **the method that established it** — a fixture rebuilt, a walk run, a measurement taken — that artifact _is_ an authority for this quantity, and choosing a no-authority instrument in its presence is choosing the weaker one. Use the diff to find the divergence, then cite the recorded derivation so a reader can reproduce the **conclusion** and not merely the disagreement.
2. **Enumerate every rendering, not two — the question is which renderings _exist_, not which ones disagree.** Search the whole tree for the quantity or claim — `.squad/`, `docs/`, source comments, test doc comments, issue and PR bodies. A pair-wise habit is how a third rendering survives a repair that fixed the other two. **Corrections do not propagate to renderings that do not yet exist**: a repair fixes the copies visible at the time, and the next author reaches for whichever copy is nearest, which may be a superseded one. So a figure can be re-rendered into a _new_ document after its correction is already on the record, and no diff between the copies known at repair time will ever see it. Enumeration at the current head is what finds those, and it is what found the live one in this file's first batch — a fourth rendering written 45 minutes after its own correction was published.
3. **Publish the extraction rule with the result.** State the pattern, the filter, and the head. A shared-figure count is not reproducible without them, and a count that cannot be re-derived is the next defect rather than evidence.
4. **Run a control that can report non-empty.** A rule that returns nothing is not the same as a rule that finds agreement.
5. **Compare the renderings against each other** and report any disagreement as a finding **against the pair or the set**, never against whichever member is not the decision log.
6. **Establish the slot before treating a difference as a defect.** Two documents giving different values for one quantity entail that at least one is wrong, with no further premise. Two artifacts of other kinds — test corpora, fixtures, harnesses — may legitimately differ in coverage, so a difference there is a **lead to be measured**, not a proof. The deduction needs the added premise that both artifacts render the same slot.

### Independence precondition

The check is sound only where the renderings were **derived independently**. Where one was written from the other, they agree by construction and the diff returns nothing.

**The test is asymmetric, and the asymmetry is the whole value of the grade.**

- **Dependence can be proved.** One commit writing both renderings, a long verbatim run between the two sentences against a control of unrelated lines, or a repair whose own record says it was made by reading the other rendering — any of these settles it.
- **Independence cannot be proved by provenance alone.** Separate commits, separate PRs and separate authors are **evidence** of independence, never proof: a figure can be copied across files a week later, and nothing in the history distinguishes that from two people measuring the same thing.

So **⚠️ Unverified is the default for a clean result**, and a clean diff on its own never reaches ✅ however many renderings agree.

**But independence is not the route to ✅, and defining it as such would make ✅ unreachable.** No repository records that two authors never read each other's files, so a grade requiring proof of that is decorative — and a grade nothing can earn gets quietly redefined the first time someone needs a clean result. Independence is a precondition for **agreement** being informative, and nothing more. It distinguishes a ⚠️ that is uninformative by construction from a ⚠️ that might mean something. It is not evidence of truth in either direction.

### Grading — Verified is discharged by a route that terminates outside the renderings

**Copying from the object is verification. Copying from another rendering is contagion.** That is the distinction; the hard part is knowing when you have actually reached the object.

- **❌ Contradicted.** The renderings disagree, or one contradicts the object. Reported against the pair or the set.
- **⚠️ Unverified.** The renderings agree and no derivation was performed, **or the derivation stopped at something that is itself a rendering.** This is the **default** and the common case. Agreement is not evidence; it is the absence of one kind of evidence of error.
- **✅ Verified.** The value is established by a derivation that **terminates in an artifact that is not a rendering** — the shipped code, the enforcing constant, the fixture the tests actually build — **and that artifact is identified in the record by path and commit**, so the route can be walked again by someone who does not trust the author. Every enumerated rendering must conform, enumerated at the current head.

**A harness is not the object. A harness is a fourth rendering.** A model of the behaviour under test, however carefully written and however often re-run, is still someone's account of that behaviour; three agreeing implementations are three renderings, not corroboration. What discharges ✅ is retrieving the thing they are renderings _of_ — reading the shipped implementation at the revision in question and naming it. This is the failure mode most likely to pass for success, because a harness emits numbers and numbers feel like measurement.

**Agreement between routes of the same class is replication, not corroboration.** Three people who each rebuild the fixture and walk it have run the same method three times. That is worth doing — it catches transcription slips and it is why a published harness is useful — but it cannot clear a bar defined as _a route terminating outside the renderings_, because none of the three does. Replication raises confidence that the model was implemented correctly; it says nothing about whether the model is faithful to the object. Count routes by **class of mechanism**, not by author or by implementation.

So the question to ask of any derivation is: **where does this route terminate?** If the last step is a document, a summary, a harness or a recollection, the grade is ⚠️ however exact the arithmetic. If the last step is an artifact that renders nothing — code that ran, a constant the program enforces, a fixture a test builds — the grade is ✅, and the artifact goes in the record.

Two worked examples are in `.squad/fact-checker/audit-trail.md`: the part-tree row budget, terminating in `MAX_PART_TREE_ROWS`; and the diamond-DAG row count, which reached ✅ **only** once the pre-fix implementation itself was retrieved — the harness alone did not get there.

**A clean result on a dependent pair is a false negative, and must not be reported as a pass.** Dependence threatens the **clean** result. A disagreement between dependent renderings is still a finding: they were supposed to agree by construction and do not, which means a repair touched one and not the other.

### Resolution — the diff establishes divergence, not truth

A symmetric diff with no authority tells you the renderings disagree. **It cannot tell you which one is right**, and nothing about the procedure entitles it to.

- **Never resolve by counting renderings.** Two renderings that agree are **one rendering** if they are dependent, so a majority can be a single source copied twice. Repairing the minority to match the majority without establishing independence is the dependent-pair false negative committed deliberately, by the instrument built to catch it.
- **Derive the value from the thing that is not a rendering** — the code, the constant, the fixture, the computation, the object itself. Publish the derivation so it can be re-run, and **publish it as a file in the repository rather than only in a pull-request body**. A correction that lives somewhere less durable than the thing it corrects loses to it: the next author reaches for the artifact that is still there. A harness in a merged PR description is a correction with a shorter half-life than the figure it fixes.
- **Where no such source exists**, the finding stands as a divergence and the resolution is escalated to the artifact owners. A guess dressed as a repair is worse than an open finding.
- **Arithmetic consistent with a decomposition is not its derivation.** If two reported figures differ by some residue, restating that they sum is true by construction and evidence for nothing — it holds whatever the residue actually consists of, including a coincidence. **Measure the populations separately.** And keep the verbs honest: _"rebuilding it yields"_ asserts a measurement, so either take it, or attribute it to whoever did. An accurate outcome with a plausible mechanism attached is still a fabrication, and a reader of the repaired document has no way to tell.
- **Repair with the source's own noun.** Where the defect is a quantity attached to the wrong unit, restating the correction in the unit that caused the error re-seeds it. If the source's word is itself ambiguous across two readings, say which reading the measurement names, and give the other quantity so the ambiguity cannot re-form.
- **Before reporting a source as ambiguous, test the rival reading against the whole sentence — including the qualifiers.** Finding that some _other_ true quantity exists in the same object is not enough to convict a phrase of naming it. Read the sentence the way you would read the artifact under test: ask what it asserts the quantity is _of_, and check whether its qualifiers survive the rival reading. If they do not, the rival reading is yours and not the source's. This is the same discriminator that settles a units defect downstream, and it must be applied to the cited authority with equal force — an authority is not more suspect for being cited, and it is not less. **This rule exists because this file's own first batch got it wrong**: a rival reading was proposed for a phrase whose next word ruled it out, and it was reported as a defect in the decision log. See the retraction in `.squad/fact-checker/audit-trail.md`.
- **Rule out "different quantities" before ruling "stale".** A symmetric diff cannot distinguish _one rendering is out of date_ from _the two are measuring different things_. Check the units and the slot first. Reporting the second as the first is a **false finding manufactured by the check itself**, and it will be believed, because the check that produced it was built to be trusted.

### Discharge

**Resolve first, then repair.** Discharge acts on the value established by the resolution step above, never on the value the majority of renderings happened to carry.

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
