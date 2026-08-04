import React, { useCallback, useRef, useState } from 'react';
import type {
  LegacyBackupPreflight,
  LegacyBackupProjectOutcome,
  LegacyBackupPrinterMapping,
  CalibrationPickLegacyBackupV4Response,
  CalibrationImportLegacyBackupV4Response,
} from '@shared/ipc';
import type { CalibrationEnvironment } from './api';
import { useDialogFocusLifecycle, useFocusTrap } from './useDialogFocus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ImportStep =
  | 'idle'
  | 'picking'
  | 'preflight'
  | 'mapping'
  | 'reviewing'
  | 'importing'
  | 'done'
  | 'error';

interface MappingEntry {
  legacyProjectId: string;
  projectName: string;
  targetPrinterId: string;
  targetToolId: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PreflightSummary({
  preflight,
}: {
  preflight: LegacyBackupPreflight;
}): React.JSX.Element {
  const {
    summary,
    importableCount,
    unsupportedCount,
    corruptCount,
    requiresActionCount,
    warnings,
  } = preflight;
  return (
    <section aria-labelledby="preflight-title">
      <h3 id="preflight-title">Preflight results</h3>
      <dl className="cal-import-preflight-dl">
        <div>
          <dt>Schema version</dt>
          <dd>{summary.detectedVersion}</dd>
        </div>
        <div>
          <dt>Projects</dt>
          <dd>{summary.projectCount}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{summary.attemptCount}</dd>
        </div>
        <div>
          <dt>Photos</dt>
          <dd>{summary.photoCount}</dd>
        </div>
        <div>
          <dt>Importable</dt>
          <dd>{importableCount}</dd>
        </div>
        <div>
          <dt>Requires action</dt>
          <dd>{requiresActionCount}</dd>
        </div>
        <div>
          <dt>Unsupported</dt>
          <dd>{unsupportedCount}</dd>
        </div>
        <div>
          <dt>Corrupt</dt>
          <dd>{corruptCount}</dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <div className="cal-alert cal-alert--warning" role="alert">
          <strong>Preflight warnings:</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>
          Per-project outcomes ({preflight.projectOutcomes.length})
        </summary>
        <ul className="cal-import-project-list">
          {preflight.projectOutcomes.map((o) => (
            <li
              key={o.legacyProjectId}
              className={`cal-import-outcome--${o.outcome}`}
            >
              <strong>{o.name}</strong> <span>({o.outcome})</span>
              {o.issues.length > 0 && (
                <ul>
                  {o.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

interface PrinterMappingFormProps {
  outcomes: LegacyBackupProjectOutcome[];
  mappings: MappingEntry[];
  onMappingChange: (
    index: number,
    field: 'targetPrinterId' | 'targetToolId',
    value: string,
  ) => void;
}

function PrinterMappingForm({
  outcomes,
  mappings,
  onMappingChange,
}: PrinterMappingFormProps): React.JSX.Element {
  const requireMapping = outcomes.filter(
    (o) =>
      o.requiresPrinterMapping &&
      (o.outcome === 'importable' || o.outcome === 'requiresAction'),
  );
  return (
    <section aria-labelledby="mapping-title">
      <h3 id="mapping-title">Printer and toolhead mapping</h3>
      <p>
        Every importable project must be mapped to an eligible authoritative
        PrintFarmer printer and physical toolhead. Eligibility requires Klipper
        firmware, Klipper G-code dialect, and upstream OrcaSlicer support; it is
        never inferred from names.
      </p>
      {requireMapping.length === 0 ? (
        <p>No projects require printer mapping.</p>
      ) : (
        <ul className="cal-import-mapping-list">
          {requireMapping.map((outcome, i) => {
            const entry = mappings.find(
              (m) => m.legacyProjectId === outcome.legacyProjectId,
            ) ?? { targetPrinterId: '', targetToolId: '' };
            return (
              <li
                key={outcome.legacyProjectId}
                className="cal-import-mapping-item"
              >
                <div>
                  <strong>{outcome.name}</strong>
                  {outcome.legacyPrinterName ? (
                    <span> (legacy printer: {outcome.legacyPrinterName})</span>
                  ) : null}
                </div>
                <label htmlFor={`printer-${i}`}>
                  PrintFarmer printer ID
                  <input
                    id={`printer-${i}`}
                    type="text"
                    required
                    placeholder="printer-uuid"
                    value={entry.targetPrinterId}
                    maxLength={256}
                    onChange={(e) =>
                      onMappingChange(i, 'targetPrinterId', e.target.value)
                    }
                    className="cal-input"
                  />
                </label>
                <label htmlFor={`tool-${i}`}>
                  Physical toolhead ID
                  <input
                    id={`tool-${i}`}
                    type="text"
                    required
                    placeholder="tool-uuid"
                    value={entry.targetToolId}
                    maxLength={256}
                    onChange={(e) =>
                      onMappingChange(i, 'targetToolId', e.target.value)
                    }
                    className="cal-input"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ImportResultView({
  result,
}: {
  result: Extract<CalibrationImportLegacyBackupV4Response, { status: 'ok' }>;
}): React.JSX.Element {
  const { importedProjectCount, projectResults, summary } = result;
  const reportText = [
    `Import complete. ${importedProjectCount} project(s) created.`,
    `File hash: ${summary.fileHash}`,
    '',
    'Per-project results:',
    ...projectResults.map(
      (r) =>
        `  ${r.legacyProjectId} → ${r.targetProjectId}: ${r.outcome}` +
        (r.detail ? ` (${r.detail})` : '') +
        ` | ${r.importedAttemptCount} attempts, ${r.importedPhotoCount} photos`,
    ),
  ].join('\n');

  const handleCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = reportText;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const handleDownload = () => {
    const blob = new Blob([reportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calibration-import-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="import-result-title">
      <h3 id="import-result-title">Import complete</h3>
      <p>
        <strong>{importedProjectCount}</strong> project(s) imported
        successfully.
      </p>
      <details>
        <summary>Per-project results ({projectResults.length})</summary>
        <ul className="cal-import-project-list">
          {projectResults.map((r) => (
            <li
              key={r.legacyProjectId}
              className={`cal-import-outcome--${r.outcome}`}
            >
              <strong>{r.legacyProjectId}</strong> → {r.targetProjectId}:{' '}
              <span>{r.outcome}</span>
              {r.detail ? ` — ${r.detail}` : ''}
              <br />
              <small>
                {r.importedAttemptCount} attempts, {r.importedPhotoCount} photos
              </small>
            </li>
          ))}
        </ul>
      </details>
      <div className="cal-import-report-actions">
        <button type="button" className="cal-button" onClick={handleCopy}>
          Copy report
        </button>
        <button type="button" className="cal-button" onClick={handleDownload}>
          Download report
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ImportLegacyBackupProps {
  profileId: string;
  env: CalibrationEnvironment;
  onClose: () => void;
  onImportComplete: () => void;
}

export function ImportLegacyBackup({
  profileId,
  env,
  onClose,
  onImportComplete,
}: ImportLegacyBackupProps): React.JSX.Element {
  const [step, setStep] = useState<ImportStep>('idle');
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<LegacyBackupPreflight | null>(
    null,
  );
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [importResult, setImportResult] = useState<Extract<
    CalibrationImportLegacyBackupV4Response,
    { status: 'ok' }
  > | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape must not abandon a native pick or an in-flight import.
  const dismissable = step !== 'importing' && step !== 'picking';
  const handleEscape = useCallback(() => {
    if (dismissable) onClose();
  }, [dismissable, onClose]);

  useDialogFocusLifecycle(dialogRef, true);
  useFocusTrap(dialogRef, true, handleEscape);

  // Initialise mapping entries when preflight completes
  const initMappings = useCallback((pf: LegacyBackupPreflight) => {
    const entries: MappingEntry[] = pf.projectOutcomes
      .filter(
        (o) =>
          o.requiresPrinterMapping &&
          (o.outcome === 'importable' || o.outcome === 'requiresAction'),
      )
      .map((o) => ({
        legacyProjectId: o.legacyProjectId,
        projectName: o.name,
        targetPrinterId: '',
        targetToolId: '',
      }));
    setMappings(entries);
  }, []);

  const handleMappingChange = useCallback(
    (
      index: number,
      field: 'targetPrinterId' | 'targetToolId',
      value: string,
    ) => {
      setMappings((prev) => {
        const next = [...prev];
        const entry = next[index];
        if (!entry) return prev;
        next[index] = { ...entry, [field]: value };
        return next;
      });
    },
    [],
  );

  const handlePick = useCallback(async () => {
    setStep('picking');
    setErrorMessage(null);
    let pickResult: CalibrationPickLegacyBackupV4Response;
    try {
      pickResult = await window.printFarmer.pickLegacyCalibrationBackupV4();
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'File pick failed.');
      setStep('error');
      return;
    }
    if (pickResult.status === 'cancelled') {
      setStep('idle');
      return;
    }
    if (pickResult.status === 'error') {
      setErrorMessage(pickResult.error.message);
      setStep('error');
      return;
    }
    setApprovalId(pickResult.approvalId);
    setPreflight(pickResult.preflight);
    initMappings(pickResult.preflight);
    setStep('preflight');
  }, [initMappings]);

  const handleProceedToMapping = useCallback(() => {
    if (preflight === null) return;
    const requireMapping = preflight.projectOutcomes.filter(
      (o) =>
        o.requiresPrinterMapping &&
        (o.outcome === 'importable' || o.outcome === 'requiresAction'),
    );
    if (requireMapping.length === 0) {
      setStep('reviewing');
    } else {
      setStep('mapping');
    }
  }, [preflight]);

  const handleProceedToReview = useCallback(() => {
    // Validate all required mappings are filled
    const incomplete = mappings.filter(
      (m) => !m.targetPrinterId.trim() || !m.targetToolId.trim(),
    );
    if (incomplete.length > 0) {
      setErrorMessage(
        `Complete all printer and toolhead fields before continuing (${incomplete.length} incomplete).`,
      );
      return;
    }
    setErrorMessage(null);
    setStep('reviewing');
  }, [mappings]);

  const handleImport = useCallback(async () => {
    if (approvalId === null || preflight === null) return;
    setStep('importing');
    setErrorMessage(null);
    const operationId = env.createId();
    const printerMappings: LegacyBackupPrinterMapping[] = mappings.map((m) => ({
      legacyProjectId: m.legacyProjectId,
      targetPrinterId: m.targetPrinterId.trim(),
      targetToolId: m.targetToolId.trim(),
    }));
    let result: CalibrationImportLegacyBackupV4Response;
    try {
      result = await window.printFarmer.importLegacyCalibrationBackupV4({
        profileId,
        approvalId,
        operationId,
        printerMappings,
      });
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Import failed.');
      setStep('error');
      return;
    }
    if (result.status === 'error') {
      setErrorMessage(result.error.message);
      setStep('error');
      return;
    }
    setImportResult(result);
    setStep('done');
    onImportComplete();
  }, [approvalId, preflight, mappings, profileId, env, onImportComplete]);

  const handleReset = useCallback(() => {
    setStep('idle');
    setApprovalId(null);
    setPreflight(null);
    setMappings([]);
    setImportResult(null);
    setErrorMessage(null);
  }, []);

  return (
    <div
      ref={dialogRef}
      className="cal-import-legacy-backup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-backup-title"
    >
      <header className="cal-import-header">
        <h2 id="import-backup-title">Import Legacy Calibration Backup</h2>
        <button
          type="button"
          className="cal-button"
          onClick={onClose}
          aria-label="Close import dialog"
          disabled={step === 'importing' || step === 'picking'}
        >
          ✕
        </button>
      </header>

      {step === 'idle' && (
        <section aria-label="Start import">
          <p>
            Import a PrintFarmer calibration backup v4 file. A native file
            picker will open — the application never scans browser storage or
            other application directories.
          </p>
          <div className="cal-import-actions">
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={() => void handlePick()}
            >
              Select backup file…
            </button>
            <button type="button" className="cal-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {step === 'picking' && <p role="status">Opening file picker…</p>}

      {step === 'preflight' && preflight !== null && (
        <>
          <PreflightSummary preflight={preflight} />
          {preflight.importableCount === 0 &&
          preflight.requiresActionCount === 0 ? (
            <div className="cal-alert" role="alert">
              No importable projects found. The backup contains only unsupported
              or corrupt records.
            </div>
          ) : null}
          <div className="cal-import-actions">
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={handleProceedToMapping}
              disabled={
                preflight.importableCount === 0 &&
                preflight.requiresActionCount === 0
              }
            >
              Continue
            </button>
            <button type="button" className="cal-button" onClick={handleReset}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'mapping' && preflight !== null && (
        <>
          <PrinterMappingForm
            outcomes={preflight.projectOutcomes}
            mappings={mappings}
            onMappingChange={handleMappingChange}
          />
          {errorMessage && (
            <div className="cal-alert" role="alert">
              {errorMessage}
            </div>
          )}
          <div className="cal-import-actions">
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={handleProceedToReview}
            >
              Review plan
            </button>
            <button
              type="button"
              className="cal-button"
              onClick={() => setStep('preflight')}
            >
              Back
            </button>
            <button type="button" className="cal-button" onClick={handleReset}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'reviewing' && preflight !== null && (
        <section aria-labelledby="review-title">
          <h3 id="review-title">Review import plan</h3>
          <p>
            Importing{' '}
            {preflight.importableCount + preflight.requiresActionCount}{' '}
            project(s) with {preflight.summary.attemptCount} attempts and{' '}
            {preflight.summary.photoCount} photos.
          </p>
          {mappings.length > 0 && (
            <ul>
              {mappings.map((m) => (
                <li key={m.legacyProjectId}>
                  <strong>{m.projectName}</strong> → printer{' '}
                  <code>{m.targetPrinterId}</code>, tool{' '}
                  <code>{m.targetToolId}</code>
                </li>
              ))}
            </ul>
          )}
          <p>
            This operation is idempotent. Exact replay with the same operation
            ID returns the original resources; a changed payload returns an
            error.
          </p>
          <div className="cal-import-actions">
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={() => void handleImport()}
            >
              Import to PrintFarmer
            </button>
            <button
              type="button"
              className="cal-button"
              onClick={() =>
                setStep(mappings.length > 0 ? 'mapping' : 'preflight')
              }
            >
              Back
            </button>
            <button type="button" className="cal-button" onClick={handleReset}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {step === 'importing' && (
        <p role="status" aria-live="polite">
          Importing — please wait. Do not close this window.
        </p>
      )}

      {step === 'done' && importResult !== null && (
        <>
          <ImportResultView result={importResult} />
          <div className="cal-import-actions">
            <button type="button" className="cal-button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}

      {step === 'error' && (
        <div className="cal-alert" role="alert">
          <strong>Import error</strong>
          <p>{errorMessage ?? 'An unexpected error occurred.'}</p>
          <div className="cal-import-actions">
            <button type="button" className="cal-button" onClick={handleReset}>
              Try again
            </button>
            <button type="button" className="cal-button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
