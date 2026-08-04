# The fact-check consistency check is symmetric, and it has now been run

`.squad/fact-checker/policy.md` no longer scopes the cross-artifact check as
_"does `.squad/decisions.md` actually say what was claimed?"_. That scoping made the
decision log the authority and the other artifact the thing under test, so the check
could only fire when the other artifact disagreed with the log. It could not fire when
the log itself held the wrong rendering — which is a failure the log records having
happened.

The policy now carries two rows in place of one. The original one-directional form is
retained for its correct object, claims made _about_ the log. A second row covers two
or more artifacts rendering one incident, and points at a new
**Cross-Artifact Symmetric Diff** section that designates no authority.

What that section requires, for any agent running the check:

- Enumerate **every** rendering, not two — the question is which renderings **exist**, not
  which ones disagree. The reason is structural: **a repair can only cover the renderings
  that existed when it was made**, so any rendering created afterwards is outside its
  scope. The live finding in this
  batch is that shape: when `32,767 rows` was written into the threat model, the correct
  total for the same fixture had been in the tree that commit was written against for
  **4h46m27s**. No diff between the copies known at repair time could have seen it;
  enumeration at the current head is what does.
- **Establish precedence by ancestry, not by timestamps.** Two commits minutes apart can
  sit on branches that never met, and a squash merge lands content without the commit — so
  a claim that something was written _after_ a correction was available needs
  `--is-ancestor`, or the correction present in the rendering's own parent tree. This rule
  is here because this batch published the inference without it and had to retract it.
- Publish the extraction rule and the head with the result, and run a control that can
  report non-empty.
- Report a disagreement against the **pair or the set**, never against whichever member
  is not the decision log.
- Establish that both artifacts fill the same slot before treating a difference as a
  defect. At document scope a difference is deductive; between test corpora or fixtures
  it is a lead to be measured.
- A clean result on a **dependent** pair is a false negative and is recorded ⚠️
  Unverified, never ✅ Verified. The test is asymmetric: **dependence can be proved**
  (one commit writing both, a long verbatim run, a repair recorded as made by reading
  the other), while **independence cannot be proved by provenance alone** — separate
  commits and authors are evidence, never proof, because a figure can be copied a week
  later. ⚠️ is therefore the default for any bare clean diff.
- **✅ grades independence, and only an author's statement of method reaches it.** The grade
  asks one thing: is the agreement between these renderings evidence of anything? It is
  **not** a grade of the value. So a derivation from the object, or a measurement re-run at
  the source, does **not** earn ✅ however strong it is — those establish that the value is
  **right**, and a pair can be a copy of a copy and still be right. Grading ✅ on them fails
  open: they would license ✅ on a pair the same policy proves dependent, whenever the
  copied value happens to be true, and they are the cheapest routes to reach for. They
  belong under **Discharge**. What is left for ✅ is direct testimony about
  provenance-of-belief — an author saying how they arrived at the value — which history
  provably cannot supply, so **⚠️ is the overwhelmingly common honest grade**. Record the
  **grade** and the **resolution** as two separate lines, so a run that derived the value
  from the object and found every rendering conforming has somewhere truthful to say so
  instead of inflating the grade. **A harness is not the object; a harness is a fourth
  rendering**, and routes count by **class of mechanism**, not by author — three people who
  each rebuild the fixture and walk it have replicated one method rather than corroborated
  it. **Copying from the object is verification; copying from another rendering is
  contagion.** The strongest instrument this batch found — retrieving the pre-fix
  implementation at `741459de` — is a **Discharge** example and not a ✅ example, and it was
  very nearly recorded as the latter.
- **Report the divergence and the measurement; do not report how the defect happened unless
  the mechanism was measured.** This cost the batch more rounds than anything else: three
  unmeasured causal sentences accumulated across the review, none removed until they were
  removed together, each sitting beside a measurement nobody ever contested. An accurate
  outcome with a plausible mechanism attached is still a fabrication, and the repair never
  needs it.
- **A symmetric diff establishes divergence, not truth.** It cannot say which rendering
  is right, so never resolve by counting renderings: two that agree are **one** if they
  are dependent. Derive the value from the thing that is not a rendering — the code, the
  constant, the fixture, the computation — and publish the derivation. Where no such
  source exists, the finding stands and resolution escalates to the artifact owners.
- **Prefer a recorded derivation where one exists.** A no-authority instrument is the
  right tool when no artifact is privileged; where one records the method that
  established a value, it _is_ an authority for that value, and reaching past it for the
  diff is choosing the weaker tool. Find the divergence with the diff, then cite the
  derivation so a reader can reproduce the conclusion and not only the disagreement.
- **Arithmetic consistent with a decomposition is not its derivation** — that two figures
  sum is true whatever the residue consists of. Measure the populations separately, and
  either take the measurement or attribute it. An accurate outcome with a plausible
  mechanism attached is still a fabrication.
- **Repair with the source's own noun.** Where the defect is a quantity attached to the
  wrong unit, restating the correction in the unit that caused the error re-seeds it.
- **Before calling a source ambiguous, test the rival reading against the whole sentence,
  qualifiers included.** That some other true quantity exists in the same object does not
  convict a phrase of naming it. This rule is in the policy because this batch broke it:
  a rival reading was reported as a defect in `.squad/decisions.md` when the phrase's next
  word ruled it out. Retracted; see the audit trail.
- **Rule out "different quantities" before ruling "stale."** A symmetric diff cannot tell
  those apart, and reporting the second as the first is a false finding manufactured by
  the check itself.
- **A disagreement is discharged only by repairing every rendering** — not by explaining
  why the two differ, and not by repairing only the rendering whose author is nearest.
- Where a corrected figure disagrees with a source a reader will reach for, name the
  relationship and not only the number.

The corrected check has been run, and `.squad/fact-checker/audit-trail.md` is no longer
a single `n/a` entry. Five runs are recorded there: the two historical pairs in opposite
directions, one dependent pair whose clean result is graded ⚠️ rather than ✅, one live
finding resolved only once the pre-fix implementation itself is
retrieved, and one agreeing set that comes back clean — which also
proves the check does not blanket-deny. **No run earns ✅**, on the settled definition
above, and that is reported as the grade being narrow rather than the check being broken.

The live finding is the same diamond-DAG row count the log already records. Its repair
fixed `.squad/skills/test-discipline/SKILL.md` and left a third rendering in
`docs/security/THREAT_MODEL.md` § _T2.2 — Structurally valid input that reaches an
untested code path (A1)_ still reading `32,767 rows`. **It was resolved by measurement,
not by majority** — the two agreeing `49,150`s are dependent, the log itself recording
that the figure enters the shared token set by being written into the skills file to
repair it, so by this policy's own rule their agreement grades ⚠️ and could not decide
it. Rebuilding `diamondDag(14)` from `tests/viewer.partTree.test.tsx` and walking it with
a path-local `seen` set, measuring each population separately, is what settled it: 49,150
rows total, 32,767 emitted for `m`-chain nodes and 16,383 for `s` nodes, against 16,384
distinct paths to the tail. So `2^15-1 = 32,767` is paths through the `m` chain summed
over the chain, and it is not the total, which the threat model's sentence claimed. A units
mislabel rather
than a merely stale number; both readings were tested before repairing. **How the mislabel
came about is not established and is not asserted**, and nothing needs it: at that commit's
own tree the fixture comment already attached the word _rows_ to `32,767`, so no conflation
need be posited. That rendering
has been repaired in the same change, since filing it and leaving it would be the
discharge failure the new rule exists to prevent. The decomposition and its method were
already on record in `.squad/decisions.md`; the run should have **cited** that derivation
rather than resting on the divergence alone — as a reporting duty, not as an authority,
since designating one would reinstate the very defect #121 names.

Governing entry, cited by heading: `.squad/decisions.md` →
**2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own
review found**. This change is the remedy that entry names, and it was authored by the
fact-checker, so per that entry it must be reviewed by someone else.

## No wording correction for Scribe. A referral was made here and is withdrawn.

An earlier version of this note asked the Scribe to reword the entry recording the
diamond-DAG decomposition, on the grounds that its phrase _"paths through the `m` chain
alone"_ named neither 32,767 nor 16,384 cleanly. **That finding was wrong. The entry is
correct as written and needs no change.** The retraction is recorded in full in
`.squad/fact-checker/audit-trail.md`; in short, two measurements withdraw it:

- Distinct root-to-node paths ending at an `m`-chain node = **32,767**, identical to the
  `m`-chain row count. Not a coincidence: under a path-local `seen` set every emitted row
  _is_ a distinct root-to-node path, which is the explosion the fixture demonstrates. So
  `32,767` is a row count **and** a path count, and "paths" is not a wrong noun.
- The rival reading proposed against it — the 16,384 paths to the tail — is ruled out by
  the phrase's own next word. Of those 16,384 paths, **16,383 traverse an `s` node** and
  exactly **one** stays in the `m` chain _alone_. The qualifier does not survive the rival
  reading, so the rival reading belonged to the reporter and not to the source.

Nothing downstream moves: the threat model's sentence claimed the **total**, the total is
49,150, and that repair stands on its own grounds.

Left here rather than deleted because the Scribe was told once that this entry was
defective, and a withdrawal that is only an absence is indistinguishable from forgetting.

Harness output, so the figures can be checked rather than taken on trust. Rebuilds
`diamondDag(14)` as `tests/viewer.partTree.test.tsx` defines it and walks it with a
path-local `seen` set — the pre-fix behaviour the figure describes — counting each
population separately rather than subtracting one reported figure from the other:

```
objects in fixture           : 29
TOTAL rows emitted           : 49150
  rows for m-chain nodes     : 32767
  rows for s nodes           : 16383
distinct paths to tail m14   : 16384
paths ending at an m node    : 32767   <- equals the m-chain row count
of paths to tail, via an s   : 16383   <- so only 1 stays in the chain "alone"
```

The harness source is `scripts/measure-diamond-dag.mjs`, runnable with plain `node`, no
build step and no test runner. It is in the repository rather than only in a pull-request
body, because a correction that lives somewhere less durable than the thing it corrects
loses to it.

**The harness is not the authority, and the entry should not cite it as one.** A model of
the pre-fix walk is a fourth rendering of that behaviour. What settles the decomposition
is the shipped pre-fix `flattenPartTree` at
**`741459dee50af3a0dd387253cfbf8b9ddc71315f`** — one `rows.push` per visit, a path-local
`const nextSeen = new Set(seen).add(objectId)`, and no `MAX_PART_TREE_ROWS` in that
revision, so rows are visits and uncapped. That commit is on no ref; it was recovered via
`gh pr view 68 --json commits`.

**A convergence was claimed here and is withdrawn with the finding it supported.** This
note previously reported that a second session had reached the same conclusion about the
log's phrasing by a different route — reading `a32ecf9`'s wording, with no harness and no
walk — and offered it as the kind of independent convergence the log asks for. Both halves
fail. The conclusion was false, as the retraction above records; and that route had
consumed this run's figures **by direct reading**, which its own author disclosed. It was a
dependent rendering with the dependency living in prose rather than in a commit — harder to
see, no different in kind, and it grades ⚠️ by the same rule as any other dependent pair.
**A well-argued report is a rendering.** Agreement between two accounts of a measurement is
not agreement between two measurements.

Recorded rather than quietly fixed: the imprecision the earlier version reported in
`.squad/skills/test-discipline/SKILL.md` and in the fact-checker's own first repair was
real _as ambiguity_, and both now name which quantity they mean. That is a disambiguation
and not a repair of an error; neither file was previously wrong.
