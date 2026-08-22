import type { AppInfoResponse, ServerProfile } from '@shared/ipc';
import { serverStatusLabel } from './serverPresentation';

export interface StatusBarProps {
  /** What the app is doing right now, in the product's own words. */
  activity: string;
  busy: boolean;
  error: string | null;
  serverProfile: ServerProfile | null;
  uploadsInFlight: number;
  sourcesNeedingAttention: number;
  appInfo: AppInfoResponse | null;
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
  uploadsInFlight,
  sourcesNeedingAttention,
  appInfo,
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

      {uploadsInFlight > 0 ? (
        <span className="status-item">
          {uploadsInFlight} {uploadsInFlight === 1 ? 'upload' : 'uploads'} in
          progress
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

      {appInfo ? (
        <span className="status-item status-item--build">
          v{appInfo.appVersion} · {appInfo.platform}
        </span>
      ) : null}
    </footer>
  );
}
