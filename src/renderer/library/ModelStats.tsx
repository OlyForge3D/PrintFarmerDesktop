import type { SceneMesh } from '../viewer/types';
import { computeSceneStats, formatDimension } from './sceneStats';

export interface ModelStatsProps {
  mesh: SceneMesh;
}

const FORMAT_LABELS: Record<SceneMesh['sourceFormat'], string> = {
  stl: 'STL',
  threeMf: '3MF',
  obj: 'OBJ',
};

/** A compact read-only summary of the loaded scene's geometry. */
export function ModelStats({ mesh }: ModelStatsProps): React.JSX.Element {
  const stats = computeSceneStats(mesh);
  const [dx, dy, dz] = stats.dimensions;

  return (
    <dl className="model-stats" aria-label="Model statistics">
      <div className="model-stat">
        <dt>Format</dt>
        <dd>{FORMAT_LABELS[stats.format]}</dd>
      </div>
      <div className="model-stat">
        <dt>Dimensions</dt>
        <dd>
          {formatDimension(dx)} × {formatDimension(dy)} × {formatDimension(dz)}
        </dd>
      </div>
      <div className="model-stat">
        <dt>Triangles</dt>
        <dd>{stats.triangles.toLocaleString()}</dd>
      </div>
      <div className="model-stat">
        <dt>Vertices</dt>
        <dd>{stats.vertices.toLocaleString()}</dd>
      </div>
      {stats.parts > 1 ? (
        <div className="model-stat">
          <dt>Parts</dt>
          <dd>{stats.parts.toLocaleString()}</dd>
        </div>
      ) : null}
    </dl>
  );
}
