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
  which ones disagree. **Corrections do not propagate to renderings that do not yet
  exist**: a repair fixes the copies visible at the time, and the next author reaches for
  whichever copy is nearest, which may be a superseded one. The live finding in this
  batch is exactly that shape — a figure re-rendered into a new document 45 minutes after
  its correction was published. No diff between the copies known at repair time could
  have seen it; enumeration at the current head is what does.
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
- **✅ is conformance to the object, not a history of authorship.** Requiring proof that
  two renderings could not have been copied makes ✅ unreachable, and a grade nothing can
  earn is redefined the first time someone needs a clean result. Independence is a
  precondition for **agreement** being informative, not a route to ✅. ✅ requires a
  derivation from the non-rendering source that is published, re-runnable and
  deterministic, with every enumerated rendering conforming to it. **Copying from the
  object is verification; copying from another rendering is contagion.** The determinism
  requirement is what discharges the author's own prior exposure to the figure — a
  re-runner gets the same value whatever the author believed — though it does not
  discharge bias in _what the author chose to measure_, which is why the derivation
  itself must be published and not merely its output.
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
finding, and one agreeing set graded **✅ by conformance to the enforcing constant** —
which also proves the check does not blanket-deny.

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
over the chain — each emitting one row, which is how a path count came to be written as a
row total — and the threat model's sentence claimed the total. A units mislabel rather
than a merely stale number; both readings were tested before repairing. That rendering
has been repaired in the same change, because filing it and leaving it would have been the
discharge failure the new rule exists to prevent. The decomposition and its method were
already on record in `.squad/decisions.md`; the run should have cited that authority
rather than resting on the divergence, and the policy now requires it.

Governing entry, cited by heading: `.squad/decisions.md` →
**2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own
review found**. This change is the remedy that entry names, and it was authored by the
fact-checker, so per that entry it must be reviewed by someone else.

## One wording correction for Scribe, in `.squad/decisions.md` itself

Not made here, because `.squad/decisions.md` is Scribe's artifact and this is a wording
change rather than a finding.

The entry recording the diamond-DAG decomposition renders the sub-quantity as
_"paths through the `m` chain alone"_. The measurement above shows that phrase names
**neither** figure cleanly:

- rows attributable to `m`-chain nodes = **32,767** (= `2^15-1`, paths summed over the chain),
- distinct paths **through** the chain to its tail `m14` = **16,384** (= `2^14`).

The phrase most naturally reads as the second and is used for the first. The entry's
finding is unaffected and its decomposition is correct — the threat model claimed the
**total**, and the total is 49,150. But the entry is cited as the authority for this
quantity, so its phrase should pin which one it means. Suggested wording:
_"32,767 rows are emitted for `m`-chain nodes — `2^15-1`, the paths summed over the
chain, not the 16,384 distinct paths to its tail."_

Harness output, so the correction can be checked rather than taken on trust. Rebuilds
`diamondDag(14)` as `tests/viewer.partTree.test.tsx` defines it and walks it with a
path-local `seen` set — the pre-fix behaviour the figure describes — counting each
population separately rather than subtracting one reported figure from the other:

```
objects in fixture           : 29
TOTAL rows emitted           : 49150
  rows for m-chain nodes     : 32767
  rows for s nodes           : 16383
distinct paths to tail m14   : 16384
m + s == total               : true
```

The harness source is in the pull request that closes #121, self-contained and runnable
with `node`.

Recorded rather than quietly fixed: the same imprecision was present in
`.squad/skills/test-discipline/SKILL.md` and in the fact-checker's own first repair, and
both are corrected in this change. An authority whose phrasing is imprecise is still the
authority; it just needs to say which quantity it names.
