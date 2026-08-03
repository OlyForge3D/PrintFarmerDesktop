<!-- Fact Checker's append-only evidence ledger. Entries are succinct — verdict + citation only, no raw source material. -->

## 2026-07-23: Squad Initialization

- **Checked:** n/a — initialization only, no claims to verify.
- **Verdict:** n/a

## 2026-08-03: First run of the Cross-Artifact Symmetric Diff (#121)

Five runs of the symmetric diff introduced in `.squad/fact-checker/policy.md` → **Cross-Artifact Symmetric Diff**. Runs A–C are re-runs at historical heads, to show the corrected check fires in both directions where the one-directional form fired in only one. Runs D–E are at `fc9799fab84f7a1ee2acb1cb919af8195d926a8b`. Full transcripts are in the PR that closes #121; entries here are verdict + citation per this file's succinctness rule.

- **A — sidecar mesh-object ceiling, at `2d5f47e`.** `.squad/decisions.md` renders the documented ceiling as `5,001`; `.squad/skills/test-discipline/SKILL.md` renders it as `5,000`. **Verdict: ❌ Contradicted, against the pair.** The decision log is the wrong rendering, which is the direction the one-directional form could not reach.
- **B — diamond-DAG row count, at `a08de19`.** `.squad/decisions.md` carries `49,150`; `.squad/skills/test-discipline/SKILL.md` carries `32,767`. **Verdict: ❌ Contradicted, against the pair.** Closed for that pair by `dc034d8`.
- **C — sidecar mesh-object ceiling, at `65345ba`.** The two renderings agree, and both are wrong. `65345ba` is one commit writing both files, so the pair is **dependent** and the clean result is a false negative. **Verdict: ⚠️ Unverified — not ✅.** Dependence measured in `.squad/decisions.md` → _2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own review found_.
- **D — diamond-DAG row count, at `fc9799f`. Live finding.** Three renderings, not two: `.squad/decisions.md` and `.squad/skills/test-discipline/SKILL.md` carry `49,150`; `docs/security/THREAT_MODEL.md` § _T2.2 — Structurally valid input that reaches an untested code path (A1)_ still carried `32,767 rows`. `dc034d8` repaired one rendering and left the third. **Verdict: ❌ Contradicted, against the set.** Discharged in the PR closing #121 by repairing the threat model, per the discharge rule — a filed-only response would have left both readers with a defect.
- **E — part-tree row budget, at `fc9799f`. Negative control.** Three renderings agree at `20,000`: `src/renderer/library/partTreeModel.ts` (`MAX_PART_TREE_ROWS`, introduced `5eef0d7`), `docs/scene-contract.md` (introduced `ecb2ee5`), `.squad/decisions.md` (introduced `f1e1bb0`) — three commits, three PRs, so the set is **independent**. **Verdict: ✅ Verified.** Run D is this run's discriminating control: the same instrument on the same heads returns a disagreement, so a clean result here is a finding of agreement rather than a rule that finds nothing.
- **Slot note (policy step 5).** `docs/scene-contract.md` also carries `20,000` as a _triangle_ threshold for proxy substitution. Same token, different slot; excluded from run E rather than counted as a fourth agreeing rendering.
