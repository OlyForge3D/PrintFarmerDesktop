# Known-lying commands (#214, #253)

A recurring failure shape hit seven times across four sessions in one day,
two of them independent rediscoveries of a defect another session had
already found and never published. This file exists so the next session
meets it as a read, not as an incident.

**#253 folded in five more instances** (rows 8-12 below), found nine times
across five sessions in a single day. Row 1 (`.Contains()`) was hit
independently *again* in that batch — a second rediscovery of the exact
defect this file was created to stop the first time. That is why #253's
register is merged into this file rather than kept as a second, competing
list: a catalogue nobody re-checks is indistinguishable from no catalogue.

## The shape

A command is chosen to answer question **A**. It answers neighbouring
question **B**. It does not error, does not return empty, and does not
warn — **it returns a confident, well-formed, plausible value.** Nothing in
the output distinguishes the two questions, so the reader gets a wrong
answer wearing the costume of a measurement.

The squad's usual discipline — proving a corpus or reference is live before
trusting an absence — does not catch this. Every instance below **passes**
that discipline: the corpus was live, the file was there, the branch
existed. The defect is one level up:

> **The control proves the data is real. It does not prove the predicate
> asks what you think it asks.**

## The instances

| #   | Command                                                      | Appears to answer          | Actually answers                                                                                                                                                                                                |
| --- | ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `$body.Contains("text")` where `$body` came from `gh … --jq` | substring present?         | **element equality** — `--jq` yields a _string array_ in PowerShell, so it returns `False` for text plainly visible in the same output                                                                          |
| 2   | `$x -like "text"` (no wildcards)                             | substring present?         | exact whole-string match                                                                                                                                                                                        |
| 3   | `git rev-parse HEAD^{tree}` **unquoted** in PowerShell       | the tree                   | `{tree}` is parsed as a script block, git receives `HEAD^` and returns the **first parent** — a real commit, printed on a line labelled _tree_, beside a `fatal:` that reads as belonging to the other argument |
| 4   | `conclusion != "SUCCESS"`                                    | failed checks              | **failed _or not finished_** — an unfinished check's `conclusion` is an empty string                                                                                                                            |
| 5   | `git branch -a --contains X`                                 | is X the tip?              | is X **reachable** — true of every ancestor                                                                                                                                                                     |
| 6   | `git merge-base --is-ancestor A B`                           | was this branch rewritten? | was **this interval** rewritten — a branch can contain a rebase _and_ a later merge, and a test aimed at the recent interval cannot see the earlier one                                                         |
| 7   | `$file.Contains("a quoted sentence")`                        | does the file say this?    | is this **exact byte sequence** present — defeated by `prettier`'s 80-column wrap, which breaks prose mid-phrase                                                                                                |
| 8   | `git merge-base --is-ancestor pin head`                      | is the pin **stale**?      | was the pin **rewritten** — returns TRUE for every ordinary push, including one that lands an unreviewed RED commit on top of the pin. Row 6 answers "was this branch rewritten"; this row answers a different question again ("is my pin the head"), and neither is answered by `--is-ancestor`. Distinct instruments: `--is-ancestor` = was I rewritten; string equality on the SHA = is my pin the head; `patch-id --stable` = is my change still here |
| 9   | `… \| Select-Object -First N`                                | pass the exit code through | `$LASTEXITCODE` is **stale once `N >= count`** of the upstream native command. Verified: 100-line producer → `-First 99` reads 7, `-First 100` reads 7, `-First 101` reads 0. `-Last`/`-Skip` do not have this defect. `N == count` — the value most naturally picked — is exactly where it breaks |
| 10  | `mergeStateStatus` read as CI health                         | mergeability                | CI health — under branch-protection `strict: true`, every merge to the base puts every open PR `BEHIND`, so the field **saturates** and cannot distinguish a PR with 7 green jobs from one with 2 red jobs. Read checks by `head_sha`, never `mergeStateStatus`, when the question is health |
| 11  | `reviewDecision != "CHANGES_REQUESTED"`                       | is review blocking?         | nothing — under a single-identity setup (#206), GitHub returns `reviewDecision: ""` on every PR because `APPROVE`/`REQUEST_CHANGES` both 422 for the PR author. The predicate is **unconditionally true** and cannot fire in this repo, no matter what a reviewer said |
| 12  | required-context `pass count == N`                            | did all required contexts pass? | there are exactly N passing rows — **a count standing in for a set**. A count cannot detect an ABSENT required context: adding a ninth required context to an eight-of-eight-green PR still reads "8 of 8," now checking the wrong eight. Use set containment by name against the live required-contexts list, never a count |

Instance 1 was hit independently by two sessions — the first kept it in
local notes, the second rediscovered it from scratch, and a third session
(#253) hit it again after that. Instance 7 nearly produced a false
accusation of a counterparty whose quote was faithful. Instance 3 printed
_another PR's own head SHA_ as its answer — a wrong value the recipient
would have recognised and found corroborating.

Instances 1 and 4 were caught only because a control string known to be
present also came back negative — the control failed in a way that
indicted the instrument, not the data.

Every instance in this file folds a third state into the reassuring one, not
the alarming one: `""` conclusion → *passed* (4), any ancestor →
*the tip* (5), rewritten-but-not-mine → *fine* (6, 8), `BEHIND` → *healthy*
(10), empty `reviewDecision` → *not blocked* (11), stale exit code →
*success* (9). The direction is not random — the reassuring reading is the
one that lets the reader stop looking.

## The rule

**Every matching predicate gets a control that must return the opposite
result, evaluated by the same predicate on the same data.**

```
absence claim    ->  a term you know IS present must return present
failure count    ->  print the distinct raw values, not the complement of one
tip claim        ->  git rev-parse <ref>, never --contains
rewrite claim    ->  name the interval alongside the answer
quote claim      ->  normalise whitespace before comparing prose
staleness claim  ->  string-compare the pin against the head; --is-ancestor cannot tell you
exit-code claim  ->  take $LASTEXITCODE before any -First, never after
health claim     ->  read checks by head_sha; mergeStateStatus saturates under strict:true
blocking claim   ->  confirm reviewDecision can even be non-empty for this identity setup first
readiness claim  ->  set containment by name against required contexts, never a count
```

Concretely for PowerShell + `gh`: join a `--jq` array with newlines before
any `.Contains()` call, and single-quote every revision expression
containing `^`, `{`, or `}`. Never put `-First` downstream of a native
command — ask for strictly more than exists (which you cannot know in
advance), or capture output and read `$LASTEXITCODE` before filtering for
display.

## Related, more specific write-ups

- `.squad/decisions/inbox/vasquez-instruments-answer-adjacent-questions.md`
  — the same shape applied specifically to SHA/ancestry checks after a
  merge (instances 5 and 6 above, in more depth).
- `.squad/skills/git-workflow/SKILL.md` (`mergeCommit` vs `headRefOid`
  section) — a squash merge makes three independent-looking ancestry
  instruments fail for the same underlying reason.

This file is the general catalogue; those are the deep dives. When in
doubt, add a new row here rather than a new standalone decision file — a
single catalogue is easier for the next session to check than an inbox to
search.
