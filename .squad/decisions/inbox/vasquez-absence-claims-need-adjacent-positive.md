# Every absence claim needs an adjacent positive claim that fails if the artefact isn't real

**By:** Vasquez — from PR #561 / #560, with Ripley. The rule is his classifier's
third defect generalised; the admission that I had the same defect in my own
output is why it is filed as a rule and not as a review note.

## The rule

**A test for the absence of something — "the log is empty", "no error was
raised", "the step never ran" — cannot be trusted on its own, because there are
unboundedly many ways to not be the artefact and an absence test enumerates only
the ways you thought of. Pair every absence claim with a positive claim that
fails when the artefact is not real.**

## The defect, measured

A CI classifier needed to separate "this job failed because the code is broken"
from "this job never started". It carried an **absence** test for the second case:
an empty or whitespace-only log means the job never ran.

Eight jobs at one head returned this:

```
231 bytes:  <Error><Code>BlobNotFound</Code>... gh: HTTP 404
```

Non-empty. Non-whitespace. No outage marker. It failed every absence test in the
instrument and **fell through to the definite answer** — eight fabricated genuine
failures against a head that had executed nothing.

The repair is a **positive shape test**: a real Actions log has timestamped lines.
Anything that fails that test is `INDETERMINATE` rather than assigned a verdict.
The result on the same data was 1 genuine, 2 outage, 8 indeterminate.

The positive test only becomes usable when a same-run control establishes that
_something_ at that head does score as a log. Without it, "not a log" is
unfalsifiable and the fabrication just moves one layer down.

## I had the same defect and would have defended it

My own outage classification carried a `reachedTests=False` column. It is a pure
absence test. It produced correct results only because a positive marker —
`Failed to resolve action download info` — happened to sit next to it in the same
output and carry the weight. Had I published the absence column alone, or had the
outage presented without that marker, I would have made the identical error and
argued for it.

That is the reason for the rule's form. The defect is not carelessness; both
instruments were built by people who had just finished writing about this exact
failure mode. **An absence test looks like a measurement and is a default.**

## Why the direction matters — the polarity argument

Absence tests fail **open** by construction. They resolve ambiguity toward a
definite answer, and the definite answer is delivered with the same confidence as
a real one. Every instrument defect found across this review — a sentinel count a
real directory would also satisfy, a version gate that skipped silently, a
structural check that verified shape rather than behaviour, a PATH shim resolved
by one runtime and not another, an empty-log guard — failed toward **confident**.
None of them threw.

Ripley supplied the counterexample that makes the point sharper than the five do.
The registry short-circuit found on CI the same day failed **closed**: it refused,
for the wrong reason, and destroyed nothing. It was caught within hours, for free,
by a runner's default filesystem layout — no attacker, no fixture, no hunting.

So the asymmetry is not only that fail-open is more dangerous. It is that
**fail-closed defects announce themselves and fail-open defects recruit you into
not looking.** A wrong refusal is loud and cheap. A wrong permit is quiet and
expensive, and it arrives wearing the same face as a correct one.

Stated as an incentive rather than a warning: decide the failure polarity
deliberately, and spend your testing budget in the open direction. You rarely need
to hunt for the closed-direction failures. They find you.

## The operational form

- Any claim of the form _"X is absent / did not happen / is empty"_ ships with a
  positive claim beside it that would fail if the artefact were not genuine.
- An input that satisfies no branch gets `INDETERMINATE`, never the default
  branch. A missing case must not fall through to a definite answer.
- Establish the positive test can pass somewhere before trusting it anywhere —
  otherwise the negative is unfalsifiable.
- Applies to reports as much as to code. A report has no linter and no diff; the
  only thing between an absence and an assertion is the person writing it.
