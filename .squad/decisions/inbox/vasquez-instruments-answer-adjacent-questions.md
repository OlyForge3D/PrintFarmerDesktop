# Every instrument that answers "is this SHA still true" answers a different question

The companion entry, _A SHA in a handoff is a perishable claim wearing a durable
costume_, established that a correctly-measured SHA goes false in transit. This
one is about the checks we then reach for to catch that, and it exists because
**two of the remedies this squad prescribes — including one prescribed by that
entry, in this directory, under my own name — fail silently in exactly the case
they were named for.**

All exit codes below were measured on git 2.53.0 against this repository at
`origin/development` = `c8d379f`, read 2026-08-04T19:21Z. They are not quoted
from documentation, and several contradict it.

## Three failure modes, and they are not degrees of one thing

```
fabricated   no such object                         a rejection channel catches it
stale        real, on-branch, superseded            --is-ancestor catches it
twin         real, resolves, on a parallel chain    NOTHING you would run catches it
```

A twin is the one that matters, because `cat-file`, `ls-remote` and
`gh api commits/<sha>` all return success on one. It arises whenever a PR is
squash-merged or rebased: the object survives in the shared object store, and
the chain it sits on is not the chain that merged. Four commits reported as
frozen heads in one day were twins, and every check available to the reporter
confirmed the wrong answer.

**Ancestry against `refs/pull/N/head` is the only local discriminator** that
names _which_ chain a twin sits on, and it requires the ref to have been fetched
first. There is a cheaper test that stops one step short and is worth running
first, because it needs no network at all:

```
git for-each-ref --contains <sha>        # which refs here reach this commit?

  a live commit   -> exit 0, one or more lines
  an orphan/twin  -> exit 0, ZERO lines
  absent object   -> exit 129
```

That separates _on a ref here_ from _on no ref here_, which is the orphan
question, and it does not answer the merge question — a commit can be orphaned
locally and live on the remote, or reachable here only because a sibling
worktree still holds the branch. **It is cheap, it is correct, and it answers a
narrower question than the one being asked**, which is the subject of this
entry rather than an exception to it.

## The exit codes are not a family, and every one is read through a boolean

```
cat-file -e <absent>                    ->   1
cat-file -e <absent>^{commit}           -> 128
merge-base --is-ancestor <absent> ...   -> 128
for-each-ref --contains <absent>        -> 129

ls-remote origin refs/heads/<deleted>   ->   0   and prints nothing
for-each-ref --contains <orphan>        ->   0   and prints nothing
git log -g <ref with no reflog>         ->   0   and prints nothing
```

**Four codes for "I could not answer", and three commands that report absence
by succeeding.** No consistent convention exists to intuit, so a caller writing
`if (failed)` or `if (!output)` is guessing in both directions at once. The two
rules that survive contact:

- **Where the answer is the output, test the output.** A status of 0 from
  `ls-remote` or `for-each-ref` means _the query ran_, never _the thing exists_.
- **Where the answer is the status, branch by value and keep the third state.**
  0 / 1 / anything-else is yes / no / **no-answer**, and pre-checking existence
  keeps the no-answer case from ever arising for a reason you did not intend.

And a third rule that only shows up once you try to obey the second one: **the
status has to survive the pipeline you read it through.** In PowerShell,
`| Select-Object -First N` terminates the upstream command early, so
`$LASTEXITCODE` keeps whatever the _previous_ command left there (#291) —
measured here in both directions, a failing command reporting 0 and a
succeeding one reporting 7. `-Last N` is safe, because consuming the last N
requires reading all of it.

This entry's author read `$LASTEXITCODE` through exactly that pipeline while
confirming CI was green, and re-checked afterwards without the truncation: the
conclusion held, **the evidence cited for it did not.** A correct answer reached
through a broken instrument is not a near miss — it is the case that teaches you
to keep using the instrument.

## The remedies that fail silently

**`git ls-remote origin refs/heads/<branch>` on a deleted branch prints nothing
and exits 0.**

```
git ls-remote origin refs/heads/development        -> exit 0, one line
git ls-remote origin refs/heads/no-such-branch     -> exit 0, ZERO lines
```

This entry's predecessor prescribes that command as the way to establish
currency. A caller who follows the prescription and tests the status — which is
what a status-returning command invites — is told _fine_ in the one case the
check existed for. **Test the output; never the exit code.** The correction is
recorded here rather than quietly patched, because a remedy that failed is
evidence about how remedies get written, and deleting it would destroy that.

**`cat-file -e` is the existence test, and the bare form answers a neighbouring
question.**

```
cat-file -e <absent>              -> 1
cat-file -e <absent>^{commit}     -> 128
cat-file -e <a tree sha>          -> 0      <- an object, not a commit
cat-file -e <a tree sha>^{commit} -> 128
```

A SHA quoted in a handoff is claimed to be a **commit**. The bare form accepts
any object, and a tree hash is a 40-hex string indistinguishable from a commit
in a message. The `^{commit}` peel is load-bearing and reads as decoration.

Note the second-order trap: **the peel moves the absent case from 1 to 128.**
Code branching on `exit === 1` to mean absent reads a peeled miss as neither
absent nor present. `--is-ancestor` has the same shape — 128 means _cannot
determine_, and collapsing it into `false` is how "I could not look" is reported
as "I looked and it was not there". **Branch by value: 0 / 1 / 128 = yes / no /
no-answer**, and pre-check existence so a missing object never reaches the
ancestry question at all.

## Ancestry is silent about the thing most pins are actually claiming

A pin is almost never really about a commit. It is about a rule, a finding, a
line of code — something in a file. Ancestry cannot see that:

```
pin = c1;  then c2 and c3 both edit f.txt;  then c4 edits something else

git merge-base --is-ancestor <pin> HEAD   -> exit 0     "still on the chain"
git rev-parse <pin>:f.txt                 -> a29bdeb...
git rev-parse HEAD:f.txt                  -> 83db48f...   the content moved
```

**The pin passes while everything it was about has changed.** Ancestry answers
_was this rewritten_, and never _is this still true_. It is a rewrite detector
being read as a currency check.

The blob form discriminates all three states, and it survives the rewrite that
defeats ancestry:

```
branch rebased onto main
  commit before  73fbda6...    commit after  f578e5a...   REWRITTEN
  blob   before  d48f83a...    blob   after  d48f83a...   IDENTICAL
  --is-ancestor <old commit> HEAD  -> 1     but the file never changed
```

`git rev-parse <sha>:<path>` says _this file is byte-identical_ across a rebase,
a squash and a fast-forward, because it compares content instead of position.
When the claim is about content, pin the content.

## Two transports to one ref is not two sources

```
gh pr view 320 --json headRefOid   fa63c0e0...
git rev-parse FETCH_HEAD           fa63c0e0...
git ls-remote origin refs/pull/320/head   fa63c0e0...
```

Three agreeing readings, and the agreement is **guaranteed by construction** —
they are three transports onto one ref on one server. The two-source rule is a
real control against a lying or misread source, and it has **no purchase
whatsoever on temporal decay**. Corroborating a head three ways produces a
confidence that none of the three readings earned.

**A pin is a measurement with a timestamp, not a standing fact.** The only thing
that makes any of these readings trustworthy is how recently it was taken, and
that is the one property no amount of cross-checking supplies.

## The cause, which is not what any of these instruments look for

Every check above answers _is this SHA current_. None of them answers _why it
stopped being current_, and for most of the incidents this squad has logged the
answer is not a rewrite at all:

> **One writer, two clocks.**

Cross-session messages here arrive **~13–14 hours after they are composed**
(#293), and a session goes on working the whole time. So the head named in a
report and the head on the ref are routinely two points on **one author's own
timeline**, with dozens of commits between them in both directions. Read
locally, with no timestamp, that is indistinguishable from a second writer
rewriting your branch — and it was repeatedly diagnosed as exactly that,
including in messages telling sessions their pushes had been orphaned. They had
not been. **The divergence was lag.**

The correction matters because the two causes demand opposite responses.
A second writer means _stop and read their work_. Lag means _re-derive and
carry on_. Guessing wrong in the cautious direction still costs a round and
teaches people to discount the warning.

**Divergence between a report and a ref is evidence about the clock before it is
evidence about a writer**, and nothing local can tell them apart — which is
precisely why a report that carries no timestamp cannot be acted on (#202), and
why the two-writer question is answered by a guard that reads authorship out of
the reflog rather than by a human comparing two hashes.

## What survived all of it

Across every incident this entry draws on — nine superseded SHAs from one
session alone — **not one piece of work was lost.** The objects were superseded
and the content shipped every time.

That is the practical bottom line, and it is why the content instruments belong
at the top of the list rather than the bottom: **check by string, not by
ancestry.** `git log --fixed-strings --grep=<subject>` and
`git rev-parse <sha>:<path>` answer _did the work arrive_, which is almost
always the question actually being asked, and they answer it across squash,
rebase and fast-forward alike.

Every instrument here is healthy. `rev-parse --verify` correctly validates rev
syntax. `ls-remote` correctly reports the refs that exist. `cat-file -e`
correctly detects objects. `--is-ancestor` correctly detects rewrites. **Not one
of them is broken, and not one of them answers "is this SHA still true" — they
answer four adjacent questions that coincide with it most of the time.**

That is why re-running the check cannot catch the error, and why the failures
are silent rather than loud: a green result from a working tool aimed slightly
past the question is indistinguishable from a green result from the right one.
**Ask what the instrument returns on the case you are afraid of, not on the case
you expect.** Every trap above was found that way, and three of them were found
in this author's own shipped work.

## The executable form

These are all available as `npm run sha:status <sha> [--pr N]`, which runs the
four checks, refuses to collapse a `128` into a `false`, and declines to
separate stale from twin when no PR is named rather than guessing. The traps
above are pinned there as tests against git itself, so a future reader who finds
a comment implausible can delete it and watch a test fail — the entry states the
finding, the test enforces it.

## Where the individual instances are filed

This entry is the general form; each of these is a live issue with its own
measurement, and none of them is superseded by being listed here.

| issue | the instance                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------- |
| #202  | claims arrive undated, so a message true when sent reads as a false claim about now            |
| #210  | a full SHA quoted from memory is fabricated in the digits nobody displays                      |
| #271  | squash orphans every review's `commit_id` — 21/21 fail `--is-ancestor`                         |
| #288  | head-ancestry reports every merged PR as unmerged                                              |
| #291  | `$LASTEXITCODE` is destroyed by `Select-Object -First N`, in both directions                   |
| #293  | cross-session messages arrive ~13h late, so every pin is exact when taken and stale on arrival |

**#271 and #288 are the squash case with a hard number attached** — a merged
PR's head is not an ancestor of the branch it merged into, and 21 of 21 review
anchors failed on it. **#210 is the fabricated mode**, and it is the one this
author committed personally: three invented 40-hex tails while building the tool
that detects them, which is why `sha:status` rejects abbreviations instead of
expanding them.
