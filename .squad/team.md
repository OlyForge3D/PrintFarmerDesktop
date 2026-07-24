# Squad Team

> PrintFarmer Desktop — local-first Electron/React 3D model library integrated with PrintFarmer

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. Does not generate domain artifacts. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| 🏗️ Ripley | Lead / Architecture | .squad/agents/ripley/charter.md | Active |
| ⚛️ Dallas | React/Electron UI | .squad/agents/dallas/charter.md | Active |
| 🔧 Bishop | Rust, SQLite, Integration | .squad/agents/bishop/charter.md | Active |
| 🧪 Hicks | QA & Contract Testing | .squad/agents/hicks/charter.md | Active |
| 🛡️ Vasquez | Security & Concurrency Review | .squad/agents/vasquez/charter.md | Active |
| 📋 Scribe | Session Logger | .squad/agents/scribe/charter.md | Active |
| 🔄 Ralph | Work Monitor | — | Active |
| 🛡️ Rai | RAI Reviewer | .squad/agents/rai/charter.md | Active |
| 🔍 Fact Checker | Fact Checker / Devil's Advocate | .squad/agents/fact-checker/charter.md | Active |

## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Bug fixes with clear reproduction steps
- Test coverage (adding missing tests, fixing flaky tests)
- Lint/format fixes and code style cleanup
- Dependency updates and version bumps
- Small isolated features with clear specs
- Boilerplate/scaffolding generation
- Documentation fixes and README updates

**🟡 Needs review — route to @copilot but flag for squad member PR review:**
- Medium features with clear specs and acceptance criteria
- Refactoring with existing test coverage
- API endpoint additions following established patterns
- Migration scripts with well-defined schemas

**🔴 Not suitable — route to squad member instead:**
- Architecture decisions and system design
- Multi-system integration requiring coordination
- Ambiguous requirements needing clarification
- Security-critical changes (auth, encryption, access control)
- Performance-critical paths requiring benchmarking
- Changes requiring cross-team discussion

## Project Context

- **Owner:** Jeff Papiez
- **Project:** PrintFarmer Desktop — a local-first desktop application providing a 3D model library and viewer, tightly integrated with the PrintFarmer platform (printer farm management).
- **Stack:** Electron + React + TypeScript + Three.js (renderer/UI), Rust + SQLite (`native/model-core`, integration/backend), Vite, Vitest, Playwright, ESLint/Prettier.
- **Team Root:** `.squad/` — local to this repo.
- **State Backend:** `local`
- **Created:** 2026-07-23

## Repos

| Repository | GitHub Repo | Primary Language | Domain |
|------|-----------|-----------------|--------|
| PrintFarmerDesktop | `OlyForge3D/PrintFarmerDesktop` | TypeScript (Electron/React) + Rust | Desktop 3D model library/viewer, native Rust/SQLite model-core, PrintFarmer integration |
| PrintFarmer | `OlyForge3D/PrintFarmer` | C# .NET + React TypeScript | Backend API, React dashboard, slicer workers this desktop app integrates with |

## Active Issues

Tracked in `OlyForge3D/PrintFarmerDesktop`:

- #24
- #25
- #26
- #27
- #28

## Issue Source

- **Repo:** `OlyForge3D/PrintFarmerDesktop`
