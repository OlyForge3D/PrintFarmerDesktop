import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Outcome of the last manual "Check for Updates", for the status bar. */
export type UpdateCheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'upToDate'; version: string }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

export interface AvailableReleaseState {
  checkNow: () => void;
  checkState: UpdateCheckState;
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

  const [checkState, setCheckState] = useState<UpdateCheckState>({
    kind: 'idle',
  });
  const manualCheckVersion = useRef(0);
  const manualCheckId = useRef(0);
  const manualCheckInFlight = useRef(false);

  const checkNow = useCallback(() => {
    const checkId = ++manualCheckId.current;
    manualCheckVersion.current += 1;
    manualCheckInFlight.current = true;
    setCheckState({ kind: 'checking' });
    Promise.resolve()
      .then(() => window.printFarmer.checkForUpdates())
      .then((response) => {
        if (checkId !== manualCheckId.current) return;
        manualCheckInFlight.current = false;
        if (response.status === 'available' && response.available) {
          // A manual check is an explicit ask: show the notice even if this
          // version was dismissed earlier.
          setDismissedVersion(null);
          try {
            globalThis.localStorage?.removeItem(DISMISSED_RELEASE_KEY);
          } catch {
            // Session-only reveal is enough.
          }
          setRelease(response.available);
          setCheckState({
            kind: 'available',
            version: response.available.version,
          });
        } else if (response.status === 'upToDate') {
          setRelease(null);
          setCheckState({
            kind: 'upToDate',
            version: response.currentVersion,
          });
        } else {
          setCheckState({
            kind: response.status === 'failed' ? 'failed' : 'unavailable',
          });
        }
      })
      .catch(() => {
        if (checkId !== manualCheckId.current) return;
        manualCheckInFlight.current = false;
        setCheckState({ kind: 'failed' });
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      const versionAtStart = manualCheckVersion.current;
      const startedDuringManualCheck = manualCheckInFlight.current;
      Promise.resolve()
        .then(() => window.printFarmer.getAvailableRelease())
        .then((response) => {
          if (
            !cancelled &&
            !startedDuringManualCheck &&
            versionAtStart === manualCheckVersion.current
          ) {
            setRelease(response.available);
          }
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
    checkNow,
    checkState,
    release: release && release.version !== dismissedVersion ? release : null,
    dismiss,
  };
}
