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
  enumeration at the current head is what does — and **_the current head_ means the
  mainline's, not the checking branch's.** Measured here rather than supposed: while this
  branch sat behind, three new renderings of the same quantity landed on the mainline, and
  an enumeration at the branch head would have returned the earlier set and reported it
  closed. A branch that is behind is a stale enumeration by construction.
- **Read the hits; do not count them.** A search cannot tell a **rendering** from a **mention**,
  and a retraction is the worst case because it necessarily contains the sentence it
  withdraws — **a search for a refuted claim scores a hit on the document that refuted it.**
  Mechanical filters are worth running and `scripts/measure-mention-filter.mjs` measures two,
  but a filter is **triage that narrows the reading, never a discriminator that licenses a
  count**: its precision can be checked by printing what it removed, while its recall cannot
  be established without reading what it kept.
- **Establish precedence by ancestry, not by timestamps.** Two commits minutes apart can
  sit on branches that never met, and a squash merge lands content without the commit — so
  a claim that something was written _after_ a correction was available needs
  `--is-ancestor`, or the correction present in the rendering's own parent tree. This rule
  is here because this batch published the inference without it and had to retract it.
- **A reachability claim must name the space it searched, and a positive control does not
  fix an unsearched region.** `git branch --contains` searches branches; `refs/pull/N/head`
  and tags are not branches, so a zero means _not present among branches_, never _absent_.
  A control that fires shows the instrument is sensitive **within** the space searched and
  says nothing about that space's boundary — so when both arms of the control are the same
  kind of ref, it cannot reveal that the question ranges wider. Reachability is provable by
  one containing ref and not disprovable by an incomplete enumeration of refs, which makes
  _unreachable_ the claim that has to state its scope. Where a cited revision is
  branch-unreachable by construction — a pre-squash commit, which by definition never
  landed — give the reader the fetch command; an instruction to verify somewhere
  unreachable is not a citation.
- Publish the extraction rule and the head with the result — naming the **mainline** commit
  the enumeration was current with, since a set closed on a branch is closed only as of that
  branch's base — and read that base **by ref name**, never from a SHA quoted in a message,
  because such a SHA resolves and greps perfectly while being stale and so fails silently.
  A push report (_pushed X from Y_) is exempt: it records an event, and events do not decay.
  **Then publish the value read, not the command that read it.** The exemption is a
  **requirement**, not a permission: suppressing a base pin does not make a claim safer, it
  makes it **unreproducible** — worse than a stale pin, since a stale pin is falsifiable and
  an absent one is not. **An over-broad rule against pins fails toward _less_ evidence, the
  one direction no reviewer can detect**, because a reader who cannot reproduce a figure sees
  their own failure rather than the omission that caused it.
  **And stating a head is a disclosure, not a check — state it _and assert it live at
  publication_, re-read from the remote at send rather than at draft.** A head true when the
  work was done and false when the report shipped satisfies every disclosure rule and misleads
  every reader, so _"say which head"_ is not the repair it looks like: **it has no falsifier,
  since you can always say which head.** The gap is the **drafting interval**, and four sessions
  have now shipped a stale-SHA warning **from a stale SHA** while stating the rule correctly in
  the same artifact — **the warning does not protect the party issuing it.** Adopted from the
  coordinator, whose formulation is stronger than the one first proposed here.
- Run a control that can report non-empty — and hold any instrument reporting **identical**
  or **absent** to the same requirement, over the space actually searched. Agreement from an
  instrument that always agrees is not evidence, and a re-enumeration rule that has only ever
  produced changes cannot be distinguished from one that always reports change.
  **Run the pattern where the answer is known, in both directions**: a detector that fires in
  the passing case has no discriminating power, and a pattern matching nowhere may be dead
  rather than describing an absence. **Absence must be tested for directly, never inferred** —
  not from two things comparing equal, not from an empty grep, not from a zero count, not from
  an empty ref listing, since in each case _no result_ and _no such thing_ arrive as one value.
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
- **Routes count by class of mechanism, not by author.** Three agents each walking the
  graph is one method run three times. That is replication, which tests for slips and
  cannot detect a systematically wrong walk, because every run repeats the walk.
  Corroboration needs a second **class** of mechanism, and only corroboration bears on
  whether the method was right. Counting agreeing agents as agreeing routes inflates the
  evidence by the number of people involved. This is the same rule as **a well-argued
  report is a rendering**, seen from the other end.
- **✅ grades independence, and only an author's own first-person statement of method reaches it — nobody can give it on their behalf.** The grade
  asks one thing: is the agreement between these renderings evidence of anything? It is
  **not** a grade of the value. So a derivation from the object, or a measurement re-run at
  the source, does **not** earn ✅ however strong it is — those establish that the value is
  **right**, and a pair can be a copy of a copy and still be right. Grading ✅ on them fails
  open: they would license ✅ on a pair the same policy proves dependent, whenever the
  copied value happens to be true, and they are the cheapest routes to reach for. They
  belong under **Discharge**. What is left for ✅ is direct first-person testimony about
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
- **A citation must be reachable by the reader, not by the author.** An author's object store is not the repository: where worktrees share one object database every superseded head resolves for its creator forever and in a fresh clone never, with **no local symptom** — so the party responsible for a pin is the party who cannot see it die. Rebase, squash and `update-branch` orphan pins _after_ they were correctly written, so pinning more carefully does not reach it. **The reader model must be stated**, because reachability from `refs/heads`, from the full advertisement, and from what a reader of one PR holds are different questions with different correct answers. A dead pin is usually **repairable by substitution** via `git patch-id --stable`, and for a claim about a file's contents the repair completes only when the twin is shown to carry **the same blob** — a twin shares its patch, not its tree. An unreachable citation is acceptable **declared and routed**, never merely correct. Checked by `scripts/check-citation-reachability.mjs` — run it with `npm run check:citation-reachability`. **Enforced on every pull request.** The workflow is live at `.github/workflows/citation-reachability.yml`: it was moved there in `e3a0e98`, armed in `4d1937a`, and the staged copy this document used to name was deleted in `299b33c`, so that path no longer exists. It could not be pushed from the authoring branch — that token lacks the `workflow` OAuth scope and the Contents API refused the same path, both attempted and measured — and a maintainer completed the move. The licence for the word is still held by a test rather than by a promise: `tests/citationReachability.test.ts` fails if any of these artifacts claims enforcement while no live workflow invokes the harness, **and now also fails if any of them denies enforcement while one does**. The second direction was added only after all three of these documents sat stale for hours behind a guard that looked one way. Credit: the general rule is the coordinator's, derived independently on his own notes.
- **A SHA identifies an object, not the party who cited it — a set of SHAs carries no
  attribution.** Two sessions examining one pull request cite the **same** identifiers, because
  identifiers belong to objects and not to readers, so an enumeration cannot be attributed to an
  author by its contents. Measured: a coordinator attributed an eight-row table to this session
  because its SHAs matched; **six of the eight are the `commit_id` fields of another party's
  reviews**, and the table was that party's. **The tokens agreed because they were always going
  to.** Third member of the common-mode family — two parties reading one ref produce one reading,
  two parties citing one object produce one token set — and the general form is that **agreement
  is evidence only when disagreement was available.** Attribution needs a lookup against
  something that discriminates: who pushed, who authored, which review id.
- **An identifier decides nothing until its namespace and its cardinality are stated.** Two differing identifiers show two entities only if both come from the **same** namespace; one shared identifier shows one party only if it is **unique** to a party. Measured in both directions on one pull request: thirteen reviews sharing a single `user.id`, where one identifier covers parties that must be distinguished; and a session-state directory name compared against a `Copilot-Session` commit trailer, where two identifiers from **different** namespaces were read as two sessions and named one — the drafts of the disputed commits sit in the directory said to belong to the other session. **Equality and inequality both look like results**, so neither failure announces itself. Name the namespace before comparing; establish cardinality before concluding; and where no identifier has the cardinality the question needs, report that **the record cannot answer it**.
- **Two measurements of the same mutable ref, taken at the same moment by two parties, are
  not two readings — they are one reading, reported twice.** Measured: two sessions with no
  contact, each pinning a head from **two sources** at read time, converged on the same value
  and both were wrong when it was used. Neither made an error. Two sources protect against a
  wrong answer at the instant of reading and do nothing about the interval before use, which
  both shared. **Lateness is common-mode**, so a current ref value cannot be carried between
  parties at all; re-read it by name at the point of use. Credited to the coordinator session
  that measured the convergence.
- **A property is not stale only through the passage of time — it is stale the moment another
  writer can change it.** This batch verified `git rev-list --merges` empty immediately before
  a push and reported **no merge commits**; within the hour a coordinator ran the REST
  `update-branch` to keep an approving review reachable, which **creates a merge commit**. The
  action was correct and the property was gone anyway. **A branch-shape claim is therefore an
  event claim** — _"no merge commits at `<sha>`, verified at push"_ holds forever, while _"the
  branch has no merge commits"_ can be falsified by a non-author with no push and no warning.
  **The instrument closest to hand is the one that cannot see it:** the local worktree stayed
  clean and correct and knew nothing. Re-read shape from the **remote ref** at the moment of
  use.
- **A reconstruction and the thing reconstructed are not two renderings of one quantity.**
  A reconstruction built from a _description_ of the object inherits every error in the
  description, so **agreement among reconstructions cannot detect an error in the
  description** — they agree exactly as hard when it is wrong. This batch's own harness
  took its **graph** from the fixture and its **traversal rule** from prose; had the prose
  been wrong, every figure would have been internally consistent, agreed with two
  independent walks, and measured the wrong thing. That is why three agreeing walks bought
  nothing and one `git grep` against `741459de` bought everything. Where a reconstruction
  is used, **record which inputs came from the artifact and which from a description of
  it.** Credited to the #57 session.
- **✅ is unavailable for judgement claims, and is reported as unavailable rather than
  approximated.** The grade presupposes something the renderings are renderings _of_.
  Claims about artifacts have one — what code did at a revision, what a document says,
  what a constant enforces. Judgements do not: whether a rollout order is correct, whether
  a decomposition is honest, whether a criterion is checkable. No route reaches ✅ there
  and none ever will, so say so — the failure mode is **a judgement dressed in the
  vocabulary of a measurement**, carrying a grade, a figure and a citation with nothing
  underneath any of them. **A grade only some claims can earn is worth more than one every
  claim can simulate.** Credited to the #57 session.
- **A symmetric diff establishes divergence, not truth.** It cannot say which rendering
  is right, so never resolve by counting renderings: two that agree are **one** if they
  are dependent. Derive the value from the thing that is not a rendering — the code, the
  constant, the fixture, the computation — and publish the derivation. Where no such
  source exists, the finding stands and resolution escalates to the artifact owners.
- **Report any derivation already on the record, and do not treat it as an authority.**
  Where an artifact records not just a value but the method that established it, say so
  and cite it, so a reader can reproduce the conclusion and not only the disagreement.
  That is a **reporting duty, not a licence to privilege the artifact**: a recorded
  method still has to be re-run to be worth anything, and you cannot tell a recorded
  derivation from a recorded non-derivation without evaluating it — at which point the
  evaluation, not the record, is what carries the weight. Designating any rendering an
  authority reinstates the one-directional defect this section exists to remove.
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
not by majority** — the two agreeing `49,150`s are dependent: per `.squad/decisions.md` →
_2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own
review found_, the figure is shared between the two documents because the repair wrote it
into the skills file. **That wording is a paraphrase, and _"shared token set"_ was this
file's phrase, not the log's** — an earlier version of this sentence attributed it to the
log without an anchor, so a reader grepping the log for it found nothing and had no way to
tell an invented citation from a real one. Cited by heading here for that reason. So by
this policy's own rule their agreement grades ⚠️ and could not decide
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
walk — and offered it as the kind of independent convergence `.squad/decisions.md` →
_2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own
review found_ asks for. Both halves
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
