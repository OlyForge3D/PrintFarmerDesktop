import type { ScenePart } from '../viewer/types';

export interface PartTreeProps {
  parts: readonly ScenePart[];
  hidden: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onToggleAll: (visible: boolean) => void;
}

/**
 * Lists the scene's parts (one per 3MF build item; one for an STL) with a
 * visibility checkbox each. Toggling a part hides its triangles in the viewer
 * without a re-parse. Renders nothing meaningful for single-part scenes beyond
 * the one row, which keeps the panel honest about model structure.
 */
export function PartTree({
  parts,
  hidden,
  onToggle,
  onToggleAll,
}: PartTreeProps): React.JSX.Element | null {
  if (parts.length === 0) {
    return null;
  }
  const allVisible = hidden.size === 0;

  return (
    <div className="part-tree">
      <div className="part-tree-header">
        <h2 className="viewer-tags-title">Parts</h2>
        <button
          type="button"
          className="part-tree-toggle-all"
          onClick={() => onToggleAll(!allVisible)}
        >
          {allVisible ? 'Hide all' : 'Show all'}
        </button>
      </div>
      <ul className="part-list" aria-label="Model parts">
        {parts.map((part, index) => {
          const visible = !hidden.has(index);
          return (
            <li key={`${part.name}-${index}`} className="part-item">
              <label>
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => onToggle(index)}
                />
                <span className="part-name">{part.name}</span>
                <span className="part-count">{part.triangleCount}△</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
