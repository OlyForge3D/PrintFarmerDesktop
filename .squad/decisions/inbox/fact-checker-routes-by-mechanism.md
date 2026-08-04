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
