## 2026-07-24: Packaged smoke test must dismiss first-run onboarding

**By:** Dallas

**What:** Updated the packaged `e2e/mvp.spec.ts` smoke flow to dismiss the first-run library onboarding dialog before asserting there are zero active dialogs ahead of explicit preview open.

**Why:** The packaged E2E suite launches one fresh app instance in `beforeAll`, so the new onboarding dialog correctly appears on the same first-run empty catalog that the smoke suite exercises. The preview smoke assertion was written before onboarding existed and now needs to clear that legitimate modal state.
