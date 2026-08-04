# The assertion you did not think worth mutating is the one to mutate first

We already have the rule that an assertion which cannot fail proves nothing.
What that rule does not supply is where to point it. Mutation is not free, and
in practice the checks that get mutated are the ones already under suspicion —
which is precisely backwards. A check you doubt is a check you will look at
again anyway. The dangerous one is the check you are confident in, because
confidence is what stops you from spending the two minutes that would expose
it. The selection bias runs the wrong way: the assertion whose mutation feels
least worth the time is the assertion most likely to be hollow, because nothing
else in the process is ever going to look at it.

The first worked example is from PR #174, a pull request whose entire purpose
was to prevent assertions that cannot fail. A test for WCAG 1.4.10 checked that
the calibration workspace does not scroll horizontally at 200% zoom, by
comparing `document.documentElement.scrollWidth` against its `clientWidth`. The
mutation was to set `min-width: 2000px` on `.cal-workspace-content` and watch
the test go red. It stayed green. That element is `overflow: auto`, so it
absorbs the overflow into its own scroller and the document's `scrollWidth` can
never grow. The assertion was measuring a quantity that was structurally
incapable of moving.

Everything else in the stack passed it. Typecheck, lint, the full 1536-test
suite, and all seven required status contexts. A reviewer reading the test would
have seen a named WCAG criterion and a plausible assertion, because that is what
it was — the criterion was right and the measurement was wrong, and no amount of
reading distinguishes those. Seven other mutations in the same batch behaved
exactly as predicted. There was no way to know in advance that this would be the
eighth, and running seven of eight would have shipped it.

The second is from PR #194 and shows the same shape in an assertion nobody
authored recently. `tests/calibration.integration.test.ts` asserted that a
conflict returned by the sidecar adapter offered `acceptServer` as an available
resolution. It read as conflict coverage and had presumably read that way for
some time. The adapter returned a hard-coded literal, so the assertion held for
any conflict of any kind, held whether or not any resolution could actually be
performed — none could; the resolve handler throws unconditionally — and would
have kept holding if the entire conflict subsystem were deleted. It was found by
mutating the adapter, which was not on the list of things that seemed worth
mutating, because the assertion was old and green and not the subject of the
change.

The cost asymmetry is what makes this worth a rule rather than a habit. A
missing test is a gap, and gaps get filled when somebody notices the
uncovered behaviour. A present, named, green test standing in for coverage that
does not exist is worse than a gap, because it will be cited as proof of the
property it names for as long as it lives, and it will be defended when someone
proposes replacing it. The 1.4.10 test would have been offered as evidence of
conformance. The conflict test would have been offered as evidence that the
conflict path was exercised.

The practical form is a targeting rule, not an exhortation. When mutating a
batch of assertions, order them by how confident you are, and start at the
confident end. When you catch yourself deciding an assertion is too obvious to
be worth breaking, that judgement is the signal to break it. And when a
mutation behaves exactly as expected, that is information about that assertion
only — it says nothing about the next one, which is why partial coverage of a
mutation matrix is not partial evidence but no evidence about the cases skipped.
