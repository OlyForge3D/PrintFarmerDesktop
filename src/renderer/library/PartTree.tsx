import type { SceneObject, ScenePlate } from '../viewer/types';

export interface PartTreeProps {
  objects: readonly SceneObject[];
  rootObjectIds: readonly string[];
  plates: readonly ScenePlate[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visible: boolean) => void;
}

/**
 * Lists the scene graph shipped by the sidecar. Objects are grouped by plate and
 * nested by `parentId`, so the renderer can expose the Rust-side hierarchy
 * without reverse-engineering a flat triangle range table.
 */
export function PartTree({
  objects,
  rootObjectIds,
  plates,
  hidden,
  onToggle,
  onToggleAll,
}: PartTreeProps): React.JSX.Element | null {
  if (objects.length === 0) {
    return null;
  }

  const byId = new Map(objects.map((object) => [object.id, object]));
  const allVisible = hidden.size === 0;

  const groupedRoots =
    plates.length > 0
      ? plates.map((plate) => ({
          plate,
          roots: plate.rootObjectIds
            .map((id) => byId.get(id))
            .filter((object): object is SceneObject => Boolean(object)),
        }))
      : [
          {
            plate: null,
            roots: rootObjectIds
              .map((id) => byId.get(id))
              .filter((object): object is SceneObject => Boolean(object)),
          },
        ];

  return (
    <div className="part-tree">
      <div className="part-tree-header">
        <h2 className="viewer-tags-title">Objects</h2>
        <button
          type="button"
          className="part-tree-toggle-all"
          onClick={() => onToggleAll(!allVisible)}
        >
          {allVisible ? 'Hide all' : 'Show all'}
        </button>
      </div>
      <div className="part-list" aria-label="Scene objects">
        {groupedRoots.map(({ plate, roots }) => (
          <section key={plate?.id ?? 'scene-root'} className="part-plate">
            {plate ? <h3 className="part-plate-title">{plate.name}</h3> : null}
            <ul>
              {roots.map((object) => (
                <SceneObjectNode
                  key={object.id}
                  object={object}
                  byId={byId}
                  hidden={hidden}
                  ancestorHidden={false}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function SceneObjectNode({
  object,
  byId,
  hidden,
  ancestorHidden,
  onToggle,
}: {
  object: SceneObject;
  byId: ReadonlyMap<string, SceneObject>;
  hidden: ReadonlySet<string>;
  ancestorHidden: boolean;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const directlyHidden = hidden.has(object.id);
  const effectivelyHidden = ancestorHidden || directlyHidden;
  const triangles = object.mesh
    ? Math.floor(object.mesh.indices.length / 3)
    : 0;
  const children = object.children
    .map((id) => byId.get(id))
    .filter((entry): entry is SceneObject => Boolean(entry));

  return (
    <li key={object.id} className="part-item">
      <label>
        <input
          type="checkbox"
          checked={!effectivelyHidden}
          disabled={ancestorHidden}
          onChange={() => onToggle(object.id)}
        />
        <span className="part-name">{object.name}</span>
        <span className="part-count">
          {object.mesh
            ? `${triangles}△`
            : `${children.length.toLocaleString()} child${children.length === 1 ? '' : 'ren'}`}
        </span>
      </label>
      {children.length > 0 ? (
        <ul>
          {children.map((child) => (
            <SceneObjectNode
              key={child.id}
              object={child}
              byId={byId}
              hidden={hidden}
              ancestorHidden={effectivelyHidden}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
