# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture & scope | Ripley | System design, module boundaries, PrintFarmer integration contracts, cross-cutting decisions |
| React/Electron UI | Dallas | Renderer components, Three.js viewer, Electron main/preload wiring, IPC surfaces, UI state |
| Rust / SQLite / integration | Bishop | `native/model-core`, SQLite schema & queries, Rust↔Electron bridge, PrintFarmer API integration |
| Testing & contracts | Hicks | Vitest unit tests, Playwright e2e, IPC/API contract tests, edge cases, regression coverage |
| Security & concurrency | Vasquez | Electron sandboxing, IPC trust boundaries, SQLite concurrency/locking, dependency/security review |
| Code review | Ripley | Review PRs, check quality, suggest improvements |
| Testing | Hicks | Write tests, find edge cases, verify fixes |
| Scope & priorities | Ripley | What to build next, trade-offs, decisions |
| Session logging | Scribe | Automatic — never needs routing |
| RAI review | Rai | Content safety, bias checks, credential detection, ethical review |
| Verification / devil's advocate | Fact Checker | Claim verification, hallucination checks, pre-mortem / counter-arguments |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Ripley (Lead) |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, **Ripley** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Ripley's review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn Hicks to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. Ripley handles all `squad` (base label) triage.
8. **Rust/UI boundary crossings** (IPC contracts, native bridge changes) route through both Dallas and Bishop with Vasquez reviewing concurrency/security implications.
