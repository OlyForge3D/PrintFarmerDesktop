import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ImportPreviewResponse, PrintFarmerApi } from '@shared/ipc';
import { ImportWizard } from '../src/renderer/library/ImportWizard.js';
import type { ImportPlan } from '../src/renderer/library/importPlan.js';
import type { ImportDraft } from '../src/renderer/library/useLibrary.js';

const approvalId = '11111111-1111-4111-8111-111111111111';
const recipeKey = 'printfarmer.import-recipe.v2.root-policies';

const preview: ImportPreviewResponse = {
  modelCount: 6,
  totalBytes: 1200,
  skippedErrors: 0,
  complete: true,
  formats: { stl: 0, threeMf: 0, obj: 6 },
  folders: [
    { relativePath: 'Miniatures', name: 'Miniatures', depth: 1, modelCount: 3 },
    {
      relativePath: 'Miniatures/Maker',
      name: 'Maker',
      depth: 2,
      modelCount: 2,
    },
    {
      relativePath: 'Miniatures/Maker/Project',
      name: 'Project',
      depth: 3,
      modelCount: 1,
    },
    { relativePath: 'Gift-Boxes', name: 'Gift-Boxes', depth: 1, modelCount: 3 },
    {
      relativePath: 'Gift-Boxes/Archive',
      name: 'Archive',
      depth: 2,
      modelCount: 1,
    },
  ],
  foldersTruncated: false,
};

const draft: ImportDraft = {
  rootId: 'root-policies',
  approvalId,
  path: '/models/import-policy-source',
  preview,
  collections: [],
  tags: [],
};

const organization = {
  affectedModels: 6,
  newCollections: ['Maker'],
  reusedCollections: [],
  newTags: ['miniatures'],
  reusedTags: [],
  unmatchedModels: 0,
  samples: [
    {
      relativePath: 'Miniatures/Maker/Project/model.obj',
      collections: ['Maker'],
      tags: ['miniatures'],
    },
  ],
  errors: [],
};

type PreviewImportMock = ReturnType<
  typeof vi.fn<PrintFarmerApi['previewImport']>
>;
type ConfirmImportMock = ReturnType<
  typeof vi.fn<(plan: ImportPlan, remember: boolean) => Promise<boolean>>
>;

function createConfirmImport(
  implementation: (
    plan: ImportPlan,
    remember: boolean,
  ) => Promise<boolean> = () => Promise.resolve(true),
): ConfirmImportMock {
  return vi.fn<(plan: ImportPlan, remember: boolean) => Promise<boolean>>(
    implementation,
  );
}

function createPreviewImport(): PreviewImportMock {
  return vi
    .fn<PrintFarmerApi['previewImport']>()
    .mockResolvedValue({ ...preview, organization });
}

function installPreview(
  previewImport: PreviewImportMock = createPreviewImport(),
): PreviewImportMock {
  Object.defineProperty(window, 'printFarmer', {
    value: { previewImport },
    configurable: true,
    writable: true,
  });
  return previewImport;
}

function renderWizard(busy = false): void {
  render(
    <ImportWizard
      draft={draft}
      busy={busy}
      error={null}
      onCancel={vi.fn()}
      onDismissError={vi.fn()}
      onConfirm={createConfirmImport()}
    />,
  );
}

async function waitForPreview(previewImport: PreviewImportMock): Promise<void> {
  await waitFor(() => expect(previewImport).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByText('Current plan')).toBeInTheDocument(),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('folder policy tree and preview', () => {
  it('starts collapsed and keeps the selected full path available after collapse', async () => {
    const previewImport = installPreview();
    renderWizard();
    await waitForPreview(previewImport);

    expect(
      screen.getByRole('button', { name: 'Expand Miniatures' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('button', {
        name: 'Edit policy for Miniatures/Maker',
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Miniatures' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit policy for Miniatures/Maker',
      }),
    );
    const editor = screen.getByRole('region', {
      name: 'Policy editor for Miniatures/Maker',
    });
    expect(within(editor).getByText('Miniatures/Maker')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse Miniatures' }),
    );
    expect(
      screen.queryByRole('button', {
        name: 'Edit policy for Miniatures/Maker',
      }),
    ).not.toBeInTheDocument();
    expect(within(editor).getByText('Miniatures/Maker')).toBeVisible();
  });

  it('sends a recipe pattern and its outputs in the authoritative preview request', async () => {
    const previewImport = installPreview();
    renderWizard();
    await waitForPreview(previewImport);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit policy for Miniatures' }),
    );
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Folder organization for Miniatures',
      }),
      { target: { value: 'recipe' } },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Path pattern for Miniatures' }),
      { target: { value: '{maker}/{project}/**' } },
    );
    fireEvent.change(
      screen.getByRole('textbox', {
        name: 'Recipe collection name for Miniatures',
      }),
      { target: { value: '{maker}' } },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Recipe tags for Miniatures' }),
      { target: { value: 'miniatures' } },
    );

    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.policies).toContainEqual({
        relativePath: 'Miniatures',
        mode: 'organize',
        collectionName: '{maker}',
        tags: ['miniatures'],
        pattern: '{maker}/{project}/**',
      });
    });
    expect(screen.getByText('Affected models')).toBeVisible();
    expect(
      screen.getByText('Example model paths and resulting organization'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Import 6 files' }),
    ).toBeEnabled();
  });

  it('resolves a fixed recipe collection by ID and blocks a missing saved target', async () => {
    localStorage.setItem(
      recipeKey,
      JSON.stringify({
        rules: [],
        ignoredPaths: [],
        commonTags: [],
        policies: [
          {
            relativePath: 'Miniatures',
            mode: 'organize',
            collectionName: 'Maker collection',
            collectionId: 'maker-collection-id',
            tags: [],
            pattern: '{project}/**',
          },
        ],
      }),
    );
    const previewImport = installPreview();
    const knownCollection = {
      id: 'maker-collection-id',
      name: 'Maker collection',
      sharedToFarm: false,
      memberCount: 2,
    };
    const { unmount } = render(
      <ImportWizard
        draft={{ ...draft, collections: [knownCollection] }}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={createConfirmImport()}
      />,
    );
    await waitForPreview(previewImport);
    expect(
      screen.getByRole('combobox', {
        name: 'Choose recipe collection for Miniatures',
      }),
    ).toHaveValue('maker-collection-id');
    expect(
      screen.getByRole('button', { name: 'Import 6 files' }),
    ).toBeEnabled();

    unmount();
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={createConfirmImport()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', {
          name: 'Choose recipe collection for Miniatures',
        }),
      ).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(
      screen.getByRole('button', { name: 'Import 6 files' }),
    ).toBeDisabled();
  });

  it('clears descendant and absent saved exceptions during subtree bulk actions', async () => {
    localStorage.setItem(
      recipeKey,
      JSON.stringify({
        rules: [
          {
            relativePath: 'Miniatures',
            kind: 'tag',
            name: 'old-additive',
          },
        ],
        ignoredPaths: ['Miniatures/Maker/legacy-ignored'],
        commonTags: [],
        policies: [
          {
            relativePath: 'Miniatures',
            mode: 'organize',
            collectionName: 'Old root',
            tags: [],
          },
          {
            relativePath: 'Miniatures/Maker',
            mode: 'disabled',
            tags: [],
          },
          {
            relativePath: 'Miniatures/Maker/absent-from-this-scan',
            mode: 'organize',
            collectionName: 'Stale exception',
            tags: [],
          },
        ],
      }),
    );
    const previewImport = installPreview();
    renderWizard();
    await waitForPreview(previewImport);

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select Miniatures and descendants',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Disable folder organization' }),
    );
    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.rules).not.toContainEqual(
        expect.objectContaining({ relativePath: 'Miniatures' }),
      );
      expect(request?.policies).toEqual([
        {
          relativePath: 'Miniatures',
          mode: 'disabled',
          tags: [],
        },
      ]);
    });

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select Miniatures and descendants',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear policy; inherit' }),
    );
    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.policies).toEqual([]);
      expect(request?.rules).toEqual([]);
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit policy for Miniatures' }),
    );
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Folder organization for Miniatures',
      }),
      { target: { value: 'tag' } },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Tags for Miniatures' }),
      {
        target: { value: 'shared-tag' },
      },
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select Miniatures and descendants',
      }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select Gift-Boxes and descendants',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Apply policy to selected subtrees',
      }),
    );
    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.policies).toContainEqual(
        expect.objectContaining({
          relativePath: 'Miniatures',
          mode: 'organize',
          tags: ['shared-tag'],
        }),
      );
      expect(request?.policies).toContainEqual(
        expect.objectContaining({
          relativePath: 'Gift-Boxes',
          mode: 'organize',
          tags: ['shared-tag'],
        }),
      );
      expect(request?.policies).not.toContainEqual(
        expect.objectContaining({ relativePath: 'Miniatures/Maker' }),
      );
    });
  });

  it('distinguishes explicit disabled from inherit and fails closed on preview errors', async () => {
    const previewImport = installPreview();
    renderWizard();
    await waitForPreview(previewImport);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Gift-Boxes' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit policy for Gift-Boxes/Archive',
      }),
    );
    const mode = screen.getByRole('combobox', {
      name: 'Folder organization for Gift-Boxes/Archive',
    });
    fireEvent.change(mode, { target: { value: 'disabled' } });
    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.policies).toContainEqual({
        relativePath: 'Gift-Boxes/Archive',
        mode: 'disabled',
        tags: [],
      });
    });
    fireEvent.change(mode, { target: { value: 'inherit' } });
    await waitFor(() => {
      const request = previewImport.mock.calls.at(-1)?.[0];
      expect(request?.policies).not.toContainEqual(
        expect.objectContaining({ relativePath: 'Gift-Boxes/Archive' }),
      );
    });

    previewImport.mockResolvedValueOnce({ ...preview });
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Folder organization for Gift-Boxes/Archive',
      }),
      { target: { value: 'disabled' } },
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Organization preview is unavailable',
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Import 6 files' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry organization preview' }),
    );
    await waitFor(() => expect(previewImport).toHaveBeenCalledTimes(5));
  });

  it('does not request a preview while busy or repeat a successful same-plan preview after failure', async () => {
    const previewImport = installPreview();
    const { rerender } = render(
      <ImportWizard
        draft={draft}
        busy
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={createConfirmImport()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(previewImport).not.toHaveBeenCalled();

    rerender(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={createConfirmImport(() =>
          Promise.reject(new Error('import failed')),
        )}
      />,
    );
    await waitForPreview(previewImport);
    expect(previewImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Import 6 files' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Import 6 files' }),
      ).toBeEnabled(),
    );
    expect(previewImport).toHaveBeenCalledTimes(1);
  });
});
