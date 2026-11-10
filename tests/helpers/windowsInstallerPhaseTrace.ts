import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export const WINDOWS_INSTALLER_PHASE_PREFIX = '[windows-installer-phase] ';
export const MAX_WINDOWS_INSTALLER_PHASE_RECORDS = 12;
export const MAX_WINDOWS_INSTALLER_PHASE_RECORD_BYTES = 192;

export type WindowsInstallerPhase =
  | 'spawn-requested'
  | 'spawned'
  | 'spawn-error'
  | 'verified-received'
  | 'callback-entered'
  | 'unlink-before'
  | 'unlink-after'
  | 'rename-before'
  | 'rename-after'
  | 'continue-sent'
  | 'helper-exit'
  | 'helper-timeout'
  | 'launch-error';

export type WindowsInstallerPhaseOutcome =
  'returned' | 'rejected' | 'success' | 'nonzero' | 'signal' | 'other';

export type WindowsInstallerFileErrorCode =
  'EACCES' | 'EBUSY' | 'EPERM' | 'OTHER';

export interface WindowsInstallerPhaseDetails {
  outcome?: WindowsInstallerPhaseOutcome;
  errorCode?: WindowsInstallerFileErrorCode;
}

export type WindowsInstallerPhaseReporter = (
  phase: WindowsInstallerPhase,
  details?: WindowsInstallerPhaseDetails,
) => void;

export interface WindowsInstallerPhaseReporterOptions {
  startedAt?: number;
  now?: () => number;
  write?: (line: string) => void;
}

export function createWindowsInstallerPhaseReporter(
  options: WindowsInstallerPhaseReporterOptions = {},
): WindowsInstallerPhaseReporter {
  const now = options.now ?? (() => performance.now());
  const startedAt = options.startedAt ?? now();
  const write =
    options.write ??
    ((line: string) => {
      writeSync(2, line);
    });
  let written = 0;

  return (phase, details = {}) => {
    if (written >= MAX_WINDOWS_INSTALLER_PHASE_RECORDS) {
      throw new Error(
        `Windows installer phase trace exceeded ${MAX_WINDOWS_INSTALLER_PHASE_RECORDS} records`,
      );
    }

    const elapsedMs = Math.max(0, Math.round(now() - startedAt));
    if (!Number.isSafeInteger(elapsedMs)) {
      throw new Error('Windows installer phase trace clock was invalid');
    }
    const record = JSON.stringify({
      phase,
      elapsedMs,
      ...(details.outcome ? { outcome: details.outcome } : {}),
      ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    });
    const line = `${WINDOWS_INSTALLER_PHASE_PREFIX}${record}\n`;
    if (
      Buffer.byteLength(line, 'utf8') > MAX_WINDOWS_INSTALLER_PHASE_RECORD_BYTES
    ) {
      throw new Error(
        'Windows installer phase trace record exceeded its byte limit',
      );
    }

    write(line);
    written += 1;
  };
}

export function windowsInstallerFileErrorCode(
  error: unknown,
): WindowsInstallerFileErrorCode {
  if (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EACCES' ||
      error.code === 'EBUSY' ||
      error.code === 'EPERM')
  ) {
    return error.code;
  }
  return 'OTHER';
}

export function observeWindowsInstallerFileOperation<T>(
  report: WindowsInstallerPhaseReporter,
  operation: 'unlink' | 'rename',
  run: () => T,
): T {
  report(`${operation}-before`);
  try {
    const result = run();
    report(`${operation}-after`, { outcome: 'returned' });
    return result;
  } catch (error) {
    report(`${operation}-after`, {
      outcome: 'rejected',
      errorCode: windowsInstallerFileErrorCode(error),
    });
    throw error;
  }
}
