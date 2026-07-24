import { useEffect, useRef } from 'react';
import type { VendorMetadata } from '@shared/ipc';
import { Icon } from '../ui/Icon';
import { ModelStats } from '../library/ModelStats';
import { PartTree } from '../library/PartTree';
import { VendorPanel } from '../library/VendorPanel';
import { ModelViewer, type Projection } from './ModelViewer';
import type { SceneMesh } from './types';

export interface PreviewWorkspaceProps {
  name: string;
  loading: boolean;
  error: string | null;
  mesh: SceneMesh | null;
  vendorMetadata: VendorMetadata | null;
  wireframe: boolean;
  projection: Projection;
  resetToken: number;
  hiddenObjects: ReadonlySet<string>;
  onClose: () => void;
  onRetry: () => void;
  onToggleWireframe: () => void;
  onToggleProjection: () => void;
  onReset: () => void;
  onToggleObject: (id: string) => void;
  onToggleAllObjects: (visible: boolean) => void;
}

export function PreviewWorkspace({
  name,
  loading,
  error,
  mesh,
  vendorMetadata,
  wireframe,
  projection,
  resetToken,
  hiddenObjects,
  onClose,
  onRetry,
  onToggleWireframe,
  onToggleProjection,
  onReset,
  onToggleObject,
  onToggleAllObjects,
}: PreviewWorkspaceProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) {
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        dialogRef.current &&
        !dialogRef.current.contains(target)
      ) {
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [onClose]);

  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) {
      closeRef.current?.focus();
    }
  }, [loading, error, mesh]);

  return (
    <>
      <div className="preview-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="preview-workspace"
        role="dialog"
        aria-modal="true"
        aria-label={`3D preview of ${name}`}
      >
        <header className="preview-header">
          <button
            ref={closeRef}
            type="button"
            className="preview-back"
            onClick={onClose}
          >
            <span aria-hidden="true">&larr;</span>
            <span>Back to library</span>
          </button>
          <div className="preview-title">
            <span>3D Preview</span>
            <strong title={name}>{name}</strong>
          </div>
          <div
            className="preview-toolbar"
            role="toolbar"
            aria-label="3D view controls"
          >
            <button
              type="button"
              aria-pressed={wireframe}
              onClick={onToggleWireframe}
              disabled={!mesh}
            >
              <Icon name="view" />
              {wireframe ? 'Solid' : 'Wireframe'}
            </button>
            <button type="button" onClick={onToggleProjection} disabled={!mesh}>
              {projection === 'perspective' ? 'Orthographic' : 'Perspective'}
            </button>
            <button type="button" onClick={onReset} disabled={!mesh}>
              <Icon name="reset" />
              Reset
            </button>
          </div>
        </header>

        <div className="preview-body">
          <div className="preview-stage">
            {loading ? (
              <div className="preview-state" role="status">
                <span className="loading-indicator" aria-hidden="true" />
                <strong>Loading {name}</strong>
                <span>Preparing geometry and materials...</span>
              </div>
            ) : error ? (
              <div className="preview-state preview-failure" role="alert">
                <Icon name="missing" size={28} />
                <strong>Could not open this model</strong>
                <span>{error}</span>
                <div>
                  <button type="button" onClick={onRetry}>
                    Retry
                  </button>
                  <button type="button" onClick={onClose}>
                    Close
                  </button>
                </div>
              </div>
            ) : mesh ? (
              <ModelViewer
                mesh={mesh}
                wireframe={wireframe}
                projection={projection}
                hiddenObjects={hiddenObjects}
                resetToken={resetToken}
                className="viewer-canvas"
                background="#0b0e12"
              />
            ) : null}
          </div>

          {mesh ? (
            <aside className="preview-details" aria-label="Preview details">
              <section>
                <h2>Geometry</h2>
                <ModelStats mesh={mesh} />
              </section>
              {mesh.objects.length > 0 ? (
                <section>
                  <h2>Scene</h2>
                  <PartTree
                    objects={mesh.objects}
                    rootObjectIds={mesh.rootObjectIds}
                    plates={mesh.plates}
                    hidden={hiddenObjects}
                    onToggle={onToggleObject}
                    onToggleAll={onToggleAllObjects}
                  />
                </section>
              ) : null}
              {vendorMetadata ? (
                <section>
                  <VendorPanel metadata={vendorMetadata} />
                </section>
              ) : null}
            </aside>
          ) : null}
        </div>
      </section>
    </>
  );
}
