import { useState } from 'react';
import type { Collection } from '@shared/ipc';

export interface CollectionEditorProps {
  all: Collection[];
  membership: Set<string>;
  onToggle: (collectionId: string) => void;
  onCreate: (name: string) => void;
  disabled?: boolean;
}

/**
 * Lists every collection as a membership checkbox for the selected model, plus
 * an input to create a new collection and add the model to it.
 */
export function CollectionEditor({
  all,
  membership,
  onToggle,
  onCreate,
  disabled = false,
}: CollectionEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const name = draft.trim();
    if (name.length > 0) {
      onCreate(name);
      setDraft('');
    }
  };

  return (
    <div className="collection-editor">
      <ul className="collection-list" aria-label="Collections">
        {all.length === 0 ? (
          <li className="collection-empty">No collections yet</li>
        ) : (
          all.map((collection) => (
            <li key={collection.id} className="collection-item">
              <label>
                <input
                  type="checkbox"
                  checked={membership.has(collection.id)}
                  disabled={disabled}
                  onChange={() => onToggle(collection.id)}
                />
                <span className="collection-name">{collection.name}</span>
                <span className="collection-count">
                  {collection.memberCount}
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
      <form
        className="collection-add"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          aria-label="New collection name"
          placeholder="New collection…"
          value={draft}
          maxLength={128}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={disabled || draft.trim().length === 0}>
          Create &amp; add
        </button>
      </form>
    </div>
  );
}
