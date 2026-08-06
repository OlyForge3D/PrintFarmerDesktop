# A control must come from the same run as the thing it validates

**By:** Vasquez — from PR #561 / #560, with Ripley. Recorded because the defect it
catches survived being _diagnosed_ by the person who had already withdrawn the
reasoning that caused it.

## The rule

**A negative control must be drawn from the same run, the same head and the same
incident window as the measurement it validates. A control from another ref or
another point in time compares two things at once and reports the difference as
if it were one.**

## How it arose, including the part that makes it worth writing down

During a GitHub Actions outage, the working method for separating a real test
failure from an infrastructure failure was: compare the failing job against trunk,
which is green.

Ripley withdrew that himself, correctly: **trunk's green runs predated the
outage.** A green trunk shows infrastructure was healthy when those runs executed,
not that it is healthy now. Comparing a fresh red against a stale green silently
compares two points in time and attributes the difference to the ref.

The withdrawal was right and incomplete. The classifier built to replace the
method **still used trunk's log as its negative control** — stale by exactly the
amount that had made the original reasoning unsound. The unsound premise had been
removed from the argument and left in the instrument.

That is the general shape and the reason this is a rule rather than an anecdote:
**retracting a method does not retract the artefacts built on it.** When a premise
is withdrawn, the withdrawal has to be applied to every instrument that consumed
it, and instruments are not searched for premises.

The repair was a contemporaneous control: a job that **passed inside the same run**
as the failures being classified. Same commit, same incident window, zero skew.
Applying it at the next head surfaced a third defect in the same classifier that
the stale control could not have exposed.

## The corollary about agreement between two measurers

Two people measuring the same objects and reporting **identical** numbers is weak
evidence. It is equally consistent with two independent reads and with one party
having read the other's cached result — and the two are indistinguishable from
outside.

Two measurers reporting a **constant offset** — in this case a uniform +38 bytes
across five independent objects — can only arise from two retrieval paths over the
same underlying data. A systematic difference has a cause you can name; an exact
match has at least two, and the benign one is the one you will assume.

**Structured disagreement is stronger evidence of independence than agreement is.**
When two instruments agree exactly, establish that they could have disagreed.

## The operational form

- The control ships in the same run as the measurement. If it cannot, say what
  the time gap is and what could have changed across it.
- When withdrawing a method, enumerate the instruments built on it. The premise
  outlives the argument.
- A control that has never been observed to return the other answer is not yet a
  control — in a single review this decided a sentinel count that a real directory
  would also satisfy, a version gate that skipped silently, and an attack harness
  that had to return `BYPASSED` for one vector and `HELD` for five in the same run
  before its `HELD` results meant anything.
- Between two measurers: prefer a reconciled difference to an exact match, and if
  you get an exact match, go and find out why.
