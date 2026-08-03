# Release validation

PrintFarmer Desktop supports Windows and macOS. The release regression suites
exercise the packaged Electron executable on both GitHub-hosted runner
platforms, including the production preload boundary, Rust sidecar, renderer,
and package resources.

## Packaged application coverage

The required pull-request package matrix runs on `windows-latest` and
`macos-latest`. Together, its packaged Playwright specs exercise:

- onboarding and folder scan/import through the production dialog, IPC, and
  sidecar boundaries;
- the populated catalog and real 256x256 thumbnail decode;
- an explicit 3D viewer launch, WebGL2 render, orbit, reset, and keyboard
  interaction;
- app restart with the same user-data/catalog paths, catalog recovery, and
  cleanup of stale temporary workflow artifacts; and
- material WCAG A/AA checks over onboarding, import review, the populated
  library, and the live viewer.

The package is built once per runner before those specs execute. The tests do
not substitute renderer or sidecar mocks for the packaged integration
boundaries.

## Graphics matrix

The viewer requires WebGL2. Pull-request package CI runs the same real model
scene and interaction in two deterministic modes. Physical release
qualification adds a third, manual-only tier:

| Tier                          | Requirement                                                                                                                                                                                                | What the result proves                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Host default (required CI)    | A WebGL2 context is created, renderer/vendor details are reported, a model renders, orbit changes the image, and reset restores it.                                                                        | The packaged viewer works with the graphics capability selected by Chromium on that hosted runner. The renderer can be hardware or software. |
| SwiftShader (required CI)     | Chromium is launched with the explicit ANGLE SwiftShader fallback, the reported renderer must identify SwiftShader, and the same scene interaction passes.                                                 | The documented software fallback remains usable when hardware acceleration is unavailable.                                                   |
| Physical GPU (release opt-in) | The packaged host-default scenario runs in a logged-in graphical session, rejects software/virtual renderers, matches WebGL and system inventory to the committed profile, and emits same-commit evidence. | A named release candidate passed on the required physical OS/architecture/vendor matrix with traceable adapter and driver/Metal information. |

GitHub-hosted runner labels do not guarantee physical GPU passthrough. A
passing host-default job must not be recorded as physical-GPU qualification.
The physical matrix is therefore a `workflow_dispatch` gate rather than a
pull-request gate.

### Required physical profiles

`scripts/release-gpu-matrix.json` is the source of truth. Each self-hosted
runner needs the standard GitHub labels plus the two custom labels shown here:

| Profile              | Physical host                        | Required runner labels                                       |
| -------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `windows-x64-nvidia` | Windows x64 with NVIDIA GPU          | `self-hosted`, `Windows`, `X64`, `printfarmer-gpu`, `nvidia` |
| `windows-x64-amd`    | Windows x64 with AMD Radeon GPU      | `self-hosted`, `Windows`, `X64`, `printfarmer-gpu`, `amd`    |
| `windows-x64-intel`  | Windows x64 with Intel GPU           | `self-hosted`, `Windows`, `X64`, `printfarmer-gpu`, `intel`  |
| `macos-arm64-apple`  | Apple silicon macOS host             | `self-hosted`, `macOS`, `ARM64`, `printfarmer-gpu`, `apple`  |
| `macos-x64-intel`    | Intel macOS host with Intel GPU      | `self-hosted`, `macOS`, `X64`, `printfarmer-gpu`, `intel`    |
| `macos-x64-amd`      | Intel macOS host with AMD Radeon GPU | `self-hosted`, `macOS`, `X64`, `printfarmer-gpu`, `amd`      |

Run the GitHub Actions runner inside a logged-in graphical user session, not a
headless service session. Keep the display available for the duration of the
test. Do not put multiple vendor labels on a runner: the workflow verifies the
requested OS, architecture, WebGL renderer, and operating-system adapter
inventory rather than trusting labels alone.

### Qualify a release candidate

Dispatch `.github/workflows/release-gpu-qualification.yml` from the candidate
tag or branch. Every result is bound to the exact resolved commit SHA:

```powershell
gh workflow run release-gpu-qualification.yml --ref <candidate-tag-or-branch>
gh run list --workflow release-gpu-qualification.yml --limit 1
gh run watch <run-id> --exit-status
```

The workflow waits for all six labeled runners, builds the release sidecar and
packaged application on each host, runs the strict physical GPU scenario, and
then applies one aggregate gate. The gate rejects:

- missing or duplicate profiles;
- software/virtual renderers;
- platform, architecture, or vendor mismatches;
- a WebGL vendor without a matching system adapter;
- evidence from a different commit, repository, workflow run, or rerun
  attempt; and
- any incomplete render/orbit/reset/responsiveness check.

Successful matrix jobs capture Windows adapter name, driver version/date and
device ID, or macOS adapter, Metal support and OS version. The aggregate
`gpu-qualification-<sha>-attempt-<n>` artifact contains all reports and the
verified summary. Preserve that artifact with the release-candidate record.
Rerun **all** matrix jobs together; reports from different run attempts are
deliberately rejected.

### Local physical-GPU preflight

After building the sidecar and an E2E-enabled package, one runner profile can be
checked locally before dispatching the official workflow:

```powershell
npm run build:sidecar
$env:PRINTFARMER_SKIP_SIDECAR_BUILD = '1'
$env:PRINTFARMER_BUILD_E2E = '1'
npm run package
$env:PRINTFARMER_E2E_GPU_MODE = 'default'
$env:PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE = '1'
$env:PRINTFARMER_E2E_GPU_PROFILE = 'windows-x64-nvidia'
$env:PRINTFARMER_E2E_COMMIT_SHA = (git rev-parse HEAD)
$env:PRINTFARMER_E2E_GPU_REPORT = (Join-Path $PWD 'gpu-qualification\webgl.json')
npx playwright test e2e/release.gpu.spec.ts
$env:PRINTFARMER_GPU_EVIDENCE_REPORT = (Join-Path $PWD 'gpu-qualification\windows-x64-nvidia.json')
node scripts\release-gpu-qualification.mjs capture
```

```sh
npm run build:sidecar
PRINTFARMER_SKIP_SIDECAR_BUILD=1 PRINTFARMER_BUILD_E2E=1 npm run package
export PRINTFARMER_E2E_GPU_MODE=default
export PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE=1
export PRINTFARMER_E2E_GPU_PROFILE=macos-arm64-apple
export PRINTFARMER_E2E_COMMIT_SHA="$(git rev-parse HEAD)"
export PRINTFARMER_E2E_GPU_REPORT="$PWD/gpu-qualification/webgl.json"
npx playwright test e2e/release.gpu.spec.ts
export PRINTFARMER_GPU_EVIDENCE_REPORT="$PWD/gpu-qualification/macos-arm64-apple.json"
node scripts/release-gpu-qualification.mjs capture
```

A local report is a preflight result, not the official six-profile
qualification. The workflow's aggregate gate binds every report to one GitHub
run and commit.

### Focused hosted-runner commands

After packaging with the CI-only dialog automation enabled, the focused local
commands are:

```powershell
npx playwright test e2e/release.accessibility.spec.ts
$env:PRINTFARMER_E2E_GPU_MODE = 'default'
npx playwright test e2e/release.gpu.spec.ts
$env:PRINTFARMER_E2E_GPU_MODE = 'swiftshader'
npx playwright test e2e/release.gpu.spec.ts
```

```sh
npx playwright test e2e/release.accessibility.spec.ts
PRINTFARMER_E2E_GPU_MODE=default npx playwright test e2e/release.gpu.spec.ts
PRINTFARMER_E2E_GPU_MODE=swiftshader npx playwright test e2e/release.gpu.spec.ts
```

## Accessibility

The packaged accessibility suite scans the onboarding/import flow, populated
library, and live 3D viewer with axe WCAG A/AA rules. Moderate, serious, and
critical violations fail the job. The suite also verifies initial dialog focus,
keyboard focus trapping, background inertness, viewer keyboard operation, and
focus restoration.

## Scale and soak regressions

The unit and packaged suites retain bounded release regressions for:

- filter-then-sort over a 50,000-result subset of a 100,000-entry catalog;
- exact 500 MB snapshot copy, SHA-256, fsync, and final-size verification;
- exact and first-rejected multipart request-cap decisions without loading a
  request body;
- a real 500,000-triangle production scene-graph/LOD workload; and
- a 200-request thumbnail queue soak.

These synthetic tests detect regressions without claiming workstation-scale
hardware qualification. The package matrix remains the cross-platform release
gate; the manual physical workflow supplies release-candidate hardware
qualification without making ordinary pull-request CI depend on scarce
self-hosted machines.
