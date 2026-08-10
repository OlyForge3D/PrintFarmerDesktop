---
name: test-discipline
description: What counts as an acceptable test change in PrintFarmer Desktop. Read before modifying, moving, or deleting any test, and before claiming a change is covered.
---

# Test discipline

## A comment claiming derivation is a testable claim, and only a counterfactual proves it

A comment that says a value **derives itself** once some capability appears is a claim about a counterfactual — what happens when that capability is granted — not about the value's current, capability-absent contents. Asserting only the current state (`the array is empty`, `the handler refuses`) cannot distinguish a genuinely derived `[]` from a hard-coded `[]`: both produce identical output while the capability is absent, and no assertion over that state tells them apart.

This is not hypothetical. Issue #270: `src/main/calibrationService.ts` replaced a hard-coded `[]` with a value advertised as derived from transport capability, with a comment promising both the advertiser and the executor would "switch on by themselves" once the capability appeared. Typecheck was clean, lint was clean, and every existing test was green — because every one of them asserted the capability-absent state, which a hard-coded literal satisfies exactly as well as a derivation does. The seam was inert: `useDefineForClassFields` (this project's ES2022 target) makes an optional class field emit an own `undefined` property on every instance, which shadows whatever a caller assigns to the prototype afterward, so the "derived" value could never actually turn on. **The fix was self-concealing in a way the hard-coded literal it replaced was not** — a stale literal is at least honest about being a literal.

So: when you replace a literal with a derivation, or write a comment claiming a value activates itself once some condition holds, add a test **in the same commit** that:

1. actually grants the capability/condition at runtime (patch the prototype, flip the flag, supply the dependency — whatever the comment says triggers the derivation), and
2. asserts the derived behavior **changes** as a result, at every site the comment claims will change together.

`tests/calibration.availability-negotiation.test.ts`'s `'the refusal is derived from the absent capability, not asserted'` block is the pattern to copy: it patches `SidecarCalibrationAdapter.prototype.resolveCalibrationConflict` at runtime and requires both `conflictResolutionsFor` and the resolve IPC handler to switch on together, restoring the prototype afterward so later tests are not left measuring an adapter that no longer exists in production. It also caught a _second_ hard-coded refusal the author's own comment claimed was derived — the counterfactual test does not just confirm the one site you were thinking about.

When you cannot state which instrument would notice if the derivation were inert, say so plainly in the PR body. If the answer is "none," per issue #270's own conclusion, the change is not ready. `scripts/check-inert-class-field-seams.mjs` (`npm run check:inert-class-field-seams`, wired into `ci.yml`) catches the specific `useDefineForClassFields` shape of this defect mechanically; it cannot catch every way a derivation claim can be untested, which is why the counterfactual-test requirement above is the durable rule and the script is only one instrument for one recurring shape of it.

## Never weaken a test to make it pass

Do not skip, delete, `#[ignore]`, loosen an assertion, or widen a tolerance to get green. If a test fails, either the production code is wrong or the test encodes a stale contract — establish which, and say which in the PR body.

A stale test is a legitimate finding, but you must prove it. When PR #62 failed, the test asserted a macOS temp alias (`/var/...`) while the service correctly `realpath()`-canonicalized to `/private/var/...`. The test was wrong — but that conclusion came from reading the service, not from the test being inconvenient.

## Announce moved tests before a reviewer finds them

A diff showing `-140` lines in a test file looks like deleted coverage. If you moved tests, say so explicitly in the PR body: which tests, to which file, and whether assertions changed. Dallas did this proactively on PR #68 and it saved a review round.

Silent test deletion is the single fastest way to lose reviewer trust.

## Test the boundary from both sides

Every limit, threshold, or cap needs **both**:

- a just-under case that **passes**, and
- a just-over case that **is rejected with the specific diagnostic**.

The passing side is not optional. A cap that degrades into blanket rejection is an availability bug wearing a security hat — a ZIP64 entry ceiling that rejects _all_ ZIP64 archives "passes" every rejection test while breaking every large legitimate package.

Prove the passing side at the **documented legitimate maximum**, not at a comfortable value. Reviewing PR #68's 20,000-row part-tree budget, the check that carried weight was rendering a legitimate 5,001-object scene (at the sidecar's documented 5,000 mesh-object ceiling) and asserting it produced 5,001 rows with no truncation notice. "A small scene renders" would not have shown that the cap leaves headroom above real input.

Also pin the boundary _adjacently_. A far-under case does not constrain the comparison operator: testing `MAX + 50` rejects and `5,000` passes leaves an off-by-one at `MAX` undetected. One of the two cases must sit next to the limit.

## Check the predicate answers the question you asked

Before trusting any matching or ancestry check in a test or assertion,
check it against `.squad/known-lying-commands.md`. A predicate can return a
confident, well-formed answer to a neighbouring question — PowerShell
`.Contains()` doing element-equality on a `--jq` array, `git branch -a
--contains` proving reachability instead of tip-ness — with nothing in the
output to tell you it happened.

## Assert the specific failure, not merely that something failed

`assert!(result.is_err())` passes when an unrelated earlier failure occurs, so it can pass while the control you meant to test never runs. Assert the exact diagnostic code (`threemf.limit.compression_ratio`), not just the presence of an error.

**Necessary, but not sufficient: the diagnostic must be _unique_ to the control.** If two guards emit the same code, asserting it cannot tell you which one fired. On PR #69 both `check_declared_archive_total` and `charge_decompressed` emitted `limit.total_decompressed_bytes`, so a test that asserted the code exactly still could not distinguish them — and the accumulator turned out to be the one never exercised. When two controls must share a code, the test has to make one of them structurally impossible instead (see below).

## Verify your control is reachable at all

A security control that cannot be reached is untested no matter how many tests surround it. Ask what input actually drives each guard, and whether any test truly produces it. Two instances of this, both on PR #69:

- The archive entry ceiling was structurally unreachable — a 16-bit ZIP EOCD caps at 65535 entries, below `MAX_ARCHIVE_PARTS` — so it was only exercisable by forging a ZIP64 trailer.
- The running decompression accumulator could never fire for an **honest** archive: the declared-total preflight sums _every_ entry while the accumulator counts only entries actually _read_, so declared >= charged and the preflight always wins the race. The accumulator fires only when an entry **lies** — declares small, delivers large — which is exactly the case it exists for, since declared sizes are attacker-controlled.

  That second one rests on a precondition worth naming, because deleting one line would silently invalidate it: **no entry may be read twice.** The charge per entry is `max(declared, actual)`, so a part read twice is charged twice and `charged` can exceed `declared_total` on a perfectly honest archive — which would make the accumulator reachable on honest input and this whole analysis wrong. Today it holds because `referenced_parts.remove(&root_part_key)` removes the root model part from `referenced_parts` before the second pass (`threemf.rs:635` as of `8c0b4ba` — grep the expression, not the line; it has moved twice already), and because the relationship parts are distinct by construction (`_rels/.rels` vs `3D/_rels/3dmodel.model.rels`), `[Content_Types].xml` is read once, and `Metadata/model_settings.config` is read once, at the single production call site of `read_plate_layout`. Only the first is a deliberate guard; the other three hold by accident of structure, which makes them the easier ones to break. When you record a structural argument, record everything it depends on — not just the part that looks like a control, and not just the dependencies that existed when you wrote it. That last one is not hypothetical: the `model_settings.config` read landed on `development` two hours after this paragraph did, and it charges both of the counters the analysis turns on. And cite the guard by something greppable: this line said `threemf.rs:560` for eighty minutes on `development` before the merge of the PR it was describing falsified it, leaving a security precondition pointing at unrelated code. Not a day — eighty minutes, which is inside a single review round.

The general shape: **when two guards defend the same budget, the cheaper one usually shadows the stricter one on all honest input.** The stricter guard is then live, correct, and untested. Reaching it requires constructing input that is dishonest in precisely the way the shadowing guard trusts — and the test must _prove_ the shadowing guard could not have fired, by asserting its own threshold was never crossed. A test where both guards could plausibly have rejected proves nothing about either.

## Build corpora from properties, not spellings

A corpus assembled from example strings tests the examples, not the rule. The non-finite float corpus used `["NaN", "inf", "-inf", "Infinity", "-Infinity"]`; `1e999` contains none of those substrings yet `f32::from_str` returns `Ok(inf)`. Enforcement was correct — `is_finite()` — but nothing pinned it, so a regression to substring blocklisting would have passed the entire suite.

Include at least one case that satisfies the **property** while looking lexically ordinary: `1e999`, `1e39`, or a plain integer above `f32::MAX` (~3.4028235e38) such as `4e38` — the 3MF corpus uses a 42-digit literal. Specify such cases by **magnitude, not digit count**: `100000000000000000000000000000000000000` is 39 digits and parses to a perfectly finite `1e38`, so "a 39-digit integer" would pin nothing. Same reasoning applies to path traversal, injection, and unicode corpora — the dangerous input is the one that does not look like the examples.

## Cover the shapes an attacker picks, not the shapes you drew

For anything walking attacker-supplied structure (scene graphs, archives, XML), a single benign fixture proves almost nothing. Cover:

- cycles, and **duplicate / multi-parent references** (a diamond DAG is not a cycle and a path-local `seen` set will not catch it),
- deep chains (recursion depth), wide fan-out, and empty/missing/dangling references,
- hostile identifiers — `__proto__`, `constructor`, `prototype` as object IDs,
- structures whose _output_ size is superlinear in input size.

A 29-node diamond DAG expanded to 49,150 rows in `partTreeModel.ts` precisely because tests only covered an ancestor cycle. (The fixture's doc comment reports `2^15-1 = 32,767` paths through the `m` chain — summed over the chain, not the 16,384 distinct paths to its tail, and not the row total. Measured by rebuilding the fixture and walking it: 32,767 `m`-chain rows and 16,383 `s`-node rows.)

## Do not let a test pin a bug

If fixture-writing reveals behavior that contradicts the issue text, do not silently encode current behavior as correct. Two legitimate options: fix it, or pin it **and flag it explicitly** for the reviewer to rule on. Pinning without flagging converts an open question into a permanent contract by accident.

## A name is a claim, and it is the claim least likely to be audited

Names and comments are what the next reader greps for. They find a hit, conclude the risk is covered, and stop. So a name that overstates is worse than no name at all: it does not merely fail to help, it actively stops the search that would have found the gap.

That mechanism is an inference about how people read code, not something the repository can prove. What the repository does show is the pattern — three instances landed in one week, each wrong in the direction that ends the audit rather than the direction that trips it:

- `rejects_an_unbounded_appearance_table` measured the appearance _entry_ axis only. The structure had two axes, and the uncapped one — group count — sat behind a passing test aimed at exactly the right risk.
- A comment reading "instances beyond the cap are dropped" was true of the internal map and false of what the user sees: those instances fall through to plate 0. Anyone auditing "where does over-cap geometry end up?" would have read it and stopped.
- `malformed_colour_values_are_ignored_rather_than_fatal` asserted `Some([0,0,0])`. Its own message said "fall back rather than poison the scene" — but black _is_ a poisoned colour. The name described the intent; the assertion pinned the opposite.

Two checks, applied to the name rather than the code:

**Name the axis you varied, not the risk you had in mind.** A test aimed at the right risk still only measures the axis you thought to vary. "Is there a test for this risk?" is nearly as weak a question as "is there a test?" — both are answered by the name, and the name is what is wrong.

**When a name states a dichotomy, check whether a third option exists.** This one comes from a single case, but a sharp one. `a_malformed_appearance_index_is_reported_not_silently_dropped` encodes a choice between fatal and silently-dropped. The correct behaviour was neither: appearance explicitly absent, geometry preserved, diagnostic surfaced. A name that forecloses the right answer will actively resist the right fix, because changing the behaviour now means admitting the test was misnamed. The other two instances above are the axis problem, not this one — do not read them as three examples of the same trap.

Corollary for reviewers: read the assertion before the name. If they disagree, the name is the defect — and it is the half that propagates.

## A surviving mutation is not a finding until the mutation is shown to bite

Mutation testing is how coverage claims get earned here, and its report has a silent failure mode. A mutation that stays green has two causes and **they are indistinguishable from the outside**: the test is weak (a finding), or the mutation never changed behaviour at all — dead value, overwritten, unreached path (a fact about the _code_, not the test, and not a finding).

**So do not report a mutation as _survived_ until you have shown it changes behaviour.** Either it goes red under _some_ test, or you demonstrate the mutated line is reached and its value observed (a temporary throw or log at the mutation site). If nothing anywhere goes red, the mutated code may be dead, and that is the finding to report instead. A mutation you cannot show to bite is reported as **ineffective**, in those words, and is not evidence about any test.

This matters because **the ambiguity fails in the direction that reads as diligence.** An ineffective mutation reported as a surviving one becomes a finding — it lands in a PR body, gets quoted in review, and generates work hardening an assertion that was never weak. Nobody audits a finding.

On PR #169, mutating the _initial_ correlation lookup in `src/main/ipc.ts` to mint a fresh ID stayed green, which looks exactly like a weak stability assertion. It was not: the success path reassigns `correlationId` from a second `resolveOrBeginWithOrigin` over the attempt binding after the response arrives, so the minted value was never observed. The mutation that bites replaces the post-response resolution.

**The mitigation is not "look twice" — it is "cheap enough to look twice."** That one was caught only because the loop was a sub-second single-file vitest run. Mutation testing degrades silently as the feedback loop slows, and it degrades _toward producing findings_: a slow loop does not stop emitting mutation reports, it emits surviving-mutation reports, which are the ones that get acted on. Treat iteration cost as part of the practice, not a convenience. See #188.

### Pin both the mutation and the tested population

A blob SHA is sufficient only for a local claim whose complete scope is that blob's content. If the current blob equals the recorded blob, that local analysis can be reused. If it differs, re-verify; inequality says only that the input changed, not whether the conclusion is now true or false.

A universal claim such as _"this mutation survives the full relevant suite"_ also depends on which tests were eligible to run. **Pinning members does not pin membership.** Record the Git tree SHA for every search or test root, plus the exact enumeration predicate or command. For example, `git rev-parse <commit>:tests` pins the complete `tests/` population. Its tree identity changes when any descendant is added, deleted, renamed, or modified. A different tree makes the survival claim stale and requires a rerun.

Also record the observed commit and the mutation target's blob SHA. A survival claim is current only while both the target identity and every population-tree identity still match. Either mismatch triggers re-verification; neither is evidence for or against survival.

Use this compact record:

```text
Observed: <commit> at <UTC time>
Mutation target: <path> at <commit>; blob <blob SHA>
Population (repeat per root): <root>; tree <tree SHA> (`git rev-parse <commit>:<root>`)
Enumeration: <exact predicate/command> => <count> tests
Test command: <exact command>
Application/non-vacuity: <proof the mutation applied and changed observable behaviour>
Outcome: <killed | survived | ineffective, with the observed result>
```

## When a fix removes a symptom, verify the mechanism, not the symptom

Some failures produce a clean-looking result _as their symptom_. When the fault is in the mock, the query, or the identifier, and it renders as an ordinary empty or passing result, **there is no independent detector** — the bad input and the misread output are one event, so nothing disagrees with anything.

A `vi.mock('node:os', …)` on PR #169 returned `{ ...patched, default: actual }`. The consumer, `src/main/retargetArtifacts.ts`, imports the **default** export, so the override was never in effect and **the mock did nothing**. It passed all seven required contexts, because the symptom it suppressed — a race that needs a stale instance directory present — did not fire that run. The symptom was verified absent; the mechanism was never verified present. `tests/calibrationRedaction.test.ts` now returns `{ ...patched, default: patched }`.

So when a change works by making a symptom go away, **assert the mechanism is in place as a distinct assertion from the behaviour under test** — for a mock, that the consumer observes the patched value. The deliberate version of this is PR #169's mutation 11: bypassing `safeOpaqueRevision` at the emitter while leaving the helper intact, because testing the helper alone passes even if the builder never calls it.

Same shape outside tests: an identifier reconstructed by hand instead of copied from the tool that emitted it returns an empty result, and empty reads as a fact about the world rather than a fault in the query. See `.squad/decisions/inbox/hicks-empty-query-results.md`, and #188 for both rules together.

The same structure governs arguments, in review comments and briefs as much as in code: a conclusion can be true while the mechanism attached to it is false, and the conclusion's truth is what stops anyone checking the mechanism. When you refute a claim of the form _X because Y_, say separately whether X survives Y's failure — the next reader acts on the half that carries a citation, and that half is Y. See `.squad/decisions/inbox/bishop-mutation-effectiveness.md`, #186 and #239.

## Mocks hide missing production code

Downstream tests that mock the sidecar stayed green while the entire native retarget engine was missing from `development`. If a test mocks the thing it is nominally validating, it cannot detect that the thing is gone. At least one test per integration boundary must exercise the real implementation.

## Fixtures

- Author them yourself, programmatically, from raw format primitives. Never commit vendor or third-party model data — it must be redistributable.
- Build them with a **test-local builder that shares no code with the parser under test**, otherwise a bug cancels itself out on both sides.
- Record `sha256`, byte length, provenance, and expected outcome in a manifest, and verify committed bytes match.
- Fixtures are consumed by CI on Windows and macOS/Linux: make generation deterministic and ensure binary fixtures cannot be mangled by line-ending translation.
