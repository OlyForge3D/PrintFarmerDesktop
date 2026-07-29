/**
 * Asset manifest loading, provenance display, and local file validation (A-01..A-08).
 *
 * Shows available calibration methods with their review status (A-06).
 * Backend-generated methods (OrcaSlicer in-slicer) display provenance and confirm
 * no local file is required; no upload button is shown (A-03, A-04, A-06).
 * For future user-provided methods, this panel would allow local file selection
 * via narrowly-named IPC (A-03, A-04).
 * External links open only via the named openCalibrationExternalUrl IPC (A-02, S-04).
 */
import { useState } from 'react';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import { calibrationApi } from './api';
import type { CalibrationStageId } from './domain';

// This manifest data mirrors compliance/calibration-asset-manifest.json (A-01)
// for type-safe renderer use. The JSON file is the reviewed source-of-truth.

/** A reviewed method that is generated server-side by OrcaSlicer — no local file required. */
interface BackendGeneratedMethodManifest {
  readonly reviewed: true;
  readonly generationMode: 'backendGenerated';
  readonly attributionLine: string;
  readonly licenseSpdx: string;
  readonly licenseUrl: string;
  readonly sourceModelUrl: string;
  readonly reviewerNotes: string;
}

/** A reviewed method that requires the user to provide a local model file. */
interface UserProvidedMethodManifest {
  readonly reviewed: true;
  readonly generationMode: 'userProvided';
  readonly expectedFilename: string;
  readonly expectedType: '3mf' | 'stl';
  readonly expectedSha256: string | null;
  readonly sourceModelUrl: string;
  readonly attributionLine: string;
  readonly licenseSpdx: string;
  readonly licenseUrl: string;
  readonly validationRules: {
    readonly maxBytes: number;
    readonly minBytes: number;
  };
}

/** An unreviewed method — disabled with a concrete reason. */
interface UnreviewedMethodManifest {
  readonly reviewed: false;
  readonly disabledReason: string;
  readonly sourceModelUrl: string;
}

type MethodManifest =
  | BackendGeneratedMethodManifest
  | UserProvidedMethodManifest
  | UnreviewedMethodManifest;

/**
 * Type guard: method is backend-generated (no local file required).
 * Satisfies A-06: these methods are reviewed; generation is permitted.
 */
function isBackendGenerated(
  m: MethodManifest,
): m is BackendGeneratedMethodManifest {
  return (
    m.reviewed &&
    (m as BackendGeneratedMethodManifest).generationMode === 'backendGenerated'
  );
}

/**
 * Type guard: method requires a user-provided local file.
 */
function isUserProvided(m: MethodManifest): m is UserProvidedMethodManifest {
  return (
    m.reviewed &&
    (m as UserProvidedMethodManifest).generationMode === 'userProvided'
  );
}

/**
 * Production manifest — mirrors compliance/calibration-asset-manifest.json.
 *
 * All four methods are confirmed backend-generated (OrcaSlicer in-slicer) based
 * on inspection of the pinned upstream commit 057d6117b9ab31747ede3a5684a009cb6079ad11.
 * The upstream public/models/manifest.json states: "Orca Slicer generates all core
 * calibration tests in-slicer, so no models are bundled or required."
 */
const METHOD_MANIFESTS: Readonly<Record<string, MethodManifest>> = {
  temperatureTower: {
    reviewed: true,
    generationMode: 'backendGenerated',
    attributionLine:
      'tayloraaron078-tech/Filament_Calibration_Wizard v1.3.2 (AGPL-3.0-only)',
    licenseSpdx: 'AGPL-3.0-only',
    licenseUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/License',
    sourceModelUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2',
    reviewerNotes:
      'Confirmed backend-generated via OrcaSlicer in-slicer generation on the PrintFarmer server. No external model file is required.',
  },
  flowStandard: {
    reviewed: true,
    generationMode: 'backendGenerated',
    attributionLine:
      'tayloraaron078-tech/Filament_Calibration_Wizard v1.3.2 (AGPL-3.0-only)',
    licenseSpdx: 'AGPL-3.0-only',
    licenseUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/License',
    sourceModelUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2',
    reviewerNotes:
      'Confirmed backend-generated via OrcaSlicer in-slicer generation on the PrintFarmer server. No external model file is required.',
  },
  pressureAdvanceTower: {
    reviewed: true,
    generationMode: 'backendGenerated',
    attributionLine:
      'tayloraaron078-tech/Filament_Calibration_Wizard v1.3.2 (AGPL-3.0-only)',
    licenseSpdx: 'AGPL-3.0-only',
    licenseUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/License',
    sourceModelUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2',
    reviewerNotes:
      'Confirmed backend-generated via OrcaSlicer in-slicer generation on the PrintFarmer server. No external model file is required.',
  },
  flowCoarse: {
    reviewed: true,
    generationMode: 'backendGenerated',
    attributionLine:
      'tayloraaron078-tech/Filament_Calibration_Wizard v1.3.2 (AGPL-3.0-only)',
    licenseSpdx: 'AGPL-3.0-only',
    licenseUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/License',
    sourceModelUrl:
      'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2',
    reviewerNotes:
      'Confirmed backend-generated via OrcaSlicer in-slicer generation on the PrintFarmer server. No external model file is required.',
  },
};

interface AssetLoaderPanelProps {
  readonly stageId: CalibrationStageId;
  readonly method: string;
  readonly attemptId: string;
}

type ValidationStatus =
  | { kind: 'idle' }
  | { kind: 'selecting' }
  | { kind: 'validating' }
  | { kind: 'valid'; sha256: string; byteSize: number; detectedType: string }
  | { kind: 'invalid'; reason: string; detail: string | null }
  | { kind: 'canceled' };

function validationReasonLabel(reason: string): string {
  switch (reason) {
    case 'invalidExtension':
      return 'Invalid file extension — expected .3mf or .stl';
    case 'invalidMagicBytes':
      return 'File does not have valid 3MF (ZIP) structure';
    case 'fileTooLarge':
      return 'File exceeds the 50 MB size limit';
    case 'fileTooSmall':
      return 'File is too small to be a valid calibration model';
    case 'geometryOutOfBounds':
      return 'The .3mf file does not contain a valid 3D model part';
    case 'checksumMismatch':
      return 'SHA-256 checksum does not match the expected value';
    case 'notARegularFile':
      return 'Selected item is not a regular file';
    case 'fileChangedDuringRead':
      return 'File changed while being read — please try again';
    default:
      return `Validation failed: ${reason}`;
  }
}

export function CalibrationAssetLoaderPanel({
  method,
}: AssetLoaderPanelProps): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>({
    kind: 'idle',
  });

  const manifest = METHOD_MANIFESTS[method] ?? null;

  const handleOpenSourcePage = (): void => {
    if (!manifest?.sourceModelUrl) return;
    store.openExternalUrl('calibration-source-releases');
  };

  const handleSelectFile = async (): Promise<void> => {
    if (!manifest || !isUserProvided(manifest)) return;
    setValidationStatus({ kind: 'selecting' });
    try {
      const approval = await calibrationApi().openCalibrationLocalModel();
      if (approval === null) {
        setValidationStatus({ kind: 'canceled' });
        return;
      }
      setValidationStatus({ kind: 'validating' });
      const result = await calibrationApi().validateCalibrationLocalModel({
        approvalId: approval.approvalId,
        method,
        expectedSha256: manifest.expectedSha256,
      });
      if (result === null) {
        setValidationStatus({ kind: 'canceled' });
        return;
      }
      if (result.status === 'canceled') {
        setValidationStatus({ kind: 'canceled' });
      } else if (result.status === 'invalid') {
        setValidationStatus({
          kind: 'invalid',
          reason: result.reason,
          detail: result.detail,
        });
      } else {
        setValidationStatus({
          kind: 'valid',
          sha256: result.sha256,
          byteSize: result.byteSize,
          detectedType: result.detectedType,
        });
        store.announce(
          'Calibration asset validated. Provenance stored with attempt.',
        );
      }
    } catch (cause) {
      setValidationStatus({
        kind: 'invalid',
        reason: 'notARegularFile',
        detail: cause instanceof Error ? cause.message : 'Validation failed.',
      });
    }
  };

  return (
    <section
      className="cal-step-section cal-asset-loader-panel"
      aria-labelledby="asset-loader-title"
    >
      <h2 id="asset-loader-title">Calibration asset</h2>

      {manifest === null ? (
        <p
          className="cal-alert cal-alert--warning"
          role="alert"
          data-testid="asset-no-method"
        >
          Select a calibration method to see its asset requirements.
        </p>
      ) : !manifest.reviewed ? (
        /* A-06: Unreviewed method disabled with concrete reason */
        <div className="cal-asset-disabled" data-testid="asset-method-disabled">
          <p className="cal-alert cal-alert--warning" role="alert">
            <strong>This method is not yet available:</strong>{' '}
            <span data-testid="asset-disabled-reason">
              {manifest.disabledReason}
            </span>
          </p>
          {manifest.sourceModelUrl ? (
            <button
              type="button"
              className="cal-button"
              onClick={handleOpenSourcePage}
              data-testid="asset-open-source-btn"
            >
              View source page (external)
            </button>
          ) : null}
        </div>
      ) : isBackendGenerated(manifest) ? (
        /* A-06: Backend-generated method — reviewed, no local file required (A-03, A-04).
         * The calibration test is generated server-side by OrcaSlicer via PrintFarmer.
         * No file upload button is shown; generation proceeds directly. */
        <div
          className="cal-asset-backend-generated"
          data-testid="asset-method-backend-generated"
        >
          {/* A-05: Display provenance to user */}
          <p
            className="cal-asset-backend-note"
            data-testid="asset-backend-generated-note"
          >
            ✓ This calibration test is generated server-side by OrcaSlicer via
            PrintFarmer. No local model file is required.
          </p>
          <dl className="cal-asset-provenance" data-testid="asset-provenance">
            <dt>Attribution</dt>
            <dd data-testid="asset-attribution">{manifest.attributionLine}</dd>
            <dt>License</dt>
            <dd data-testid="asset-license">
              {manifest.licenseSpdx}
              {' — '}
              <button
                type="button"
                className="cal-link-button"
                onClick={() =>
                  store.openExternalUrl('calibration-license-agpl3')
                }
                data-testid="asset-license-link"
              >
                View license
              </button>
            </dd>
            <dt>Source reference</dt>
            <dd>
              <button
                type="button"
                className="cal-link-button"
                onClick={handleOpenSourcePage}
                data-testid="asset-source-link"
              >
                {manifest.sourceModelUrl}
              </button>
            </dd>
          </dl>
        </div>
      ) : (
        /* Reviewed user-provided method: show provenance and allow file selection */
        <div className="cal-asset-reviewed" data-testid="asset-method-reviewed">
          {/* A-05: Display provenance to user */}
          <dl className="cal-asset-provenance" data-testid="asset-provenance">
            <dt>Attribution</dt>
            <dd data-testid="asset-attribution">{manifest.attributionLine}</dd>
            <dt>License</dt>
            <dd data-testid="asset-license">
              {manifest.licenseSpdx}
              {' — '}
              <button
                type="button"
                className="cal-link-button"
                onClick={() =>
                  store.openExternalUrl('calibration-license-agpl3')
                }
                data-testid="asset-license-link"
              >
                View license
              </button>
            </dd>
            <dt>Expected filename</dt>
            <dd data-testid="asset-expected-filename">
              {manifest.expectedFilename}
            </dd>
            <dt>Source</dt>
            <dd>
              <button
                type="button"
                className="cal-link-button"
                onClick={handleOpenSourcePage}
                data-testid="asset-source-link"
              >
                {manifest.sourceModelUrl}
              </button>
            </dd>
            {manifest.expectedSha256 ? (
              <>
                <dt>Expected SHA-256</dt>
                <dd data-testid="asset-expected-sha256">
                  <code>{manifest.expectedSha256.slice(0, 16)}…</code>
                </dd>
              </>
            ) : null}
          </dl>

          <div className="cal-asset-actions">
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={() => void handleSelectFile()}
              disabled={
                validationStatus.kind === 'selecting' ||
                validationStatus.kind === 'validating'
              }
              aria-busy={
                validationStatus.kind === 'selecting' ||
                validationStatus.kind === 'validating'
              }
              data-testid="asset-select-file-btn"
            >
              {validationStatus.kind === 'selecting'
                ? 'Opening file picker…'
                : validationStatus.kind === 'validating'
                  ? 'Validating…'
                  : 'Select local model file'}
            </button>
          </div>

          {validationStatus.kind === 'valid' ? (
            <div
              className="cal-asset-valid"
              role="status"
              aria-live="polite"
              data-testid="asset-validation-valid"
            >
              <p>✓ File validated successfully.</p>
              <dl>
                <dt>SHA-256</dt>
                <dd data-testid="asset-validated-sha256">
                  <code>{validationStatus.sha256.slice(0, 16)}…</code>
                </dd>
                <dt>Size</dt>
                <dd data-testid="asset-validated-size">
                  {(validationStatus.byteSize / 1024).toFixed(1)} KiB
                </dd>
                <dt>Type</dt>
                <dd data-testid="asset-validated-type">
                  {validationStatus.detectedType}
                </dd>
              </dl>
            </div>
          ) : validationStatus.kind === 'invalid' ? (
            <p
              className="cal-alert cal-alert--error"
              role="alert"
              aria-live="polite"
              data-testid="asset-validation-invalid"
            >
              <strong>[{validationStatus.reason}]</strong>{' '}
              <span data-testid="asset-validation-reason-label">
                {validationReasonLabel(validationStatus.reason)}
              </span>
              {validationStatus.detail ? (
                <span className="cal-validation-detail">
                  {' '}
                  — {validationStatus.detail}
                </span>
              ) : null}
            </p>
          ) : validationStatus.kind === 'canceled' ? (
            <p
              role="status"
              aria-live="polite"
              data-testid="asset-validation-canceled"
            >
              File selection canceled.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
