# Known-lying commands (#214)

A recurring failure shape hit seven times across four sessions in one day,
two of them independent rediscoveries of a defect another session had
already found and never published. This file exists so the next session
meets it as a read, not as an incident.

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

| # | Command | Appears to answer | Actually answers |
|---|---|---|---|
| 1 | `$body.Contains("text")` where `$body` came from `gh … --jq` | substring present? | **element equality** — `--jq` yields a *string array* in PowerShell, so it returns `False` for text plainly visible in the same output |
| 2 | `$x -like "text"` (no wildcards) | substring present? | exact whole-string match |
| 3 | `git rev-parse HEAD^{tree}` **unquoted** in PowerShell | the tree | `{tree}` is parsed as a script block, git receives `HEAD^` and returns the **first parent** — a real commit, printed on a line labelled *tree*, beside a `fatal:` that reads as belonging to the other argument |
| 4 | `conclusion != "SUCCESS"` | failed checks | **failed *or not finished*** — an unfinished check's `conclusion` is an empty string |
| 5 | `git branch -a --contains X` | is X the tip? | is X **reachable** — true of every ancestor |
| 6 | `git merge-base --is-ancestor A B` | was this branch rewritten? | was **this interval** rewritten — a branch can contain a rebase *and* a later merge, and a test aimed at the recent interval cannot see the earlier one |
| 7 | `$file.Contains("a quoted sentence")` | does the file say this? | is this **exact byte sequence** present — defeated by `prettier`'s 80-column wrap, which breaks prose mid-phrase |

Instance 1 was hit independently by two sessions — the first kept it in
local notes, the second rediscovered it from scratch. Instance 7 nearly
produced a false accusation of a counterparty whose quote was faithful.
Instance 3 printed *another PR's own head SHA* as its answer — a wrong
value the recipient would have recognised and found corroborating.

Instances 1 and 4 were caught only because a control string known to be
present also came back negative — the control failed in a way that
indicted the instrument, not the data.

## The rule

**Every matching predicate gets a control that must return the opposite
result, evaluated by the same predicate on the same data.**

```
absence claim   ->  a term you know IS present must return present
failure count   ->  print the distinct raw values, not the complement of one
tip claim       ->  git rev-parse <ref>, never --contains
rewrite claim   ->  name the interval alongside the answer
quote claim     ->  normalise whitespace before comparing prose
```

Concretely for PowerShell + `gh`: join a `--jq` array before any
`.Contains()` — `(gh … --jq '…') -join "` + "`n" + `"` — and single-quote
every revision expression containing `^`, `{` or `}`.

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
