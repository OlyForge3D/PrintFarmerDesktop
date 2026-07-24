import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';

export interface LibraryOnboardingProps {
  busy: boolean;
  onAddFolder: () => void;
  onClose: () => void;
}

export function LibraryOnboarding({
  busy,
  onAddFolder,
  onClose,
}: LibraryOnboardingProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    primaryActionRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (
        event.target instanceof Node &&
        dialogRef.current &&
        !dialogRef.current.contains(event.target)
      ) {
        primaryActionRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [busy, onClose]);

  return (
    <>
      <div className="onboarding-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="library-onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-onboarding-title"
        aria-describedby="library-onboarding-description"
      >
        <header className="library-onboarding-header">
          <div>
            <p className="pane-eyebrow">Welcome</p>
            <h2 id="library-onboarding-title">Set up your model library</h2>
            <p id="library-onboarding-description">
              Add a source folder to index STL, 3MF, and OBJ files without
              leaving the renderer sandbox.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close onboarding"
            disabled={busy}
            onClick={onClose}
          >
            &times;
          </button>
        </header>

        <div className="library-onboarding-body">
          <ol className="library-onboarding-steps">
            <li>
              <Icon name="folder" />
              <div>
                <strong>Pick a folder</strong>
                <span>
                  Reuse the existing folder picker to choose your first source
                  root.
                </span>
              </div>
            </li>
            <li>
              <Icon name="collection" />
              <div>
                <strong>Review import rules</strong>
                <span>
                  Confirm how folders should become collections and tags before
                  scanning.
                </span>
              </div>
            </li>
            <li>
              <Icon name="refresh" />
              <div>
                <strong>Keep roots healthy</strong>
                <span>
                  Rescan, reconnect, or remove roots later from the sidebar.
                </span>
              </div>
            </li>
          </ol>

          <div className="library-onboarding-actions">
            <button
              ref={primaryActionRef}
              type="button"
              disabled={busy}
              onClick={onAddFolder}
            >
              Add your first folder
            </button>
            <button
              type="button"
              className="library-onboarding-secondary"
              disabled={busy}
              onClick={onClose}
            >
              Maybe later
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
