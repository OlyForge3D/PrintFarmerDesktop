import { useCallback, useEffect, useState } from 'react';
import type { AvailableRelease } from '@shared/ipc';

const DISMISSED_RELEASE_KEY = 'printfarmer.dismissedReleaseVersion';
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function readDismissedVersion(): string | null {
  try {
    return globalThis.localStorage?.getItem(DISMISSED_RELEASE_KEY) ?? null;
  } catch {
    return null;
  }
}

export interface AvailableReleaseState {
  /** The newer release to announce, or `null` when none / dismissed. */
  release: AvailableRelease | null;
  dismiss: () => void;
}

/**
 * Asks main whether a newer build is published on this build's release train,
 * at startup and periodically. Failures are silent: an update notice is a
 * courtesy and must never surface as an app error. Dismissal is remembered per
 * version, so a later release is announced again.
 */
export function useAvailableRelease(
  recheckIntervalMs: number = RECHECK_INTERVAL_MS,
): AvailableReleaseState {
  const [release, setRelease] = useState<AvailableRelease | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    readDismissedVersion,
  );

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      Promise.resolve()
        .then(() => window.printFarmer.getAvailableRelease())
        .then((response) => {
          if (!cancelled) setRelease(response.available);
        })
        .catch(() => undefined);
    };
    check();
    const interval = setInterval(check, recheckIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [recheckIntervalMs]);

  const dismiss = useCallback(() => {
    if (!release) return;
    setDismissedVersion(release.version);
    try {
      globalThis.localStorage?.setItem(DISMISSED_RELEASE_KEY, release.version);
    } catch {
      // Dismissal still holds for this session.
    }
  }, [release]);

  return {
    release: release && release.version !== dismissedVersion ? release : null,
    dismiss,
  };
}
