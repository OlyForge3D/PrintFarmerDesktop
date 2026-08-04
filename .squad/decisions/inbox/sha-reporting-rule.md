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
