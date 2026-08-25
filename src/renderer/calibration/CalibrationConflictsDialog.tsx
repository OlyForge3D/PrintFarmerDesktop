import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  CalibrationConflict,
  CalibrationConflictResolution,
  CalibrationResolveConflictRequest,
  CalibrationResolveConflictResponse,
} from '@shared/ipc';
import { calibrationApi } from './api';
import { useDialogFocusLifecycle, useFocusTrap } from './useDialogFocus';
import './CalibrationConflictsDialog.css';

const MAX_MERGED_FIELDS = 20;
const MAX_MERGED_FIELD_LENGTH = 4096;
// Mirrors the `mergedFields` key bound in `src/shared/ipc.ts`
// (`CalibrationResolveConflictRequest.mergedFields`). Keys come from parsed
// payload summaries, not from renderer-controlled input, so this is enforced
// by dropping the field rather than blocking the whole merge -- the same
// treatment already given to a non-scalar value.
const MAX_MERGED_FIELD_KEY_LENGTH = 200;

/**
 * Renderer-facing calibration conflict resolution (issue #762).
 *
 * PR #757 removed the old printer-calibration saga's `CalibrationConflictDialog`
 * along with its IPC channels, while leaving the sidecar/main-process resolve
 * logic live (`SidecarCalibrationAdapter.resolveCalibrationConflict`). This is
 * a fresh surface, not a resurrection of that deleted dialog: it is scoped to
 * the current filament calibration workspace and speaks only the generic
 * `CalibrationConflict` / `CalibrationConflictResolution` shapes, not the old
 * saga's project/attempt/orchestration dashboard.
 */
export interface CalibrationConflictsDialogProps {
  readonly profileId: string;
  readonly profileName: string;
  readonly onClose: () => void;
  readonly onResolved?: () => void;
}

interface MergeSeed {
  readonly fields: Readonly<Record<string, string>>;
  readonly error: string | null;
}

export function CalibrationConflictsDialog({
  profileId,
  profileName,
  onClose,
  onResolved,
}: CalibrationConflictsDialogProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());
  const resolvePendingRef = useRef(false);
  const [conflicts, setConflicts] = useState<readonly CalibrationConflict[]>(
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolutionReport, setResolutionReport] =
    useState<CalibrationResolveConflictResponse | null>(null);
  const [status, setStatus] = useState(`Loading conflicts for ${profileName}.`);

  useDialogFocusLifecycle(dialogRef, true);
  useFocusTrap(dialogRef, true, onClose);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    setResolveError(null);
    setResolutionReport(null);
    try {
      const response = await calibrationApi().listCalibrationConflicts({
        profileId,
      });
      setConflicts(response.conflicts);
      setSelectedId((current) =>
        response.conflicts.some((item) => item.conflictId === current)
          ? current
          : (response.conflicts[0]?.conflictId ?? null),
      );
      setStatus(conflictCountMessage(response.conflicts.length, profileName));
    } catch (error) {
      setLoadError(errorMessage(error));
      setStatus(`Conflicts for ${profileName} could not be loaded.`);
    } finally {
      setLoading(false);
    }
  }, [profileId, profileName]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (
    conflict: CalibrationConflict,
    resolution: CalibrationConflictResolution,
    mergedFields?: Readonly<Record<string, string>>,
  ): Promise<void> => {
    if (
      resolvePendingRef.current ||
      !conflict.availableResolutions.includes(resolution)
    )
      return;
    resolvePendingRef.current = true;
    const request: CalibrationResolveConflictRequest = {
      profileId,
      conflictId: conflict.conflictId,
      resolution,
      ...(resolution === 'manualFieldMerge' ? { mergedFields } : {}),
    };
    setPendingId(conflict.conflictId);
    setResolveError(null);
    setStatus(`Resolving ${kindLabel(conflict.kind)} conflict.`);
    try {
      const response =
        await calibrationApi().resolveCalibrationConflict(request);
      const remaining = conflicts.filter(
        (item) => item.conflictId !== response.conflict.conflictId,
      );
      setConflicts(remaining);
      setSelectedId(remaining[0]?.conflictId ?? null);
      setResolutionReport(response);
      const supersededCount = response.supersededObservations.length;
      setStatus(
        `Conflict resolved with ${resolutionLabel(response.conflict.resolution ?? resolution)}. ${
          supersededCount === 0
            ? 'No recorded observations were superseded.'
            : `${supersededCount} recorded observation${supersededCount === 1 ? ' was' : 's were'} superseded but not invalidated.`
        } ${conflictCountMessage(remaining.length, profileName)}`,
      );
      onResolved?.();
    } catch (error) {
      const message = errorMessage(error);
      setResolveError(message);
      setStatus(`Conflict could not be resolved. ${message}`);
    } finally {
      resolvePendingRef.current = false;
      setPendingId(null);
    }
  };

  const selected =
    conflicts.find((conflict) => conflict.conflictId === selectedId) ?? null;
  const selectedIndex = conflicts.findIndex(
    (conflict) => conflict.conflictId === selectedId,
  );

  const selectAndFocus = (index: number): void => {
    const conflict = conflicts[index];
    if (!conflict) return;
    setSelectedId(conflict.conflictId);
    setResolveError(null);
    optionRefs.current.get(conflict.conflictId)?.focus();
  };

  const onOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLLIElement>,
    index: number,
  ): void => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (index + 1) % conflicts.length;
    if (event.key === 'ArrowUp')
      next = (index - 1 + conflicts.length) % conflicts.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = conflicts.length - 1;
    if (event.key === 'Enter' || event.key === ' ') next = index;
    if (next === null) return;
    event.preventDefault();
    selectAndFocus(next);
  };

  return (
    <>
      <div className="cal-conflicts-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="cal-conflicts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading}
        tabIndex={-1}
      >
        <header className="cal-conflicts-header">
          <div>
            <h2 id={titleId}>Review calibration conflicts</h2>
            <p id={descriptionId}>
              Compare local and server values for {profileName}, then choose
              only a resolution offered by PrintFarmer.
            </p>
          </div>
          <button
            type="button"
            className="cal-conflicts-close"
            aria-label="Close calibration conflicts dialog"
            onClick={onClose}
          >
            &times;
          </button>
        </header>

        <p className="cal-visually-hidden" role="status" aria-live="polite">
          {status}
        </p>

        {resolutionReport ? (
          <section
            className="cal-conflicts-resolution-report"
            aria-label="Resolution result"
          >
            <strong>
              {resolutionReport.supersededObservations.length === 0
                ? 'No recorded observations were superseded.'
                : `${resolutionReport.supersededObservations.length} recorded observation${
                    resolutionReport.supersededObservations.length === 1
                      ? ''
                      : 's'
                  } superseded`}
            </strong>
            {resolutionReport.supersededObservations.length > 0 ? (
              <>
                <p>
                  These observations were not invalidated. Review them
                  separately before relying on the accepted revision.
                </p>
                <ul>
                  {resolutionReport.supersededObservations.map(
                    (observation) => (
                      <li key={observation.observationId}>
                        Step {shortId(observation.stepId)}, parameter{' '}
                        {observation.parameterKey}, attempt{' '}
                        {shortId(observation.attemptId)}
                      </li>
                    ),
                  )}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}

        <div className="cal-conflicts-content">
          <section
            className="cal-conflicts-list-pane"
            aria-label="Conflict list"
          >
            <div className="cal-conflicts-list-header">
              <div>
                <h3>Unresolved conflicts</h3>
                <span>{conflicts.length} unresolved</span>
              </div>
              <button
                type="button"
                className="cal-button"
                disabled={loading || pendingId !== null}
                onClick={() => void load()}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {loadError ? (
              <div className="cal-alert" role="alert">
                <p>Conflicts could not be loaded. {loadError}</p>
                <button
                  type="button"
                  className="cal-button"
                  onClick={() => void load()}
                >
                  Try again
                </button>
              </div>
            ) : loading && conflicts.length === 0 ? (
              <div className="cal-conflicts-state">
                <strong>Loading conflicts…</strong>
                <span>Checking the authoritative server conflict list.</span>
              </div>
            ) : conflicts.length === 0 ? (
              <div className="cal-conflicts-state">
                <h3>No calibration conflicts</h3>
                <p>
                  The server reports no unresolved conflicts for this profile.
                </p>
              </div>
            ) : (
              <ul
                className="cal-conflicts-list"
                role="listbox"
                aria-label={`Unresolved calibration conflicts for ${profileName}`}
              >
                {conflicts.map((conflict, index) => (
                  <li
                    key={conflict.conflictId}
                    ref={(element) => {
                      if (element)
                        optionRefs.current.set(conflict.conflictId, element);
                      else optionRefs.current.delete(conflict.conflictId);
                    }}
                    className={`cal-conflicts-option${conflict.conflictId === selectedId ? ' selected' : ''}`}
                    role="option"
                    aria-selected={conflict.conflictId === selectedId}
                    tabIndex={
                      index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1
                    }
                    onClick={() => selectAndFocus(index)}
                    onKeyDown={(event) => onOptionKeyDown(event, index)}
                  >
                    <strong>{kindLabel(conflict.kind)}</strong>
                    <span>Project {shortId(conflict.projectId)}</span>
                    <span>Server revision {conflict.serverRevision}</span>
                    <span className="cal-conflicts-status-text">
                      Status: unresolved
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            className="cal-conflicts-detail-pane"
            aria-label="Conflict details"
          >
            {selected ? (
              <ConflictDetail
                key={`${selected.conflictId}:${selected.serverRevision}:${selected.availableResolutions.join(',')}`}
                conflict={selected}
                pending={pendingId === selected.conflictId}
                error={resolveError}
                onResolve={(resolution, fields) =>
                  void resolve(selected, resolution, fields)
                }
              />
            ) : (
              <div className="cal-conflicts-state">
                <h3>Select a conflict</h3>
                <p>Choose an unresolved conflict to review its safe actions.</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function ConflictDetail({
  conflict,
  pending,
  error,
  onResolve,
}: {
  readonly conflict: CalibrationConflict;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onResolve: (
    resolution: CalibrationConflictResolution,
    fields?: Readonly<Record<string, string>>,
  ) => void;
}): React.JSX.Element {
  const [resolution, setResolution] =
    useState<CalibrationConflictResolution | null>(null);
  const seed = mergeSeed(conflict);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>(
    seed.fields,
  );
  const manual = resolution === 'manualFieldMerge';
  const valuesTooLong = Object.values(fields).some(
    (value) => value.length > MAX_MERGED_FIELD_LENGTH,
  );
  const manualBlocked =
    seed.error !== null || Object.keys(fields).length === 0 || valuesTooLong;

  return (
    <article className="cal-conflicts-detail">
      <header>
        <h3>{kindLabel(conflict.kind)} conflict</h3>
        <p>Entity {conflict.entityId}</p>
      </header>

      <div className="cal-conflicts-comparison">
        <section>
          <h4>Local payload summary</h4>
          <pre>{conflict.localPayloadSummary ?? 'Not provided'}</pre>
        </section>
        <section>
          <h4>Server payload summary</h4>
          <pre>{conflict.serverPayloadSummary ?? 'Not provided'}</pre>
        </section>
      </div>

      <form
        className="cal-conflicts-resolution"
        onSubmit={(event) => {
          event.preventDefault();
          if (!resolution || pending || (manual && manualBlocked)) return;
          onResolve(resolution, manual ? fields : undefined);
        }}
      >
        <fieldset disabled={pending}>
          <legend>Resolution</legend>
          {conflict.availableResolutions.length === 0 ? (
            <p className="cal-alert cal-alert--warning">
              PrintFarmer did not advertise a safe resolution for this conflict.
            </p>
          ) : null}
          {conflict.availableResolutions.map((available) => (
            <label className="cal-conflicts-choice" key={available}>
              <input
                type="radio"
                name={`resolution-${conflict.conflictId}`}
                value={available}
                checked={resolution === available}
                onChange={() => setResolution(available)}
              />
              <span>{resolutionLabel(available)}</span>
            </label>
          ))}
        </fieldset>

        {manual ? (
          <div className="cal-conflicts-manual">
            <h4>Manual field merge</h4>
            {seed.error ? (
              <p className="cal-alert cal-alert--warning" role="alert">
                {seed.error}
              </p>
            ) : (
              Object.entries(fields).map(([key, value]) => (
                <label key={key}>
                  {key}
                  <input
                    type="text"
                    value={value}
                    maxLength={MAX_MERGED_FIELD_LENGTH}
                    onChange={(event) =>
                      setFields((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))
            )}
            <p className="cal-field-help">
              At most {MAX_MERGED_FIELDS} top-level scalar fields; each value is
              limited to {MAX_MERGED_FIELD_LENGTH} characters.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="cal-alert" role="alert">
            Resolution failed. {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="cal-button cal-button--primary"
          disabled={pending || resolution === null || (manual && manualBlocked)}
        >
          {pending ? 'Resolving…' : 'Resolve conflict'}
        </button>
      </form>
    </article>
  );
}

function mergeSeed(conflict: CalibrationConflict): MergeSeed {
  const local = scalarFields(conflict.localPayloadSummary);
  const server = scalarFields(conflict.serverPayloadSummary);
  // Blocked when *either* side fails to parse, not just when both do. A
  // one-sided parse failure previously fell through to `local ?? {}` /
  // `server ?? {}`, silently seeding the merge form from only the side that
  // parsed -- which looks like a complete field set but is actually missing
  // every field the other, unparsed side would have contributed. That is
  // worse than refusing outright: the operator has no way to tell a
  // deliberately-empty side from a malformed one they can't see.
  if (local === null || server === null) {
    return {
      fields: {},
      error:
        'Manual merge is blocked because one or both payload summaries are missing, or are not a JSON object with top-level scalar fields.',
    };
  }
  const fields: Record<string, string> = { ...local };
  for (const [key, value] of Object.entries(server)) {
    if (!(key in fields)) fields[key] = value;
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    return {
      fields,
      error:
        'Manual merge is blocked because no top-level scalar fields are available.',
    };
  }
  if (keys.length > MAX_MERGED_FIELDS) {
    return {
      fields,
      error: `Manual merge is blocked because ${keys.length} fields exceed the ${MAX_MERGED_FIELDS}-field IPC limit.`,
    };
  }
  return { fields, error: null };
}

// Defense-in-depth alongside the upstream "never contains credentials"
// invariant on `CalibrationConflict.localPayloadSummary` /
// `serverPayloadSummary` (`src/shared/ipc.ts`): those fields are populated by
// `summarizeConflictPayload` (`calibrationService.ts`), which does a plain
// `JSON.stringify` with no redaction of its own, so the guarantee is
// currently a contract, not an enforced one. This dialog is the first
// renderer surface to read and re-send those fields, so a field whose *name*
// looks credential-shaped is dropped from the merge form rather than echoed
// back verbatim -- narrow enough not to reject legitimate calibration field
// names (`displayName`, `stepId`, ...), but a second line of defense should
// the upstream invariant ever be violated.
const SENSITIVE_FIELD_NAME =
  /token|secret|password|credential|api[-_]?key|authorization/i;

function scalarFields(summary: string | null): Record<string, string> | null {
  if (summary === null) return null;
  try {
    const parsed: unknown = JSON.parse(summary);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.length > MAX_MERGED_FIELD_KEY_LENGTH) continue;
      if (SENSITIVE_FIELD_NAME.test(key)) continue;
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        result[key] = value === null ? '' : String(value);
      }
    }
    return result;
  } catch {
    return null;
  }
}

function kindLabel(kind: CalibrationConflict['kind']): string {
  return {
    projectMetadata: 'Project metadata',
    stepOrdering: 'Step ordering',
    stepDraft: 'Step draft',
    outcomeSelection: 'Outcome selection',
    staleprinterSnapshot: 'Stale printer snapshot',
    deletionVsLocalEdit: 'Deletion versus local edit',
  }[kind];
}

function resolutionLabel(resolution: CalibrationConflictResolution): string {
  return {
    acceptServer: 'Accept server version',
    keepLocalAsNewRevision: 'Keep local as a new revision',
    manualFieldMerge: 'Merge fields manually',
  }[resolution];
}

function conflictCountMessage(count: number, profileName: string): string {
  return `${count} unresolved calibration conflict${count === 1 ? '' : 's'} for ${profileName}.`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected error occurred.';
}
