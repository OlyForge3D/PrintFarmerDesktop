# A green mutation, and other instruments that cannot report what they appear to report

Two rules, one shape. Both are cases where the thing that would have
raised the alarm is the same event as the fault, so nothing disagrees with
anything and the result reads as diligence. Filed from #188.

## Rule 1 — a mutation that stays green is not evidence until it is shown to have changed behaviour

A mutation that survives has two possible causes and **they are
indistinguishable from the outside**. Either the test is weak — the mutation
changed behaviour and nothing noticed, which is a finding — or the mutation was
**ineffective**: it never changed behaviour at all, because the mutated value
was dead, overwritten, or on a path the test does not reach. The second is a
fact about the _code_, not about the test, and it is not a finding. Both produce
the identical observable: an edit, a green run, a note reading _"survived."_ We
have no step that separates them, and the protocol reads the green run as
evidence about the test.

**The ambiguity fails in the direction that reads as diligence.** An ineffective
mutation reported as a surviving one becomes a finding — written into a PR body,
quoted in a review, generating follow-up work hardening an assertion that was
never weak. Nobody audits a finding. In the worse case the reasoning runs
backwards and the test is judged load-bearing precisely where the code beneath
it is unreachable.

**The instance, from PR #169 (`jpapiez-vigilant-bassoon`).** Testing
correlation-ID stability across a calibration flow, the _initial_ correlation
lookup in `src/main/ipc.ts` was mutated to mint a fresh ID. It stayed green,
which looks exactly like a weak stability assertion. It was not. The handler
opens with `calibrationCorrelation.resolve('job', request.jobId)` and then, on
the success path, **reassigns `correlationId` from a second
`resolveOrBeginWithOrigin` over the attempt binding once the response has
arrived** — so the minted value was never observed by the assertion. The
mutation that bites replaces that _post-response_ resolution, and that one goes
red. (Grep `resolveOrBeginWithOrigin` in the queue-state handler rather than
trusting a line number; both call sites are in the same `try` block.)

**The remedy is not "look twice" — it is "cheap enough to look twice."** The
only reason the ineffective mutation was caught is that the loop was a
sub-second single-file vitest run, so trying it a second way cost nothing. Had
it been a CI round-trip or anything needing a live server, "surviving mutation,
weak test" would have been banked and reported. Mutation testing therefore
degrades **silently** the moment the feedback loop gets slow, and it degrades
_toward producing findings_: a slow loop does not stop emitting mutation
reports, it emits surviving-mutation reports, which are the ones that get acted
on. The health of the practice is coupled to iteration cost in a way that is
invisible from the reports themselves.

**The rule.** A mutation may not be reported as _survived_ until it has been
shown to change behaviour — red under _some_ test, or the mutated line
demonstrably reached and its value observed. If nothing anywhere goes red, the
mutated code may be dead, and _that_ is the finding to report instead. A
mutation that cannot be shown to change behaviour is reported as **ineffective**,
explicitly, and is not evidence about any test.

**It is not really a rule about mutations.** It binds **any intervention whose
result you intend to read** — a bisect, a feature-flag flip, a mock, a disabled
cache — because each is an edit made in order to interpret an outcome, and each
is worthless until shown to have changed the system. The trap with teeth is an
intervention applied to **one of N copies of the mechanism, where N is not
visible from the file you are editing**: disabling `reapStaleTempRoots` in
`tests/calibrationRedaction.test.ts` and still seeing the failure twice in eight
runs reads as _reaper exonerated_ — but that helper sweeps every
`pf-calibration-log-*` in the shared OS temp directory, skipping only its own
root, and this machine carries twenty-plus worktrees each running their own
copy. The bisect changed nothing the failure could see, and _exonerated_ is a
conclusion someone will quote.

## Rule 2 — when the bad input and the misread output are the same event, there is no second signal

**Some failures produce a clean-looking result as their symptom.** When the
fault is in the query, the mock, or the identifier, and the fault renders as an
ordinary empty or passing result, **there is no independent detector**. The bad
input and the misread output are a single event, so nothing contradicts
anything, and the absence of a signal is read as the presence of information.

**Instance A — a mock that verified green while doing nothing.** PR #169 added a
`vi.mock('node:os', …)` returning `{ ...patched, default: actual }`. The
consumer, `src/main/retargetArtifacts.ts`, does `import os from 'node:os'` and
reads `os.tmpdir()` off the **default** export, so the override was never in
effect and **the mock did nothing**. It passed all seven required contexts,
because the symptom it suppressed is a race that only fires when a stale
instance directory happens to be present, and there wasn't one. _The symptom was
verified absent; the mechanism was never verified present._ The corrected form
is in `tests/calibrationRedaction.test.ts` on that branch — it returns
`{ ...patched, default: patched }`, with a comment naming the defect.

**Instance B — an identifier reconstructed rather than copied.** Ripley queried
the CI API with a full commit SHA he had rebuilt by hand from a 7-character
prefix, received `[]`, and nearly read it as _"no runs for this commit."_ A
reconstructed identifier that is wrong returns empty, and empty reads as a
finding about the world rather than a fault in the query. His own
`ripley-go-and-look.md` already carries the guard — _"never reconstruct an
identifier — copy it from the tool that emitted it"_ — under the heading
**"Never valid — no reading was ever taken."** (`ripley-go-and-look.md` reached
`development` in #163 after this note was drafted. Cite the heading rather than a
line number regardless — the rule sat at `:37` in one telling and `:45` in the
file, and heading text survives both the rebase and the merge.)

These two also sit alongside `hicks-empty-query-results.md`, which is the same
defect reached from the query side: a field that can never hold the property
being asked about produces an audit that returns clean forever.

**Corollary, and it is the actionable part: when a fix works by _removing a
symptom_, verify the mechanism is in place rather than that the symptom is
gone.** For a mock, assert that the mock is actually applied — that the consumer
observes the patched value — as an assertion distinct from the behaviour under
test. PR #169 does the deliberate version as its mutation 11: bypass
`safeOpaqueRevision` at the emitter while leaving the helper intact, which goes
red with `expected 'bearer ******' to be '[unsafe-revision-dropped]'`. Testing
the helper alone passes even if the builder never calls it.

## Related, and not restated here: a prohibition in a brief carries a citation

Ripley adopted a third rule of the same family today, and it binds **the issuer
of a brief, not its recipient**: a prohibition stated in a dispatch carries a
citation — a file, a line, an issue — or it is stated as a preference. The case
was his instruction _"do NOT touch `.github/workflows/` — `tests/supplyChainPolicy.test.ts`
hard-asserts counts over `ci.yml`."_ The prohibition was reasonable; **the causal
claim welded to it was false.** Editing that workflow merely requires updating
that test, which is friction, not prohibition — see
`hicks-count-assertions-over-external-sets.md`, which documents exactly that.
Worse, the claim was not checkable by anyone who was not in that conversation.
It was copied into a plan without verification, which is the correct default and
is exactly the problem.

It is recorded in full as **#186**, which is authoritative for it; it is named
here only because all three rules concern controls that **bind the party least
able to act** — the reviewer who cannot see the mutation site, the reader who
cannot see the mock, the recipient who cannot see the source of a constraint.

## Scope

Protocol and documentation only. No production code, no test changes, no
harness. Automating the effectiveness check — instrumenting the mutation site —
is a larger question and is deliberately not settled here.
