import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalibrationCustomProfileRef,
  CalibrationSlicerProfileRef,
} from '@shared/ipc';
import { calibrationApi } from './api';
import {
  customProfilesOfType,
  decodeProfileOption,
  filterCustomFilamentsForMachine,
  filterCustomMachineOrProcessForModel,
  profileOptionValue,
  resolveChosenMachineName,
  resolveChosenProfileGuid,
  type DecodedProfileOption,
} from './profileSelection';

/**
 * The resolved profile identities the operator picked from the cascade —
 * emitted through `onSelectionChange` on every change. Consumers use this
 * shape for the filament calibration wizard's `cloneFilamentProfile` and
 * `submitCalibrationSlice` calls: `sourceProfileGuid` (the base filament
 * `guid`) and the three profile `Name` strings the wire mapper uses to key
 * the slice request.
 *
 * All fields are nullable so the callback fires with a partial selection
 * every time the operator advances (or backs out of) any dropdown — the
 * caller inspects `readyForClone` to decide whether the picks are complete
 * enough to proceed.
 */
export interface ProfileSelectionSnapshot {
  readonly machineName: string | null;
  readonly processName: string | null;
  readonly filamentName: string | null;
  /**
   * Guid of the picked base filament — its `sourceProfileId` for the clone
   * step, when already resolved. Null for a system pick that has never
   * been imported into PrintFarmer; the option is still selectable (issue
   * #766), and the wizard resolves the real Guid on demand at clone time
   * via `calibration:resolveSystemProfile`.
   */
  readonly filamentGuid: string | null;
  /** Origin of the picked base filament, or null when nothing is picked. */
  readonly filamentOrigin: 'system' | 'custom' | null;
  /** True when every field the wizard needs to proceed is populated. */
  readonly readyForClone: boolean;
}

/**
 * Props to the profile-selection cascade.
 *
 * Step 1 of the filament calibration workflow (owner directive 2026-08-23,
 * `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`): the
 * operator picks machine, process and a base filament profile from the lists
 * PrintFarmer offers for the highlighted printer.
 */
export interface ProfileSelectionSectionProps {
  readonly profileId: string;
  readonly printerId: string;
  /**
   * Optional catalog model Guid for the printer. The `for-model` endpoint
   * requires it; when absent (the current wire mapper never populates it —
   * `RemoteCalibrationCandidateDto` carries no model Guid), the cascade falls
   * back to `listCalibrationExtendedProfiles` for the system-machine pool.
   * A follow-up server change adds the field to the candidate DTO.
   */
  readonly printerModelId: string | null;
  readonly disabled: boolean;
  /**
   * Fires whenever the operator's picks change. Used by the filament
   * calibration wizard to gate its "clone this profile" step; the printer-
   * calibration flow does not consume it. Optional to keep the older
   * `NewCalibrationProject` caller unchanged.
   */
  readonly onSelectionChange?: (snapshot: ProfileSelectionSnapshot) => void;
}

interface CatalogState {
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly noModelAlias: boolean;
  readonly systemMachines: readonly CalibrationSlicerProfileRef[];
  readonly systemProcesses: readonly CalibrationSlicerProfileRef[];
  readonly systemFilaments: readonly CalibrationSlicerProfileRef[];
  readonly custom: readonly CalibrationCustomProfileRef[];
}

const emptyCatalog: CatalogState = {
  loading: false,
  loaded: false,
  error: null,
  noModelAlias: false,
  systemMachines: [],
  systemProcesses: [],
  systemFilaments: [],
  custom: [],
};

interface FilteredForMachine {
  readonly loading: boolean;
  readonly error: string | null;
  readonly systemProcesses: readonly CalibrationSlicerProfileRef[];
  readonly systemFilaments: readonly CalibrationSlicerProfileRef[];
}

const emptyFilteredForMachine: FilteredForMachine = {
  loading: false,
  error: null,
  systemProcesses: [],
  systemFilaments: [],
};

/**
 * Format a profile row's display text so the origin ("system" / "custom") is
 * visible inline as well as on the `<optgroup>` label. The refused-environment
 * / profile-selection tests accept either, but showing both means an operator
 * reading a single option without its group header still sees the origin.
 */
function systemOptionLabel(profile: CalibrationSlicerProfileRef): string {
  return profile.displayLabel !== null && profile.displayLabel.length > 0
    ? `${profile.name} — ${profile.displayLabel} (system profile)`
    : `${profile.name} (system profile)`;
}

function customOptionLabel(profile: CalibrationCustomProfileRef): string {
  return `${profile.name} (custom / your profile)`;
}

export function ProfileSelectionSection(
  props: ProfileSelectionSectionProps,
): React.JSX.Element {
  const { profileId, printerId, printerModelId, disabled, onSelectionChange } =
    props;

  const [catalog, setCatalog] = useState<CatalogState>(emptyCatalog);
  const [forMachine, setForMachine] = useState<FilteredForMachine>(
    emptyFilteredForMachine,
  );
  const [chosenMachine, setChosenMachine] = useState<string>('');
  const [chosenProcess, setChosenProcess] = useState<string>('');
  const [chosenFilament, setChosenFilament] = useState<string>('');

  const catalogEpochRef = useRef(0);
  const forMachineEpochRef = useRef(0);
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  const loadCatalog = useCallback(async (): Promise<void> => {
    const epoch = ++catalogEpochRef.current;
    setCatalog({ ...emptyCatalog, loading: true });
    try {
      const api = calibrationApi();
      const [extended, custom, forModel] = await Promise.all([
        api.listCalibrationExtendedProfiles({ profileId }),
        api.listCalibrationCustomProfiles({ profileId }),
        printerModelId === null
          ? Promise.resolve(null)
          : api.listCalibrationMachineProfilesForModel({
              profileId,
              printerModelId,
            }),
      ]);
      if (catalogEpochRef.current !== epoch || unmountedRef.current) return;

      if (extended.status === 'error') {
        setCatalog({
          ...emptyCatalog,
          loaded: true,
          error: `Could not load the calibration profile catalog: ${extended.error.message}`,
        });
        return;
      }
      if (custom.status === 'error') {
        setCatalog({
          ...emptyCatalog,
          loaded: true,
          error: `Could not load your custom profiles: ${custom.error.message}`,
        });
        return;
      }

      let noModelAlias = false;
      let systemMachines: readonly CalibrationSlicerProfileRef[] =
        extended.machineProfiles;
      if (forModel !== null) {
        if (forModel.status === 'error') {
          setCatalog({
            ...emptyCatalog,
            loaded: true,
            error: `Could not resolve machine profiles for this printer model: ${forModel.error.message}`,
          });
          return;
        }
        noModelAlias = forModel.noModelAlias;
        // Prefer the model-scoped list when the server had one; fall back to
        // the catalog-wide `/extended` list when there was no alias (the
        // catalog-wide list is unfiltered, but not showing anything at all
        // would leave the operator with no lever).
        if (!noModelAlias) systemMachines = forModel.profiles;
      }

      setCatalog({
        loading: false,
        loaded: true,
        error: null,
        noModelAlias,
        systemMachines,
        systemProcesses: extended.processProfiles,
        systemFilaments: extended.filamentProfiles,
        custom: custom.profiles,
      });
    } catch (error) {
      if (catalogEpochRef.current !== epoch || unmountedRef.current) return;
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Failed to load the calibration profile catalog.';
      setCatalog({ ...emptyCatalog, loaded: true, error: message });
    }
    // printerId is not read inside loadCatalog itself (the parent hands us
    // per-printer requests via `profileId` + `printerModelId`), but it MUST
    // sit in the deps: a new printer starts a fresh cascade, and the
    // useEffect below re-runs `loadCatalog` on identity change. Excluding
    // printerId would keep the old callback alive across printer swaps —
    // the wrong catalog would render for the wrong printer until React
    // happened to re-render for another reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerId, printerModelId, profileId]);

  useEffect(() => {
    void loadCatalog();
    // A new printer starts a fresh cascade. Nothing chosen carries over,
    // because the profile catalogue is model-scoped: a machine that was
    // applicable to the previous printer may not exist here at all.
    setChosenMachine('');
    setChosenProcess('');
    setChosenFilament('');
    setForMachine(emptyFilteredForMachine);
    // printerId is deliberately in the deps — the callback closes over
    // profileId/printerId/printerModelId so a new printer produces a new
    // callback identity, which fires this effect.
  }, [loadCatalog, printerId]);

  const chosenMachineOption = useMemo(
    (): DecodedProfileOption | null => decodeProfileOption(chosenMachine),
    [chosenMachine],
  );

  const chosenMachineName = useMemo(
    (): string | null =>
      resolveChosenMachineName(
        chosenMachineOption,
        catalog.systemMachines,
        customProfilesOfType(catalog.custom, 'machine'),
      ),
    [catalog.custom, catalog.systemMachines, chosenMachineOption],
  );

  /**
   * When the operator picks a machine we fetch the process/filament lists the
   * server has already filtered for that exact machine name. These lists
   * change with every machine selection, so they are not cached with
   * `catalog` above — the catalog stays the same across machine picks.
   */
  const loadForMachine = useCallback(
    async (machineName: string): Promise<void> => {
      const epoch = ++forMachineEpochRef.current;
      setForMachine({
        loading: true,
        error: null,
        systemProcesses: [],
        systemFilaments: [],
      });
      try {
        const api = calibrationApi();
        const [processes, filaments] = await Promise.all([
          api.listCalibrationProcessProfilesForMachines({
            profileId,
            machineNames: [machineName],
          }),
          api.listCalibrationFilamentProfilesForMachines({
            profileId,
            machineNames: [machineName],
          }),
        ]);
        if (forMachineEpochRef.current !== epoch || unmountedRef.current)
          return;
        if (processes.status === 'error') {
          setForMachine({
            loading: false,
            error: `Could not load applicable process profiles: ${processes.error.message}`,
            systemProcesses: [],
            systemFilaments: [],
          });
          return;
        }
        if (filaments.status === 'error') {
          setForMachine({
            loading: false,
            error: `Could not load applicable filament profiles: ${filaments.error.message}`,
            systemProcesses: [],
            systemFilaments: [],
          });
          return;
        }
        setForMachine({
          loading: false,
          error: null,
          systemProcesses: processes.profiles,
          systemFilaments: filaments.profiles,
        });
      } catch (error) {
        if (forMachineEpochRef.current !== epoch || unmountedRef.current)
          return;
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Failed to load profiles for the chosen machine.';
        setForMachine({
          loading: false,
          error: message,
          systemProcesses: [],
          systemFilaments: [],
        });
      }
    },
    [profileId],
  );

  useEffect(() => {
    setChosenProcess('');
    setChosenFilament('');
    if (chosenMachineName === null) {
      setForMachine(emptyFilteredForMachine);
      return;
    }
    void loadForMachine(chosenMachineName);
  }, [chosenMachineName, loadForMachine]);

  /**
   * The system profile lists come pre-filtered from `/for-machines`. The
   * custom lists come UNFILTERED from `/custom` (the server has no notion of
   * which printer a user-authored profile is intended for), so the client
   * applies the applicability filter — the highest-value assertion in
   * `calibrationProfileSelectionFlow.test.tsx` guards this exact gap.
   */
  const customMachines = useMemo(
    (): readonly CalibrationCustomProfileRef[] =>
      filterCustomMachineOrProcessForModel(
        customProfilesOfType(catalog.custom, 'machine'),
        printerModelId,
      ),
    [catalog.custom, printerModelId],
  );

  const customProcesses = useMemo(
    (): readonly CalibrationCustomProfileRef[] =>
      filterCustomMachineOrProcessForModel(
        customProfilesOfType(catalog.custom, 'process'),
        printerModelId,
      ),
    [catalog.custom, printerModelId],
  );

  const customFilaments = useMemo(
    (): readonly CalibrationCustomProfileRef[] =>
      filterCustomFilamentsForMachine(
        customProfilesOfType(catalog.custom, 'filament'),
        chosenMachineName ?? '',
      ),
    [catalog.custom, chosenMachineName],
  );

  // Selection snapshot for the filament calibration wizard. Resolves each
  // dropdown value back to its canonical `Name` string (system) or the
  // custom row's `name` (custom); the base filament also resolves its
  // Guid, which the wizard's clone step needs as `sourceProfileId`.
  const chosenProcessOption = useMemo(
    (): DecodedProfileOption | null => decodeProfileOption(chosenProcess),
    [chosenProcess],
  );
  const chosenFilamentOption = useMemo(
    (): DecodedProfileOption | null => decodeProfileOption(chosenFilament),
    [chosenFilament],
  );
  const chosenProcessName = useMemo(
    (): string | null =>
      resolveChosenMachineName(
        chosenProcessOption,
        forMachine.systemProcesses,
        customProfilesOfType(catalog.custom, 'process'),
      ),
    [catalog.custom, chosenProcessOption, forMachine.systemProcesses],
  );
  const chosenFilamentName = useMemo(
    (): string | null =>
      resolveChosenMachineName(
        chosenFilamentOption,
        forMachine.systemFilaments,
        customProfilesOfType(catalog.custom, 'filament'),
      ),
    [catalog.custom, chosenFilamentOption, forMachine.systemFilaments],
  );
  const chosenFilamentGuid = useMemo(
    (): string | null =>
      resolveChosenProfileGuid(
        chosenFilamentOption,
        forMachine.systemFilaments,
        customProfilesOfType(catalog.custom, 'filament'),
      ),
    [catalog.custom, chosenFilamentOption, forMachine.systemFilaments],
  );

  useEffect(() => {
    if (onSelectionChange === undefined) return;
    const readyForClone =
      chosenMachineName !== null &&
      chosenProcessName !== null &&
      chosenFilamentName !== null;
    onSelectionChange({
      machineName: chosenMachineName,
      processName: chosenProcessName,
      filamentName: chosenFilamentName,
      filamentGuid: chosenFilamentGuid,
      filamentOrigin: chosenFilamentOption?.origin ?? null,
      readyForClone,
    });
  }, [
    chosenFilamentGuid,
    chosenFilamentName,
    chosenFilamentOption,
    chosenMachineName,
    chosenProcessName,
    onSelectionChange,
  ]);

  return (
    <fieldset
      className="cal-step-fieldset"
      disabled={disabled}
      aria-busy={catalog.loading}
    >
      <legend>
        Choose machine profile, process profile, and filament profile
      </legend>
      <p className="cal-hint">
        System profiles come from the OrcaSlicer catalog. Your custom profiles
        are shown alongside them, filtered to those applicable to this printer.
      </p>

      {catalog.loading ? (
        <p role="status" className="cal-hint">
          Loading calibration profile catalog for this printer.
        </p>
      ) : null}

      {catalog.error !== null ? (
        <div className="cal-alert" role="alert">
          <p>{catalog.error}</p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void loadCatalog()}
          >
            Retry loading the catalog
          </button>
        </div>
      ) : null}

      {catalog.noModelAlias ? (
        // Distinct from a generic "no profiles applicable" state — the fix is
        // a catalog administrator adding an OrcaSlicer alias for this printer
        // model, not something the operator can resolve here.
        <p className="cal-notice" role="status">
          The OrcaSlicer catalog has no alias for this printer model, so system
          machine profiles are being shown unfiltered. Ask your administrator to
          add a model alias for tighter scoping, or upload a custom machine
          profile.
        </p>
      ) : null}

      <label>
        Machine profile
        <select
          value={chosenMachine}
          onChange={(event) => setChosenMachine(event.target.value)}
          aria-label="Machine profile"
        >
          <option value="">Select a machine profile</option>
          {catalog.systemMachines.length > 0 ? (
            <optgroup label="System profiles">
              {catalog.systemMachines.map((profile) => (
                <option
                  key={profile.name}
                  value={profileOptionValue('system', profile.name)}
                >
                  {systemOptionLabel(profile)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {customMachines.length > 0 ? (
            <optgroup label="Your custom profiles">
              {customMachines.map((profile) => (
                <option
                  key={profile.id}
                  value={profileOptionValue('custom', profile.id)}
                >
                  {customOptionLabel(profile)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>

      {chosenMachineName !== null ? (
        <>
          {forMachine.loading ? (
            <p role="status" className="cal-hint">
              Loading process and filament profiles for {chosenMachineName}.
            </p>
          ) : null}
          {forMachine.error !== null ? (
            <div className="cal-alert" role="alert">
              <p>{forMachine.error}</p>
            </div>
          ) : null}
          <label>
            Process profile
            <select
              value={chosenProcess}
              onChange={(event) => setChosenProcess(event.target.value)}
              aria-label="Process profile"
            >
              <option value="">Select a process profile</option>
              {forMachine.systemProcesses.length > 0 ? (
                <optgroup label="System profiles">
                  {forMachine.systemProcesses.map((profile) => (
                    <option
                      key={profile.name}
                      value={profileOptionValue('system', profile.name)}
                    >
                      {systemOptionLabel(profile)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {customProcesses.length > 0 ? (
                <optgroup label="Your custom profiles">
                  {customProcesses.map((profile) => (
                    <option
                      key={profile.id}
                      value={profileOptionValue('custom', profile.id)}
                    >
                      {customOptionLabel(profile)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        </>
      ) : null}

      {chosenProcess !== '' ? (
        <label>
          Filament profile
          <select
            value={chosenFilament}
            onChange={(event) => setChosenFilament(event.target.value)}
            aria-label="Filament profile"
          >
            <option value="">Select a filament profile</option>
            {forMachine.systemFilaments.length > 0 ? (
              <optgroup label="System profiles">
                {forMachine.systemFilaments.map((profile) => (
                  <option
                    key={profile.name}
                    value={profileOptionValue('system', profile.name)}
                  >
                    {systemOptionLabel(profile)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {customFilaments.length > 0 ? (
              <optgroup label="Your custom profiles">
                {customFilaments.map((profile) => (
                  <option
                    key={profile.id}
                    value={profileOptionValue('custom', profile.id)}
                  >
                    {customOptionLabel(profile)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
      ) : null}
    </fieldset>
  );
}
