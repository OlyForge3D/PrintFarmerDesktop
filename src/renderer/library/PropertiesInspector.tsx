import type {
  Collection,
  LogicalModel,
  Tag,
  VendorMetadata,
} from '@shared/ipc';
import { Icon } from '../ui/Icon';
import { CollectionEditor } from './CollectionEditor';
import { TagEditor } from './TagEditor';
import { SceneStatsDisplay } from './ModelStats';
import type { SceneStats } from './sceneStats';
import { VendorPanel } from './VendorPanel';
import {
  formatBytes,
  formatLabel,
  isAvailable,
  modelDisplayName,
} from './model';
import { useThumbnail } from './useThumbnail';

const MAX_VISIBLE_LOCATIONS = 25;

export interface PropertiesInspectorProps {
  model: LogicalModel | null;
  favorite: boolean;
  stats: SceneStats | null;
  vendorMetadata: VendorMetadata | null;
  tags: Tag[];
  collections: Collection[];
  collectionMembership: Set<string>;
  organizationError: string | null;
  previewDisabled: boolean;
  retargetEligible?: boolean;
  onToggleFavorite: () => void;
  onPreview: () => void;
  onRetarget?: () => void;
  onAddTag: (name: string) => void;
  onRemoveTag: (tagId: string) => void;
  onToggleCollection: (collectionId: string) => void;
  onCreateCollection: (name: string) => void;
}

export function PropertiesInspector(
  props: PropertiesInspectorProps,
): React.JSX.Element {
  return (
    <aside className="properties-inspector" aria-label="Model properties">
      <header className="inspector-header">
        <p className="pane-eyebrow">Inspector</p>
        <h2>Properties</h2>
      </header>
      {props.model ? (
        <SelectedModelInspector {...props} model={props.model} />
      ) : (
        <div className="inspector-placeholder">
          <Icon name="file" size={28} />
          <p>Select a model to inspect its file details.</p>
          <span>The 3D viewer opens only when you choose Preview.</span>
        </div>
      )}
    </aside>
  );
}

function SelectedModelInspector({
  model,
  favorite,
  stats,
  vendorMetadata,
  tags,
  collections,
  collectionMembership,
  organizationError,
  previewDisabled,
  retargetEligible = false,
  onToggleFavorite,
  onPreview,
  onRetarget = () => undefined,
  onAddTag,
  onRemoveTag,
  onToggleCollection,
  onCreateCollection,
}: PropertiesInspectorProps & {
  model: LogicalModel;
}): React.JSX.Element {
  const name = modelDisplayName(model);
  const available = isAvailable(model);
  const thumbnail = useThumbnail(model);
  const visibleLocations = model.locations.slice(0, MAX_VISIBLE_LOCATIONS);
  const hiddenLocationCount = model.locations.length - visibleLocations.length;

  return (
    <div className="inspector-content">
      <section className="inspector-identity">
        <div className="inspector-thumbnail" aria-hidden="true">
          {thumbnail.status === 'ready' && thumbnail.src ? (
            <img src={thumbnail.src} alt="" />
          ) : (
            <Icon name="cube" size={28} />
          )}
        </div>
        <div className="inspector-name-block">
          <h3 title={name}>{name}</h3>
          <span
            className={
              available ? 'availability available' : 'availability missing'
            }
          >
            {available ? 'Available' : 'File unavailable'}
          </span>
        </div>
        <button
          type="button"
          className={favorite ? 'icon-button active' : 'icon-button'}
          aria-label={favorite ? `Unfavorite ${name}` : `Favorite ${name}`}
          aria-pressed={favorite}
          onClick={onToggleFavorite}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          className="inspector-preview-button"
          onClick={onRetarget}
          disabled={!retargetEligible || previewDisabled}
          title={
            retargetEligible
              ? 'Prepare this editable 3MF for Snapmaker U1'
              : 'Available cataloged editable 3MF required'
          }
        >
          <span>Prepare for Snapmaker U1</span>
        </button>
        <button
          type="button"
          className="inspector-preview-button"
          onClick={onPreview}
          disabled={!available || previewDisabled}
          title={
            !available
              ? 'File unavailable'
              : previewDisabled
                ? 'Import in progress'
                : `Preview ${name} in 3D`
          }
        >
          <Icon name="preview" />
          <span>Preview in 3D</span>
        </button>
      </section>

      <InspectorSection title="File">
        <dl className="property-list">
          <Property label="Format" value={formatLabel(model.format)} />
          <Property label="Size" value={formatBytes(model.size)} />
          <Property
            label="Copies"
            value={model.locations.length.toLocaleString()}
          />
          <Property
            label="Content hash"
            value={model.hash.slice(0, 12)}
            title={model.hash}
            monospace
          />
        </dl>
      </InspectorSection>

      {vendorMetadata ? (
        <InspectorSection title="Slicer project">
          <VendorPanel metadata={vendorMetadata} />
        </InspectorSection>
      ) : null}

      <InspectorSection title="Locations">
        <ul className="location-list">
          {visibleLocations.map((location) => (
            <li key={`${location.rootId}:${location.path}`}>
              <span
                className={
                  location.available
                    ? 'location-state available'
                    : 'location-state missing'
                }
              >
                {location.available ? 'Available' : 'Missing'}
              </span>
              <span className="location-path" title={location.path}>
                {location.path}
              </span>
            </li>
          ))}
          {hiddenLocationCount > 0 ? (
            <li className="location-overflow">
              Showing the first {MAX_VISIBLE_LOCATIONS} of{' '}
              {model.locations.length.toLocaleString()} locations.
            </li>
          ) : null}
        </ul>
      </InspectorSection>

      <InspectorSection title="Geometry">
        {stats ? (
          <SceneStatsDisplay stats={stats} />
        ) : (
          <p className="inspector-hint">Preview to inspect model geometry.</p>
        )}
      </InspectorSection>

      <InspectorSection title="Tags">
        <TagEditor tags={tags} onAdd={onAddTag} onRemove={onRemoveTag} />
      </InspectorSection>

      <InspectorSection title="Collections">
        <CollectionEditor
          all={collections}
          membership={collectionMembership}
          onToggle={onToggleCollection}
          onCreate={onCreateCollection}
        />
      </InspectorSection>

      {organizationError ? (
        <p role="alert" className="inline-error">
          {organizationError}
        </p>
      ) : null}
    </div>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Property({
  label,
  value,
  title,
  monospace = false,
}: {
  label: string;
  value: string;
  title?: string;
  monospace?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={monospace ? 'monospace' : undefined} title={title}>
        {value}
      </dd>
    </div>
  );
}
