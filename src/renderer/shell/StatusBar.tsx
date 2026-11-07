import type {
  AppInfoResponse,
  AvailableRelease,
  ServerProfile,
} from '@shared/ipc';
import { serverStatusLabel } from './serverPresentation';
import type { UpdateCheckState } from './useAvailableRelease';

function updateCheckMessage(state: UpdateCheckState): string {
  switch (state.kind) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${state.version} is available`;
    case 'upToDate':
      return `You're up to date (v${state.version})`;
    case 'failed':
      return "Couldn't check for updates. Try again later.";
    case 'unavailable':
      return 'Update checks run only in installed builds';
    case 'idle':
      return '';
  }
}

export interface StatusBarProps {
  /** What the app is doing right now, in the product's own words. */
  activity: string;
  busy: boolean;
  error: string | null;
  serverProfile: ServerProfile | null;
  uploadsRemaining: number;
  sourcesNeedingAttention: number;
  appInfo: AppInfoResponse | null;
  /** A newer build on this build's release train, if one is published. */
  availableRelease?: AvailableRelease | null;
  onDismissRelease?: () => void;
  onCheckForUpdates?: () => void;
  updateCheck?: UpdateCheckState;
}

/**
 * Ambient state that stays true regardless of which place is open. It reports
 * the system, not the route: naming the current workspace here would only
 * repeat what the rail already shows with `aria-current`.
 */
export function StatusBar({
  activity,
  busy,
  error,
  serverProfile,
  uploadsRemaining,
  sourcesNeedingAttention,
  appInfo,
  availableRelease = null,
  onDismissRelease,
  onCheckForUpdates,
  updateCheck = { kind: 'idle' },
}: StatusBarProps): React.JSX.Element {
  return (
    <footer className="app-statusbar" aria-label="Application status">
      <span className="status-activity" role="status" aria-busy={busy}>
        {activity}
      </span>

      {error ? (
        <span className="statusbar-error" role="alert">
          {error}
        </span>
      ) : null}

      <span className="statusbar-spacer" />

      {uploadsRemaining > 0 ? (
        <span className="status-item">
          {uploadsRemaining} {uploadsRemaining === 1 ? 'upload' : 'uploads'}{' '}
          remaining
        </span>
      ) : null}

      {sourcesNeedingAttention > 0 ? (
        <span className="status-item status-item--warning">
          {sourcesNeedingAttention}{' '}
          {sourcesNeedingAttention === 1 ? 'source needs' : 'sources need'}{' '}
          attention
        </span>
      ) : null}

      <span className="status-item">
        <span
          className={`server-status-dot ${serverProfile?.status ?? 'none'}`}
          aria-hidden="true"
        />
        {serverStatusLabel(serverProfile)}
        {serverProfile ? ` · ${serverProfile.displayName}` : ''}
      </span>

      {availableRelease ? (
        <span className="status-item status-item--update">
          <a href={availableRelease.url} target="_blank" rel="noreferrer">
            {availableRelease.prerelease ? 'Beta' : 'Update'}{' '}
            {availableRelease.version} available
          </a>
          {onDismissRelease ? (
            <button
              type="button"
              className="status-item-dismiss"
              onClick={onDismissRelease}
              aria-label={`Dismiss ${availableRelease.version} update notice`}
            >
              Dismiss
            </button>
          ) : null}
        </span>
      ) : null}

      {onCheckForUpdates ? (
        <span className="status-item status-item--check">
          <button
            type="button"
            className="status-item-dismiss"
            onClick={onCheckForUpdates}
            disabled={updateCheck.kind === 'checking'}
          >
            Check for Updates
          </button>
          <span role="status" aria-live="polite">
            {updateCheckMessage(updateCheck)}
          </span>
        </span>
      ) : null}

      {appInfo ? (
        <span className="status-item status-item--build">
          v{appInfo.appVersion} · {appInfo.platform}
        </span>
      ) : null}
    </footer>
  );
}
