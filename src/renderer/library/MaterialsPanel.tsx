import { useMemo } from 'react';

import type { SceneMesh } from '../viewer/types';
import { summarizeSceneMaterials } from './sceneMaterials';

export interface MaterialsPanelProps {
  mesh: SceneMesh;
}

/**
 * The colours the scene is actually drawn in, with how much of the model each
 * one covers.
 *
 * This reads the same `material` records the scene graph builds its three.js
 * materials from, so the swatches cannot drift from what is on screen. A model
 * whose objects all share the viewer's fallback colour carries no material
 * information worth a panel, so nothing is rendered for it.
 */
export function MaterialsPanel({
  mesh,
}: MaterialsPanelProps): React.JSX.Element | null {
  const summary = useMemo(() => summarizeSceneMaterials(mesh), [mesh]);
  const { groups, perFaceTriangles } = summary;
  const hasAuthored = groups.some((group) => !group.isDefault);
  if (!hasAuthored && perFaceTriangles === 0) return null;

  return (
    <div className="materials-panel">
      <h2 className="viewer-tags-title">Materials</h2>
      <ul className="materials-list" aria-label="Materials">
        {groups.map((group) => (
          <li key={group.id} className="materials-item">
            <span
              className="materials-swatch"
              style={{ backgroundColor: group.hex }}
              // The colour is already named in the adjacent text, so the
              // swatch would only repeat it to a screen reader.
              aria-hidden="true"
            />
            <span className="materials-label">
              {group.isDefault ? 'Default colour' : group.hex}
            </span>
            <span className="materials-detail">
              {group.objects.toLocaleString()}{' '}
              {group.objects === 1 ? 'part' : 'parts'} ·{' '}
              {group.triangles.toLocaleString()}{' '}
              {group.triangles === 1 ? 'triangle' : 'triangles'}
            </span>
          </li>
        ))}
        {perFaceTriangles > 0 ? (
          <li className="materials-item materials-item-per-face">
            <span className="materials-label">Per-face colours</span>
            <span className="materials-detail">
              {perFaceTriangles.toLocaleString()}{' '}
              {perFaceTriangles === 1 ? 'triangle' : 'triangles'}
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
