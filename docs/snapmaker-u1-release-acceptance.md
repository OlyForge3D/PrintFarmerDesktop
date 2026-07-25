# Snapmaker U1 release acceptance

This checklist is the external release gate for opening PrintFarmer Desktop
outputs in Snapmaker Orca and, when hardware is available, confirming physical
behavior. Automated tests do not substitute for these observations.

## Accepted environment

- **Snapmaker Orca:** 2.3.5 stable (released 2026-07-15)
- **Desktop platforms:** Windows 10/11 x64 and supported macOS Intel/Apple
  Silicon runners
- **Printer/profile:** Snapmaker U1, 0.4 mm nozzle, the exact bundled or imported
  profile fingerprint recorded below

Environment discovery on 2026-07-24 found Snapmaker_Orca 2.3.4 at
`C:\Program Files\Snapmaker_Orca\snapmaker-orca.exe`; 2.3.5 and a connected U1
were not available. Therefore no manual slicer, re-slice, tool-change, or
hardware result is claimed in this document.

## Current external gates

| Gate                                                                         | Status  | Required evidence                                                |
| ---------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| Single-material output opens in Snapmaker Orca 2.3.5 without a repair prompt | NOT RUN | Screenshot and Orca log                                          |
| Multi-material output preserves intended tool routing and re-slices          | NOT RUN | Source/output routing screenshots and sliced tool-change summary |
| Multi-plate output preserves plate membership and placement                  | NOT RUN | One screenshot per plate plus exported project hash              |
| Paint-bearing output preserves painted regions after re-slice                | NOT RUN | Before/after paint screenshots and warning acknowledgement       |
| U1 guardrails match the generated process/machine settings                   | NOT RUN | Settings export/diff                                             |
| Physical U1 print performs expected tool changes                             | NOT RUN | Printer/job identifier, console log, and operator observation    |

## Independent projects

Create these projects from simple original geometry owned by the tester. Do not
use MkWorld2Snap source, tests, assets, or fixtures.

| Project ID  | Required contents                                                      | Source SHA-256 | Output SHA-256 |
| ----------- | ---------------------------------------------------------------------- | -------------- | -------------- |
| `U1-SINGLE` | One object, one PLA slot, non-origin placement                         |                |
| `U1-TOOLS`  | At least two objects/parts routed to different U1 tools/material slots |                |
| `U1-PLATES` | At least two plates with distinct object transforms                    |                |
| `U1-PAINT`  | A mesh with visible face painting and at least two colors/tools        |                |

For each project, retain the original editable 3MF, the PrintFarmer Desktop
output, and the re-saved/re-sliced Snapmaker Orca project. Record hashes before
opening any application.

## Evidence record

| Field                                               | Value |
| --------------------------------------------------- | ----- |
| Tester and date/time                                |       |
| PrintFarmer Desktop commit/version                  |       |
| Package artifact name and SHA-256                   |       |
| OS version/architecture                             |       |
| Snapmaker Orca version/build                        |       |
| U1 firmware and serial suffix (if hardware is used) |       |
| Target source (`bundled` or `imported`)             |       |
| Target profile ID/fingerprint                       |       |
| Fixture/project ID                                  |       |
| Source SHA-256 before preflight                     |       |
| Source SHA-256 after cancel/failure/save/restart    |       |
| Output SHA-256                                      |       |
| Screenshots/log archive location                    |       |
| Repair prompt observed (`yes` fails)                |       |
| Re-slice completed                                  |       |
| Expected/observed tool changes                      |       |
| Deviations or follow-up issue                       |       |

## Procedure

Repeat this procedure for all four independent projects on Windows and macOS.

1. Confirm the source hash and retain a read-only backup.
2. Catalog the source in PrintFarmer Desktop and open **Prepare for Snapmaker
   U1**.
3. Record every preflight blocker, warning, and proposed change. Painted
   projects must show the render-unverified paint warning.
4. Explicitly select the bundled target. For a second pass, import a known-good
   editable U1 reference and explicitly select the imported target.
5. Build the review copy. Toggle source/output and inspect object count,
   transforms, plate membership, and visible routing.
6. Exercise Save As cancellation and an existing-name collision; confirm both
   leave the source hash and existing destination unchanged. Save to a new name.
7. Close and restart the app. Confirm stale temporary artifacts are gone, the
   imported profile remains available, and the source hash is unchanged.
8. Open the output in Snapmaker Orca 2.3.5. Record whether a repair prompt
   appears. Any repair prompt fails acceptance.
9. Inspect machine/process/filament selection, all plates and transforms,
   object/part tool assignments, object exclusion, paint, and every speed and
   acceleration override.
10. Re-slice. Confirm no stale source G-code survives, no invalid OPC warning is
    reported, and the generated tool changes match the intended routing.
11. If a U1 is available and the project is safe to print, capture the job ID,
    printer log, expected/observed tool changes, and operator result. Otherwise
    leave the hardware row `NOT RUN`.

## Pass criteria

Release acceptance passes only when every non-hardware row has reproducible
Windows and macOS evidence for Snapmaker Orca 2.3.5, source hashes are identical
at every checkpoint, no repair prompt or stale G-code/invalid relationship is
observed, placement/routing/paint are correct, and re-slicing succeeds with
guardrails intact. Hardware acceptance may remain separately deferred only when
the release notes state that no physical print was performed.
