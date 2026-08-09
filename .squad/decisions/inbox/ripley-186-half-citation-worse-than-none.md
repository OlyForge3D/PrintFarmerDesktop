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
future citation to "the required-contexts check" points at a step that
genuinely runs, not at a script nothing calls. It runs on the same
`docs_only` terms as the rest of that job — gated behind
`steps.changes.outputs.docs_only != 'true'`, the same fast path the job's
SBOM and `cargo-audit` steps already stand down under (ci.yml:80-102
documents why) — and, per the round-4 correction below, only on `push`, not
on `pull_request` or `merge_group`. A citation to this step should say "runs
on any push to development/main that touches more than documentation," not
"every pull request" — an earlier draft of this section said the latter,
which was already an overstatement before the round-4 security fix made it
additionally wrong about which trigger the step runs under at all; this file
exists because that distinction is exactly the kind that gets lost in
restatement.

The wiring itself needed a second correction mid-review, on the same theme.
The first version gave the `advisories` job `permissions: administration:
read`, reasoning that reading `branches/{branch}/protection` needed a scope
`contents: read` didn't cover. `administration` is not a valid
`permissions:` key at all — GitHub Actions rejected the whole workflow at
load time (Hicks, PR #661 review, run `31313684210`), which took down every
check-run context on the PR, the opposite of what a "citations must be
accurate" fix should do. And re-spelling it correctly would not have helped:
that endpoint requires the calling token to hold repo-admin read access,
which `GITHUB_TOKEN` cannot be granted through `permissions:` regardless of
which key is named, because "grant GITHUB_TOKEN admin on its own repo" is
not a thing that block can express. The corrected step drops the invalid
permission and reads an optional `MERGE_QUEUE_CONTEXTS_TOKEN` secret; absent
that secret it prints a one-line `::warning::` naming exactly this
precondition and exits, rather than crashing the workflow or silently
reporting success.

A third review pass (Hicks again, same PR) caught the residual overstatement
in the paragraph above, before this correction: it said the step "runs...
what it cannot yet do is complete the comparison," which implies the
comparison starts and stalls partway. It does not start at all. The guard
clause exits BEFORE the `npm run check:merge-queue-contexts` line, so in
this repository's current state — no `MERGE_QUEUE_CONTEXTS_TOKEN` secret
configured — `scripts/check-merge-queue-contexts.mjs`'s `main()` has not
executed once in CI, ever. What is true, precisely: the Actions STEP runs
(is not skipped) on every non-docs-only push to `development`/`main` (see
the round-4 correction below for why it no longer runs on pull requests at
all), and its shell body always executes; what is not true is that the
script inside it runs, or partially runs, absent that secret.
`tests/enforcementCitations.test.ts` and
`scripts/check-script-reachability.mjs`'s `UNENFORCED_CHECKS` still classify
this as "invoked"/"enforced" — correctly, by their own stated definition,
which is "does some workflow `run:` line reference this command" (a
call-site question, decidable from tracked files alone) and not "does this
command execute on the current head, given secrets neither tool can read."
That is a real, load-bearing distinction and not a loophole: reverting
either classification back to "unenforced" was tried and rejected, because
it made those tools assert something equally false in the other direction —
`.github/workflows/ci.yml` genuinely does contain a real call site now,
which is exactly the fact `UNENFORCED_CHECKS`/`invoked` exist to track, and
an allowlist entry claiming otherwise would itself be the stale-justification
defect `tests/scriptReachability.test.ts`'s rot guard exists to catch (and
does catch — restoring the entry to verify this reproduces that guard's own
failure). The honest scope-limit is stated here, in prose a citation can
point at, rather than forced into either boolean: this step has a citable,
re-derivable call site; whether that call site has ever fired is a separate
question neither classifier answers, and today the answer is no.

A fourth review pass (Vasquez and Ripley independently, Hicks on a separate
prose point, all same PR) caught a defect one level more serious than
overstatement: a real vulnerability in the step itself. `MERGE_QUEUE_CONTEXTS_TOKEN`
is repo-admin-scoped, and the step handed it to `npm run
check:merge-queue-contexts` unconditionally on every non-docs-only run of
this job — including `pull_request` and `merge_group` events, where
`actions/checkout@v4` (no `ref:` override) checks out PR-authored content.
`npm run <script>` resolves the script name from `package.json` and its body
from `scripts/check-merge-queue-contexts.mjs`, both part of that same
untrusted checkout on those events, so a pull request could redefine either
one to exfiltrate the token — the same trust boundary `pull_request_target`
exists to protect, crossed here not by using the wrong trigger but by handing
a real secret to a `pull_request`-triggered step regardless. This was a
structural risk from the moment this step was written, independent of
whether the secret currently exists in this repo (it doesn't yet — but the
fix has to hold once it does). The fix restricts the step to `github.event_name
== 'push'`: it now runs only over already-merged, already-reviewed content on
`development`/`main`, never over a PR's own code. That narrows the claim
above about "runs on any pull request that touches more than documentation"
(paragraph two of this section) — it no longer runs on pull requests at all;
it runs on pushes to protected branches that touch more than documentation.
Separately, `.squad/decisions.md`'s account of this step once claimed it was
"non-blocking... like the SBOM/cargo-audit steps already in that job" — only
this step carries `continue-on-error: true` (`ci.yml`); the SBOM and
advisory-audit steps achieve their own non-blocking behavior by internally
choosing to `::warning::` and exit 0, not by that shared step setting.
Corrected there to not claim a parity the YAML doesn't have.

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
