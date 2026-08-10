# #244 decided: compliance's evidentiary asymmetry is doctrine, not a work item — its one mechanical residue was already landed by #299

**By:** Ripley, per the `squad:ripley` routing on #244.

## The finding, restated in one line

Honouring a constraint tells you nothing about whether it is real: violating a
rule produces the actual consequence immediately, while complying with it
produces silence — and that silence is identical whether the rule was
load-bearing, misattributed, or fictional. #244's own worked example (the
`supplyChainPolicy.test.ts` mechanism cited for #152, verified false by
mutation) and its five thread comments each measure a different shape of the
same asymmetry:

1. A positive control upgrades an abstention from a self-report to a
   measurement of conduct — it never upgrades a claim about the _rule_, which
   is what this issue is about.
2. A compliance null needs a **denominator** (`0 / 6`, not bare `0`) and a
   **coverage boundary** (the ref range, the query frontier) or a vacuous
   test and a passing test print the same headline.
3. An instrument used to audit compliance must be validated against the
   object on **both arms**, not just given a denominator and a control — the
   `hold:sequenced` label-index measurement (#299) is a case where a
   non-silent, in-range, denominator-carrying instrument was still
   confidently **wrong**, and wrong toward the direction nobody audits
   (phantom holds surviving closure, 5 of 6 rows).
4. A self-incrimination norm mis-assigns blame as reliably as a self-serving
   one — the default accused becomes whoever holds the norm hardest, which
   selects on conscientiousness, not on evidence; a disagreement between two
   claims must be tested in both directions before either party volunteers.

## Decision

1. **Disciplines 1–3 from the issue body (verify a stated mechanism once at
   write-time; separate constraint from rationale in dispatches; mark a
   restated constraint as received-not-verified) are dispatch-authoring
   conduct.** No test can reach them and no mechanical check can enforce
   prose discipline between agents — they are recorded here as doctrine, not
   filed as further child issues, per the standard this squad has already
   applied when closing similarly-shaped philosophical findings (#186, #214).
2. **The one item in this thread with a finishable, checkable acceptance
   test — "a check that fails when repository prose or a runbook instructs a
   reader to determine hold state via `--label` / `label:`" — is not new
   work.** It was already filed and landed as **#299**, and lives today as
   `scripts/check-label-index-usage.mjs` (enforced by
   `tests/labelIndexUsage.test.ts`), which bans the label-search index as an
   _authorizing_ read in scripts/workflows for exactly the reason this
   thread's fourth comment measured (5 phantom `hold:sequenced` rows
   surviving PR closure, byte-identical across independent re-runs). No
   further mechanical change is required to close that residue.
3. **This issue closes as a recorded finding**, per the closing party's own
   proposed disposition in-thread: "most of #244 is doctrine and should not
   pretend otherwise... I would rather this issue close as a recorded
   finding with one small child than stay open as a standing invitation to
   add a fifth discipline" — and that one small child (the `--label` /
   `label:` prose-instruction lint) is #299, already merged.

## Where this is filed

This entry, `.squad/decisions.md` (once merged by Scribe), and
`.squad/known-lying-commands.md` (instance 11/12's neighbourhood — the same
"confident wrong answer" shape) are where a future sweep asking "was #244
ever resolved, and does the mechanical check it wanted exist?" should find
the answer.

## What would reopen this

If a future audit finds repository prose or a runbook instructing a reader to
determine hold state via `--label`/`label:` that `check-label-index-usage.mjs`
does not catch (see that script's own documented scope limitations — it is a
best-effort smoke test, not a static-analysis guarantee), reopen against #299
first, not #244: #244 is the doctrine finding, #299 is the mechanical
enforcement, and they should not be re-merged into one issue.
