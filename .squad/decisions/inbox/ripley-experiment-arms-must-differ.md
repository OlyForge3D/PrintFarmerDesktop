# Two arms that do not differ mean the experiment did not run

An experiment that compares a test case against a control produces a result only
when the two arms differ. When they agree, the first conclusion available is not
that the variable under test does not matter — it is that the variable was never
applied. Divergence between the arms is the evidence that the apparatus works;
without it, the run carries no information about the subject at all, in either
direction. Treat identical output as an apparatus failure until a specific cause
is found, and re-run rather than record.

The check is required because a broken run does not announce itself. Four
instances in one review of PR #149 arrived looking exactly alike, and the causes
sat at three different stages:

Construction — a force-push aimed at a protected branch was refused by the
`PROTECTED_REFS` check before control ever reached the session-attribution code
under test. The input never arrived.

Execution — a setup step used `git cherry-pick -q`, which is not a valid flag.
The step silently did nothing and the repository was never placed in the state
the experiment described.

Observation — a PowerShell output filter stripped lines beginning with `+ ` to
suppress error carets, and `git cherry` marks a genuinely lost commit with `+`.
The run was correct and the instrument deleted the finding.

The fourth is the one that justifies the rule, because it caught a positive
rather than a null. A force-push appeared to bypass the guard entirely; the
worktree had been restored to a branch where `.githooks/` did not exist, so
`core.hooksPath` pointed at a missing directory and git ran no hook at all. What
exposed it was an ordinary fast-forward, run for an unrelated reason, that also
produced no guard output — which cannot be true if the hook is wired. Publishing
a bypass that does not exist would have been more damaging than missing one, as
it sends an author rewriting a working control against evidence nobody can
reproduce.

Neither inspecting the arm under test more carefully, nor reasoning harder about
the mechanism, surfaces any of the four. Only the comparison does, and only when
the control is chosen so that a sound apparatus must make it come out
differently.

This is `pushExpectingSuccess` one level up. That control exists because a test
asserting a push is refused also passes when the push silently never happened;
this rule exists because an experiment reporting no effect also passes when the
experiment silently never ran. Same defect class, applied to the harness rather
than to the code.

It stands upstream of the rule that a negative result is worth reporting only
when you can say what would have made it come out the other way. That rule
governs what may be published; this one governs whether a result exists to
publish. Ordering matters: a null with no divergent control is not a weak
finding, it is an unrun experiment, and applying the publication test to it
grants it a standing it has not earned.

Recorded because it came out of an agent's own broken runs rather than out of
reviewing anyone's code. The failures that produce transferable process rules
are more often the reviewer's than the author's, and they are visible only to
the person who made them.
