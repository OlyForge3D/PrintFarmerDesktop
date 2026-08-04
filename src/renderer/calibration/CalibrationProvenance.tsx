/**
 * CalibrationProvenance
 *
 * Immutable provenance display for a queued calibration job (criterion 11).
 *
 * Shows (and never mutates):
 * - Upstream Orca version, Klipper dialect, printer snapshot revision,
 *   config revision, profile/model/specification/G-code hashes, queued
 *   job identity, assigned printer.
 *
 * All data is read-only once the job is queued. This component only renders —
 * it never writes.
 */

import React from 'react';
import type { CalibrationJobProvenance } from '@shared/ipc';

interface CalibrationProvenanceProps {
  readonly provenance: CalibrationJobProvenance;
}

function HashLine({
  label,
  hash,
}: {
  readonly label: string;
  readonly hash: string | null | undefined;
}) {
  if (!hash) return null;
  // Abbreviate for display: show first 12 + '…' + last 8 characters.
  const abbreviated =
    hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash;
  return (
    <div className="calibration-provenance__row">
      <dt className="calibration-provenance__label">{label}</dt>
      <dd className="calibration-provenance__hash" title={hash}>
        <code>{abbreviated}</code>
      </dd>
    </div>
  );
}

function IdLine({
  label,
  id,
}: {
  readonly label: string;
  readonly id: string | null | undefined;
}) {
  if (!id) return null;
  return (
    <div className="calibration-provenance__row">
      <dt className="calibration-provenance__label">{label}</dt>
      <dd className="calibration-provenance__value">
        <code>{id}</code>
      </dd>
    </div>
  );
}

function TextLine({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number | null | undefined;
}) {
  if (value == null) return null;
  return (
    <div className="calibration-provenance__row">
      <dt className="calibration-provenance__label">{label}</dt>
      <dd className="calibration-provenance__value">{String(value)}</dd>
    </div>
  );
}

/**
 * Immutable provenance display. All fields are read-only.
 * Once rendered, none of these values can change for a given job.
 */
export const CalibrationProvenance: React.FC<CalibrationProvenanceProps> = ({
  provenance,
}) => {
  return (
    <section className="calibration-provenance" aria-label="Job provenance">
      <h3 className="calibration-provenance__heading">Job Provenance</h3>
      <p className="calibration-provenance__intro">
        The following information is locked in at job creation time and never
        updated. It uniquely identifies what was generated and what environment
        was used.
      </p>
      <section aria-labelledby="provenance-identity">
        <h4
          id="provenance-identity"
          className="calibration-provenance__section-header"
        >
          Job Identity
        </h4>
        <dl className="calibration-provenance__details">
          <IdLine label="Job ID" id={provenance.jobId} />
          <IdLine label="Assigned Printer" id={provenance.assignedPrinterId} />
          <IdLine label="G-code File" id={provenance.gcodeFileId} />
          <TextLine
            label="Queue Revision (ETag)"
            value={provenance.rowVersion}
          />
        </dl>
      </section>

      <section aria-labelledby="provenance-environment">
        <h4
          id="provenance-environment"
          className="calibration-provenance__section-header"
        >
          Generation Environment
        </h4>
        <dl className="calibration-provenance__details">
          <TextLine
            label="Upstream Orca Version"
            value={provenance.requiredSlicerVersion}
          />
          <TextLine
            label="Klipper Dialect"
            value={provenance.requiredGcodeDialect}
          />
          <TextLine
            label="Firmware Family"
            value={provenance.requiredFirmwareFamily}
          />
          <TextLine
            label="Slicer Container Digest"
            value={provenance.requiredSlicerContainerDigest}
          />
          <TextLine
            label="Printer Config Revision"
            value={provenance.pinnedPrinterConfigRevision}
          />
        </dl>
      </section>

      <section aria-labelledby="provenance-hashes">
        <h4
          id="provenance-hashes"
          className="calibration-provenance__section-header"
        >
          Content Hashes (SHA-256)
        </h4>
        <dl className="calibration-provenance__details">
          <HashLine
            label="G-code Content"
            hash={provenance.gcodeContentSha256}
          />
          <HashLine
            label="Specification"
            hash={provenance.specificationSha256}
          />
          <HashLine
            label="Machine Profile"
            hash={provenance.machineProfileSha256}
          />
          <HashLine
            label="Process Profile"
            hash={provenance.processProfileSha256}
          />
          <HashLine
            label="Filament Profile"
            hash={provenance.filamentProfileSha256}
          />
          <HashLine
            label="Printer Config Snapshot"
            hash={provenance.printerConfigSnapshotSha256}
          />
        </dl>
      </section>
    </section>
  );
};

export default CalibrationProvenance;
