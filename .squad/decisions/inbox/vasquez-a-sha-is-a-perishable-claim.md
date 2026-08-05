# A SHA in a handoff is a perishable claim wearing a durable costume

Every discipline this repository adopted for cross-session reporting is
sender-side: measure before you write, pin the value, name the instrument. None
of them reach the interval between sending and reading. A SHA measured correctly
and written down honestly becomes false while it is in transit, and it does so
without changing appearance — which is why the receiving session acts on it.

The entry exists because the author committed the defect in the message
reporting the defect. That is recorded here deliberately; an entry that names a
mechanism without recording that its own author fell to it is a weaker artifact,
and the receipt is available.

## The worked example, both directions

PR #149 was reported by its owner at head `9c492214` and merged at `f4e0e2de`.

```
git merge-base --is-ancestor 9c492214 f4e0e2de   ->  exit 1   not an ancestor
git rev-list --count 9c492214..f4e0e2de          ->  53
```

Fifty-three commits and, in the two files the claim was about, +1725/-65. The
reviewer of that PR then re-derived his findings at `9c492214` as well, having
inherited the pin from the report rather than reading the ref — so the same
stale value propagated through three sessions in one pull request, each of them
competent and each of them measuring something.

The reciprocal case is the useful control. A blocker was raised against head
`6154dc39` carrying a genuine, correctly `commit_id`-anchored review clearance.
The clearance was real and the anchor was honest; the head had moved three
commits past it, and one of those three was the least-reviewed code on the
branch. **A `commit_id`-anchored approval is strictly more precise than an
unanchored one and produced exactly the same wrong action**, because the
consumer read "approved" as a property of the pull request rather than of a
commit. Precision in the reference does not help when the comparison is never
made.

## Why nothing warns you

The signal a reader expects from a wrong SHA is a lookup that fails. It never
fires. Every `git show`, `git log`, `git diff` and `git cat-file` aimed at a
superseded commit succeeds and returns coherent, self-consistent content about
an object that has no relation to the work. There is no error to notice, and a
forty-character hash reads as maximally precise evidence.

It is worse than staleness alone, and the exact shape is worth measuring rather
than assuming:

```
$fake = 'dead' * 10                    # a fabricated 40-hex, no such object

git rev-parse --verify $fake     ->  exit 0
git cat-file -e     $fake        ->  exit 1

git rev-parse --verify 9c492214  ->  exit 0     real object, on no ref
git cat-file -e     9c492214     ->  exit 0
```

`rev-parse --verify` returns success for a SHA that does not exist at all: the
flag is named for a property it does not check. `cat-file -e` is the only
existence test in the family. **So "the lookup succeeded" carries no
information — not about currency, and not even about existence.**

This repository makes the staleness far more likely than it would otherwise be,
and the cause is worth stating: eight or more worktrees share a single object
database. A sibling session's local commits, and every superseded head of every
branch, resolve in everyone's store while living on no ref anywhere. A
superseded PR head is therefore the single most likely value to be misreported
as live — it is real, recent, fetchable, and indistinguishable from the current
one by any local command.

## What to do instead

**Write the clock with the value.** `X at HH:MM` or do not write it. The SHA is
durable; the proposition it supports — _this is the head_ — is perishable, and
the timestamp is the only part of the message that says which one is being
claimed. This is not cosmetic: two reports in the same incident that appeared to
be stale-object resolutions turned out to be correct point-reads plus delivery
latency, and the only reason that could be established was that one of them
carried its reading's clock. A correct-but-aged reading and a stale-object
reading are indistinguishable in the body of a message and demand different
responses.

**The receiver re-derives; the receiver never quotes.** This is the half no
sender-side discipline can cover. Currency is a comparison against the live ref
and nothing else establishes it:

```
gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha     # or
git ls-remote origin refs/heads/<branch>
```

string-compared to the pin — and **`ls-remote` must be compared by output, not
by exit code.** On a deleted branch it prints nothing and exits 0, so a caller
who tests the status is told _fine_ in the exact case the check existed for.
That correction, and three further instruments that answer adjacent questions,
are measured in _Every instrument that answers "is this SHA still true" answers
a different question_. Note also that `cat-file -e` below is the bare form,
which accepts **any** object: a tree hash passes it. When the claim is that a
SHA names a commit, the `^{commit}` peel is load-bearing.

Ancestry is a weaker instrument here and its failure
mode is asymmetric: `--is-ancestor` detects a rewrite, so it fired correctly on
`9c492214`, but on an ordinary fast-forward it returns 0 while every blob under
the ref has moved. It is also tri-state — exit 128 means _cannot determine_,
which is a different finding from exit 1 and must not be collapsed into it.

**Match the pin's durability to the claim's.** The same message that got the
head wrong also cited findings by line number, `725` and `992`, against a file
into which 1302 lines were subsequently inserted; the headings survived the
rebase and the squash, the numbers survived neither. A coverage claim pins to
the test file, a rule pins to its heading, a "which tree" claim pins to a
content hash. **A line number and a branch tip are the two least durable pins
available, and they are the two people reach for first.**

**Prefer the tree when the question is content.** `git show -s --format=%T` on
each side answers "is this the same code" without any dependence on where the
refs currently point, and survives both rebase and squash. Ancestry does not.

## The general form

The recurring error is not carelessness about SHAs. It is that a durable-looking
artifact is quoted in support of a perishable proposition, and re-reading the
artifact confirms it every time. A `head_sha`-pinned CI run stays green forever.
An amended review comment keeps its id. A superseded commit answers every query.
In each case the value is correct and the match between the value and the
question is what has expired — which is why checking it again cannot catch it,
and why only a comparison against something live can.
