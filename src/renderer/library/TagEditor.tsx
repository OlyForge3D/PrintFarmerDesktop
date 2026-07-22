import { useState } from 'react';
import type { Tag } from '@shared/ipc';

export interface TagEditorProps {
  tags: Tag[];
  onAdd: (name: string) => void;
  onRemove: (tagId: string) => void;
  disabled?: boolean;
}

/** Chips for a model's tags plus an input to add new ones. */
export function TagEditor({
  tags,
  onAdd,
  onRemove,
  disabled = false,
}: TagEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const name = draft.trim();
    if (name.length > 0) {
      onAdd(name);
      setDraft('');
    }
  };

  return (
    <div className="tag-editor">
      <ul className="tag-list" aria-label="Model tags">
        {tags.length === 0 ? (
          <li className="tag-empty">No tags</li>
        ) : (
          tags.map((tag) => (
            <li key={tag.id} className="tag-chip">
              <span>{tag.name}</span>
              <button
                type="button"
                className="tag-remove"
                aria-label={`Remove tag ${tag.name}`}
                onClick={() => onRemove(tag.id)}
                disabled={disabled}
              >
                ×
              </button>
            </li>
          ))
        )}
      </ul>
      <form
        className="tag-add"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          aria-label="Add a tag"
          placeholder="Add a tag…"
          value={draft}
          maxLength={128}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={disabled || draft.trim().length === 0}>
          Add
        </button>
      </form>
    </div>
  );
}
