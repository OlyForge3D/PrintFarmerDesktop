# Inspector Feedback — Iteration 1

## Verdict: FAIL

**Critical Issue:** `CalibrationHttpClient` and `CalibrationEngine` are fully implemented
but never instantiated or wired into the application. IPC handlers return stubs instead
of calling the real sync engine, violating acceptance criteria #3 and #6.

## Root Cause

The foundation code is comprehensive and well-tested in isolation:
- CalibrationHttpClient (1055 lines): Full token refresh, profile fencing, error handling
- CalibrationEngine (683 lines): Full sync semantics with outbox, conflicts, cursors
- All Zod schemas (1230+ lines): Comprehensive IPC contracts
- All native tables (schema.rs v12): 9 calibration tables for persistence

But **integration is missing**: No code instantiates these classes or calls them from IPC handlers.

## Acceptance Criteria Status

| # | Criterion | Status | Reason |
|----|-----------|--------|--------|
| 1 | Zod schemas | ✓ PASS | 1230+ lines comprehensive |
| 2 | Remote DTOs | ✓ PASS | Strict safety fields |
| 3 | HTTP client uses ServerProfileService | ✗ **FAIL** | Never instantiated |
| 4 | Renderer isolation | ✓ PASS | Fixed routes, no secrets |
| 5 | Model-core migration + RPC | ✓ PASS | Schema v12, 9 tables |
| 6 | Sync validates/pushes/pulls/commits | ✗ **FAIL** | Engine never called |
| 7 | SignalR optional | ✓ PASS | REST exclusive |
| 8 | Offline/photo/staging | ✓ PASS | Feature-gated stubs |
| 9 | Conflict comparisons | ✓ PASS | Full schema, gated |
| 10 | Append-only dedupe | ✓ PASS | Immutable tables |
| 11 | Narrow IPC commands | ✓ PASS | Explicit channels |
| 12 | Automated coverage | ✗ **FAIL** | Missing integration tests |
| 13 | Existing tests compatible | ✓ PASS | 905 tests pass |
| 14 | Quality gates | ✓ PASS | All pass |
| 15 | PR/commit format | ✓ PASS | Non-draft, Closes #52 |

## Critical Findings

### 1. CalibrationHttpClient Not Wired
**File:** src/main/calibrationHttp.ts (1055 lines)

```bash
$ grep -r "new CalibrationHttpClient" src/  # NO MATCHES
$ grep -r "import.*CalibrationHttpClient" src/main/ipc.ts  # NO MATCHES
```

The client implements all required features but is never used.

### 2. CalibrationEngine Not Wired
**File:** src/main/calibrationEngine.ts (683 lines)

```bash
$ grep -r "new CalibrationEngine" src/  # NO MATCHES
$ grep -r "engine.sync\|engine.push\|engine.pull" src/main/  # NO MATCHES
```

### 3. IPC Handlers Return Stubs
**File:** src/main/ipc.ts (lines 891-1160)

```typescript
ipcMain.handle(IpcChannel.CalibrationSyncNow, (...) => {
  return { phase: 'failed', error: 'not yet available' }; // STUB
});

ipcMain.handle(IpcChannel.CalibrationListPrinters, (...) => {
  return { printers: [] }; // STUB
});
```

All 18 handlers return stubs. The note at line 893 says:
> "These stubs return typed unavailable states until downstream services (#53-#56) 
> complete the feature."

But acceptance criteria require **present-tense operational behavior**, not future feature-gating.

## Why This Is FAIL

Criterion #3: "A calibration-specific main-process authenticated HTTP client **uses**
ServerProfileService.getAuthenticatedContext()" — present tense = must work now.

Criterion #6: "Synchronization **validates**...pushes...pulls...commits" — all present
tense = must work now.

These cannot be true when the HTTP client is never called and the engine is never instantiated.

## What Must Be Fixed

1. **Instantiate CalibrationHttpClient** in registerIpcHandlers()
2. **Instantiate CalibrationEngine** and pass to handlers
3. **Update all 18 handlers** to call engine (not return stubs)
4. **Add ≥50 integration tests** for end-to-end sync flow
5. **Re-run all quality gates** to verify

## What Works (Foundation Solid)

- ✓ All 905 tests pass
- ✓ All quality gates pass (typecheck, lint, format, cargo)
- ✓ Comprehensive Zod schemas with strict validation
- ✓ HTTP client implementation is complete and correct
- ✓ Engine sync semantics are complete and correct
- ✓ Native persistence tables properly designed
- ✓ Renderer isolation proven; no credential leaks
- ✓ PR properly formatted (non-draft, base development, Closes #52)
- ✓ No regression to existing Library/server-profile tests

## Recommendation

**Do not merge.** Return to Builder to wire the foundation code together.
The components exist and work in isolation; they just need to be connected.

