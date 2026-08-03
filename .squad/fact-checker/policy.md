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

| Rating                     | Meaning                                                       | Required next step                                            |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| ✅ **Verified**            | Confirmed via source, test, or direct observation             | None — proceed                                                |
| ⚠️ **Unverified**          | Plausible but could not confirm (no source, source ambiguous) | Flag in the verification report; team decides whether to ship |
| ❌ **Contradicted**        | Found evidence that contradicts the claim                     | **Blocking** — must be revised before ship                    |
| 🔍 **Needs Investigation** | Requires deeper analysis beyond current scope                 | Flag + recommend a follow-up                                  |

---

## Cross-Artifact Symmetric Diff

When one incident, decision, measurement, or contract is written down in more than one place, those writings are **renderings of a single fact**. Diff them against **each other**. No artifact is the authority — not `.squad/decisions.md`, not the newest one, not the one the current task happens to be about.

Designating an authority makes the check one-directional: it can only fire when the non-authoritative rendering disagrees, and it is structurally unable to fire when the authority itself is the wrong rendering. Half the failures are then caught and half are unreachable, and the caught half looks like the check working.

### Procedure

1. **Enumerate every rendering, not two.** Search the whole tree for the quantity or claim — `.squad/`, `docs/`, source comments, test doc comments, issue and PR bodies. A pair-wise habit is how a third rendering survives a repair that fixed the other two.
2. **Publish the extraction rule with the result.** State the pattern, the filter, and the head. A shared-figure count is not reproducible without them, and a count that cannot be re-derived is the next defect rather than evidence.
3. **Run a control that can report non-empty.** A rule that returns nothing is not the same as a rule that finds agreement.
4. **Compare the renderings against each other** and report any disagreement as a finding **against the pair or the set**, never against whichever member is not the decision log.
5. **Establish the slot before treating a difference as a defect.** Two documents giving different values for one quantity entail that at least one is wrong, with no further premise. Two artifacts of other kinds — test corpora, fixtures, harnesses — may legitimately differ in coverage, so a difference there is a **lead to be measured**, not a proof. The deduction needs the added premise that both artifacts render the same slot.

### Independence precondition

The check is sound only where the renderings were **derived independently**. Where one was written from the other, they agree by construction and the diff returns nothing.

**The test is asymmetric, and the asymmetry is the whole value of the grade.**

- **Dependence can be proved.** One commit writing both renderings, a long verbatim run between the two sentences against a control of unrelated lines, or a repair whose own record says it was made by reading the other rendering — any of these settles it.
- **Independence cannot be proved by provenance alone.** Separate commits, separate PRs and separate authors are **evidence** of independence, never proof: a figure can be copied across files a week later, and nothing in the history distinguishes that from two people measuring the same thing.

So **⚠️ Unverified is the default for a clean result**, and ✅ Verified requires positive evidence that the renderings could not have been copied — a derivation from the underlying object, a measurement re-run at the source, or an author statement of method. Absence of a copying signal is not that evidence.

**A clean result on a dependent pair is a false negative, and must not be reported as a pass.** Dependence threatens the **clean** result. A disagreement between dependent renderings is still a finding: they were supposed to agree by construction and do not, which means a repair touched one and not the other.

### Resolution — the diff establishes divergence, not truth

A symmetric diff with no authority tells you the renderings disagree. **It cannot tell you which one is right**, and nothing about the procedure entitles it to.

- **Never resolve by counting renderings.** Two renderings that agree are **one rendering** if they are dependent, so a majority can be a single source copied twice. Repairing the minority to match the majority without establishing independence is the dependent-pair false negative committed deliberately, by the instrument built to catch it.
- **Derive the value from the thing that is not a rendering** — the code, the constant, the fixture, the computation, the object itself. Publish the derivation so it can be re-run. Ground truth lives there, not in the prose.
- **Where no such source exists**, the finding stands as a divergence and the resolution is escalated to the artifact owners. A guess dressed as a repair is worse than an open finding.
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
