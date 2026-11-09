# Renderer coverage and temporary screenshot evidence

**Policy:** screenshots are temporary review artifacts only. This proposal adds
no committed PNG baselines, golden-approval requirement or blocking pixel-diff
comparison. Behavior, layout, DOM and automated accessibility assertions remain
enforced. Pixel-diff regression detection is intentionally not provided.

`coverage-manifest.json` is the authoritative catalog. Its schema version 2
preserves the Layer 1 inventory from
`843b0b2f98027fe4d60caf9c0001ec6026f34003`, then adds individually executable
renderer states. Structural workspace/dialog/phase/method/native counts overlap;
they must not be added into a coverage denominator. No Cartesian product is
implied.

The reconciled catalog has **35 surfaces, 404 named rows and 331 candidate
scenarios**:

| Row status       | Count | Meaning                                                                              |
| ---------------- | ----: | ------------------------------------------------------------------------------------ |
| `scenario`       |   331 | Owns one stable capture ID and explicit assertions                                   |
| `scenario-group` |    45 | Original composite row referencing executable scenario IDs; creates no extra capture |
| `blocked-native` |    16 | Native/platform behavior or real device interaction outside this safe renderer layer |
| `not-rendered`   |     6 | Absent feature, unreachable forced state or non-renderer tooling                     |
| `unit-test`      |     1 | Static design detector, which has no rendered interface                              |
| `retired`        |     4 | Legacy/non-live surfaces, not active coverage                                        |
| `external`       |     1 | Destination outside this app                                                         |
| `unverified`     |     0 | No remaining generic unmapped live-renderer row                                      |

Zero `unverified` rows is a classification statement, **not** a completeness,
accessibility or visual-pass certificate. Native limits and real failures remain
explicit. The two former card/upload golden-review rows now reference their
existing scenario evidence; neither requires a golden image. Every one of the
331 scenario IDs has a current Windows PNG/metadata pair as of 2026-11-09.
The audit checked actual image/environment digests, metadata/index/state mapping
and current manifest assertion scope, with an altered-digest negative control.
All 586 previously captured images were preserved byte-for-byte; the archive now
contains 653 image/environment pairs. Capture alone does not establish an axe
pass: capture precedes some scans so failures retain reviewable evidence.
All 331 scenarios use `screenshotPolicy: "temporary-review-evidence"`.

## What executes

Scenarios run production Electron renderer bundles with isolated catalog/user
data. Fixtures use checked-in synthetic models or typed synthetic IPC replies
validated against `src/shared/ipc.ts`. The reply sequencer can hold requests
pending, return schema-valid values, or throw explicit errors. It replaces
main-process handlers rather than injecting a new renderer API. No real printer,
production account, credential, source-file mutation or actual profile write is
used.

The finite named dimensions include:

- Shell route/selection retention, default route after reload, global modal
  exclusion, onboarding preparation/error/dismissal, import rules and warnings,
  pending/error/retry/cancel/incomplete-result refusal, and cache picker/save/
  clear handoffs.
- Library loading/error/empty/populated/pagination, sidebar filters and bounded
  resizing, source scan and missing/offline health, cards/thumbnails,
  tag/collection editors, organization CRUD/review, upload lifecycle and server
  profile forms.
- Preview loading/error/retry, shading/projection, absent/unknown/populated vendor
  data, default/per-face materials, actual multi-scene plate selection, deep and
  malformed part trees, inherited visibility and isolated roving keyboard focus.
- Retarget catalog/import/preflight/build/scene/save pending and explicit/thrown
  failures, blockers, warnings/proposed changes, cancellation/collision/retry,
  explicit profile selection, refresh warnings and one-canvas Source/Output
  switching.
- Calibration provider recovery, printer/profile/dependency/spool alternatives,
  clone boundaries, all eight method purpose/setup screens, input/disposition
  boundaries, draft handoff choices, slicing/polling outcomes, start confirmation
  and unreachable refusal, scalar/temperature measurements, writeback and sync
  failures, completion/promotion confirmation, restart clear-before-delete and
  clean remount, and conflict editing/resolution boundaries.

Composite inventory rows reference these specific scenarios through
`coverage.scenarioIds`. They do not claim a new screenshot or every combination
of method, phase, theme, platform and error. The validator rejects missing,
duplicate or empty group references and prevents groups from impersonating
single capture rows.

An additional typed-error regression exercises `OperatorRecoveryRequired` in
the filament wizard without adding another inventory capture ID. It preserves
the server's durable enum meaning: dispatch stays blocked until an operator
deliberately clears the block in PrintFarmer or cancels the job. It verifies
operator copy and reference visibility, not live server recovery or printer
behavior; `MapBlockedReason` still has no corresponding dispatch wire token.

### Deliberate evidence boundaries

The WebGL-unavailable fixture makes WebGL/WebGL2 `getContext` return null before
navigation. It verifies production constructor-refusal feedback, not an actual
driver failure. The context-loss scenario dispatches DOM events to production
listeners, not GPU loss/recovery.

Dense grids with 149,058 and 150,152 triangles exercise both sides of the actual
150,000-triangle scene LOD floor, including the rendered proxy-built notice.
This does not claim that the proxy is selected at initial framing. In a separate
within-run check, keyboard orbit changes canvas PNG bytes and Reset view restores
the exact original bytes; this is not a portable GPU golden.

The actual part-tree budget fixture renders 20,000 rows plus one truncation
diagnostic and asserts both counts. **Full-page axe exceeded 240 seconds on this
DOM. Only the visible truncation diagnostic receives axe in that scenario.**
The manifest records this restricted scope; it is not counted as a full-page
axe pass.

Conflict fixtures exercise editable key/value limits, the 21-field cap, and
nested/array refusal. The typed summary itself is limited to 4,096 JSON
characters; JSON overhead prevents constructing an editable scalar over 4,096
characters through that live path. Tests do not bypass the boundary to
manufacture an unreachable internal branch.

Dashboard is the only live calibration subnav entry. Legacy project/flush APIs
still in the store are not independently rendered routes. Similarly, unused
`.cal-dashboard-layout` and `.cal-form-grid` CSS selectors are not live wizard
screens. Compact tests assert the actual header stacking instead.

## Rendering profiles

The default profile is 1440x900 CSS pixels, device scale factor 1, `en-US`, UTC,
dark preference and reduced motion. Chromium CDP records actual platform fonts
used by each candidate. Fonts are not bundled, so Windows/macOS images and
font changes may look different. Fingerprints explain those differences; they
are not an approval/comparison gate.

Additional profiles independently fingerprint:

| CSS viewport | Scope                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| 1120x700     | Minimum-window renderer proxy, compact rail/dialogs, runtime sidebar cap |
| 720x450      | 200% magnification proxy relative to 1440x900, long paths/details        |
| 680x450      | Actual compact calibration header breakpoint                             |

Viewport proxies are not native OS/browser zoom. GPU/compositor, native chrome,
pickers/installers, forced colors and mixed-monitor DPI are not pinned or
certified. The sidebar fixture asserts min 200/max 480, persistence, the actual
640px model-pane stacking threshold and a usable 320px model-list floor under
runtime clamping.

## Running and reviewing candidates

The release accessibility entry point imports `calibrationA11yTests.ts`:

```powershell
npx playwright test release.accessibility.spec.ts
```

For the complete manifest candidate suites, use basename selectors (Windows
backslashes are regex escapes in Playwright file selectors):

```powershell
npx playwright test authority-bar-actions.spec.ts calibration-state-coverage.spec.ts collection-management.spec.ts details-state-coverage.spec.ts import-cancellation-coverage.spec.ts inventoried-rendered-states.spec.ts library-pagination-busy.spec.ts library-state-coverage.spec.ts metadata-error-coverage.spec.ts organization-state-coverage.spec.ts release.accessibility.spec.ts retarget-state-coverage.spec.ts retarget.spec.ts shell-import-state-coverage.spec.ts source-scan-coverage.spec.ts status-notice.spec.ts thumbnail-cache-confirmation.spec.ts
```

Manifest and archive contract tests:

```powershell
npx vitest run tests/uiCoverageManifest.test.ts tests/visualCandidateArchive.test.ts
```

Candidates attach to Playwright results and also write to
`test-results/visual-candidates/<platform>-<scenario-id>.{png,json}`.
Playwright clears `test-results` before each run. A second, git-ignored,
content-addressed evidence directory survives that lifecycle:

```text
artifacts/ui-coverage-review/<platform>/<scenario-id>/<image-sha256>-<environment-sha256>.png
artifacts/ui-coverage-review/<platform>/<scenario-id>/<image-sha256>-<environment-sha256>.json
artifacts/ui-coverage-review/index.json
```

The evidence index maps images to named inventory states, triggers, expected
states, exercised dimensions and the temporary-artifact policy. Per-candidate JSON
records image/environment digests, actual platform-font identities, rendering
profile and fixture/axe scope. No baseline paths or approval records are generated.
Older environment/image pairs are
retained, not silently replaced. Recapturing the identical image/environment
pair refreshes its companion metadata atomically so the index and JSON describe
the same current assertion scope.

Material axe findings also persist as content-addressed JSON under
`artifacts/ui-coverage-review/findings/<node-platform>/`, rather than existing
only as reporter attachments that the next Playwright run can erase.

Both directories are ignored temporary local/CI artifacts, not versioned product
assets or a permanent external archive. Current captures are deliberately
preserved during handoff. CI may retain its normal artifacts for its configured
retention period; this proposal adds no external service or CI approval job.
Legacy JSON companions from earlier captures can still contain the former
approval fields; they are historical data, ignored by the current harness.

### Contrast regressions and retained findings

Earlier configured Sources scans reported primary text at 2.76:1 (`#0c1319`
on `#385f7d`) and refresh text at 4.1:1 (`#777b7f` on `#151a20`). Those
historical candidates remain **not passing axe evidence**, even though current
rebuilt packaged Sources/reset checks now pass. The typed Sources fixture also
explicitly checks enabled primary/refresh actions and scans both hover states.
The primary action retains its accent background on hover instead of inheriting
the generic dark hover background.

The combined new-state run also found the import-error **Dismiss** button at
4.37:1 (`#e6e9ed` on `#6b6b6b`, 13px normal text), below 4.5:1. The error-retry
scenario explicitly hovers that button before capture/scan. Import error actions
now share the explicit dark-theme alert-action styling rather than relying on
the native gray button background. The same hovered scenario passes after
rebuilding the production bundle. The old raw finding is retained, not waived or
rewritten as a pass.

Scanners verify a deliberate unnamed-button probe before material checks; soft
assertions retain all findings while still failing the test. Manifest/archive
contract tests, TypeScript, repository lint and formatting passed. The earlier
full unit run had one unrelated
`OperatorRecoveryRequired` enum-drift failure in
`tests/calibration.jobBlockedReasonCode.test.ts`; it is not silently relabeled as
a passing full suite.

After the contrast fixes and a successful production/package rebuild
(`npm run pretest:e2e`), the final artifact-only implementation passed
**126 tests across all 17 manifest suites**, using the complete command above.
The removed approval flag was deliberately set during the run:

```powershell
$env:PRINTFARMER_REQUIRE_APPROVED_VISUAL_BASELINES = '1'
# Run the complete 17-suite command above; this obsolete flag has no effect.
```

The current manifest/archive contract command passed **12 tests**. The earlier
related App/manifest/archive unit run passed 46 tests with one pre-existing skip.
`npm run typecheck`, `npm run lint` and `npm run format` also passed.
`artifacts/ui-coverage-review/verification.json` records the current 331-scenario
evidence audit and preservation results. This does not change the explicitly
restricted truncation scan or native-platform limits.

### Reviewing images without a gate

Open `artifacts/ui-coverage-review/windows/` in Explorer and browse the
scenario-ID folders as thumbnails or open the PNGs in an image viewer. Open the
same-stem JSON alongside an image for its environment, fixture, trigger and
expected state. `index.json` provides relative image/metadata paths and
`coverage-manifest.json` links the scenario to its test file and asserted scope.

There is no approval file, review status to satisfy or required baseline-copy
step. Record actionable findings in the ordinary issue/code-review workflow if
desired; do not copy these PNGs into tracked snapshot directories.
Changing an image between runs does not fail a pixel comparison. Existing
unrelated screenshot tests and snapshot configuration are not changed by this
policy; the within-run viewer orbit/reset behavior assertion also remains.

## Limits and interpretation

Native picker/menu/About/installer/Finder behavior, actual zoom/forced colors,
mixed-monitor transitions and real GPU resets require platform observation.
Real printer dispatch/profile writes are prohibited for this test layer.
Absent light theme, absent token-policy parser and unreachable concurrent modal
state are not gaps that can honestly be filled with a screenshot.

`sourceDriftSinceInventory` retains the 12 paths changed after the Layer 1
snapshot; that snapshot is provenance, not runtime proof. New scenario references
identify the executed production-bundle evidence. Static detector tests, retired
nine-stage calibration, skipped legacy suites and orphaned CSS never inflate
the runtime denominator.

**Falsifier:** a missing archive ID, a fixture that fails to reach its asserted
state, a material axe failure or mismatched environment invalidates the
corresponding claim. **Who could be harmed:** operators relying on inaccessible
controls or misleading coverage reports. **If wrong:** false confidence could
ship blocked workflows or unsafe calibration assumptions. Keeping screenshots
non-authoritative, real dispatch disabled and failure/scope records explicit makes this
evidence reversible; it is not WCAG conformance or disability-usability testing.
