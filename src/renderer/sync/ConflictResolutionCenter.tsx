import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_NAME_MAX_LENGTH,
  type ConflictEntityType,
  type ConflictReasonCode,
  type ConflictResolutionActionInput,
  type ConflictResolutionCenterProps,
  type ConflictViewModel,
  type ManualCollectionMergeInput,
  type ModelCollectionConflictValue,
  type ResolveConflictRequest,
} from './types';
import './ConflictResolutionCenter.css';

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type ValueSource = 'localValue' | 'serverValue' | 'submittedValue';
type ResolutionKind = ConflictResolutionActionInput['kind'];

interface ComparisonRow {
  label: string;
  local: string;
  server: string;
  submitted: string;
}

interface ManualMergeErrors {
  name: string | null;
  description: string | null;
}

export function ConflictResolutionCenter({
  profileId,
  profileName,
  conflicts,
  unresolvedCount,
  selectedConflictId,
  loading,
  loadError,
  now = Date.now(),
  returnFocusTo,
  onSelectConflict,
  onRefresh,
  onResolve,
  onClose,
}: ConflictResolutionCenterProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef<HTMLElement | null>(
    returnFocusTo === undefined ? activeElement() : returnFocusTo,
  );
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const ownerDocument = dialog.ownerDocument;
    const restoreFocusTarget = restoreFocusRef.current;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (event.shiftKey && ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        closeRef.current?.focus();
      }
    };

    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('focusin', onFocusIn);
    return () => {
      ownerDocument.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('focusin', onFocusIn);
      if (restoreFocusTarget?.isConnected) restoreFocusTarget.focus();
    };
  }, []);

  const selectedConflict =
    conflicts.find((conflict) => conflict.conflictId === selectedConflictId) ??
    null;
  const selectedIndex = conflicts.findIndex(
    (conflict) => conflict.conflictId === selectedConflictId,
  );
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const safeCount = Math.max(0, unresolvedCount);

  const selectAndFocus = (index: number): void => {
    const conflict = conflicts[index];
    if (!conflict) return;
    optionRefs.current.get(conflict.conflictId)?.focus();
    onSelectConflict({ profileId, conflictId: conflict.conflictId });
  };

  const onOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLLIElement>,
    index: number,
  ): void => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = (index + 1) % conflicts.length;
        break;
      case 'ArrowUp':
        nextIndex = (index - 1 + conflicts.length) % conflicts.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = conflicts.length - 1;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        selectAndFocus(index);
        return;
      default:
        return;
    }
    event.preventDefault();
    selectAndFocus(nextIndex);
  };

  const liveMessage = loading
    ? `Refreshing conflicts for ${profileName}.`
    : selectedConflict?.resolutionState === 'resolving'
      ? `Resolving ${entityTypeLabel(selectedConflict.entityType)} conflict.`
      : `${formatCount(safeCount)} for ${profileName}.`;

  return (
    <>
      <div
        className="profile-backdrop conflict-center-backdrop"
        aria-hidden="true"
      />
      <section
        ref={dialogRef}
        className="conflict-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading}
        tabIndex={-1}
      >
        <header className="profile-dialog-header conflict-center-header">
          <div>
            <p className="pane-eyebrow">PrintFarmer sync center</p>
            <h2 id={titleId}>Resolve sync conflicts</h2>
            <p id={descriptionId}>
              Review local and server changes for {profileName} before choosing
              which version to keep.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close conflict resolution center"
            onClick={onClose}
          >
            &times;
          </button>
        </header>

        <p
          id={statusId}
          className="conflict-center-live"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {liveMessage}
        </p>

        {loadError ? (
          <div className="profile-alert profile-error" role="alert">
            <span>Conflicts could not be refreshed. {loadError}</span>
          </div>
        ) : null}

        <div className="conflict-center-content">
          <section
            className="conflict-center-list-pane"
            aria-labelledby={`${titleId}-list`}
            aria-describedby={statusId}
          >
            <div className="conflict-center-list-header">
              <div>
                <h3 id={`${titleId}-list`}>Unresolved conflicts</h3>
                <span className="conflict-center-count">
                  {safeCount.toLocaleString()} unresolved
                </span>
              </div>
              <button
                type="button"
                className="conflict-center-button"
                disabled={loading}
                onClick={() => onRefresh({ profileId })}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {loading && conflicts.length === 0 ? (
              <div className="conflict-center-state">
                <strong>Loading conflicts…</strong>
                <span>Checking the latest state for this server profile.</span>
              </div>
            ) : !loadError && conflicts.length === 0 ? (
              <div className="purposeful-empty-state conflict-center-state">
                <h3>No conflicts to resolve</h3>
                <p>Local and server library changes are in sync.</p>
              </div>
            ) : conflicts.length > 0 ? (
              <ul
                className="conflict-center-list"
                role="listbox"
                aria-label={`Unresolved conflicts for ${profileName}`}
              >
                {conflicts.map((conflict, index) => {
                  const selected = conflict.conflictId === selectedConflictId;
                  return (
                    <li
                      key={conflict.conflictId}
                      ref={(element) => {
                        if (element) {
                          optionRefs.current.set(conflict.conflictId, element);
                        } else {
                          optionRefs.current.delete(conflict.conflictId);
                        }
                      }}
                      className={
                        selected
                          ? 'conflict-center-option selected'
                          : 'conflict-center-option'
                      }
                      role="option"
                      aria-selected={selected}
                      aria-posinset={index + 1}
                      aria-setsize={conflicts.length}
                      tabIndex={index === tabbableIndex ? 0 : -1}
                      onClick={() => selectAndFocus(index)}
                      onKeyDown={(event) => onOptionKeyDown(event, index)}
                    >
                      <div className="conflict-center-option-heading">
                        <strong>{entityDisplayName(conflict)}</strong>
                        <span
                          className={`conflict-center-state-badge ${conflict.resolutionState}`}
                        >
                          {resolutionStateLabel(conflict.resolutionState)}
                        </span>
                      </div>
                      <span className="conflict-center-option-meta">
                        {entityTypeLabel(conflict.entityType)} ·{' '}
                        {formatAge(conflict.createdAt, now)}
                      </span>
                      <span className="conflict-center-reason">
                        {reasonLabel(conflict.reasonCode)}
                      </span>
                      <span className="conflict-center-summary">
                        <span>
                          <span className="conflict-center-summary-label">
                            Local
                          </span>{' '}
                          {valueSummary(conflict, 'localValue')}
                        </span>
                        <span>
                          <span className="conflict-center-summary-label">
                            Server
                          </span>{' '}
                          {valueSummary(conflict, 'serverValue')}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          <section
            className="conflict-center-detail-pane"
            aria-labelledby={`${titleId}-detail`}
          >
            {selectedConflict ? (
              <ConflictDetail
                key={[
                  selectedConflict.conflictId,
                  selectedConflict.entityType,
                  selectedConflict.conflictVersion,
                  selectedConflict.unresolvedToken,
                  selectedConflict.attemptToken,
                ].join(':')}
                profileId={profileId}
                conflict={selectedConflict}
                refreshInProgress={loading}
                onResolve={onResolve}
                headingId={`${titleId}-detail`}
              />
            ) : (
              <div className="conflict-center-detail-empty">
                <h3 id={`${titleId}-detail`}>Select a conflict</h3>
                <p>
                  Choose an item from the unresolved list to compare its
                  versions and review safe resolution choices.
                </p>
              </div>
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function ConflictDetail({
  profileId,
  conflict,
  refreshInProgress,
  onResolve,
  headingId,
}: {
  profileId: string;
  conflict: ConflictViewModel;
  refreshInProgress: boolean;
  onResolve: (request: ResolveConflictRequest) => void;
  headingId: string;
}): React.JSX.Element {
  const rows = comparisonRows(conflict);
  return (
    <article className="conflict-center-detail">
      <header className="conflict-center-detail-header">
        <div>
          <span>{entityTypeLabel(conflict.entityType)}</span>
          <h3 id={headingId}>{entityDisplayName(conflict)}</h3>
          <code title={conflict.entityId}>{conflict.entityId}</code>
        </div>
        <span
          className={`conflict-center-state-badge ${conflict.resolutionState}`}
        >
          {resolutionStateLabel(conflict.resolutionState)}
        </span>
      </header>

      <p className="conflict-center-detail-reason">
        <strong>Why this needs review</strong>
        <span>{reasonLabel(conflict.reasonCode)}</span>
      </p>

      <div className="conflict-center-comparison">
        <table>
          <caption>Local, server, and submitted values</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Local</th>
              <th scope="col">Server</th>
              <th scope="col">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.local}</td>
                <td>{row.server}</td>
                <td>{row.submitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ResolutionPanel
        profileId={profileId}
        conflict={conflict}
        refreshInProgress={refreshInProgress}
        onResolve={onResolve}
      />
    </article>
  );
}

function ResolutionPanel({
  profileId,
  conflict,
  refreshInProgress,
  onResolve,
}: {
  profileId: string;
  conflict: ConflictViewModel;
  refreshInProgress: boolean;
  onResolve: (request: ResolveConflictRequest) => void;
}): React.JSX.Element {
  const choiceGroupName = useId();
  const nameErrorId = useId();
  const descriptionErrorId = useId();
  const [choice, setChoice] = useState<ResolutionKind>('acceptServer');
  const [confirmed, setConfirmed] = useState(false);
  const [manualValue, setManualValue] = useState<ManualCollectionMergeInput>(
    () => manualMergeSeed(conflict),
  );
  const errors =
    choice === 'manualMerge'
      ? validateManualMerge(manualValue)
      : { name: null, description: null };
  const hasValidationError =
    errors.name !== null || errors.description !== null;
  const unavailable = conflict.resolutionState !== 'ready';
  const disabled = refreshInProgress || unavailable;

  const changeChoice = (next: ResolutionKind): void => {
    setChoice(next);
    setConfirmed(false);
  };
  const updateManualValue = (
    update: Partial<ManualCollectionMergeInput>,
  ): void => {
    setManualValue((current) => ({ ...current, ...update }));
    setConfirmed(false);
  };

  const submit = (): void => {
    if (disabled || !confirmed || hasValidationError) return;
    let actionInput: ConflictResolutionActionInput;
    if (choice === 'manualMerge') {
      if (conflict.entityType !== 'ModelCollection') return;
      actionInput = {
        kind: 'manualMerge',
        value: {
          name: manualValue.name,
          description:
            manualValue.description === '' ? null : manualValue.description,
          isShared: manualValue.isShared,
        },
      };
    } else {
      actionInput = { kind: choice };
    }
    onResolve({
      profileId,
      conflictId: conflict.conflictId,
      conflictVersion: conflict.conflictVersion,
      expectedUnresolvedToken: conflict.unresolvedToken,
      batchIncarnation: conflict.batchIncarnation,
      expectedAttemptToken: conflict.attemptToken,
      actionInput,
    });
  };

  return (
    <form
      className="conflict-center-resolution"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>Choose a resolution</h4>
      {conflict.entityType === 'Tag' ? (
        <p className="conflict-center-guidance">
          Tags are pull-only. Accepting the server version is the only available
          resolution.
        </p>
      ) : null}
      {refreshInProgress ? (
        <p className="conflict-center-guidance" role="status">
          Wait for the refresh to finish before resolving this conflict.
        </p>
      ) : null}
      {conflict.resolutionState === 'resolving' ? (
        <p className="conflict-center-guidance" role="status">
          The parent is resolving this conflict. The list will update after its
          response.
        </p>
      ) : null}
      {conflict.resolutionState === 'stale' ? (
        <p className="conflict-center-blocked" role="alert">
          This conflict changed. Refresh before choosing a resolution.
        </p>
      ) : null}
      {conflict.resolutionState === 'unresolvable' ? (
        <p className="conflict-center-blocked" role="alert">
          This conflict cannot be resolved from the desktop. Refresh or review
          it on the server.
        </p>
      ) : null}
      {conflict.resolutionError ? (
        <p className="conflict-center-blocked" role="alert">
          Resolution failed. {conflict.resolutionError}
        </p>
      ) : null}

      <fieldset disabled={disabled}>
        <legend className="conflict-center-sr-only">Resolution action</legend>
        <label className="conflict-center-choice">
          <input
            type="radio"
            name={choiceGroupName}
            value="acceptServer"
            checked={choice === 'acceptServer'}
            onChange={() => changeChoice('acceptServer')}
          />
          <span>
            <strong>Accept server</strong>
            <small>Replace the local value with the latest server value.</small>
          </span>
        </label>

        {conflict.entityType !== 'Tag' ? (
          <label className="conflict-center-choice">
            <input
              type="radio"
              name={choiceGroupName}
              value="keepLocal"
              checked={choice === 'keepLocal'}
              onChange={() => changeChoice('keepLocal')}
            />
            <span>
              <strong>Keep local</strong>
              <small>
                Queue the current local value again against fresh server state.
              </small>
            </span>
          </label>
        ) : null}

        {conflict.entityType === 'ModelCollection' ? (
          <>
            <label className="conflict-center-choice">
              <input
                type="radio"
                name={choiceGroupName}
                value="manualMerge"
                checked={choice === 'manualMerge'}
                onChange={() => changeChoice('manualMerge')}
              />
              <span>
                <strong>Manual merge</strong>
                <small>Submit supported collection fields only.</small>
              </span>
            </label>
            {choice === 'manualMerge' ? (
              <div className="conflict-center-manual-fields">
                <label>
                  <span>Collection name</span>
                  <input
                    required
                    maxLength={COLLECTION_NAME_MAX_LENGTH}
                    value={manualValue.name}
                    aria-invalid={errors.name !== null}
                    aria-describedby={
                      errors.name === null ? undefined : nameErrorId
                    }
                    onChange={(event) =>
                      updateManualValue({ name: event.target.value })
                    }
                  />
                  {errors.name ? (
                    <small
                      id={nameErrorId}
                      className="conflict-center-field-error"
                    >
                      {errors.name}
                    </small>
                  ) : null}
                </label>
                <label>
                  <span>Description (optional)</span>
                  <textarea
                    maxLength={COLLECTION_DESCRIPTION_MAX_LENGTH}
                    value={manualValue.description ?? ''}
                    aria-invalid={errors.description !== null}
                    aria-describedby={
                      errors.description === null
                        ? undefined
                        : descriptionErrorId
                    }
                    onChange={(event) =>
                      updateManualValue({ description: event.target.value })
                    }
                  />
                  {errors.description ? (
                    <small
                      id={descriptionErrorId}
                      className="conflict-center-field-error"
                    >
                      {errors.description}
                    </small>
                  ) : null}
                </label>
                <label className="conflict-center-sharing">
                  <input
                    type="checkbox"
                    checked={manualValue.isShared}
                    onChange={(event) =>
                      updateManualValue({ isShared: event.target.checked })
                    }
                  />
                  <span>Share this collection on the server</span>
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </fieldset>

      <label className="conflict-center-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || hasValidationError}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>I have reviewed the comparison and confirm this resolution.</span>
      </label>

      <button
        type="submit"
        className="conflict-center-button conflict-center-resolve"
        disabled={disabled || !confirmed || hasValidationError}
      >
        {conflict.resolutionState === 'resolving'
          ? 'Resolving…'
          : 'Resolve conflict'}
      </button>
    </form>
  );
}

function activeElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) => !element.closest('[hidden], [aria-hidden="true"], [inert]'),
  );
}

function entityTypeLabel(entityType: ConflictEntityType): string {
  switch (entityType) {
    case 'ModelCollection':
      return 'Model collection';
    case 'ModelCollectionMembership':
      return 'Collection membership';
    case 'Tag':
      return 'Tag';
  }
}

function reasonLabel(reasonCode: ConflictReasonCode): string {
  switch (reasonCode) {
    case 'concurrentUpdate':
      return 'The server changed after this local edit began.';
    case 'deletedOnServer':
      return 'This item was removed from the server.';
    case 'changedBeforeDelete':
      return 'The server changed this item before the local deletion arrived.';
    case 'permissionChanged':
      return 'Server access or sharing permissions changed.';
    case 'missingDependency':
      return 'A collection or model needed by this change is unavailable.';
    case 'unknown':
    default:
      return 'The server could not apply this pending change safely.';
  }
}

function resolutionStateLabel(
  state: ConflictViewModel['resolutionState'],
): string {
  switch (state) {
    case 'ready':
      return 'Needs review';
    case 'resolving':
      return 'Resolving';
    case 'stale':
      return 'Refresh required';
    case 'unresolvable':
      return 'Server review';
  }
}

function entityDisplayName(conflict: ConflictViewModel): string {
  switch (conflict.entityType) {
    case 'ModelCollection':
    case 'Tag': {
      const value =
        conflict.localValue ?? conflict.serverValue ?? conflict.submittedValue;
      if (value?.name.trim()) return value.name;
      break;
    }
    case 'ModelCollectionMembership': {
      const value =
        conflict.localValue ?? conflict.serverValue ?? conflict.submittedValue;
      if (value?.modelName.trim() && value.collectionName.trim()) {
        return `${value.modelName} in ${value.collectionName}`;
      }
      break;
    }
  }
  return `${entityTypeLabel(conflict.entityType)} ${conflict.entityId.slice(0, 8)}`;
}

function valueSummary(
  conflict: ConflictViewModel,
  source: ValueSource,
): string {
  switch (conflict.entityType) {
    case 'ModelCollection': {
      const value = conflict[source];
      return value
        ? `${value.name || 'Unnamed'} · ${value.isShared ? 'Shared' : 'Private'}`
        : 'Not present';
    }
    case 'ModelCollectionMembership': {
      const value = conflict[source];
      return value
        ? `${value.isMember ? 'Included' : 'Not included'} · ${value.modelName}`
        : 'Not present';
    }
    case 'Tag': {
      const value = conflict[source];
      return value
        ? `${value.name || 'Unnamed'} · ${value.category ?? 'Uncategorized'}`
        : 'Not present';
    }
  }
}

function comparisonRows(conflict: ConflictViewModel): ComparisonRow[] {
  switch (conflict.entityType) {
    case 'ModelCollection':
      return [
        comparisonRow(conflict, 'Name', (value) => value.name || 'Unnamed'),
        comparisonRow(
          conflict,
          'Description',
          (value) => value.description ?? 'No description',
        ),
        comparisonRow(conflict, 'Sharing', (value) =>
          value.isShared ? 'Shared' : 'Private',
        ),
      ];
    case 'ModelCollectionMembership':
      return [
        comparisonRow(conflict, 'Collection', (value) => value.collectionName),
        comparisonRow(conflict, 'Model', (value) => value.modelName),
        comparisonRow(conflict, 'Membership', (value) =>
          value.isMember ? 'Included' : 'Not included',
        ),
      ];
    case 'Tag':
      return [
        comparisonRow(conflict, 'Name', (value) => value.name || 'Unnamed'),
        comparisonRow(
          conflict,
          'Category',
          (value) => value.category ?? 'Uncategorized',
        ),
        comparisonRow(
          conflict,
          'Description',
          (value) => value.description ?? 'No description',
        ),
        comparisonRow(conflict, 'Color', (value) => value.color ?? 'No color'),
        comparisonRow(conflict, 'Source', (value) =>
          value.isAutoGenerated ? 'Automatic' : 'Manual',
        ),
      ];
  }
}

function comparisonRow<T extends ConflictViewModel>(
  conflict: T,
  label: string,
  format: (value: NonNullable<T['localValue']>) => string,
): ComparisonRow {
  const formatValue = (value: T['localValue']): string =>
    value === null ? 'Not present' : format(value);
  return {
    label,
    local: formatValue(conflict.localValue),
    server: formatValue(conflict.serverValue),
    submitted: formatValue(conflict.submittedValue),
  };
}

function manualMergeSeed(
  conflict: ConflictViewModel,
): ManualCollectionMergeInput {
  if (conflict.entityType !== 'ModelCollection') {
    return { name: '', description: null, isShared: false };
  }
  const value: ModelCollectionConflictValue | null =
    conflict.localValue ?? conflict.serverValue ?? conflict.submittedValue;
  return value
    ? { ...value }
    : { name: '', description: null, isShared: false };
}

function validateManualMerge(
  value: ManualCollectionMergeInput,
): ManualMergeErrors {
  let name: string | null = null;
  if (value.name.trim().length === 0) {
    name = 'Enter a collection name.';
  } else if (value.name.length > COLLECTION_NAME_MAX_LENGTH) {
    name = `Use ${COLLECTION_NAME_MAX_LENGTH.toLocaleString()} characters or fewer.`;
  }
  const description =
    value.description !== null &&
    value.description.length > COLLECTION_DESCRIPTION_MAX_LENGTH
      ? `Use ${COLLECTION_DESCRIPTION_MAX_LENGTH.toLocaleString()} characters or fewer.`
      : null;
  return { name, description };
}

function formatCount(count: number): string {
  return `${count.toLocaleString()} unresolved conflict${count === 1 ? '' : 's'}`;
}

function formatAge(createdAt: number, now: number): string {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) {
    return 'Age unavailable';
  }
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
