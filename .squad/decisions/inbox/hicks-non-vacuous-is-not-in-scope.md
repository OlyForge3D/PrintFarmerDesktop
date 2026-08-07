# A test can be non-vacuous, correctly asserted, and still not test the thing its issue exists for

Mutation-sensitivity proves an assertion is load-bearing. It does not prove it
is load-bearing on the defect the issue was opened about.

We already have the rule that an assertion which cannot fail proves nothing, and
the rule about where to point mutation first. Both answer "is this check real?"
Neither answers "is this check aimed at the reported defect?" Those are different
questions, and a test can pass the first while failing the second completely. The
gap is invisible to every tool we run: the suite is green, the mutation fails for
the right reason at the right line, coverage went up, and the issue gets closed.

## The worked example

`#545` recorded a specific confusable pair: the citation harness exits `1` both
when it finds broken citations and when it never started, so a green-looking arm
can be a harness that never executed. Two outcomes, one channel, indistinguishable.

PR #560 added a test that was, on inspection, sound work. It formed a starved
fixture, asserted the raw spawn was `status 1` matching
`ERR_MODULE_NOT_FOUND|Cannot find module`, and asserted the guarded runner threw.
I neutered the guard to `if (false)` and the expectation failed at the right line
for the right reason — `expected [Function] to throw an error`. Not vacuous. I
mutated the harness so it still exited `2` but stopped printing `CONTROL FAILED`,
and the paired assertion failed too. Also not vacuous.

It still did not test `#545`. The second fixture was a `git init` with no commit,
so nothing resolved, all six controls classified ORPHAN, and it exited `2` —
the harness's "I could not look" channel, not its "I found a defect" channel,
which is `exit 1`. The test therefore paired **exit 1 against exit 2**. Those were
already separable by status alone, by anyone, without the test. The pair `#545`
names — `exit 1` meaning both never-started _and_ found-a-defect — was never
formed anywhere in the case. No arm reached the harness's `exit 1` verdict path.

Every local signal said the test was good. The only thing that said otherwise was
reading the issue and asking which two things it claimed were confusable.

## Why this is not one of the rules we already have

It is not the apparatus rule ("two arms that do not differ mean you have no
result"). The arms differed — `1` and `2`, loudly and reproducibly. The apparatus
worked perfectly. It measured the wrong pair.

It is not the mutation-selection rule ("mutate the assertion you trust"). The
assertions were mutated, including the trusted one, and they responded correctly.

It is closest to "a wrong reason that predicts the right table," but inverted.
There, the measurement is right and the explanation is wrong. Here the
measurement and the explanation are both internally correct — the fixture really
does exit 2, and it really does emit `CONTROL FAILED` — and the **scope** is
wrong. The claim is true; it is just not the claim the issue asked for.

## What this looks like in practice

Before reviewing the assertions, name the confusable pair from the issue in one
sentence: _which two outcomes does the report say cannot be told apart?_ Write it
down before reading the diff, so the test cannot supply the answer.

Then check the test forms **that** pair. Two specific traps:

- **A pair already separable by a cheaper signal is not the pair.** If the two
  arms differ in exit status, and the complaint was that exit status is
  ambiguous, the test has stepped around the defect rather than through it.
- **Both members must be present.** A defect report about `X` meaning two things
  needs two arms that both produce `X`. An arm producing `Y` is a third case; it
  may be worth having, but it does not close the report.

Prefer the phrasing "this test would fail if the harness stopped distinguishing
A from B" over "this test would fail if the harness broke." The second is
satisfied by almost any assertion; only the first is checkable against an issue.

## Why this matters more than an ordinary scope miss

The artifact left behind is a passing test named after the defect. It is
permanent, it is cited when the issue is closed, and it will be read by everyone
afterwards as evidence the defect is covered. The next person to touch the
harness will see an arm called "startup floor" and reasonably conclude the floor
is tested. Nothing in the suite will ever contradict them.

That makes this strictly worse than no test: an absent test invites the question,
and a passing one whose scope nobody re-derived retires it. The closing of the
issue is the damage, not the test.

---

Instance: review of PR #560 against `#545` at head `0fe7384d`. The verdict
blocked on this scope point alone — every other property of the test measured
sound. Fixed at `1dc096dd`, where the arm was rewritten to form the real pair
and renamed `rejects a startup exit 1 but accepts a citation-verdict exit 1`.
