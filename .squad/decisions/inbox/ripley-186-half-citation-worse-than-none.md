# A dispatch constraint's citation must be one the reader can execute — a wrong one is worse than none

#186's opening incident: Bishop's PR #169 was built around a constraint
stated verbatim in a lead dispatch — _"Do NOT touch `.github/workflows/`.
`tests/supplyChainPolicy.test.ts` hard-asserts counts over `ci.yml`."_ — that
was false. Unlike a wrong fact in a skill file (auditable: it has a path,
`git grep` finds it, one correction fixes it for everyone), a wrong fact in a
dispatch message has none of those properties. It is not in the repository,
it arrives through the one channel a member has least reason to doubt, it
propagates by copying to every recipient, and it cannot be corrected once —
only re-stated to whoever asks next.

The issue's original three acceptance criteria were refined across its own
comment thread. AC2 and AC3 are unchanged from the issue body. **AC1 is
strengthened below**, because the issue's own opening incident satisfies the
original AC1 as written and still misled Bishop.

## AC1 (strengthened)

The original AC1 read: _"Constraints in a dispatch must cite an artifact, or
be marked as unverified."_ The false constraint above met that bar — it named
a path (`tests/supplyChainPolicy.test.ts`) and gave a reason a member could
read. It was still false. **A citation requirement is satisfied by a wrong
citation**, so the original wording does not exclude the case it was written
for.

The strengthened rule:

1. A prohibition in a dispatch must cite **the assertion that enforces it**,
   by file and line, and the citation must be one the reader can **execute**
   — reproduce, at their own machine, right now — or it must carry **no
   citation at all** and stand purely on the dispatcher's own authority.
   There is no third form. A citation that looks checkable but is not
   (because it names a real file:line whose assertion doesn't establish what
   the dispatcher claims) is not a permitted middle ground.
2. **A half-cited rule is worse than an uncited one.** It supplies a
   refutation target that is not the actual rule. A reader who executes the
   citation and finds the named assertion true has not confirmed the claim —
   they have confirmed an unrelated fact standing next to the claim — and
   will believe the claim regardless, because checking is what the reader
   was invited to do and checking succeeded. An uncited bare-authority
   statement invites no such false confidence; the reader knows to weigh it
   as an instruction, not as a checked fact.
3. The citation must be **re-derivable at the reader's current HEAD**, not
   frozen at the author's HEAD at dispatch time. A file:line that was true
   when written and has since moved, or whose neighboring code has since
   changed what it establishes, is stale on arrival exactly the way
   `.squad/decisions/inbox/ripley-go-and-look.md` describes for artifact
   pointers generally — this is that rule applied to instructions rather
   than to observations.
4. An explicit `UNVERIFIED:` marker remains an acceptable substitute for a
   citation, per the original wording — it invites the member to check
   rather than asserting a checked fact that isn't one.

### The worked example that motivated the strengthening

A correction to the original false constraint (delivered after #186 was
filed) named the right file and line —
`tests/ciWorkflowTriggers.test.ts:271` — and characterized it as verifying
that the seven check-run names `ci.yml` emits match the branch-protection
required contexts. The file and line resolve. The test's own adjacent
comment (`:272-273`) states plainly that it does not:

```
:271  it('emits exactly the seven check-run names ci.yml produces, byte-identical'
:272    // The emitted side only. Whether these are the *required* contexts lives
:273    // in branch protection, which this test does not read:
```

**Referentially correct, inferentially wrong.** A reader who executes the
citation confirms the file exists, the line number is right, and the quoted
title is exact — and still ends up believing something the test does not
establish. No citation-checking discipline catches this, because the
citation checks out.

The belief behind the correction was true: the emitted names really are
meant to match the required contexts, and the code that performs that match
is real — `scripts/check-merge-queue-contexts.mjs`
(`fetchRequiredContexts` reads live `branches/development/protection`;
`evaluateRequiredContexts` compares it against what each workflow emits).
But at the time #186 was filed, that comparison was **never invoked
automatically anywhere** — described as enforcing in four workflow header
comments, wired into `package.json` as `check:merge-queue-contexts`, and
called by nothing in `.github/workflows/`. `tests/enforcementCitations.test.ts`
already measured this exactly (`runInvokedScripts`/`testImportedScripts`,
asserting `imported: true, invoked: false` for this script, per #472).

So half of what makes the "seven names match" rule true was enforced
(`ciWorkflowTriggers.test.ts:271`, live, running in the suite) and half was
dead code (`check-merge-queue-contexts.mjs`'s live comparison, "run by hand").
**A strengthened AC1 that only demanded a resolvable file:line would not have
caught this** — the file:line was real. It has to demand that the cited
assertion actually establishes the claim, and that the reader can watch it
run. This PR's companion change
(wiring `check-merge-queue-contexts.mjs`'s live half into
`.github/workflows/ci.yml`'s `advisories` job) closes that specific gap so a
future citation to "the required-contexts check" points at something that
genuinely runs on every pull request, not at a script nothing calls.

## AC2 (unchanged)

**A member is licensed — and expected — to falsify a constraint in their own
brief and report it, without needing permission first.** Bishop did this in
the originating incident without being licensed to, and was right. Disputing
a dispatched constraint should not require nerve; it should be the ordinary,
expected response to finding one wrong.

## AC3 (unchanged)

**A falsified constraint must be corrected in a `.squad/` artifact, not
merely in a reply or a comment.** The dispatch that carried the error is not
reachable by the next recipient — a reply to that one dispatch fixes it for
one person and leaves every other recipient, and every future one, holding
the original sentence. The correction belongs where `git grep` can find it:
this file, and the summary entry in `.squad/decisions.md`.

## Relation to other entries

- `.squad/decisions/inbox/ripley-go-and-look.md` — reachability and
  staleness of a pointer are properties of the reader's fetch state, not of
  the commit; item 3 above is that rule applied to a dispatch citation
  instead of an artifact pointer.
- `.squad/decisions/inbox/hicks-count-assertions-over-external-sets.md` — the
  true account of the count-assertion claim the original false constraint
  misattributed to `supplyChainPolicy.test.ts`.
- #472 / `scripts/check-enforcement-citations.mjs` — the existing, narrower
  mechanism that already catches an enforcement citation naming a script
  nothing runs or imports, in workflow/comment prose. That check is necessary
  and not sufficient here: it accepts "run by hand" as an honest label for a
  citation, which is a legitimate state for many scripts but was, for this
  specific rule, the dead half of a claim being made to a squad member as if
  it were fully live.
- #313 — "a check with no call site cannot say no": the general shape this
  issue's concrete finding is a further instance of.
