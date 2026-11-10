import { useId, useState } from 'react';
import type { ServerProfile } from '@shared/ipc';
import { Icon } from '../ui/Icon';

const LABEL = 'Upload selected models to PrintFarmer';

export function UploadSelectedButton({
  disabled,
  serverProfile,
  onUpload,
}: {
  disabled: boolean;
  serverProfile: ServerProfile | null;
  onUpload: () => void;
}): React.JSX.Element {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const availability = serverProfile?.availability.modelUpload;
  const detail = !serverProfile
    ? 'Connect a PrintFarmer server profile first.'
    : !availability?.available
      ? (availability?.reason ?? 'Model upload is unavailable.')
      : availability.mode === 'legacyModelOnly'
        ? 'Legacy model-only upload; interrupted retries can create duplicates.'
        : 'Upload selected models with idempotent retry protection.';

  return (
    <span
      className="upload-action"
      tabIndex={disabled ? 0 : undefined}
      role={disabled ? 'group' : undefined}
      aria-label={disabled ? LABEL : undefined}
      aria-describedby={disabled ? tooltipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className="command-button upload-selected"
        aria-label={LABEL}
        aria-describedby={tooltipId}
        disabled={disabled}
        onClick={onUpload}
      >
        <Icon name="upload" />
        Upload
      </button>
      <span
        id={tooltipId}
        className="upload-action-tooltip"
        role="tooltip"
        hidden={!open}
      >
        {LABEL}. {detail}
      </span>
    </span>
  );
}
