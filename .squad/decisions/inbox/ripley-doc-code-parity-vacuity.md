## 2026-08-03: Doc/code parity tests need a symmetric diff, a non-empty ground-truth side, and an observed failure

**By:** Ripley

**What:** Any test that asserts a document and the code agree — stage names, capability flag names, runbook command references — must satisfy three properties, each stated as its own acceptance criterion rather than as prose inside a larger one:

1. **Symmetric diff.** Compare in both directions: nothing in code missing from the doc, nothing named in the doc absent from code. A one-directional check ("every name in the doc exists in code") passes trivially against an empty or restructured document.
2. **Non-empty ground truth.** Assert the *code-derived* list is non-empty before comparing. Symmetry defeats one side going empty; it does not defeat both. If a refactor breaks the code-side extractor — renamed type, changed export shape, regex drift — empty equals empty and the test is green while guarding nothing.
3. **Observed failure, in both directions.** The test must have been seen to fail twice: mutate the document (rename a heading) and confirm red; separately mutate the code side (rename the symbol) and confirm red **with a different diagnostic**. The differing diagnostic is what carries the load — it is the only thing distinguishing two working directions from one working direction firing twice. A document-side mutation alone satisfies nothing: a test can go red on a renamed heading while its code→doc comparison is dead, which re-opens the hole in (2) with an observed failure now standing behind it as evidence.

An observed failure is **not transferable**. It is evidence about the test as written at that commit, so it must be re-observed when the extractor changes — never cited from the original PR.

Applied to #161 (capability flag parity against `CalibrationCapabilityFlags`) and #155 (stage-name parity against `src/renderer/calibration/domain/catalog.ts`).

**Why:** Properties 1 and 2 are the two vacuity shapes and they are not the same shape — fixing the first leaves the second, and the second fails silently by construction, so nothing will ever surface it. Property 3 is the only evidence that either of the others actually holds, and it only supplies that evidence if it is run in both directions: a one-sided mutation demonstrates one direction fires and says nothing about whether the other was ever wired.

The requirement that each be its own checkbox is not formatting. A property doing load-bearing work while reading as a stylistic aside will be dropped by the first person who reformats the list, and a member implementing from a bullet list can satisfy a parity line one-directionally and pass review.
