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

**Related entries, and what this one does not repeat.** Two files in this
directory already cover ground next to this. `dallas-ancestry-is-not-content.md`
owns `--is-ancestor` under squash, its exit-code polarity, and tree identity as
the remedy — **that treatment is better than the one this entry originally
carried, and this entry now defers to it.** `sha-reporting-rule.md` owns the
citation rule that a cited object must be reachable by the _reader_, and notes
the shared object database as the reason it often is not. What is left here and
found nowhere else: the **grading** of `git branch -r --contains`, the
demonstration that it **reads a local cache and inherits the defect of #81**,
the enumeration of how many worktrees share this object store, and the rule that
a **stale claim is not a false claim**. `fact-checker-symmetric-diff.md` names a
different limit of the same family — `git branch --contains` searches branches
and so cannot see `refs/pull/N/head` — which is complementary to the staleness
defect recorded here, not the same finding.

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

**For a whole-commit comparison, prefer the tree over any set of paths:**
`git show -s --format=%T` on each side, per
`.squad/decisions/inbox/dallas-ancestry-is-not-content.md`. The per-path form
below is for a claim about one file; reach for it only when that is genuinely
the claim, because a path list is a place to forget a file and a tree is not.

**It is sufficient and not necessary, and the gap is worth naming.** A
comment-only edit changes the blob — measured — so the check reports _changed_
for a file whose behaviour did not move, and buys a re-derivation nobody needed.

The obvious remedy is to strip comments and compare the residue. **In this
repository that is the wrong trade, and the measurement says so plainly:**

```
scripts/push-guard.mjs on origin/development
  1216 lines total
   655 comment lines        54%
```

**Over half the file is comment, and it is the half that gets cited.** The
findings quoted back at this squad from that file all session — _a reflog is a
record of where the ref went, not of what this worktree wrote_; _a guard that is
correct by accident is one refactor away from being wrong silently_ — **are
comments.** A residue comparison would report "unchanged" across an edit to any
of them, which is precisely the case where a citation to that line has gone
stale.

The deeper reason to decline it is the asymmetry this entry closes on:
**over-reporting a change is the noisy direction and costs one re-derivation;
under-reporting is silent and costs a false "still true".** Suppressing a
warning because it fires too often, in a codebase whose rationale lives in
comments, moves a cheap loud failure into an expensive quiet one. **Pay the
re-derivation.**

## The reason every wrong SHA has been resolvable

The property that makes these incidents confusing is not that the SHAs are
wrong. It is that **every wrong SHA reported has been a real, correctly typed,
locally present commit.** Nothing was fabricated. The cause is structural:

```
git worktree list        21 worktrees off one clone
git rev-parse --git-common-dir   <the main checkout>/.git   -- one object store
```

**Worktrees share one object database.** A sibling session's purely local
commits — never pushed, on no remote ref — are therefore resolvable in every
other session's object store as ordinary commits. `cat-file -t` returns
`commit`. `log -1` prints a subject. A diff shows. **Nothing cheap distinguishes
them from work that shipped**, which is exactly the confusion this entry exists
to end.

Compose that with the namespace effect below and the trap is complete: a SHA
captured at time T, or resolved by subject, can be a real object that is
fetchable, greppable, typed, **and on no ref anywhere.**

### `git branch -r --contains` is the cheap discriminator, and it is graded

Measured across the objects involved in tonight's incidents:

```
                                     remote-contains   --is-ancestor -> dev
two local-only phantoms                    0                  not
two live PR heads                          1                  not
the squash commit that landed #149       135                  IS
the squash commit that landed #203       289                  IS
```

**Zero means the object is on no remote ref at all** — nothing has it, and it
cannot be something anyone else is running. **One means a single branch tip**,
which is the ordinary state of an open PR head. **Many means the mainline**,
inherited by every branch cut from it since; the number is a count of branches,
not a measure of importance.

This separates the three states that `cat-file` collapses, and it costs one
command. **Two limits have to travel with it, and the second one is severe.**

First, a merged PR whose branch was deleted also reads `0`, indistinguishable
from a phantom. So `0` means _on no remote ref now_, never _this work never
landed_.

Second — and this is the one that nearly made this entry harmful — **`git branch
-r --contains` does not ask the server anything.** It reads `refs/remotes/*`,
which is a local cache that only `fetch` writes and only `--prune` corrects.
Measured in this clone:

```
remote-tracking refs held locally        135
branch refs actually on origin           125      10 stale
--contains <the #149 squash>  before     136
                              after fetch --prune  128
```

**The answer moved by eight while nothing changed on the server.** Two clones
will therefore disagree about the same SHA, and they will each be internally
consistent — which is exactly the cross-clone disagreement that prompted this
paragraph.

**That is the defect of #81 reappearing inside the instrument written to
diagnose it.** `--force-with-lease` compares against the local remote-tracking
ref and is satisfied against a value the pushing session never read; this check
counts the same cached refs and reports a number about when this clone last
fetched. **A control and its diagnostic tool inherited the same wrong
assumption, which is the strongest argument in this entry for testing the
instrument rather than trusting it.**

The failure direction is the dangerous one. A phantom stays `0` in every clone,
so the strict reading is safe. But **a real commit reads `0` in a clone that has
never fetched its branch**, and `0` is the reading that gets reported as _this
work does not exist anywhere_ — the precise claim that precedes someone
discarding it. **The loud error is impossible and the silent error is easy.**

⇒ **`git fetch --prune` immediately before, in the same invocation, or the
number is not evidence.** The ordinal reading — none / one / many — survives a
prune; the counts are not comparable across clones or across time, and should
never be quoted as though they were.

## Squash and ancestry: see Dallas's entry, which got here first and got it righter

This entry originally carried a full parallel account of what `--is-ancestor`
does under a squash merge. **It is deleted, because
`.squad/decisions/inbox/dallas-ancestry-is-not-content.md` was already on trunk
saying the same thing more precisely.** That entry has the exit-0 polarity, the
same-call direction control, the observation that the inverted reading was
circulated to three sessions, and the distinction this one was reaching for and
did not name as cleanly:

| operand passed to `--is-ancestor`             | meaningful? |
| --------------------------------------------- | ----------- |
| verified **branch head** vs the squash        | no          |
| the **squash merge commit** vs `origin/<ref>` | yes         |

Its remedy is also stronger than the one this entry proposed. Where this note
suggested per-path blob identity, Dallas compares the **whole tree** —
`git show -s --format=%T` on each side — which "cannot be weakened by accident:
there are no pathspecs to forget." That is the correct instrument and the reason
is the same one this entry is about. **Use theirs.**

One measurement is kept because it is additive. The claim in circulation was
that the commit which landed **#203** proves ancestry convicts landed work.
Dallas measured that it reads `exit 0`. The obvious defence — that it was read
before it landed — was not tested by anyone, and it fails:

```
the #203 squash commit             authored 08-03 20:47
the pin it was measured against             08-04 12:01   ~15h later
--is-ancestor <#203 squash> <that pin>      exit 0        already an ancestor then
```

It was an ancestor of the reporting session's own pin at the moment of
reporting. **Stating the alternative explanation and showing it fails is what
makes a correction different from a counter-assertion.**

### The way this section got written is the entry's own subject

This note is about instruments that answer an adjacent question. It was filed
without anyone running the cheapest query available: **does an entry for this
already exist?** Two sessions independently measured the same commit, wrote the
same finding, and neither knew — in an inbox of thirty-four files, in a
repository whose whole current difficulty is that the same work appears under
several identifiers.

The three questions this entry proposes for a SHA apply unchanged to a claim.
**Existence** — is there an entry? **Membership** — is it on trunk, or only in
someone's branch? **Content** — does it actually say this, or merely sound like
it? I ran all three against commits all evening and none against the inbox.

⇒ **Before filing a finding, grep the inbox for it.** Duplicate entries are
worse than a missing one: they diverge under editing, and a reader who finds
the weaker of two has no signal that the stronger exists.

## One subject, several SHAs, and only one of them reachable by name

The reason a stale SHA is so easy to produce here is not carelessness. It is
that the identifier changes while everything a human uses to refer to the work
stays fixed:

```
"Pin all three ancestry outcomes, because a comment is not a control"
   three distinct commits, all --is-ancestor -> development  exit 1

"Stop a checked-out branch from laundering another session's commits"
   two distinct commits,   all --is-ancestor -> development  exit 1
```

Five objects, two subjects, none of them on the mainline — and every one still
resolves, still types as `commit`, still shows a diff. **Each rebase mints a new
SHA under an unchanged subject and leaves the previous one reachable by name
only.** Nobody rewrote anything of anyone else's; the branch was simply updated
more than once.

This is why the three failure modes at the top of this entry are hard to tell
apart in practice. **Existence and membership look identical in a namespace where
superseded objects are never collected**, and the subject — the only part a
person reads or repeats — is precisely the part that does not change when the
identity does.

⇒ **Cite content and paths. A subject line names the work; a SHA names one
attempt at it.**

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

### A stale claim is not a false claim, and the reviewer's error is to conflate them

The discipline this entry argues for — re-derive every claim before acting on it
— has a failure mode of its own, and it is the one the author of this entry
committed. A claim was measured, found not to hold, and reported as **wrong**
four separate times:

```
the report      "#57 was CLOSED COMPLETED at 09:21:31Z"
measured        state=OPEN  stateReason=REOPENED
timeline        closed    2026-08-04T09:21:31Z
                reopened  2026-08-04T20:41:26Z
```

**The closure is real and the timestamp is exact to the second.** The issue was
closed as described, and reopened eleven hours later — after the first
re-derivation. Every "this claim is wrong" should have been "this claim was true
and has since been remedied", and the difference is not politeness: the reported
exposure — a parent epic closed over unfinished children — **actually happened**,
and calling the report false erased a real event from the record.

`stateReason=REOPENED` was in the very first measurement and is the fingerprint
of exactly the closure being described. **The evidence that would have corrected
this was in the output already and was read as a refutation.**

⇒ **Re-deriving tells you what is true now. It does not tell you what was true
when the claim was made**, and a claim is only false if it was wrong at its own
timestamp. Checking that costs one query against the event history — the same
query in either direction. Elsewhere in this entry another disputed claim was
put through exactly that test and **did not** survive it: the object involved
predated the reporting session's own pin by fifteen hours and was already an
ancestor of it. **Both outcomes come from running the check; only one of them
came from remembering to.**

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

There is a sharper version, and it is the one to carry off this page. **"I
measured it" reads as a claim about the world and is actually a claim about the
arms you built — and you build arms for the failures you have already
imagined.** So the honest form of the sentence includes _which direction_:

- **Failures that make a check stricter announce themselves.** An over-refusing
  guard, an over-eager staleness warning, a false `ABSENT` — someone complains
  within minutes.
- **Failures that make it more permissive are silent by construction.** Nothing
  reports a check that quietly passed.

**Thoroughness in the noisy direction is therefore self-reinforcing: it feels
like diligence while sampling from the half that would have told you anyway.**
Every silent failure in this entry sits on the permissive side — `ls-remote`
succeeding on a deleted branch, `cat-file -e` succeeding on a tree,
`for-each-ref` succeeding on an orphan, `$LASTEXITCODE` reporting 0 for a
command that exited 3. **Ask which direction you measured, and which one would
have complained on its own.**

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
