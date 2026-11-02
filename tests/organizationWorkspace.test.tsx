import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  ApplyOrganizationDeletionRequest,
  PreviewOrganizationDeletionRequest,
  type OrganizationEntry,
  type PrintFarmerApi,
} from '@shared/ipc';
import { OrganizationWorkspace } from '../src/renderer/library/OrganizationWorkspace';

const FINGERPRINT = 'b'.repeat(64);

const entries: OrganizationEntry[] = [
  {
    kind: 'collection',
    id: 'c1',
    name: 'Dragons',
    modelCount: 3,
    synced: false,
    deleteScope: 'local',
  },
  {
    kind: 'collection',
    id: 'c2',
    name: 'Old prints',
    modelCount: 0,
    synced: false,
    deleteScope: 'local',
  },
  {
    kind: 'collection',
    id: 'c3',
    name: 'Farm shared',
    modelCount: 0,
    synced: true,
    deleteScope: 'readOnly',
  },
  {
    kind: 'collection',
    id: 'c4',
    name: 'Synced empty',
    modelCount: 0,
    synced: true,
    deleteScope: 'sync',
  },
  {
    kind: 'tag',
    id: 't1',
    name: 'red',
    modelCount: 0,
    synced: false,
    deleteScope: 'local',
  },
  {
    kind: 'tag',
    id: 't2',
    name: 'pla',
    modelCount: 5,
    synced: true,
    deleteScope: 'local',
  },
];

function api(value: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value,
    configurable: true,
  });
}

function renderWorkspace(
  overrides: Partial<PrintFarmerApi> = {},
  props: Partial<Parameters<typeof OrganizationWorkspace>[0]> = {},
) {
  const listOrganization = vi.fn().mockResolvedValue(entries);
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  api({ listOrganization, ...overrides });
  const view = render(
    <OrganizationWorkspace
      busy={false}
      revision={0}
      onChanged={onChanged}
      onDeleted={onDeleted}
      {...props}
    />,
  );
  return { listOrganization, onChanged, onDeleted, unmount: view.unmount };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OrganizationWorkspace', () => {
  it('lists collections with counts and source, and keeps shared ones out of deletion', async () => {
    renderWorkspace();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(
      screen.getByRole('checkbox', { name: 'Select Farm shared' }),
    ).toBeDisabled();
    expect(within(table).getByText('Shared · read-only')).toBeVisible();
    expect(within(table).getByText('Synced')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Select all unused (2)' }),
    ).toBeEnabled();
  });

  it('filters by name and usage', async () => {
    renderWorkspace();
    await screen.findByRole('table');
    fireEvent.change(screen.getByRole('combobox', { name: 'Show by usage' }), {
      target: { value: 'used' },
    });
    expect(screen.getByText('Dragons')).toBeVisible();
    expect(screen.queryByText('Old prints')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Show by usage' }), {
      target: { value: 'all' },
    });
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search collections' }),
      { target: { value: 'old' } },
    );
    expect(screen.getByText('Old prints')).toBeVisible();
    expect(screen.queryByText('Dragons')).not.toBeInTheDocument();
  });

  it('bulk deletes every unused collection after an exact review', async () => {
    const previewOrganizationDeletion = vi.fn().mockResolvedValue({
      kind: 'collection',
      entries: [entries[1], entries[3]],
      assignmentsRemoved: 0,
      serverDeletions: 1,
      fingerprint: FINGERPRINT,
    });
    const applyOrganizationDeletion = vi.fn().mockResolvedValue({
      kind: 'collection',
      deletedIds: ['c2', 'c4'],
      assignmentsRemoved: 0,
    });
    const { onDeleted, onChanged, listOrganization } = renderWorkspace({
      previewOrganizationDeletion,
      applyOrganizationDeletion,
    });
    await screen.findByRole('table');

    fireEvent.click(
      screen.getByRole('button', { name: 'Select all unused (2)' }),
    );
    expect(screen.getByText('2 selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion…' }));

    const review = await screen.findByRole('alert');
    expect(review).toHaveTextContent('Delete 2 collections?');
    expect(review).toHaveTextContent(
      '1 synced collection will also be deleted on PrintFarmer',
    );
    const request: unknown = previewOrganizationDeletion.mock.calls[0]![0];
    expect(PreviewOrganizationDeletionRequest.parse(request)).toEqual({
      kind: 'collection',
      ids: ['c2', 'c4'],
      emptyOnly: true,
    });
    expect(
      within(review).getByRole('button', { name: 'Keep collections' }),
    ).toHaveFocus();

    fireEvent.click(
      within(review).getByRole('button', { name: 'Delete 2 collections' }),
    );
    await screen.findByText('Deleted 2 collections.');
    expect(
      ApplyOrganizationDeletionRequest.parse(
        applyOrganizationDeletion.mock.calls[0]![0] as unknown,
      ),
    ).toEqual({ selection: request, fingerprint: FINGERPRINT });
    expect(onDeleted).toHaveBeenCalledWith('collection', ['c2', 'c4']);
    expect(onChanged).toHaveBeenCalled();
    expect(listOrganization).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Nothing selected')).toBeVisible();
  });

  it('invalidates the review when the selection changes', async () => {
    const previewOrganizationDeletion = vi.fn().mockResolvedValue({
      kind: 'collection',
      entries: [entries[1]],
      assignmentsRemoved: 0,
      serverDeletions: 0,
      fingerprint: FINGERPRINT,
    });
    renderWorkspace({ previewOrganizationDeletion });
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Old prints' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion…' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dragons' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('notifies the library about a completed deletion after leaving the workspace', async () => {
    let finishDeletion = (): void => undefined;
    const applyOrganizationDeletion = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDeletion = () =>
            resolve({
              kind: 'collection',
              deletedIds: ['c2'],
              assignmentsRemoved: 0,
            });
        }),
    );
    const { onDeleted, onChanged, unmount } = renderWorkspace({
      previewOrganizationDeletion: vi.fn().mockResolvedValue({
        kind: 'collection',
        entries: [entries[1]],
        assignmentsRemoved: 0,
        serverDeletions: 0,
        fingerprint: FINGERPRINT,
      }),
      applyOrganizationDeletion,
    });
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Old prints' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion…' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete 1 collection' }),
    );
    expect(applyOrganizationDeletion).toHaveBeenCalledOnce();
    unmount();
    finishDeletion();

    await waitFor(() =>
      expect(onDeleted).toHaveBeenCalledWith('collection', ['c2']),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('warns that tags from PrintFarmer only leave this computer', async () => {
    const previewOrganizationDeletion = vi.fn().mockResolvedValue({
      kind: 'tag',
      entries: [entries[5]],
      assignmentsRemoved: 5,
      serverDeletions: 0,
      fingerprint: FINGERPRINT,
    });
    renderWorkspace({ previewOrganizationDeletion }, { initialKind: 'tag' });
    await screen.findByRole('table');
    expect(screen.getByRole('radio', { name: /Tags/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select pla' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion…' }));
    const review = await screen.findByRole('alert');
    expect(previewOrganizationDeletion).toHaveBeenCalledWith({
      kind: 'tag',
      ids: ['t2'],
      emptyOnly: false,
    });
    expect(review).toHaveTextContent('5 model assignments will be removed');
    expect(review).toHaveTextContent('may return on the next sync');
  });

  it('reports a refused apply and refreshes the list', async () => {
    const previewOrganizationDeletion = vi.fn().mockResolvedValue({
      kind: 'collection',
      entries: [entries[1]],
      assignmentsRemoved: 0,
      serverDeletions: 0,
      fingerprint: FINGERPRINT,
    });
    const applyOrganizationDeletion = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'organization membership changed; refresh and review the selection',
        ),
      );
    const { onDeleted, listOrganization } = renderWorkspace({
      previewOrganizationDeletion,
      applyOrganizationDeletion,
    });
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Old prints' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion…' }));
    const review = await screen.findByRole('alert');
    fireEvent.click(
      within(review).getByRole('button', { name: 'Delete 1 collection' }),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((node) =>
            node.textContent?.includes('organization membership changed'),
          ),
      ).toBe(true),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(listOrganization).toHaveBeenCalledTimes(2);
  });

  it('renames a collection inline', async () => {
    const renameCollection = vi.fn().mockResolvedValue({
      id: 'c1',
      name: 'Wyrms',
      sharedToFarm: false,
      memberCount: 3,
    });
    renderWorkspace({ renameCollection });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Rename Dragons' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'New name for Dragons' }),
      { target: { value: 'Wyrms' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Renamed “Dragons” to “Wyrms”.');
    expect(renameCollection).toHaveBeenCalledWith({ id: 'c1', name: 'Wyrms' });
  });
});
