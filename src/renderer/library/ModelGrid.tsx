import type { LogicalModel } from '@shared/ipc';
import { ModelCard } from './ModelCard';

export interface ModelGridProps {
  models: LogicalModel[];
  selectedHashes?: ReadonlySet<string>;
  /** @deprecated Compatibility for single-selection callers. */
  selectedHash?: string | null;
  onSelect: (
    model: LogicalModel,
    modifiers?: { toggle: boolean; range: boolean },
  ) => void;
  onPreview?: (model: LogicalModel) => void;
  previewDisabled?: boolean;
  emptyLabel?: React.ReactNode;
  isFavorite?: (hash: string) => boolean;
  onToggleFavorite?: (model: LogicalModel) => void;
}

/** Renders the catalog as a grid of selectable model cards. */
export function ModelGrid({
  models,
  selectedHashes,
  selectedHash,
  onSelect,
  onPreview,
  previewDisabled = false,
  emptyLabel,
  isFavorite,
  onToggleFavorite,
}: ModelGridProps): React.JSX.Element {
  const selection =
    selectedHashes ?? new Set(selectedHash ? [selectedHash] : []);
  if (models.length === 0) {
    return (
      <div className="library-empty">
        {emptyLabel ?? (
          <>
            No models yet. Add a folder to scan for <code>.stl</code>,{' '}
            <code>.3mf</code>, and <code>.obj</code> files.
          </>
        )}
      </div>
    );
  }

  return (
    <ul className="model-grid" aria-label="Model grid">
      {models.map((model) => (
        <ModelCard
          key={model.hash}
          model={model}
          selected={selection.has(model.hash)}
          onSelect={onSelect}
          {...(onPreview ? { onPreview } : {})}
          previewDisabled={previewDisabled}
          favorite={isFavorite?.(model.hash) ?? false}
          {...(onToggleFavorite ? { onToggleFavorite } : {})}
        />
      ))}
    </ul>
  );
}
