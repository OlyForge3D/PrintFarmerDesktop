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

## Assert the specific failure, not merely that something failed

`assert!(result.is_err())` passes when an unrelated earlier failure occurs, so it can pass while the control you meant to test never runs. Assert the exact diagnostic code (`threemf.limit.compression_ratio`), not just the presence of an error.

## Verify your control is reachable at all

A security control that cannot be reached is untested no matter how many tests surround it. On PR #69 the archive entry ceiling was structurally unreachable — a 16-bit ZIP EOCD caps at 65535 entries, below `MAX_ARCHIVE_PARTS` — so it was only exercisable by forging a ZIP64 trailer. Ask what input actually drives each guard, and whether any test truly produces it.

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
