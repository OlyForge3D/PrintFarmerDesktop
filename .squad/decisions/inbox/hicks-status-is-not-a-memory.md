# A status that was true when you took it is not a status; it is a memory

Re-measure at the moment of assertion, not at the moment the work finished.

Every status this repository reports is a reading of something that keeps
moving: a branch head, a check conclusion, a mergeability state, an issue's
open/closed. The reading is accurate when taken and decays immediately.
Reporting it later is not reporting a status — it is quoting a past
observation in the present tense, and nothing in the sentence marks it as one.

The worked example is a branch of my own. I reported a pull request as
`55dcbf2 / MERGEABLE / CLEAN / untouched` when it was `130e327 / BLOCKED`.
Every word had been true. I had merged the base into it myself and then
described the branch from memory rather than from the remote. "Untouched" was
false about a branch I had touched.

This is not carelessness and it does not respond to being more careful. Its
frequency scales with how well things are going: a squad that measures
carefully accumulates a large stock of true-when-taken facts, and each one is
a candidate to be carried forward past its life. On a day when several pull
requests merge, every open branch changes state without anyone touching it,
so the stalest facts are the ones about work nobody is doing.

## Why this is not the same as a query that cannot see its answer

The rule about empty and full query results covers a **broken instrument** —
a field that cannot carry the distinction being asked about, so the answer is
independent of the world. This rule covers a **working instrument read too
late**. The measurement was correct and the field did carry the distinction.
Only the clock moved.

The two need separating because the remedies differ. A broken instrument is
fixed by changing the query. An expired reading is fixed by taking it again,
and no amount of improving the query helps.

## What this looks like in practice

Take the reading in the same turn you assert it. If a report says a branch is
clean, that must come from a fetch performed while writing the report, not
from the check that preceded the last edit.

Report a value at a reference the reader can resolve independently, rather
than a description they must trust. "Seven contexts green at `45c1db4`" can be
checked by anyone; "CI is green" cannot, and is indistinguishable from a
memory of the previous run.

Prefer instruments that make a stale answer unreturnable over instruments that
make it detectable. Querying workflow runs _by_ `head_sha` cannot hand back a
different head's run, because the SHA is the selector. Reading a run and then
verifying its `head_sha` afterwards works too, but only if the check is
remembered every time — and it is a check about staleness, so it will be
skipped on exactly the busy day it is needed.

## The failure this prevents is not a wrong report

A stale status is usually harmless because someone re-reads it. The damage is
in decisions taken on it without a re-read: sequencing a conflict that has
already been resolved by a merge, holding work that is no longer blocked,
scheduling a rebase for a branch that has landed. Those consume real cycles
and they are all justified by a fact that was true when it was taken.
