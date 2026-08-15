# Printer Calibration user guide

PFD Printer Calibration is a native PrintFarmer Desktop workspace. It walks a
single printer, toolhead, nozzle and filament through nine calibration stages,
records what you observed at each one, and produces a deterministic OrcaSlicer
filament profile from the results.

It is not a wrapper around another tool and it does not bundle anybody else's
calibration models. The stage definitions follow upstream OrcaSlicer behaviour
and the official
[OrcaSlicer calibration wiki](https://github.com/SoftFever/OrcaSlicer/wiki/Calibration),
which is the right place to read about the physics of each test. This guide
covers what the application does, what it refuses to do, and why.

## Contents

- [Starting a project: choose the printer first](#starting-a-project-choose-the-printer-first)
- [Which printers are eligible](#which-printers-are-eligible)
- [What a calibration project is bound to](#what-a-calibration-project-is-bound-to)
- [Stages](#stages)
- [Coach and Expert](#coach-and-expert)
- [Saving, resuming and redoing](#saving-resuming-and-redoing)
- [What works offline](#what-works-offline)
- [Calibration models and external assets](#calibration-models-and-external-assets)
- [Generate, queue, clear the bed, record the result](#generate-queue-clear-the-bed-record-the-result)
- [Installing or exporting the profile](#installing-or-exporting-the-profile)
- [Importing a legacy calibration backup (v4)](#importing-a-legacy-calibration-backup-v4)
- [When something goes wrong](#when-something-goes-wrong)

## Starting a project: choose the printer first

Calibration settings belong to one printer. A flow ratio measured on one machine
says nothing about another, so the wizard asks which printer you are calibrating
before it fetches anything about any printer.

The sequence is:

1. **The printer list loads.** This is the only thing fetched at this point. No
   printer configuration, no profile catalogue and no scan of your local
   OrcaSlicer installation happens yet, because none of them can be scoped to a
   printer you have not named.
2. **You choose a printer.** Moving through the list with the arrow keys or the
   mouse only highlights; nothing is loaded until you select **Continue with
   this printer**. No printer is chosen for you.
3. **That printer's configuration and profiles load.** Exactly one
   configuration snapshot is read, and profiles are resolved for that printer
   and that configuration revision only. Your local OrcaSlicer install is
   searched for the one profile name the printer reports, not for everything it
   contains. This is the point at which PrintFarmer actually evaluates the
   printer's profiles; the list in step 1 is a basic screen that does not.
4. **The rest of the wizard unlocks.** Naming the project, choosing the tool and
   nozzle, picking a base profile and entering baselines all come after, because
   each depends on the printer.

A project can only be created against a printer PrintFarmer has **fully
evaluated** — profiles resolved, printer declared eligible, with no missing
inputs and no rejection reasons. A printer that merely passed the basic screen
is listed and can be selected, but it is never enough on its own, and a server
too old to say whether it evaluated profiles is treated as not having done so.

Changing your mind is safe at any point. Selecting a different printer cancels
whatever was still loading for the previous one and clears its results, so a
slow answer for the printer you moved away from can never appear next to the one
you are now looking at. You can switch while a printer is still loading.

Printers PrintFarmer will not calibrate stay in the list and can be selected, so
you can read exactly why. **Continue** stays disabled for them, so looking at a
refusal never risks acting on it.

If a printer's configuration or profiles fail to load, only that printer is
affected: the list stays on screen and the other printers remain selectable. A
problem with one machine is never reported as "you have no printers".

If the search of your own machine cannot be completed — a profile folder that
cannot be read, for instance — the workspace says the scan failed. That is
deliberately not the same message as "OrcaSlicer is not installed", which would
send you to reinstall software that is already there.

## Which printers are eligible

Eligibility is decided by PrintFarmer and is checked against explicit canonical
values. A printer is eligible only when PrintFarmer reports **all** of:

| Field                | Required value |
| -------------------- | -------------- |
| `firmwareFamily`     | `Klipper`      |
| `gcodeDialect`       | `Klipper`      |
| `slicerFamily`       | `OrcaSlicer`   |
| `slicerIdentity`     | `OrcaSlicer`   |
| `slicerDistribution` | `upstream`     |

These are exact literal values, not ranges or families of values. Anything
incomplete, or carrying a different literal, is reported as ineligible rather
than interpreted.

Eligibility also requires complete hardware metadata: positive build volume in
all three axes, a maximum nozzle temperature, a maximum bed temperature and a
maximum volumetric rate. These are the machine limits PrintFarmer publishes for
the printer, and your baseline values are range-checked against them.

Permissions are checked separately, against the permissions your PrintFarmer
account actually grants:

| You want to                       | You need               |
| --------------------------------- | ---------------------- |
| List printers and open the wizard | `calibration:read`     |
| Create a calibration project      | `calibration:create`   |
| Record results and queue a print  | `calibration:update`   |
| Generate a profile                | `calibration:generate` |

Only `calibration:read` is needed to open the workspace and look, so an account
with read-only access to the farm can inspect printers and profiles without
being refused at the door. Each of the other actions is checked on its own when
you attempt it, and the refusal names the exact permission that was missing.
A permission problem is reported as a permission problem — never as an empty
printer list.

**Manufacturer, model, alias and transport backend never establish
eligibility.** A printer named "Klipper" or connected over a Klipper-shaped
transport is not eligible on that basis. Neither is a printer whose
configuration merely looks compatible. If PrintFarmer does not supply the
canonical values above, the workspace reports that eligibility is missing and
refuses to start, rather than inferring it. The same applies in reverse: an
eligible printer that is currently offline cannot have its context verified, so
project creation is blocked until it is reachable.

## What a calibration project is bound to

A project is pinned to a specific physical and configuration scope. Changing any
part of it means a new project, not an edited one.

- **Backend identity** — the PrintFarmer profile, printer, and printer
  configuration, plus that configuration's **revision number**.
- **Immutable snapshot** — an identified, revisioned snapshot of the printer
  captured at bind time. The snapshot revision must match the bound
  configuration revision; a mismatch is `CONFIGURATION_REVISION_MISMATCH`.
- **Physical toolhead and nozzle** — the exact tool, toolhead and nozzle,
  including nozzle diameter and material. On a multi-tool machine you must
  select which tool you are calibrating. The selected tool, toolhead and nozzle
  must all match the snapshot.
- **Filament** — filament project, provider, product and SKU. A spool is
  optional; the other four are required.

Before any action that moves hardware or writes a profile, the app asks you to
confirm that the physical toolhead and nozzle in the machine match the bound
snapshot. That confirmation is checked field by field, including nozzle
diameter, and a mismatch blocks with `PHYSICAL_TOOLHEAD_NOZZLE_MISMATCH`.

Releasing a queued job for printing needs one more thing: a current confirmation
that the bed is clear. The app records that confirmation itself, and only after
PrintFarmer has told it that the job really is waiting for one. It is good for
that one job on that one printer at that configuration revision, is spent the
moment it is used, and expires after two minutes — because it is a statement
about the bed _now_, and the longer it is honoured the more likely it is to have
stopped being true. If it has expired or was already used, you are asked again
rather than the app assuming the bed stayed clear.

## Stages

There are nine stages. Each one has a prerequisite, a purpose, and a result that
means something specific. They are listed here in the order the workspace runs
them.

### 1. Temperature — `temperature`

**Prerequisite:** none. This is the first stage.
**Purpose:** find the nozzle temperature that gives the cleanest surface for
this filament.
**Result:** a temperature in °C, bounded to 150–400 and constrained by the
snapshot's maximum nozzle temperature. Everything downstream is measured at this
temperature, which is why nothing else can run first.

### 2. Flow pass 1 — `flowPass1`

**Prerequisite:** Temperature.
**Purpose:** get flow approximately right in one coarse move.
**Result:** a flow adjustment percentage. Coach uses the standard method
(−20…+20% in 5% steps). Expert can also choose coarse (−30…+30% in 5% steps) or
YOLO (−30…+30% in 1% steps).

### 3. Flow pass 2 — `flowPass2`

**Prerequisite:** Flow pass 1.
**Purpose:** refine the first-pass result with smaller steps.
**Result:** a fine correction of −10…+10% in 1% steps, applied to the ratio you
selected in pass 1. It is a correction to that value, not a replacement for it.

### 4. Pressure advance — `pressureAdvance`

**Prerequisite:** Flow pass 2.
**Purpose:** control extrusion at corners and speed changes.
**Result:** a pressure advance value in seconds, 0–2 in 0.001 steps. Coach uses
the tower method. Expert can use tower, line or pattern; the method you used is
recorded with the observation, because the same number obtained by different
methods is not the same evidence.

### 5. Flow verification — `flowVerification`

**Prerequisite:** Flow pass 2 **and** Pressure advance.
**Purpose:** confirm the chosen flow and pressure advance work together before
you tune anything downstream of them.
**Result:** a pass or a fail. Record a pass only if both coexist cleanly — this
is the stage that catches a flow value that was only good because pressure
advance was wrong.

### 6. Retraction — `retraction`

**Prerequisite:** Flow verification.
**Purpose:** find the shortest retraction that controls stringing.
**Result:** a retraction length of 0–20 mm in 0.1 mm steps. This value is
specific to this exact toolhead and filament and does not transfer to another.
Skippable in both Coach and Expert.

### 7. Maximum volumetric speed — `maximumVolumetricSpeed`

**Prerequisite:** Flow verification.
**Purpose:** find the highest stable extrusion rate before under-extrusion.
**Result:** a rate of 0.5–100 mm³/s in 0.1 steps, capped by the snapshot's
maximum volumetric rate. The app will not accept a value above the hardware
limit it was given.

### 8. Shrinkage — `shrinkage`

**Prerequisite:** Maximum volumetric speed.
**Purpose:** correct dimensional error from cooling.
**Result:** a per-axis compensation of 90–110% in 0.01 steps, entered as nominal
and measured dimensions from a **cooled** coupon. Measuring warm produces a
wrong number that looks correct. Skippable in both Coach and Expert.

### 9. Final verification — `finalVerification`

**Prerequisite:** Retraction, Maximum volumetric speed **and** Shrinkage.
**Purpose:** prove the combined result before anything is written to a profile.
**Result:** a pass or a fail, with visible defects recorded. **This stage is not
skippable in either mode**, and a clean completion is required before a profile
patch can be applied — attempting to apply without it is blocked with
`WORKFLOW_NOT_VERIFIED`. A failed verification means retesting, not overriding.

## Coach and Expert

Both modes run the same nine stages in the same order with the same bounds. They
differ in two ways.

**Method choice.** Coach picks one method per stage so there is nothing to
decide. Expert opens up the alternatives: three flow methods at Flow pass 1
(standard, coarse, YOLO) and three pressure advance methods (tower, line,
pattern). Every other stage has a single method in both modes.

**Skipping.** In Expert, every stage except Final verification may be skipped.
In Coach, only Retraction and Shrinkage may be skipped. Final verification can
never be skipped in either mode.

Skipping requires a reason, and the reason is stored with the project. A skipped
stage is a recorded decision, not an absence.

## Saving, resuming and redoing

**Your work is saved as you go.** Stage drafts autosave locally. Closing the
workspace, or losing connectivity, does not lose entered values; reopening the
project restores where you were.

**A draft is not a result.** Autosaved input is editable and revisable. It
becomes an immutable attempt only when you explicitly begin and complete the
stage. Until then nothing has been recorded.

**Redo creates a new attempt — it never edits the old one.** A completed,
skipped or needs-retest stage can be redone. Doing so starts a new immutable
attempt with a new attempt ID, records the method used and the reason you gave,
and leaves the previous attempt in the history. There is no path in the
application that rewrites a recorded observation. If you calibrated at the wrong
temperature and redid the stage, both attempts remain visible, which is what
lets you tell later why a profile came out as it did.

## What works offline

Offline, the workspace is a notebook. Online, it is a notebook that can drive a
printer.

**Works offline:**

- Opening and editing existing calibration projects
- Entering, editing and autosaving stage drafts
- Staging photos against a stage

**Does not work offline:**

- Creating a new calibration project (the printer's current context cannot be
  verified)
- Generating a calibration model
- Creating a print queue entry
- Acknowledging that the bed is clear
- Starting a print
- Generating, installing, exporting or restoring an OrcaSlicer profile

Any of these blocked while offline reports `OFFLINE_ACTION_BLOCKED` and names
the action. Two related conditions block the same actions even when you are
online: unsynchronised local changes (`UNSYNCED_MUTATIONS`) and unresolved
conflicts (`UNRESOLVED_CONFLICTS`). Both are cleared by synchronising, and the
workspace tells you which one it is.

## Calibration models and external assets

PFD does not bundle third-party calibration models. Third-party models are
**linked or user-imported and are never bundled** — the reasoning is recorded in
[ADR 0001](adr/0001-printer-calibration-source-provenance.md).

The practical effect is that any external asset in your calibration flow is one
**you** selected. The app does not fetch models on your behalf and does not ship
a model library. Where a stage needs a test object, PFD generates it from the
bound printer configuration rather than shipping somebody else's geometry, which
is also why the generated object matches your build volume and nozzle rather
than a generic profile.

## Generate, queue, clear the bed, record the result

Printing a calibration object is one flow with four steps, and it is deliberately
not a single button.

1. **Generate the calibration model.** The app builds the object for this stage
   from the bound configuration. Progress is reported while it runs.
2. **Queue it.** A queue entry is created for the bound printer. The queue shows
   its state and revision.
3. **Acknowledge the bed is clear.** You are asked to confirm the bed is
   physically clear. This is never offered while the printer is offline, while
   telemetry is stale, or while the confirmation has expired — in those cases the
   panel explains why instead of showing a button you should not press.
   Without this confirmation, print start is blocked with
   `BED_CLEAR_CONFIRMATION_REQUIRED`. An operator must also be present
   (`OPERATOR_PRESENCE_REQUIRED`).
4. **Record the result.** Enter what you observed and complete the stage.

### What "Starting…" means

If the print has been dispatched but the server has not yet confirmed whether it
started, the outcome shows **Starting…** and stays there.

**The application will not retry this for you, and you should not either.** The
dispatch may have succeeded; the app does not know yet. Retrying a dispatch
whose outcome is unknown can start the same calibration print twice on a machine
you may not be standing in front of. The status updates by itself when the
server confirms the outcome. The guidance shown next to the status says exactly
this, and no retry button is offered in that state — the absence of the button is
intentional, not a missing feature.

## Installing or exporting the profile

Once Final verification is complete, the workspace can generate a deterministic
OrcaSlicer filament profile from the observations you selected. What happens next
depends on your platform.

**Windows — transactional install with rollback.** _Install transactionally_
writes the profile, taking a backup first. Both the installed profile and the
backup are identified by hash. If the result is wrong, _Restore from backup_
puts the previous profile back. The install is transactional: it either replaces
the profile completely or leaves it untouched.

**macOS and Linux — export only.** These platforms offer _Export profile…_,
which writes the profile to a location you choose. **PFD does not install a
profile directly on macOS**, and no rollback affordance is shown, because there
is nothing to roll back — the app has not modified your OrcaSlicer
configuration. Import the exported file through OrcaSlicer yourself.

On every platform, generation requires explicit confirmation before any write,
and the proposed patch can be previewed before you accept it. Regenerating is
always available.

**The base profile must still be the one you chose.** A generated profile is a
named base plus your measured changes, so the app verifies before patching that
the OrcaSlicer profile on disk is byte-for-byte the one this project was bound
to. If OrcaSlicer rewrote it, or you replaced it, generation stops and says the
base profile changed rather than quietly patching a different starting point.
Re-select the base profile, or restore the original, and generate again. A
project that recorded no fingerprint for its base is reported the same way,
because there is nothing to check the file against.

## Importing a legacy calibration backup (v4)

If you have a v4 calibration backup, the workspace can import it.

**Preflight first.** Selecting a backup runs a preflight that reports the
detected schema version and counts the records it found, including how many are
**unsupported** and how many are **corrupt**. You see this before anything is
imported.

**Unsupported and corrupt records are reported, not discarded.** They are
counted in the preflight and again in the import result, so the difference
between "this backup had 40 attempts" and "36 attempts were imported" is visible
rather than silent. Nothing is dropped without appearing in the report.

**Printer mapping is explicit.** Legacy projects are mapped onto eligible
printers by you. Only printers meeting the eligibility rules above can be
targets, for the same reason new projects can only be created against them.

**The result is a report.** After import you get per-project results — attempts
and photos imported for each — which you can copy or download as a text file.
Keep it if the counts matter to you; it is not stored in the app.

## When something goes wrong

Every failure state below is shown with a specific message that names the
condition and what to do about it.

| What you see               | What it means                                                                                        | What to do                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Offline**                | PrintFarmer is unreachable. Saved projects stay editable.                                            | Reconnect. Hardware and profile actions return; drafts you made offline are kept.                             |
| **Session expired**        | Your sign-in expired or was revoked. Distinct from a permission problem: the account may be fine.    | The app re-establishes the session by itself and tells you if it cannot. Reconnect the profile, then retry.   |
| **Permission denied**      | Your account lacks printer read, calibration write, generation or print start.                       | The message names the missing permission. An administrator grants it in PrintFarmer.                          |
| **Capability unavailable** | PrintFarmer did not confirm Klipper firmware, Klipper G-code, OrcaSlicer, and upstream distribution. | This printer is not eligible. The workspace names which capability was not confirmed.                         |
| **Stale printer context**  | The printer's configuration or snapshot revision moved after you bound the project.                  | Rebase to the fresh snapshot and explicitly retest the affected stages. Values are not carried over silently. |
| **Conflict**               | The same project changed here and on the server.                                                     | Resolve the conflict before continuing; hardware actions stay blocked until you do.                           |
| **Generation failed**      | Model or profile generation did not complete.                                                        | The error names the stage that failed. Regenerate; nothing was written.                                       |
| **Starting… (uncertain)**  | A print was dispatched and the server has not confirmed the outcome.                                 | Wait. Do not retry — see [What "Starting…" means](#what-starting-means).                                      |
| **Rolled back**            | A transactional profile install was reverted (Windows only).                                         | The previous profile is restored. The install left no partial state.                                          |

Two of these deserve emphasis.

**Stale context does not silently invalidate your work.** When the printer
configuration changes underneath a project, the app does not quietly keep going
and it does not quietly discard your observations. It tells you the snapshot
moved and requires you to decide which stages to retest, because a flow number
measured against a different configuration is not evidence about the current one.

**A blocked action always names its blocker.** If more than one condition
applies — offline _and_ unsynced _and_ stale — all of them are listed. You are
never left with a disabled control and no explanation.

**Nothing is retried on your behalf after an authorisation problem.** When the
server refuses an action, or your session expires mid-flow, the app corrects
what it knows — it re-reads your permissions, and re-establishes an expired
session — but it never re-sends the generate, queue or print you asked for. That
decision stays yours, because the account the retry would run as is not
guaranteed to be the one you started with.
