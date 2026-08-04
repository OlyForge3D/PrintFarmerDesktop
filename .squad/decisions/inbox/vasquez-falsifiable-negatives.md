# A negative result is only reportable if you can say what would have made it come out the other way

**By:** Vasquez — from PR #149, with Ripley. Two retractions in one day, ours and
the reviewer's, both the same shape.

## The rule

**Before reporting a negative result, state the observation that would have
produced the opposite finding. If you cannot name one, you have not measured the
class you are about to close.**

This is the sibling of the testing rule — _an assertion that cannot fail proves
nothing_ — pointed at **measurements and reports** rather than at tests. That
matters because a test with no failing mode can at least be caught by a reviewer
reading the file, whereas a report has no linter, no diff, and no gate. The only
thing standing between a narrow measurement and a general-sounding claim is the
person writing the sentence.

The failure it catches is not carelessness. It is running an experiment that
**confirms a prediction** and reading it as one that **risked** the prediction.
Both are real measurements. Only the second one licenses a claim about a class.

## Two retractions, same day, same shape

**Ours.** The push guard's live query was argued to be unfailable in practice.
The evidence was a real experiment: make the remote **unreachable**, observe that
git fails at the ref advertisement before the hook runs, conclude the whole class
of query failures is unreachable. Every word of that was true. The defect was the
sampling — one configuration was varied and a claim was made about all of them.
Review then found the case never sampled: `git push` resolves
`remote.<name>.pushurl` while `git ls-remote <remote>` resolves
`remote.<name>.url`, which differ **by design** in a fetch-over-HTTPS,
push-over-SSH clone. A plain fast-forward was refused, permanently, including the
push that would carry the fix.

**The reviewer's.** He published a claim that the missing-object path refuses
ordinary fast-forwards on shallow clones. He had reasoned it rather than run it.
Pressed to measure, he retracted it himself: a shallow clone's advertised tip
**is** its boundary commit, so the object is present and the push is allowed.

**And the lead's.** Ripley put the network concern to Vasquez, received a
falsification of the version he had asked about, and ratified it as covering more
than it did. He did not ask _"what would have made this come out the other way?"_
either. The rule is recorded with that included deliberately: a rule that only
catches the member and never the reviewer or the lead is not a control, it is a
hierarchy.

## Why this framing and not "be thorough"

"Test more cases" is unbounded and therefore unactionable — there is always
another case. The question _"what observation would have produced the opposite
finding?"_ is **answerable in one sentence or not at all**, and the failure to
answer it is itself the signal. In the `ls-remote` case the honest answer was _"a
configuration where the push URL and the fetch URL differ"_ — which, once said
aloud, is a thing to go and configure rather than a thing to conclude.

## The positive example, because the rule is about structure and not diligence

The same session exported its unpushed commits with `git format-patch` and then
**replayed them**: cloned to a temp directory, checked out the base commit,
`git am`'d the patches, and diffed the result against the original tip expecting
empty. That was sound not because it was careful but because it had a
**falsifiable output** — a diff that would have been non-empty if the backup were
bad. An exported patch that has never been replayed is a backup you are guessing
about, and the guess and the evidence look identical from the outside.

The same test applied to a **type**: a required field was verified by removing it
from the helper and watching `tsc` reject the fixtures with `TS2375`. "It
compiles" proves nothing; "it stops compiling when I break it" proves the
constraint is load-bearing.

## The operational form

- Reporting a negative — _"X cannot happen"_, _"this path is unreachable"_,
  _"that is safe"_ — requires naming the observation that would have refuted it.
- If the answer is a configuration, **go and configure it**. If it is an input,
  **construct it**.
- Distinguish _"I measured it"_ from _"I measured the general case"_ in the
  sentence itself. They are different claims and the gap between them is where
  this defect lives.
- Applies to a fix as much as to a finding: after repairing something, the
  question is what observation would show the repair incomplete. In #149 the
  first B2 repair passed its test and was still wrong, because the test exercised
  a partial rollback and never a full one.
