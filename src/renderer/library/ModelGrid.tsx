import type { LogicalModel } from '@shared/ipc';
import { ModelCard } from './ModelCard';

export interface ModelGridProps {
  models: LogicalModel[];
  selectedHash: string | null;
  onSelect: (model: LogicalModel) => void;
  emptyLabel?: React.ReactNode;
}

/** Renders the catalog as a grid of selectable model cards. */
export function ModelGrid({
  models,
  selectedHash,
  onSelect,
  emptyLabel,
}: ModelGridProps): React.JSX.Element {
  if (models.length === 0) {
    return (
      <p className="library-empty">
        {emptyLabel ?? (
          <>
            No models yet. Add a folder to scan for <code>.stl</code> and{' '}
            <code>.3mf</code> files.
          </>
        )}
      </p>
    );
  }

  return (
    <ul className="model-grid" aria-label="Model library">
      {models.map((model) => (
        <ModelCard
          key={model.hash}
          model={model}
          selected={model.hash === selectedHash}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
