import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  ApplyCollectionChangeRequest,
  PreviewCollectionChangeRequest,
  type Collection,
  type PrintFarmerApi,
  type PreviewCollectionChangeResponse,
  type QueryModelsRequest,
} from '@shared/ipc';
import { CollectionManager } from '../src/renderer/library/CollectionManager';

const FINGERPRINT = 'a'.repeat(64);
const collections: Collection[] = [
  { id: 'c1', name: 'Dragons', sharedToFarm: false, memberCount: 2 },
  { id: 'c2', name: 'Terrain', sharedToFarm: false, memberCount: 0 },
];
const query: QueryModelsRequest = {
  query: 'orc',
  filter: 'stl',
  sort: 'name-asc',
  collectionIds: [],
  tagIds: ['red'],
  excludedRootIds: [],
  page: 3,
  pageSize: 48,
};

function preview(
  operation: 'add' | 'remove',
  modelCount: number,
  changeCount: number,
): PreviewCollectionChangeResponse {
  return {
    operation,
    fingerprint: FINGERPRINT,
    modelCount,
    changeCount,
    unchangedCount: modelCount - changeCount,
    targets: [
      {
        collectionId: 'c1',
        name: 'Dragons',
        changeCount,
        unchangedCount: modelCount - changeCount,
      },
    ],
  };
}

function api(value: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value,
    configurable: true,
  });
}

function renderManager(
  overrides: Partial<React.ComponentProps<typeof CollectionManager>> = {},
) {
  const props = {
    collections,
    selectedHashes: ['h1', 'h2'],
    queryRequest: query,
    matchingTotal: 300,
    queryPending: false,
    onChanged: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CollectionManager {...props} />);
  return props;
}

afterEach(() => cleanup());

describe('CollectionManager', () => {
  it('previews then applies a bulk add for the selected models only', async () => {
    const previewCollectionChange = vi
      .fn<PrintFarmerApi['previewCollectionChange']>()
      .mockResolvedValue(preview('add', 2, 1));
    const applyCollectionChange = vi
      .fn<PrintFarmerApi['applyCollectionChange']>()
      .mockResolvedValue({
        operation: 'add',
        modelCount: 2,
        changedMemberships: 1,
        unchangedMemberships: 1,
        collections,
      });
    api({ previewCollectionChange, applyCollectionChange });
    const props = renderManager();

    const previewButton = screen.getByRole('button', { name: 'Preview add' });
    expect(previewButton).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use Dragons for bulk change' }),
    );
    fireEvent.click(previewButton);
    await screen.findByText(/1 will be added, 1 already members/);
    expect(
      PreviewCollectionChangeRequest.parse(
        previewCollectionChange.mock.calls[0]?.[0],
      ),
    ).toEqual({
      operation: 'add',
      target: { kind: 'selected', hashes: ['h1', 'h2'] },
      collectionIds: ['c1'],
    });
    expect(applyCollectionChange).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm: add 1 membership' }),
    );
    await screen.findByText(/Added 1 membership across 2 models/);
    expect(
      ApplyCollectionChangeRequest.parse(
        applyCollectionChange.mock.calls[0]?.[0],
      ),
    ).toEqual({
      change: previewCollectionChange.mock.calls[0]?.[0],
      fingerprint: FINGERPRINT,
    });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('bulk removes from every model matching the filters across pages', async () => {
    const previewCollectionChange = vi
      .fn<PrintFarmerApi['previewCollectionChange']>()
      .mockResolvedValue(preview('remove', 300, 120));
    const applyCollectionChange = vi
      .fn<PrintFarmerApi['applyCollectionChange']>()
      .mockResolvedValue({
        operation: 'remove',
        modelCount: 300,
        changedMemberships: 120,
        unchangedMemberships: 180,
        collections,
      });
    api({ previewCollectionChange, applyCollectionChange });
    renderManager({ selectedHashes: [] });

    fireEvent.click(screen.getByRole('radio', { name: /Remove from/ }));
    expect(screen.getByRole('radio', { name: /All 300 models/ })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Selected models/ }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use Dragons for bulk change' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview remove' }));
    await screen.findByText(/120 will be removed, 180 not members/);
    expect(previewCollectionChange.mock.calls[0]?.[0].target).toEqual({
      kind: 'query',
      query,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm: remove 120 memberships' }),
    );
    await screen.findByText(/Removed 120 memberships across 300 models/);
    expect(applyCollectionChange).toHaveBeenCalledTimes(1);
  });

  it('invalidates a preview when the request changes and blocks unsettled filters', async () => {
    const previewCollectionChange = vi
      .fn<PrintFarmerApi['previewCollectionChange']>()
      .mockResolvedValue(preview('add', 2, 2));
    api({ previewCollectionChange, applyCollectionChange: vi.fn() });
    const { rerender } = render(
      <CollectionManager
        collections={collections}
        selectedHashes={['h1', 'h2']}
        queryRequest={query}
        matchingTotal={300}
        queryPending={false}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use Dragons for bulk change' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview add' }));
    await screen.findByRole('button', { name: 'Confirm: add 2 memberships' });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use Terrain for bulk change' }),
    );
    expect(screen.queryByRole('button', { name: /Confirm:/ })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /All 300 models/ }));
    rerender(
      <CollectionManager
        collections={collections}
        selectedHashes={['h1', 'h2']}
        queryRequest={query}
        matchingTotal={300}
        queryPending
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Preview add' })).toBeDisabled();
    expect(screen.getByText(/Waiting for the library filters/)).toBeTruthy();
  });

  it('renames a collection while keeping its id and surfaces errors', async () => {
    const renameCollection = vi
      .fn<PrintFarmerApi['renameCollection']>()
      .mockRejectedValueOnce(new Error('name already exists'))
      .mockResolvedValueOnce({ ...collections[0]!, name: 'Wyrms' });
    api({ renameCollection });
    const props = renderManager();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Dragons' }));
    const input = screen.getByRole('textbox', { name: 'New name for Dragons' });
    fireEvent.change(input, { target: { value: '  Wyrms ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'name already exists',
    );
    expect(props.onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Renamed “Dragons” to “Wyrms”.');
    expect(renameCollection).toHaveBeenLastCalledWith({
      id: 'c1',
      name: 'Wyrms',
    });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('deletes a collection only after confirmation and reports the id', async () => {
    const deleteCollection = vi
      .fn<PrintFarmerApi['deleteCollection']>()
      .mockRejectedValueOnce(
        new Error('shared remote collections are read-only'),
      )
      .mockResolvedValueOnce([collections[1]!]);
    api({ deleteCollection });
    const onDeleted = vi.fn();
    const props = renderManager({ onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dragons' }));
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(screen.getByText(/2 memberships will be removed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(
      screen.queryByRole('button', { name: 'Delete collection' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dragons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'read-only',
    );
    expect(onDeleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    await screen.findByText('Deleted “Dragons”.');
    expect(deleteCollection).toHaveBeenLastCalledWith({ id: 'c1' });
    expect(onDeleted).toHaveBeenCalledWith('c1');
    expect(props.onChanged).toHaveBeenCalledTimes(2);
  });

  it('updates the library when deletion completes after the dialog closes', async () => {
    let resolveDelete: (value: Collection[]) => void = () => undefined;
    const deleteCollection = vi
      .fn<PrintFarmerApi['deleteCollection']>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDelete = resolve;
          }),
      );
    api({ deleteCollection });
    const onDeleted = vi.fn();
    const props = renderManager({ onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dragons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Close collection manager' }),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    await act(async () => {
      resolveDelete([collections[1]!]);
      await Promise.resolve();
    });
    expect(onDeleted).toHaveBeenCalledWith('c1');
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a deletion failure that arrives after the dialog closes', async () => {
    let rejectDelete: (error: Error) => void = () => undefined;
    api({
      deleteCollection: () =>
        new Promise((_, reject) => {
          rejectDelete = reject;
        }),
    });
    const onDeleted = vi.fn();
    const onDeleteError = vi.fn();
    const props = renderManager({ onDeleted, onDeleteError });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dragons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Close collection manager' }),
    );
    cleanup();
    await act(async () => {
      rejectDelete(new Error('database unavailable'));
      await Promise.resolve();
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteError).toHaveBeenCalledWith(
      'Could not confirm deletion of “Dragons”: database unavailable. Check the refreshed library.',
    );
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not report success when the returned collection still exists', async () => {
    api({ deleteCollection: vi.fn().mockResolvedValue(collections) });
    const onDeleted = vi.fn();
    const props = renderManager({ onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dragons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The collection was not deleted',
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('creates a collection and checks it as a bulk destination', async () => {
    const createCollection = vi
      .fn<PrintFarmerApi['createCollection']>()
      .mockResolvedValue({
        id: 'c3',
        name: 'Imported',
        sharedToFarm: false,
        memberCount: 0,
      });
    api({ createCollection });
    const props = renderManager();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'New collection name' }),
      { target: { value: 'Imported' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Created “Imported”.');
    expect(createCollection).toHaveBeenCalledWith({ name: 'Imported' });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores results that arrive after the dialog closes', async () => {
    let resolve: (value: PreviewCollectionChangeResponse) => void = () =>
      undefined;
    api({
      previewCollectionChange: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const props = renderManager();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use Dragons for bulk change' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview add' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(preview('add', 2, 2));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Confirm:/ })).toBeNull(),
    );
  });
});
