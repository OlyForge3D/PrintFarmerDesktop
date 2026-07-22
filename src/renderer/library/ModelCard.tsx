import type { LogicalModel } from '@shared/ipc';
import {
  formatBytes,
  formatLabel,
  isAvailable,
  modelDisplayName,
} from './model';
import { useThumbnail } from './useThumbnail';
import { Icon } from '../ui/Icon';

export interface ModelCardProps {
  model: LogicalModel;
  selected: boolean;
  onSelect: (model: LogicalModel) => void;
  onPreview?: (model: LogicalModel) => void;
  favorite?: boolean;
  onToggleFavorite?: (model: LogicalModel) => void;
}

/** A single selectable model tile in the library grid. */
export function ModelCard({
  model,
  selected,
  onSelect,
  onPreview,
  favorite = false,
  onToggleFavorite,
}: ModelCardProps): React.JSX.Element {
  const name = modelDisplayName(model);
  const available = isAvailable(model);
  const format = formatLabel(model.format);
  const thumbnail = useThumbnail(model);

  return (
    <li className="model-card">
      {onToggleFavorite ? (
        <button
          type="button"
          className={favorite ? 'model-fav-button active' : 'model-fav-button'}
          aria-pressed={favorite}
          aria-label={favorite ? `Unfavorite ${name}` : `Favorite ${name}`}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => onToggleFavorite(model)}
        >
          <Icon name="star" />
        </button>
      ) : null}
      <button
        type="button"
        className={
          selected ? 'model-card-button selected' : 'model-card-button'
        }
        aria-pressed={selected}
        aria-label={`Select ${name}`}
        onClick={() => onSelect(model)}
        onDoubleClick={() => {
          if (available) {
            onPreview?.(model);
          }
        }}
        title={available ? name : `${name} (file missing)`}
      >
        <span className="model-thumb" aria-hidden="true">
          {thumbnail.status === 'ready' && thumbnail.src ? (
            <img className="model-thumb-img" src={thumbnail.src} alt="" />
          ) : (
            format
          )}
        </span>
        <span className="model-name">{name}</span>
        <span className="model-meta">
          <span className="model-format">{format}</span>
          <span className="model-size">{formatBytes(model.size)}</span>
          {model.locations.length > 1 ? (
            <span className="model-copies">
              {model.locations.length} copies
            </span>
          ) : null}
          {!available && <span className="model-missing">Missing</span>}
        </span>
      </button>
      {onPreview ? (
        <button
          type="button"
          className="model-preview-button"
          onClick={() => onPreview(model)}
          disabled={!available}
          aria-label={`Preview ${name} in 3D`}
          title={available ? 'Preview in 3D' : 'File unavailable'}
        >
          <Icon name="preview" />
          <span>Preview</span>
        </button>
      ) : null}
    </li>
  );
}
