# Independence of routes is a property of mechanism, not of authorship

**Filed by:** 🔍 Fact Checker, from PR #328 (follow-up to #162 / #121).
**Status:** landed. Drafted at the coordinator’s request during #162 and parked in a session file; see **"What the parking cost"** below, which is the part of this note with teeth.

## The rule

Two renderings corroborate each other only if the routes that produced them differ **in class of mechanism**. They do not corroborate merely because different people produced them.

> **Routes count by class of mechanism, not by author.**
> Three agents each walking the graph is one method run three times. That is _replication_, which tests for slips. It is not _corroboration_, which requires a second mechanism and tests for a wrong method. Replication cannot detect a systematically wrong walk; every run repeats it.

And the companion, which is the same rule seen from the other end:

> **A well-argued report is a rendering.**
> Agreement between two accounts of a measurement is not agreement between two measurements. **Copying from the object is verification. Copying from another rendering is contagion.**

## Why this is a decision and not only a fact-checker procedure

It governs any claim that a figure is confirmed, and it has produced errors outside the fact-checker’s artifacts: convergence tallies that counted members which were the same mechanism under different names.

## Worked example, and it convicts its author

The fact-checker reported a **commit timestamp** to the coordinator as the time a rebase moved the branch. A reviewer copied that exact figure into a published addendum and had to retract it. GitHub’s own timeline for #162 records a `head_ref_force_pushed` event **after** the commit timestamps, and an earlier one that the report never mentioned at all.

**A commit timestamp is not a push time.** The reviewer’s error was not carelessness — he took an exact figure from a careful source. **That is the contagion path, and the more careful the source, the less likely the recipient re-derives.** Care in the sender manufactures unwarranted confidence in the receiver, and the sender cannot fix it from their end.

## What the parking cost — the reason this note is worth reading

This note sat in a session file, unpublished, from the round it was drafted until the round it landed. **In that interval one of its own claims was measured and refuted, and the refutation went into the artifacts the note is about while the note kept the error.**

The draft asserted that `git merge-base --is-ancestor` exits **1** both when a commit is not an ancestor and when the object is absent. **That is false.** Measured:

```
0    ancestor
1    a real object that is not an ancestor
128  cannot determine — the object is absent
128  cannot determine — the *second* argument is absent (unfetched ref)
129  the command never ran — malformed invocation (see below)
```

Committing the draft unedited would have published a retracted claim into the decision log, which is **the most durable artifact in this repository**, from a file no check reads and no reader can see.

> **A parked draft does not hold still. It goes stale in place, and the correction lands in the artifacts while the draft keeps the error.**

This ledger has repeatedly recorded the inverse — a correction living somewhere less durable than the thing it corrects. **This is the same defect with the arrow reversed, and it is worse, because the parked text is invisible to every instrument until the moment it is published as current.**

## Consequence for controls

A control inherits the rule. `git merge-base --is-ancestor <review_commit> <head>` is a real instrument and it is **one-directional in the same way the check #121 was chartered on was one-directional**: it asks _was the branch rewritten_, not _is this pin still true_. A review pinned several commits back returns **exit 0, no alarm**, while the file it cited has changed underneath it — and **append staleness is the common case, because appending is most of what anyone does**.

The blob comparison discriminates all three:

```
git rev-parse <review_commit>:<path>   vs   git rev-parse <head>:<path>
  differ -> the pin is void, whether by rewrite or by append
  same   -> the pin is live, even across a rebase that carried the file forward
```

And the exit code must be branched on **by value**, never by truthiness. Almost nobody writes `exit == 1`; they write `if (!ok)`, `set -e`, `||`. Under any of those, **1 and 128 are one value**, and a failed fetch, an unfetched pull-request ref, or a typo all report as _rewritten_.

> **The defect is not in the exit code. It is that a three-valued answer — ancestor / not-ancestor / cannot-tell — is being read through a two-valued test. Treat 128 as _no answer_, never as _no_.**

Pre-check with `git cat-file -e <sha>^{commit}` to separate _absent_ from _no_.

### `for-each-ref --contains` does not answer the question it is read as answering

It is tempting to reach for `git for-each-ref --contains <sha>` to decide whether a commit is still
on a branch. **It reads the local ref store**, and a branch deleted upstream leaves
`refs/remotes/origin/…` behind until something prunes it. Measured on a merged pull request whose
branch had been deleted, the **merged head** reported four branch-shaped refs — including
`refs/heads/…` and `refs/remotes/origin/…` — while `git ls-remote` for that same branch returned
nothing at all.

> **`for-each-ref --contains` answers _did this repository ever cache a branch containing this
> commit_. It is read as _does a branch contain this commit_. It fails toward the reassuring answer,
> and it fails there selectively for commits whose branch has been deleted — which is exactly the
> population anyone runs it on.**

**A stale remote-tracking ref is not a weaker witness than a live one; it is textually
indistinguishable from one.** The discriminating pair is `git ls-remote`, which goes to the remote
and cannot be satisfied by a local cache, plus **content** at a named revision, which does not care
what any ref says. Neither `cat-file -e` nor `--is-ancestor` nor `for-each-ref` separates a live
branch from a deleted one.

### Two readings inside one window are one snapshot, not a corroboration

The two-source rule above buys **source diversity**. It has **no purchase on temporal decay**, and
_sampling twice_ is the intuition that conceals the gap.

> **Agreement between two readings taken inside one window is evidence of a consistent snapshot, not
> evidence that either reading is current. A stopped clock read twice is not corroborated;
> repetition is precisely what it has to offer.**

This matters most when the second reading is used to promote the first from _observation_ to
_stable_. A single stale read is a wrong value. **Two agreeing stale reads are a wrong value plus a
false warrant**, and the warrant is what licenses the promotion. **Repetition strengthens the wrong
answer**, which is the same shape as a query that returns the same phantom rows on every re-run.

The remedy is not a third source. It is a **timestamp beside every value**, and re-derivation at the
moment of use rather than at the moment of composition.

### A finding's addressee is metadata

This repository has already established that a commit's identity fields are populated with values
that look like answers and do not identify the session that produced it. **The consequence is not
confined to git.** When several sessions share a role, a message addressed to that role is not
thereby a message about that role's work, and a finding relayed with an addressee attached carries
no more warrant for the attachment than a copied figure carries for its value.

> **A finding is a claim about an artifact. Open the artifact.** A remediation aimed at a defect that
> is not present does not no-op — **it writes the defect in.**

### Unreachability is not evidence of value

A commit that has fallen off a branch looks like a loss and invites recovery. **Check its content
against the branch before restoring it.** In the case that produced this note, an orphaned commit's
changes had all landed except a single sentence — **and that sentence was one that had since been
measured false and retracted.** Restoring the orphan on the strength of its being unreachable would
have reinstated a retracted claim.

### A content check and a structural check are blind to each other's defects

**Text can be present to every instrument that reads it and absent to the reader it was written
for.** An entry in this squad's audit trail was spliced into the interior of the previous entry's
last line, with no line break before it. `git grep` finds every word; a Markdown reader never sees
a list item, because a bullet marker in the middle of a line is not a bullet. Two other entries
cite that entry by name, so the reader who follows a citation lands inside a different entry's
paragraph.

**It survived every gate.** The formatter accepts the line, the citation harness resolves the
revisions inside it, and no test reads the document as a sequence of entries. **The artifact had
only ever been checked for the presence of content** — figures, phrases, citations — **and never
for whether its entries are entries.**

**The generalisation is a scoping rule, not a new check.** A check evaluates a predicate over a
rendering it chooses: content checks range over the text, structural checks over the shape, and
**neither can see a defect that lives in the other's rendering.** So a claim of the form _"the
artifact is correct"_ is only ever a claim about the rendering that was examined, and the honest
form names it.

**And the two disagreeing is the check working.** Here a line-anchored search reported the entry
**missing** and a content search reported it **present** — a false negative and a false positive
on one object, with the truth at neither. The failure available at that moment was to trust
whichever instrument ran first; **the recovery was to read the hits in full**, which is the rule
this squad already holds for enumeration and which located the missing newline directly.

### Durability and currency are independent, and the fix for one is not a fix for the other

**A claim moved into a durable artifact survives the channel. It does not thereby stay true.** This
squad adopted _put your standing in the pull-request body, the only artifact that outlives a
message_ as the remedy for a communication channel that delivers hours late. The remedy is correct
about **transport** and silent about **re-derivation**, and the block that resulted carried a
measured figure unchanged through four pushes while the quantity it named moved four times.

**A stale claim in a durable artifact is worse than a stale claim in a message**, because it accrues
the artifact's standing and is read by people who were not present when it was taken. The message is
disbelieved by default; the artifact is not.

**The mechanism to guard against is a rendering that does not distinguish measured values from typed
ones.** In the case that produced this note, five fields in one fenced block were queried live and a
sixth was a string literal, laid out identically. **Neither a reader nor the author could tell them
apart from the output.** Where a status block mixes both, either derive every field or mark the ones
that are asserted.

**And a figure that has never been seen to move is not evidence of stability.** It is equally
consistent with a figure that was never re-taken, and those two cases are indistinguishable from the
value alone. The discriminator is to run the instrument over several points and confirm it returns
**different** answers — a control this squad already requires of reachability and patch-identity
checks, and had not applied to its own status reporting.

### The exit-code taxonomy is a property of the tool _and_ the shell, and ours has a fourth value

**`129` is not in the three-valued rule this squad has adopted, and it means something the other
three do not: the command never ran.** _Could not answer_ and _was never asked_ are different facts,
and only the second is the caller's own error.

**It arrives from the remedy, not from the hazard.** The guard prescribed to disambiguate `128` is
`git cat-file -e <sha>^{commit}`, published with the argument bare. Measured on PowerShell, which is
what this repository is built and tested on:

```
                      real object   absent object
  unquoted                129           129
  quoted                    0           128
```

**Unquoted, the pre-check returns the identical code for a present object and an absent one.** It
destroys precisely the distinction it exists to make, and silently — `129` is non-zero, and every
published example tests non-zero.

> **A control that can only answer _cannot tell_ never fires and never alarms, which is
> indistinguishable from a control that passes.**

**So quote the argument, and branch by value across four codes: `0` yes, `1` no, `128` no answer,
`129` not asked.** More generally: **a rule stated about a command is not thereby true of the line
someone will paste.** Every rendering of this taxonomy in the repository states the tool and omits
the shell, and the shell is where the fourth value comes from.

**The correction propagated faster than its verification.** The three-valued form now appears in six
notes under five authors, which is the same mechanism this note already records for figures: a
result is copied because it is right about the thing it names, and the recipient does not re-derive.

## A test whose stimulus is too weak returns the reassuring answer

Issue #291 reports that a PowerShell exit code is stale after an early-terminating pipeline stage.
The obvious reproduction — a command that exits immediately, piped to that stage — returns the
**correct** exit code on every arm, because the process has already finished by the time the
pipeline stops. Six arms, six passes, and the idiom looks clear. Substitute a producer that emits
slowly and the same arm reports success for a command that failed.

**The discriminating variable was the stimulus, not the instrument**, and the natural stimulus is the
one that cannot elicit the defect. This is the same shape as a model that agrees with its object on
every published figure because the fixture never reaches the branch where they differ, and as a
mutation control that cannot distinguish an ineffective mutation from an inert test. In all three
cases the run completes, reports cleanly, and licenses a conclusion it never tested.

**Consequence.** A reproduction attempt that fails to reproduce establishes nothing until it is shown
capable of reproducing — which requires a positive arm in the same run, not a separate
demonstration recalled from elsewhere. An exoneration needs a control exactly as much as an
accusation does, and is far less likely to be given one.

## A size assertion is a control that content and structure checks do not subsume

An entry for the audit trail was inserted by a script whose replacement text happened to contain a
dollar sign immediately followed by a backtick. In a JavaScript replacement string that sequence
means _the entire portion of the subject before the match_. The insertion silently duplicated about
150KB of the file.

**Every check available locally passed on the corrupted result:** the new heading was present, the
section anchor was present, and the structural detector written for a previous defect reported zero
problems. The formatter would have accepted it. What caught it was `git diff --numstat` reporting
**307 insertions for a fifteen-line entry**.

**A content check asks whether the expected material is there. A structural check asks whether it is
positioned correctly. Neither can see material that nobody wrote** — and duplication satisfies both
by construction, because every duplicated element is genuine. Size and count assertions are the
cheapest instrument that has any purchase on this class, and they are the ones normally skipped as
trivial.

## An escape hazard is a property of any interpreted replacement, not of a shell

Three instances arrived within one hour, in three languages: a backslash-dollar written for bash and
passed through PowerShell, where the backslash is not an escape and the variable still expands; an
unquoted commit-peel suffix, where the shell consumes the braces and the command never runs; and the
dollar-backtick above, consumed by a JavaScript replacement.

**Stating the first as a bash-versus-PowerShell difference was already too narrow when it was
written.** The general condition is that a string is interpreted by something between the author and
its destination, and the author is reasoning about the destination. The repairs are all the same
move — remove the interpretation rather than escape it correctly: single quotes, quoted
arguments, a replacement **function** instead of a replacement string. Escaping requires knowing
every special sequence of every layer; disabling interpretation requires knowing none of them.

## Counting a false claim is anti-correlated with correctness, because guarding against it requires holding it

A grep for a wrong rendering cannot distinguish the file that **asserts** it from the file that **refutes**, **quotes**, or
**regression-guards** it. That much is already the use-versus-mention rule. The consequence that is not obvious, and that has now
produced a live false finding, is the direction of the bias.

**A repository that guards against a false sentence must contain that false sentence.** A regression test that proves a claim would have
been caught has to bind the claim as a fixture. A retraction has to quote what it withdraws. A decision entry recording a repair has to
state what was repaired. So the better a defect is documented, pinned, refuted and guarded, the **more** copies of it the tree holds —
and a checker that counts occurrences scores the best-disciplined artifact as the most defective one.

This fired here. Two sides were compared on a hit count for a wrong figure: the side with more hits was reported as holding the
divergence live, when in fact the figure was repaired on both sides and the extra hits were a regression fixture, a decision entry, and
the ledger entry recording the repair. **The count was accurate and its sign was backwards.**

Three consequences worth keeping:

- **No refinement of the pattern recovers the difference.** Use and mention are identical strings by construction; the discriminator is
  the surrounding sentence, so the hit has to be read. A filter can triage, and triage can never license a count.
- **Occurrence counts must never be compared across two corpora as a proxy for defect load.** The corpora differ in how much they
  document, which is a property nobody intended to measure.
- **A superseded present-tense claim in a durable artifact is a live hazard even when a later entry corrects it**, because a reader who
  stops at the first hit never reaches the correction. Scope the earlier claim in place; do not rely on ordering. Correcting the record
  in a location the reader may not reach is the same defect as not correcting it.

## A derived claim cannot go stale; a true claim has no mechanism that keeps it true

A status sentence in a durable artifact — _"all four failing checks are inherited from the
base"_ — is a measurement with a timestamp, and nothing in the artifact records the
timestamp or re-takes the measurement. It was true when written. Within the hour two of
the four had been repaired upstream and had become the branch's own, and the sentence had
become false **in the direction that exonerates its author**, which is the direction
nobody rechecks.

The repair is not to write the sentence more carefully. It is to **compute it at read
time**: read the failing check names here, read them on the mainline, and render the
comparison. A computed claim has no interval during which it can be wrong. **The two are
indistinguishable in the output** — both render as the same English sentence — so the
choice cannot be audited by reading the artifact, only by reading what produced it.

This is the same rule as _publish derivations as files_, arriving on status rather than on
figures, and it is why a generator is worth more than a well-written paragraph: the
paragraph's accuracy is a property of the moment it was typed.

## A fix aimed at the instance leaves the same defect in the mirror position

An instrument compared two sides. Its failure filter counted any run whose conclusion was
not `success` as failed — which scores a **pending** run, whose conclusion is `null`, as a
failure. The defect was found on the near side and repaired there.

**The identical defect remained on the far side, and it fails in the opposite direction.**
An incomplete comparand yields an _empty_ failure set, which does not read as "unknown" —
it reads as **"the other side is clean"**, and therefore attributes every shared failure to
the side being measured. It then did exactly that.

> The mirror position is the least-watched place in an instrument, precisely _because_ the
> bug was just fixed. A repair creates confidence whose scope is the instance and whose
> felt scope is the class.

The general rule: **when a defect is found in how one operand is handled, the repair must
be applied to every operand of the same kind in the same expression, and the reviewer's
question is "where else does this value appear", not "is it fixed here".** A defect in a
_comparison_ has at least two sites by construction.

## Confirming a repair requires the failing step, not the check's colour

A commit that fixes a defect may still be red for an unrelated reason — here, a type error
was repaired and the same contexts still concluded `failure` on formatting, going green
only at the _following_ commit. **Same check name, same colour, different step.**

Verifying a fix by reading the fix commit's status returns _not fixed_, with no signal that
the question was answered about something else. Read the step, and read the commit after
the one carrying the fix.

## A verdict recorded against an object that does not determine it

A check that reads something mutable — a pull request body, a label, a live upstream
ref — and reports its result on an immutable commit is measuring two things and naming
one. The same commit can then carry opposite conclusions, both honestly produced, and
nothing in either report says which of the two inputs moved.

Observed on one commit: `Desktop (windows-latest)` failed and `Desktop (macos-latest)`
succeeded, because a step in both reads the pull request body and the body was edited
between the two starts. **The reading that pair invites is a platform-specific defect,
because platform is the only difference the two names expose.** The actual discriminator
was the clock, which is in no field.

The consequence runs in the reassuring direction. A required _code_ context was turned
green by editing prose; the tree never moved, so nothing re-evaluated the code, and the
green is truthful about the body while saying nothing about the commit it is attached to.

## Re-running a job is not a second sample when the job reads outside the tree

A re-run is normally a flake test: same inputs, drawn again. That holds only while the
job's inputs are the tree. When a job reads a mutable object, the second run has
**different inputs**, so a green re-run is evidence about that object now and not about
the commit — and it is indistinguishable, in the check list, from a flake that settled.

The practical rule: a job that reads outside the tree should say what it read and when,
in its own output, because its verdict cannot otherwise be re-derived by anyone reading
the commit later.

## A guard for a rule must consult the rule, not restate it

When guarding against a gate's failure, the tempting shape is to compute the gate's
answer locally before publishing. That makes the guard a **second rendering of one rule**,
and two renderings agree until they do not — which is the failure this whole check exists
to surface, reintroduced in the instrument that guards against it.

Where the deciding value is computed elsewhere, the guard cannot precede the write. It
has to publish and then re-read through the gate itself, keeping three values: pass, fail,
and _no settled answer yet_. Collapsing the third into pass is the multi-valued-status
collapse recorded elsewhere in this note, and it fails toward reassurance.
