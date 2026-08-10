# Citation content assertions

This ledger is the corpus for `scripts/check-citation-content.mjs` (#528), and
it is a **separate instrument from `check-citation-reachability.mjs`** on
purpose.

The reachability harness answers one question: _can a reader reach the
revision this citation names?_ It says so in its own transcript. It has never
answered the adjacent one: _is the content this citation pins still what the
citation claims it is?_ A citation of the form `` `<sha>` — adds `FOO` `` can
be perfectly reachable and completely false, and the reachability harness
passes it, because reachability is all it claims.

Folding a content predicate into the reachability harness's exit code would
give one exit status two meanings: _"no reader can obtain this revision"_ and
_"every reader can obtain this revision and it does not say what the citation
claims."_ Those failures have different remedies — declare a twin, or edit the
prose — and a single red that cannot distinguish them sends the author to the
wrong repair. So this ledger, this heading, and this script are their own
thing, with their own exit code.

## Grammar

A row under the heading below is:

```
- `<7-40 hex char SHA>` — asserts: `<exact text>`
```

The SHA must resolve to a commit. The asserted text must appear, verbatim, as
an added line in that commit's diff (`git show <sha>`) — checked with **line
containment**, not `git patch-id --stable` (#413: `patch-id --stable` hashes
context lines, so a true twin on an append-only ledger gets a different id;
containment survives an append).

## What a row can classify as

- **PASS** — the cited commit is reachable from what this reader holds (a
  reader is `HEAD` and, where fetched, `origin/development` — same model as
  the reachability harness) **and** the asserted text is present, verbatim, as
  an added line in that commit's diff.
- **FAIL** — the cited commit is reachable **and** the asserted text is
  **absent** from every added line in its diff. The citation is reachable and
  wrong; this is the failure the reachability harness cannot see, because
  reachability is all it claims.
- **WITHHOLD** — the cited commit is not reachable from what this reader
  holds, or does not resolve to a commit here at all. This check does not
  fail an unreachable citation. Reachability is `check-citation-reachability.mjs`'s
  question, not this one's, and answering it here — even correctly — would
  duplicate that harness's verdict and inherit its blind spot: a check that
  reports FAIL on "I cannot look" is indistinguishable from one that reports
  FAIL on "I looked, and it's wrong," and a reader cannot tell which repair a
  red is asking for.

Reachability itself is decided with `git merge-base --is-ancestor
<sha>^{commit} <reader>^{commit}`, never `git cat-file -e` or `git log
--follow`. Several worktrees on this machine share one object database, so
`cat-file -e` and `log --follow` both resolve a commit no ref of the reader's
ever reached — the same hazard `check-citation-reachability.mjs` was built to
avoid, repeated here would reopen it in the sibling instrument. `git
merge-base --is-ancestor` exits `128` when either revision does not resolve
locally at all; that is **not** a "no" — it is "no answer," and this check
treats it exactly like an ordinary unreachable commit: WITHHOLD, never FAIL.

## Citations with a pinned content assertion

- `42054254e06e26d164cf8f56c8f776dd5d828e2a` — asserts: `This module is deliberately the *mechanism* and never the *number*.`
