import { useEffect, useRef, useState } from 'react';
import type { ThumbnailCacheSettings } from '@shared/ipc';

interface ThumbnailCacheDialogProps {
  onClose: () => void;
}

export function ThumbnailCacheDialog({
  onClose,
}: ThumbnailCacheDialogProps): React.JSX.Element {
  const [settings, setSettings] = useState<ThumbnailCacheSettings | null>(null);
  const [maxMiB, setMaxMiB] = useState('512');
  const [retentionDays, setRetentionDays] = useState('30');
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  const applySettings = (next: ThumbnailCacheSettings): void => {
    setSettings(next);
    setLocation(next.location);
    setMaxMiB(String(Math.round(next.maxBytes / (1024 * 1024))));
    setRetentionDays(String(next.retentionDays));
  };

  useEffect(() => {
    let active = true;
    closeRef.current?.focus();
    void window.printFarmer
      .getThumbnailCacheSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setLocation(loaded.location);
        setMaxMiB(String(Math.round(loaded.maxBytes / (1024 * 1024))));
        setRetentionDays(String(loaded.retentionDays));
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
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
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      active = false;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  const chooseLocation = async (): Promise<void> => {
    setError(null);
    try {
      const selected = await window.printFarmer.chooseThumbnailCacheLocation();
      if (!selected.canceled && selected.path) {
        setLocation(selected.path);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const save = async (): Promise<void> => {
    const maxMiBValue = Number(maxMiB);
    const retentionValue = Number(retentionDays);
    if (
      !Number.isInteger(maxMiBValue) ||
      maxMiBValue < 16 ||
      maxMiBValue > 16 * 1024 ||
      !Number.isInteger(retentionValue) ||
      retentionValue < 1 ||
      retentionValue > 3650
    ) {
      setError(
        'Enter a cache size of 16–16384 MiB and retention of 1–3650 days.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await window.printFarmer.setThumbnailCacheSettings({
        location,
        maxBytes: maxMiBValue * 1024 * 1024,
        retentionDays: retentionValue,
      });
      applySettings(saved);
      setMessage('Thumbnail cache settings saved.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.printFarmer.clearThumbnailCache();
      applySettings(result.settings);
      setConfirmClear(false);
      setMessage(
        `Cleared ${result.clearedEntries} cached thumbnail${result.clearedEntries === 1 ? '' : 's'}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="profile-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="server-profiles-dialog thumbnail-cache-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="thumbnail-cache-title"
      >
        <header className="profile-dialog-header">
          <div>
            <h2 id="thumbnail-cache-title">Thumbnail cache</h2>
            <p>
              Manage locally generated previews. Source models are never
              changed.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close thumbnail cache settings"
            onClick={onClose}
            disabled={busy}
          >
            &times;
          </button>
        </header>

        {error ? (
          <div className="profile-alert profile-error" role="alert">
            {error}
          </div>
        ) : null}
        {settings?.warning ? (
          <div className="profile-alert profile-error" role="alert">
            {settings.warning} Thumbnails will still render, but may not be
            cached until the location is writable.
          </div>
        ) : null}
        {message ? (
          <p className="thumbnail-cache-message" role="status">
            {message}
          </p>
        ) : null}

        <div className="profile-dialog-content thumbnail-cache-content">
          <section aria-labelledby="thumbnail-cache-location-heading">
            <h3 id="thumbnail-cache-location-heading">Storage location</h3>
            <p className="thumbnail-cache-path">
              {location !== null && location !== settings?.location
                ? `Selected folder: ${location}`
                : (settings?.effectiveLocation ?? 'Loading cache settings…')}
            </p>
            <div className="profile-card-actions">
              <button
                type="button"
                onClick={() => void chooseLocation()}
                disabled={busy}
              >
                Choose folder…
              </button>
              <button
                type="button"
                onClick={() => setLocation(null)}
                disabled={busy || location === null}
              >
                Use app data folder
              </button>
            </div>
            <p className="thumbnail-cache-hint">
              A new location starts with an empty cache. Existing cache files
              remain in their previous folder; only PrintFarmer thumbnail
              entries are managed there.
            </p>
          </section>

          <section aria-labelledby="thumbnail-cache-limits-heading">
            <h3 id="thumbnail-cache-limits-heading">Automatic cleanup</h3>
            <label className="thumbnail-cache-field">
              Maximum size (MiB)
              <input
                type="number"
                min={16}
                max={16 * 1024}
                step={16}
                value={maxMiB}
                onChange={(event) => setMaxMiB(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="thumbnail-cache-field">
              Remove unused thumbnails after (days)
              <input
                type="number"
                min={1}
                max={3650}
                step={1}
                value={retentionDays}
                onChange={(event) => setRetentionDays(event.target.value)}
                disabled={busy}
              />
            </label>
            <p className="thumbnail-cache-usage">
              {settings
                ? `${formatBytes(settings.usedBytes)} used · ${settings.entryCount} thumbnails`
                : 'Usage unavailable'}
            </p>
            <button type="button" onClick={() => void save()} disabled={busy}>
              {busy ? 'Working…' : 'Save settings'}
            </button>
          </section>

          <section aria-labelledby="thumbnail-cache-clear-heading">
            <h3 id="thumbnail-cache-clear-heading">Clear cache</h3>
            {confirmClear ? (
              <div role="alertdialog" aria-label="Confirm clearing thumbnails">
                <p>
                  Delete cached thumbnails from the current location? Your
                  original model files will not be affected.
                </p>
                <div className="profile-card-actions">
                  <button
                    type="button"
                    onClick={() => void clearCache()}
                    disabled={busy}
                  >
                    Clear thumbnails
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    disabled={busy}
                  >
                    Keep cache
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={busy || !settings?.entryCount}
              >
                Clear cached thumbnails…
              </button>
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
