# An assertion must discriminate the claim it makes — for a refusal, assert the cause, not the exit code

**By:** Vasquez — from PR #561 / issue #546, with Ripley. Ripley asked whether
this is specific to that suite or general. It is general, and I am setting it as
mandatory for guard tests.

## The rule

**A test that names a specific cause must assert on an observable that only that
cause produces. `status === 1` is not such an observable when many causes return 1.**

Stated as the failure it catches: an assertion can be wrong in two directions,
and the second one has no name yet.

- It can **pass when the implementation is broken** — the case already covered by
  _an assertion that passes under the broken implementation is not a control_.
- It can **pass when a different thing failed** — the test observes the outcome
  it expected, produced by a cause it did not intend, and reports success.

Both are the same underlying defect: the observable is not a function of the
claim. The first is a false negative under mutation. The second is a false
positive under substitution of cause. Guard tests are unusually exposed to the
second, because guards are written to converge on one outcome — refusal — and
convergent outcomes destroy information by design.

## The measurement that decides it

`scripts/safe-worktree-remove.mjs` at `31d7d52e`:

```
distinct throw sites: 19
```

All 19 are caught by one handler in `main()` and returned as `1`. So
`expect(status).toBe(1)` discriminates **one cause in nineteen**. It is satisfied
by "refused because the cwd is inside the worktree", and equally by "refused
because the recovery receipt's device and inode do not match", and by fifteen
others that have nothing to do with the test's name.

## What that cost, concretely

Four arms on `windows-latest` — including the junction-alias and `subst` arms,
which were the **only two real controls** on the path-containment guard because
they run the real script as a subprocess with no injected resolver — asserted
exit 1, received exit 1, and refused for an unrelated reason:

```
expected  'current directory is inside the worktree being removed'
received  'refusing because this is not a registered linked worktree: C:\Users\RUNNER~1\...'
```

The registry-membership check runs before identity resolution and on the
unresolved path; the runner's `TEMP` is an 8.3 short name and git reports the long
form, so membership refused first and the guard was never reached.

The part that makes this a rule rather than a bug report: **on a runner without
8.3 short names those arms go green while still never executing the guard.** The
suite would have reported the containment guard as covered, on the strength of an
exit code produced by a check that had already short-circuited. The same defect
appeared independently on `macos-latest` via `/var` → `/private/var`, which is the
default layout on every Mac — so this was not an exotic host.

## The trap in the obvious fix

Once the reason is asserted, the observed reason is _"not a registered linked
worktree"_. The cheapest way to make the test pass is to expect that string. That
would **pin the short-circuit as intended behaviour** and permanently retire the
only controls the guard has.

So the rule has a second clause: **the assertion is fixed by changing the code
until the right cause fires, never by changing the expectation to the cause that
did.** An expectation edited to match observed behaviour is not a test result, it
is a transcript.

## Assert an identifier, not prose

Requiring message-substring matching buys discrimination at the price of
brittleness — every wording change breaks tests, and the predictable response is
to loosen the matcher until it stops discriminating again, which returns us to
where we started by a slower route.

The durable form is a stable machine-readable discriminator per refusal — an
`error.code` or a symbol — asserted by code, leaving prose free to change. Where
that does not exist yet, substring matching is the only discriminator available
and should be used, but adding codes is the cheaper long-run answer and makes the
rule nearly free to comply with. A rule that is expensive to follow will be
followed once.

## Where it does not apply

This is not "always assert messages." The obligation is set by what the test
claims:

- A test named _"refuses a subst cwd"_ claims a **specific** cause. It must assert
  that cause.
- A test named _"exits non-zero on invalid input"_ claims the **shared** observable
  and is entitled to assert only that.

If a test cannot state which cause it is about, that is worth knowing before
worrying about the assertion.

## Relation to the sibling rules

- _An assertion that passes under the broken implementation is not a control_ —
  same defect, mutation direction.
- _A negative result is only reportable if you can say what would have made it
  come out the other way_ — same defect, pointed at reports.
- _Instruments answer adjacent questions_ — same defect, pointed at tools.

Four statements, one property: **the observable must be a function of the claim.**
Every instance found while reviewing #561 — a sentinel count that a real directory
would also satisfy, a version gate that skipped silently, a structural check that
verified shape rather than behaviour, and this one — failed toward **confident**
rather than toward visibly broken. None of them threw. That asymmetry is why these
need controls rather than care: care catches the failures that look like failures.

## The operational form

- A guard test asserts **which** guard refused, not merely that something did.
- Prefer a stable error code; use message matching only until codes exist.
- Never reconcile the expectation to the observed cause. Fix the cause.
- If a suite's guard arms all assert the same exit code, treat the coverage they
  claim as unproven until the discriminator is added.
