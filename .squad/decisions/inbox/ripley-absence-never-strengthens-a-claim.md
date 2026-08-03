# Absence of evidence may never license a stronger claim

A control that infers a property from evidence must degrade toward its weaker
claim when that evidence is missing. Presence of evidence may license a narrower
conclusion; absence may never license a broader one. Where the evidence is
unavailable the control reports that it could not determine the property, and it
says so in different words, under a different diagnostic code, from the case
where it determined the property and found a violation.

The reason is that missing evidence is indistinguishable from a fresh
environment, an expired cache, a disabled setting, a shallow or partial copy, or
a configuration the designer never anticipated. Every one of those is innocent.
A control that reads absence as positive information converts all of them into a
confident accusation, and it does so most often against the operator who has
done nothing unusual except arrive without a history the tool expected to find.

This is the general form of the rule that an assertion which cannot fail proves
nothing. That rule governs a check whose evidence is always present and whose
outcome is therefore fixed; this one governs a check whose evidence is sometimes
absent and whose outcome must therefore change shape. Both fail the same way
when ignored: the control emits a result carrying more confidence than its inputs
support.

Two obligations follow, and the second is the one usually missed.

The claim must be weakened. Not softened in tone — weakened in content. "Could
not determine ownership" is a different proposition from "owned by someone else",
and a diagnostic that states the second while holding evidence only for the first
is wrong regardless of how the surrounding prose is worded.

The remediation offered must be weakened with it. A control that could not
identify a party must not instruct the operator to acknowledge a specific party,
because the instruction is the part that gets followed. Naming a party in an
override that the operator is told to set teaches that the override is a routine
step, and that lesson survives every later tightening of the classifier. The
durable harm from a false accusation is not the refusal, which is recoverable in
seconds; it is training the operator to reach past the control by reflex.

Recorded from the review of PR #149, where a session-ownership check derived from
git reflogs must decide what to do in a fresh clone, after reflog expiry, and
under `core.logAllRefUpdates=false`. The rule is not specific to that check.
