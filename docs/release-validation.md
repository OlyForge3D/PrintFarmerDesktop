# Release validation

PrintFarmer Desktop supports Windows and macOS. The release regression suites
exercise the packaged Electron executable on both GitHub-hosted runner
platforms, including the production preload boundary, Rust sidecar, renderer,
and package resources.

## Graphics matrix

The viewer requires WebGL2. Package CI runs the same real model scene and
keyboard interaction in two modes:

| Mode                 | CI requirement                                                                                                                                             | What the result proves                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Host default         | A WebGL2 context is created, renderer/vendor details are reported, a model renders, orbit changes the image, and reset restores it.                        | The packaged viewer works with the graphics capability selected by Chromium on that runner. The reported renderer can be hardware or software. |
| SwiftShader fallback | Chromium is launched with the explicit ANGLE SwiftShader fallback, the reported renderer must identify SwiftShader, and the same scene interaction passes. | The documented software fallback remains usable when hardware acceleration is unavailable.                                                     |

GitHub-hosted runner labels do not guarantee physical GPU passthrough. A
passing host-default job must not be recorded as physical-GPU qualification.
Issue #23 remains open until Windows and macOS release candidates also have
traceable physical-hardware results (or dedicated GPU-backed CI) for the
supported vendor/driver matrix.

After packaging with the CI-only dialog automation enabled, the focused local
commands are:

```powershell
npx playwright test e2e\release.accessibility.spec.ts
$env:PRINTFARMER_E2E_GPU_MODE = 'default'
npx playwright test e2e\release.gpu.spec.ts
$env:PRINTFARMER_E2E_GPU_MODE = 'swiftshader'
npx playwright test e2e\release.gpu.spec.ts
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
gate; physical-GPU evidence is tracked separately in issue #23.
