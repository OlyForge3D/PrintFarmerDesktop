import type { PlateSliceInfo, Slicer, VendorMetadata } from '@shared/ipc';

export interface VendorPanelProps {
  metadata: VendorMetadata;
}

const SLICER_LABELS: Record<Slicer, string> = {
  prusaSlicer: 'PrusaSlicer',
  superSlicer: 'SuperSlicer',
  bambuStudio: 'Bambu Studio',
  orcaSlicer: 'OrcaSlicer',
  cura: 'Cura',
  unknown: 'Unknown slicer',
};

/** Format a duration in seconds as `Hh Mm` / `Mm` for print-time predictions. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function plateLabel(plate: PlateSliceInfo, fallbackIndex: number): string {
  return `Plate ${plate.index ?? fallbackIndex + 1}`;
}

/**
 * Render a 3MF metadata date, which is only conventionally ISO-8601.
 *
 * The value comes straight from the file, so it can be anything an authoring
 * tool wrote. Anything unparseable is shown verbatim rather than replaced with
 * "Invalid Date", so the user still sees what the file actually says.
 */
export function formatMetadataDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Read-only slicer-project details for a vendor 3MF: authoring slicer, core
 * metadata, and per-plate print-time/weight/filament stats. Standard 3MF with
 * no vendor payload renders a short "no vendor data" note instead.
 *
 * `VendorMetadata.thumbnails` is deliberately not rendered here. It carries ZIP
 * part *names* rather than image data, so this panel has nothing to show for
 * them; `VendorPlateThumbnails` is the surface that resolves and displays the
 * actual images. Stating that explicitly because the rest of this panel exists
 * to stop extracted fields being silently dropped at the last step, and an
 * unrendered field is otherwise indistinguishable from that bug.
 */
export function VendorPanel({ metadata }: VendorPanelProps): React.JSX.Element {
  const { slicer, core, plates } = metadata;
  const hasCore =
    core.title ||
    core.designer ||
    core.description ||
    core.application ||
    core.licenseTerms ||
    core.copyright ||
    core.creationDate ||
    core.modificationDate;

  if (slicer === 'unknown' && !hasCore && plates.length === 0) {
    return (
      <div className="vendor-panel">
        <h2 className="viewer-tags-title">Slicer project</h2>
        <p className="vendor-empty">No slicer/vendor metadata in this file.</p>
      </div>
    );
  }

  return (
    <div className="vendor-panel">
      <h2 className="viewer-tags-title">Slicer project</h2>
      <dl className="vendor-core" aria-label="Slicer metadata">
        <div className="model-stat">
          <dt>Slicer</dt>
          <dd>{SLICER_LABELS[slicer]}</dd>
        </div>
        {core.title ? (
          <div className="model-stat">
            <dt>Title</dt>
            <dd>{core.title}</dd>
          </div>
        ) : null}
        {core.designer ? (
          <div className="model-stat">
            <dt>Designer</dt>
            <dd>{core.designer}</dd>
          </div>
        ) : null}
        {core.application ? (
          <div className="model-stat">
            <dt>Application</dt>
            <dd>{core.application}</dd>
          </div>
        ) : null}
        {core.licenseTerms ? (
          <div className="model-stat">
            <dt>License</dt>
            <dd>{core.licenseTerms}</dd>
          </div>
        ) : null}
        {core.copyright ? (
          <div className="model-stat">
            <dt>Copyright</dt>
            <dd>{core.copyright}</dd>
          </div>
        ) : null}
        {core.creationDate ? (
          <div className="model-stat">
            <dt>Created</dt>
            <dd>{formatMetadataDate(core.creationDate)}</dd>
          </div>
        ) : null}
        {core.modificationDate ? (
          <div className="model-stat">
            <dt>Modified</dt>
            <dd>{formatMetadataDate(core.modificationDate)}</dd>
          </div>
        ) : null}
      </dl>
      {core.description ? (
        <p className="vendor-description">{core.description}</p>
      ) : null}
      {plates.length > 0 ? (
        <ul className="vendor-plates" aria-label="Plates">
          {plates.map((plate, index) => (
            <li key={plate.index ?? index} className="vendor-plate">
              <span className="vendor-plate-name">
                {plateLabel(plate, index)}
              </span>
              <span className="vendor-plate-stats">
                {plate.predictionSeconds !== undefined
                  ? formatDuration(plate.predictionSeconds)
                  : null}
                {plate.weightGrams !== undefined
                  ? ` · ${plate.weightGrams}g`
                  : null}
                {plate.filamentTypes.length > 0
                  ? ` · ${plate.filamentTypes.join(', ')}`
                  : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
