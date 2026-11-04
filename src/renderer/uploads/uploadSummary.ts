import type { UploadJob } from '@shared/ipc';

export interface UploadQueueSummary {
  queued: number;
  uploading: number;
  paused: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  cancelled: number;
  remaining: number;
}

export function summarizeUploadJobs(jobs: UploadJob[]): UploadQueueSummary {
  const summary: UploadQueueSummary = {
    queued: 0,
    uploading: 0,
    paused: 0,
    succeeded: 0,
    failed: 0,
    uncertain: 0,
    cancelled: 0,
    remaining: 0,
  };

  for (const job of jobs) {
    if (job.paused) {
      summary.paused += job.summary.queued + job.summary.uploading;
    } else {
      summary.queued += job.summary.queued;
      summary.uploading += job.summary.uploading;
    }
    summary.succeeded += job.summary.succeeded;
    summary.failed += job.summary.failed;
    summary.uncertain += job.summary.uncertain;
    summary.cancelled += job.summary.cancelled;
  }

  summary.remaining = summary.queued + summary.uploading + summary.paused;
  return summary;
}

export function describeUploadQueue(
  jobs: UploadJob[],
  summary: UploadQueueSummary,
): string {
  if (jobs.length === 0) return 'Upload queue is empty.';

  const pending = [
    summary.uploading > 0 ? `${summary.uploading} uploading` : null,
    summary.queued > 0 ? `${summary.queued} queued` : null,
    summary.paused > 0 ? `${summary.paused} paused` : null,
  ].filter((part): part is string => part !== null);
  const outcomes = [
    summary.succeeded > 0 ? `${summary.succeeded} succeeded` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.uncertain > 0 ? `${summary.uncertain} uncertain` : null,
    summary.cancelled > 0 ? `${summary.cancelled} cancelled` : null,
  ].filter((part): part is string => part !== null);

  const sections = [
    pending.length > 0 ? pending.join(', ') : null,
    outcomes.length > 0 ? outcomes.join(', ') : null,
  ].filter((part): part is string => part !== null);

  return sections.length > 0
    ? `${sections.join('; ')}.`
    : 'No upload activity.';
}
