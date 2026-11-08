import { Icon } from '../ui/Icon';

interface LibraryErrorAlertProps {
  error: string;
  className: string;
  onDismiss: () => void;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | null | undefined;
}

export function LibraryErrorAlert({
  error,
  className,
  onDismiss,
  onRetry,
  retryLabel,
}: LibraryErrorAlertProps): React.JSX.Element {
  const hasDetails = error.length > 300;
  const separator = error.indexOf(':');
  const summary = !hasDetails
    ? error
    : separator > 0 && separator <= 300
      ? error.slice(0, separator)
      : 'The library operation failed. See error details below.';

  return (
    <div className={`${className} library-error-alert`} role="alert">
      <Icon name="missing" />
      <span className="library-error-message">{summary}</span>
      <div className="library-error-actions">
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            {retryLabel ?? 'Retry'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss library error"
        >
          Dismiss
        </button>
      </div>
      {hasDetails ? (
        <details className="library-error-details">
          <summary>Error details</summary>
          <pre>{error}</pre>
        </details>
      ) : null}
    </div>
  );
}
