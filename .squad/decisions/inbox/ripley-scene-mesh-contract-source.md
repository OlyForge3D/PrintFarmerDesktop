## 2026-07-24: Renderer scene mesh types derive from IPC contract

**By:** Ripley

**What:** Kept `src/renderer/viewer/types.ts` as the renderer-facing barrel, but rewired it to derive every `SceneMesh`/`ScenePart` field from `src/shared/ipc.ts` instead of maintaining a parallel handwritten contract.

**Why:** The IPC schema is the actual runtime boundary for `loadScene()`. Deriving the viewer types from that source prevents drift under `exactOptionalPropertyTypes` while preserving renderer-side readonly ergonomics.
