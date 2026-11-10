// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  createWindowsInstallerPhaseReporter,
  MAX_WINDOWS_INSTALLER_PHASE_RECORD_BYTES,
  MAX_WINDOWS_INSTALLER_PHASE_RECORDS,
  observeWindowsInstallerFileOperation,
  WINDOWS_INSTALLER_PHASE_PREFIX,
  windowsInstallerFileErrorCode,
  type WindowsInstallerPhaseReporter,
} from './helpers/windowsInstallerPhaseTrace';

describe('Windows installer phase diagnostics', () => {
  it('writes bounded monotonic records with only allowlisted details', () => {
    const lines: string[] = [];
    let time = 10;
    const report = createWindowsInstallerPhaseReporter({
      startedAt: time,
      now: () => time,
      write: (line) => lines.push(line),
    });

    time = 13;
    report('verified-received');
    time = 17;
    report('unlink-after', { outcome: 'rejected', errorCode: 'EBUSY' });

    expect(lines).toHaveLength(2);
    expect(
      lines.map(
        (line) =>
          JSON.parse(
            line.slice(WINDOWS_INSTALLER_PHASE_PREFIX.length),
          ) as unknown,
      ),
    ).toEqual([
      { phase: 'verified-received', elapsedMs: 3 },
      {
        phase: 'unlink-after',
        elapsedMs: 7,
        outcome: 'rejected',
        errorCode: 'EBUSY',
      },
    ]);
    expect(
      lines.every(
        (line) =>
          Buffer.byteLength(line, 'utf8') <=
          MAX_WINDOWS_INSTALLER_PHASE_RECORD_BYTES,
      ),
    ).toBe(true);
    expect(lines.join('')).not.toContain('private');
  });

  it('fails visibly rather than emitting more than the fixed record limit', () => {
    const lines: string[] = [];
    const report = createWindowsInstallerPhaseReporter({
      startedAt: 0,
      now: () => 1,
      write: (line) => lines.push(line),
    });

    for (
      let index = 0;
      index < MAX_WINDOWS_INSTALLER_PHASE_RECORDS;
      index += 1
    ) {
      report('spawned');
    }

    expect(lines).toHaveLength(MAX_WINDOWS_INSTALLER_PHASE_RECORDS);
    expect(() => report('spawned')).toThrow(
      `Windows installer phase trace exceeded ${MAX_WINDOWS_INSTALLER_PHASE_RECORDS} records`,
    );
    expect(lines).toHaveLength(MAX_WINDOWS_INSTALLER_PHASE_RECORDS);
  });

  it('preserves operation results and original errors while recording only safe error codes', () => {
    const lines: string[] = [];
    const report = createWindowsInstallerPhaseReporter({
      startedAt: 0,
      now: () => 1,
      write: (line) => lines.push(line),
    });
    const result = { unchanged: true };
    let successfulAttempts = 0;
    expect(
      observeWindowsInstallerFileOperation(report, 'rename', () => {
        successfulAttempts += 1;
        return result;
      }),
    ).toBe(result);
    expect(successfulAttempts).toBe(1);

    const denied = Object.assign(new Error('private path must not be logged'), {
      code: 'EPERM',
    });
    let attempts = 0;
    let caught: unknown;

    try {
      observeWindowsInstallerFileOperation(report, 'unlink', () => {
        attempts += 1;
        throw denied;
      });
    } catch (error) {
      caught = error;
    }

    expect(attempts).toBe(1);
    expect(caught).toBe(denied);
    expect(
      lines.map(
        (line) =>
          JSON.parse(
            line.slice(WINDOWS_INSTALLER_PHASE_PREFIX.length),
          ) as unknown,
      ),
    ).toEqual([
      { phase: 'rename-before', elapsedMs: 1 },
      { phase: 'rename-after', elapsedMs: 1, outcome: 'returned' },
      { phase: 'unlink-before', elapsedMs: 1 },
      {
        phase: 'unlink-after',
        elapsedMs: 1,
        outcome: 'rejected',
        errorCode: 'EPERM',
      },
    ]);
    expect(lines.join('')).not.toContain('private path');
    expect(windowsInstallerFileErrorCode({ code: 'ENOENT' })).toBe('OTHER');
  });

  it('exposes writer failures to direct reporter callers', () => {
    const writerError = new Error('diagnostic stream unavailable');
    const report = createWindowsInstallerPhaseReporter({
      startedAt: 0,
      now: () => 1,
      write: () => {
        throw writerError;
      },
    });

    expect(() => report('spawned')).toThrow(writerError);
  });

  it('does not let reporter failures suppress operations or replace their errors', () => {
    const report: WindowsInstallerPhaseReporter = () => {
      throw new Error('diagnostic stream unavailable');
    };
    const result = { unchanged: true };
    let attempts = 0;

    expect(
      observeWindowsInstallerFileOperation(report, 'unlink', () => {
        attempts += 1;
        return result;
      }),
    ).toBe(result);
    expect(attempts).toBe(1);

    const denied = new Error('sharing violation');
    let caught: unknown;
    try {
      observeWindowsInstallerFileOperation(report, 'rename', () => {
        attempts += 1;
        throw denied;
      });
    } catch (error) {
      caught = error;
    }

    expect(attempts).toBe(2);
    expect(caught).toBe(denied);
  });
});
