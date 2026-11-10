import { useEffect, useState } from 'react';
import { basename } from './model';
import type { LibraryScanActivity } from './useLibrary';

export function ImportPreparationStatus({
  activity,
}: {
  activity: LibraryScanActivity;
}): React.JSX.Element {
  const path = activity.phase === 'inspecting' ? activity.path : null;
  const [visiblePath, setVisiblePath] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    const timer = setTimeout(() => setVisiblePath(path), 150);
    return () => {
      clearTimeout(timer);
      setVisiblePath(null);
    };
  }, [path]);

  const visible = path !== null && path === visiblePath;
  return (
    <div
      className="import-preparation-status"
      data-active={visible}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Folder inspection"
    >
      {visible ? (
        <>
          <span className="loading-indicator" aria-hidden="true" />
          <div>
            <strong>Inspecting folder: {basename(path)}</strong>
            <p>
              {activity.label === 'Loading import organization choices'
                ? 'Loading import organization choices.'
                : 'Checking local files and subfolders before import.'}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
