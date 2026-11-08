import { useEffect, useRef, useState } from 'react';
import type { ThumbnailCacheSettings as CacheSettings } from '@shared/ipc';

interface ThumbnailCacheSettingsProps {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function ThumbnailCacheSettings({
  disabled,
  onBusyChange,
}: ThumbnailCacheSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<CacheSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [maxMiB, setMaxMiB] = useState('512');
  const [retentionDays, setRetentionDays] = useState('30');
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keepCacheRef = useRef<HTMLButtonElement | null>(null);
  const clearCacheTriggerRef = useRef<HTMLButtonElement | null>(null);
  const clearCacheHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusAfterConfirmationRef = useRef<'trigger' | 'heading' | null>(null);
  const controlsDisabled = busy || loading || disabled || settings === null;
  const setWorking = (working: boolean): void => {
    setBusy(working);
    onBusyChange(working);
  };

  const cancelClearConfirmation = (): void => {
    focusAfterConfirmationRef.current = 'trigger';
    setConfirmClear(false);
  };

  const applySettings = (next: CacheSettings): void => {
    setSettings(next);
    setLocation(next.location);
    setMaxMiB(String(Math.round(next.maxBytes / (1024 * 1024))));
    setRetentionDays(String(next.retentionDays));
  };

  useEffect(() => {
    let active = true;
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (confirmClear) {
      keepCacheRef.current?.focus();
      return;
    }

    const focusTarget = focusAfterConfirmationRef.current;
    focusAfterConfirmationRef.current = null;
    if (focusTarget === 'trigger') clearCacheTriggerRef.current?.focus();
    if (focusTarget === 'heading') clearCacheHeadingRef.current?.focus();
  }, [confirmClear]);

  const chooseLocation = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      const selected = await window.printFarmer.chooseThumbnailCacheLocation();
      if (!selected.canceled && selected.path) {
        setLocation(selected.path);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
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
    setWorking(true);
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
      setWorking(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.printFarmer.clearThumbnailCache();
      applySettings(result.settings);
      focusAfterConfirmationRef.current = 'heading';
      setConfirmClear(false);
      setMessage(
        `Cleared ${result.clearedEntries} cached thumbnail${result.clearedEntries === 1 ? '' : 's'}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section
      className="settings-cache"
      aria-labelledby="thumbnail-cache-title"
      aria-busy={busy || loading}
    >
      <header className="service-heading">
        <div>
          <h2 id="thumbnail-cache-title" tabIndex={-1}>
            Thumbnail cache
          </h2>
          <p>
            Manage locally generated previews. Source models are never changed.
          </p>
        </div>
      </header>

      {error ? (
        <div className="profile-alert profile-error" role="alert">
          {error}
        </div>
      ) : null}
      {settings?.warning ? (
        <div className="profile-alert profile-error" role="alert">
          {settings.warning} Thumbnails will still render, but may not be cached
          until the location is writable.
        </div>
      ) : null}
      {message ? (
        <p className="thumbnail-cache-message" role="status">
          {message}
        </p>
      ) : null}

      <div className="thumbnail-cache-content">
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
              disabled={controlsDisabled}
            >
              Choose folder…
            </button>
            <button
              type="button"
              onClick={() => setLocation(null)}
              disabled={controlsDisabled || location === null}
            >
              Use app data folder
            </button>
          </div>
          <p className="thumbnail-cache-hint">
            A new location starts with an empty cache. Switching locations
            removes only PrintFarmer thumbnail entries from the previous folder;
            unrelated files are preserved.
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
              disabled={controlsDisabled}
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
              disabled={controlsDisabled}
            />
          </label>
          <p className="thumbnail-cache-usage">
            {settings
              ? `${formatBytes(settings.usedBytes)} used · ${settings.entryCount} thumbnails`
              : 'Usage unavailable'}
          </p>
          <button
            type="button"
            onClick={() => void save()}
            disabled={controlsDisabled}
          >
            {busy ? 'Working…' : 'Save settings'}
          </button>
        </section>

        <section aria-labelledby="thumbnail-cache-clear-heading">
          <h3
            id="thumbnail-cache-clear-heading"
            ref={clearCacheHeadingRef}
            tabIndex={-1}
          >
            Clear cache
          </h3>
          {confirmClear ? (
            <div
              role="alert"
              aria-label="Confirm clearing thumbnails"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !controlsDisabled) {
                  event.preventDefault();
                  cancelClearConfirmation();
                }
              }}
            >
              <p>
                Delete cached thumbnails from the current location? Your
                original model files will not be affected.
              </p>
              <div className="profile-card-actions">
                <button
                  type="button"
                  onClick={() => void clearCache()}
                  disabled={controlsDisabled}
                >
                  Clear thumbnails
                </button>
                <button
                  ref={keepCacheRef}
                  type="button"
                  onClick={cancelClearConfirmation}
                  disabled={controlsDisabled}
                >
                  Keep cache
                </button>
              </div>
            </div>
          ) : (
            <button
              ref={clearCacheTriggerRef}
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={controlsDisabled || !settings?.entryCount}
            >
              Clear cached thumbnails…
            </button>
          )}
        </section>
      </div>
    </section>
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
