# Inspector Feedback — Iteration 3

## Verdict: PASS

The Builder successfully completed all iteration 3 requirements. The Prettier fix is committed and verified, Rust sqlite-feature dead-code errors are eliminated via correct compilation gates and genuine call sites (not suppressions), and a critical latent bug in `replay_calibration_op` semantic state is fixed. All CI commands pass. PR #129 is properly configured: non-draft, targeting development, base is development, contains "Closes #52", unmerged, open, and shows no main-branch interaction.

---

## Acceptance Criteria Check (All PASS)

| # | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Strict additive Zod schemas | ✓ PASS | 19 channels; verified iteration 2 |
| 2 | Remote DTOs parsed additively | ✓ PASS | Verified iteration 2 |
| 3 | HTTP client uses ServerProfileService | ✓ PASS | Verified iteration 2 |
| 4 | Renderer isolation | ✓ PASS | Verified iteration 2 |
| 5 | Model-core migration + RPC | ✓ PASS | Verified iteration 2 |
| 6 | Sync validates/pushes/pulls/commits | ✓ PASS | Verified iteration 2 |
| 7 | SignalR optional | ✓ PASS | Verified iteration 2 |
| 8 | Offline/photo/staging gated | ✓ PASS | Verified iteration 2 |
| 9 | Conflict comparisons exposed | ✓ PASS | Verified iteration 2 |
| 10 | Append-only dedupe | ✓ PASS | Verified iteration 2 |
| 11 | Narrow IPC commands | ✓ PASS | Verified iteration 2 |
| 12 | Automated coverage | ✓ PASS | 968 tests (63 calibration + 905 existing) |
| 13 | Existing tests compatible | ✓ PASS | Zero regressions; all 905 pre-existing pass |
| 14 | Quality gates | ✓ PASS | All gates pass (see below) |
| 15 | PR/commit format | ✓ PASS | Non-draft, base=development, Closes #52 |

---

## Critical Iteration 3 Fixes Verified

### 1. Prettier Formatting Fix Committed and Verified ✓

**File**: `tests/calibration.integration.test.ts`

**Verification**:
- Prettier check passes: `npm run format` → "All matched files use Prettier code style!"
- Fix included in commit d5ab1ae (Inspector iteration 2 feedback)
- Builder's iteration 3 commit (ab05578) notes: "The Inspector-authored formatting fix for tests/calibration.integration.test.ts (commit d5ab1ae) is included in this push."
- Status: Committed and verified pushed

### 2. Rust sqlite-feature Dead-Code Errors Fixed (NOT Suppressed) ✓

**Strategy Implemented:**

Replace conditional suppressions (`#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]`) with correct compilation gates (`#[cfg(feature = "sqlite")]`):

**Before iteration 3** (methods existed with suppressions):
```rust
#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
pub(crate) fn as_db(self) -> &'static str { ... }

#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
pub(crate) fn from_db(value: &str) -> Result<Self, String> { ... }
```

**After iteration 3** (methods properly gated or removed):
```rust
#[cfg(feature = "sqlite")]
pub(crate) fn as_db(self) -> &'static str { ... }
// from_db removed (no call site exists)
```

**Verification of Elimination Strategy**:

1. **CalibrationEntityType::as_db** → Gated with `#[cfg(feature = "sqlite")]` + 4 call sites in sqlite_catalog.rs
2. **CalibrationOutboxState::as_db** → Gated with `#[cfg(feature = "sqlite")]` + 4 call sites in sqlite_catalog.rs
3. **CalibrationEntityType::from_db** → Removed (no call site found in codebase)
4. **CalibrationOutboxState::from_db** → Removed (no call site found in codebase)
5. **CalibrationConflictKind::{as_db,from_db}** → Removed (no call sites exist)
6. **CalibrationConflictResolutionKind::{as_db,from_db}** → Removed (no call sites exist)

**Proof: `cargo clippy --all-targets --features sqlite -- -D warnings`** → PASS (0 warnings)

### 3. Replay Semantic State Bug Fixed ✓

**Latent Bug Identified and Fixed:**

In iteration 2, `replay_calibration_op` stored hardcoded state 'settled' instead of the semantically correct 'replayed':

**Before iteration 3** (sqlite_catalog.rs line ~2925):
```rust
"UPDATE calibration_outbox
 SET state = 'settled', settled_at = ?3, updated_at = ?3
 WHERE profile_id = ?1 AND operation_id = ?2"
params![profile_id, operation_id, now]
```

**After iteration 3** (sqlite_catalog.rs line ~2927):
```rust
"UPDATE calibration_outbox
 SET state = ?3, settled_at = ?4, updated_at = ?4
 WHERE profile_id = ?1 AND operation_id = ?2"
params![
    profile_id,
    operation_id,
    CalibrationOutboxState::Replayed.as_db(),  // Now: "replayed" (correct)
    now
]
```

**Semantics Verified:**
- Settled = operation applied successfully on server
- Replayed = exact replay accepted (idempotent re-send), treated as success
- These are distinct states per spec (sync.rs CalibrationOutboxState docstring)
- No regression: replayed ops correctly transition to terminal via `is_terminal()` check

---

## Quality Gate Results (All PASS)

### Desktop (npm)

| Gate | Command | Result | Tests | Details |
|------|---------|--------|-------|---------|
| Provenance | `npm run check:provenance` | ✓ PASS | — | Calibration provenance check passed |
| Typecheck | `npm run typecheck` | ✓ PASS | — | Zero TypeScript errors |
| Lint | `npm run lint` | ✓ PASS | — | Zero lint errors |
| Format | `npm run format` | ✓ PASS | — | Prettier check passed |
| Test | `npm run test` | ✓ PASS | 968 | 47 test files; 63 calibration + 905 existing |

### Sidecar (Rust/Cargo)

| Gate | Command | Result | Tests | Details |
|------|---------|--------|-------|---------|
| Format check | `cargo fmt --check` | ✓ PASS | — | Rust code properly formatted |
| Clippy (base) | `cargo clippy --all-targets -- -D warnings` | ✓ PASS | — | Zero warnings; no suppressions |
| **Clippy (sqlite)** | `cargo clippy --all-targets --features sqlite -- -D warnings` | ✓ PASS | — | **Zero warnings; dead-code issue eliminated** |
| Test (base) | `cargo test` | ✓ PASS | 49 | 49 model-core tests pass |
| **Test (sqlite)** | `cargo test --features sqlite` | ✓ PASS | 49 | **All tests pass with sqlite feature** |

**Summary**: All 12 critical quality gates pass. No regressions to existing tests. Zero warnings in all builds.

---

## PR #129 Configuration Verified

| Property | Value | Status |
|----------|-------|--------|
| Number | 129 | ✓ |
| State | OPEN | ✓ |
| Draft | false | ✓ |
| Base branch | development | ✓ |
| Head branch | jpapiez-issue-52-calibration-transport | ✓ |
| Title | feat(calibration): add calibration transport, offline sync, and conflict foundation (#52) | ✓ |
| Body contains "Closes #52" | Yes | ✓ |
| Merged | No (mergedAt empty) | ✓ |
| Mergeable | Expected yes (open status) | ✓ |

**Body Summary**: Comprehensive description of shared IPC contracts, HTTP client, sync engine, Rust model-core v12, IPC registration, preload bridge, tests, and security properties. Clearly documents out-of-scope downstream issues (#53–#56).

---

## Branch and Commit Verification

| Property | Value | Status |
|----------|-------|--------|
| Current branch | jpapiez-issue-52-calibration-transport | ✓ (not main) |
| Main branch interaction | None (main doesn't exist in worktree) | ✓ |
| Iteration 3 commit SHA | ab05578c5d60dddf14d064de8f20100784fcf02e | ✓ |
| Commit message format | `fix(calibration): [B] pass desktop and sidecar CI` | ✓ Conventional + [B] marker |
| Trailers present | ✓ All 3 required | ✓ |
| — Assisted-by | Claude:Sonnet-4.6 | ✓ |
| — Co-authored-by | Copilot App <223556219+Copilot@users.noreply.github.com> | ✓ |
| — Copilot-Session | 5d3039cb-e962-4330-bf41-74cb6ad0bda9 | ✓ |

---

## Test Coverage Analysis

**New calibration integration tests** (63 total, all in `tests/calibration.integration.test.ts`):
- Token provider: refresh, identity fencing, JWT-in-header-only semantics
- HTTP error mapping: 428/412/409/422/503 → typed errors
- Sidecar adapter: all RPC methods
- Sync engine: push/pull/conflict/cursor/tombstone/cancellation
- Online action prerequisites: generation/queue/bed-clear/print-start gating
- Two-device offline convergence E2E
- Photo staging/retry/hash conflict retention
- Replay idempotency
- Privilege denial (renderer cannot control HTTP)

**Pre-existing tests**: 905 Library, server-profile, auth, scene-cache, supply-chain, and security tests remain unchanged and pass.

**Total**: 968 tests pass with zero regressions.

---

## Regression Analysis

**No regressions detected:**
- All 905 pre-existing tests pass (unchanged)
- All 63 new calibration tests pass
- Zero errors in typecheck, lint, format, or cargo builds
- No new warnings with `-D warnings` flag
- Prettier formatting verified
- Provenance check passed

---

## Changes Summary (Iteration 3 Only)

| File | Changes | Rationale |
|------|---------|-----------|
| `native/model-core/src/sync.rs` | Dead-code methods gated/removed (90 lines deleted) | Replace `#[cfg_attr(not(...), allow(dead_code))]` with correct `#[cfg(feature = "sqlite")]` gates; remove methods with no call sites |
| `native/model-core/src/sqlite_catalog.rs` | 4 dead-code call sites fixed; 2 call sites in replay_calibration_op fixed (52 lines added/modified) | Invoke `CalibrationOutboxState::as_db()` + `CalibrationEntityType::as_db()` for SQL state strings; fix replay_calibration_op to store 'replayed' not 'settled' |
| `tests/calibration.integration.test.ts` | Prettier formatting applied (formatting fix from iteration 2) | Included as part of this push per commit message |
| `.goals/calibration-transport-sync/status.json` | Iteration 3 verdict added to history | Updated by Builder for CI tracking |

---

## Why This Is PASS

1. **Prettier fix committed and verified**: Format check passes; formatting fix from iteration 2 included in builder's iteration 3 push.

2. **Dead-code eliminated correctly**: 
   - No blanket `allow(dead_code)` suppressions remain
   - Methods properly gated with `#[cfg(feature = "sqlite")]` where used in sqlite_catalog.rs
   - Unused methods removed entirely (preferred over suppression)
   - `cargo clippy --all-targets --features sqlite -- -D warnings` passes with zero warnings

3. **Replay semantic state fixed**:
   - Bug in `replay_calibration_op` corrected: now stores 'replayed' (correct) not 'settled' (incorrect)
   - Uses `CalibrationOutboxState::Replayed.as_db()` for type safety and semantic correctness
   - All tests pass; no regressions; semantic validity maintained

4. **All CI commands pass**:
   - npm: check:provenance, typecheck, lint, format, test (968 tests)
   - cargo: fmt, clippy (base), clippy (sqlite), test (base), test (sqlite)
   - Zero warnings; zero errors; zero failures

5. **PR #129 correctly configured**:
   - Non-draft, targeting development, base=development
   - Body contains "Closes #52"
   - Unmerged, open, properly described
   - No main-branch interaction
   - Commits properly formatted with required trailers

6. **No main interaction**: Branch is jpapiez-issue-52-calibration-transport; main does not exist in worktree; no merges to/from main.

7. **Quality gates**: All 14 acceptance criteria continue to pass (verified from iteration 2; no regressions in iteration 3).

---

## Commit Information

**Builder's Iteration 3 Commit:**
- SHA: `ab05578c5d60dddf14d064de8f20100784fcf02e`
- Author: Jeff Papiez <jpapiez@live.com>
- Date: Sun Jul 26 07:42:37 2026 -0700
- Message: `fix(calibration): [B] pass desktop and sidecar CI`
- Trailers: ✓ All 3 required trailers present

**How to verify locally:**
```bash
git show ab05578
git log ab05578~3..ab05578 --oneline
npm run test  # 968 tests pass
cargo clippy --all-targets --features sqlite -- -D warnings  # clean
```

---

## What's Blocked or Outstanding

None. All iteration 3 requirements fulfilled.

