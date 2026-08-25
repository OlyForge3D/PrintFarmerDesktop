import type {
  CalibrationCustomProfileRef,
  CalibrationSlicerProfileRef,
} from '@shared/ipc';

/**
 * Categorises a custom profile as machine / process / filament.
 *
 * The server groups them all into `GET /api/slicer/profiles/custom` (there is
 * no per-category endpoint), so the renderer sorts them itself before running
 * the applicability filter below.
 */
export function customProfilesOfType(
  profiles: readonly CalibrationCustomProfileRef[],
  type: 'machine' | 'process' | 'filament',
): readonly CalibrationCustomProfileRef[] {
  return profiles.filter((profile) => profile.profileType === type);
}

/**
 * Client-side applicability filter for custom machine and process profiles.
 *
 * Custom profiles come from `/custom` UNFILTERED — the server has no notion of
 * which printer a user-authored profile is intended for. React's
 * `NewSliceJobPage.tsx:1024-1038` reference implementation matches by
 * `printerModelId` (the exact catalog model Guid the custom profile was
 * authored against).
 *
 * When the *printer* carries no `printerModelId` — the current `Calibration
 * PrinterCandidate` DTO does not carry the field, that follow-up server
 * change is being tracked separately — we cannot match, so we show ALL
 * customs and let the operator decide. A permissive fallback is the correct
 * choice for machine/process profiles specifically: unlike filament (where
 * the operator's manual pick can produce a print-ruining mismatch), a wrong
 * machine or process pick is caught immediately — the slicer worker fails to
 * apply it, no G-code is ever generated, no hardware moves. The safety
 * concern that motivates the filament filter simply does not apply here.
 *
 * When the printer DOES carry a `printerModelId` we filter strictly — that
 * is the exact-match reference behaviour and it drops customs authored for a
 * different model.
 *
 * The filament filter uses a different code path
 * (`filterCustomFilamentsForMachine` below) because filament profiles carry
 * `compatiblePrinters` on every row and machine/process profiles do not.
 */
export function filterCustomMachineOrProcessForModel(
  profiles: readonly CalibrationCustomProfileRef[],
  printerModelId: string | null,
): readonly CalibrationCustomProfileRef[] {
  if (printerModelId === null) return profiles;
  return profiles.filter(
    (profile) => profile.printerModelId === printerModelId,
  );
}

/**
 * Client-side applicability filter for custom filament profiles.
 *
 * The React reference at `NewSliceJobPage.tsx:1024-1038` parses
 * `rawJson.compatible_printers` and asserts membership of the *chosen
 * machine's canonical name*, not the printer model. `CalibrationCustomProfileRef`
 * already exposes `compatiblePrinters` as a decoded string array (main-process
 * handles the raw-json parse), so this is a straight `.includes()` check.
 *
 * `compatiblePrinters === null` means the custom profile did not declare any
 * — the reference treats that as "not applicable to any specific machine",
 * so it is excluded. Including everything by default is the failure mode this
 * whole helper exists to prevent (owner directive 2026-08-22).
 */
export function filterCustomFilamentsForMachine(
  profiles: readonly CalibrationCustomProfileRef[],
  chosenMachineName: string,
): readonly CalibrationCustomProfileRef[] {
  if (chosenMachineName === '') return [];
  return profiles.filter(
    (profile) =>
      profile.compatiblePrinters !== null &&
      profile.compatiblePrinters.includes(chosenMachineName),
  );
}

/**
 * Composite value stored in each `<option>`, so the operator's pick tells us
 * both which origin the profile came from (`system` or `custom`) and which row
 * it is. Custom rows use their Guid `id`; system rows use their canonical
 * `name` (there is no `Id` field on system profile DTOs — the wire migration
 * §C.2 of `printfarmer-api-contract.md`).
 */
export function profileOptionValue(
  origin: 'system' | 'custom',
  identity: string,
): string {
  return `${origin}:${identity}`;
}

export interface DecodedProfileOption {
  readonly origin: 'system' | 'custom';
  readonly identity: string;
}

export function decodeProfileOption(
  value: string,
): DecodedProfileOption | null {
  if (value === '') return null;
  const colon = value.indexOf(':');
  if (colon === -1) return null;
  const origin = value.slice(0, colon);
  const identity = value.slice(colon + 1);
  if (origin !== 'system' && origin !== 'custom') return null;
  if (identity.length === 0) return null;
  return { origin, identity };
}

/**
 * Resolve the chosen `<option>` value back to a profile Guid, when the main
 * process has already resolved one from a prior list call. `null` when the
 * operator has not picked one, or the pick is a system profile that has
 * never been imported into PrintFarmer — the option is still selectable
 * (issue #766); callers that need a Guid for a never-imported pick resolve
 * it on demand via `calibration:resolveSystemProfile` instead of refusing
 * the pick.
 */
export function resolveChosenProfileGuid(
  selected: DecodedProfileOption | null,
  systemProfiles: readonly CalibrationSlicerProfileRef[],
  customProfiles: readonly CalibrationCustomProfileRef[],
): string | null {
  if (selected === null) return null;
  if (selected.origin === 'system') {
    const match = systemProfiles.find(
      (profile) => profile.name === selected.identity,
    );
    return match?.guid ?? null;
  }
  const custom = customProfiles.find(
    (profile) => profile.id === selected.identity,
  );
  return custom?.id ?? null;
}

/**
 * Resolve the operator's chosen machine to its canonical `name` string. The
 * `/for-machines` endpoints take an array of these names; the setup PUT does
 * not — it takes the machine Guid — but the intermediate cascade fetches
 * (process, filament) key off the name. Returns `null` when the option's
 * identity does not resolve to a known profile in either list.
 */
export function resolveChosenMachineName(
  selected: DecodedProfileOption | null,
  systemMachines: readonly CalibrationSlicerProfileRef[],
  customMachines: readonly CalibrationCustomProfileRef[],
): string | null {
  if (selected === null) return null;
  if (selected.origin === 'system') {
    const match = systemMachines.find(
      (profile) => profile.name === selected.identity,
    );
    return match?.name ?? null;
  }
  const custom = customMachines.find(
    (profile) => profile.id === selected.identity,
  );
  return custom?.name ?? null;
}
