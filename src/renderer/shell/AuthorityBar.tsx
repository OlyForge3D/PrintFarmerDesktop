import type { ServerProfile } from '@shared/ipc';
import { Icon } from '../ui/Icon';
import {
  serverAccessibleLabel,
  serverStatusLabel,
  serverVersionLabel,
} from './serverPresentation';

export interface AuthorityBarProps {
  profile: ServerProfile | null;
  disabled: boolean;
  onManage: () => void;
}

/**
 * Which PrintFarmer server this session speaks for, shown in every place.
 * Calibration is gated on this selection and Library uploads through it, so it
 * belongs to the shell rather than to whichever workspace happens to be open.
 */
export function AuthorityBar({
  profile,
  disabled,
  onManage,
}: AuthorityBarProps): React.JSX.Element {
  const status = serverStatusLabel(profile);
  return (
    <section className="authority-bar" aria-label="PrintFarmer server">
      <button
        type="button"
        className={`authority-entry${profile ? '' : ' authority-entry--cta'}`}
        disabled={disabled}
        aria-label={serverAccessibleLabel(profile)}
        onClick={onManage}
      >
        <Icon name="server" />
        <span
          className={`server-status-dot ${profile?.status ?? 'none'}`}
          aria-hidden="true"
        />
        <span className="authority-name" aria-hidden="true">
          {profile?.displayName ?? 'Connect to PrintFarmer'}
        </span>
        <span className="authority-detail" aria-hidden="true">
          {serverVersionLabel(profile)}
        </span>
        <span
          className={`authority-status ${profile?.status ?? 'none'}`}
          aria-hidden="true"
        >
          {status}
        </span>
      </button>

      {profile?.warnings.includes('insecureHttp') ? (
        <p className="authority-warning">
          <Icon name="missing" />
          HTTP connection is not encrypted
        </p>
      ) : null}
    </section>
  );
}
