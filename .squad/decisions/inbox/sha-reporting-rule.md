# Inbox — reporting a SHA: bind the sender, not the dispatcher

**For Scribe.** Drafted by the fact-checker at Ripley's request, out of the review of the PR
closing #121. Ripley amended the original dispatch-scoped proposal to bind **any sender of a
SHA**; this draft carries that amendment and one refinement found while checking it.

## The rule

**When you assert a SHA, re-read it at the moment of assertion, and when you report a push,
report two elements: the SHA you pushed and the SHA you pushed it from.**

```
pushed <new-sha> from <old-sha>
```

Two elements, no poll, no cache window, and no freeze. They let any reader run the staleness
check themselves without asking the author anything.

### A head SHA in a message is a different object from a push report, and only one of them decays

The rule above was later read as licence to put head SHAs in messages, and a coordinator ruled
against that: **no message between sessions carries a head SHA; the receiver re-reads the ref by
name.** That ruling is correct and this section is not an exception to it, because the two
statements are about different kinds of claim:

- **_"the head is X"_ is a claim about a mutable ref's current value.** It is true when read and
  false whenever the ref moves — including while the message is in transit, which no care at
  either end can prevent. **Never send it. Send the ref name.**
- **_"I pushed X from Y"_ is a claim about an event at a time.** It does not decay, because the
  push happened and goes on having happened. It stays useful precisely when the head has moved
  on, since it is what lets a reader run `--is-ancestor` and `patch-id --stable` afterwards.

**The distinction is between a value and a reading of a value.** A push report is a record; a
head assertion is a measurement whose timestamp the reader cannot see. **The reason head SHAs are
dangerous is not that they are wrong — they resolve, they grep, they answer every question put to
them.** They are dangerous because nothing in the token marks when it was read.

So: **name the ref when the reader needs the current value; give the SHA when the reader needs
the event.** Historical and archival SHAs — a commit under review, a merge commit, a pre-squash
revision — are events too and are unaffected by the ruling.

### The exemption is a requirement, and this file broke it in the commit that wrote it

**An archival pin is not merely permitted, it is owed.** The enumeration entry added alongside
this section named the **command** that reads the mainline head and not the **value** it
returned — so it recorded how to obtain the base rather than which base the measurement ranged
over. **The rule and its violation shipped in one commit**, which is the clearest available
evidence that a broad prohibition does not distinguish load-bearing pins from decaying ones.

**Suppressing a required pin does not make a claim safer; it makes it unreproducible, and that
is strictly worse than a stale one.** A stale pin is falsifiable — the first reader who runs it
finds out. An absent pin produces a claim nobody can check, and **the reader's failure to
reproduce looks like the reader's error.** Measured: a reviewer tried four different corpora,
all at the wrong head, and came within one step of filing a blocker against a correct figure.

> **An over-broad rule against pins fails silently in the direction of _less_ evidence — the
> one direction no reviewer can detect.**

**The discriminator is the question the pin answers.** _"What is the head right now?"_ decays and
must never be sent. _"Which tree did this measurement range over?"_, _"what did I push, and from
what?"_, _"which revision is under review?"_ are closed facts about the past. **Send those by
value, always.**

### Stating a head is a disclosure. It is not a check

The obvious repair — _"say which head you measured at"_ — **has no falsifier, because you can
always say which head.** A pin that was true when the work was done and false when the report
shipped **satisfies every disclosure rule and misleads every reader**, and nothing in the format
distinguishes the two cases. So the rule has to be stronger:

> **State the head, and assert it live at publication — re-read from the remote at send, not at
> draft.**

_"This was live at send"_ can be wrong, and a rule that cannot be wrong is not a control.

**The gap is the drafting interval**, and no amount of care at read time reaches it: the pin is
taken while the work is being done, the report ships later, and nothing between the two re-reads
it. **Four sessions have now shipped a stale-SHA warning from a stale SHA**, each having stated
the rule correctly in the same artifact that violated it. **The warning does not protect the party
issuing it** — which is the whole reason this needs to be a mechanical step at send rather than a
principle anyone is asked to remember.

### Attribution does not travel with a SHA

**A SHA identifies an object, not the party who cited it.** Two sessions examining one pull request
cite the **same** identifiers, so **a table of SHAs looks identical whoever assembled it** and
cannot be attributed by its contents. Measured here: an eight-row enumeration was attributed to the
wrong session on the strength of matching revisions, when **six of the eight were the `commit_id`
fields of a different party's reviews.** Attribution requires a lookup against something that
discriminates — who pushed, who authored, which review id — because **agreement between two
citations is evidence only when disagreement was available**, and here it never was.

## Why the sender and not the dispatcher

The failure this prevents was first diagnosed as a dispatch problem: a coordinator pins a
finding to a head that has since moved. But the instances cluster somewhere narrower.

> **The one ref nobody re-reads is the one they moved themselves.**

A foreign ref is understood to move, so it gets checked. Your own ref is modelled as _what I
last did to it_ — a model that is authored, confident, and never re-derived. Every reported
instance in this review was an author reporting **their own** branch one commit behind.

**This is why the two-source rule does not reach it.** Two sources correct a _read_: they
disagree when one is stale. A self-push is a **write**, so both sources agree with each other
and disagree with the author — and the only thing that would make anyone consult them is the
belief that they might be wrong about their own action, which is the belief the failure is
made of.

**The rule is also self-defeating to rely on as discipline.** Its clearest instance in this
review was produced by someone in the act of writing it up, while maximally alert to it. That
is evidence for the rule rather than against it: a check on the act of sending is needed
precisely because attention does not substitute for one.

## How to read the ref

Prefer the ref advertisement over any API that can cache:

```
git ls-remote <url> refs/heads/<branch>
```

**Refinement, and it matters for the self-push case.** `refs/pull/N/head` is a ref GitHub
derives and maintains, not the ref a push writes. When reporting your own push, read
`refs/heads/<branch>` — that is the object you actually wrote. Reading the derived ref adds a
second rendering between you and the thing you did, which is the shape this whole review is
about.

Measured at rest on PR #162, all three agreed:

```
ls-remote refs/heads/<branch>   c4a3321
ls-remote refs/pull/162/head    c4a3321
gh pr view --json headRefOid    c4a3321
```

**That agreement does not test the claim.** The reported divergence is a window of roughly one
to three seconds _after a write_, and a quiescent branch cannot exercise it. Recorded as
unverified here rather than as confirmation.

## The staleness check this enables, and its two limits

```
git merge-base --is-ancestor <last-reported-sha> <current head>
```

**Exit codes are three, not two:**

```
0    ancestor            fast-forward; findings survive, grade the delta
1    not an ancestor     rewrite; every pin void, re-derive
128  cannot determine    object absent — NOT a rewrite
```

**Branch on the codes explicitly.** A script keying on `exit !== 0` reports a rewrite that
never happened, because an unfetched object lands in the same bucket. Pre-check with
`git cat-file -e <sha>^{commit}` if the object's presence is not guaranteed.

**And it detects rewrites, not changes.** A branch can fast-forward twice and leave a file's
blob different at every step, so a pin can pass `--is-ancestor` while every line-number finding
taken against it is void. **Per-finding blob identity is the sensitive instrument:**

```
git rev-parse <reported-sha>:<path>   against   git rev-parse <head>:<path>
```

Use the ancestry check to decide whether _findings_ survive, and blob identity to decide
whether a _pointer into a file_ survives. They answer different questions and only the second
one tracks what a reader will actually re-open.

## After a rebase, ancestry answers the wrong question

`--is-ancestor` asks **was I rewritten**. After a rebase the answer is always yes, and it says
nothing about whether the work survived. The question worth asking is **is my change still
here**, and it is answered by content:

```
git show <sha> | git patch-id --stable
```

A rebased commit and its pre-rebase twin produce **identical** patch-ids while
`--is-ancestor` reports the original as gone. Measured on this branch: all **22** commits
matched a twin across a rebase, `0` lost, while `--is-ancestor` on the old head exited `1`.

**Run the discrimination control before trusting a match.** An instrument that reports
_identical_ has to be shown capable of reporting _different_ — here, 22 commits yielded 22
distinct patch-ids with no collisions. Without that, agreement is consistent with a hash that
always agrees, which is the same defect as a positive control that only ever searches one
region.

**Two limits, both measured rather than assumed.** `patch-id` hashes the **diff only** — not the
message, not the author, not the parent — so it answers _did this change survive_ and not _did
this commit survive_, and those separate under rebase, cherry-pick and squash. And **whole-tree
comparison is the wrong instrument for the same question**: after a rebase the tree legitimately
differs, because the base advanced and other people's work arrived. On this branch the trees
differed while every one of the 22 changes was present. **Compare per-commit patches, not trees.**
