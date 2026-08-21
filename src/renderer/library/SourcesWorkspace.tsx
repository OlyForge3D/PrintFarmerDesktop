import { useEffect, useRef, useState } from 'react';
import type { ResetCatalogResponse } from '@shared/ipc';
import { Icon } from '../ui/Icon';
import { reconcileHeadline, type SourceRootSummary } from './sourceRoots';
import type { LibraryScanActivity } from './useLibrary';

export interface SourcesWorkspaceProps {
  roots: SourceRootSummary[];
  modelCount: number;
  busy: boolean;
  error: string | null;
  scanActivity: LibraryScanActivity;
  onAddFolder: () => void;
  onRefresh: () => void;
  onRescanRoot: (rootId: string) => void;
  onRemoveRoot: (rootId: string) => void;
  onResetCatalog: () => Promise<ResetCatalogResponse | null>;
}

/**
 * Folder access is durable configuration an operator revisits, so it is a place
 * rather than a dialog. Only the destructive reset still takes over focus,
 * because that is a decision and not a view.
 */
export function SourcesWorkspace({
  roots,
  modelCount,
  busy,
  error,
  scanActivity,
  onAddFolder,
  onRefresh,
  onRescanRoot,
  onRemoveRoot,
  onResetCatalog,
}: SourcesWorkspaceProps): React.JSX.Element {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetSummary, setResetSummary] = useState<ResetCatalogResponse | null>(
    null,
  );
  const cancelResetRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmingReset) cancelResetRef.current?.focus();
  }, [confirmingReset]);

  const availableCount = roots.filter(
    (root) => root.status === 'available',
  ).length;
  const attentionCount = roots.length - availableCount;

  const resetCatalog = async (): Promise<void> => {
    const result = await onResetCatalog();
    if (!result) return;
    setConfirmingReset(false);
    setResetSummary(result);
  };

  return (
    <main
      id="sources-main"
      className="sources-pane"
      aria-label="Catalog sources"
      aria-busy={busy}
    >
      <header className="service-heading">
        <div>
          <h1 data-sources-heading tabIndex={-1}>
            Sources
          </h1>
          <p>
            Which folders PrintFarmer indexes on this computer. Scans are
            read-only; original model files are never moved.
          </p>
        </div>
        <div className="service-heading-actions">
          <button
            type="button"
            className="catalog-source-primary"
            disabled={busy}
            onClick={onAddFolder}
          >
            <Icon name="folder" />
            Add source folder
          </button>
          <button type="button" disabled={busy} onClick={onRefresh}>
            <Icon name="refresh" />
            Refresh catalog
          </button>
        </div>
      </header>

      <div className="catalog-source-summary" aria-label="Catalog summary">
        <CatalogMetric value={roots.length} label="Source folders" />
        <CatalogMetric value={modelCount} label="Indexed models" />
        <CatalogMetric value={availableCount} label="Available" />
        <CatalogMetric
          value={attentionCount}
          label="Need attention"
          tone={attentionCount > 0 ? 'warning' : 'default'}
        />
      </div>

      {error ? (
        <div className="catalog-sources-alert error" role="alert">
          <Icon name="missing" />
          <span>{error}</span>
        </div>
      ) : null}
      {resetSummary ? (
        <div className="catalog-sources-alert success" role="status">
          <span>
            Catalog cleared. Removed {resetSummary.modelsRemoved} indexed{' '}
            {resetSummary.modelsRemoved === 1 ? 'model' : 'models'} and{' '}
            {resetSummary.sourceRootsRemoved}{' '}
            {resetSummary.sourceRootsRemoved === 1
              ? 'source folder'
              : 'source folders'}
            .
          </span>
        </div>
      ) : null}
      {scanActivity.phase !== 'idle' ? (
        <div
          className="catalog-sources-progress"
          role="status"
          aria-live="polite"
        >
          <div>
            <strong>
              {scanActivity.phase === 'preparing'
                ? 'Preparing source'
                : 'Scanning source'}
            </strong>
            <span>
              {scanActivity.estimatedTotal === null
                ? 'Checking local files'
                : `${scanActivity.estimatedTotal} known models`}
            </span>
          </div>
          <progress aria-label="Scan progress" />
          <p>{scanActivity.label ?? 'Updating the local catalog'}</p>
        </div>
      ) : null}

      <div className="catalog-sources-content">
        <section
          className="catalog-source-list-section"
          aria-labelledby="configured-sources-title"
        >
          <div className="catalog-source-section-heading">
            <h2 id="configured-sources-title">Configured folders</h2>
            <span>{roots.length}</span>
          </div>
          {roots.length === 0 ? (
            <div className="catalog-source-empty">
              <span className="catalog-source-empty-icon" aria-hidden="true">
                <Icon name="folder" size={22} />
              </span>
              <div>
                <h3>No folders connected</h3>
                <p>
                  Add a folder to index STL, 3MF, and OBJ files without moving
                  them.
                </p>
              </div>
            </div>
          ) : (
            <ul className="source-root-list" aria-label="Source folders">
              {roots.map((root) => (
                <li
                  key={root.rootId}
                  className={`source-root-item ${root.status}`}
                >
                  <div className="source-root-summary">
                    <span
                      className={`source-root-dot ${root.status}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{root.label}</strong>
                      <span className="source-root-state">
                        {sourceRootStateLabel(root)}
                      </span>
                      <small title={root.path}>{root.path}</small>
                      <small>{sourceRootDetail(root)}</small>
                    </div>
                  </div>
                  <div className="source-root-actions">
                    <button
                      type="button"
                      className="source-root-action"
                      disabled={busy}
                      onClick={() => onRescanRoot(root.rootId)}
                    >
                      {root.status === 'available' ? 'Scan again' : 'Reconnect'}
                    </button>
                    <button
                      type="button"
                      className="source-root-action ghost"
                      disabled={busy}
                      aria-label={`Hide ${root.label} from the catalog`}
                      onClick={() => onRemoveRoot(root.rootId)}
                    >
                      Hide source
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="catalog-reset-zone"
          aria-labelledby="catalog-reset-title"
        >
          <div>
            <h2 id="catalog-reset-title">Start over on this computer</h2>
            <p>
              Clear the local index and folder access without touching your
              model files or PrintFarmer server.
            </p>
          </div>
          {!confirmingReset ? (
            <button
              type="button"
              className="catalog-reset-trigger"
              disabled={busy}
              onClick={() => {
                setResetSummary(null);
                setConfirmingReset(true);
              }}
            >
              <Icon name="reset" />
              Reset catalog
            </button>
          ) : (
            <div
              className="catalog-reset-confirmation"
              role="alert"
              aria-live="assertive"
            >
              <strong>Clear this local catalog?</strong>
              <p>
                This removes indexed models, source folders, favorites,
                thumbnail records, tag assignments, and collection memberships.
              </p>
              <p>
                Your original files, tags and collection definitions, server
                connections, remote data, upload history, and calibration
                projects stay.
              </p>
              <div>
                <button
                  ref={cancelResetRef}
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingReset(false)}
                >
                  Keep catalog
                </button>
                <button
                  type="button"
                  className="catalog-reset-confirm"
                  disabled={busy}
                  onClick={() => void resetCatalog()}
                >
                  {busy ? 'Clearing catalog...' : 'Clear local catalog'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function CatalogMetric({
  value,
  label,
  tone = 'default',
}: {
  value: number;
  label: string;
  tone?: 'default' | 'warning';
}): React.JSX.Element {
  return (
    <div className={`catalog-source-metric ${tone}`}>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function sourceRootStateLabel(root: SourceRootSummary): string {
  switch (root.status) {
    case 'available':
      return 'Available';
    case 'missing':
      return 'Missing files';
    case 'offline':
      return 'Needs scan';
    default:
      return 'Unknown';
  }
}

function sourceRootDetail(root: SourceRootSummary): string {
  if (root.status === 'missing' && root.missingLocations > 0) {
    return `${root.missingLocations} unavailable file locations`;
  }
  if (root.totalModels > 0) {
    return `${root.availableModels} of ${root.totalModels} models available`;
  }
  return root.lastReport ? reconcileHeadline(root.lastReport) : 'Ready to scan';
}
