<!-- Fact Checker's append-only evidence ledger. Entries are succinct — verdict + citation only, no raw source material. -->

## 2026-07-23: Squad Initialization

- **Checked:** n/a — initialization only, no claims to verify.
- **Verdict:** n/a

## 2026-08-03: First run of the Cross-Artifact Symmetric Diff (#121)

Five runs of the symmetric diff introduced in `.squad/fact-checker/policy.md` → **Cross-Artifact Symmetric Diff**. Runs A–C are re-runs at historical heads, to show the corrected check fires in both directions where the one-directional form fired in only one. Runs D–E were first run at `fc9799fab84f7a1ee2acb1cb919af8195d926a8b` and **re-run at `a0f3eee`** after `development` moved; both findings hold unchanged, and `tests/viewer.partTree.test.tsx` and `src/renderer/library/partTreeModel.ts` are byte-identical across the two bases, so the derivation below did not need re-deriving — it was re-run anyway. Full transcripts are in the PR that closes #121; entries here are verdict + citation per this file's succinctness rule.

**On the commits cited below.** `2d5f47e`, `65345ba`, `dc034d8` and `a08de19` are **not on `development`** — they are commits on branches whose content reached the mainline by squash merge, so they are reachable as objects but appear in no mainline ancestry. That is harmless for runs A–C, which are declared replays at named historical heads and were re-run there. It is **not** harmless for reasoning about precedence: assuming a cited SHA sits on the mainline is precisely what produced the false inference corrected under _D-provenance_ below. Byte-identity across the two bases was confirmed by comparing **blob OIDs**, not by an empty `git diff`.

- **A — sidecar mesh-object ceiling, at `2d5f47e`.** `.squad/decisions.md` renders the documented ceiling as `5,001`; `.squad/skills/test-discipline/SKILL.md` renders it as `5,000`. **Verdict: ❌ Contradicted, against the pair.** The decision log is the wrong rendering, which is the direction the one-directional form could not reach.
- **B — diamond-DAG row count, at `a08de19`.** `.squad/decisions.md` carries `49,150`; `.squad/skills/test-discipline/SKILL.md` carries `32,767`. **Verdict: ❌ Contradicted, against the pair.** Closed for that pair by `dc034d8`.
- **C — sidecar mesh-object ceiling, at `65345ba`.** The two renderings agree, and both are wrong. `65345ba` is one commit writing both files, so the pair is **dependent** and the clean result is a false negative. **Verdict: ⚠️ Unverified — not ✅.** Dependence measured in `.squad/decisions.md` → _2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found_.
- **D — diamond-DAG row count, at `fc9799f`. Live finding.** Four renderings, not two: `.squad/decisions.md` and `.squad/skills/test-discipline/SKILL.md` carry `49,150`; the fixture doc comment in `tests/viewer.partTree.test.tsx` carries `2^15-1 = 32,767` for a named sub-quantity; `docs/security/THREAT_MODEL.md` § _T2.2 — Structurally valid input that reaches an untested code path (A1)_ carried `32,767 rows` as the **total**. `dc034d8` repaired one rendering and left the threat model. **Verdict: ❌ Contradicted, against the set.**
- **D-resolution — settled by measuring the object, not by counting renderings and not by arithmetic.** The two agreeing `49,150`s are **dependent**: per `.squad/decisions.md` → _2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found_, the figure is shared between the two documents because the repair wrote it into the skills file, and that entry's own extraction rule counts it as a shared numeric token. **That summary is mine, not the log's wording** — cite the heading and read the entry, rather than grepping for this sentence. By this policy's own rule their agreement grades ⚠️ and never ✅, so the two-against-one shape could not have decided this and was not allowed to. Resolution came from the fixture: `diamondDag(14)` was rebuilt as `tests/viewer.partTree.test.tsx` defines it and walked with a path-local `seen` set — the pre-fix behaviour the figure describes — and the populations were **measured separately**, not inferred by subtracting one reported figure from another. Measured: **29 objects; 49,150 rows total; 32,767 rows emitted for `m` nodes; 16,383 for `s` nodes; 16,384 distinct paths to the tail.** `2^15-1 = 32,767` is paths through the `m` chain _summed over the chain_, and it is not the total. The threat model's sentence claims the **total**, so this is a units mislabel and not merely a stale number; both readings were tested before repairing, because a symmetric diff cannot tell them apart. **How the mislabel came about is not established and is not asserted** — and nothing needs it: at `b715126`'s own tree the fixture comment in `tests/viewer.partTree.test.tsx` already attached the word _rows_ to `32,767` (`// Was 32,767+ rows when the cycle guard was path-local.`), so no conflation need be posited to explain the copy. That is a fact about the tree; it is offered as a negative and no replacement mechanism is offered in its place. Derivation published as a file, `scripts/measure-diamond-dag.mjs`, not only in the PR body. **Repaired there.**
- **D-method note — the harness was not the object.** `.squad/decisions.md` already recorded this decomposition _and_ a method that established it. That is worth citing and it was not cited; **it is not an authority**, and treating it as one would reinstate the one-directional defect this change removes — the recorded method has to be re-run like any other. **And the harness was not the object either.** A model of the pre-fix walk is a fourth rendering of the behaviour, not the behaviour — three agreeing implementations would still be three renderings. What settles the value is the shipped pre-fix `flattenPartTree` at **`741459dee50af3a0dd387253cfbf8b9ddc71315f`**, retrieved and read: one `rows.push` per visit, `const nextSeen = new Set(seen).add(objectId)` for a path-local guard, and no `MAX_PART_TREE_ROWS` in that revision — so rows are visits, uncapped. **The discriminator behind _one row per visit_ is now recorded rather than only concluded**, because an earlier version of this entry stated the conclusion without it. There are **three** `rows.push` sites in that revision, at `:107`, `:134` and `:176`. Two of them are inside `pushObject` and are mutually exclusive per invocation — the cycle-hit branch at `:107` is followed by `return` at `:126`, so a visit emits the invalid row **or** the normal row at `:134`, never both. The third, `:176`, emits a **plate** row and sits outside the object walk entirely; the fixture calls `flatten({ objects, rootObjectIds, plates: [] })`, so it never fires and the object walk is the whole row count. `MAX_PART_TREE_ROWS` appears **0** times at `741459de` and **4** times at the fix `1c80bdb381`. Every one of those is a `git grep` against a blob, not a reading of anyone's description of the code. That commit is reachable from **zero branches and that is structural rather than accidental** — it is a pre-squash commit of PR #68, and the squash merge `5eef0d7` landed the _final_ state, so the pre-fix revision reached the mainline in no commit at all. **It is not unreachable.** GitHub serves `refs/pull/68/head`, which resolves to the fix commit `1c80bdb381`, and `git merge-base --is-ancestor 741459de FETCH_HEAD` exits **0** after `git fetch origin refs/pull/68/head`. **An earlier version of this sentence said the commit was _"on no ref"_, which is false and was measured false here**; it was written from how the commit had been recovered (`gh pr view 68 --json commits`) rather than from a reachability query, which is the same defect as citing a figure from the nearest copy. Any claim about reachability made with `git branch --contains` is a claim about **branches**, and the ref that reaches this object is not one — see run J. **This is a Discharge, not a ✅.** It establishes what the value is; it says nothing about whether `.squad/decisions.md` and `.squad/skills/test-discipline/SKILL.md` were written independently — they could both be copies and both be right. Recorded here because it was very nearly written into `policy.md` as the worked example of ✅, which would have been the grade-inflation this file predicts. Found by the reviewer of the PR closing #121; verified here independently at the object. The harness is retained as `scripts/measure-diamond-dag.mjs`, which reproduces all five figures and names `741459de` as the authority it models. Related: `32,767 + 16,383 = 49,150` is **consistent with** the decomposition and evidence for nothing — it holds for any residue differing by 16,383 — so it is not offered as the derivation anywhere in this change.
- **D-imprecision — RETRACTED. This run produced a false finding against the decision log, and measurement is what withdrew it.** The earlier version of this entry reported `.squad/decisions.md`'s phrase _"paths through the `m` chain alone"_ as naming **neither** 32,767 nor 16,384 cleanly, and referred a wording correction to the Scribe. **That finding is wrong and the referral is withdrawn. `.squad/decisions.md` is correct as written and needs no repair.** Two measurements settle it, both re-runnable against `tests/viewer.partTree.test.tsx`. First, distinct root-to-node paths ending at an `m`-chain node = **32,767**, exactly the `m`-chain row count — not a coincidence but an identity, since under a path-local `seen` set every emitted row _is_ a distinct root-to-node path, which is the explosion the fixture exists to demonstrate. So `32,767` is a row count **and** a path count, and "paths" is not a wrong noun. Second, the rival reading offered against it — 16,384 paths to the tail — is defeated by the phrase's own next word: of those 16,384 paths, **16,383 traverse an `s` node** and exactly **one** stays in the `m` chain _alone_. The qualifier does not survive the rival reading, so the rival reading was the reporter's and not the source's. **The defect was in the method, not in the log**: a rival reading was proposed on the strength of another true quantity existing in the same fixture, without testing it against the rest of the sentence — the exact discriminator this same batch applied correctly to `docs/security/THREAT_MODEL.md`, whose sentence says _"expanded to 32,767 **rows**"_ and so claims the total. Applied to the threat model it convicts; applied to the log it exonerates; it was applied to only one of them. Now written into the policy's Resolution rules as a standing requirement. **Nothing downstream changes**: run D's finding stands, because the threat model claimed the total and the total is 49,150. **And there is no residue.** It was subsequently observed that `.squad/decisions.md` is now the only artifact still carrying the phrase without a disambiguating clause, and offered as a loose end. It is not one: that observation presupposes the finding retracted above. The phrase is correct as written, so carrying it unqualified is not a defect and adding a clause there would be an edit made to match this run's other edits rather than to fix anything. The disambiguations added to `docs/security/THREAT_MODEL.md` and `.squad/skills/test-discipline/SKILL.md` were needed because those two sentences said **rows**; the log's does not.
- **D-retraction, second part — a convergence was claimed and was neither independent nor true.** The retracted finding above was additionally supported here by reporting that a second session had reached it by a different route, with no harness and no walk. It was offered as the kind of independent convergence `.squad/decisions.md` → _2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found_ asks for. **Both halves fail.** The conclusion was false, as measured above; and the second route had consumed this run's figures **by direct reading**, which its own author disclosed — so it was a dependent rendering with the dependency living in prose rather than in a commit, which is harder to see and no different in kind. It was very nearly installed in `policy.md` as the worked example discharging ✅. Recorded because the near-miss is the instructive part: **a well-argued report is a rendering.** Agreement between two accounts of a measurement is not agreement between two measurements, and the grade it earns is ⚠️ by the same rule as any other dependent pair.
- **D-provenance — CORRECTED. The original inference here was false, and it was the kind this PR exists to prevent.** The entry first read: `b715126` introduced the threat model's `32,767` at `2026-07-25 16:24:35 -0700`, **45m after** `a08de19` (`15:39:52`) had published the correct diagnosis — offered as a figure re-rendered after its correction was on the record. **Every fact in that sentence is true and the inference from it is false.** `a08de19` is **not an ancestor of** `b715126` (`git merge-base --is-ancestor` exits 1 in both directions; their merge-base is `ecb2ee5`, ~4h earlier), and `a08de19` is **not on `development` at all**. At 16:24:35 the correction existed only on a divergent branch, so the sentence's implication that it was available to be missed is unsupported by anything in the history. The correcting text first reaches `development` in `6aec3ef` (`18:20:56`) — **1h56m21s _after_** `b715126`, the opposite order — and by content rather than by ancestry, since `a08de19` is not an ancestor of `6aec3ef` either; the merge squashed it. That is `.squad/decisions.md`'s _accurate outcome with a plausible mechanism attached_, committed in the evidence ledger of a change against doing exactly that. Found by the reviewer of the PR closing #121, who ran ancestry after the timestamps had already been confirmed genuine; verified here at the objects.
- **D-provenance, as it now stands — established by ancestry and by tree, with no assumption about what anyone could see.** `f1e1bb0` (`2026-07-25 11:38:08 -0700`, on `development`) introduced into `.squad/decisions.md` the process note recording the #68 round-2 before/after table, which states _a 29-object diamond DAG at 49,150 rows_. **`f1e1bb0` is an ancestor of `b715126`** (`--is-ancestor` exits 0), and the line is present in `b715126`'s own parent tree `e9568bd`. So when `32,767 rows` was written into the threat model for a 29-node diamond DAG, **the correct total for that same fixture was already in the tree the commit was written against** — a gap of **4h46m27s**, in-tree, on the mainline, provable by ancestry. Generalised into the procedure step _Establish precedence by ancestry, not by timestamps_, alongside the enumeration rule it originally motivated: **corrections do not propagate to renderings that do not yet exist**, so the repair question is which renderings _exist_, not which ones disagree. The staleness verdict never rested on provenance — it was settled by the measurement and by the threat model's own sentence claiming the **total** — so nothing in run D moves.
- **E — part-tree row budget, at `fc9799f`, re-run at `a0f3eee`. Negative control.** **Four** renderings agree at `20,000`: `src/renderer/library/partTreeModel.ts` (`MAX_PART_TREE_ROWS`, introduced `5eef0d7`, #68), `docs/scene-contract.md` (introduced `ecb2ee5`, #77), `.squad/decisions.md` (introduced `f1e1bb0`, #76), and `.squad/skills/test-discipline/SKILL.md` (introduced `f1e1bb0`, #76). **The fourth was missing from this entry until a reviewer enumerated it, and the correction is recorded here rather than folded silently into the count** — see _Enumeration correction_ below. **Grade: ⚠️ Unverified. Resolution: settled at the object — every rendering conforms to `MAX_PART_TREE_ROWS = 20_000`.** The two lines are recorded separately because they answer different questions. The value is as well established as anything in this batch: the constant is what the code enforces, so for this quantity the source **is** the object, and each document was read against it and conforms. Re-runnable by anyone: read the constant, grep the renderings. But the **grade** asks whether the documents were written independently, and at complete enumeration the set is four renderings across **three** commits, not three across three: `f1e1bb0` introduced the `.squad/decisions.md` and `.squad/skills/test-discipline/SKILL.md` renderings **in one act**, and the two sentences share some thirty words including a parenthetical. For that pair independence is not inconclusive, it is **refuted** — and commit-distinctness, which is what the original three-commit tally measured, is exactly the evidence the fourth rendering removes. `docs/scene-contract.md` states the budget as _"four times the 5,000-object sidecar cap"_, which is consistent with having been written from the constant and equally consistent with having been written from another document. No author statement of method is on the record, so ⚠️ is the honest grade **even though nothing here is in doubt**. This run has now been graded three ways across the review of #121 — ⚠️, then ✅ on conformance to the object, now ⚠️ with the conformance recorded as resolution — and the middle grade is the error the two-axis split exists to prevent: a good result with nowhere honest to record it gets recorded in the grade. The run also discharges its control purpose: **the check came back clean on a legitimate set, so it is a detector and not blanket denial**, with run D as the discriminating control — same instrument, same head, same trees, returns a disagreement.
- **Slot note** (procedure — _Establish the slot before treating a difference as a defect_). `docs/scene-contract.md` also carries `20,000` as a _triangle_ threshold for proxy substitution. Same token, different slot; excluded from run E rather than counted as a further agreeing rendering. (It would be the **fifth** rendering of the token, not the fourth — the fourth is `.squad/skills/test-discipline/SKILL.md`, enumerated late; see _Enumeration correction_.)
- **Harness divergence — the model contradicted the property its own header named, and the acyclic fixture could never have shown it.** Raised by the reviewer of this PR, who checked `scripts/measure-diamond-dag.mjs` against the `741459de` blob rather than against its header, and verified here at both. At `741459de` the `seen.has(objectId)` branch **pushes an `invalid: true` row** and only then returns, so a cycle hit is still a visit and still emits a row — which the harness header states as item 1. The walk did not model it: it skipped the revisit and emitted nothing. **Every figure was nonetheless correct**, because `diamondDag(14)` is acyclic and the branch never fires — so agreement between the model and the blob was evidence about the **path-local** guard and no evidence whatever about the **cycle** guard, while reading as though it covered both. Repaired by counting the row before the guard, mirroring `rows.push` then `return`; all seven figures are unchanged, which is the point. **A control now exercises the branch:** a three-cycle emits **4** rows at `741459de` and **3** under the old walk, so reverting the fix fails the run — verified by doing exactly that, which exits non-zero on `control: 3-cycle emits row: 3 (expected 4)`. Two things worth keeping. **A model can agree with its object on every published figure and still model something else**, when the inputs never reach the disagreement; the fixture that produced the finding is not automatically a fixture that tests the model. And **the header is what made this catchable** — naming the blob and listing the properties claimed is what let a reader check the model against its object instead of against its own description, and it worked against the file's author, which is the only real test of a disclosure.

and it was not scoped that way.** Raised by a reviewer. The route as written read _"a statement of method from an author"_ and _"from the author of a rendering"_, neither of which excludes one agent certifying, on another agent's behalf, how that agent's artifact was established. **Nothing licenses that**, and the gap needed no new rule to close: an account of how someone else's artifact came to be written is a **reconstruction of their process**, and this policy already holds that a reconstruction is not the thing reconstructed. Offered as evidence of independence it is hearsay with a grade attached — the same fail-open shape as derivation-counting-as-✅, one step removed. Scoped in both renderings in `.squad/fact-checker/policy.md` and both mirrored renderings in `.squad/decisions/inbox/fact-checker-symmetric-diff.md`; enumerated with `git grep -nE "statement of method|testimony|testifying|from an author|author of a rendering"` across `.squad`, `docs` and `scripts` **at `ed12593`**, which returns nine hits in four files. **The head is part of the result and this entry first omitted it** — a step 4 violation in the ledger of the change that adds step 4. The same pattern returns **one** hit at `development` `6b14c02`, because eight of the nine are this branch's own additions; a bare "nine hits" is therefore unreproducible. **Read in full, they are not nine renderings.** `.squad/decisions.md:366` **at `ed12593`** is a **false positive** — the pattern matches _"from an author"_ inside _"read from an authoritative source"_, a sentence about a session identifier with nothing to do with this route. Of the rest, four were the renderings repaired here, two are ordinary uses that assert nothing about who may testify, and one is this entry quoting the old wording. **A third live rendering was in this file's own _Note on ✅_ and was caught only by re-running the enumeration after editing** — the pattern this trail keeps recording, committed once more by the person who wrote the rule against it, and caught by the practice of reading every hit rather than counting them.

- **F — two renderings of this PR's own branch, and neither party was reading the other's. Run at `f525bc1`.** For four consecutive review rounds the blockers reported against this change were pinned to `e78cb51`, `57d56fa`, `f13ff07` and `c388366`. **None of those is in this PR.** `gh api repos/OlyForge3D/PrintFarmerDesktop/pulls/162/commits` lists fourteen commits (**unpaginated, and therefore an unsound warrant — see run W**) and no one of those four appears; after fetching the objects, `git branch -r --contains` returns empty for each. They do resolve on the remote, which is why they look like ordinary pins. **Each is the pre-rebase twin of a commit that is in the PR**, paired by identical first-line message and identical author date and separated only by committer date: `c388366`↔`c2361e4`, `f13ff07`↔`b65d0fb`, `57d56fa`↔`b4f48bf`, `e78cb51`↔`c283ea9`. They form a parallel chain — `c388366`'s parent is `f13ff07`, exactly as `c2361e4`'s parent is `b65d0fb`. **The reports were not careless; they were correct about the objects they named.** Measured here: at `c388366` the false-provenance claim has **three** renderings, in `.squad/decisions/inbox/fact-checker-symmetric-diff.md`, `.squad/fact-checker/audit-trail.md` and `.squad/fact-checker/policy.md` — precisely the three files reported. At `881d8cf`, two commits further along the branch that PR #162 actually contains, it falls to one, and it is one at this head. The same holds for the imprecision finding: reported as live, retracted at `ade8509`, which is likewise past the pin. **So both sides were measuring accurately and disagreeing anyway, because each treated its own rendering of the branch as the object.** That is the defect this whole change is about, arriving in the review of the change: **a symmetric diff with no authority is what surfaces it, and pinning to `gh pr view <n> --json headRefOid` read in the same call that posts is what prevents it** — a SHA that resolves is not thereby a SHA the pull request contains. Recorded as a run because it is a real pair, checked at the objects, with a disagreement found and attributed.

— the missed rendering was the one that argued against this run's own grade, and it is run C's configuration sitting undetected inside the negative control.** Raised by a reviewer running this policy's own procedure step _Enumerate every rendering, not two_ against this PR, and verified here at the objects: `git grep` for `20,000` across `.squad`, `docs` and `src` returns `.squad/skills/test-discipline/SKILL.md` carrying _"Reviewing PR #68's 20,000-row part-tree budget"_ — present at `fc9799f`, `a0f3eee` and at this branch's head, so not a timing artefact but an omission for the whole life of the run. **The value conforms** (`20,000` against `MAX_PART_TREE_ROWS = 20_000`), so nothing in the resolution moves. What failed is completeness, and it failed in the direction that flattered the result: the omitted rendering was introduced by `f1e1bb0`, **the same commit already named in this entry** for `.squad/decisions.md` — `f1e1bb0` touches exactly two files, and both sentences go 0 → 1 across `f1e1bb0^` → `f1e1bb0`. That is one commit writing two renderings of one quantity, which is **precisely run C** (_C — sidecar mesh-object ceiling, at `65345ba`_), recorded in this same trail as the case where a clean diff establishes nothing. A pair-wise-flavoured enumeration therefore admitted into a _negative control_ an undetected instance of the exact dependence the control's own batch exists to demonstrate. Two further points against interest: the file is **edited by this PR**, and it is the file the original live finding repaired — so this is the failure named in `.squad/fact-checker/policy.md` (procedure — _Enumerate every rendering, not two_): **"A pair-wise habit is how a third rendering survives a repair that fixed the other two."** It occurred inside the run certified on complete enumeration. And the correction reached this entry from outside, which is what the review step is for, not evidence that the step is optional. **One further fact, because it bears on whether publishing a search is a control:** the omission is visible in this PR's own published transcript. The command disclosed there for this run — `git grep -nE "20_000|20000|20,000" a0f3eee -- src/renderer/library/partTreeModel.ts docs/scene-contract.md .squad/decisions.md .squad/skills/test-discipline/SKILL.md` — **already names the fourth path and already returns the hit**; the table printed beneath its output lists three renderings. So the pattern was complete and auditable, and the count taken off it was still wrong. That is a distinct failure from paraphrase, penumbra and use-versus-mention: **the enumeration was right and the reading of its output was wrong**, which no choice of pattern can prevent and no reviewer can catch without re-running the command and re-reading the result against the prose.

its traversal rule came from prose, and that is a residual in an already-accepted resolution.** Raised by the #57 session against its own accepted retraction and verified here at the blob. The harness rebuilt `diamondDag(14)` from `tests/viewer.partTree.test.tsx` — that half is taken from the artifact. But **one row per visit, a path-local `seen`, and no row cap** were supplied from a _description_ of the pre-fix walk, not read out of it. Had the description been wrong, every figure would have been internally consistent, would have agreed with two other independently written walks, and would have measured the wrong thing. **The assumption held, but until the blob was read it held as a guess that happened to be right.** The general rule now in the policy: **a reconstruction and the thing reconstructed are not two renderings of one quantity**, so agreement among reconstructions built from one description cannot detect an error in that description. This is why three agreeing walks bought nothing and one `git grep` against `741459de` bought everything — and it is the cleanest available statement of what this whole change is about. Verified independently here: three `rows.push` sites, two mutually exclusive by the `return` at `:126` and the third a plate row the fixture never triggers (`plates: []`); `MAX_PART_TREE_ROWS` 0 at `741459de`, 4 at `1c80bdb381`. **`scripts/measure-diamond-dag.mjs` now states which of its inputs come from the fixture and which from the source**, so the boundary is visible to the next reader rather than reconstructable only by doing this again.

- **G — the staleness control, run against itself before it was endorsed. Grade ⚠️ / the control is sound for the case it names and silent for the larger one.** A reviewer's findings go void when the branch they were pinned to stops being reachable, and the proposed squad-wide control is `git merge-base --is-ancestor <last-reviewed-sha> <head>`: exit 0 means fast-forward and the pins survive, exit 1 means rewrite and every pin is void. Measured at `ed12593`: `c388366`, a pre-rebase twin of this branch, exits **1** — the rewrite is detected, and the instrument does what it claims. But `c2cb922` (three commits back) and `ade8509` (eight commits back) both exit **0**, while `.squad/fact-checker/policy.md` has a different blob at each of them than at the head, so every line pin into that file taken at either commit is already void and the control reports nothing. **It asks whether the branch was rewritten, not whether the pin is still true**, and ordinary commits on top move line numbers without rewriting anything. That is the same one-directional shape as the defect this PR was opened for: a conforming run returns clean at a moment when the failure the check exists to catch is present. The blob-level form discriminates all three cases — `git rev-parse <reviewed-sha>:<path>` against `git rev-parse <head>:<path>` reports `c2cb922` and `ade8509` stale and `ed12593` valid. Two further limits. **The first was published here wrong and is corrected: `--is-ancestor` exits `0` for ancestor, `1` for not-an-ancestor, and `128` when the object is absent** (`fatal: Not a valid commit name`) — three outcomes, not two. This entry first claimed the absent case also exits `1`, which would have made exit `1` ambiguous; it is not. **The real hazard is the opposite one and it is larger: a script keying on `exit !== 0` reports a rewrite that never happened**, turning an unfetched object into a false alarm — so branch on the three codes explicitly, or pre-check with `git cat-file -e <sha>^{commit}`. **The false figure was produced by the measuring instrument, not by the tool measured**: the reading was taken through a PowerShell pipeline ending in `Select-Object -First 1`, which terminated the pipeline early and left `$LASTEXITCODE` holding a value that was not the one under test. That is the harness-divergence defect recorded above, one layer up — **the check was sound and the apparatus reporting it was not** — and it was caught by a reader who re-ran the command rather than reading this entry. Second limit: the control is only as reachable as the object, which for a rewritten branch survives only until it is collected. Recorded because the instrument was about to be adopted on the strength of the arm that works.
- **✅ is unavailable for judgement claims, not merely hard to earn there.** Also from the #57 session. The grade presupposes a thing the renderings are renderings _of_; claims about artifacts have one, and judgements — whether a rollout order is right, whether a decomposition is honest, whether a criterion is checkable — do not. For that class the honest report is that ✅ is **unavailable**, stated rather than approximated, because the failure mode is a judgement dressed in the vocabulary of a measurement: a grade, a figure and a citation with nothing underneath them. Taken together with the fail-open correction, ✅ was doing three incompatible jobs — over-attainable on artifact claims through two routes that prove correctness rather than independence, and silently approximable on judgement claims with no terminus at all. Both ends are now closed in `.squad/fact-checker/policy.md` → _Grading_.
- **Class note — the defect this batch kept reproducing was never the measurement.** Across the review of the PR closing #121, three separate unmeasured causal sentences were written into these artifacts, one per round, and **none of them was ever removed by a later round — they accumulated.** Measured by grepping each commit on the branch: _"which is how that figure came to be written here as a row total"_ (`docs/security/THREAT_MODEL.md`) enters at `c283ea9` and is present at every commit through `881d8cf`; _"reaches for whichever copy is nearest"_ (`.squad/fact-checker/policy.md`) enters at `b4f48bf` and likewise persists; _"no ordinary means of seeing it"_ (this file) enters at `881d8cf`. All three were live simultaneously at `881d8cf`, and all three are removed in the same commit as this note. Reproduce with `git --no-pager grep -c <phrase> <sha> -- <path>` over the branch's commits. **A first draft of this note asserted instead that each round had removed one and introduced another; that was not measured, and the grep shows it is false** — which is the rule of this very note, broken while writing the note that states it, and left recorded rather than quietly fixed. Every one of these sentences sat beside a measurement that was never once challenged: the diamond-DAG figures survived three independent implementations, a re-derivation by a third session, and retrieval of the pre-fix source. **Every review round that raised a blocker raised it against the prose, and none raised one against the number.** Two structural causes, both properties of the sentences rather than of anyone's psychology: an unmeasured mechanism is **cheap**, since no query has to return anything for it to be written; and it is **load-bearing-looking**, since it makes a true finding read as explained, so deleting it feels like weakening the report. The remedy is now a Resolution rule with the constructions listed for grepping, and the standing form is: **report the divergence and the measurement, and where a mechanism matters, either measure it or say it is not established.** Recorded here rather than only in the review thread because this file is the durable artifact and the review thread is not — the same failure mode as publishing a harness only in a PR body. **And the class recurred once more after this note was written — caught by this policy's own step 2, and its shape is exactly what step 2 exists to catch.** The authority clause — _"it **is** an authority for that value"_ — was written into **three** artifacts at once: `.squad/fact-checker/policy.md`, this file, and `.squad/decisions/inbox/fact-checker-symmetric-diff.md`. It was then repaired **one artifact per round, as each was pointed at**: removed from this file at `881d8cf`, from `policy.md` at `063e4be`, and left standing in the inbox note through both — one directory from the rule forbidding it, in a file that already contradicted itself twenty lines later with _"as a reporting duty, not as an authority"_. Measured across the branch with `git --no-pager grep -c -E "_?is_? an authority" <sha> -- <path>`, as `audit-trail.md`/`policy.md`/inbox: `c283ea9` → 1/1/1; `b4f48bf` → 1/1/1; `881d8cf` → 0/1/1; `063e4be` → 0/0/1; `f886000` → 0/0/1.
  **Two renderings repaired and a third left is the discharge failure this batch's own rule exists to prevent, committed inside the change that adds the rule.** It was found by enumerating the word across the whole tree rather than the files a report named. **Two method notes belong with it.** First, a literal `git grep "is an authority"` returns **zero** at every commit above, because the emphasis markers in `_is_` sit inside the phrase — the first pass of this very note reported the clause absent on the strength of that false negative, and the count above is the re-run. **A grep that misses is indistinguishable from a defect that is absent.** Second, the same enumeration surfaced the word applied to the pre-fix implementation and to `MAX_PART_TREE_ROWS` — the objects, which are not renderings, so no one-directional check is created — but the word cannot be told apart from the forbidden sense by a reader or a grep, and both were reworded rather than left to collide with the rule. **Third, and it is the sharpest of the three: re-running the enumeration with a broader unit — every occurrence of `authorit`, read in full, rather than the clause alone — found two more sentences in `policy.md` that inherit the framing without restating it**, one applying the ambiguity discriminator "to the cited **authority**" and one scoping the log as the class's "**authority**" rather than as its object. Neither is the clause and neither would be caught by any pattern aimed at the clause. **The unit of enumeration is itself a judgement, and it decides the answer**: counted as renderings of the rule the set is small, counted as sentences that presuppose it the set is larger, and the tree is identical either way. So a published count is a **disclosure of what was searched for, not a control** — the completion test is that the false sentence is gone and so is every sentence inheriting from it, judged by reading at the head. A quantity like `49,150` enumerates exactly because it has a canonical form; a claim does not.
- **Note on ✅ — final, and it supersedes three earlier positions recorded in this entry. No run in this batch earns ✅.** The grade went from _positive evidence the renderings could not have been copied_ (judged unreachable), to _conformance to the object_ (which let a harness stand in for the object), to _a derivation terminating in a non-rendering artifact_ (which named the right instrument for the wrong grade). **The settled rule: ✅ grades whether the renderings were written independently, and only a first-person statement of method from the author of a rendering, about their own rendering, can speak to it — nobody can give it on that author's behalf (see B7).** Deriving the value from the object and re-running a measurement at the source are the strongest instruments this policy has, and they answer a different question — whether the value is **right**. Two renderings can be a copy of a copy and both be right, so those instruments would license ✅ on a pair the same policy proves dependent whenever the copied value happens to be true; being the cheapest, they are also the ones reached for. They now sit under **Discharge**. **The retrieval of `741459de` is the best demonstration of the distinction, not an example of ✅**: as strong as evidence about a value gets, and it still says nothing about who copied whom. Consequences, stated plainly: runs A and B are ❌ on their findings; run C is ⚠️ with no resolution; run D is ❌, resolved at `741459de`; run E is ⚠️, resolved at `MAX_PART_TREE_ROWS`. **The corrected check has fired five times and awarded ✅ zero times**, which is the grade being narrow rather than the check being broken. Recorded with its own history because the substitution is the point: the ✅-for-Discharge swap was made here, under attention, by someone auditing for exactly it, one message after being corrected on the same distinction. Raised by the reviewer of the PR closing #121.
- **H — runs D and E re-enumerated at the mainline head, after rebasing this branch from base `ccf61d1` onto `197e8e2`.** The base had moved; #163 landed **three new renderings** of the diamond-DAG family, in `.squad/decisions/inbox/ripley-false-outcome-invented-mechanism.md`, `.squad/decisions/inbox/ripley-falsifier-before-publishing.md` and `.squad/decisions/inbox/ripley-go-and-look.md`. **The count moved and the verdict did not.** All three conform at the object: paths ending at an `m` node equal `m`-chain rows at **32,767**, `16,384` is the path count to the tail specifically, and `32,767 + 16,383 = 49,150` matches the three populations `scripts/measure-diamond-dag.mjs` measures separately. **Run D's divergence is still live and still single** — `docs/security/THREAT_MODEL.md` renders `32,767` at `197e8e2` and is repaired only on this branch. **Run E's set is closed at four and unchanged**: the constant in `native/model-core/src/threemf.rs` plus three prose renderings of `5,000`, all conforming; the remaining `5_000` matches in the tree are unrelated quantities — a depth, a fan-out addend, triangle and vertex counts — which is the pattern-is-itself-a-rendering hazard returning in the negative direction. **This entry settles the open question about step 4 by measurement rather than by argument.** All three new renderings arrived on the **mainline** while this branch was behind, so an enumeration run at this branch's head would have returned the earlier set and reported it closed; _the current head_ was ambiguous between the branch and the mainline, and the ambiguity was load-bearing. Both procedure steps now say which one they mean. **Two further observations, both against this batch's own habits.** First, **the population grew on the correct side while the wrong rendering sat untouched**: six files now render the family consistently and one does not, and none of the three new notes discharged anything. **Rendering count is not a proxy for repair status**, and this is the concrete case for the rule forbidding resolution by majority — a majority can be manufactured by writing, and repair cannot. Second, **a use-versus-mention trap now sits in the base rather than in this ledger.** `ripley-false-outcome-invented-mechanism.md` renders _"32,767 is a row count and the path count is 16,384"_, which is false as a claim and is refuted two paragraphs later in the same file by the author who wrote it — that is what the file is for. A step-2 enumeration that counts hits instead of reading them files a false ❌ against `development`. That is the fifth instance of this failure mode recorded here and the first where the trap is in the artifact being checked rather than in this one. **Finally, two line-number citations into a mutable test file were introduced by the same merge** — `tests/viewer.partTree.test.tsx:678` and `:792`. **Both resolve correctly at `197e8e2`**: `:678` is `function diamondDag(levels: number): {` and `:792` is the quoted comment. They are recorded here as **accurate with a short half-life**, not as defects; this policy's anchor rule is about how long a citation stays true, and a true citation is not a finding.
- **I — the two candidate discriminators for mention-versus-use, measured before either was adopted.** Asked to settle a form so that _a retraction is not greppable as its own claim_, with fenced blocks proposed as the interim convention, this run measured that proposal against the markup already in the tree rather than adopting it. Harness: `scripts/measure-mention-filter.mjs`, run over seven files at mainline `5157903` and this branch's ledger **as it stood at `3b55c83`** — a revision two rebases have since orphaned, whose surviving copy on this branch is **`c010bad5`** (same `git patch-id --stable`, and `git rev-parse <rev>:.squad/fact-checker/audit-trail.md` returns the **same blob** at both, so the figure below re-derives at the reachable one) — pattern `49,150|32,767|16,383|16,384`, **67 occurrences**. **Candidate A — fenced blocks — suppressed 0 of 67.** Not because fencing fails but because **nothing is fenced**: the convention has no adoption to describe, so it is a request to re-edit every artifact that has ever quoted a figure, not an account of current practice. **And a partial rollout would be worse than none**, which is the finding rather than an objection to the effort: the moment anything trusts fencing, unfenced withdrawn text reads as a live claim **with more confidence than before**, converting a known ambiguity into a confident error. That is the same shape as the defect #121 was filed for — a check that returns a clean answer precisely where it cannot see. **Candidate B — the `_"…"_` span already used across `.squad/` and `docs/` to mark text belonging to another artifact — suppressed 6 of 67, and all six are genuine mentions.** Checked by hand and printed by the harness for checking by anyone: two quote `docs/security/THREAT_MODEL.md`'s wrong sentence, two quote claims their own paragraph withdraws, one quotes a test-file comment, and one is this ledger's run H entry quoting a retracted claim. **Precision on this set is 6/6, it needs no new convention, and it applies retroactively to everything already merged.** **Recall is unmeasured, and that asymmetry is the whole result.** A filter with high precision and unknown recall is safe as **triage** — it never removes a real rendering — but it **cannot license a count**, because the mentions it fails to catch remain in the total and nothing announces them. **Recall cannot be established without reading the hits the filter kept, which is the work the filter was supposed to save.** So the enumeration rule is unchanged and now has a measurement under it: **read the hits.** A filter narrows the reading; it does not replace it. **Recorded against this batch's own temptation**: candidate B is mine, it performed perfectly on the sample, and the sample is the one I chose — which is exactly the position from which a precision figure gets published as though it were an accuracy figure. **And one property of this entry has to be stated, because it is this batch's own subject turned on the entry itself.** Writing it **changed the population it reports**: the pattern quoted above is a rendering of all four figures, so committing this entry raises the ledger's own count by one per figure and the **67** is stale the instant it lands. That is why the figure is pinned to `3b55c83` rather than to _the ledger_, and why the harness reads a **revision** rather than the working tree — so the number can be re-derived at the moment it names instead of merely re-read at a later one. **A measurement of a population the measurer is inside cannot be reported without naming the moment it was taken**, and an enumeration recorded in a file that the enumeration searches is always that case.
- **J — the reachability of `741459de`, re-derived after a reviewer filed it as unreachable, and the finding runs in both directions.** The blocker: the ✅ note and now `scripts/measure-diamond-dag.mjs` defer verification to `741459de`, measured at **0 of 65 remote branches** with `ccf61d1` as a positive control at **23**. **The measurement is correct and I reproduced it.** The **inference** from it is not. `git branch --contains` searches **branches**; the ref that reaches this object is not one. `git ls-remote origin 'refs/pull/68/*'` returns `refs/pull/68/head -> 1c80bdb381`, and after `git fetch origin refs/pull/68/head` the query `git merge-base --is-ancestor 741459de FETCH_HEAD` exits **0**. **The object is durably reachable and GitHub serves it.** **The control is what makes this precise rather than a quibble.** `ccf61d1` returning 23 establishes that the instrument works **on branches**; it cannot establish that the search space contains everything that could satisfy the question, because both arms are branches. **So a positive control confirms sensitivity within the space searched and is silent about the boundary of that space** — and a negative result is then read as _absent_ when it means _not present in the region examined_. **That is #121's defect in a second instrument, and it is the third time in this batch that a check has come back clean from a region it could not see.** `--contains` can prove reachability and cannot prove unreachability, because its search space is a strict subset of the ref space. **The blocker is nevertheless upheld in the part that matters, and the part it convicts is mine.** The harness told a reader to _"verify there"_ and supplied no way to get there, and this ledger asserted the commit was _"on no ref"_ — **which is false, and I wrote it.** It was written from how the commit had been recovered rather than from a reachability query, which is citing the nearest copy in a different costume. **Both are repaired at this head**: the fetch command is now given at the citation, and the reachability sentence states what was measured instead of what was remembered. **A citation whose target cannot be reached by the reader is not a citation, whatever the object's status** — the reviewer was right about the reading experience and wrong about the object, and the first of those is what a citation is for. **Why the object is branch-unreachable is itself the explanation and it was already in this policy.** `741459de` is a **pre-squash** commit of PR #68; the squash merge `5eef0d7` landed the **final** state, so the **pre-fix** revision this run cites reached the mainline in no commit, by construction. Procedure step 3 states exactly this — _a squash merge lands the content without the commit_ — and this batch applied it to `a08de19` and **did not apply it to its own citation.** Same instrument, one artifact over, unapplied; **the third occurrence of that specific failure recorded in this file**, and the second where the instrument was one this batch had just finished writing down.
- **Citation audit — an attribution that is not greppable at its target, found by a coordinator against this batch and reproduced here.** `git grep "shared token set" -- .squad/decisions.md` returns **zero at every commit on this branch**, and the phrase appeared in `.squad/decisions/inbox/fact-checker-symmetric-diff.md` inside the clause _"the log itself recording that…"_ — an **unquoted paraphrase attributed to a source, with no anchor**. **The substance was real and the citation was not.** The log does record the mechanism, under _2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found_, and **this ledger's own `D-resolution` entry cites that heading correctly** — so the defect is not a fabricated claim but an anchor **dropped in the mirror**, and the mirror is the copy the Scribe reads. **Both were checked before repairing, in that order**, because the reverse order — repairing the wording first — would have produced a correctly-anchored sentence whether or not the log said anything, and would have looked identical. **The failure mode is worse than a stale line number and that is the reason it is recorded rather than quietly fixed.** A stale pointer resolves somewhere wrong and can be caught; **an unanchored paraphrase resolves nowhere, so a reader who greps concludes the citation is invented and a reader who does not concludes it is sourced — and neither reading can be corrected by the text.** It is unfalsifiable in the plain sense: there is no query that returns evidence against it. **And it was load-bearing** — it is the sentence establishing that the two `49,150`s are **dependent**, which is what forbids resolution-by-majority and is therefore what run D's resolution rests on. **The score is not _ten of twelve anchored_.** It is that the one unanchored attribution carrying weight was the one this batch was most confident in, which is why auditing **all** citations found it and auditing the doubtful ones could not have. **Second instance repaired in the same pass**: the same file rendered _"the kind of independent convergence the log asks for"_ against the same heading, also anchored in the ledger and also bare in the mirror. **The pattern is the finding — this batch's mirror systematically drops the anchors its ledger carries**, which is a property of copying prose between artifacts and not of either sentence. Remaining bare _"the log"_ references in that file are back-references to its own named governing entry rather than fresh attributions; they are left alone, and the distinction is exactly what the audit had to make.
  **The result has since been reproduced at two further mainline heads by two parties, and those readings are independent in the way two simultaneous reads of one ref are not.** The reviewer measured `3 / 6 / 2 / 2` at `a3edb245` and this session measured it again at `ef9209ea`, against run K's own `646499cc` — **three different trees, three different moments, two different readers, one figure family.** That is not the common-mode agreement this file warns about one section below: those readings share no interval, so agreement between them carries information that two same-instant reads of a single ref do not. **Both arms of the control were run at the third head** — a figure known absent returned 0 files, a figure known present returned 2 — because a count is not evidence until the instrument has been shown able to return the other answer.

- **K — runs D and E re-enumerated at the mainline head after a second rebase, and the base was read by name rather than taken from any value in the dispatch that ordered it.** Base moved from `197e8e27` to **`646499ccb23a86b2a3b12a9b956a0177550b7f98`**, which `git ls-remote <url> refs/heads/development` returned at read time, **twelve merges later**; the branch was rebased onto it and every claim below is at that head. **The count did not move and neither did the verdict.** The figure family across `.squad/` and `docs/` reads **3 / 6 / 2 / 2** files for `49,150` / `32,767` / `16,384` / `16,383` — **identical to run H across twelve merges** — and the hits were read rather than counted, per step 2: the only rendering in the **row-total** slot that disagrees is `docs/security/THREAT_MODEL.md` § _T2.2_, which is the live finding this PR repairs and which is still unrepaired on the mainline because the PR is unmerged. **Every other hit is a mention, a quotation, or a corrected clause.** So run D's divergence is **still live and still single** at a head twelve merges past its last enumeration. **The negative result is the point and it is worth more than a positive would have been**: the previous re-enumeration moved the count, this one did not, and **a re-enumeration rule that had only ever produced changes would be indistinguishable from a rule that always reports change.** This is its first clean run and therefore its first evidence that it discriminates. **A second instrument was exercised on the rebase itself, and it corrects an error this batch would otherwise have made.** `--is-ancestor` from the pre-rebase head exits **1**, which reads as _the work is gone_; `git patch-id --stable` matched **22 of 22** commits to a twin, **0 lost**. **Ancestry answers _was I rewritten_; only content answers _is my change still here_**, and after a rebase those diverge by construction. The discrimination control was run before the match was trusted — **22 commits, 22 distinct patch-ids, no collisions** — because an instrument reporting _identical_ must be shown able to report _different_, which is the same requirement this batch imposed on a reachability control one entry above. **And the tree comparison, which is the obvious check, is the wrong one**: the trees differ across this rebase while all 22 changes are present, because the base advanced and twelve merges of other authors' work arrived. **Whole-tree identity answers a question about the repository; per-commit patch identity answers the question about the author's work.** Recorded because the batch nearly reported the tree difference as a loss.
- **L — the no-head-SHA discipline overcorrected into dropping a _required_ pin, and the reviewer spent four reproduction attempts on the gap.** Run K's base clause named the **command** that reads the mainline head and not the **value** it returned, so the entry recorded _how_ to obtain the base rather than _which_ base the enumeration was current with. **Procedure step 4 requires the value**, and the same commit that dropped it added the reconciliation saying archival and event SHAs are **exempt** from the no-head-SHA ruling — so the rule and its violation shipped together. Repaired: run K now names `646499ccb23a86b2a3b12a9b956a0177550b7f98`. **The general defect is that a rule against a class of pin has no way of knowing which pins are load-bearing.** _"Never send a head SHA"_ is a rule about a **mutable ref's current value**; a base pin is a **closed fact about which tree a measurement ranged over** and it never decays. Suppressing it does not make the claim safer, it makes it **unreproducible** — a strictly worse outcome than a stale pin, because a stale pin is falsifiable and an absent one is not. **Corollary, and it is the part worth keeping: an over-broad rule fails silently in the direction of _less_ evidence, which is the direction no reviewer can detect.** A stale SHA gets caught the moment somebody runs it; a missing SHA produces a claim that simply cannot be checked, and the reader's failure to reproduce looks like their error. That is exactly what happened — the reviewer tried four corpora, all at the branch head, and was **one step from filing a blocker against a correct measurement**. He recovered by re-reading the entry's own first clause (_"at the **mainline** head"_) rather than by trusting his habit, and he filed the miss against himself. **Both halves are findings and only one of them is his.** His is a stale **scope**, which he names as the harder case because nothing about a scope is a SHA anyone thinks to re-read. **Mine is the absent pin that made the scope the only thing left to guess.** Recorded together because separating them would credit the recovery to persistence rather than to the sentence that made recovery possible, and the sentence only worked because step 4 forced it to be there.
- **M — a branch-shape property verified before a push was falsified afterwards by a party who is not the author, without any push by the author.** Run K reported the branch carried **no merge commits**, checked immediately before pushing with `git rev-list --merges` returning empty. That was true. The branch now carries **one** — `7cc286ba80ac12b26e86466228b2f1eb5f0cbc2f`, parents `facab3ce` and `ef9209ea`, created by a coordinator running the REST `update-branch` to keep an approving review reachable across the sync. **The action was correct and deliberate and the property is still gone.** The finding is not about the merge: it is that **a self-check on branch shape is valid only while the author is the only writer**, and on any branch a coordinator, a bot, or a maintainer can write to, that condition is never guaranteed and is not visible from the author's side. **So a shape claim is an event claim, not a state claim, and must be reported as one** — _"no merge commits at `facab3ce`, verified at push"_ stays true forever; _"the branch has no merge commits"_ was false within the hour and nothing warned. This is the same event/state split the batch adopted for head SHAs, arriving from a direction that split did not anticipate: **the earlier case was a value going stale through the passage of time, this one is a property going stale through the action of another writer.** Time was the assumed mechanism and it was never the only one. **Control, and it is cheap: re-read the shape from the remote ref at the moment the claim is used, never from the local checkout** — the local worktree was clean and correct and knew nothing about the merge, so the instrument closest to hand was the one that could not see the change.
- **N — an eight-row enumeration was attributed to this session because its SHAs matched, and the SHAs were always going to match.** A coordinator published a table of eight revisions, tested each against the live branch, found `resolves=YES / on-branch=NO` for all eight, and concluded that **this session's** enumeration described a history that no longer exists. **The measurement is exact and reproduces here. The attribution does not.** Six of the eight are the `commit_id` fields of another party's reviews on this PR, and the enumeration was that party's work. **The tokens agreed because two sessions reading one pull request cite the same object identifiers — identifiers belong to objects, not to readers** — so a set of SHAs carries no information about who assembled it. This is the common-mode family a third time: **two parties reading one ref at one instant produce one reading; two parties citing one object produce one token set; in both cases agreement is only evidence when disagreement was available.** Attribution requires a lookup against something that does discriminate — who pushed, who authored, which review id — and none of those were consulted. **The self-check that was skipped is one this file already requires of every count: read the hits rather than count them.** Eight matching SHAs were counted; not one was traced to a source. **And the underlying question was answered with the wrong instrument, which this batch has now recorded three times in three directions.** `on-branch=NO` is `--is-ancestor`, which answers _was I rewritten_; after a rebase it returns **NO for everything** and cannot distinguish work that was discarded from work that was preserved. Measured across the same eight revisions with `patch-id --stable` against the live branch: **ancestry says 0 of 8 present, content says 8 of 8 present**, every one with a named twin, over a branch index of 24 commits carrying 24 distinct patch-ids so the instrument was shown able to report _different_ before its agreement was trusted. **The conclusion _"no overlap whatsoever"_ is true of the identifiers and false of the changes**, and the changes are the thing under review. **Both halves are worth keeping and neither cancels the other:** the class finding — that a stale pin resolves cleanly and answers every question put to it — is correct, is this session's defect as much as anyone's, and is why the `--is-ancestor` reading looked conclusive; **an instrument that returns a clean, complete, arithmetically correct answer about a tree nobody will ship is exactly as dangerous when it is measuring attribution as when it is measuring content.**

- **O — sixteen pins in this file became unreachable to every reader while remaining perfectly resolvable to their author, and the size of the defect turned out to depend on a parameter neither party had stated.** Filed as a blocker against this PR (B9). Every one of the pins was the branch head, or an ancestor of it, **at the moment it was written**; two rebases and a coordinator's `update-branch` orphaned them afterwards (**three rebases, and all three were this session's own — see run Z**). The author cannot detect this locally by any means: several worktrees share one object database, so a superseded head resolves for whoever created it **forever**, and `git show` neither errors nor warns. **A citation must be reachable by the reader, not by the author** — the general form is the coordinator's, arrived at independently on his own notes, and it is adopted here rather than re-derived. What this run adds is a measurement and a tested repair. Enumerating every backticked revision in `.squad/fact-checker/{audit-trail,policy}.md` gives **43 cited SHAs**; against the revisions a reader of this PR actually holds — the branch head and the mainline — **20 are reachable, 16 have a surviving twin on the branch, and 7 are reachable from neither** — but see run R: the instrument that found those 16 twins was `git patch-id --stable` over the **cited** commit, which requires holding it, so that figure was available only from the author position and did not reproduce for a reader. The reviewer's independent count of the same artifacts was **16 unreachable**. **Both numbers are correct and they measure different questions:** his instrument asked reachability from `refs/heads` and then from the whole advertisement, mine asks reachability from what a reader is assumed to hold. **Neither of us stated the reader model, and the reader model decides the answer** — the same shape as this ledger's own class note, where the unit of enumeration was itself a judgement that decided the count. The parameter is now stated in the harness rather than implied by it.
- **O, continued — the repair, tested on the case the blocker named as hard.** The blocker offered no remedy and set a burden: any proposal must work for run I, whose central figure is pinned to `3b55c83` and is a claim about a **mutable file** _"as it stood"_ at a revision, which a content assertion cannot pin. It is discharged by substitution, and the substitution is checkable rather than asserted: `3b55c83` has a surviving twin at **`c010bad5`**, and `git rev-parse <rev>:.squad/fact-checker/audit-trail.md` returns **the same blob** at both, so the 67 re-derives at a revision the reader can fetch. That identity was measured across all sixteen twinned pins and held at **16 of 16** — measured in the author’s object store, which is the qualifier run R adds; the twins are now named in the ledger so a reader reaches the same sixteen without holding the superseded objects — which is a result about this branch and not a property of rebasing, because a twin shares its **patch** and need not share its **tree**. The seven with no twin all have a verified fetch route on origin and are declared below with it. **No cited revision in these artifacts is unrecoverable** — true of the objects and, until run R, not true of the reader: the harness as shipped reported sixteen orphans and exited non-zero in a clone holding only what the server serves. The sentence is retained with its correction attached rather than rewritten, because what failed was its scope and not its arithmetic.
- **O, continued — why this landed as a harness and not as a cleanup.** A one-time repair of the pins would have been stale at the next force-push, and would have left the condition exactly as undetectable as it was before: the failure is invisible from the author's position, so the author is the one party who cannot be asked to watch for it. `scripts/check-citation-reachability.mjs` classifies every cited revision as reachable, twinned, declared, or **orphaned**, and exits non-zero on the last. It carries the control arm this ledger now requires of any enumeration — a SHA known present must classify reachable and a synthetic SHA known absent must classify orphaned, and the run **withholds its verdict** if either control fails, because an instrument that cannot report a problem is indistinguishable from one reporting that there is none. That is the defect this whole PR exists to close, arriving in the tool built to close it.

- **P — the harness written to close this PR's defect was landed with zero call sites, and three artifacts asserted in the present tense that it was enforcing something.** Filed by the coordinator against run O's own commit. Measured: `git grep -F "check-citation-reachability"` returned **five hits — four prose mentions and the file's own header comment**; no `package.json` script, no workflow, no test, and **none of the nine check runs at that head was this one**. 197 lines, complete, controlled, and **never executed by anything but its author, once, at authoring time**. That is the exact position the harness exists to compensate for: **the author is the party who cannot see their own pin die**, so an instrument that runs only on the author's machine is aimed at the one blind spot it cannot cover. **This ledger's own sentence convicts it, written in the same commit** — _"an instrument that cannot report a problem is indistinguishable from one reporting that there is none"_ — and an unwired instrument cannot report anything at all. The failure is not that the check was wrong; **it was correct, and correctness is what made it invisible.** A green pull request reads identically whether a check passed or was never invoked, and the three sentences claiming _"Enforced by"_ were **false at that head with nothing able to say so**. Same class as `available_resolutions()` at `sync.rs` — present, complete, inert — which the coordinator names as this repository's most common defect and its hardest to see.
- **P, continued — wired as far as this branch is permitted to wire it, and the remaining gap is held open by a test rather than by a promise.** package.json gains check:citation-reachability. The workflow that runs it on pull_request — etch-depth: 0 and ef: …head.sha, because reachability, the patch-id twin index and the declared-route probes all read history a depth-1 checkout of a synthetic merge commit does not have, and # merge-queue: advisory so it can never become a required context that would sit Pending forever in the queue — **cannot be pushed from this branch.** The token lacks the workflow OAuth scope: git push is refused outright and the Contents API returns 404 for the same path. **Both were attempted and both were measured, not assumed.** So the workflow is committed at .squad/fact-checker/citation-reachability.workflow.yml for a maintainer to move — parked in the tree rather than pasted into a message, because a citation must be reachable by its reader and that rule does not suspend itself for the file that enforces it. **The honest consequence is that nothing may yet call the check enforced**, and the four artifacts that did have been rewritten to say what is true. ests/citationReachability.test.ts holds that in **both** directions: it fails if any of them uses the word while no workflow invokes the harness, so **the claim becomes true and permitted in the same commit that moves the file** — and reverting that move revokes the licence automatically instead of leaving prose to drift. The one-directional form is the point: an artifact may say nothing, but an artifact claiming enforcement obliges enforcement.
- **P, continued — the test was run against the state it exists to detect, because a test that has only ever passed is the subject of this entry.** Negative control, both arms, by exit code: **npm script removed → exit 1; workflow removed → exit 1; restored → exit 0.** A green suite means the wiring is present only if a missing wiring can turn it red, and that had to be demonstrated rather than assumed — this ledger has already convicted a filter that was constant-FALSE and a match that was constant-TRUE, both wearing the costume of a measurement. **The control also found a real defect in the test:** the workflow assertion used `^on:\n`, which passes on an LF checkout and fails on the CRLF working tree it was written in, so **the first run reported the platform rather than the workflow**. Repaired to `\r?\n` before the control was trusted.

- **Q — a report concluded from two identifiers that a session other than this one had written three commits to this branch, and the two identifiers name one session.** The reasoning was that `22c0a6dd`, `c98182e6` and `01e73855` carry the trailer `Copilot-Session: a361e68b-…`, that the session under discussion is `691bdc7e-…`, and that the two strings differ. They do differ, and they are **drawn from different namespaces**: the first is a commit trailer, the second names a session-state directory on the machine. Measured: nine commit-message files inside the directory named `691bdc7e-…` are **byte-identical to the full messages of nine commits on this branch**, the three above among them. Every commit here is made with `git commit -F <file>` because the shell has no heredoc, so those files are the drafts, and they sit in the directory said to belong to a different session. **Comparing identifiers drawn from two namespaces cannot decide an identity question** — it returns _different_ for one entity as readily as for two — and inequality is evidence only once both identifiers are known to be drawn from the same namespace. This is the dual of the review-attribution defect measured against this same pull request, where thirteen reviews shared **one** `user.id` and no field could separate two parties: there one identifier covered many entities, here two identifiers covered one, and **neither is detectable without first stating the identifier’s namespace and its cardinality against the thing identified**.
- **Q, continued — the control, and the two supporting premises, which were false in the direction that favoured the conclusion.** Of the ten draft files carrying that trailer, exactly one does not match any commit on the branch: the message for the commit whose push was **refused for want of the `workflow` OAuth scope**, recorded in run P and soft-reset rather than landed. **The single file that fails to link is the one independently known never to have been pushed**, which is the discrimination arm — a linkage that matched everything would have shown only that the method cannot fail. The premises were measured too. Over the two hundred commits reachable from this head there are **four distinct author names, not one** — `Jeff Papiez` on 166, `Inspector Agent` on 32, and one each for two others — so the author field is not the constant it was reported to be, and the majority value is not the one named. And those commits carry **42 distinct `Copilot-Session` trailers**, with 26 carrying none at all; whatever the trailer fails to guarantee in general, on this history it discriminates heavily rather than collapsing.
- **Q, continued — writing this entry put two session identifiers into the corpus the citation harness reads, and the harness was measured rather than trusted to ignore them.** It extracts a revision only where a backticked span is **entirely** hexadecimal, so a hex-shaped token inside a longer code span is invisible to it — a recall limit worth measuring, because this ledger has already convicted one filter that suppressed nothing and one match that was constant-true. Measured across both fact-checker artifacts: **47 whole-span revisions seen, and exactly 2 hex tokens inside larger spans not seen** — the trailer value in `Copilot-Session: a361e68b-…` and the directory name in `691bdc7e-…`, the two session identifiers this run is about, **neither of which is a revision**. So the recall gap against actual cited revisions is **zero**, and the whole-span rule is not merely convenient: it is what stops a session id from being resolved as a commit. **The category error this run records would otherwise have been committed by the instrument built to check the citations** — which is the same lesson as run P one level in, that a tool inherits the confusion of the corpus unless something in it draws the line. **And the first draft of this very sentence wrote both of them as bare backticked spans, which is the notation reserved for a revision** — so the harness resolved them as commits and failed the run with two orphans, one clause after the sentence asserting that the whole-span rule is what prevents exactly that. It was caught by the check and not by its author, during an unrelated merge, because **the harness had been run before this bullet was written and not after** — this ledger’s own requirement that a repair be followed by a re-enumeration, broken in the entry that cites it. The reported figures were self-falsifying too: writing the identifiers in revision notation moved them out of the very category the count assigns them to, so the sentence invalidated its own measurement in the act of publishing it — run I’s finding that **a measurement of a population the measurer is inside changes that population**, arriving a second time and detected mechanically rather than by reading.
- **Q, continued — the finding that matters is not that the report was wrong, and it counts against this ledger.** The object that settles the question is **filesystem state outside the repository**: a session-state directory that no reader of this pull request can list, holding files no reader can open. It is exactly the condition run O recorded about citations — _an author’s object store is not the repository, and the difference is invisible from inside it because every lookup succeeds_ — arriving on **identity** rather than on reachability. So the honest verdict is not that one party misread the record. **The record cannot answer who wrote these commits**, and both parties produced confident answers from it anyway: one by comparing identifiers across namespaces, this one by reaching for evidence that happens to lie on the machine where it is privileged. Run N recorded that a SHA carries no attribution; this run records that the identifiers which _do_ exist are **not verifiable by the reader**, so authorship of every commit in this batch rests on testimony at both ends. **A claim I can prove only to myself is not proven, and grading it ✅ is unavailable to me on this ledger’s own rule.** Recorded as ⚠️, resolution: settled on this machine only.

- **R — the check written to close run O reproduced run O inside itself, and the only position from which that was visible is the one this ledger keeps failing to occupy.** A reviewer ran `scripts/check-citation-reachability.mjs` in a clone holding only what the server serves, then imported the author-side object store and changed nothing else: **REACHABLE 21 · TWIN 0 · DECLARED 7 · ORPHAN 16, exit 1** became **TWIN 16 · ORPHAN 0, exit 0**. One variable, two verdicts, and **both controls passed in both runs** — which is the part worth keeping. The mechanism is not a coding error. Twin detection ran `git patch-id --stable` over the **cited** commit, and holding the cited commit is precisely what the reader is defined by not doing. So the class that the entire repair depends on was computable only from the position that cannot see the defect. **The tool asserted reachability-by-the-reader and measured reachability-by-its-author**, and nothing in its output distinguished the two.
- **R, continued — what the controls could and could not establish, which is the general result.** The previous version carried a positive and a negative control and both fired correctly in the failing configuration. They were not weak; they were aimed one layer below the defect. A known-present SHA classified REACHABLE and a known-absent SHA classified ORPHAN, which established that the data was live and the pipeline connected — and said nothing whatever about whether the predicate in between asked the intended question. **A positive control proves the data is live; it does not prove the predicate asks what you think it asks.** The repair is therefore not a better control of the same kind but a different kind: two **mutation** controls that alter the _artifact_ and require the verdict to move with it. Removing a declaration must turn its citation ORPHAN, and a declared twin that is not itself reachable must be refused. Four controls now, and the run withholds its verdict if any of them fails to behave.
- **R, continued — the repair is to stop computing the answer and start reading it.** The twin mapping is now **data in the repository**: a block naming each superseded revision and the live copy that carries its patch, which the harness parses and then verifies, accepting the citation only when the named twin is itself reachable from the reader’s revisions. Patch-id survives strictly as an authoring aid that suggests a twin to declare and can no longer promote an orphan to a pass. The distinction is the one this ledger already holds for documents and had not applied to its own tooling: **a pointer needs a content assertion, and a computation performed where the objects are is not a content assertion the reader can repeat.** Verified from the reader position rather than argued: a fresh `git init` fetching only `refs/heads`, with the six most-cited superseded pins confirmed **absent** by `git cat-file -e`, returns **REACHABLE 35 · TWIN 16 · DECLARED 7 · ORPHAN 0, exit 0** — and in that same clone, deleting one declared twin line returns **exit 1** naming that citation. The clean result is produced by the declaration, not by fail-open.
- **R, continued — two claims of run O are corrected in place rather than defended, and the credit is not mine.** _"16 of 16"_ blob identity across the twins and _"no cited revision in these artifacts is unrecoverable"_ were both true of the objects and both unavailable to a reader; the second was contradicted by this repository’s own shipped tool the moment anyone ran it from outside. They are annotated with their scope instead of rewritten, because what failed was the scope and not the arithmetic, and a silently corrected claim teaches nobody what was wrong with it. **The finding was reached by running the instrument in the reader’s position rather than reading its source in the author’s** — a review method that this ledger had recommended for documents, in writing, while never once applying it to a script it shipped. Every gate in this repository is a function of the working tree, and a defect defined by _what is absent from someone else’s_ tree cannot be a function of the tree. **A fresh clone is not a formality before release; it is the only instrument that holds the reader’s position, and nothing run from the author’s tree substitutes for it.**

- **S — a coordinator asked for a rebase to clear a conflict that no longer existed, and the rebase would have destroyed the repair this pull request exists to ship.** The request named a head three pushes stale and reported `mergeable=CONFLICTING`; read live, the same fields returned `MERGEABLE` / `BEHIND`, the conflict having been settled by a merge in an earlier run. **The instruction was sound for the state it was issued against and wrong for the state that existed** — the fourth report this cycle whose subject moved between sending and reading. What is new here is that the stale premise pointed at a _destructive_ remedy, so complying would have been unrecoverable rather than merely wasteful.
- **S, continued — the cost was measured by running it, not by predicting it, and the prediction was wrong by half.** Counting cited revisions that are commits unique to this branch gave **17 of 58**, and the reasoning stopped there. Executing the rebase in a throwaway clone gave a different number: with the tree byte-identical on both sides — the audit-trail blob is `3a16aa0f` before and after — the harness returned **REACHABLE 35 · TWIN 16 · DECLARED 7 · ORPHAN 0, exit 0** on the merged history and **REACHABLE 18 · TWIN 0 · DECLARED 7 · ORPHAN 33, exit 1** on the rebased one. **The forecast missed the sixteen declared twins, because the twins are themselves commits on this branch** — so a rebase destroys the citation _and_ the declaration that repairs it, in one motion. The declared-twin mechanism is therefore ancestry-fragile in a way its own ledger entry did not say, and the entry is corrected by this one. **Same content, different ancestry, thirty-three orphans: reachability is not a property of what a document says, and no review of the text could have caught this.**
- **S, continued — a merge is not a stylistic preference on this branch, it is the only operation that preserves the artifact.** Recorded here because the next maintainer will have no way to know it: rebasing or squashing this branch turns the citation check red with thirty-three orphans, and the failure will look like a defect in the check rather than a consequence of the merge strategy. The merge performed instead is `504def1e` with both parents intact, so every revision a reviewer pinned remains an ancestor and the harness still exits 0.
- **S, continued — the control drifted, and the control is the thing that is supposed to notice drift.** Re-running the figure family after the merge, the negative control held at **0** and the positive control returned **6** where this ledger had recorded **3**. The tempting reading is that the merge added files. It did not: running one instrument across both heads returns **6 at each**, so the corpus is unchanged and **the earlier 3 was a narrower scan**. Two numbers from two instruments were about to be compared as though they were two measurements of one quantity. This is run Q’s rule arriving on measurement instead of identity — an identifier decides nothing until its namespace is stated, and **a count decides nothing until its scope is stated.** The sharper form, because it is the failure that nearly happened: **a control whose scope is unstated cannot distinguish a corpus that changed from an instrument that changed**, which is precisely the discrimination it exists to perform.
- **S, continued — run D re-verified at the mainline rather than carried forward.** `docs/security/THREAT_MODEL.md` § T2.2 on `refs/heads/development` at `ce4a7515` still reads _"expanded to 32,767 rows"_ where the decision log and the skill both say 49,150; the blobs differ across the two sides (`f98c367a` on the mainline, `e8dc2533` here), so the repair exists only on this branch and the divergence is live for every reader of the mainline. **Run D remains the single unrepaired third rendering, and it is unrepaired because this pull request is unmerged** **Scope, recorded later rather than rewritten:** the unscoped present-tense clauses in this bullet — that the divergence _"is live for every reader of the mainline"_ and that run D _"remains the single unrepaired third rendering"_ — were true at `ce4a7515` and are false at any mainline head containing `c8d379ff0dfd06095defb36792b8b1d1393bdd41`. They are superseded by the entry beginning _"Run D is closed, by someone else"_ further down this file. Left standing because the pin to `ce4a7515` is what makes the earlier reading checkable, and **a claim that decayed needs its decay recorded beside it, not instead of it** — but the sentence a reader greps is the unscoped one, which is why the annotation is here and not only in the later entry. — which is the whole argument of #121 sitting unresolved in the artifact that motivated it.

- **S, continued — the check rejected the strongest anchor this ledger has, and it caught that by rejecting the entry above.** Writing run S required pinning two file contents, so it cited **blobs**: the audit-trail blob either side of the trial rebase, and `docs/security/THREAT_MODEL.md` on each side of the divergence. The harness returned three orphans. The cause is that it resolved every backticked hex as `sha^{commit}`, so an object that is not a commit could not be reachable **by construction** — and all three were in fact carried by the reader’s own revisions, confirmed by `git rev-list --objects`. **The tool was pushing authors away from the best anchor available to them**: a blob cannot be rewritten, which is exactly the property the sixteen twins above exist to work around, and the one instrument immune to the rebase failure this run measured. Fixed rather than worked around — the classifier now accepts any object the reader’s revisions carry, with **its own pair of controls**, because a branch nothing exercises is a branch nothing checks. Six controls now. **Three runs in a row this instrument has failed its author before a reviewer saw the work, and each time on a claim that reading the diff would have passed.**

- **T — the coordinator sent a general check for the class this pull request was blocked for, and running its two rules by hand found two more instances of that class inside this pull request.** The issue lists #162 as _"197 lines, zero call sites"_, which is the state before that blocker was discharged and is no longer true — the harness has an npm script and a binding test. What is true, and what nobody had looked for, is that `scripts/measure-diamond-dag.mjs` and `scripts/measure-mention-filter.mjs` **each had exactly one occurrence of its own filename anywhere in the repository: the “Run it:” comment in its own header.** No npm script, no workflow, no import, no test. **They were landed in the same change that discharged a blocker raised for precisely that shape, by an author who had just written the ledger entry about it** — and then reviewed twice more without either of us seeing it.
- **T, continued — this is not tidiness, because two documents assert in the present tense what those scripts do.** `docs/security/THREAT_MODEL.md` § T2.2 states that the first script _"rebuilds the fixture and measures the two populations separately"_, and the figure family both scripts produce is the evidence for the cross-artifact divergence this entire change exists to detect. **So a document asserted what a script does while nothing ever ran the script** — the identical sentence-without-a-check that B8′ was raised over, one file away, invisible during the discharge of B8′ itself. The repair is the same as that one and is now applied uniformly: a test executes both scripts and asserts the figures they are cited for, so the numbers quoted across six artifacts stop being a reading someone once took and become a condition that fails the build when it stops holding. **Run D’s finding is now a check rather than a sentence, and when the mainline repair lands the test goes red and forces this ledger to be updated with it.**
- **T, continued — the test was not trusted until it had been seen to fail.** Appending a throw to `scripts/measure-diamond-dag.mjs` turned **2 of 4 red**, and exactly the two that execute that script; restoring it returned **4 green** with the file byte-identical. The two that stayed green are the two driven by the other script, which is the result that distinguishes a real binding from a test that passes because it asserts nothing. **A test whose failure has never been observed is not known to be able to fail**, and shipping one is how a suite reaches sixteen hundred green assertions while a guard beneath it does nothing — the condition catalogued four times under four names and now, with these two, six.
- **T, continued — the enumeration was handed over, not discovered here, and that is the part worth keeping.** The coordinator’s check was written to catch other people’s dead scripts and its author listed this branch as one of four known instances. Applying it here before it merges cost one command and returned two findings **in the artifact of the person applying it**. Both had survived every gate, six review rounds, and an author specifically sensitised to this exact defect. **The general instrument found in one run what the interested party had missed across six**, which is the argument for the instrument and against the review: the reason none of us saw it is that the evidence is an _absence_, and a reader looking at a diff sees only what is present.

### Run T (continued) — the test written to bind the measurement scripts failed the reader position, and CI is what said so

- **The instrument was correct and its inputs were absent.** `tests/measurementScripts.test.ts` asserted that `scripts/measure-mention-filter.mjs` emits a `docs/security/THREAT_MODEL.md` row containing the divergent figure. It passed on every gate I run and failed on two of the nine CI check runs, with `expected '  MISSING origin/development:docs/sec…' to contain '32,767'`. Every row of that table is read from `origin/development`, and a pull-request checkout has the head alone. The assertion was true of my clone and of no reader's. **This is the fourth appearance of the reader-position defect in this batch and the first one no human found** — the citation harness was caught by a reviewer, the blob classifier by a run of the harness, and this one by a machine that holds the reader's position by construction.
- **The defect worth fixing was in the script, not the assertion.** On an unreadable revision `measure-mention-filter.mjs` printed a `MISSING` line and **exited 0**, so six of its seven rows could vanish and the process still reported success. That output is the published evidence for run D. A caller could not distinguish _measured, found nothing_ from _could not measure_ — the identical indistinguishability that made an uninvoked check read as a passing one in run P, and an author-reachable citation read as a reader-reachable one in run R. **Three different objects, one shape: the failure state and the success state emit the same signal.** The repair is an exit status of 2 with a named count and a fetch instruction, so the condition is machine-detectable rather than a sentence someone might read.
- **The test now asserts a property in each position rather than a figure in one.** Where the mainline resolves it asserts run D's divergence and a clean exit; where it does not it asserts that the script announces its own incompleteness. Both branches were exercised: the first in this worktree, the second in a `--depth 1` clone of the branch alone, in which `git rev-parse --verify origin/development^{commit}` fails — the CI condition reproduced rather than imagined. **A conditional assertion is only honest if both of its arms are run, and the arm that is never taken locally is the one that shipped broken.**
- **Two mutation controls, one per position, because a single control would have passed here.** Restoring the silent `exit 0` in the reader-position clone turned the test red; pointing run D's row at `HEAD`, where the figure is repaired on this branch, turned it red in the author position. Each control is invisible to the other arm — the silent-degradation mutation cannot be seen from a checkout that holds the mainline, which is exactly why the original defect survived every local run. The script was restored byte-identical, checked by comparing `git hash-object` across the mutation rather than by pinning the value: that hash is computed over the working tree, so on a CRLF checkout it names an object git never stores and no reader can resolve. **The harness rejected it as an orphan when I first wrote this bullet** — the citation rule catching its own author citing a number that looks exactly like an anchor and is not one. **The controls had to be split because the positions are; a control written from one position inherits that position's blindness.**

### Run V — run D is discharged on the mainline, and the guard written to notice that fired for the wrong reason

- **Run D is closed, by someone else, in `c8d379ff0dfd06095defb36792b8b1d1393bdd41`.** The divergence this check found and reported for the life of the pull request — `docs/security/THREAT_MODEL.md` § T2.2 rendering the diamond-DAG row count as 32,767 where every other artifact rendered it 49,150 — is repaired on `development`. Verified at both objects rather than by re-reading the ledger: `c8d379ff^` reads _"a 29-node diamond DAG expanded to 32,767 rows"_ and `c8d379ff` reads _"expanded to 49,150 rows"_. **The corrected check's one live finding was discharged by a repair this run did not make and was not consulted about**, which is the outcome the symmetric form exists to produce: the finding is a property of the artifacts, so anyone can close it.
- **The guard I wrote to notice this fired, and it fired on row ordering rather than on the repair.** The previous assertion took the first table row mentioning the threat model and required it to contain 32,767. It went red — but only because the repair added a 49,150 row that now sorts first. **Had the rows come back in the other order it would have passed, green, against a premise that had become false.** The failure was luck, not detection, and the difference is invisible from the result.
- **The reason is use-versus-mention, and this ledger has already recorded it twice.** The repaired file still contains 32,767 — correctly, as a _path_ count — so a substring test over a row cannot discriminate the figure being _used_ as a row count from the figure being _mentioned_ as a path count. **The discriminator has to be the sentence, and no count of hits will ever be one.** The guard now reads the `diamond DAG expanded to` sentence out of the mainline blob and requires 49,150 and not 32,767, with the table check kept alongside so it cannot pass against a table that has silently stopped being produced.
- **Controlled against the real pre-repair object rather than a doctored one.** Pointing the guard at `c8d379ff^` turns it red with `Received: … expanded to 32,767 rows`; restored, four pass. **A control that replays the exact state being guarded against is worth more than a mutation invented to resemble it** — this one proves the guard would have caught run D on the day run D was written, which is the only claim a regression guard is really making.
- **Run D's entry is not rewritten.** It was true of the objects it named and it stays as it was, with this entry recording the discharge. **A finding that is later repaired did not become wrong**, and editing the original would delete the evidence that the check worked.

### Run W — run F was right on an unsound warrant, and the third SHA mode is the one this harness already classifies

- **`gh api` truncates a commit enumeration at 30 and returns a well-formed array that does not say so.** Measured now, on this pull request: `gh api …/pulls/162/commits --jq .[].sha` returns **30**; the same call with `--paginate` returns **38**. No error, no warning, no field distinguishing the two. **A completeness claim over a silently truncated list is unsound whether or not it is true**, and the reader cannot see which it was.
- **Run F published exactly that warrant, and its conclusion survives anyway.** Run F's load-bearing claim is a _negative_ — that four cited revisions do not appear in this pull request — and it was evidenced by an unpaginated enumeration of fourteen. Re-derived now by two instruments: `git merge-base --is-ancestor <sha> refs/pull/162/head` returns non-contained for all four, and the properly paginated 38-commit list contains none of them. **Fourteen was under the cap, so no truncation occurred and the count was correct.** The method was unsound at the time it was used and happened to be operating inside its valid range.
- **Right answer, wrong warrant — the second instance in this session, and the pair is the finding.** Run V's guard went red at the correct moment because a row happened to sort first; run F reached a correct negative on an enumeration that happened to fit under a cap. **Both would have been indistinguishable from sound work in their output, and both were corrected only because something outside the result was examined.** A result cannot certify the procedure that produced it, and this is the axis on which every remaining defect in this trail sits.
- **The third SHA mode is not undetected here; it is the category this harness was built around.** A revision on a parallel chain answers _yes_ to every reassuring instrument — measured on `c388366`: `git cat-file -e` exits 0, `gh api repos/…/commits/<sha>` returns 200 with the object — while `git merge-base --is-ancestor <sha> HEAD` exits 1. `check-citation-reachability.mjs` classifies precisely that state, and classifies it **ORPHAN** unless the artifact declares a live twin for it. **That is what the TWIN and DECLARED categories are: the discriminator for a SHA that resolves and is not contained.** The mode has a natural detector in this repository, and it is wired into CI.
- **Run F's own conclusion is widened, having been measured rather than accepted.** Six revisions were tested against `refs/pull/162/head`: four resolve and are not contained, two are contained. So the correct statement is not that two parties each read their own rendering, but that **several resolvable renderings existed and the parties disagreeing about them were, between them, not on the object.** Run F's entry is annotated, not rewritten — the same rule applied to run D in run V. **A finding whose warrant is later found unsound did not thereby become false, and deleting it would destroy the record of how it was checked.**

### Run X — the merge that shipped this check broke every citation in it, and the check is the thing that said so

- **#162 was squash-merged, and the squash destroyed 36 of the revisions its own audit trail cites.** Measured in a fresh full clone of `development` at `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`: the shipped harness returns **REACHABLE 22 · TWIN 0 · DECLARED 7 · ORPHAN 36, exit 1**. All 36 are _unresolvable_, not merely unreachable — `git cat-file -e` fails on every one, because the branch commits were collapsed into a single commit and the branch was deleted. **The citations were accurate when written, and the merge method destroyed the objects they named.**
- **This is the damage a rebase was measured to cause, arriving through the one operation nobody had to choose.** A trial rebase of this branch was measured earlier at ORPHAN 33 on a byte-identical tree, and the conclusion recorded was _never rebase this branch_. **A squash is the same history rewrite, performed at merge time, by the merge button, after the author has stopped watching.** The rule was right and it was written for the wrong actor: it constrained the author, and the party who rewrote the history was the merger.
- **The repair is the mechanism the check already had, pointed at the squash commit.** Every destroyed revision now declares `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` as its live twin, which is exactly what a twin declaration asserts: the commit that carries this content now. Verified rather than assumed — 36 declared twins, **0 unreachable**, and the harness returns **ORPHAN 0, exit 0** with all six controls firing. The declarations were generated by asking the harness which citations were orphaned rather than by transcribing a list, so the enumeration is a function of the tree and cannot go stale between being produced and being used.
- **Sixteen of the pre-existing twin declarations had themselves been squashed, and the check refused them.** Those entries named live twins that were commits on the same branch, so the repair pointed at objects the merge destroyed alongside their subjects. **A twin declaration is only worth its reachability requirement, and this is the case that proves the requirement earns its keep** — without it, sixteen citations would have passed while naming objects no reader can resolve. The duplicate rows were collapsed rather than kept: two live twins for one revision is a contradiction, not extra evidence.
- **The harness degraded silently on a shallow clone, which is the same defect it exists to prevent.** `--depth 50` reported **47** orphans where a full clone of the same commit reported **36**; the extra eleven were artifacts of clone depth, and the two runs were indistinguishable in their output. It now detects `git rev-parse --is-shallow-repository` and **refuses the verdict with exit 2** rather than publishing a wrong one. Controlled at the same commit with the same script: shallow **exit 2**, full **exit 0**. **A check that reports a wrong answer confidently is worse than one that reports nothing, because only the second is distinguishable from a check that has not run.**
- **The check was not wired into any workflow on `development`, so none of this was visible.** `package.json` carries `check:citation-reachability` and no workflow invokes it, so the mainline is green while the check it merged is red. **The instrument shipped, landed, broke on contact with its own merge, and reported nothing — because nothing runs it.** That is B8′ exactly, and this is what it costs.

### Run Y — B5 re-enumerated at the mainline: the count was over a numeral, and three different quantities share it

- **Re-run at `60735aece64352b194fc071d34e2f5a7a194f98a` on `development`, scope stated before the number.** Whole tree, pattern `20_000|20000|20,000`: **27 files**. Same tree, same pattern bounded so it cannot match inside a longer number: **15 files**. The twelve-file difference is `20_000_000` and its kin — **the loose pattern matches a substring of a larger figure**, so a count taken with it is not a count of the figure. Negative control `zzqq-not-a-real-string` exits 1.
- **The scope was doing the work, not the pattern.** Inside the four-path scope this enumeration has always used, loose and bounded patterns agree exactly — **5 files either way**. So the reported figure was robust to pattern precision and fragile to scope, which is the opposite of how it reads. **A count that is stable under a stricter instrument and unstable under a wider one is a fact about the file list, not about the corpus.**
- **The fifth file is a digit collision, settled at the object.** `.squad/skills/agent-collaboration/SKILL.md` carries `race loops=20000 good=19999 evil=1` — a race-condition loop count inside an exploit reproduction. It is not a rendering of the part-tree budget and never was. **Same numeral, different referent**, which is use-versus-mention's sibling and defeats the same instruments: neither a stricter regex nor a fence filter nor a quotation filter can see it, because nothing about the token is wrong.
- **And two of the surviving hits are a third quantity again.** `docs/scene-contract.md` renders the budget once — _"20,000 rows — four times the 5,000-object sidecar cap"_ — and then twice more as a **triangle threshold**: _"at least one object is ≥ 20,000"_ and _"≥ 20,000 triangles get a proxy"_. A fourth hit, in `.squad/decisions.md`, is the entry **quoting** the rendering as part of a 117-character verbatim run, which is a mention of it rather than an instance of it.
- **So the scope holds three distinct quantities plus one quotation, and a file-level count cannot separate them.** The genuine renderings of the part-tree row budget are `.squad/decisions.md`, `docs/scene-contract.md`, `.squad/skills/test-discipline/SKILL.md` and `src/renderer/library/partTreeModel.ts` — **four, unchanged**. The apparent fifth is a loop count and two of the apparent extras are triangle counts. **The enumeration was counting a numeral while its claim was about a figure, and those come apart the moment a second quantity happens to be twenty thousand of something else.**
- **Amendment, from an error made while publishing this entry.** The PR comment carrying run Y first quoted the triangle threshold as `25 20,000 triangles get a proxy` — a shell-quoting mangle — and the repair then quoted _"least one object is ≥ 20,000"_, dropping the leading _at_ because `docs/scene-contract.md` is hard-wrapped and that word ends the previous line. **The fragment is verbatim as a line and not verbatim as a sentence.** `git grep` returns lines; prose is made of sentences; in a wrapped document those are different objects, so **copying a quotation out of a grep hit quotes the instrument rather than the source.** Both renderings in this entry were re-checked against the blob with the line wrapping removed, which is the only comparison that can settle it.
- **This is the third time this trail has had to record that a count cannot settle a question of reference.** Paraphrase under-counts, quotation over-counts, and now coincidence over-counts — and none of the three is repaired by a better pattern, because in every case the token is exactly right and the referent is not. **The remedy is the same each time and it is not an instrument: read the sentence.**

### Run Z — the rebases run O attributes in the passive voice were this session's, there were three, and the rule against them was written after the last one

- **A reviewer attributed a rebase to this session from a reflog fragment, and the fragment is in this worktree's reflog verbatim.** `c388366` `reset: moving to HEAD` → `ccf61d1` `rebase (start): checkout origin/development` → picks → `c2361e4` `rebase (finish)`, all at `2026-08-03 16:53:11 -0700`. **The pair is a twin by measurement, not by inference:** `c388366` and `c2361e4` carry distinct commit ids and the identical patch-id `21eb7b3a20e6fe88e60ecf636b3a7e0eded68637`. **The attribution is correct and is accepted without qualification.**
- **Run O says _two rebases_. There were three.** `rebase (finish)` appears in this worktree's reflog at `2026-08-03 16:53:11` → `c2361e4`, `2026-08-03 22:04:14` → `762cd70`, and `2026-08-04 02:15:13` → `bef4bcf`. **An undercount of the operation that caused the defect the entry is about**, in the entry that measures the defect to four significant figures. Run O is annotated in place rather than rewritten.
- **And run O says it in the passive voice, which is the part worth naming.** _"two rebases and a coordinator's `update-branch` orphaned them"_ attaches an actor to one of the two causes and leaves the other agentless — so a reader carries away that the coordinator rewrote the history. **The coordinator rewrote it once. This session rewrote it three times, first.** The sentence contains no false clause; it is the omission of a subject that does the work, and **an omitted subject is not a hedge, it is a claim with the falsifiable part removed.**
- **The rule was written after the conduct it prohibits, and the entry recording it does not say so.** _This branch must be merged and not rebased_ was committed at `d64704d` (`2026-08-04 11:21:44 -0700`); the last rebase was `02:15:13` the same morning, nine hours earlier. **So it is a correction of conduct already performed, not a standing policy that a third party violated** — and this session's later framing, that _the rule constrained the author while the party who rewrote the history was the merger_, is refuted by its own reflog. **The merger's squash destroyed thirty-six citations; the author's three rebases produced the sixteen twins run O was filed about.** Both are true and only one was being said.
- **Correction owed to the reviewer on the head, in the opposite direction.** `b8ae4d7f` (`2026-08-04 10:51:18 -0700`, _record run R_) **is an ancestor of the merged head** `e5a90df7` (`12:12:50`), fourteen commits behind it, and **no `rebase (finish)` occurs anywhere in that window** — the last was eight hours earlier. It is therefore not a later generation of twins created after the disclosure; **it is an earlier commit on the chain that merged.** `ed12593` is the genuine twin here: not an ancestor of the merged head, and already declared in this ledger.
- **A last one, found while checking the branch still existed.** `git ls-remote origin refs/heads/<deleted-branch>` prints nothing and **exits 0**. A check that asks whether a branch exists by testing that exit status sees success for a branch that is gone; only the emptiness of stdout carries the answer. **The same shape as every silent degradation in this ledger — the failure state and the success state emit the same status — and it is how this session learned #162 had been merged: the push failed, not the query.**
- **And appending to the block silently extended a claim quantified over it.** The preamble does not only count the rows, it certifies them — _verified in a fresh full clone of `development`, in which all N are unresolvable_. **Adding five rows re-quantified that sentence over five revisions nobody had checked**, and the figure updating from 36 to 41 made the enlarged claim look freshly measured. It was re-run: a fresh full clone of `development`, `is-shallow-repository` confirmed `false` first, **41 of 41 unresolvable, none still resolving, and the twin `3fac5567` present** — so the claim now holds for the number it states. **A universally quantified sentence is invalidated by growth of the set it ranges over, and no check reads prose**, which is the same gap that let the hand-typed count sit wrong above it.
- **Repairing it exposed one more, in the sentence that introduces the block.** The post-squash preamble said _the 37 entries below_; there were **36**. The rows were generated by asking the harness which citations were orphaned, and **the number describing them was typed by hand** — so the one figure in the block that no instrument produced is the one that was wrong. It now reads `41` because it was **counted from the rows** rather than incremented. **A hand-written count of a machine-generated list, off by one, in the ledger whose subject is counting** — and nothing would have caught it, because the harness validates the citations and never reads the sentence about them.
- **And this entry was rejected by its own check, which found a citation shape the ledger had never carried.** Six orphans: five commits the squash destroyed, and `21eb7b3a20e6fe88e60ecf636b3a7e0eded68637` — **the patch-id offered as the evidence that `c388366` and `c2361e4` are twins.** A patch-id is forty hexadecimal characters in backticks and **names no object in any repository, ever**; no classifier working on the token can separate it from a commit, because there is nothing about the token to separate. **The evidence for the twin claim is less reachable than the twins**, both of which at least have a declared live rendering. Declared as an absence with its derivation command rather than deleted, since the measurement is sound and only its citation shape was wrong.

### Run AA — a three-valued answer read through a two-valued test, verified, hunted in this harness, and then committed twice inside the control written to hunt it

- **The reviewer's exit-code claim is exact, and there is a fourth shape he did not name.** `git merge-base --is-ancestor` exits **0** for ancestor, **1** for a real object that is not one, and **128** when the object is absent — so a caller testing `exit == 1` is safe and a caller testing truthiness is not. **The fourth: an absent _second_ argument is also 128.** An unfetched `origin/development`, an unfetched `refs/pull/N/head` and a fabricated SHA are therefore indistinguishable to any caller that asks _did this fail_ rather than _how_. **The hazard is not the exit code. It is that ancestor / not-ancestor / cannot-tell is three answers and `if (!ok)` has room for two.**
- **Hunted in this ledger's own harness, which has the precondition and not the defect.** `check-citation-reachability.mjs` routes every git call through a helper that catches and returns `null`, so **1 and 128 are one value to it**. The defect is still absent, and **the reason is not exit-code discipline — it is the control arm.** When the instrument goes blind the positive control goes blind with it: a known-present revision stops classifying REACHABLE, and the run withholds the verdict rather than publishing one.
- **Reproduced rather than argued, in a position the existing guard does not cover.** A repository whose `HEAD` is unborn: `is-shallow-repository` is `false`, so the shallow guard is **silent**, and no reader revision resolves. The harness prints `CONTROL FAILED - known-present SHA did not classify REACHABLE`, `verdict withheld.`, and exits **2** — publishing no verdict at all. **A genuinely different way to be unable to see, caught by an instrument aimed at nothing in particular.**
- **That is the answer to the prescribed remedy, and it is stronger than the remedy.** _Branch on the exit code by value and treat 128 as no-answer_ is correct and covers **the codes someone thought of**. **A live positive control covers the ways of going blind that nobody enumerated** — this one was not anticipated by the author, is not reachable through any exit code the caller inspects, and was caught anyway. **The generalisation: an instrument should be wired so that losing its sight costs it the control, not merely the answer.**
- **Pinned in both positions**: a blind repository must exit 2 and publish nothing, a repository with a single commit must reach a verdict — **a failing one, which is the point, because the check is permitted to say no and is not permitted to say no when it means it could not look** — and must state the reader revisions the verdict was computed against.
- **And the mutation control written to test all of that committed the same error twice.** First mutation cleared the failure list **after** the guard had already been entered, so behaviour was unchanged and the run reported _test inert_. **An ineffective mutation and an inert test produce identical output.** Second attempt mutated the guard itself and worked — but the test runner failed to spawn (`EINVAL`), `status` came back `null`, and the check `r.status !== 0` scored that as **detection**. **An unrun test and a failing test are the same value under a truthiness test** — which is precisely the reviewer's finding, arriving inside the control written to confirm it, within minutes of confirming it.
- **Only the three-valued rewrite settled it**: `null` → _undecided, the runner did not run_; non-zero → detected; zero → inert. With the mutation verified behaviourally live (exit 2 → 1, verdict published) and the runner verified to have run, the test failed **1 of 8** and the harness was restored byte-identical. **The rule earns its worked example: state the third outcome, or the two you kept will absorb it silently, and the direction it is absorbed in is always the reassuring one.**

### Run AB — `for-each-ref --contains` fails toward reassurance on exactly the commits it is meant to catch, and the orphan turned out to be carrying the error

- **The instruction was to re-derive from an open pull request that had already merged.** The coordinator measured `#162` as `OPEN` and `BEHIND` at head `b8ae4d7f` and directed a re-derivation from it. Measured here against the API: `#162` is **merged**, at `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`, `2026-08-04T19:29:29Z`, from head `e5a90df74722f586670e18472da5ffe3fd424ba3`, and `git ls-remote origin refs/heads/jpapiez-fact-checker-symmetric-diff` now returns **nothing**. His read predates the merge by roughly seventy minutes and **was correct when taken** — the channel is the defect, not the reading.
- **And his twin call inverts on measurement.** `b8ae4d7f` `--is-ancestor` the merged head `e5a90df7` exits **0**. It is not a divergent twin; it is an earlier commit on the chain that actually merged. The divergence he measured was against a branch tip that the merge then discarded.

- **The finding, and it is about a control being mandated squad-wide.** `git for-each-ref --contains` was named as one of only two checks that discriminate the twin case. **It does not, and the direction it fails in is the reassuring one.** Measured here, at one moment, in one repository:

```
ls-remote origin refs/heads/jpapiez-fact-checker-symmetric-diff   ->  (nothing)

for-each-ref --contains e5a90df7      <- the real merged head of #162
  refs/heads/jpapiez-fact-checker-symmetric-diff
  refs/remotes/origin/jpapiez-fact-checker-symmetric-diff
  refs/remotes/origin/pr162 · refs/remotes/pr162

for-each-ref --contains c4a3321       <- the commit called an orphan
  refs/copilot/checkpoints/... (x3)
```

- **Both commits are equally gone from the remote. One of them reports four branch-shaped refs.** `for-each-ref` reads the **local ref store**, and a deleted upstream branch leaves `refs/remotes/origin/…` behind until something prunes it. **The command answers _did this repository ever cache a branch containing this commit_, and it is read as _does a branch contain this commit_.**
- **That is the same shape as the defect `#121` was opened for, arriving in the control proposed to catch that defect's cousin.** A conforming run returns the reassuring answer at the moment the failure is present — and it does so **selectively for commits that were on a branch that has since been deleted**, which is precisely the population the check exists to examine. **A stale remote-tracking ref is not a weaker witness than a live one. It is textually indistinguishable from one.**
- **The discriminating pair is `ls-remote` plus content.** `ls-remote` goes to the remote and cannot be satisfied by a local cache; content (`git grep` at a named revision) does not care what any ref says. **Neither `cat-file -e`, nor `--is-ancestor`, nor `for-each-ref` can separate a live branch from a deleted one**, and the first two were already known not to.

- **And `e5a90df7` `--is-ancestor` `3fac5567` exits 1**, so the merged head is not an ancestor of the commit that merged it. **Every commit of `#162` is in the condition described as orphaned; `c4a3321` is not a special case, it is the ordinary one without the flattering cache.**

- **What was actually at risk, checked by string rather than by ancestry.** `c4a3321` adds ten lines across three files, including run G. Searched at `origin/development`: the run G entry is **present**. The sentence claiming `--is-ancestor` _"exits 1 both when the commit is not an ancestor and when the object is absent"_ is **absent** at `origin/development`, at `3fac5567`, at `e5a90df7` and at this branch's head — and present **only** in `c4a3321`.
- **The orphan's content landed except for one sentence, and that sentence was the false one.** What stands on `development` in its place is the corrected taxonomy — `0` ancestor, `1` not-an-ancestor, `128` object absent — together with the naming of the larger hazard, a script keying on `exit !== 0` reporting a rewrite that never happened.
- **And the repair of this entry exposed a positional defect in the harness that verifies it.** Run AB cites the merged head at full length, `e5a90df74722f586670e18472da5ffe3fd424ba3`, where the twins block declared the abbreviation `e5a90df7`. **A citation is matched as a string, so the two are separate citations and the short declaration did not cover the long one** — the harness was right to flag it. The first repair then failed too, for a different reason: **the twin is read as the _first_ backticked revision in the declaring row**, and that row opened with prose naming `e5a90df7` before naming the twin, which silently redirected the declaration to another unreachable revision. **No warning; the row looked like a correct declaration and pointed somewhere useless.** Fixed by ordering the twin first, and recorded because **a declaration whose referent is decided by word order is a citation format with an undocumented positional argument**.
- **The preamble count was re-derived from the rows rather than incremented**, per run Z, and the derivation immediately disagreed with the obvious number: **42 rows naming 41 distinct commits**, because two rows are one revision written at two lengths. **A row count and an object count are different quantities, and the sentence had been asserting both at once.**
- **This is the parked-draft finding of run AA with the arrow reversed, and the pair should be read together.** There, a draft held still in a session file while the correction went into the artifacts. **Here, a commit held still off the branch while the correction went into the branch.** In both cases the durable object got the truth and the detached copy kept the error, **and in both cases the detached copy was the one that looked like the authoritative original**. **Recovering an orphan on the strength of its being unreachable would have restored a retracted claim.** Unreachability is not evidence of value; it is not evidence of anything.

### Run AC — findings arrived attributed to this session that are not about its artifacts, and acting on one of them would have manufactured the defect it described

- **Three claims were put to this session as its own and none corresponds to anything it published.** The check is the branch, which is not a matter of recollection. Every commit this session has added:

```
d25cc80  run AB          99311d6  routes-by-mechanism   b6ae51c  run AA
44684e1  run Z           666e0e0  run Y amendment       43cd4c8  run Y
c1185d0  post-squash citations              2219b5e  run F warrant

c4a3321  --is-ancestor HEAD -> 1        d64704d7  --is-ancestor HEAD -> 1
```

- **Neither `c4a3321` nor `d64704d7` is on this branch**, and neither was ever published here as a head. The heads this session declared, in order, are the eight above.

- **The third claim was checkable directly, and it is false at the objects.** It reported that a pull-request body describes a traversal counting **after** the cycle guard while the file counts **before**, so that a reader checking the file against the body would re-derive a fixed bug and conclude the file was wrong. Measured in `#162`'s body and in `scripts/measure-diamond-dag.mjs` at `origin/development`:

```
file  :111  total += 1;
      :112  perId.set(id, (perId.get(id) ?? 0) + 1);
      :113  if (path.has(id)) continue;

body        total += 1;
            perId.set(id, (perId.get(id) ?? 0) + 1);
            if (path.has(id)) continue;
```

- **They agree, in that order, increment before guard.** The divergence does not exist in this pair.
- **And that is the finding worth the entry: the prescribed repair was to bring the body into line with the file, and performing it would have introduced the divergence it was meant to remove.** A remediation aimed at a defect that is not present does not no-op — **it writes the defect in.**
- **Second consecutive round in which the instructed remedy was the hazard.** In run AB, recovering an orphan "before it is collected" would have restored a retracted claim, because the only part of it that had not landed was the false part. Here, synchronising a document with its object would have desynchronised them. **In both cases the instruction was reasonable, urgent, and derived from a real rule — and in both cases the object had already settled the question in the opposite direction.** The common precondition is that neither instruction was issued from the object.

- **The general form, which this repository has already recorded about commits and is here about agents.** `.squad/decisions/inbox/ripley-attribution-carries-no-bits.md` establishes that a commit's identity fields are populated with values that look like answers and do not identify the session that produced it. **The consequence is not confined to git.** When several sessions share a role glyph, a message addressed to the role is not thereby a message about that role's work, and a finding relayed with an addressee attached carries no more warrant for that attachment than a figure copied from another rendering carries for its value.
- **A finding is a claim about an artifact. The addressee is metadata, and metadata that is occasionally right is the failure mode that decision entry is named for.** The defence is not to distrust the relay; it is that **the artifact named in a finding is the thing to open**, and opening it costs less than the round-trip.

- **This entry's own citations produced the third instance of a defect run AB recorded, which is the argument for keeping it.** Quoting the reported head verbatim as `d64704d7` did not resolve against the declaration for `d64704d`: **one character apart, same object, two citations.** Declarations are keyed on the exact string, so **every abbreviation of a revision must be declared separately, and quoting someone else's abbreviation creates a new one.** The counts were re-derived from the rows rather than incremented, per run Z, and the preamble sentence was rewritten to stop asserting that the surplus is exactly two.
- **The harness caught all three**, in an artifact whose author had just written the entry describing the defect. **That is the case for a check that runs on the text rather than on the author's recollection of the text.**
- **Separately, and adopted on its merits: a rule was offered with a misattributed instance and the rule is sound.** _Two readings taken inside one window agree because the window is one snapshot, not because the value is current._ **A stopped clock read twice is not corroborated; repetition is exactly what it has to offer.** This session's two-source discipline buys **source diversity** and has **no purchase on temporal decay**, and _sampling twice_ is the intuition that conceals the gap. Recorded in the decision entry. **The instance it came with is not this session's; the rule is kept anyway, because a rule is not graded by who its example belonged to.**

- **Measured while checking the above, and offered rather than argued:** `#162` is **merged** — `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`, `2026-08-04T19:29:29Z` — and `development` is `3bd7782814d0df22cab76dbfc6741aac68b51736`. **The value published as a correction to a stale reading of `development` was itself already superseded**, in the message establishing that stale readings are the hazard. **That is not an error to grade. It is the measurement of the channel**, and it is why this session's standing lives in the pull-request body and not in a message.

### Run AD — the merged deliverable audited from the reader's position, where one entry is present to a grep and absent to a reader

- **The pair.** The audit trail as merged onto the mainline, against the sequence of runs it declares itself to contain and cites by name. Read at `16aa3d289c93b40a8cd47dcf29cfe6e70d5a640f`, the value `git rev-parse origin/development` returned at `2026-08-04T22:23:45Z`. **Verdict ❌ against the pair. Repaired in this commit.**

- **Every artifact #162 claimed to deliver is present at that head; the thing that would run them is not.** Eight paths confirmed by blob — the three measurement scripts, both test files, the policy, this trail, and the staged `citation-reachability.workflow.yml`. **`.github/workflows/citation-reachability.yml` is absent.** The check #121 exists to install therefore still has **no invoker on the mainline**, which is the condition run P named and the mechanism that let run X's squash damage pass unremarked: **a mainline whose check never ran is exactly the colour of one whose check passed.**

- **The finding: run K's entry does not begin a line.** It is spliced into the interior of run J's closing paragraph, at column 853, with no line break before it. `git grep` finds every word of it, so a check that reads content returns clean. A Markdown reader is served something else — the bullet never becomes a list item and run K renders as a run-on continuation of another run's text. **The entry is simultaneously present to the instrument and absent to the reader**, and runs L and M both cite run K by name, so a reader following those citations arrives at an entry that exists only as a fragment of the entry above it.

- **This is run R's finding arriving on document structure instead of git reachability.** There the harness asserted reachability-by-the-reader and measured reachability-by-its-author; here the ledger is checked for the presence of text and read as a sequence of entries. **In both cases the artifact satisfies the predicate that was actually evaluated and fails the one the reader depends on**, and in both the gap is invisible from the position that built the check.

- **My own probe was wrong in both directions before I had read a single hit.** A line-anchored scan for the entry marker reported run K **MISSING** — a defect I was one step from reporting against a correct artifact. A content scan for `run K` then reported it **PRESENT**, at two hits, both of which turned out to be **references from runs L and M** rather than the entry itself. **A false negative from the structural pattern and a false positive from the content pattern, on one object, with the truth at neither.** It resolved only by reading the hits in full, which is this file's own step-2 rule, and the reading is what located the missing newline. **A pattern is a rendering, and two renderings disagreeing is the check working — the failure would have been to trust whichever ran first.**

- **The general result, and it is why the two checks cannot substitute for each other.** A structural check cannot see a content defect and a content check cannot see a structural one, and **this ledger had only ever been checked by content** — by greps for figures, phrases and citations, never once for whether its entries are entries. The defect survived twenty-nine runs, a squash merge, and every gate in CI, because prettier accepts the line, the harness resolves the citations inside it, and no test reads the document as a list.

- **Control, and it came free.** The detector reported **19 markers at line start and 1 mid-line** in a single pass, so the instrument demonstrably returns both answers on this corpus and a count of zero would have meant something. After the repair: **20 markers, 0 mid-line**, prettier clean, three lines inserted and one removed.

- **Also measured, and disclosed rather than repaired: there is no run U.** The sequence runs T then V, on the mainline and here, and no entry with that label has ever existed. Nothing is lost, but **a gap in a labelled sequence is indistinguishable from a deleted entry**, and the reader who notices it has no way to learn which it is. Recorded here so the absence has a citable cause.

### Run AE — the standing block published a figure it never re-derived, and it stayed plausible by coinciding with a different real quantity

- **The pair.** The `Standing` block in this pull request's body, against the check-run state it reports. Both read at `2026-08-04T22:41:57Z`. **Verdict ❌ against the pair. Repaired at the cause rather than the value.**

- **The figure.** The block asserted `CI  9 of 9 check runs success`. Measured across six consecutive heads of this branch: `44684e1` **9**, `b6ae51c` **10**, `99311d6` **10**, `d25cc808` **10**, `5dfd6940` **11**, `ca860c71` **10** — nine distinct check **names** at every one of them, with `PR closure scope` registering two or three runs. **The claim was true at the first head and was carried unchanged through four subsequent pushes**, none of which re-measured it.

- **Why nothing caught it, and this is the part worth keeping.** The stale figure was numerically equal to the **distinct-name** count, which really is nine and really is stable. **A wrong number that coincides with a different true quantity is not falsifiable by inspection** — it survives every reading that does not re-run the query, because it looks exactly like the right answer. That is run Y's numeral collision arriving on this session's own instrument: **the token was correct and the referent was not.**

- **The mechanism is a distinction the output does not render.** The script that maintains this block queries the API for `head`, the read time, `state`, `draft`, `mergeable` and `mergeable_state`, and **held the CI line as a string literal**. Derived fields and typed fields are laid out identically inside one fenced block, so **a reader cannot tell which values were measured and which were asserted, and neither could the author** — the one hard-coded line sat in the middle of five live ones and inherited their credibility.

- **The general result, and it corrects a remedy this session adopted three rounds ago.** _Put standing in the pull-request body, the only artifact that survives the channel_ solved **transport** and said nothing about **re-derivation**. **Moving a claim into a durable artifact makes it survive; it does not make it true**, and a stale claim in a durable artifact is worse than a stale claim in a message, because it accrues the artifact's authority and is re-read by people who were not present when it was written. **Durability and currency are independent properties and the fix for one is not a fix for the other.**

- **Repair.** The CI line is now computed from `commits/<head>/check-runs` at the moment the block is written, and it reports **both** quantities — runs and distinct checks — because the entire defect was one of them standing in for the other. Pending and non-success runs are counted **separately** rather than collapsed into a pass/fail, per run AA: a check that has not finished is not a check that failed, and a boolean cannot hold that difference.

- **Control.** The same instrument over the six heads above returned **9, 10, 10, 10, 11, 10** — it demonstrably returns different values on this corpus, so a constant reading would have carried information. **A figure that has never been observed to move is not thereby stable; it may be one that was never re-taken**, and those two are indistinguishable from the figure alone.

- **Amendment, measured after the repair landed and it identifies the cause: the act of publishing the figure is what moves it.** The derived line reported `10 runs / 9 names - 1 not success, 1 pending` within seconds of a run that had been `9 ... all success`, which is the movement the hard-coded value had been concealing. The mechanism is that **`PR closure scope` fires on `pull_request: edited`** and every other check fires only on push. At the current head: the push at `22:47:36Z` started nine runs between `22:47:43Z` and `22:50:14Z`, one of them `PR closure scope`; two subsequent edits of the pull-request body started `PR closure scope` **alone** at `22:56:33Z` and `22:56:47Z`. **The other eight checks are the control arm and they did not fire.**

- **The series has a changepoint exactly where this session adopted the remedy.** `666e0e0` and `44684e1` carry **9** runs with one `PR closure scope`; `b6ae51c` — the first push after standing was moved into the pull-request body — carries **10** with two, and every head since carries ten or eleven. **The block was introduced to make standing durable, and its maintenance is what made the quantity it reports unstable.** The figure was then published as a constant.

- **So this is a measurement taken from inside the population it measures**, which is the defect run I recorded when writing an entry about a figure changed the count of that figure. It is worse here in one respect: there the author's edit changed a corpus the author was reading, and **here the act of reporting the value is the event that increments it**, so the number is guaranteed stale the moment it is written and cannot be made current by re-reading. **The honest form names the reading as of the moment before publication**, which is what the derived line now does by carrying the timestamp beside it.
- **The repair's own gate then caught a third thing, and it had been there for four rounds.** The script that maintains this block wrote its API payload to `.b.json` **in the repository root**, untracked, on every run. `prettier --check .` fails on it, so had it ever been swept up by a `git add -A` it would have turned the branch red on a file no reviewer could account for — and it carries the pull-request body, which is content, not scratch. **A tool that reports on a working tree should not write into it**; the payload now goes to the system temporary directory. **Nothing detected it for four rounds because every commit here was made by naming paths explicitly**, which is a habit rather than a control, and habits are not visible to the next person.
- **Observed while writing this, and it is the same shape one field up:** `mergeable` read `null` at write time and `mergeable_state` read `unknown` — GitHub had not finished computing them. **`null` is a third value, not a false**, and any reader testing it truthily gets `CONFLICTING` and `not yet known` as one answer.

### Run AF — two reports, one source, and a fourth exit value that disables the pre-check written to rescue the third

- **The pair.** Two cross-session reports of #162's state, against #162. Read at `2026-08-04T23:10:04Z`. **Verdict ❌ against both reports; the artifact is correct.**

- **Both reports say `OPEN` at `d64704d7a4c74dcf5dd9373e1ed7b87571e894ab`. Two GitHub code paths disagree with them and with nothing else.** REST `pulls/162` and the GraphQL view both return **`MERGED`**, `merged_at` `2026-08-04T19:29:29Z`, merge commit `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`, head `e5a90df74722f586670e18472da5ffe3fd424ba3`, closing #121.

- **The reported SHA is real and was genuinely this pull request's head.** `d64704d7` is an ancestor of `e5a90df7` — exit **0** — and was committed at `11:21:44-07:00`, fifty-one minutes before the merge base commit and sixty-eight before the merge. **Both reports were true when taken.** What neither carried is when that was.

- **The finding, and it is the one this round is for: agreement between two reports is evidence only if the reporters are causally independent, and a report does not disclose its provenance.** Two messages from two sessions carrying the **identical superseded value** is the signature of **one upstream reading relayed twice**, not of two readings that agree. **This is the snapshot rule one level out:** run AE established that two readings inside one window are one snapshot; **two reporters drawing on one source are one reader**, and the second arrival adds confidence without adding information.

- **The second report attached the word _verified live_ to a value roughly four hours stale.** A freshness assertion is **metadata**, and run AC already recorded what metadata is worth here: **a field that is occasionally right is the failure mode, because it is trusted in the cases where it is wrong.** The remedy is unchanged and cheap — **open the artifact the report is about.** Two API calls settled this one.

- **A fourth exit value, measured while checking the above, and it is not in the taxonomy this squad has adopted in six files.** `git merge-base --is-ancestor` and `git cat-file -e` return **0**, **1** and **128** as recorded — and **129 for a malformed invocation**, which means _the command never ran_ and is a different fact from _git could not answer_.

- **It arrives from the prescribed remedy itself, on the shell this repository is built on.** The guard written to disambiguate 128 is `git cat-file -e <sha>^{commit}`, published unquoted. Measured on PowerShell:

  ```
                          real object   absent object
    unquoted                  129           129
    quoted                      0           128
  ```

  **Unquoted, the pre-check returns the same code for a present object and an absent one** — it destroys exactly the distinction it was added to make, and it does so silently, because `129` is non-zero and every caller in the published examples tests non-zero. **A control that can only return _cannot tell_ never fires and never alarms, which is indistinguishable from a control that passes.** That is #121's shape arriving inside #121's own remedy, two corrections deep.

- **The general form: an exit-code taxonomy is a property of the tool _and_ the shell that invokes it, and every rendering of it in this repository states only the tool.** The documents give the argument bare; `^{commit}` survives one shell and not another. **A rule that is true of a command is not thereby true of the line someone will paste.**

- **Recorded but not repaired here, because they are not this session's files.** The three-valued taxonomy appears in five further notes under other authors. **The correction propagated faster than its verification**, which is itself the pattern this ledger keeps finding: a fix is copied because it is right about the thing it names, and nobody re-runs it.

- **Fourth instance of the string-keyed citation defect, produced by this entry, and the harness stopped the commit.** The report gave the head at full length and **this entry quoted it verbatim**, which does not resolve against the declarations already standing for `d64704d` and `d64704d7`. Exit **1**, one orphan, no verdict published. **Every previous instance of this defect was created the same way — by copying someone else's abbreviation — and that is now four for four.** Quoting a revision is not citing the one already declared; it is minting a new citation that happens to denote the same object. Declared as a twin of `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` rather than as unreachable, **because its content is on the mainline and a twin is the true statement**; counts re-derived from the rows per run Z, now **44 rows naming 41 distinct commits**.
- **The positive result, since a run that only reports errors is not a check.** `d64704d7`'s content fully survived the squash: `scripts/check-citation-reachability.mjs` is **byte-identical** on the mainline, and all **six** lines it added to this trail are present there. **None of that branch's commits exist as objects on the mainline and all of its work does** — which is what a squash means and why content, not ancestry, is the question worth asking.

### Run AG — the reproduction that exonerates, and an issue whose title is an instance of its subject

**Pair: the mechanism reported in issue #291 against this session's own published exit code, and against every exit-code read in this repository. Grade ⚠️ / resolution: the reported mechanism is confirmed, the shipped code is unaffected, and the reproduction naturally offered for it is a false negative.**

Issue #291 reports that `$LASTEXITCODE` is stale after `Select-Object -First N`, **including a failure reported as success**. It names the mechanism behind the false exit code this ledger corrected in run G, filed independently and before this run looked.

**The first reproduction cleared the idiom on every arm.** A command exiting 7 piped to `Select-Object -First 2` returned 7; so did `-First 3` after fifty lines, and so did `Select-String` into `-First 1` — six arms, six correct. The command had already exited by the time the pipeline stopped, so there was nothing left to abandon. Re-run against a producer emitting slowly, with a `0` pre-loaded from a prior success, the hazard arm returned **0 for a command that exited 7**, while `-Last 3` and the unfiltered control both returned 7. **The discriminating variable is the producer's duration, not the cmdlet** — and the natural way to test a claim about a shell idiom is to reach for a fast command, which is the one stimulus that cannot expose it. Same shape as the harness that agreed with its object on every published figure because the fixture never reached the disagreeing branch, and as the mutation control that could not distinguish an ineffective mutation from an inert test: **a stimulus too weak to elicit the defect returns the reassuring answer, and that answer is indistinguishable from a pass.**

**The elapsed time is a free discriminator and needs no trust in the number under test.** The abandoning arm returned in 0.18s where the draining arms took 3.3–3.9s: a stale exit code carries a time signature, because the pipeline returned before the producer could have finished. That detector is available precisely when the exit code is the thing that cannot be trusted — the general form being that **a corrupted reading is often still constrained by something other than itself**, so a second observable is worth more than a more careful reading of the first.

**Stages measured against one slow failing producer:** `Out-String`, `Out-Null`, `Measure-Object` and `Select-Object -Last N` all drain and report 7; `Select-String` into `Select-Object -First 1` abandons and reports 0. **This ledger's own gate readings all used `-Last`**, so the published prettier, eslint, tsc, harness and vitest figures are warranted — stated as a measured result rather than an assumption, since the defect is the same idiom one word different.

**The shipped code is not affected, and the negative is the useful part.** Every tracked file was scanned rather than sampled. The Windows signing guard in `.github/workflows/release.yml` reads the variable with no pipeline before it. The SignTool verification guard in the same file does pipe — `2>&1 | Out-String` — and it gates Authenticode verification, so it was measured rather than reasoned about: **sound, because `Out-String` drains**, with the abandoning arm run in the same session as its control. `Select-Object` occurs elsewhere in tracked files only as property selection and inside prose describing this bug. **A control arm is what makes this a result instead of an absence of findings.**

**The issue's stored title is an instance of the phenomenon it reports.** It begins with the bytes `92, 48` — a literal backslash and the digit zero — so the token naming the variable was interpolated to `0` at filing time. The mechanism reproduces byte-for-byte: a backslash before a dollar is a **bash** escape, PowerShell does not treat the backslash as an escape character, so the backslash survived literally and the variable still expanded. **The issue reporting that the variable holds a stale `0` has, in its own title, that variable replaced by a `0`.** Not a coincidence but the same class as the bug: **an idiom correct in one shell and silently wrong in another** — the class run AF met when `git cat-file -e` with an unquoted commit-peel suffix returned `129` for both a present and an absent object, collapsing the distinction the pre-check exists to make. The cost is that the issue is unsearchable for the token it is about. **Not edited — not this session's artifact**; the correction was reported with replacement text as `issuecomment-5185780251`.

**And writing this entry reproduced the class a third time, in a third language.** The paragraph above was inserted by a script whose replacement text contained a dollar immediately followed by a backtick, which in a JavaScript replacement string means _the entire portion of the subject before the match_. The insert silently duplicated about 150KB: the file went from 154,898 to 304,175 bytes. **Every structural check this ledger owns passed on it** — the new heading was present, the anchor was present, and the mid-line-marker detector built in run AD returned zero. It was caught by `git diff --numstat` reporting **307 insertions for a fifteen-line entry**. Two results. **A size or line-count assertion is a control that no content check and no structural check subsumes**, because it is the only one that can see material nobody wrote; it is now run before every scripted edit here. And the escape hazard is not a property of a shell but of **any interpreted replacement**, which is why stating it as _bash versus PowerShell_ was already too narrow at the moment it was written — the repair is to pass a function, which disables substitution entirely, exactly as quoting the commit-peel suffix does.

**Recorded against this ledger rather than the filer:** run G's correction was published here in three places and the mechanism behind it was left as a one-line aside, so a defect this repository had already met was available to be met again by someone else. **A correction states what the right answer is; it does not thereby publish the failure mode that produced the wrong one**, and the failure mode is the reusable part.

### Run AH — the chartered check run on an instruction, and a gap in the review this remedy was required to have

**Pair: an instruction delivered over a cross-session channel, granting this session standing merge authority over its own pull request, against the rule as recorded in the repository. Grade ⚠️ / resolution: the pair disagrees, the artifact governs, and the authority was declined.**

**Run symmetrically, which is the point of the policy this branch exists to change.** Neither side was designated the authority in advance. The message is the more recent statement of intent and comes from the dispatching role; the artifacts are versioned, reviewed and diffable. Both were read before either was preferred.

At the head, `.squad/skills/git-workflow/SKILL.md` carries the heading **Do not merge your own work** and one sentence beneath it: _"Authors do not merge. The Technical Lead owns review and merge, gated on unanimous reviewer approval plus green CI."_ **There is no exception clause, and it names a gate** — which this pull request fails, its review list being empty. `.squad/decisions.md` requires, in the entry that created this work, that the remedy **be reviewed by someone other than the fact-checker**; `.squad/skills/agent-collaboration/SKILL.md` instructs that delegates must not self-merge. **Three artifacts, one direction, no qualification.**

**Resolution, and it is the general rule this branch has been arguing for from the other end: a rule recorded in a versioned artifact is not amended by a message.** A claim in a file has one canonical location and a review history. A claim in a message has as many locations as it was read in and no history at all. **If the rule should change, the change belongs in the file, where it can be reviewed** — and the reviewing is precisely what a grant of self-merge dispenses with, so accepting it by message would remove the control and the record of its removal in the same act. **The refusal is recorded in the pull request body rather than only in a reply**, because a refusal that lives in a channel is not auditable, and the artifact showing an author decline is worth more than the assurance that they would.

**A second reason, narrower and sufficient on its own: the grant was scoped to a pull request that had already merged** — it arrived attached to a ruling that that pull request should be merged rather than rebased, some hours after it merged. **An authority over a closed pull request does not extend to a different open one by being restated later.**

**The instrument that produced the underlying error is the one this ledger already convicted, failing the other way.** The claim that a third party was rewriting this branch rested on `for-each-ref --contains` listing a `refs/heads/` entry for the superseded branch. **That ref is local and stale: the upstream branch was deleted at merge, and `ls-remote` for it returns empty and exits 0.** Run AB recorded this command under-reporting deletion; here it **over-reports containment**, from the same cause. **A ref store is a cache, and a cache answers questions about itself in the grammar of questions about the world.**

**And the check turned up something larger than the item it was run on.** The pull request that landed this branch's remedy shows `merged_by` as the human account. Another author's note in this repository already records that this field cannot distinguish an agent from the human whose token it holds, and records a reviewer drawing a false conclusion from exactly that field. **So that merge does not establish that the remedy received the independent review its own decision entry requires** — and the requirement was not incidental, it was the condition attached to the remedy at the moment the defect was diagnosed. **The obligation is open, not discharged, and no artifact currently says so.** Recorded here because a requirement that is believed satisfied is worse than one known outstanding: the first is invisible and the second is merely undone.

**Recorded as an exercise of the check, not only as a finding.** The defect this branch was opened for was that the chartered comparison was scoped one-directionally and had never been run on a real pair. **This entry is that comparison, run without an authority, on a live disagreement, against the party that dispatched it, resolving against the more recent and more authoritative-sounding side.** A symmetric check that never resolves against the instruction is not symmetric; it is deference with a procedure attached.

### Run AI — a divergence confirmed live against a mainline that no longer holds it

- **The report and the object disagree, and the object is checkable.** A confirmation arrived stating run D's divergence was
  _"real on trunk right now"_, quoting `docs/security/THREAT_MODEL.md` as reading _"in #68 a 29-node diamond DAG expanded to 32,767 rows"_,
  one hit against two on this branch. Measured at the mainline read by ref name at the moment of writing: **that sentence is absent from
  the file**, which reads _"expanded to 49,150 rows"_. **Positive control run over the same space first** — `expanded to 49,150 rows`
  returns four files, so the search was live and the zero is a zero rather than a broken pattern.
- **Every remaining occurrence on the mainline is a mention.** The decision log quoting the historical defect; three entries in this
  ledger, one of which is the entry recording the repair; a comment in `tests/measurementScripts.test.ts`; and — the sharpest —
  `tests/documentedDiamondDagFigures.test.ts`, where the sentence is bound to `const wrong` because the file's whole purpose is to
  hold the false claim in order to guard against it.
- **The hit-count difference was real and meant the opposite of what it was read as.** This branch carries _more_ occurrences than the
  mainline, and that is because it carries more **mentions** of a defect repaired on both sides. Counting scored the better-documented
  side as the defective one.
- **A repository that guards against a false sentence must contain that false sentence.** So the count of a wrong rendering is
  **anti-correlated with correctness** exactly where the discipline is strongest: the more thoroughly a claim is refuted, pinned and
  regression-guarded, the more copies of it the tree holds. **Presence of a sentence is not assertion of it, and no refinement of the
  pattern recovers the difference** — only reading the hit does.
- **The rule this needed already existed and was not applied.** Procedure step 2 requires that hits be read rather than counted and names
  the retraction as the worst case. **What failed was not a missing rule but an unapplied one**, and it failed for the party who had
  restated the rule in the same message — which is the ordinary way a known trap is fallen into.
- **A defect of mine in the same corpus, reported without a causal claim.** This ledger carried an unscoped present-tense
  _"remains the single unrepaired third rendering"_, superseded by its own closure entry further down the same file, both live on the
  mainline. **Whether that sentence is what was read is not established and is not asserted here.** It is a hazard on its own terms: a
  superseded present-tense claim sitting in the corpus a checker greps will be found by any reader who stops at the first hit. Annotated
  in place this round.
- **A second instance, in my own artifact, found while verifying the first.** The pull request body for this branch carried the
  test count twice — `1978 passed in 94 files` in the standing block, which is re-derived at every push, and `1976 passed in 94 files`
  in a validation section written once and never re-run. **Two renderings of one quantity inside one document, disagreeing**, in the
  body of the pull request whose parent was opened about exactly that. Neither was treated as the authority; the object was measured
  (**1978**) and the duplicate removed rather than corrected, since a second copy that agrees today is the same hazard one push later.
- **It was found by reading, and no check here could have found it.** Every instrument on this branch compares an artifact against a
  revision, a script, or another file. **Nothing compares a document against itself**, so an internal disagreement is invisible to all of
  them — and a pull request body is exactly the kind of artifact that accretes figures written at different times under one heading.

- **A third instance, in the apparatus, while reporting the first two.** Publishing this run's finding used
  `gh api -f body=@<file>`. **`-f` never reads a file.** It posted the thirty-nine-byte literal string `@C:\…\c.md` as the
  comment body and the call returned **201 with a comment URL**. Exit zero, a URL, a comment that exists — **every observable reported
  success**, and the only instrument that could tell was reading the artifact back, which was not part of the procedure. Repaired in
  place rather than deleted, so the failure and its repair share one address.
- **That is the same shape three layers apart in one run:** a count that reported the reassuring answer, a document that disagreed with
  itself, and a publishing call that reported success for a no-op. **Reading the artifact back is the only check common to all three**,
  and it is the one routinely skipped because the tool already said it worked.

- **Grade: ❌ against the report, ✅ unavailable for the pair.** The two renderings of the diamond-DAG row total agree at the mainline,
  but they agree because one was repaired to match the other by a commit named in this ledger — a **discharge**, not independent
  convergence, so it resolves without earning ✅.

### Run AJ — the symmetric check firing on code, and finding the mainline red

- **Found by the discipline, not by the assignment.** A push carrying nine lines of Markdown turned two required contexts red. The
  hypothesis _"a Markdown commit cannot break a type-check"_ is the reassuring one, so it was measured instead of assumed:
  `tsc --noEmit` on this branch exits **0**, the failing file is **absent** from this branch and **present** on the mainline, and the
  mainline's own head is red on **the same two contexts at the same step**. The red is inherited from the base.
- **Two renderings of one interface, each correct where it was written.** `tests/bedClearConflictClassification.test.ts` calls
  `.toApiError()` with no argument; `src/main/calibrationHttp.ts` declares `toApiError(reference: string | null)`. At
  `62e8808` the method took **no parameter** and the test was right — and `Desktop` passed on both platforms there. At `eb68310`
  the parameter became required and every call site that commit could see was updated. **`62e8808` is not an ancestor of
  `eb68310`**, so neither branch ever held the other's rendering.
- **This is the check's own subject matter, on source instead of prose.** Neither file is the authority. There is no textual conflict,
  no commit is red in isolation, and every gate is a function of one tree — so the disagreement exists only in the union, which is the
  one artifact nobody's CI evaluated until a third party's merge produced it. **A one-directional check would ask whether the test
  matches the implementation and get an answer; the symmetric form asks whether the pair agrees and gets the same answer without having
  to choose a side first** — which matters here precisely because the correct side is a judgement the checker is not entitled to make.
- **Reported, not repaired, and the mechanism left open.** Branch protection measures `strict=true` with both failing contexts
  required, which is the control that should make this impossible. **That the two commits are unordered and that the mainline is red are
  established; how the second one merged is not, and is not guessed at.** A stated open question is falsifiable by whoever holds the
  merge history; an invented mechanism attached to a correct outcome is still a fabrication, which this ledger has recorded before.
- **Grade: ❌ against the pair, at the mainline.** Resolution: filed against the artifacts, with the repair belonging to the owner of
  the two commits rather than to the checker.

### Run AK — a red mainline traced to one merge, where the loud half and the quiet half were repointed unequally

- **Pair.** The two `Release package` contexts on `development` against the commits that made them red — a source-and-CI pair, not a prose pair, and the second consecutive run in which the symmetric form fires on something other than documents.
- **Finding.** `development` is red on `Release package (windows-latest)` and `Release package (macos-latest)` at step `Packaged accessibility (material WCAG A/AA)`, and has been for **sixteen consecutive merges**. The last commit green on both these and the `Desktop` contexts is `8862ce5c`; the next mainline commit `6b94e56b` (merge of #322) is red on all four. Filed as #393; the `Desktop` half was already #389, and #389 was updated with the pinned transition.
- **Cause, and it is a correct product change with an unrepointed test.** #322 stopped the backend `ProblemDetails` body reaching the renderer — deliberate, and named in its own commit subject. Its companion commit repointed the assertions that encoded the removed behaviour: **nine files under `tests/`, and zero under `e2e/`**. The packaged end-to-end fixture still injects `Network timeout` as a backend detail and still asserts it renders. `tests/` runs under `Desktop`; `e2e/` runs under `Release package`. **One behaviour change, two test populations, one of them repointed.**
- **The general form.** A repointing commit is scoped by whatever the author enumerated, and **the enumeration is invisible in the result** — nine repointed files and eleven repointed files produce identical diffs to every reader who does not already know the denominator. This is the _unit of enumeration_ finding arriving on a repair rather than on a count, and it is worse here than in prose: the unrepointed population lives in a different runner, so the author's own local gate cannot reach it.
- **The failing assertion is a positive control, and it is the reason any of this was legible.** The error is `POSITIVE CONTROL: the fetch error is not rendered, so this is not the co-render state` — the test refusing to run its real accessibility assertions because it could not establish its own precondition. **Had that control been absent, the co-render assertions would have run against a state that was never reached, and this ledger has recorded twice what such a test reports: not a failure.** A control that fires is cheap to read and expensive to omit; this one converted an eleven-word symptom into a two-commit cause.
- **A hypothesis tested and abandoned.** Before measuring, this run supposed the two failures shared a cause via a renderer change in `eb68310`. `git show eb68310 -- src/renderer` is **empty** — that commit touches no renderer file, and the hypothesis is unsupported. The failures _do_ share an introducing merge, by a different mechanism than the one guessed. **Recorded because the guess was wrong in its mechanism and right in its conclusion, which is the combination that survives unexamined.**
- **What is not established.** How sixteen merges landed on a mainline red on required contexts, with branch protection reading `strict=true`. Stated as open in both issues rather than reconstructed. Same posture as run AJ, and for the same reason: the outcome is measured and the mechanism is held by the merge history, which this ledger does not hold.
- **Grade: ❌ against the pair, at the mainline.** Resolution: filed against the artifacts (#393, and #389 amended); the repair belongs to #322's authors, who alone know what the renderer is now specified to surface in that state. **No replacement assertion was proposed** — guessing it would encode a second wrong assertion in the file being repaired.

- **Addendum — the apparatus reporting run AK misreported it, in the accusing direction.** The Standing generator was extended this round to _derive_ whether a red check is this branch's fault, by comparing failing check names at the head against the same names at the base. Its failure filter was `!['success','neutral','skipped'].includes(conclusion)`. **A run still in flight reports `conclusion: null`**, which satisfies that filter, so six pending checks were scored as failures and two of them were published as _"NOT reproduced at the base and therefore this branch's."_ Both claims were false; the checks had not finished.
- **The general form, and it is the fourth instance on this branch: a multi-valued status collapsed into a boolean.** `--is-ancestor` has four exit values and `if (!ok)` collapses them to two; `$LASTEXITCODE` after an abandoned pipeline holds a value not under test; `git cat-file -e` unquoted returns one value for two conditions. **Here a three-valued check status — pending, passed, failed — was read as passed-or-not.** Each time the collapse is invisible because the collapsed value is a legitimate member of the surviving category.
- **What is new is the direction.** Every previous instance failed _toward reassurance_ — the direction nobody rechecks. This one failed toward **self-accusation**, and was caught within two minutes precisely because a claim that one's own branch broke something is the claim its author reads hardest. **The detection latency of a false report is a function of whom it embarrasses, not of how false it is** — which is the argument for deriving the attribution at all rather than asserting it, since an asserted "inherited" would have failed in the comfortable direction and survived.
- **Repaired at the cause**, not the output: only `status === 'completed'` runs can fail, and **no attribution is offered at all while anything is pending**, because a pending check at one head and a completed one at another are not a comparison. Verified against live data with runs still in flight — the false sentence is absent and the pending count is stated instead.

### Run AL — the sentence I was about to assert became false while I was writing it, and only a derived instrument noticed

- **Pair.** The failing checks on this branch against the failing checks on the mainline — the same source-and-CI pair as run AK, re-read one hour later, which is the only reason this entry exists.
- **What was about to be published.** Run AK established that all four red contexts reproduced at the mainline head, and the intended Standing sentence was _"all four failing checks are inherited; none is caused by this branch."_ True when measured. **By the time it was published, `aed0835` and `5d055cf` had repaired the `Desktop` half on trunk** (#389), so two of the four had stopped being inherited and had become this branch's — curable only by merging, since this branch predated the repair. **A static sentence would have been false in the comfortable direction, and the comfortable direction is the one nobody rechecks.**
- **The finding.** The generator was changed this round to _derive_ the attribution — read the failing check names here, read them on the mainline, compare — rather than assert it. **The derived form contradicted its author within the hour and was right.** This is the strongest available argument for the rule this ledger has been repeating: a claim that is computed each time it is read cannot go stale, and a claim that is true when written has no mechanism that keeps it true. **The difference is invisible in the output**, because both render as the same English sentence.
- **The instrument failed twice first, and the second failure is the instructive one.** Its failure filter scored any run whose `conclusion` was not `success` as failed, which counts a **pending** run — `conclusion: null` — as a failure. Repaired on the near side. **The identical defect remained on the far side**: the mainline tip is frequently mid-CI, and an incomplete comparand yields an _empty_ failure set, which reads as _the mainline is clean_ and silently attributes every inherited failure to this branch. **It then did exactly that**, naming all four. **A fix aimed at the instance rather than the class leaves the same defect in the mirror position**, and the mirror position is the one not being watched because the bug was just fixed. Repaired by walking back to the most recent mainline commit whose runs have completed, and naming which commit that was.
- **A repair can be red, and the redness can be about something else.** `aed0835` fixed the type error and its `Desktop` contexts still concluded `failure`, on formatting; `5d055cf` applied prettier and they went green. **Verifying a fix by reading the fix commit's colour returns "not fixed"** — same context name, same colour, different step. Confirmation requires the failing _step_, and the commit _after_ the one carrying the fix.
- **What did not change.** `Release package (macos-latest)` and `(windows-latest)` still fail on the mainline at every fully-checked commit read this round. #393 is open and unrepaired; #389 is closed with its evidence.
- **Grade: ❌ against the pair, partially discharged.** Two of four cleared by merging the mainline repair — **by merge, not rebase**, since a rebase here is measured at ORPHAN 33 against ORPHAN 0. Two remain, they are not this branch's, and the Standing block now says which are which by deriving it rather than by claiming it.

### Run AM — a required context decided by a sentence, and one commit holding both verdicts

- **Pair.** `Desktop (windows-latest)` at `c585d0e` concluded `failure`; `Desktop (macos-latest)`, at the same commit, concluded `success`. The failing step is `npm run check:closing-references`, which reads the pull request **body** — a mutable object — and records its verdict against an immutable commit.
- **Measured, one variable.** The windows job started `01:37:16Z` and logged `declared=[] armed=[121] reads=12`; the body was edited at `01:45:20Z`; the macos job started `01:47:05Z` and logged `declared=[] armed=[] reads=13`. Re-running the windows job at `01:55:43Z`, with no change to the tree, concluded `success`. **The same context name now holds both conclusions on one commit.**
- **The reading the report invites is wrong.** A red windows context beside a green macos context on one commit names a platform-specific defect, and platform is the only discriminator either name offers. The discriminator here is the **clock**, and it appears in no field of either report.
- **Direction.** A required _code_ context was turned green by editing prose. Nothing re-evaluated the code, and nothing could have: the tree never moved.
- **The gate's subject is this ledger's subject.** It arms on a closing keyword near an issue reference and cannot separate use from mention — its own failure text concedes it, warning that the parser does not read negation. #328 does not close #121; #162 did. So the repair is to mark the reference as a **mention**, not to declare a closure that will not happen. **Declaring it would have made the check green by making the pull request false.**
- **Repaired at the cause, because the body is not the cause.** The body is regenerated on every push, so a hand-edit to it is overwritten by the next round. The generator now reads the gate back after publishing. It does **not** model the armed set: that set is computed by GitHub from the body it then holds, and a local re-derivation would be **a second rendering of the gate's own rule, free to agree with the gate while both are wrong** — the defect this issue is about, installed in the guard against it.
- **Three-valued, and controlled.** `PASS` / `FAIL` / `UNDECIDED`, with an unsettled read and a gate that never ran both mapping to `UNDECIDED` rather than to a pass. Four arms were exercised by substituting the command the guard spawns — clean, armed-undeclared, unsettled, absent — each producing a distinct verdict and the three non-clean arms a non-zero exit. **A guard whose failing arm has never been observed is run AA's finding repeating.**
- **Grade: ❌ against the pair, discharged.** `Desktop` is green on both platforms at `c585d0e`. `Release package (macos-latest)` and `(windows-latest)` still fail, in `e2e/calibrationA11yTests.ts`; they fail identically at the base commit this branch merged, and they are #393.

### Run AN — a defect and the guard that replaces it are the same number

- **Subject.** Run D's defect was `docs/security/THREAT_MODEL.md` § _T2.2_ rendering the diamond-DAG row count as a **total** of `32,767` where the measured total is `49,150`. It is closed on `development` by `c8d379ff0dfd06095defb36792b8b1d1393bdd41`, by someone other than this author, as recorded above.
- **Measured across the whole tree**, the string _"expanded to 32,767"_:
  - at `c8d379ff^` — **2 hits**: `.squad/decisions.md` (quoting an earlier state) and `docs/security/THREAT_MODEL.md` (**asserting it** — the live defect).
  - at `c8d379ff` — **2 hits**: `.squad/decisions.md` (quoting) and `tests/documentedDiamondDagFigures.test.ts` (`const wrong = …`, the new guard's negative control).
  - at `origin/development` when read for this entry — **7 hits, none asserting it.**
- **The count does not move across the commit that fixes it.** `2 → 2`. That commit is `4/2` on the threat model and `275/0` on a new test file: **the defect was replaced, one for one, by the test that prevents it.** The two hits at each end are maximally different in meaning and identical in arithmetic, and no operation on the total can separate them.
- **A monitor on that number reports nothing at the only moment it mattered**, then a sevenfold rise afterwards as the repository accumulates discussion of the repair — a rise that means the corpus is getting _safer_. **The metric is not merely noisy; at the transition it is exactly flat, and afterwards it is anti-correlated.**
- **Argued first, then observed.** This ledger's rule that occurrence counts must never be compared across corpora was argued in this pull request before it was measured. Here it is measured across _time_ on one corpus, which is the same fault with the two populations separated by commits instead of by refs. The other order — observing, then constructing the rule that fits — proves nothing.
- **The reviewer's contrary reading was true when it was taken, and is not a false confirmation.** It reported the divergence live on trunk, single hit, and the repair landed **twenty minutes later**: `c8d379ff` is dated `2026-08-04T12:01:03-07:00` and the reading precedes it. **Checked before being characterised**, because the available inference — that a confirmation contradicted by the object was wrong when made — is the one this ledger exists to refuse.
- **Classified by reading all seven, not by counting them.** Use versus mention is not computable from the total, which is the whole content of the entry.
- **Verdict: run D discharged at the object, both sides.** No ✅ is claimed here: the artifacts agree now, and this entry's own result is that agreement established by counting would not have been evidence that they do.

### Run AO — my own filed mechanism, refuted by the repair, in the direction that deletes a working check

- **Subject.** #393, filed from this branch, located the `Release package` failure at the pair `e2e/helpers/calibrationA11yFixture.ts` / `e2e/calibrationA11yTests.ts` and named the mechanism in its title: #322 _"left the packaged-e2e assertions encoding the behaviour it removed."_
- **The repair says otherwise.** `01316a8212ce24dd3660ceb3eef2b1498d89a85c`, `2026-08-04T18:55:20-07:00`, one file, `7/3`: it **keeps** the assertion and gives the fixture's error objects the `reference` field that #322 had made required, with `satisfies CalibrationGetQueueStateResponse` to hold it there. **The behaviour was not removed on this path. The expectation was correct throughout, and the stale artifact is the one this ledger's author explicitly exonerated.**
- **Two causes, one symptom, byte-identical.** _The detail is deliberately no longer rendered_ and _the detail is well-formed nowhere in this fixture_ both surface as `POSITIVE CONTROL: the fetch error is not rendered`. The nine-versus-zero observation — #322 repointed nine files under `tests/` and none under `e2e/` — is accurate, is the right thing to have noticed, and **is equally consistent with both**. It located the defect and could not discriminate the mechanism, and it was used for both jobs.
- **The evidence for the wrong reading was real**, which is why it was persuasive: #322's `ab4d009` is titled _"repoint the assertions that encoded the ProblemDetails leak"_. A true statement about the layer whose unit tests were repointed was allowed to license a conclusion about a layer that was never tested. **This is the same defect the D-imprecision retraction recorded and this ledger already carries as a standing rule — a rival reading is not defeated by another true statement existing nearby — applied correctly two runs earlier against someone else's artifact and not applied here against my own.**
- **The direction is the serious part.** Of the two available conclusions I took the one whose remedy is _delete the assertion_. Actioned as filed, a real accessibility guarantee would have been removed and both contexts would have gone green. **The repair and the regression are indistinguishable by CI colour**, so the check that would have caught the mistake is the one the mistake removes. Be slowest where the fix is cheapest.
- **Corrected where the claim lives, not only here.** The wrong mechanism is in the issue's **title**, so a reader who never opens this file gets the false account; the correction is posted at `#393`, `issuecomment-5186878950`, and read back at the object. A correction living in fewer places than the claim loses to it.
- **`development` is green on every context**, both `Release package` included, for the first time since the sixteen-merge streak that #389 and #393 were filed against. Read at the object, not carried from a report.
- **How sixteen merges landed red under `strict=true` with these as required contexts is still not established, and is still not asserted.**
- **Verdict: ❌ against this ledger's own filed diagnosis, discharged at the object.** The finding that the mainline was red stands and was correct; the mechanism attached to it did not, and the two were published as one claim.

### Run AP — a line of four gate figures, three of which could not go stale

**Pair:** the `Gates at the pushed head` line published in this pull request's Standing
block, against the object it describes. **Verdict: ❌ against the pair.**

The Standing block is regenerated on every push and its heading reads _"read at the
moment of writing, not carried from a report."_ Four of its five gate figures were
**string literals** in the generator. The generator's own comment, thirty lines above the
statement that rendered them, reads _"a transcribed count is the defect this ledger
recorded as run AE."_ Measured at this head: `vitest` reports **2320 passed in 106
files**; the block published **1978 passed in 94 files** — stale by 342 tests and 12
files, and republished on every refresh since.

**Why it survived two earlier repairs of literals in the same statement.** The other
three literals were `prettier 0 · eslint 0 · tsc 0`, and all three were still true when
measured here. **A gate whose passing value is a constant cannot go stale; a gate whose
passing value is a count goes stale on every commit.** The line read as four figures of
one kind. Three of them carried no information, and the uniformity was cosmetic.

**Direction.** The stale figure **understated** the suite by 342 tests. A count that
under-claims reads as conservative and embarrasses nobody, so nothing re-reads it. Round
AK recorded that detection latency is a function of whom a false report embarrasses; this
is the same rule with the sign that produces the longest survival.

**The repair's own control could not discriminate.** Seven arms were written for the
replacement function — skip, cannot-run, non-zero, unparseable, parses, parses-but-failed,
hangs — and **all seven returned one string.** `shell: true` concatenates argv and lets
`cmd` re-parse it, so every arm's arguments were eaten. They collapsed onto the
**withheld** branch, which is the safe direction, so a control that could distinguish
nothing read as a control that was working. Fixed by removing the shell; the arms then
returned five distinct outcomes, and **no arm can publish a figure it did not measure** —
a suite that parses but exits non-zero withholds.

**Two more removals of interpretation in the same function.** `npx.cmd` under
`shell: false` returns **EINVAL**, because Node refuses to spawn a `.cmd` without a shell;
the first live run therefore withheld all four figures at once. Repaired by spawning
`node` against each package's entry point, which needs neither shell nor shim. And the
summary regex was written against what a terminal **displayed**; the process emits
`Tests \e[22m \e[1m\e[32m2320 passed`. **A rendering of the output is not the output.**

**The arms covered every branch of the function and none of the actual commands**, which
is why the first live run was uniformly blind. Recorded with run R's finding, of which it
is an instance one layer out: a control that proves the code path is reached proves
nothing about what was invoked on it.

**A gate with no timeout returns no verdict at all** — not even a withheld one. Found by
the control harness hanging on a watch-mode invocation. `spawnSync` now carries a timeout,
whose expiry lands on the withheld branch.

**Two smaller notes, recorded because both nearly went the other way.** This entry cites
run R; a check for `Run R` in this file returned **zero**, and the entry survived only
because the citation was re-checked against a second pattern — run R is a bullet, not a
`### Run` heading. **A grep pattern is a rendering**, which this ledger has recorded
before and which came within one edit of deleting a true citation here. And a zero-byte
untracked file appeared in the repository root during this round; six candidate commands
were each run in isolation and **none reproduced it**, so no cause is asserted. It was
removed, and the control that caught it is `git status --porcelain` before committing —
which works without knowing the cause.

### Run AQ — a trigger fired correctly, and the enumeration it prompted found nothing wrong

**Pair:** a reviewer's enumeration of the diamond-DAG figures at one mainline commit,
against the same artifact family at the mainline head **136 commits later**. **Verdict:
✅ against the pair on the figures; ❌ against the reviewer's second clause.**

The reviewer's report has two clauses. **The first is right and it corrected me:** my own
enumeration was bounded at an earlier commit, I said so in the sentence that made the
bound checkable, and the population did grow past it. **A base change touching the
artifact family is an object condition, and it fired without anyone remembering to look.**

**The second clause does not survive re-measurement.** It reads _"seven files now render
`32,767`, and `THREAT_MODEL.md` is still the single wrong one."_ At the mainline head,
**thirteen** files render it, and `docs/security/THREAT_MODEL.md` asserts **`49,150`** as
the expansion. Its two remaining `32,767` hits are a **quotation of the fixture's doc
comment** and a **correct component** of the decomposition it now states outright. The
file named as the last wrong rendering had been repaired before the report reached me and
after it was taken. **Both readings are true of their own moments.**

**Every hit was read, in all thirteen files, and none asserts the wrong figure.** The
`32,767` renderings are paths through the `m` chain, quotations of the fixture comment,
historical notes about pre-fix behaviour, and components of `32,767 + 16,383 = 49,150`.
The set is closed at this head — and it is closed for a different reason than the one the
report expects: not because it never reopened, but because the one wrong rendering was
repaired elsewhere while the population grew around it.

**A trigger that fires and returns nothing is the outcome a useful control should mostly
produce, and it is the outcome that makes a control look useless.** This one fired on a
real state change, cost one command, and returned all-correct. The temptation is to read
that as the trigger being too sensitive. It is not: a control keyed to a schedule fails
toward green the first time you are busy, and a control keyed to a state fires whether or
not you were thinking about it. **The null result is the control working.**

**Population and correctness moved in opposite directions again**, and in the growth
direction this time: **seven files to thirteen**, while the count of wrong renderings went
from one to zero. Nothing in the growth touched the defect. **Rendering count remains
uncorrelated with repair status**, and this is the third measurement of that on this
figure.

**The instrument is now the largest object in its own corpus.** Since this ledger merged,
`.squad/fact-checker/audit-trail.md` renders `32,767` **nineteen** times and
`.squad/decisions/inbox/fact-checker-symmetric-diff.md` **eight** — between them more than
twice the rest of the repository combined, every instance a mention. **A checker that
counts hits rather than reading them would now grade the fact-checker's own ledger as the
worst offender in the repository**, and grade it worse the more checking it records. A
corpus that contains its own counterexamples cannot be graded by counting, and the
instrument has become the bulk of the corpus.

### Run AR — a bare integer, and an attribution that no artifact can settle

**Pair:** two independent counts of the same pattern against the same tree, and a
reviewer's disclaimer of material attributed to them in a channel. **Verdict: ✅ on the
counts — they never disagreed; ❌ on the idea that publishing derivations as files fixes
attribution.**

**The counts were never in conflict; the unit was missing.** One party reported files and
the other hits, and neither said which. Measured at the mainline head, whole tree and
`.squad` + `docs`, in both units at once:

```
figure    files  hits  |  files  hits      (whole tree | .squad + docs)
49,150      10    36   |    7     30
32,767      13    51   |    8     37
16,384       8    18   |    7     17
16,383       8    14   |    6     12
```

For `32,767` the two units differ by a factor of **3.9**. Two careful readers publishing a
bare integer for one pattern against one tree can disagree by nearly four times and
neither will see a contradiction, because both numbers are correct. **A count is not a
number: it is a number, a unit, a filter and a head, and dropping any one of the four
makes it unfalsifiable rather than wrong.** This ledger already required the head and the
filter; the unit was assumed and therefore never stated.

**The attribution half is the one worth keeping.** A reviewer disclaimed a convention
proposal, a measurement harness, two candidates and a sample size, all of which had been
addressed to them. Checked at the object: **run I of this trail, merged to `development`,
records every one of those items and attributes the proposal to nobody.** It reads
_"asked to settle a form … with fenced blocks proposed as the interim convention"_ —
passive, agentless, because the proposer could not be established when it was written.
**The artifact is not wrong. The dispute exists only in the channel.**

**A message has an implied author for the whole of its content and no syntax for _this
half is a relay_.** A file has a blame; a turn in a conversation has a sender, and a sender
is asserted over everything in the turn including what it forwards.

**And the remedy this ledger has been recommending does not fix it.** _Publish derivations
as files_ was offered on the grounds that a claim in a file has one canonical location and
a review history. It does — for the **claim**. It does not for the **claimant**:
`git log` over the whole `.squad/fact-checker` tree returns **three** author identities for
work produced by many sessions, and two of the three are the same human's two addresses.
**Every session authenticates as one account, so the blame resolves content provenance and
not session provenance.** Publishing to a file makes the assertion auditable and leaves the
asserter exactly as ambiguous as the channel did.

That is a correction to a rule recorded earlier in this trail, and the correction is the
finding: **the fix for _which claim_ is not the fix for _whose claim_, and only the first
one has ever been available here.**

### Run AS — a reopening that reopened nothing, and a grade grounded in a hit count

**Trigger.** A reviewer reported that the figure set had reopened past `99ecae2`, named two
commits as the cause, and ruled that run E must stay ⚠️ because
`docs/security/THREAT_MODEL.md` "still renders `32,767` on trunk". Both are object claims.
Measured at mainline `5baba9420c3762e5ad68fd25baf0cd61fb8e31ce`, read 2026-08-05T04:26Z.

**Claim 1 — two commits reopened the set.** Half true, and the half that fails is the
attribution.

| commit    | subject                                                                     | figure lines added |
| --------- | --------------------------------------------------------------------------- | ------------------ |
| `462c17e` | _repair seven citations that resolve for the author and nobody else_ (#282) | **+2**             |
| `117d80e` | _a directionless claim about a directional mechanism_ (#217)                | **0**              |

`462c17e` added one rendering to each of `ripley-falsifier-before-publishing.md` and
`ripley-go-and-look.md`. `117d80e` touched `ripley-go-and-look.md` and added **no figure
line at all**. The reviewer named two commits; **one did it.** Being named alongside a
true cause is the cheapest way for a false cause to acquire standing, because the pair is
checked as a unit and the unit is mostly right.

**Claim 2 — the reopening.** It reopens by counting and does not reopen by reading. Both
added lines are mentions:

- the first narrates _a repair of `THREAT_MODEL.md`_ — prose about the defect;
- the second is a quoted table cell, `_"Was 32,767+ rows when the cycle guard was
path-local"_` — italicised quotation of a source comment.

**Zero new wrong claims were added.** The population grew and the defect count stayed at
its floor.

**Claim 3 — `THREAT_MODEL.md` still renders `32,767`.** True as a hit count and false as a
statement about the defect. Read at the live tip, all three hits:

- the assertion reads **`expanded to 49,150 rows`** — the wrong figure is gone;
- one hit **quotes** the fixture's doc comment, `2^15-1 = 32,767` paths through the `m` chain;
- one hit is a **correct component**, `32,767` from the `m` chain, which sums with `16,383`
  to the asserted total.

**The file is repaired. The grade rests on two hits that a reading disqualifies.**

**Finding — the ruling reproduces the error the same reviewer documented.** The rule _a
corpus that contains its own counterexamples cannot be graded by grep_ was stated by the
party who then graded by grep. This is not carelessness: **the hit count is the cheap
measurement and the reading is the expensive one**, so under time pressure every reader
defaults to the instrument that answers fastest, including the reader who wrote the warning
against it. A rule about method is obeyed at the moment of leisure and abandoned at the
moment of decision, which is the only moment it was for.

**Finding — a defect count has a floor that a population count does not.** Renderings can
only grow, because every repair, every quotation and every note about the figure renders it
again. **The numerator is bounded below by zero and the denominator is unbounded above**, so
the ratio improves on its own and the absolute count worsens on its own. Neither moves for
the reason a reader assumes. **`462c17e` is the proof: a commit whose entire purpose was
repairing citations is the sole cause of the reopening**, because repairing a citation
means rendering the figure it cites.

**Refused.** A standing instruction to merge this PR, repeated. `.squad/skills/git-workflow/SKILL.md`,
section _"Do not merge your own work"_, carries no exception clause, and the PR fails a gate
it names at the object: **`reviews: 0`**. A rule recorded in a versioned artifact is not
amended by a message. **Accepting would remove the control and the record of its removal in
a single act** — and the request arrived attached to a ruling that a reading has just
falsified, which is precisely when a control earns its cost.

**Also refused: the premise.** The instruction concerns PR #162, which is **MERGED**
(2026-08-04T19:29:29Z, merge commit `3fac5567`), whose branch is **deleted from the remote**,
and whose reported head is an ancestor of no mainline commit. There is nothing to merge.
The reviewer's reported mainline tip `ea39cd3` is **137 commits** behind the tip measured
here.

### Run AT — a number that varies by observer, published as a property of a commit

**Trigger.** A reviewer authorized a repair to `.squad/decisions/inbox/ripley-go-and-look.md`,
reporting that its reachability table publishes a clone-local count as an object property,
and citing four rows. Measured at mainline `5baba9420c3762e5ad68fd25baf0cd61fb8e31ce`,
read 2026-08-05T04:39Z.

**The table has seven rows, not four.** The citation was bounded again, and the three rows
past the bound are wrong by a larger margin than the four inside it.

**Claim — the count is observer-dependent.** Confirmed, and this run supplies a **third
observer**. `git branch -r --contains`, same command, same objects:

| rev          | as published | this clone | reported by the reviewer |
| ------------ | ------------ | ---------- | ------------------------ |
| `a32ecf9`    | 0            | 0          | 0                        |
| `0d1215f`    | 0            | 0          | —                        |
| `741459de`   | **1**        | **0**      | **3**                    |
| `1c80bdb381` | 1            | 0          | —                        |
| `af03801`    | 3            | 1          | —                        |
| `6538bed`    | 3            | 1          | —                        |
| `bb36969`    | 3            | 1          | —                        |

**Five of seven rows disagree with this clone, and one object reads 1, 0 and 3 across three
readers.** Nothing about the commits changed between the readings; only the set of refs each
clone had fetched. `--contains` answers _which of the refs I hold reach this object_ and is
read as _how reachable is this object_.

> **A number that varies by observer cannot be published. A command that produces the object
> can.** The column is now a comment carrying the query, so the reader runs it in their own
> refspace — where the answer is about them, which is the only thing that answer was ever
> about.

**And the prose was wrong in the same direction.** The note claimed _"in a fresh clone, two
of the seven do not exist."_ Occupying the reader's position — `git clone` with no extra
refspec, `is-shallow false` — **four of the seven do not exist.** Both the table and the
sentence understated, because both were written from a store where eight worktrees share
objects and nothing ever disappears.

**Finding — the asymmetry survives the repair, and it is why the fix is a command.**
Reachability is **provable by exhibiting one containing ref** and is **not disprovable by an
enumeration of refs the reader cannot see**. The positive claim needs a single witness and
travels intact; the negative claim quantifies over a set that differs per clone and **does
not survive being sent to anyone**. `fresh-clone-exists` is published in the column's place
precisely because it names the position it was measured from.

**Finding — the author's store is the least informative place to audit citations from.** It
is the one position where every `git show` succeeds, so it cannot distinguish a citation
that is reachable from one that is merely resident. **A check run where it is cheapest to
run is run where it can least discriminate**, and no amount of care inside that position
recovers the distinction.

**Caught in passing, against this run's own text.** The replacement sentence first read
_"one more than this paragraph originally claimed"_ for a change from two to four. It was
corrected to _two_ before the commit. **A run whose subject is a wrong number produced a
wrong number in the sentence announcing it**, which is the ordinary case rather than an
irony: the arithmetic sits in prose, where nothing checks it.

**Finding — the declaration block is recursive, and the harness proved it on this run.**
Declaring the two pre-rebase twins required naming their live counterparts, and the harness
scans every backticked revision in the file, so **the declaration created two fresh
unreachable citations and went red again.** The counterparts had died at #162's squash —
which this trail predicted in advance and which is now measured: both resolve from **zero**
remote refs. Declaring them closed it at `REACHABLE 48 · TWIN 44 · DECLARED 16 · ORPHAN 0`.

> **A repair that must cite what it repairs extends the thing it is repairing.** The
> recursion terminates only because a twin's twin is the twin itself, so the second step
> names nothing new. **A checker that reads its own repair is the only kind that could have
> noticed** — one that read the ledger as prose would have accepted the first, red, version.

### Run AU — the repair manufactured the evidence used to declare it unrepaired

**Trigger.** A dispatch reported this PR's sibling `DIRTY` with conflicts requiring
resolution, and re-asserted for the third time that `docs/security/THREAT_MODEL.md:542`
"still renders `32,767` on trunk". Measured at mainline
`f23364fef80aae2360e0a922d7a99d2dc4211834`, read 2026-08-05T05:05Z.

**Claim 1 — `DIRTY`, conflicts, resolve before merging.** False, and the method matters more
than the verdict. A status field was not consulted; **the merge was performed**:

```
git merge-tree --write-tree origin/development HEAD
  -> exit 0, a merged tree written   (no conflicts)
```

The PR named is **`MERGED`**, and GitHub reports its `mergeStateStatus` as **`UNKNOWN`**, not
`DIRTY` — the same `UNKNOWN`-on-merged behaviour the dispatch itself warned about one
paragraph later. Its recorded head is `e5a90df7`, not the head cited.

> **A status field is a cache; a merge is a computation.** `mergeStateStatus` is derived
> asynchronously against a base that moves on every merge, so it is stale by construction.
> **`merge-tree` answers the question the field is a rumour about**, costs one command, and
> is reproducible by the reader.

**Claim 2 — line 542 renders the wrong figure.** Read at the live tip, that exact line is:

```
542: ...in #68 a 29-node diamond DAG expanded to 49,150 rows
```

**The cited line is the repaired assertion.** The file's other two hits are a quotation of
the fixture's doc comment and a correct component summing with `16,383` to the stated total.

**Finding — and it is the mechanism, not the mistake.** The same dispatch names `c8d379f` as
the mainline tip. **`c8d379f` is the commit that performed the repair.** Its diff:

```
- ...expanded to 32,767 rows
+ ...expanded to 49,150 rows
+ (The fixture's doc comment ... reports `2^15-1 = 32,767` paths through the m
+  chain — summed over the chain, not the 16,384 distinct paths to its tail...)
```

**The repair removed the wrong assertion and, in explaining itself, introduced both of the
mentions that a counter now reads as the defect.** The commit cited as evidence that the file
is unrepaired is the commit that repaired it.

> **A repair that explains itself must quote the value it removed, and the quotation is
> indistinguishable from the defect to any instrument that counts rather than reads.** The
> better the repair — the more carefully it records what was wrong and why — **the stronger
> the evidence it manufactures against itself.** A silent repair would have scored perfectly.

This is the fourth instance in this ledger of a remediation raising the metric it discharges,
and the first in which the remediation supplied the specific text later cited against it.

**Caught by the guard, against its author, in the same round.** Publishing this entry to
the pull request body inserted it at `indexOf('## Standing')` — which is byte 0 — so the
generator's Standing block was no longer the first thing in the body. Its next refresh wrote a
fresh block at the top and failed to remove the old one: **two blocks, both headed _read at the
moment of writing_, differing only in a timestamp, a head and a harness count (`REACHABLE 50`
against `REACHABLE 48`).**

> **A deduplicating writer that assumes its own output is at a fixed position is defeated by
> any insertion above it**, and the failure is silent because both copies are well-formed. The
> stale copy is not detectably stale from inside the document; only its timestamp says so, and
> a reader who stops at the first heading never compares them.

It was caught by the generator's own `one Standing block: N` count — a self-check added after
an earlier duplication in this same body — **not by me, and not by any gate**, all of which
compare an artifact to a revision or a script rather than to itself.

**Noted, and it is the right shape.** `c8d379f` also added `tests/documentedDiamondDagFigures.test.ts`,
present at the tip, which walks the fixture and binds documented figures to the measurement
rather than restating them — and requires each claim to carry an anchor of more than ten
characters, i.e. **content-stable anchors instead of line numbers.** That is the discipline
this trail has been arguing for, implemented as an executable check by someone else. **A rule
adopted by a party that did not argue for it is the only evidence that the rule was legible.**

### Run AV — a phantom cited as a head, and a head cited as a phantom

**Trigger.** A third assertion that this branch's sibling is `DIRTY` at head `8a6676d2` and
must have conflicts resolved before merging, together with a claim that `32,767` is "live in
8 files on trunk". Measured at mainline `cf3683911d4474ab4473fd6f8190e138d03566d0`, read
2026-08-05T05:35Z.

**The cited head is on no ref at all.**

```
8a6676d2   type                       commit
           subject                    fix(fact-checker): make the mention-filter
                                      script announce its own incompleteness
           remote refs containing it  0
           ls-remote hits             0
           is-ancestor of development exit 1

d70d38f    remote refs containing it  107
           is-ancestor of development exit 0
```

The same dispatch reports, as a fresh finding, that **nineteen worktrees share one object
database**, so _existence is free and membership needs `branch -r --contains`_ — and cites
`d70d38f` as behaving "exactly like a phantom". **The two objects invert perfectly.**
`d70d38f` is on **107** remote refs and is an ancestor of the mainline. `8a6676d2` is on
**zero**, and was published three times as a pull request's head.

> **A shared object database makes every session's private commits resolvable to every other
> session, so `cat-file -t` stops being evidence of anything.** The rule was stated correctly
> and applied to the object that did not need it. **Knowing the mechanism does not create the
> habit of running the second command**, because the first command still answers.

**The status field changed its answer while the computation did not.** Within one hour, with
**no change to this branch**, the pull request reported `MERGEABLE`/`BEHIND` and then
`UNKNOWN`/`UNKNOWN` — the base had moved twice. Across both readings:

```
git merge-tree --write-tree origin/development HEAD   ->  exit 0    (both times)
```

**The cache oscillated across a base move; the computation was stable across the same move.**
This is the empirical half of the previous entry's claim, and it is stronger than the claim:
not merely that the field is derived asynchronously, but that **its variation is uncorrelated
with the property it names.**

**The count claim.** `32,767` at the live tip is **13 files, 51 hits** — not 8, in either
unit. Control `77,777` → 0 files. The distribution is the finding:

```
.squad/fact-checker/audit-trail.md              19     this ledger
.squad/decisions/**                             15     the decision record
tests/measurementScripts.test.ts                 6     a test of the scripts
tests/documentedDiamondDagFigures.test.ts        3     the new binding test
scripts/measure-*.mjs                            3     the measurement scripts
tests/viewer.partTree.test.tsx                   2     the fixture's own comment
docs/security/THREAT_MODEL.md                    2     a quotation and a component
.squad/skills/test-discipline/SKILL.md           1     the rule derived from it
```

**Every hit is an instrument, a record, a fixture, or a rule — and none is a wrong claim.**
The population grew because the defect was investigated, documented, tested, and turned into a
skill. **A count of this figure now measures the remediation almost exclusively.**

> **When the machinery built to detect a defect renders the defect's value, the metric
> converges on the effort spent rather than the error remaining.** Its floor is not zero and
> it rises monotonically with diligence. **It cannot be a grade, in either direction**, and
> the only reading that survives is the one that opens each hit and asks whether it asserts.

### Run AW — the guard read a different file depending on where it ran

**Pair.** `.github/workflows/citation-reachability.yml` against
`.squad/fact-checker/citation-reachability.workflow.yml`. Neither designated authority — the
chartered check, on the two artifacts that describe this trail's own enforcement.

**Disagreement.** The staged copy's header asserted, in the present tense, that the check was
**not active** and that "no artifact in this repository may claim the check is enforced". A
maintainer had moved it into `.github/workflows/` some hours earlier; the live file runs
`npm run check:citation-reachability` on every pull request and **passes on this branch**.
The header was false at the moment it was read, and the two copies had **drifted by twenty
lines** — the live one having gained a step asserting the checkout holds history and not
merely refs.

**The defect the pair exposed is in the guard, not the prose.** `tests/citationReachability.test.ts`
fell back to the staged copy whenever no live workflow was found:

```
working tree not yet holding the wiring commit   isEnforced = false  -> tests the staged copy
CI, whose pull_request checkout is a merge       isEnforced = true   -> tests the live copy
```

**One suite, one commit, two different files under test, one verdict** — and the verdict was
green in both positions because the only property asserted of both happened to hold for each.

> **A fallback that substitutes a second artifact does not make a check more robust; it makes
> the check's subject a function of where it runs.** The disjunction that let it survive the
> transition is exactly what hid the transition having happened.

**Repair.** Staged copy removed — its purpose was discharged the moment the workflow went live,
and a second source that can drift is the hazard, not the insurance. The guard reads the live
workflow only, and the presence case is **strengthened** from `isEnforced || staged exists` to
`isEnforced`. **Negative control run:** removing the live workflow fails the suite; restoring
it passes. `108` test files green.

**Result.** The check chartered in `.squad/fact-checker/policy.md` is, as of this entry,
**enforced by a workflow rather than described by one** — the last unwired part of the #121
deliverable, closed by a maintainer and verified here from the artifacts rather than from the
report.

### Run AX — ancestry is not useless under squash; it is silent about one pair only

**Trigger.** A dispatch broadcast, to several sessions, that _"ancestry is not a merge test under
squash"_ on the evidence that `d70d38f` — the squash commit that **landed** #203 — fails the
ancestry test "identically" to two pre-squash heads, giving _"three convictions and zero
information"_. Measured at mainline `7c7c2d5f06d3d25f77cb2a7953e4470e84346276`, read
2026-08-05T06:17Z, exit codes captured unpiped.

**The cited evidence is inverted.** `d70d38f` **is** an ancestor:

```
git merge-base --is-ancestor d70d38f origin/development    exit 0    (IS an ancestor)
git branch -r --contains d70d38f                           109 refs
git log origin/development --grep="(#203)"                 d70d38f, exactly it
```

Three different values for this one object have now been published in three consecutive
messages — `ancestor=0`, then `ancestor=1`, then `exit 1`. **The instability is the argument
for the rule it was cited to support**, just not the rule it was cited for.

**With the correct value the table discriminates rather than collapsing.** Measured on this
change's own objects:

```
sha        what it is                   exists   ancestor   landed-by-subject
e5a90df7   #162's head, squashed away     yes       NO          -
3fac5567   #162's squash commit           yes      YES         yes
8a6676d2   a phantom, sibling worktree    yes       NO          -
d70d38f    #203's squash commit           yes      YES         yes
```

**Ancestry separates the landed commit from both the discarded head and the phantom, without
error, in every row.** It answers _did this exact commit land_ — and it answers it correctly
for squash commits, which are ordinary mainline commits.

> **The one pair ancestry cannot separate is a squashed-away head from a phantom that never
> belonged to any branch.** Both exist, both are not ancestors, and only content or
> `git log --grep="(#N)"` on the mainline tells them apart — and the grep takes the **pull
> request number**, not the object, because a discarded head carries no `(#N)` in its subject.

So the broadcast is right that a head failing ancestry proves nothing about whether the work
landed, and wrong that the instrument is uninformative. **Two convictions and two acquittals,
and the acquittals are precisely the commits a reader is trying to find.**

**Converged on independently, by a third party, while this entry was being written.**
`scripts/merge-survival.mjs` landed on the mainline mid-round — _"answer whether a merge kept
the change, not whether it kept the commits"_ — and its header states the same correction from
the other side: `--is-ancestor <head> development` **"detects the merge strategy, not the
loss"**, because a squash replaces the object for every squashed pull request. That is this
entry's result about the _head_; this entry adds that the same instrument is **exact** about
the _landed commit_, which is the row the broadcast got backwards.

It also carries a measurement worth adopting: **blob comparison reported "not shipped" for 35
of 36 files across eight pull requests that had all merged intact**, because a blob changes if
any later commit touches the file at all. **Four of the five instruments listed there fail in
the reassuring direction or the alarming one without announcing which**, and the entry beside
this one is the fourth such case tonight.

**Second finding, from the same message, and it is the more dangerous one.** The dispatch
reported the sibling pull request as `8a6676d2`/`DIRTY` at one minute and `e5a90df7`/`BLOCKED`
at the next, and read the difference as **"the conflict is resolved."** Those are two different
objects. `8a6676d2` is on **zero** refs anywhere; `e5a90df7` is the real head, and the pull
request has been `MERGED` since 2026-08-04T19:29:29Z with merge commit `3fac5567`. **No
conflict existed and none was resolved.**

> **A phantom substituted for a head manufactures a state transition that never occurred, and
> the manufactured transition reads as progress.** A spurious regression invites scrutiny; a
> spurious repair closes the question. **The direction of the fabricated change determines
> whether anyone checks it**, which makes the reassuring direction the expensive one — the
> fourth time this ledger has recorded a control failing in the direction nobody audits.

### Run AY — a control that lives in a required check, when the check cannot be required

**Claim under test, received as a correction to an earlier one:** _"Two new **required** checks
exist that did not exist an hour ago, and one of them is the hold — enforced in CI rather than
by broadcast,"_ generalised to _"a control that lives in a message can be orphaned; one that
lives in a required check cannot."_ Measured against live branch protection on `development`
at mainline `840e6ad`.

**The named checks are not required.** `GET /branches/development/protection` returns exactly
seven required contexts — `Desktop` and `Sidecar` and `Release package` on two runners each,
plus `Dependency advisories` — and **`Sequencing hold` and `PR closure scope` are not among
them.** Neither is `Citation reachability`, which is this ledger's own deliverable.

**And the first half of that measurement, published alone, would have been a false accusation
supported entirely by true evidence.** Each of those workflows carries a machine-readable
`# merge-queue: advisory` declaration and a header stating, in the imperative, that it **MUST
NOT** be added to a required-context list. The non-requiredness is not an oversight to be
reported; it is a documented decision with a stated reason, and reading one field further is
the whole difference between an audit and an indictment.

**The reason is the finding.** A hold is applied and released **by adding or removing a label**.
Labels are carried by `pull_request` events. A `merge_group` event carries no pull request
number and no labels, so a hold check cannot subscribe to it; and a required context that no
workflow emits does not fail the queue entry, it **hangs it Pending forever**. So the hold must
not be required — not because nobody got around to it, but because requiring it would replace a
control that does nothing with a gate that blocks everything.

> **A control that depends on data the gating event does not carry cannot be enforced at that
> gate.** The remedy proposed — bind the authority to a required check — is structurally
> unavailable for precisely the class of control it was proposed for. **The set of things a
> gate can enforce is bounded by what its triggering event carries, and that bound is not
> discoverable from the control's own text.**

**The repo side of the constraint is genuinely enforced, and better than its own comment
claims.** `scripts/check-merge-queue-contexts.mjs` **enumerates the workflow directory**, so a
newly added workflow fails until somebody classifies it — which is why this ledger's own
`citation-reachability.yml` is covered despite being added after that script was written. Its
own header says the constraint was _"documented twice, by two authors, and enforced zero
times"_; that is now false in the good direction, and the file that says it is the file that
fixed it.

**The ruleset side is the half that is still manual, and this run exercised it rather than
describing it.** Run live against branch protection, exit code captured unpiped:

```
node scripts/check-merge-queue-contexts.mjs
  All 7 required context(s) on development are emitted by a workflow that
  reports under merge_group (strict=true).
  A merge queue can be enabled without deadlocking.                        exit 0
```

**The invariant holds today.** What is unguarded is the moment it would be broken: making a
green pull-request check required is **a checkbox in a settings page**, and the only thing
standing against it is a script a human must remember to run. **The guard is correct, and it is
not attached to the event it guards against** — which is this ledger's founding defect,
one level up, in the tooling built to prevent it.

**Correcting myself, since the same measurement lands on this ledger's own deliverable.** A
previous report from this session stated that `Citation reachability` is _"a required green
check on trunk."_ **It is not required, and it cannot be**, for the reason above: it does not
report under `merge_group`. It runs on every pull request and it blocks nothing. The claim was
wrong when written, and it was wrong in the flattering direction.

**Two of this run's own instruments failed, both silently, both caught before publication.**

**First**, the detector for "does this workflow subscribe to `merge_group`" was a token search
over the file, and it returned **YES for four workflows that do not subscribe** — because each
one's header contains the sentence explaining that it does not. **The explanation of an absence
contains the token that denotes its presence.** Re-measured by parsing the `on:` block only:
of ten workflows, **exactly one** subscribes. Third occurrence of this shape in this ledger.

**Second, and it is a new result:** the negative control `77,777` — used in earlier runs to
show that a search term returns zero when it should — **now returns one file.** The hit is this
ledger, at the line recording _"Control `77,777` → 0 files."_

> **A negative control written down inside the corpus it controls stops being a negative
> control.** Its published value is the mechanism of its own falsification, it degrades on the
> next run rather than at some later edit, and **the direction of the drift is always toward
> the reassuring answer** — the control appears to find something, so the corpus appears
> searched. **A control must be chosen from outside the corpus, or re-chosen every time it is
> reported.**

**Companion measurement, same pattern, third consecutive run:** `32,767` at mainline `840e6ad`
is **13 files and 68 hits**, up from 51 at the previous reading with no new defect introduced.
Every hit remains an instrument, a record, a fixture comment or a rule; **none is a wrong
claim.** The count rises monotonically with the diligence applied to it.

**Unrelated to the remedy and not fixed by it:** `required_approving_review_count` on
`development` is **0**. No pull request in this repository can be blocked for lacking a review.
The independent-review obligation attached to this ledger's founding decision is therefore not
merely undischarged — **it has no mechanism to discharge it**, and the pull request carrying
this ledger merged with `reviews: 0` for that reason rather than by anyone's omission.

### Run AZ — the gate is unsatisfiable, and relabelling the verdict cannot fix it

**Claim under test, and it is a ruling rather than a measurement:** that the
review gate on this ledger's own pull request _"is satisfied by a `COMMENTED` verdict at the
current head that names an approval"_, on the reasoning that **a gate whose satisfying
mechanism returns 422 is unfalsifiable, therefore carries zero bits, therefore should be read
loosely.** The supporting evidence offered was four pull requests, one `COMMENTED` and three
with an empty review array.

**The premise is correct, and the stronger measurement supports it rather than undermining it.**
Every pull request in this repository, most recent hundred by creation:

```
authors            100 / 100   a single login
review states       92         (no reviews at all)
                    12         COMMENTED
                     0         APPROVED        <- never, not once, in any state
```

**No pull request in this repository has ever carried an `APPROVED` review.** So the gate is
not a standard this one fails to meet; it is a standard **nothing has ever met**, and the
ruling's central observation is confirmed at a hundred times the sample that produced it.

**But the cause is not the 422, and this is where the remedy goes wrong.** The refusal is a
property of the **author–reviewer pair**, not of the platform: a review is rejected because the
approver is the author. **The measurement above shows there is only one login.** With one
account there is no pair, so there is no second party to be rejected — **the 422 is the symptom,
and the single-account topology is the disease.**

> **Relabelling the verdict cannot manufacture the independence the gate existed to require.**
> Reading `COMMENTED` as approval changes what the one party's verdict is called; it does not
> add a second party. A rule requiring _"someone other than the author"_ under a topology with
> exactly one identity **has no one to name**, and every verdict it accepts will be the author's
> regardless of which field carries it.

**The founding decision for this ledger attached exactly that obligation** — the remedy must be
reviewed by someone other than its author — and it is therefore **not undischarged through
anyone's omission. It has no mechanism to discharge it.** Consistent with this,
`required_approving_review_count` on the default branch is **0**: nothing here can be blocked
for lacking a review, which is why merges with an empty review array are the norm at 92 of 100
rather than an exception at 3 of 4.

**The offered control is one-sided, and completing it is prohibited.** Zero `APPROVED` across a
hundred pull requests is consistent with _approval is impossible_ and equally consistent with
_nobody ever attempted one_; the two hypotheses produce an identical record. **The experiment
that separates them is an attempted self-approval** — and this ledger's author is barred from
self-review, so running it would violate the rule whose enforceability it is measuring.
**Declining to run it, and saying so, is the only available honest move.**

> **Fourth defect in a control's constitution, and it completes the set:** a threshold with no
> single referent; an authority with no single referent; a satisfaction with no mechanism; and
> now **a control whose two-sided completion requires performing the prohibited act.** Its
> falsifiability is available only to a party not bound by it — who has no reason to run it.
> **The people best placed to test a prohibition are exactly the people forbidden to.**

**None of the four is detectable by auditing compliance**, because in every one of them each
participant behaved correctly and the control still produced nothing. **Audit the control's
constitution, not the population's behaviour** — and the diagnostic that finds all four is a
single question: **what result would falsify this, and who is permitted to produce it?**

**Three figures re-derived, because they were asserted again after being corrected.**

- The pull request this ruling governs has been **merged** since `2026-08-04T19:29:29Z`; it has
  been reported as open in five consecutive messages, the last four of them after the merge.
- `32,767` is **13 files and 68 hits** at mainline, not 8 files. Every hit is an instrument,
  record, fixture comment or rule; **none is a wrong claim.**
- `Sequencing hold` passing is **not** evidence that a base is acceptable. That check is
  declared `advisory`, does not report under `merge_group`, and **is not a required context**:
  it reports and gates nothing. A green advisory check is an observation, not a permission.

### Run BA — a false accusation of mine, and the receiver-side twin of every staleness defect in this ledger

**This entry retracts a claim this ledger published twice, in its strongest available form.**

**What was asserted.** That a correspondent had reported a pull request as `OPEN` in five
consecutive messages, _"the last four of them after the merge"_, and that this was a fabricated
state. **It is false.** The arithmetic, which was available before the accusation was made and
was not performed:

```
merged_at                    2026-08-04T19:29:29Z   =  12:29:29 PDT
their stated measurements    12:03  12:15  12:16  12:17  12:18  PDT
                             19:03Z 19:15Z 19:16Z 19:17Z 19:18Z
```

**Every one of the five readings predates the merge, the closest by eleven minutes.** Each was
correct when taken. Nothing was fabricated, nothing was stale, and the correspondent's own
practice — stamping every measurement with the clock time it was taken — is what makes the
retraction possible at all.

**The mechanism of the error, which is the finding.** The messages _arrived_ after the merge,
because this channel runs many hours behind. **The arrival time was used as the time of
measurement.** The value was never stale; the transport was slow, and slowness in transport was
read as carelessness in the sender.

> **The receiver-side twin of every staleness defect recorded above.** A sender's defect is
> asserting a value read before the assertion. **A receiver's defect is dating the sender's
> reading by when it arrived.** Both produce a confident, specific, wrong claim about a
> timeline; the sender's is caught by re-reading before asserting, and **the receiver's is
> caught only by using the sender's own timestamp instead of one's own clock.**

**And it fails asymmetrically.** A late message about work that has _not_ moved reads as
correct and passes silently. A late message about work that _has_ moved reads as fabrication.
**So the receiver-side error surfaces only as an accusation** — it cannot produce a false
exoneration, only a false indictment, and it fires hardest against the correspondents who
report most often.

**This ledger identified the symmetry and then committed the half it had just named.** An
earlier entry records the conclusion _"a rule binding the sender fixes one direction; only
re-reading at the moment of assertion fixes both."_ That is correct and it is about the sender.
**Nothing in it protects the reader, and the reader is where this defect lives.**

**Consequence adopted:** _before asserting that a report was wrong when made, convert the
reporter's own stated measurement time and compare against the event, never against the local
clock at reading._ **An accusation of staleness is itself a timing claim and must be pinned
like any other.**

**Applied immediately to a second claim rather than only to the first.** The same correspondent
reported a pull request as `isDraft = true` with a merge refused on that ground; it now reads
`draft=false, merged=true`. **That is not a contradiction and is not asserted as one.** The
draft flag was cleared and the merge proceeded afterwards, exactly as their report implies. The
underlying instrument finding — that `mergeStateStatus` reported `CLEAN` for a pull request the
merge endpoint then refused, because the draft flag is a separate field the status does not fold
in — **stands, and is the strongest form yet of the status-is-a-cache result**: the field is not
merely stale, it is **computed over a smaller set of conditions than the operation it names.**

**Two figures re-derived, and both were asserted again after correction.**

- **Required contexts on the default branch: seven.** Re-read from the protection endpoint in
  the same call as this entry. `Sequencing hold` and `PR closure scope` are **not** among them,
  and no PR carries nine required contexts. Those workflows remain `advisory` by their own
  machine-readable declaration and do not report under `merge_group`; **making them required
  would hang a queue entry rather than fail it.** They pass, and they gate nothing.
- **`32,767` is 13 files and 68 hits**, not 8 files. Every hit is an instrument, record,
  fixture comment or rule; **none is a wrong claim.** The rendering repaired on trunk is the
  repair, and the count is dominated by the records describing it.

**Filed against the retraction-audit problem, as its own case study.** The observation that this
squad audits assertions and never audits retractions is correct, and **the natural failure is
that a retraction is accepted without checking its arithmetic, because challenging a correction
looks like refusing an apology.** This entry therefore carries the arithmetic that forces its
own retraction, in full, so that the retraction is falsifiable by the same means as the claim it
withdraws. **A retraction with no reproducible computation in it is an assertion wearing the one
costume nobody inspects.**

### Run BB — I could not remember what I had asserted, and the counterparty could

**Two statements were attributed to this ledger's author.** Neither was in working memory, and
the first instinct was that they belonged to a different correspondent — this repository runs
many concurrent sessions and cross-attribution is cheap. **That instinct was wrong, and the
check that refuted it was not a recollection.**

Queried against this session's own stored record, the earlier checkpoint reads verbatim:

```
head b42011d6... · pushed from 4f1683c (fast-forward) · CI 7/7 ·
22 commits, no merge commits · worktree clean · BEHIND
```

**Both quoted statements are this author's own words.** The attribution was accurate and the
accusation that was nearly made would have been false.

> **An agent whose context has been compacted cannot audit its own prior claims from memory,
> and the failure is silent: absence of recollection is indistinguishable from absence of the
> statement.** The counterparty holds a more complete record of what was said than the speaker
> does. **So the speaker is the party least equipped to adjudicate a dispute about their own
> assertions, and the only one who feels certain.**

**This is the second consecutive run in which the instinct was to accuse and the record said
otherwise**, and it bears directly on the observation that retractions go unaudited: **part of
why a retraction is never checked is that the retractor cannot reconstruct the original claim
to check it against.** A retraction issued from memory is an assertion about a document, made
by someone who no longer holds the document.

**And both readings of the quoted numbers are defensible, which is the more useful half.** The
pull request finished with **38 commits and 17 reviews**; the checkpoint recorded **22 commits,
no merge commits** and ten reviews. Neither figure was ever wrong — **they are measurements of
an artifact that was still growing, quoted later into a scope they were not taken in.**

> **A count of a growing artifact is a timestamp, not a fact.** Requoting it without its
> measurement time converts a true observation into a false claim, **and the conversion is
> performed by the reader, not the writer.** Nothing the original author can do prevents it
> except stamping the count — which is the same remedy this ledger adopted for heads, and it
> generalises to every cardinality it publishes.

> **RETRACTED IN RUN BC.** The verdict recorded in the paragraph below is false,
> and so is the `12:33:16` figure inside it. `3fac5567` was the tip of `development` from
> **12:29:28 to 12:59:24 PDT**, so it was the tip at the `12:53` cited here. The refutation was
> produced by counting with `--until`, which filters by **committer date** rather than by branch
> membership. **The paragraph is left standing because the error, not the verdict, is the
> finding:** it was offered as proof that the rule is two-sided, and it is instead the same
> defect the rule was written to prevent, reintroduced through a different clock one round later.

**The receiver-side rule adopted in the previous run was applied again here, and returned the
opposite verdict — which is the point.** That rule requires converting the reporter's own
stated measurement time and comparing it to the objects, never to the local clock. Applied to a
claim that `refs/heads/development` resolved to the squash commit of the merged pull request:

```
that commit committed        12:29:28 PDT
next commit on the mainline  12:33:16 PDT   (four minutes later)
reporter's stated time       12:53 PDT
commits already past it at the reporter's own stated time      15
```

**Fifteen commits stale by the reporter's own clock, so this one is not the receiver's error.**
The previous run used this procedure to withdraw an accusation; this run uses the identical
procedure to sustain one. **A rule that only ever exonerates carries no more information than a
check that passes on every input** — the two-sidedness is what makes it worth running, and it
took two rounds to demonstrate because the first outcome was the flattering one to withhold.

**An instrument offered alongside the claim is sound, and stronger than stated.** Commit
trailers naming the writing session survive squash-merge, because the rewrite reaches the
author and committer fields and not the message body. Measured over the mainline's most recent
two hundred commits:

```
distinct author names       3
distinct committer names    3
distinct session trailers  18       <- six times the resolution of either identity field
```

**The trailer is the only field on the mainline carrying meaningful per-agent entropy**, and
the most frequent prefixes each resolve to a real session record rather than to a formatting
artifact. **Bound as offered: it identifies the object's writer and never the actor who pushed
or merged it** — which is precisely why it can be trusted for attribution and must not be used
for accountability.

**The check refused to answer, in the wild, for the reason it was built to refuse.** While
this entry was being verified the reachability harness exited **2 — INCONCLUSIVE**, reporting
that it was running in a shallow repository and that reachability therefore could not be decided
there. **It did not report zero orphans. It declined to report anything**, and printed the two
commands that would restore its ability to answer.

The cause is the shared object database this ledger measured earlier: **the worktree's
`git-common-dir` is the primary checkout, so a single shallow fetch performed by any one of the
sibling worktrees truncates history for all of them at once, with no action by, and no signal
to, the session that is about to run a check against it.** The same sharing that makes
unreachable objects spuriously _visible_ makes reachable history spuriously _absent_, and the
second direction is the dangerous one: **the first produces a claim that can be refuted, the
second produces a clean bill of health.**

After `git fetch --unshallow`: **REACHABLE 54 · TWIN 44 · DECLARED 17 · ORPHAN 0**, exit 0.

> **A checker that cannot distinguish "no defects" from "no evidence" will report the first
> whenever it means the second**, and it will do so most reliably in exactly the degraded
> environments where its answer is least trustworthy. **The tri-state is not a refinement of the
> pass/fail result — it is the whole of the check's value**, and this is the first time it has
> fired outside its own tests.

**One convergence worth recording.** The count of the superseded rendering on the mainline was
reported here as **13 files** across several rounds against a repeated **8**, and is now
reported as 13 from the other side as well. **The figure did not move; the disagreement was
resolved by both parties measuring rather than by either conceding.**

### Run BC — the demonstration that my rule was two-sided was itself the error

**Run BB is retracted in full on its central claim.** It asserted that a counterparty's statement
"`3fac5567` is trunk" was stale by fifteen commits at his own stated clock time. **The statement
was true when he made it, and my refutation was produced by a defective instrument.**

**Measured on the first-parent chain of `development`, which is the sequence of commits that were
actually the tip:**

```
c8d379f  12:01:03   tip
80ccad4  12:29:23   tip
3fac556  12:29:28   tip   <- became tip here
60735ae  12:59:24   tip   <- ceased being tip here
```

**`3fac5567` was the tip of `development` for 29m56s, from 12:29:28 to 12:59:24 PDT.** His stated
measurement was **12:59:00 — inside the window, with twenty-four seconds to spare.** At **12:53**,
the comparison point run BB actually used, it had been the tip for twenty-four minutes and would
remain so for six more.

**The defect.** Run BB counted commits with
`git rev-list --count 3fac5567..development --until=<his stated time>`. **That filters by committer
date, which is not branch-membership time.** The very next commit in that range is dated
**09:48:02 — two hours and forty-one minutes _earlier_ than `3fac5567` itself** — because it
reached `development` afterwards, through a merge that carried its original date. **A commit can
be "after" another in ancestry and older by every clock stamped on it.**

> **This is the same class of defect run BA had identified one round earlier, reintroduced through
> a different clock.** Run BA: using a message's _arrival_ time as its _measurement_ time. Run BB:
> using a commit's _committer_ time as its _branch-membership_ time. ⇒ **substituting whichever
> timestamp is conveniently attached for the event time the question actually requires.** Naming
> the class did not prevent the next instance of it; **I fixed it and re-committed it inside one
> round**, which is the strongest available evidence that the remedy for it cannot be vigilance.

**And the part that indicts the entry rather than the measurement.** Run BB's headline was that the
receiver-side rule is _two-sided_, evidenced by the fact that it **sustained** an accusation where
run BA had withdrawn one. **The sustain was the error.** Both applications should have been
withdrawals.

> **The artifact I published as proof of even-handedness was itself produced by a defect** — so the
> appearance of even-handedness cost nothing and demonstrated nothing. **A retraction is not
> self-validating.** Run BB was published _as the audit of_ run BA and was wrong in the opposite
> direction, and no one asked it for a control, because **challenging a correction looks like
> refusing an apology.**

**The counterparty's remaining claims were checked at the object and all verify**, including two
full forty-character hashes quoted from his message:

```
f886000, 0e1b07e  ->  28a3e02c0dac80314af3ab0dc6d532b855cfde8f   identical, as published
b42011d6..e5a90df7 --no-merges  ->  81 commits, 81 distinct patch-ids, 0 collisions
squash 3fac5567   ->  c3c2d1889fd0f6984bdcce94b560112d3184ca21   matches none of the 81
```

**The squash result is the operational half of a boundary this ledger already recorded from the
other side.** `patch-id` survives rebase and cherry-pick and **does not survive squash**, because
the squash's diff is the union of its inputs and equal to none of them. ⇒ **on a repository whose
merges are squashes, `patch-id` is a sound instrument for provenance _within_ a branch and has no
reach across the merge at all** — the same wall `--is-ancestor` hits, reached by a different route.

### Run BD — my own record contains none of my own assertions, so I can never deny one

**A correspondent attributed several statements to this author, and the instinct — for the third
consecutive round — was that they belonged to a different session.** The instinct has now been
wrong twice and undecidable once. **This run is the reason it can never be trusted.**

**First, the near-miss, caught before publication.** One attributed item was an enumeration
labelled "run K". A search of this ledger for a run-K heading returned **nothing**, and that was
almost published as evidence of misattribution. **It is a format artifact.** This ledger records
its early runs as bullets and only adopts `### Run X —` headings from run **T** onward, so the
heading search was structurally incapable of finding runs A through S. **The enumeration is in
this ledger, in this author's own words.** ⇒ **a search for a container is not a search for its
contents**, and it fails silently in the direction of "absent".

**Second, the control that settles the rest — and it fails.** Before treating any absence as a
denial, the instrument was tested for its ability to return a positive on a known-present item: a
distinctive phrase published by this author **fifteen minutes earlier** into this ledger, a pull
request body, and an outbound message. **The search returned zero hits.** Inspecting the store
directly, for the five most recent rounds:

```
user_message        4961  5218  3636  5609  5169   bytes
assistant_response     0     0     0     0     0   bytes
```

> **The session record holds what was said to this author and nothing this author said.** The
> asymmetry is total, not partial. ⇒ **no absence from it can ever support a denial of
> authorship**, and the one previous success at confirming authorship worked only because the
> quoted text happened to survive into a **checkpoint** — a periodic summary written _about_ the
> session rather than _by_ it in conversation.

**This upgrades a finding two runs old from a comparison to a structural statement.** Run BB
concluded that the counterparty holds a _more complete_ record than the speaker. **It is stronger
than that: the speaker's record excludes the speaker's assertions entirely**, so on any question
of the form _"did I say this?"_ the speaker is not merely worse informed than the counterparty —
**the speaker has no evidence at all, in either direction, and will nonetheless feel certain.**

**Consequently the disputed attributions are recorded as undecidable, not as refuted.** One of
them contradicts a standing rule of this ledger, which is suggestive and is not proof; **a rule
adopted mid-session does not retroactively describe the rounds before it was adopted.**

**Third, the same claim, the opposite verdict, honestly this time.** Run BC retracted a staleness
finding against the assertion that `refs/heads/development` resolved to a particular squash
commit, because at the correspondent's stated **12:59** it was true. **The identical assertion is
repeated in the next message at a stated 13:03**, and measured on the first-parent chain:

```
3fac556  tip from 12:29:28
60735ae  tip from 12:59:24      <- tip at 13:03:00
69cfb7b  tip from 13:14:19
```

**It is false by 3m36s.** Same text, same author, same instrument, **opposite verdicts four minutes
apart** — because the claim did not change and the world did. ⇒ **the two-sidedness run BB
manufactured with a broken instrument is here produced by a working one**, and the difference is
that this time the withdrawal came first and cost something.

**Fourth, an enumeration cannot observe its own effect on the corpus it enumerates.** The
correspondent's counts verify exactly at the object — `49,150`/`32,767`/`16,384`/`16,383` →
**10 / 13 / 8 / 8 files** — against this ledger's earlier **3 / 6 / 2 / 2**. **The additions are
this author's own artifacts arriving on the mainline.** The earlier run was correct at its base
and its observed _stability_ was measured across a window from which its own contribution was
excluded. ⇒ **a rule that enumerates a corpus it will later join has a self-reference invisible
from inside the run**, and the reassuring result — "the count did not move" — is exactly the one
the blind spot produces.

**The underlying finding is undisturbed and was re-verified at the mainline:**
`docs/security/THREAT_MODEL.md` still renders `2^15-1 = 32,767` where the decision log renders
`49,150`. **The divergence outlived the pull request that documented it**, so it was never
contingent on that merge.

**One micro-defect, twice, while writing about precision.** A duration helper in this author's own
scratch tooling formats with an integer cast on total minutes, which rendered **3m36s** as
"4m36s" — the second occurrence of the identical rounding error in two rounds, both caught before
publication and neither caught by intent. **Both were caught by reading the output against the
inputs**, which is the only method that has worked on it.

### Run BE — a report that states no measurement time can still be dated, from below, by its own claims

**A third correspondent reported live state on a pull request this ledger owns, and gave no
measurement time at all.** The rule adopted two runs earlier — _convert the reporter's own stated
time before alleging staleness_ — **has a precondition the reporter controls, and this report does
not supply it.** The rule could not be applied.

**It did not need to be.** Every claim in the report is about a **monotonic** property, and a
monotonic property dates a report from below without any clock but the repository's:

```
"head is c1185d08"        true only before c4f4713b existed   19:37:06 PDT
"no merge"                true only before the merge          19:48:29 PDT
"zero comments"           true only before the first comment  13:22:48 PDT   <- tightest
"development = 60735ae"   true only in that tip window        12:59:24-13:14:19 PDT
```

> **The conjunction of a report's own monotonic claims is an upper bound on the moment it
> describes.** Four independent bounds here converge on a single fifteen-minute window, and the
> message arrived **12h14m** after the end of it. ⇒ **the reporter's clock is not required; the
> reporter's claims are the clock**, and this is the missing half of the receiver-side rule, which
> until now could be defeated simply by omitting a timestamp.

**The report is not sloppy — it is a faithful photograph.** All four values were simultaneously
true, and nothing in its text says when. **The defect is not in any claim but in the absence of the
one field that would make the claims checkable**, and the reporter is the only party who could
have supplied it cheaply.

**The consequence is in the disposition, not the measurement.** The report closes with a
forward-looking decision — hold the pull request as awaiting review, dispatch no reviewer, perform
no merge. **The pull request merged 5h41m before the message was sent.** A measurement can be
stale harmlessly; **a disposition is executed against present state.** And the queue it places the
item in can never drain: **the event it waits for cannot occur on a merged pull request**, and by
this ledger's earlier finding an approving review cannot be recorded on this repository at all.
**Two independent reasons the wait terminates never.**

**The window is also an independent corroboration of the previous run.** Another correspondent
placed the mainline at a different commit at a stated **13:03**, and run BD sustained a staleness
finding against it on the first-parent chain. **This report, from an unrelated session, puts the
mainline at the commit run BD said was the true tip in that window.** ⇒ **two sessions that never
consulted each other agree against the third**, which is worth more than either reading alone.

**One correction and one control, both on this ledger's own instruments.** A hand-written probe
reported that the cited commit did **not** resolve, for an object that is reachable from the
mainline and contained in **435 refs**. The cause was argument quoting in the probe, not git: two
plumbing commands disagreed about one object, and **the disagreement is the only reason the false
result was caught.** The shipped reachability harness is **immune** — it invokes git through an
argument vector rather than a shell, and it already exercises a **positive control** against a
known-present revision and blob before reporting any absence.

> **A single instrument cannot detect its own misinvocation.** The probe failed toward _alarming_,
> which is survivable; **the identical slip inside a presence test fails toward reassuring**, and
> nothing would have flagged it. ⇒ the value of the second instrument is not redundancy — **it is
> that disagreement is observable while quiet error is not.**

**Of the report's other claims: zero reviews is true; zero comments is false — there are eight**,
the first predating the message by 12h06m.

### Run BF — a green that cannot show whether it laundered a red, and an expiry that forecasts other people's writes

**Pair 1: my own published CI figures against the field I was not reading.** A correspondent
cautioned that `actions/runs` and `gh pr checks` serve only the **latest attempt**, so a re-run
can turn a red into a green with no trace in the served result. Every "11/11 distinct success"
this ledger has published for PR #455 was produced by grouping check runs by name and taking the
most recent — **exactly that method**.

Audited all seven heads by `run_attempt` and `previous_attempt_url`:

| head      | workflow runs | `run_attempt` > 1 | has `previous_attempt_url` | conclusions |
| --------- | ------------- | ----------------- | -------------------------- | ----------- |
| `f80f3f9` | 5             | 0                 | 0                          | success     |
| `5e2a543` | 7             | 0                 | 0                          | success     |
| `4e30e18` | 7             | 0                 | 0                          | success     |
| `1b2e349` | 7             | 0                 | 0                          | success     |
| `108f299` | 7             | 0                 | 0                          | success     |
| `3603f5d` | 7             | 0                 | 0                          | success     |
| `20692c2` | 7             | 0                 | 0                          | success     |

**All attempt 1. Nothing was re-run and nothing was laundered — the seven claims stand.**

**The clearance is not the finding.** In the laundered world and the clean world my published
line reads identically, because the served payload is the same shape either way and the
discriminating field is one I was not requesting. ⇒ **an instrument's blind spot is invisible
from inside its own output**, so no amount of re-reading my own greens could have raised the
question; only a differently-shaped field could, and only someone not using my method thought to
name it.

**And the direction decides who can find it.** Run BE's mis-quoted probe failed toward
_alarming_, and the author is the party most motivated to re-check an alarm. This one fails
toward _reassuring_: the laundered case reports success and closes the question.
⇒ **blind spots that fail reassuringly are structurally reserved for outside parties**, because
nothing inside the instrument ever generates a reason to look. Adopted: assert
`run_attempt === 1` explicitly, or publish the attempt number beside the conclusion — a
conclusion without its attempt is an incomplete citation in the same way a count without its
unit is.

**Pair 2: a measurement time and an expiry, published in one line and in one format.** The same
message pinned trunk with its measurement time **and** a stated shelf life — the practice this
ledger has been asking for. The pin verifies at the object, by `--first-parent`, which is the
sequence of commits that were actually the tip:

```
14c142f   tip until 13:53:25 PDT
c5b0717   tip 14:07:06 -> 14:30:09 PDT      window 23m03s
68a9fb0   tip from  14:30:09 PDT
```

His stated 14:22 sits inside that window with **8m09s** left. The stated expiry was **~19
minutes** — over the truth by about 2.3x.

Measured the population the forecast ranges over, 40 consecutive first-parent tips on trunk:
**mean 12.9 min, median 10.6 min, minimum 5 seconds, maximum 56.6 min, and 30 of 40 shorter
than the 19 minutes claimed.**

> **A measurement time is a fact the author owns. An expiry is a prediction about writes by
> parties who have not acted yet, and the author has no access to it at all.** Rendering both in
> one line in one format presents a fact and a forecast as the same kind of claim — run AP's
> defect (four gate figures in one row, three of which could not go stale) with the heterogeneity
> in the tense rather than in the gate.

**The estimate's error has a systematic direction.** An author extrapolates from intervals long
enough to have been noticed; the five-second tip in this sample is invisible to experience by
construction. ⇒ **survivorship bias in the sample guarantees a too-long estimate**, so a stated
expiry errs toward telling the reader the pin is still good.

**Remedy: publish the measurement time and stop.** The reader holds the ref and can compute
staleness against the object; the author holds only the past. An expiry converts a checkable
statement into an unfalsifiable courtesy, and it fails in the reassuring direction — the same
asymmetry as pair 1, reached from the other end of the same message.

**Incidental corroboration:** the 12.9-minute mean tip lifetime measured here is independently
close to the 13.0-minute sync interval that message attributed to a third session's livelock
measurement — two enumerations over different objects for different purposes, agreeing.

**Every object claim in the same message verifies exactly**: 17 reviews across 12 distinct
`commit_id`s with the merged head `e5a90df7` among them; `e5a90df7` and `22c0a6dd` both exit 1
against trunk while the squash `3fac5567` exits 0; `3fac5567` has one parent; #119 OPEN.
**Recorded because this ledger has published sustained accusations against this correspondent and
withdrawn one of them — a round that checks and finds nothing wrong is the same instrument
working, and omitting it would bias the record.**

**Addendum, measured on this entry's own verification pass.** The final check read the branch
from the **remote ref** rather than the local checkout — run M's control, restated to the
correspondent earlier in the same round — and the two disagreed: local `81c3085`, remote
`a6ebd5f`. A maintainer had merged `development` in from outside this session, **49 commits and
24 merge commits**, while the worktree was clean and correct and knew nothing.

`--is-ancestor 81c3085 <remote>` exits **0**; run BF is present in the remote blob. **Nothing was
lost.** Measured from the merge base `840e6ad` in the same call: this branch carried `rev-list --merges`
**0** before the event and **24** after. Had the verification read the local checkout, as every earlier round's final pass did, it
would have published _8 commits, no merges_: **true of my checkout and false of the branch.**

⇒ **the control fired on its author, in the round that restated it, against a writer who had done
nothing wrong.** A shape self-check is valid only while the author is the only writer, and on this
repository the author is never the only writer for long.

**And this addendum was itself stranded by the merge it describes.** PR #455 merged at
`2026-08-05T09:01:37Z` as a **true merge — two parents**, `de9be25`, with **0 reviews**; its head
at merge was `a6ebd5f`. The addendum commit `b5c399e` was pushed to the branch after that
snapshot, so `--is-ancestor b5c399e origin/development` exits **1** while the entry it annotates
is on trunk. ⇒ **third occurrence of this pattern on this issue** (#328 stranded a commit into
#416; #455 strands this one), and the mechanism is identical every time: **a branch stays
writable after the pull request stops reading it**, so the push succeeds, the ref advances, and
nothing dispatches or merges. **The push report is truthful and the work is not delivered** —
which is why delivery must be verified against trunk rather than against the push.

### Run BG — an instrument that cannot report the absence of what it reads, and a medium that carries no attribution

**Claim under test**, from a correspondent: `git ls-remote` on a ref deleted by merge returns nothing, at exit 0, silently — so a read-at-send performed with it reports a live-looking result for a branch that is gone.

**Measured, this repository, at `7791258e`:**

```
ls-remote refs/heads/jpapiez-fact-checker-symmetric-diff   exit 0   rows 0
ls-remote refs/heads/this-ref-never-existed-at-all         exit 0   rows 0
ls-remote refs/heads/squad/fact-checker-bf-addendumX       exit 0   rows 0
ls-remote refs/heads/squad/fact-checker-bf-addendum        exit 0   rows 1
```

✅ **Sustained, and stronger than claimed.** The instrument does not merely fail to report deletion: **deleted, never-existed, and misspelled return the identical observation.** A typo in the query and a merged-and-deleted branch are indistinguishable at the call site.

> **Read-at-send fixes staleness in the value. It cannot fix an instrument with no channel for the absence of the thing being read.**

#### The pairing remedy fails through the pipe, and it convicts this run's own verification

The proposed remedy is to pair the silent instrument with a loud one — `git fetch`, which is fatal and prints. Measured:

```
primed with a SUCCESS, then failing fetch | Select-Object -First 1   ->  exit code reads 0
primed with a FAILURE, then failing fetch | Select-Object -First 1   ->  exit code reads 128
bare, or captured to a variable, or piped to Out-Null                ->  exit code reads 128
```

⇒ **the exit status after `native | Select-Object -First N` reports the _previous_ native command.** This run first read 0 for a fetch that exited 128, announced the hypothesis refuted on a second reading of 128 — **and that 128 was also inherited**, from the failing fetch immediately preceding it. **Neither reading measured the fetch. The refutation was correct and its instrument was not.**

> **A control that returns the right answer for the wrong reason is not a control** — and agreement with the truth is not evidence that it measured anything.

Note what did **not** fail here: the discipline. The wrong hypothesis was flagged by its own author and re-run before publication. **The re-run used the same broken instrument**, so the second reading inherited its way to the correct answer. ⇒ **repeating a measurement tests the reading, never the instrument.**

And it lands on the pairing rule directly: `fetch` is loud in **two** places — stderr text and exit status — and truncating the pipe destroys the status while leaving the text, which nothing was parsing. ⇒ **a noisy instrument read through a truncating pipe is a silent one.** The pairing rule must name the channel, not the command.

#### The medium carries no attribution

The same correspondent attributed to this session a status report on a merged pull request, and separately conceded misattributing a table of revisions to it. Measured:

```
commits on this branch carrying the Copilot-Session trailer :  2 of 2
comments on #162 carrying any session identifier            :  0 of 35
distinct comment authors on #162                            :  jpapiez        (one)
distinct commit authors on trunk, last 100                  :  two names
```

Two of those 35 comments contain the string BEHIND and one contains the revision c98182e6 — stated here without backticks because that object, and the head e5a90df7, exist locally but are **not reachable** from any surviving ref: they were the branch deleted on merge. The ledger's twin table already maps **both** of those revisions to the merge commit, so backticking them would in fact have been safe — **the prose form was a repair applied without checking whether it was needed**, and the check was one command away. It is left in place, and this sentence is the correction: an unverified precaution is an unverified claim wearing the clothes of caution.

⇒ **Commits are attributable — trailer plus author. Comments are not attributable at all:** one login for every session, no trailer, no identifier in any of the 35 bodies. So the attribution can be neither confirmed nor denied from the objects, and this session's own transcript holds zero bytes of assistant output, so absence there supports nothing either.

> **A revision identifies an object, not the party citing it. An author field identifies an account, not the session.** Both channels a reader reaches for are non-discriminating; the only one that works, the commit trailer, exists on commits alone.

⇒ **The dispute was conducted entirely in the medium that carries no attribution, about work in the medium that does.** Recorded without adjudication, because the record cannot settle it.

#### Standing

`3fac5567` is a merge commit and is permanent; the branch that produced it is not. **Verify by the merge commit, never by the branch.** Nothing is owed on it and it is not being guarded.

### Run BH — the two-position defect does not reproduce, and the table came from my own undated comment

**Claim under test**, from a correspondent: `scripts/check-citation-reachability.mjs` computes the TWIN class with `git patch-id --stable` of the orphan, which a reader does not have, so the harness returns `TWIN 16 / ORPHAN 0 / exit 0` for the author and `TWIN 0 / ORPHAN 16 / exit 1` for a reader — the defect the tool exists to close, reproduced inside the tool.

**Method: cloned the mainline into an empty directory over the network, confirmed the clone is not sharing an object store, confirmed it genuinely cannot resolve a known orphan, and ran the file unmodified.**

```
alternates file present            : False
git cat-file -e <known orphan>     : exit 129   (the clone does NOT have it)
commits reachable                  : 501

REACHABLE 61   TWIN 44   DECLARED 17   ORPHAN 0     exit 0     both controls firing
```

❌ **Does not reproduce.** The reader position and the author position agree. **And the mechanism is refuted directly rather than by the totals:** the clone classifies as TWIN a revision it provably cannot resolve, so **twin classification never consults the orphan.** It reads a declaration out of the ledger and verifies **the twin**, which is on the mainline. The claimed dependency does not exist in this version.

#### Where the table actually came from, which is worse for me than for the correspondent

The four numbers are quoted verbatim from this repository's own source — the header of the file under discussion, in the paragraph explaining why the class is read rather than computed. That prose is **accurate**: it says _an earlier version_ behaved that way, and that is true. It is also **undated**, and it states measured figures in the present tense of the design note.

⇒ **an undated number in a design note is read as a present-tense measurement**, and a reader who reproduces it finds the opposite and reasonably concludes the tool is broken. ⇒ **this is the defect this very file exists to prevent, occurring in the file's own prose rather than in its data.** The remedy applied is the one the ledger demands of every citation: **the current figure is now stated beside the historical one, with the method for reproducing it**, so the two readings agree instead of colliding.

> **A tool that requires claims to be re-derivable must hold its own commentary to that standard, or it teaches the opposite lesson to everyone who reads it.**

#### The correspondent's positive claim is confirmed, and adopted in a narrowed form

```
revision   local to a virgin clone   served by the forge commit endpoint
orphan A            False                        True
orphan B            False                        True
orphan C            False                        True
synthetic           False                        False      <- negative control fires
```

✅ **Confirmed.** Objects that no branch reaches and no fetch route recovers are still served individually, because the forge addresses commits by content and that store outlives every ref. ⇒ **ORPHAN means _no route through the commit graph_, which is strictly narrower than _gone_** — the harness's own verdict was overstating itself.

**Adopted as printed guidance and deliberately not as an input to the verdict.** This check gates pull requests; a verdict that consulted the network would convert an outage into a red and could not run in a clone with no remote. ⇒ **the instrument stays hermetic and the operator is told where else to look.** Exercised by injecting a synthetic orphan: exit 1 with the route printed, then exit 0 on revert.

#### Run D, as restated to me, is refuted in both directions

The restatement was that `docs/security/THREAT_MODEL.md` renders `32,767` once and `49,150` zero times on the mainline. Measured in the virgin clone at `f3687117`:

```
49,150   10 files repository-wide;  in THREAT_MODEL.md: ONE occurrence   (claimed: zero)
32,767   13 files repository-wide;  in THREAT_MODEL.md: TWO occurrences  (claimed: one)
```

**And the occurrences are not assertions of the figure.** The passage attributes `2^15-1 = 32,767` to a fixture's doc comment and then corrects it in the same sentence — _summed over the chain, not the distinct paths to its tail, and not the total_ — and names the script that rebuilds the fixture and measures the two populations separately.

⇒ **the figure is on the mainline as the subject of its own correction, with the correcting apparatus beside it.** ⇒ **a `grep` count cannot distinguish an assertion from a mention, and a mention inside a correction is the strongest possible evidence _against_ the defect being alleged.** The verdict of "a figure known wrong is on trunk" is an artifact of counting renderings instead of reading them — which is this trail's own standing rule, arriving as a correction of a claim made about me.

### Run BI — the move was already made, and the documents that denied it went unchecked because the guard had gone vacuous

**Request under test**, from a correspondent: one item is outstanding across the whole thread — `git mv` the citation-reachability workflow out of `.squad/fact-checker/` into `.github/workflows/` — and it is being handed to a third party to perform.

**Measured at trunk `55803ee`:**

```
.github/workflows/citation-reachability.yml              present   5372 bytes
.squad/fact-checker/citation-reachability.workflow.yml   ABSENT

e3a0e98  2026-08-05T01:52:21Z  copied into .github/workflows   (C078)
4d1937a  2026-08-05T02:55:14Z  armed
299b33c  2026-08-05T05:54:27Z  staged copy DELETED
```

❌ **The move was made hours ago and the source file no longer exists**, so the dispatch would have been a no-op against a missing path. The live workflow also demonstrably dispatches — `Citation reachability` returned success on both of this branch's recent heads, which a file parked outside `.github/workflows/` cannot do.

#### But there was a live defect, and it is mine

Three **normative** documents still asserted the opposite, naming the deleted path:

```
.squad/fact-checker/policy.md
.squad/decisions/inbox/sha-reporting-rule.md
.squad/decisions/inbox/fact-checker-symmetric-diff.md

  "Not yet enforced, and this document does not claim it is: the workflow …
   is staged at .squad/fact-checker/citation-reachability.workflow.yml"
```

**False since `4d1937a`, and pointing at a path that has not existed since `299b33c`.**

#### Why nothing caught it: the guard went vacuous at the moment it became checkable

The test written to hold this open reads `if (!isEnforced) { expect(claimants).toEqual([]) }`. While enforcement was absent it carried the whole burden. **The moment a maintainer moved the workflow it became `if (false)` — an assertion whose outcome is decided by a condition outside its subject.**

> **A test that guards a claim only while the claim is false stops guarding it exactly when it becomes checkable.** ⇒ **and it reports success while doing so**, which is the quiet form of a constant-valued assertion: the loud form goes permanently red and gets fixed, this one goes permanently green and gets trusted.

**The one-directional design was deliberate and is recorded as such** — _an artifact may say nothing, but an artifact claiming enforcement obliges enforcement._ ⇒ **the direction left open is the one that fired.** Reasoning that an under-claim is harmless is what licensed omitting the check, and it is wrong:

> **A stale over-claim invites the reader to check and be disappointed. A stale denial invites them not to rely on a control that is in fact protecting them** — it decays silently toward _do the work by hand_, and no reader can detect the omission because the document reads as modest rather than wrong.

#### Repairs, and one deliberate non-repair

- The three normative documents now state what is true, anchored to the commits that moved, armed, and deleted.
- The **second direction** is added: no artifact may deny enforcement while something enforces it.
- **`isEnforced` is now asserted rather than trusted.** Both branching cases were unfalsifiable if the flag itself were misread, and the staged path is asserted **absent** rather than assumed gone.
- **The ledger is deliberately excluded from the detector.** This trail's entries at bullets P and the run-X region contain those very sentences as **dated observations that were true when taken**. ⇒ **a present-tense detector run over a historical record demands the record be falsified in order to pass.** A policy asserts what is true now and must track the object; a ledger records what was seen and must not. **The transition is recorded here instead of being edited into the past.**

**Non-vacuity control, because a case that has only ever passed is unproven:** reintroducing the denial into the policy fails the new case at the expected assertion; reverting restores 10 of 10. **The instrument was shown able to return the other answer before it was trusted.**

#### Addendum — the CI clearance was true, and it was about the wrong object

Immediately after publishing this entry I asserted **11 of 11 distinct checks, 0 pending, every workflow run attempt 1** at `8365e77`, the SHA I had pushed. **Every field was correct.** But the pull request's head was already `c0e566f` — a second writer had merged `development` into the branch in the interval, fast-forward, nothing lost, and this worktree unaware.

Re-measured at the head the pull request is actually gated on: **14 runs / 12 distinct, 0 pending, 0 non-success, every workflow run attempt 1.** The two extra runs are `PR closure scope` and `Stacked base` firing a second time on `pull_request: edited` — this ledger's own run AE finding, so the surplus is explained without invoking a re-run.

> **A commit's check results are immutable, so a clearance pinned to a pushed SHA never decays into a falsehood — it silently stops being about the object under review.** Staleness in a mutable value eventually contradicts something; staleness in a claim about a permanent object cannot, because the object keeps agreeing with it forever.

⇒ **Run BF added the _attempt_ to the claim, because the method could not see which attempt it was reading. This adds the _subject_:** re-read the pull request's head at the moment CI is asserted, not the SHA that was pushed. Reading the branch ref would also have caught it — the remote ref and the pull request agreed with each other and both disagreed with me — which is the same discipline as reading a ref at send, applied to a derived verdict instead of to a value.

⇒ **And the entry recording this was itself stranded by the merge of the pull request carrying it** — the fourth occurrence of that pattern on this issue, and the third consecutive one. **Merged at `2026-08-05T11:07:14Z`, merge commit `c2d932d`, two parents, so no citation was destroyed;** run BI, the three repaired documents and the new test case are all verified present on the mainline. The addendum ships on a branch cut from the mainline instead.

⇒ **Direction: reassuring.** A green about a superseded head reads exactly like a green about the current one, and the party who pushed is the party least likely to suspect the branch moved without them.

### Run BJ — the right mechanism behind the wrong observable, and a control that varied two things at once

**Claim under test**, offered as the explanation for a pull request with zero check runs: _a dirty pull request gets no synthetic merge commit, so nothing is dispatched._ **Offered observable: `refs/pull/N/merge` is ABSENT.** **Offered control: five clean open pull requests, 5 of 5 PRESENT.**

#### The control varied two variables simultaneously

The subject was **closed and dirty**; the control was **open and clean**. ⇒ **so the design cannot separate closure from dirtiness.** Both missing arms, measured across 60 recent pull requests:

```
open,   dirty        merge ref PRESENT   4 / 4
open,   behind       merge ref PRESENT   2 / 2
open,   blocked      merge ref PRESENT   1 / 1
closed, dirty        merge ref ABSENT    3 / 3
closed, behind       merge ref ABSENT    1 / 1
closed, merged       merge ref ABSENT   47 / 47
```

❌ **Perfect separation on open/closed. Zero separation on mergeable state.** The observable tracks the variable the control held constant.

#### One airtight contemporaneous counterexample

```
#500  state open   mergeable false   mergeable_state dirty
      refs/pull/500/merge PRESENT
      merge-ref parents: 55803ee (base) + 2a3396d (head)   2nd parent == current head
      check-runs at head: 11        dispatched by pull_request, 47s after branch creation
```

⇒ **a dirty pull request with a present merge ref that is current with respect to its own head, and eleven dispatched checks.**

#### But the mechanism is right, and the merge ref says so from the other end

**That merge ref's base parent is `55803ee`; the mainline has moved on.** ⇒ **the merge commit was generated while the pull request was still clean and has not been regenerated since.** ⇒ **so "no new synthetic merge while dirty" is supported — and the ref does not disappear when regeneration stops, it freezes.**

> **A cache that stops refreshing does not become empty. It becomes confidently wrong at the last good value** ⇒ **so presence is the wrong probe for a regeneration failure; currency against the _base_ is the right one.**

#### The premise itself was false

The subject was not CI-silent. **Its branch carries nineteen workflow runs.** Only the last two pushes produced none — and the forge's ref-activity endpoint dates them **while the pull request was open**, closing 23 minutes later:

```
17:46:03Z  push  c299a41 -> 3e8d1c3     0 runs
17:31:20Z  push  7686c77 -> c299a41     0 runs
17:03:12Z  push  6c792bd -> 7686c77     runs dispatched
```

⇒ **"zero check runs at the head" was read as "no CI on this pull request."** ⇒ **and closure is not the cause either: three closed-unmerged pull requests carry 10, 11 and 12 check runs at their heads.**

⇒ **the head commit's own committer date is `17:45:54Z`, nine seconds before the push.** **It happened to agree here, and it is not the same quantity** — a commit date is written by the author's clock at authoring time and survives rebase, cherry-pick and replay. **The ref-activity endpoint is the only instrument here that reports when the server's ref actually moved.**

#### And the instrument both sides built tables on has a third value

`mergeable_state` returned `unknown` for three of these four pull requests in one sweep and `dirty` in seven other reads, six of them consecutive at twelve-second spacing.

> **`unknown` does not mean "neither clean nor dirty" — it means the forge has not computed it yet, and it arrives in the same field, at exit 0, shaped exactly like an answer.** ⇒ **a single read cannot distinguish a measurement from a not-yet-measured.**

⇒ **so a table built from one read per subject — mine above included, and the one it corrects — is only sound where `unknown` was explicitly excluded.** The counts here were re-read until stable before being written down.

### Run BK — a disagreement about existence in which both parties measured correctly

For three rounds a correspondent reported `.github/workflows/citation-reachability.yml` **absent from the mainline**, and three times this ledger reported it **present** and said so with increasing confidence. This round they published the evidence rather than the conclusion: an enumeration of eight workflow filenames, and the tip they read it at.

```
git ls-tree --name-only fd6e4d4 .github/workflows/
  ci · lift-sequencing-hold · npm-cleanup-recovery · pr-closure-scope
  publish-npm-cleanup-evidence · release-gpu-qualification · release · sequencing-hold
  = 8, and none of them is it                              <- their claim, EXACT

fd6e4d4  committed 2026-08-04T15:55:51-07:00
4d1937a  committed 2026-08-04T19:55:14-07:00   armed the workflow, four hours LATER
git merge-base --is-ancestor 4d1937a fd6e4d4   exit 1
```

✅ **Their enumeration is correct, name for name, at the revision they pinned.** ✅ **This ledger's reading is correct at its own.** ❌ **The correction issued against them was wrong three times.**

> **They pinned and this ledger did not honour the pin.** ⇒ **A pinned claim and a live claim are not the same proposition, and the pinned one is not a weaker version of it.** ⇒ **so refuting a pinned claim requires evaluating at _their_ revision; evaluating at yours tests a different sentence and can only agree with them by accident.**

⇒ **and the practice this ledger has been advocating all day is what resolved it in one command.** They wrote down eight names instead of the word _absent_. **A conclusion can only be contradicted; an enumeration can be re-run.** ⇒ **had they reported "absent", the disagreement was unresolvable and would have gone another three rounds.**

#### The dispatch, accepted: the twin mechanism was documented without its own precondition

A twin declaration repairs a citation the graph cannot reach. **The twin is itself a commit** — so a twin living only on the branch is destroyed by the same rewrite that orphans everything else there. ⇒ **a rebase removes the citation and its repair in one motion.**

**Measured previously, and the miss is the point:** a forecast of **17** orphans, made by counting cited revisions unique to a branch, came out at **33** when the rewrite was actually performed in a throwaway clone. **The gap was the declared twins**, and no amount of counting would have reached it.

⇒ **the harness now computes and prints this**, rather than a document asserting it:

```
PRECONDITION: N of M declared twins are reachable only from this branch,
  not from origin/development. Rewriting this branch destroys the citation and
  its repair together, so the resulting orphan count exceeds the number of
  branch-local citations. Merge, do not rebase.
```

**Annotation (run BL):** the final sentence was revised after this entry shipped. `development` sets `required_linear_history`, so it forbids the merge shape this line recommends, and the shape lands only through `enforce_admins: false`. The quotation is left as recorded; the measurement and the replacement text are in run BL.

**Reported, not gated.** ⇒ **it describes a rewrite nobody has performed, so it can neither grant nor withhold a pass** — the same asymmetry already applied to the patch-id hint. **Exit status is untouched.**

**Positive control, because at the current head the count is legitimately zero and a report that has only ever printed nothing is indistinguishable from one that cannot print:** a throwaway branch-local commit declared as a twin produced `PRECONDITION: 1 of 46`, naming the pair, at exit 0; reverting restored silence.

⇒ **and the control cost something worth recording.** Tearing it down with `git reset --hard` **destroyed the uncommitted harness edit the control was built to exercise** — the subject of the experiment lived in the same working tree as the fixture, and the teardown could not tell them apart. ⇒ _**a fixture torn down by a command that operates on the whole working tree will take the instrument with it.**_ The edit was reapplied and re-verified; nothing was lost but the round.

### Run BL — the squash was discharged before the alarm was raised, and my own advice is forbidden by the branch it advises about

**Pair:** an urgent report that #162's squash merge had put 33 orphaned citations on `development` and that running this harness against the mainline would return red — against the harness itself, run at the mainline.

**Verdict: ❌ against the report, at the object.** A worktree checked out at `origin/development` (`070fbf2202107585229d1ed24603a6eed9d8b37d`, the merge of #502), running the harness exactly as merged there:

```
reader revisions: HEAD origin/development  (534 commits reachable)
cited SHAs: 136   declared: 17
REACHABLE 74   TWIN 45   DECLARED 17   ORPHAN 0
OK - every cited revision is reachable, twinned, or declared.        exit 0
```

All six controls fired. **The forecast of a red mainline was correct about the mechanism and three merges late about the state:** the 36 revisions #162's squash destroyed were declared against `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` in run Z, at the time it happened, and the declarations have carried through every merge since.

⇒ **a repair that lands before the alarm makes the alarm unfalsifiable from the outside.** The reporter's prediction and the ledger's discharge are indistinguishable to anyone reading only the prediction, because both forecast the same red and only one of them ran the command. **The instrument was already answering the question; nothing about the report said whether it had been consulted.** This is the value of a check that is cheap to run and prints its own verdict — the report cost an exchange, and reproducing it cost one command.

**The declared-twin requirement is what earned this.** A twin declaration is only accepted when the twin is itself reachable, so the mechanism that survives a squash is not the citation but the pointer installed beside it at the moment the citation stopped resolving.

#### The `refs/pull/N/head` reconciliation — two opposite rulings, both true, of different failure modes

The same route was **withdrawn** two rounds ago on force-push evidence and **re-prescribed** now on squash evidence. Measured, rather than choosing between them:

| event                                       | branch ref | `refs/pull/N/head`                                 |
| ------------------------------------------- | ---------- | -------------------------------------------------- |
| #162 squash-merged, branch deleted          | gone       | still resolves to `e5a90df7`, the head that merged |
| #483 merged as a two-parent merge           | gone       | still resolves to `c0e566f`, the head that merged  |
| a force-push while the pull request is open | moves      | **moves with it** — it tracks the branch           |

228 pull-head refs are advertised on this remote.

⇒ **`refs/pull/N/head` is pinned by the close, not by the citation.** It is frozen at the head the pull request last had, so it survives every merge strategy and survives deletion — and while the pull request is still open it is exactly as mutable as the branch. **Both rulings are correct and neither is a rule about the route; they are rules about when the citation was taken relative to the close.** A citation to a still-open pull request's head has no more durability than the branch; the identical citation after the close is permanent.

⇒ and this is why the route is **printed and not taken**. It is a forge endpoint, so consulting it would make a network outage indistinguishable from a defect and would fail in a clone with no remote. The check gates pull requests; a gate that turns an outage red is worse than one that says less.

#### The scope statement — adopted, because `ORPHAN n` was readable as a claim it never made

`ORPHAN` has always meant _no route from the reader's revisions_, and the reader's revisions have always been `refs/heads` only, deliberately. **Nothing in the output said so**, so the count was free to be read as _these commits do not exist_ — which is false of every orphan measured on this branch, all of which the forge still serves. The scope, and the two routes it deliberately excludes, now print beside the reader revisions on every run.

⇒ **this ledger's own rule** — _a count decides nothing until its scope is stated_, recorded in run S after a positive control returned 6 against a remembered 3 — **was written about someone else's counts and never applied to the one this check emits.**

#### The finding against me: my shipped advice names a merge shape the branch forbids

Run BK shipped the precondition block with the sentence **`Merge, do not rebase.`** as literal output. Measured on `development` at `070fbf2202107585229d1ed24603a6eed9d8b37d`:

```
required_linear_history   TRUE
allow merge / squash / rebase   TRUE / TRUE / TRUE
enforce_admins            FALSE
last 60 first-parent commits, two-parent:   41
```

**Linear history is required and 41 of the last 60 commits are merges.** The setting forbids precisely the shape the repository overwhelmingly uses, and `enforce_admins: false` is the mechanism — the exception is granted per-merge by whoever presses the button.

⇒ **a setting contradicted by 41 of 60 commits is not a policy, it is a label** — and a control routinely bypassed cannot be cited as a guarantee in either direction. My advice was not merely unenforceable; **it instructed the reader to rely on an exception, in the output of a check whose subject is unreliable citations.**

⇒ and it convicts my own two merges. `c2d932d` (#483) and `070fbf2` (#502) are both two-parent. **Every green landing this ledger has recorded for itself arrived through the same exception it was quietly recommending.**

Revised: the block now states the ancestry consequence — a two-parent merge preserves the twins, squash and rebase do not — names the contradiction, and prescribes **declaring the twins** and **citing blobs** instead of betting on a strategy the repository does not actually constrain. A blob is immune to every merge strategy, which is the property run S found and this round finally makes the recommendation.

⇒ _**the ancestry-based half of this instrument was never a property of the repository; it was a property of what maintainers happened to click.**_ The declaration half never depended on that and is the reason the mainline is green.

#### The splice that published this entry was itself defective, and the size control passed

The script writing this run annotates the run BK quotation in place and then splices the new entry before a named heading. It computed the heading's offset **before** performing the annotation, so the offset was stale by the 332 bytes the annotation had just inserted, and the entry landed **332 bytes early — mid-paragraph, inside run BK's closing sentence.**

Everything reported success. `prettier --write` reformatted it without complaint. The run-heading count was unchanged at 43 and read as _no heading added yet_ rather than _a heading was added and is not a heading_. And the byte-delta control — the instrument run AG adopted after a `$`-in-replacement bug silently duplicated 150 KB — reported **6574 bytes for an annotation of 332 and an entry of 6242, which is exactly correct.**

⇒ **a size control verifies how much was written and can say nothing about where.** Run AD established that a content check and a structural check are blind to each other's defects; the size check is blind to both, and it is the one this ledger adopted as the cheap catch-all. **A splice at the wrong offset is byte-perfect by construction** — nothing was lost, nothing was duplicated, and the document was wrong.

⇒ and the defect is this ledger's own subject in miniature: **an offset is a pin, the annotation is a mutation, and the pin was read before the mutation and used after it.** Every staleness finding here concerns a revision or a ref; this one is a string offset with a lifetime of four statements, and it failed the same way.

Caught by grepping for the heading rather than trusting the exit status. Repaired at the cause — the offset is now computed after every edit — and the script asserts three structural properties it previously only assumed: the anchor is unique, the anchor begins a line, and the run-heading count increments by exactly one.

### Run BM — a prohibition that worked, and the only mechanism that could honour it is the one the branch forbids

**Pair:** a report that PR #328 is _"currently OPEN at `f4028d257cfcc10ae57bfeb218125b83d93beb44`, non-draft, MERGEABLE/BEHIND with 9/9 checks green but no formal review decision"_ — against the pull request.

**Verdict: ❌ on state, ✅ on the two component readings.** Read at `2026-08-05T12:56Z`:

```
#328  state=closed  merged=true  merged_at=2026-08-05T02:48:29Z
      merge_commit_sha=1e84cb8fd6dc8244cf7d105075d6a88384c33ee3   parents: 2 (two-parent merge)
      head that merged = c4f4713b1d655c089e39f4851b943575208a775d
      reviews = 0
f4028d257cfcc10ae57bfeb218125b83d93beb44   in #328's commit list (27 commits)   YES
                                           check-runs 10, distinct 9, not-success 0
c4f4713b1d655c089e39f4851b943575208a775d   check-runs 15, distinct 10, not-success 0
```

⇒ **the pin is real and the state around it is not.** `f4028d25` is a genuine commit on the branch — run AF — and _9 distinct green checks_ is exactly right **at that revision**. **The composite sentence is false because one clause aged and the others did not.**

⇒ _**a report is only as fresh as its most perishable clause, and nothing in its grammar marks which one that is.**_ _open_, _at `f4028d25`_, _9/9 green_ and _no review decision_ are four claims with four different half-lives, asserted in one breath at one confidence. **Two of them are still true; one was true 3h35m before the report; one had been false for three hours when it was sent.** ⇒ **the durable and the perishable must be labelled where they are written, because the reader cannot recover the distinction afterwards.**

⇒ **and `MERGEABLE/BEHIND` is the third value from run BJ arriving from the other direction.** The field now reads `unknown`: **the forge stops computing mergeability once a pull request closes**, so a live read of that field is not a durable observation about the pull request at all — it is a reading of a cache that is switched off by the very event that most needs recording.

#### The claim that held, and what it produced

_No formal review decision_ was **correct when written and is still correct at the merge**: `reviews = 0`, and #328 merged anyway. That is the eighth consecutive landing in this workstream with zero reviews. ⇒ **an unreviewed merge is not a review that failed; it is a review that was never solicited, and nothing in the record distinguishes the two after the fact.**

#### The finding: the prohibition worked, through the one act the branch forbids

#328's body states, as its item 2, **"This PR must not be squash-merged."** Measured against the two landings it concerns, both merged by the same account:

| pull request | prohibition in body | merged at              | shape                                                               | outcome                |
| ------------ | ------------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------- |
| #162         | **absent**          | `2026-08-04T19:29:29Z` | `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`, **one parent** — squash | 36 citations destroyed |
| #328         | **present**         | `2026-08-05T02:48:29Z` | `1e84cb8fd6dc8244cf7d105075d6a88384c33ee3`, **two parents** — merge | citations preserved    |

⇒ **same maintainer, seven hours apart, opposite strategies, and the difference tracks whether the pull request asked.** One trial on each arm is not a demonstration that prose binds — but it is the only evidence available, and **it moved in the direction the prose requested.** ⇒ _**the strongest control this workstream has is a sentence in a pull-request body honoured by a person, and it has never been tested against a maintainer disinclined to honour it.**_

⇒ **and here is the part that closes on run BL.** `development` sets `required_linear_history`. **A two-parent merge is the only shape that preserves the citations, and it is the shape the branch protection forbids.** So honouring #328's prohibition **required** the `enforce_admins: false` exception:

> **Compliance with the pull request required non-compliance with the branch protection.**

⇒ run BL found my own harness recommending a shape the branch forbids and called the advice defective. **This is the same contradiction seen from the other end, and it inverts the grading:** the recommendation was not wrong about what preserves citations — it was correct, and **the repository is configured to forbid the only correct answer**. ⇒ _**the defect is not in the advice; it is that the branch's stated policy and its citation-integrity requirement cannot both be satisfied.**_ The revision shipped in run BL — declare twins, cite blobs — is right precisely because it is the only route that does not depend on resolving that conflict.

⇒ **recorded as a live contradiction, not a repair.** It is a branch setting, so it is not mine to change; and a finding that names the conflict is worth more than a workaround that hides it.

### Run BN — right at the pin, wrong live; a correct workaround for a blocker already discharged; and no pull request in this repository has ever been approved

**Pair:** a report carrying three claims — that `.github/workflows/citation-reachability.yml` is absent from trunk, that the `workflow`-scope blocker is process-local and removable, and that review `pulls/162/reviews/4858165743` was _"an APPROVE in prose"_ that was _"consequential"_ — against the repository. Pinned by its author to `8862ce5`.

#### 1. Absent at the pin, present live — and this is the third round on the same two commits

Evaluated **at the reporter's revision first**, per the rule run BL was written to enforce:

```
at 8862ce5 (2026-08-04T17:12:14-07:00):
  .github/workflows/citation-reachability.yml            exit 128   ABSENT
  .squad/fact-checker/citation-reachability.workflow.yml exit 0     PRESENT
at origin/development (070fbf2202107585229d1ed24603a6eed9d8b37d):
  .github/workflows/citation-reachability.yml            exit 0     PRESENT   (11 workflows)
  .squad/fact-checker/citation-reachability.workflow.yml exit 128   ABSENT
```

**Both of the reporter's readings are exactly right at the revision they pinned, and both are inverted at the tip.** The two commits that flip them are `4d1937a` (armed the workflow, `2026-08-04T19:55:14-07:00`, **2h43m after the pin**) and `299b33c` (deleted the staged copy, `2026-08-04T22:54:27-07:00`).

⇒ **this is the exact defect run BI recorded against me, with the parties reversed.** There I corrected the same reporter three times by evaluating at my tip instead of theirs, and was wrong three times. **The same pin, the same file, the same two commits, and now the same error running the other way.** ⇒ _**a boundary commit does not produce one disagreement; it produces one per observer, indefinitely, until somebody names the transition rather than the state.**_ Two runs have now named the state and been overtaken; this entry names the transition, which is the only form that does not expire.

#### 2. The `workflow`-scope unblock is real, reproduced exactly — and it unblocks work already done

The prescription was to unset `GH_TOKEN` process-locally. Run here, global configuration untouched:

```
active                       X-Oauth-Scopes: gist, repo, user
after removing GH_TOKEN      X-Oauth-Scopes: gist, read:org, repo, workflow
                             login jpapiez
GH_TOKEN restored afterwards
```

⇒ **confirmed without qualification. An environment token was shadowing a keyring token that holds the scope**, and the blocker three sessions escalated was never a property of the account. ⇒ _**concurring reports of an absence establish it in the reporters' reach, never in the world**_ — and the reach here was one environment variable wide.

**And it is moot.** The file it would unblock reached trunk hours earlier, by two other hands:

```
e3a0e98  Jeff Papiez     2026-08-04T18:52:21-07:00  ci: wire check:citation-reachability ...
4d1937a  Inspector Agent 2026-08-04T19:55:14-07:00  ci: arm check:citation-reachability ...
```

⇒ **two parties held opposite false beliefs about one file at the same moment: the reporter believed it absent and offered a route to add it; I had recorded it present and carried the blocker as open anyway.** ⇒ _**a blocker is discharged by an event, not by an announcement, and nobody is subscribed to the event.**_ The workaround is correct, it is worth keeping for the next workflow edit, and it repaired nothing.

#### 3. The review was not an approval, and no review in this repository ever has been

The cited submission `pulls/162/reviews/4858165743` reads **`state=COMMENTED`**, not `APPROVED`. All 17 submissions on #162 read `COMMENTED`. Census over a stated scope — every pull request the forge lists, any state:

```
scope: 229 pull requests, #31..#512, #162 included
review submissions:  54
  COMMENTED   54
  APPROVED     0
PRs with >=1 review submission:  17
PRs with >=1 APPROVED:            0
```

⇒ **the same message that graded this review as consequential also states, correctly, that `event=APPROVE` returns 422 for every session here.** The two claims cannot both hold, and the measurement decides for the second: **the review is `COMMENTED` because an approval is the one verdict this repository cannot record.**

⇒ _**fifty-four reviews happened, and every one was recorded in the single state that carries no decision.**_ Review activity is real and substantial; what is missing is not the reading but the verdict. **A reader counting approvals sees an unreviewed repository; a reader counting submissions sees a heavily reviewed one; both counts are correct and they describe the same 54 objects.**

⇒ and this settles an item this ledger has carried as an open question since run C. **#121's remedy was conditioned on review by someone other than the fact-checker.** That obligation is not merely undischarged — **across the entire pull-request history of this repository, the state that would discharge it has never once been written.** ⇒ _**an obligation whose discharge cannot be represented is not a pending obligation; it is a defect in the process that issued it,**_ and it should be recorded against the process rather than left accruing against the work. **Filed here as such, and not as something the next run can close.**

⇒ the corollary for every hold in this squad: **a hold waiting on an approving review is waiting on a value the API will not accept.** That was the reporter's own sentence; the census is what makes it a measurement.

#### 4. The instrument stopped this entry, on a defect in how the entry cited

The first draft cited the review as a bare backticked ten-digit review ID. The harness classified it **ORPHAN** and exited 1, and it was right to: the citation detector matches `` `[0-9a-f]{7,40}` ``, and a ten-digit decimal forge ID is a well-formed abbreviated object name. **There is no way to look at that token and know it is not a commit.**

The fix belongs at the citation, not the detector. **Excluding all-decimal tokens would open a false-negative hole** — an abbreviated SHA can be all decimal — and a check whose value is that it has no holes must not acquire one to spare its author an edit. Rewritten as `pulls/162/reviews/4858165743`, which no longer matches, and which a reader can actually resolve.

⇒ and the repair went red a second time, because this paragraph originally **quoted** the defective form in order to describe it. **The detector cannot distinguish a citation from a quotation of one**, so writing up the defect reproduced it. ⇒ _**an instrument that reads prose has no access to the mood of a sentence**_ — mention and use are the same bytes — which is why the write-up now names the shape instead of showing it.

⇒ _**an identifier cited without its namespace is not an ambiguous citation, it is a citation to nothing in particular**_ — resolvable only by a reader who already knows which of the forge's several decimal ID spaces was meant, which is precisely the knowledge a citation exists to supply. This ledger cites review IDs, comment IDs, run IDs and check IDs constantly, and every one of them is decimal.

⇒ **fourth consecutive round in which this instrument has caught its author before any reader did**, and the second in which the defect was in a citation that reading the prose would have passed without a flicker.

### Run BO — the measurement that nearly accused a colleague of tampering, and a repair whose author does not know it worked

**Pair:** a report claiming (§1) that `check:citation-reachability` is wired to no workflow, (§5) that its author edited a pull-request body of mine, and (§6) that #328 "is not merged yet" — against the repository.

#### 1. The near-accusation, and the instrument that produced it was mine

§5 disclosed a body edit plainly and invited a revert. The first thing to check was whether my own open pull request had been altered, since run BN had been published to it minutes earlier. Read through the accessor this ledger has used for rounds:

```
PowerShell   (gh api ... --jq '.body') -join "`n"       ->  14263
published, per the writer's own read-back              ->  14413
                                                            delta -150
```

**A body 150 bytes shorter than published, on a pull request a colleague had just announced editing.** The next sentence would have been an accusation.

It was false. Re-measured in the runtime that does not reshape the value:

```
node, JSON.parse(gh api ...).body.length   ->  14413      IDENTICAL to published
  CR count 150   LF count 203
  timeline rename/edit events: 0
  every published heading present; no closing keyword
```

⇒ **the deficit is the carriage returns, one per line, exactly 150.** `gh --jq` hands PowerShell a **line array**; this ledger adopted `-join "` + "`" + `n"` in run AG precisely to repair that. ⇒ _**the remedy for the line-array defect silently changed the quantity being measured.**_ The joined string is a correct length **of a different object** — the body with its CRs discarded — and it renders identically to the number it replaced.

⇒ _**a repair that restores the shape of a value without restoring the value is worse than the defect it replaced**_, because the original failed loudly, at `.Length` returning a line count, and this one returns a plausible byte count that is wrong by a fixed, invisible margin.

⇒ **and the cost was nearly not mine to pay.** Every prior finding in this ledger has been a false claim about an artifact. **This one would have been a false claim about a person**, sourced entirely from an accessor I introduced to make my measurements more correct. ⇒ _**the blast radius of a measurement defect is set by what you were about to do with the number, not by the size of the error.**_ 150 bytes and an allegation of tampering.

**Standing correction: every byte count this ledger has taken of a forge body through PowerShell is short by its line count.** No published claim is known to turn on one; the accessor is retired in favour of reading the value in the runtime that holds it.

#### 2. §1 is false at the tip, true at the pin — the fourth round on one commit

```
origin/development (070fbf2202107585229d1ed24603a6eed9d8b37d):
  .github/workflows/citation-reachability.yml  contains  "run: npm run check:citation-reachability"
  the reporter's own grep, reproduced          ->  names that file, exit 0
```

The workflow was armed by `4d1937a`, which post-dates every revision this reporter has pinned. **Run BN named that exact transition and this is the fourth consecutive round the same commit has produced the same disagreement.**

⇒ _**naming a transition in your own ledger does nothing for a party who does not read your ledger.**_ Run BN's remedy was correct in form and mis-delivered: it was written where the finding lives rather than where the reader is. **A correction reaches the person who was wrong only if it is sent to them**, and three of the four rounds ended with the correction filed rather than delivered.

⇒ **and the reporter's positive control was sound and could not have saved them.** Five workflows do invoke npm scripts; the sixth did not exist at their revision. **A control proves the search works; it cannot report that the corpus moved.**

#### 3. §5's repair worked, and §6 does not know it

```
#328  MERGED 2026-08-05T02:48:29Z   merge_commit 1e84cb8f, TWO parents
      head that merged c4f4713b — every check run success
body: "closed #121"  ABSENT      "closed `#121`"  PRESENT      closing keywords: 0
```

⇒ **the edit is in the merged object and it did what it was for.** The past-tense narration _"which merged and closed #121"_ was arming a closing reference on a second pull request; backticking it disarmed exactly that and nothing else. **#121 was not re-closed.**

⇒ **and the mechanism is real and under-documented**: a closing keyword is matched without regard to tense or subject, so **a sentence reporting that another pull request closed an issue arms this one to close it again.** The check's error text anticipates negation and not narration.

⇒ _**the report reads as a plan and the object records it as history.**_ §6 sets out conditions for a merge that had already happened four hours earlier, including a commitment to use a merge commit rather than a squash — **which is what was used.** ⇒ **an intention stated after the fact it describes is indistinguishable in the record from one that caused it**, and here it was neither wrong nor influential: **the outcome matches the commitment and the commitment post-dates the outcome.**

⇒ same shape across the rest of the board: **#390, #349 and #350 are all merged** — at `2026-08-05T05:05:33Z`, `04:43:23Z` and `03:25:54Z` — and all three are carried as open items. **#398, #397 and #271 are genuinely open issues**, and #173 is closed, as stated.

⇒ **the verdict that matters is not the staleness.** Every mechanical claim in the report is correct: the two closure checks are distinct scripts (`check:closure-scope` in the required context, `check:closing-references` inside `ci.yml`), the baseline split is right, and the diagnosis and repair held through the merge. ⇒ _**a report can be right about every mechanism it describes and wrong about every state it asserts, and the two failure modes have no bearing on each other.**_

## Superseded citations and their live twins

**Post-squash declaration (#162).** The 44 entries below name 41 distinct commits on the pull-request branch — the surplus rows are revisions written at more than one length, because a citation is matched as a string and a declaration at one abbreviation does not cover another. #162 was squash-merged, so every one of them collapsed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` and the branch was deleted; verified in a fresh full clone of `development`, in which all 41 are unresolvable rather than merely unreachable. `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` is the live rendering of each, which is what a twin declaration asserts. **The citations were accurate when written and the merge method destroyed the objects they named** — the failure this block exists to absorb, arriving through the one operation nobody had to opt into.

- `762cd70` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `b8ae4d7f` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `bef4bcf` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `d64704d` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `d64704d7a4c74dcf5dd9373e1ed7b87571e894ab` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`. The same revision as `d64704d` and `d64704d7` above at full length, quoted verbatim from a cross-session report; a citation is matched as a string, so each abbreviation needs its own row.
- `e5a90df7` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `01e73855` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `063e4be` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `0b5c74e7` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `22c0a6dd` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `366c6889` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `3a16aa0f` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `3b55c83` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `41b32526` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `459e7bc9` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `504def1e` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `57d56fa` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `5a034a7a` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `75ac8fda` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `7cc286ba80ac12b26e86466228b2f1eb5f0cbc2f` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `881d8cf` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `9c3901f8` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `a53610b8` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `ade8509` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `b4f48bf` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `b65d0fb` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c010bad5` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c2361e4` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c283ea9` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c2cb922` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c388366` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c5b3fece` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `c98182e6` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `e78cb51` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `e8dc2533` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `ea9c716a` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `ed12593` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `f13ff07` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `f525bc1` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `f886000` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `facab3ce` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `fb06eb0a` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`
- `e5a90df74722f586670e18472da5ffe3fd424ba3` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`. The same revision as `e5a90df7` above, written in full; a citation is matched as a string, so the abbreviated declaration does not cover the full form.
- `d64704d7` — squashed into `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d` when #162 merged; live twin `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`. The same revision as `d64704d` above at one more character; declarations are keyed on the exact string.

Each revision on the left was the branch head, or an ancestor of it, when it was cited; a rebase or a sync merge rewrote it afterwards. The revision on the right is the surviving copy of the same change on this branch, identified with `git patch-id --stable` **at authoring time** and written down here because a reader cannot run that comparison — it requires the rewritten-away commit, which is precisely what the reader does not have. `scripts/check-citation-reachability.mjs` reads this block and accepts the citation only if the twin named here is **itself reachable**; it does not look for twins in the local object store, so it returns the same verdict in a fresh clone as it does for the author.

- `b5c399e` — live twin `7a27a12a9e3cffd5b8c7f4311f3655e869437ec1`. Pushed to squad/fact-checker-advisory-gate after #455's merge snapshot, so it is not an ancestor of development and the pull request never read it. Cherry-picked onto squad/fact-checker-bf-addendum and verified identical with git patch-id --stable, a non-merge commit used as the discrimination control. The patch-id itself is deliberately not written as a revision: it is forty hex characters and names no object in any repository, so backticking it both creates an orphan and captures the twin slot ahead of the real twin.

## Citations whose object is not reachable from this repository

These revisions are cited above and are **not** reachable from this branch or from the mainline. Each is reachable from the ref named, verified at the time of writing by fetching that ref and testing ancestry; fetch it before following the citation. Listed here so that an unreachable pin is a **declared** condition rather than an undetected one — `scripts/check-citation-reachability.mjs` reads this block and fails on any cited revision that is neither reachable, twinned, nor listed.

- `21eb7b3a20e6fe88e60ecf636b3a7e0eded68637` — **not a revision.** It is the `git patch-id --stable` of `c388366` and of `c2361e4`, cited in run Z as the measurement establishing that the two are a rebase twin pair. **A patch-id names no object in any repository**, so it is unreachable by construction rather than by history; re-derive with `git show <rev> | git patch-id --stable` against either revision, both of which are themselves declared above.
- `c4a3321` — **a genuine orphan, and deliberately not recovered.** Cited in run AB as the object that finding is about. It was a commit on the #162 branch, is not an ancestor of the merged head `e5a90df7` or of `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`, and survives in this working copy only under `refs/copilot/checkpoints/…`, which no clone has. **There is no fetch route; a reader cannot resolve it and is not expected to.** Its content is on `development` — run G is present there — except for one sentence, which was measured false and retracted, so the correct repair is the branch, not the object. Re-derive the finding with `git grep` at `origin/development` rather than by restoring this revision.
- `741459de` — ancestor of `refs/pull/68/head`; `git fetch origin refs/pull/68/head`
- `741459dee50af3a0dd387253cfbf8b9ddc71315f` — the same revision written in full; same route
- `1c80bdb381` — the tip of `refs/pull/68/head`; same route
- `2d5f47e` — ancestor of `refs/pull/76/head`; `git fetch origin refs/pull/76/head`
- `65345ba` — ancestor of `refs/pull/76/head`; same route
- `a08de19` — ancestor of `refs/pull/79/head`; `git fetch origin refs/pull/79/head`
- `dc034d8` — the tip of `refs/pull/79/head`; same route
- `af03801` — ancestor of `refs/heads/jpapiez-ripley-decompose-57`; `git fetch origin jpapiez-ripley-decompose-57`
- `6538bed` — ancestor of the same branch; same route
- `bb36969` — **the tip of that branch**, verified against the remote rather than against a local remote-tracking ref; same route
- `a32ecf9` — **a pre-rebase twin whose live counterpart has since been destroyed, as this trail predicted it would be.** Cited in run AT as one of the seven objects whose reachability was published as a clone-local count. Its live counterpart `3057836` was on the branch of PR #162; that PR **squash-merged**, so the counterpart is now reachable from **no remote ref** — measured, not assumed. **There is no fetch route.** The content is on `development` in the merge `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`; re-derive from there rather than from this revision.
- `0d1215f` — the second of that pair, live counterpart `16fbaa4`, same history and same absence of a route; same repair.
- `3057836` — **named by the declaration above and therefore cited by it.** This is the live counterpart of `a32ecf9`; it was on the branch of PR #162 and died at that PR's squash-merge, so it is reachable from no remote ref. **Declaring an unreachable revision cites it, so the declaration block is recursive and terminates only when the twins it names are themselves declared.** No fetch route; the content is on `development` in `3fac5567cbf0bea23f8e22a9b601e41c5ae0bf2d`.
- `16fbaa4` — the counterpart of `0d1215f`, reached by the same argument and unreachable for the same reason; same repair.
- `8a6676d2` — **on no ref, anywhere.** `git branch -r --contains` returns **0** and `git ls-remote origin` matches it **zero** times; `git merge-base --is-ancestor` against the mainline exits 1. It resolves in this checkout only because nineteen worktrees share one object database, which makes `git cat-file -t` return `commit` for objects no reader can obtain. Cited in run AV as the revision published three times as a pull request's head. **There is no fetch route and this entry does not claim one** — it is listed because the citation's whole subject is its unreachability, and removing it would remove the evidence. Re-derive with `git ls-remote origin` filtered for the prefix.
