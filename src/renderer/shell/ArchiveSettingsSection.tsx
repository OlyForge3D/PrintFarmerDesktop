import { useEffect, useState } from 'react';
import { MAX_ARCHIVE_SIZE_MIB } from '@shared/ipc';

export function ArchiveSettingsSection({
  disabled,
  onBusyChange,
}: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}): React.JSX.Element {
  const [maxMiB, setMaxMiB] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void window.printFarmer
      .getArchiveSettings()
      .then((settings) => {
        if (active) {
          setMaxMiB(String(settings.maxArchiveBytes / (1024 * 1024)));
          setLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const save = async (): Promise<void> => {
    const value = Number(maxMiB);
    if (!Number.isInteger(value) || value < 1 || value > MAX_ARCHIVE_SIZE_MIB) {
      setError(`Enter a whole number from 1 to ${MAX_ARCHIVE_SIZE_MIB} MiB.`);
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setMessage(null);
    try {
      const settings = await window.printFarmer.setArchiveSettings({
        maxArchiveBytes: value * 1024 * 1024,
      });
      setMaxMiB(String(settings.maxArchiveBytes / (1024 * 1024)));
      setMessage(
        'ZIP size limit saved. It applies to the next scan or rescan.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <section
      className="settings-archives"
      aria-labelledby="settings-archives-heading"
      aria-busy={loading || busy}
    >
      <header className="service-heading">
        <div>
          <h2 id="settings-archives-heading" tabIndex={-1}>
            ZIP files
          </h2>
          <p>
            Choose the largest on-disk ZIP archive to index on this computer.
          </p>
        </div>
      </header>
      {error ? (
        <p className="profile-alert profile-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {loading ? <p role="status">Loading ZIP settings...</p> : null}
      <label className="thumbnail-cache-field">
        Maximum ZIP size (MiB)
        <input
          type="number"
          min={1}
          max={MAX_ARCHIVE_SIZE_MIB}
          step={1}
          value={maxMiB}
          disabled={disabled || loading || busy}
          aria-describedby="settings-archives-hint"
          onChange={(event) => setMaxMiB(event.target.value)}
        />
      </label>
      <p id="settings-archives-hint" className="settings-hint">
        1 MiB = 1,048,576 bytes. Default: 512 MiB. ZIPs above this limit are
        skipped; files exactly at the limit are allowed. Other ZIP safety
        limits, including the 512 MiB per-model limit, remain in place. Rescan
        source folders after changing this value.
      </p>
      <div>
        <button
          type="button"
          disabled={disabled || loading || busy || !loaded}
          onClick={() => void save()}
        >
          {busy ? 'Saving ZIP limit...' : 'Save ZIP limit'}
        </button>
        {error && !loaded && !loading ? (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => setRevision((current) => current + 1)}
          >
            Retry ZIP settings
          </button>
        ) : null}
      </div>
    </section>
  );
}
