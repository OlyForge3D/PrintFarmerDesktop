# Fact Checker — Recent Sessions

Fact Checker is the verification / devil's advocate agent for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). `.squad/fact-checker/policy.md` and `.squad/fact-checker/audit-trail.md` seeded. No claims verified yet — infrastructure only.

## 2026-08-21: "calibration print → mock printer" reachability

Investigated a "not implemented on server" claim after a prior consequential
misread by another agent this session. Verdict: (c) MIXED — the queue,
bed-clear ack, and dispatch chain are fully implemented in
`OlyForge3D/PrintFarmer@6cf79dee`; only the split-mode routing adapter for the
calibration _generation_ capability probe is unimplemented. The claim as
written was ❌ CONTRADICTED; a narrower, honest form of it (generation is
unroutable in `DEPLOYMENT_MODE=microservices`) is ✅ VERIFIED.

Decision written to `decisions/inbox/fact-checker-calibration-reachability.md`.

## Learnings

- **The DTO-default = "off" pattern is repo-native and easy to misread.** The
  five `*Enabled`/`*Implemented` calibration flags return `false` on the wire
  because the DTO defaults are `false` and only two of the record's members
  are assigned in `CalibrationCapabilityService.cs:224-228`. A flag reading
  `false` in that shape is not a probe result. Control I now use: grep for
  `<FieldName>\s*=` across the whole src/ tree, and prove the search would
  find the assignment by also grepping for a sibling field known to be
  assigned. If a sibling is found and the target isn't, the target is a
  default, not a probe.
- **`405 Method Not Allowed` on OPTIONS is a positive existence signal.** For a
  route that doesn't exist, ASP.NET returns `404`. This is a cheaper existence
  check than probing with the correct verb and body.
- **A live 422 from a saga is proof the saga is wired up**, even if the caller
  intended to probe a later 503 branch. Bishop reported "503 after seeding";
  my probe with an unseeded dummy hit `422 method_unsupported` at the binder,
  which sits before the 503 branch. Two adjacent live responses corroborated
  the same saga's presence.
- **The desktop's `calibrationActionGate.ts` is the source of truth for which
  wire flags actually block a user action.** For the calibration workflow,
  `startPrint` and `acknowledgeBedClear` do not consult any of the five "off"
  flags; only `generate` does, via `calibrationGenerationEnabled`. Do not read
  the wire's shape as the desktop's contract — read `calibrationActionGate.ts`.
- **`known-lying-commands.md` row shape recognised in the wild.** The chain
  "capability doc shows `queueIntegrationImplemented: false` → agent
  concludes 'queue integration missing' → coordinator accepts" is a fresh
  instance of the file's core defect: the flag answers a **neighbouring**
  question ("has the DTO been taught to advertise this yet?") not the one
  asked ("does this code path exist and function?"). The reassuring reading
  is the one that lets the reader stop looking; the harder reading (grep the
  actual service, hit the actual endpoint) reveals the code was there all
  along. Recording this here in case a future session re-encounters the
  same wire.
