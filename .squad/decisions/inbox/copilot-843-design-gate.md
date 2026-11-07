# 2026-11-07: Automatic design gate (#843)

**Decision:** UI changes get design review without anyone asking for it.

- `scripts/design-surface.mjs` is the one definition of "design surface" (renderer markup/styles, root `index.html`) and "design governance" (`DESIGN.md`, `PRODUCT.md`, `.impeccable/`, `tools/impeccable-detector/`). The CI scan, the agent hook, and the verdict gate all import it.
- **Deterministic layer:** `.github/workflows/design-detector.yml` (`Design detector`) runs the vendored impeccable detector on changed design-surface files and fails on non-advisory findings. The detector is vendored (Apache-2.0, skill v4.0.3) rather than installed from npm because the npm package is a shim that downloads a native binary; `manifest.json` pins every file by SHA-256 and the runner refuses to run a modified copy.
- **In-loop feedback:** `.github/hooks/impeccable.json` runs `scripts/design-detector-hook.mjs` after agent edits and injects findings into context. Never blocks (always exits 0).
- **Judgment layer:** new squad member **Lambert** (Design Review, Alien). `squad/pre-pr-verdict` requires a `lambert` APPROVE at the head SHA on top of the normal count for design-surface PRs; Lambert is not a panel substitute, and a Lambert-authored UI PR needs the owner. Self-attested, like every squad record.
- **Shaping:** Ralph's author brief runs impeccable `shape` before building UI.

**Not done here (manual, owner):** making `Design detector` a required status check in branch protection. The workflow subscribes to `merge_group` and is classified `# merge-queue: reports`, so it is eligible.
