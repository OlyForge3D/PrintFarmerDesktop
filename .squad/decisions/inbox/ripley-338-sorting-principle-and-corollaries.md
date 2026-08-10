# The sorting principle: absence invites a second look, success ends the investigation

**By:** Ripley — split out of #214 at Ripley's own request. #214 is "commands that
answer a neighbouring question": a defect _class_, keyed to which predicate was
run. The instances below are not command defects — they cover a label, a
configuration read, a broadcast form, a bucket name, and a retraction's grammar.
Filed under #214's heading they read as N more rows in that table; filed here
they are the principle that explains _why_ that whole table, and several others
in this squad's doctrine, keep collecting new rows instead of emptying out.

## The principle

> **Absence invites a second look; success ends the investigation.**

A missing value provokes a check. A well-formed answer does not. So **the wrong
answers that survive are the ones that arrive looking right** — every defect
this doctrine has filed under #214, #253, #305, #307, #516, and the four
corollaries below is an instance of a result that was well-formed, plausible,
and unaudited. This is the reason a catalogue of "commands that lie" never
converges: the fix for each row is a smarter predicate, but the sorting rule
that decides which rows _get written_ is upstream of any of them — it is
whichever result looked done.

## Corollary 1 — the mute corollary

> **A checker that cries red on every fresh run gets muted, and a muted checker
> fails toward green permanently. The reassurance failure is one mute away from
> any alarm failure.**

The axis is not two-valued. Failing toward red is survivable per-occurrence
(someone notices, someone investigates) and unsurvivable per-rate: a false-alarm
rate is exactly what manufactures the mute that converts a currently-safe
alarm failure into a silent reassurance failure. A check nobody has muted yet
is not a check that cannot be muted — it is a check that has not yet accumulated
enough false alarms to earn one. This is why "the checker still exists" is not
evidence it is still trusted, and why an audit of live doctrine has to ask
separately whether each checker's alarms are still being read.

## Corollary 2 — correction latency is a traffic property

> **Corrections tonight fired because an inbound message arrived, not because
> anyone re-audited. Correction latency is a property of message traffic, not of
> discipline — a quiet session is not a converged one.**

Measured on a channel that had run ~13h (#293): **the error-correction rate is
bounded by the message rate, and the sessions least likely to be corrected are
the ones generating the least traffic.** This inverts the instinct to praise
quiet sessions — **silence is the condition under which a wrong belief survives
longest**, not evidence nothing needed fixing. Paired with the routing-side
finding that a broadcast requesting reports over a one-way channel receives
silence, and silence reads as compliance, this is the strongest available
argument in this doctrine for **putting state on artifacts (files, PR bodies,
issue comments) rather than in messages (chat turns, one-way broadcasts)** —
an artifact can be read cold by a later, unrelated session; a message that
generated no reply cannot be distinguished after the fact from one that was
never delivered.

## Corollary 3 — statistics with no ill-posed return (measured 2026-08-10)

Four sessions spent an evening comparing the `cloud` and `local` session-store
members of this repo's own session-store tooling — counts, maxima, ratios,
eighteen frontier samples. Measured:

```
                 member_total  never_present  touched_present
cloud                 975            0               0
local                 723           25              25   <- positive control, by construction

id length 36 both sides    task_id: 0 and 0, and task_id = id on 0 of 975
same window: cloud 758 / local 618       this repo: cloud 324 / local 370
```

Same object, same window, same repository, same identifier shape — **not one
shared row**; 0 of 50 bounds overlap under ~6%. The two members are **disjoint
stores, not replicas with a lag between them**, so every cross-member ratio
published to date was void rather than merely wrong.

> **Two aggregates over disjoint populations yield a difference that is
> arithmetically valid and semantically empty.** `COUNT` and `MAX` are total
> functions — they return a comparable number for _any_ two sets, including
> unrelated ones, and **cannot report that their operands describe different
> objects. Only a join can fail, and a join is the one thing nobody ran.**

This is the mute corollary's mirror image: **a statistic with no red state
never complains, so it never gets muted — and it is never audited either.**
The comparison succeeded every time, for eighteen samples, and success ended
the investigation exactly as the principle predicts. The remedy is the same
shape as #516's base/head rule and #307's subject-liveness rule: before trusting
a cross-population comparison, run the join (or an equivalent membership check)
that could fail, rather than only the aggregate that cannot.

## Corollary 4 — the form a declination must take

> **A declination is a second reading only when it names what was read.**
> _"I did not do X"_ is nothing; _"I did not do X because the ref resolved to a
> different SHA"_ is a measurement.

Without the qualifier, every "I didn't touch it" becomes admissible as
evidence — **a null result dressed as a control**, which is the class this
whole doctrine exists to remove. A bare declination and a genuine negative
control are indistinguishable from the outside; the qualifier is the only
thing that turns the former into the latter (see also
`vasquez-same-run-negative-control.md`'s "a control that has never been
observed to return the other answer is not yet a control" — the same
requirement, applied to a spoken retraction instead of an automated check).

## Member instances, cited by comment URL (not by comment number)

**Numbers do not resolve on #214 and must not be used as citations.** Measured
on all 201 comments on #214: 92 distinct declared numbers, max declared 124,
**19 declaration collisions** (comments 8, 14, 16, 19, 30, 33, 35, 39, 40, 41,
45, 46, 47, 48, 51, 52, 55, 57, 67 each carry more than one declared number),
73 singly-declared. A negative control ("instance 9999") returns 0 comments,
so the resolver itself discriminates correctly — the collisions are real, not
a resolver defect. Collisions have grown from 14 of 78 at the prior audit to
19 of 92 here: independent numbering by concurrent writers continues, and the
obvious remedy (key by author instead of by number) cannot work, because **all
201 comments are authored by the single identity `jpapiez`** — `user.login`
carries one value across every session, so authorship discriminates nothing
either. **The only working citation for a comment on this issue is its URL.**

The requested window (declared instances 22-37) resolved by URL — 16 declared,
13 unique comments, 3 ambiguous (a declared number pointing at two different
URLs):

| #                     | comment                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22, 23                | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174340271                                                                                       |
| 24                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174371096                                                                                       |
| 25                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174390337                                                                                       |
| 26, 27                | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174424008                                                                                       |
| 28                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174437045                                                                                       |
| 29                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174452224                                                                                       |
| **30 — AMBIGUOUS x2** | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174478494 · https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174702762 |
| 31, 32                | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174492691                                                                                       |
| **33 — AMBIGUOUS x2** | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174504831 · https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174610471 |
| 34                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174520687                                                                                       |
| **35 — AMBIGUOUS x2** | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174532398 · https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174610471 |
| 36                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174548537                                                                                       |
| 37                    | https://github.com/OlyForge3D/PrintFarmerDesktop/issues/214#issuecomment-5174559883                                                                                       |

**Representative members, each a well-formed-but-wrong result that ended its
own investigation:**

- **`CORRECTION` as a trust-bearing label.** A correction inherits the trust
  earned by the act of correcting and spends it on its own new, unverified
  values. The label signals _already verified_, which is exactly the signal
  that stops the recipient verifying it themselves.
- **Branch protection read as weak rather than unset.**
  `required_approving_review_count = 0` is not a protection that exists but
  cannot fire — it is one **never configured**, and that is a different fact
  with a different remedy (configure it, versus recognise it cannot be
  satisfied at all under a single-collaborator repo and stop budgeting on it).
  This repo's own `scripts/check-protection-assumptions.mjs` already draws
  this exact line correctly (see the annotation below) — it is cited here as
  the positive control for the corollary, not as an outstanding defect.
- **`mergeable`/`mergeStateStatus` on a draft.** They answer "would this merge
  cleanly" completely and correctly, and say nothing about draft status,
  approval state, or a `DO NOT MERGE` marker in the title — three separate,
  well-formed, true readings that together produce a false sense that the PR
  is ready.
- **`not-success` as a bucket name.** `conclusion` is `null` until
  `status == 'completed'`, so `conclusion != 'success'` is true for a failed
  job and equally true for one that has not started yet — **the bucket is
  named after its bad member**, and a reader who sees "3 not-success" cannot
  tell, from the name alone, how many of those three simply haven't run.
  This is the same defect already catalogued as row 4 of
  `.squad/known-lying-commands.md` (`conclusion != "SUCCESS"`); annotated
  there to point at this issue's naming-convention framing rather than
  duplicated as a new row.

## Scope note

The window (declared instances 22-37) was requested when the series had
reached 124 declarations. It is cited above as asked, but it is a 38-minute
band (03:41Z-04:19Z) out of a list that has since grown by 87 more
declarations, and the later instances belong to the same classes named here.
Filing only this window would leave most of the evidence under #214's command
heading rather than sorted here. Future sessions re-citing #214 material
against this principle should take the rest by URL as they are re-cited, not
by re-deriving comment numbers (see the collision measurement above).

## What this doctrine entry is, and is not

This is a documentation-only entry: a durable name for a sorting rule this
squad's own audit history already exercises, plus its four corollaries and the
two measurements taken specifically for this write-up (the citation-collision
count and the disjoint cloud/local store measurement). It does not change any
checker's behaviour. The one annotation it makes (`known-lying-commands.md`
row 4) is a pointer, not a new mechanism. Closes #338.
