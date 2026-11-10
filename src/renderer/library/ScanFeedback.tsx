import type { ScanIssue, ScanSkippedEntries } from '@shared/ipc';
import { formatBytes } from './model';

export interface ScanFeedbackData {
  failure?: string | undefined;
  added?: number | undefined;
  changed?: number | undefined;
  unchanged?: number | undefined;
  modelCount?: number | undefined;
  skippedErrors?: number | undefined;
  scanErrors?: number | undefined;
  hashErrors?: number | undefined;
  cloudFilesSkipped?: number | undefined;
  cloudDirectoriesSkipped?: number | undefined;
  skippedEntries?: ScanSkippedEntries | undefined;
  scanIssues?: ScanIssue[] | undefined;
  scanIssuesTruncated?: boolean | undefined;
  archiveWarnings?: string[] | undefined;
}

interface ScanFeedbackProps {
  data: ScanFeedbackData;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | null | undefined;
  onDismiss?: (() => void) | undefined;
  className?: string | undefined;
  compact?: boolean;
  disabled?: boolean;
}

const REASONS: Record<ScanIssue['reason'], string> = {
  cloudOnly:
    'This item is online-only. Make it available on this device in your sync app, then rescan.',
  permissionDenied:
    'PrintFarmer could not access this item. Check its permissions and reconnect the source if needed.',
  unreadable:
    'This item could not be read. Check that it is available and not in use, then rescan.',
  tooLarge:
    'This ZIP archive exceeds the configured archive size limit and was skipped.',
};

function count(value: number | undefined): number {
  return value ?? 0;
}

export function scanOutcomeCounts(data: ScanFeedbackData): {
  cloudOnly: number;
  permissionDenied: number;
  unreadable: number;
  filesystemErrors: number;
  tooLarge: number;
  skipped: number;
} {
  const cloudOnly =
    data.skippedEntries?.cloudOnly ??
    count(data.cloudFilesSkipped) + count(data.cloudDirectoriesSkipped);
  const permissionDenied = count(data.skippedEntries?.permissionDenied);
  const unreadable = count(data.skippedEntries?.unreadable);
  const filesystemErrors =
    data.skippedEntries?.unreadable === undefined
      ? count(data.skippedErrors ?? data.scanErrors)
      : 0;
  const tooLarge = Math.max(
    count(data.skippedEntries?.tooLarge),
    (data.scanIssues ?? []).filter((issue) => issue.reason === 'tooLarge')
      .length,
    data.archiveWarnings?.length ?? 0,
  );
  return {
    cloudOnly,
    permissionDenied,
    unreadable,
    filesystemErrors,
    tooLarge,
    skipped:
      cloudOnly + permissionDenied + unreadable + filesystemErrors + tooLarge,
  };
}

function hasFeedback(data: ScanFeedbackData): boolean {
  return (
    Boolean(data.failure) ||
    count(data.skippedErrors) > 0 ||
    count(data.scanErrors) > 0 ||
    count(data.hashErrors) > 0 ||
    data.added !== undefined ||
    count(data.cloudFilesSkipped) > 0 ||
    count(data.cloudDirectoriesSkipped) > 0 ||
    Object.values(data.skippedEntries ?? {}).some((value) => value > 0) ||
    Boolean(data.scanIssues?.length) ||
    Boolean(data.scanIssuesTruncated) ||
    Boolean(data.archiveWarnings?.length)
  );
}

function reasonLabel(reason: ScanIssue['reason']): string {
  switch (reason) {
    case 'cloudOnly':
      return 'Cloud-only';
    case 'permissionDenied':
      return 'Permission denied';
    case 'unreadable':
      return 'Unreadable';
    case 'tooLarge':
      return 'Oversized ZIP';
  }
}

function legacyArchiveDetails(warning: string): {
  path: string;
  sizeBytes?: number;
  limitBytes?: number;
} {
  const match = warning.match(
    /^Skipped ZIP (.*?): on-disk size (\d+) bytes exceeds the .*? limit \((\d+) bytes\)\.?$/,
  );
  if (!match) return { path: warning };
  return {
    path: match[1]!,
    sizeBytes: Number(match[2]),
    limitBytes: Number(match[3]),
  };
}

export function ScanFeedback({
  data,
  onRetry,
  retryLabel,
  onDismiss,
  className = '',
  compact = false,
  disabled = false,
}: ScanFeedbackProps): React.JSX.Element | null {
  if (!hasFeedback(data)) return null;
  if (compact) {
    return (
      <details className="import-scan-details">
        <summary>Skipped paths and scan details</summary>
        <ScanFeedback
          data={data}
          onRetry={onRetry}
          retryLabel={retryLabel}
          disabled={disabled}
          className="import-scan-feedback"
        />
      </details>
    );
  }

  const cloudFiles = count(data.cloudFilesSkipped);
  const cloudFolders = count(data.cloudDirectoriesSkipped);
  const {
    cloudOnly,
    permissionDenied,
    unreadable,
    filesystemErrors: legacyFilesystemErrors,
    tooLarge,
  } = scanOutcomeCounts(data);
  const issues = data.scanIssues ?? [];
  const legacyArchives = data.archiveWarnings ?? [];
  const indexedFiles = data.failure
    ? undefined
    : data.added !== undefined
      ? count(data.added) + count(data.changed) + count(data.unchanged)
      : data.modelCount;
  const visibleArchives = legacyArchives.slice(0, 200);
  const knownIssuePaths = new Set(
    issues
      .filter((issue) => issue.reason === 'tooLarge')
      .map((issue) => issue.path),
  );
  const archiveDetails = visibleArchives
    .map((warning) => ({ warning, ...legacyArchiveDetails(warning) }))
    .filter(({ path }) => !knownIssuePaths.has(path));
  const allDetails = [
    ...issues.map((issue) => ({ type: 'issue' as const, issue })),
    ...archiveDetails.map((archive) => ({ type: 'archive' as const, archive })),
  ];
  const visibleDetails = allDetails.slice(0, 200);
  const limits = [
    ...issues.flatMap((issue) =>
      issue.reason === 'tooLarge' && issue.limitBytes !== undefined
        ? [issue.limitBytes]
        : [],
    ),
    ...archiveDetails.flatMap(({ limitBytes }) => {
      return limitBytes === undefined ? [] : [limitBytes];
    }),
  ];
  const distinctLimits = [...new Set(limits)];
  const truncated =
    data.scanIssuesTruncated === true ||
    legacyArchives.length > 200 ||
    allDetails.length > 200;
  const hasSkippedEntries =
    cloudOnly > 0 ||
    permissionDenied > 0 ||
    unreadable > 0 ||
    legacyFilesystemErrors > 0 ||
    tooLarge > 0;
  const detailsAvailable = allDetails.length > 0 || hasSkippedEntries;

  return (
    <section
      className={`scan-feedback ${className}`.trim()}
      role="status"
      aria-label="Scan results"
    >
      <div className="scan-feedback-summary">
        <div className="scan-feedback-text">
          {data.failure ? (
            <p>
              <strong>Scan stopped; catalog unchanged.</strong> {data.failure}
            </p>
          ) : null}
          {indexedFiles !== undefined ? (
            <p>
              <strong>{indexedFiles}</strong>{' '}
              {data.added !== undefined
                ? `file${indexedFiles === 1 ? '' : 's'} indexed`
                : `supported file${indexedFiles === 1 ? '' : 's'} found`}
              .
            </p>
          ) : null}
          <ul aria-label="Skipped entries by reason">
            {cloudOnly > 0 ? (
              <li>
                Cloud-only: {cloudOnly} {cloudOnly === 1 ? 'entry' : 'entries'}
                {cloudFiles + cloudFolders > 0 ? (
                  <>
                    {' '}
                    ({cloudFiles} {cloudFiles === 1 ? 'file' : 'files'},{' '}
                    {cloudFolders} {cloudFolders === 1 ? 'folder' : 'folders'})
                  </>
                ) : null}
              </li>
            ) : null}
            {permissionDenied > 0 ? (
              <li>Permission denied: {permissionDenied}</li>
            ) : null}
            {unreadable > 0 ? <li>Unreadable: {unreadable}</li> : null}
            {legacyFilesystemErrors > 0 ? (
              <li>
                Filesystem errors (reason unavailable): {legacyFilesystemErrors}
              </li>
            ) : null}
            {count(data.hashErrors) > 0 ? (
              <li>Hash errors: {count(data.hashErrors)}</li>
            ) : null}
            {tooLarge > 0 ? (
              <li>
                Oversized ZIP archives: {tooLarge} skipped
                {distinctLimits.length === 1
                  ? ` (${formatBytes(distinctLimits[0]!)} limit)`
                  : distinctLimits.length > 1
                    ? ' (configured limits vary)'
                    : ''}
              </li>
            ) : null}
          </ul>
          {cloudOnly > 0 ? (
            <p>
              Make cloud-only items available locally in your sync app, then
              rescan.
            </p>
          ) : null}
        </div>
        <div className="scan-feedback-actions">
          {onRetry ? (
            <button type="button" disabled={disabled} onClick={onRetry}>
              {retryLabel ?? 'Retry'}
            </button>
          ) : null}
          {onDismiss ? (
            <button type="button" onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
      {detailsAvailable || truncated ? (
        <details className="scan-feedback-details">
          <summary>Show skipped paths and details</summary>
          {truncated ? (
            <p>
              Path details are limited to the first 200 entries. Counts above
              cover the entire scan.
            </p>
          ) : null}
          <ul>
            {visibleDetails.map((entry, index) =>
              entry.type === 'issue' ? (
                <li key={`${entry.issue.path}:${entry.issue.reason}:${index}`}>
                  <strong>
                    {entry.issue.kind === 'folder' ? 'Folder' : 'File'} ·{' '}
                    {reasonLabel(entry.issue.reason)}
                  </strong>
                  <code title={entry.issue.path}>{entry.issue.path}</code>
                  <span>{REASONS[entry.issue.reason]}</span>
                  {entry.issue.reason === 'tooLarge' &&
                  entry.issue.sizeBytes !== undefined &&
                  entry.issue.limitBytes !== undefined ? (
                    <span>
                      Size: {formatBytes(entry.issue.sizeBytes)} · limit:{' '}
                      {formatBytes(entry.issue.limitBytes)}
                    </span>
                  ) : null}
                  {entry.issue.detail ? (
                    <span>{entry.issue.detail}</span>
                  ) : null}
                </li>
              ) : (
                <li key={`archive:${index}`}>
                  <strong>Oversized ZIP</strong>
                  <code title={entry.archive.path}>{entry.archive.path}</code>
                  {entry.archive.sizeBytes !== undefined &&
                  entry.archive.limitBytes !== undefined ? (
                    <span>
                      Size: {formatBytes(entry.archive.sizeBytes)} · limit:{' '}
                      {formatBytes(entry.archive.limitBytes)}
                    </span>
                  ) : (
                    <span>{entry.archive.warning}</span>
                  )}
                  <span>{REASONS.tooLarge}</span>
                </li>
              ),
            )}
          </ul>
          {allDetails.length === 0 ? (
            <p>Path-specific details were not provided for this scan.</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
