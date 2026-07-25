---
name: test-discipline
description: What counts as an acceptable test change in PrintFarmer Desktop. Read before modifying, moving, or deleting any test, and before claiming a change is covered.
---

# Test discipline

## Never weaken a test to make it pass

Do not skip, delete, `#[ignore]`, loosen an assertion, or widen a tolerance to get green. If a test fails, either the production code is wrong or the test encodes a stale contract — establish which, and say which in the PR body.

A stale test is a legitimate finding, but you must prove it. When PR #62 failed, the test asserted a macOS temp alias (`/var/...`) while the service correctly `realpath()`-canonicalized to `/private/var/...`. The test was wrong — but that conclusion came from reading the service, not from the test being inconvenient.

## Announce moved tests before a reviewer finds them

A diff showing `-140` lines in a test file looks like deleted coverage. If you moved tests, say so explicitly in the PR body: which tests, to which file, and whether assertions changed. Dallas did this proactively on PR #68 and it saved a review round.

Silent test deletion is the single fastest way to lose reviewer trust.

## Test the boundary from both sides

Every limit, threshold, or cap needs **both**:

- a just-under case that **passes**, and
- a just-over case that **is rejected with the specific diagnostic**.

The passing side is not optional. A cap that degrades into blanket rejection is an availability bug wearing a security hat — a ZIP64 entry ceiling that rejects _all_ ZIP64 archives "passes" every rejection test while breaking every large legitimate package.

Prove the passing side at the **documented legitimate maximum**, not at a comfortable value. Reviewing PR #68's 20,000-row part-tree budget, the check that carried weight was rendering a legitimate 5,001-object scene (at the sidecar's documented 5,000 mesh-object ceiling, plus one container) and asserting it produced 5,001 rows with no truncation notice. "A small scene renders" would not have shown that the cap leaves headroom above real input.

Also pin the boundary _adjacently_. A far-under case does not constrain the comparison operator: testing `MAX + 50` rejects and `5,000` passes leaves an off-by-one at `MAX` undetected. One of the two cases must sit next to the limit.

## Assert the specific failure, not merely that something failed

`assert!(result.is_err())` passes when an unrelated earlier failure occurs, so it can pass while the control you meant to test never runs. Assert the exact diagnostic code (`threemf.limit.compression_ratio`), not just the presence of an error.

**Necessary, but not sufficient: the diagnostic must be _unique_ to the control.** If two guards emit the same code, asserting it cannot tell you which one fired. On PR #69 both `check_declared_archive_total` and `charge_decompressed` emitted `limit.total_decompressed_bytes`, so a test that asserted the code exactly still could not distinguish them — and the accumulator turned out to be the one never exercised. When two controls must share a code, the test has to make one of them structurally impossible instead (see below).

## Verify your control is reachable at all

A security control that cannot be reached is untested no matter how many tests surround it. Ask what input actually drives each guard, and whether any test truly produces it. Two instances of this, both on PR #69:

- The archive entry ceiling was structurally unreachable — a 16-bit ZIP EOCD caps at 65535 entries, below `MAX_ARCHIVE_PARTS` — so it was only exercisable by forging a ZIP64 trailer.
- The running decompression accumulator could never fire for an **honest** archive: the declared-total preflight sums _every_ entry while the accumulator counts only entries actually _read_, so declared >= charged and the preflight always wins the race. The accumulator fires only when an entry **lies** — declares small, delivers large — which is exactly the case it exists for, since declared sizes are attacker-controlled.

  That second one rests on a precondition worth naming, because deleting one line would silently invalidate it: **no entry may be read twice.** The charge per entry is `max(declared, actual)`, so a part read twice is charged twice and `charged` can exceed `declared_total` on a perfectly honest archive — which would make the accumulator reachable on honest input and this whole analysis wrong. Today it holds only because `threemf.rs:560` removes the root model part from `referenced_parts` before the second pass. When you record a structural argument, record what it depends on.

The general shape: **when two guards defend the same budget, the cheaper one usually shadows the stricter one on all honest input.** The stricter guard is then live, correct, and untested. Reaching it requires constructing input that is dishonest in precisely the way the shadowing guard trusts — and the test must _prove_ the shadowing guard could not have fired, by asserting its own threshold was never crossed. A test where both guards could plausibly have rejected proves nothing about either.

## Build corpora from properties, not spellings

A corpus assembled from example strings tests the examples, not the rule. The non-finite float corpus used `["NaN", "inf", "-inf", "Infinity", "-Infinity"]`; `1e999` contains none of those substrings yet `f32::from_str` returns `Ok(inf)`. Enforcement was correct — `is_finite()` — but nothing pinned it, so a regression to substring blocklisting would have passed the entire suite.

Include at least one case that satisfies the **property** while looking lexically ordinary: `1e999`, `1e39`, or a plain integer above `f32::MAX` (~3.4028235e38) such as `4e38` — the 3MF corpus uses a 42-digit literal. Specify such cases by **magnitude, not digit count**: `100000000000000000000000000000000000000` is 39 digits and parses to a perfectly finite `1e38`, so "a 39-digit integer" would pin nothing. Same reasoning applies to path traversal, injection, and unicode corpora — the dangerous input is the one that does not look like the examples.

## Cover the shapes an attacker picks, not the shapes you drew

For anything walking attacker-supplied structure (scene graphs, archives, XML), a single benign fixture proves almost nothing. Cover:

- cycles, and **duplicate / multi-parent references** (a diamond DAG is not a cycle and a path-local `seen` set will not catch it),
- deep chains (recursion depth), wide fan-out, and empty/missing/dangling references,
- hostile identifiers — `__proto__`, `constructor`, `prototype` as object IDs,
- structures whose _output_ size is superlinear in input size.

A 29-node diamond DAG expanded to 32,767 rows in `partTreeModel.ts` precisely because tests only covered an ancestor cycle.

## Do not let a test pin a bug

If fixture-writing reveals behavior that contradicts the issue text, do not silently encode current behavior as correct. Two legitimate options: fix it, or pin it **and flag it explicitly** for the reviewer to rule on. Pinning without flagging converts an open question into a permanent contract by accident.

## Mocks hide missing production code

Downstream tests that mock the sidecar stayed green while the entire native retarget engine was missing from `development`. If a test mocks the thing it is nominally validating, it cannot detect that the thing is gone. At least one test per integration boundary must exercise the real implementation.

## Fixtures

- Author them yourself, programmatically, from raw format primitives. Never commit vendor or third-party model data — it must be redistributable.
- Build them with a **test-local builder that shares no code with the parser under test**, otherwise a bug cancels itself out on both sides.
- Record `sha256`, byte length, provenance, and expected outcome in a manifest, and verify committed bytes match.
- Fixtures are consumed by CI on Windows and macOS/Linux: make generation deterministic and ensure binary fixtures cannot be mangled by line-ending translation.
