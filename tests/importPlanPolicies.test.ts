import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreviewResponse } from '@shared/ipc';
import {
  buildImportPlan,
  applyPolicyToFolders,
  bulkFolderPolicies,
  initialImportChoices,
  policyValidationError,
  rememberImportPlan,
} from '../src/renderer/library/importPlan';
import { previewAllImportFolders } from '../src/renderer/library/importPreview';

const preview: ImportPreviewResponse = {
  modelCount: 602,
  totalBytes: 1234,
  skippedErrors: 0,
  complete: true,
  formats: { stl: 602, obj: 0, threeMf: 0 },
  folders: [
    'Miniatures',
    'Miniatures/Maker',
    'Miniatures/Maker/Project',
    'Boxes',
  ].map((relativePath) => ({
    relativePath,
    name: relativePath.split('/').at(-1)!,
    depth: relativePath.split('/').length,
    modelCount: 1,
  })),
  foldersTruncated: false,
};
const rootId = 'policies-test';

beforeEach(() => localStorage.clear());

describe('remembered subtree policies', () => {
  it('creates no automatic folder tags or collections', () => {
    const choices = initialImportChoices(rootId, 'Models', preview);
    expect(choices.folders.every((folder) => folder.mode === 'inherit')).toBe(
      true,
    );
    expect(buildImportPlan(choices)).toMatchObject({
      rules: [{ relativePath: '', kind: 'collection', name: 'Models' }],
      policies: [],
    });
  });

  it('migrates all explicitly saved v1 rules including multiple outputs and IDs', () => {
    const rules = [
      {
        relativePath: 'Miniatures',
        kind: 'collection',
        name: 'Old name',
        collectionId: 'stable-id',
      },
      { relativePath: 'Miniatures', kind: 'tag', name: 'miniatures' },
      { relativePath: 'Absent/Folder', kind: 'tag', name: 'preserved' },
    ];
    localStorage.setItem(
      `printfarmer.import-recipe.v1.${rootId}`,
      JSON.stringify({
        rules,
        commonTags: ['common'],
        ignoredPaths: ['Boxes'],
      }),
    );
    const choices = initialImportChoices(rootId, 'Models', preview);
    const plan = buildImportPlan(choices);
    expect(plan.rules).toEqual(rules);
    expect(choices.folders[0]).toMatchObject({
      legacy: true,
      collectionId: 'stable-id',
    });
    expect(choices.folders.at(-1)?.mode).toBe('ignore');
    expect(plan.policies).toEqual([]);
    rememberImportPlan(rootId, plan);
    expect(
      buildImportPlan(initialImportChoices(rootId, 'Models', preview)),
    ).toEqual(plan);
    expect(
      localStorage.getItem(`printfarmer.import-recipe.v1.${rootId}`),
    ).not.toBeNull();
  });

  it('remembers explicit disabled versus inherit and applies policies to newly discovered folders', () => {
    const choices = initialImportChoices(rootId, 'Models', preview);
    choices.folders[0] = {
      ...choices.folders[0]!,
      mode: 'collection',
      name: 'Miniatures',
    };
    choices.folders[1] = { ...choices.folders[1]!, mode: 'disabled' };
    rememberImportPlan(rootId, buildImportPlan(choices), [
      {
        relativePath: 'Miniatures',
        name: 'Miniatures',
        collectionId: 'stable-id',
      },
    ]);
    const next = initialImportChoices(rootId, 'Models', {
      ...preview,
      folders: [
        ...preview.folders,
        {
          relativePath: 'Miniatures/New',
          name: 'New',
          depth: 2,
          modelCount: 7,
        },
      ],
    });
    expect(next.folders[0]?.collectionId).toBe('stable-id');
    expect(next.folders[1]?.mode).toBe('disabled');
    expect(next.folders.at(-1)?.mode).toBe('inherit');
    expect(buildImportPlan(next).policies).toEqual([
      {
        relativePath: 'Miniatures',
        mode: 'organize',
        collectionName: 'Miniatures',
        collectionId: 'stable-id',
        tags: [],
      },
      { relativePath: 'Miniatures/Maker', mode: 'disabled', tags: [] },
    ]);
  });

  it('bulk scope removes collapsed and absent exceptions without resurrecting them on save', () => {
    rememberImportPlan(rootId, {
      rules: [{ relativePath: 'Miniatures/Absent', kind: 'tag', name: 'old' }],
      policies: [
        {
          relativePath: 'Miniatures/Absent/Deep',
          mode: 'organize',
          tags: ['old'],
        },
      ],
      ignoredPaths: [],
      commonTags: [],
      visibleFolderPaths: [],
    });
    const choices = initialImportChoices(rootId, 'Models', preview);
    const disabled = bulkFolderPolicies(choices, ['Miniatures'], 'disabled');
    const plan = buildImportPlan(disabled);
    expect(plan.rules).toEqual([]);
    expect(plan.policies).toEqual([
      { relativePath: 'Miniatures', mode: 'disabled', tags: [] },
    ]);
    rememberImportPlan(rootId, plan);
    const restored = initialImportChoices(rootId, 'Models', preview);
    expect(buildImportPlan(restored).policies).toEqual(plan.policies);
    expect(restored.legacyRules).toEqual([]);
    expect(
      buildImportPlan(bulkFolderPolicies(restored, ['Miniatures'], 'inherit'))
        .policies,
    ).toEqual([]);
  });

  it('blocks corrupt saved recipes rather than replacing them with defaults', () => {
    localStorage.setItem(`printfarmer.import-recipe.v2.${rootId}`, '{broken');
    const choices = initialImportChoices(rootId, 'Models', preview);
    expect(policyValidationError(choices)).toContain('blocked');
    expect(() => rememberImportPlan(rootId, buildImportPlan(choices))).toThrow(
      'blocked',
    );
  });

  it('rejects duplicate or invalid disabled saved policies rather than losing outputs', () => {
    for (const policies of [
      [{ relativePath: 'Miniatures', mode: 'disabled', tags: ['unexpected'] }],
      [
        { relativePath: 'Miniatures', mode: 'disabled', tags: [] },
        { relativePath: 'Miniatures', mode: 'organize', tags: ['duplicate'] },
      ],
    ]) {
      localStorage.setItem(
        `printfarmer.import-recipe.v2.${rootId}`,
        JSON.stringify({
          rules: [],
          commonTags: [],
          policies,
        }),
      );
      expect(
        initialImportChoices(rootId, 'Models', preview).recipeError,
      ).toContain('blocked');
    }
  });

  it('normalizes Windows v1 paths while preserving the original collection identity', () => {
    localStorage.setItem(
      `printfarmer.import-recipe.v1.${rootId}`,
      JSON.stringify({
        rules: [
          {
            relativePath: 'Miniatures\\Maker',
            kind: 'collection',
            name: 'Maker',
            collectionId: 'original',
          },
        ],
        commonTags: [],
      }),
    );
    const choices = initialImportChoices(rootId, 'Models', preview);
    expect(choices.folders[1]).toMatchObject({
      legacy: true,
      collectionId: 'original',
    });
    expect(buildImportPlan(choices).rules[0]?.relativePath).toBe(
      'Miniatures/Maker',
    );
  });

  it('bulk-enables a chosen policy across selected subtrees and clears old exceptions', () => {
    const choices = initialImportChoices(rootId, 'Models', preview);
    choices.folders[2] = {
      ...choices.folders[2]!,
      mode: 'tag',
      name: 'exception',
    };
    const enabled = applyPolicyToFolders(choices, ['Miniatures', 'Boxes'], {
      ...choices.folders[0]!,
      mode: 'collection',
      name: 'Shared',
      tagsText: 'printable',
    });
    expect(buildImportPlan(enabled).policies).toEqual([
      {
        relativePath: 'Miniatures',
        mode: 'organize',
        collectionName: 'Shared',
        tags: ['printable'],
      },
      {
        relativePath: 'Boxes',
        mode: 'organize',
        collectionName: 'Shared',
        tags: ['printable'],
      },
    ]);
    expect(enabled.folders[2]?.mode).toBe('inherit');
  });

  it('coalesces overlapping bulk selections instead of creating a policy per descendant', () => {
    const folders = Array.from({ length: 1200 }, (_, index) => ({
      relativePath: `Miniatures/Project${index}`,
      name: `Project${index}`,
      depth: 2,
      modelCount: 1,
    }));
    const choices = initialImportChoices(rootId, 'Models', {
      ...preview,
      folders: [preview.folders[0]!, ...folders],
    });
    const selected = choices.folders.map((folder) => folder.relativePath);
    const disabled = bulkFolderPolicies(choices, selected, 'disabled');
    expect(buildImportPlan(disabled).policies).toEqual([
      { relativePath: 'Miniatures', mode: 'disabled', tags: [] },
    ]);
    expect(policyValidationError(disabled)).toBeNull();
  });

  it('validates bounded named placeholders and keeps unused captures optional', () => {
    const choices = initialImportChoices(rootId, 'Models', preview);
    choices.folders[0] = {
      ...choices.folders[0]!,
      mode: 'recipe',
      pattern: '{maker}/{project}/**',
      name: '{maker}',
      tagsText: 'miniatures',
    };
    expect(policyValidationError(choices)).toBeNull();
    expect(buildImportPlan(choices).policies).toContainEqual({
      relativePath: 'Miniatures',
      mode: 'organize',
      pattern: '{maker}/{project}/**',
      collectionName: '{maker}',
      tags: ['miniatures'],
    });
    choices.folders[0].name = '{missing}';
    expect(policyValidationError(choices)).toContain('placeholders');
    choices.folders[0].name = '{maker}';
    choices.folders[0].pattern = '{maker}/{maker}/**';
    expect(policyValidationError(choices)).toContain('unique');
    choices.folders[0].pattern = '**/{maker}';
    expect(policyValidationError(choices)).not.toBeNull();
  });
});

describe('full folder discovery paging', () => {
  it('loads policies beyond folder 500 without increasing page size', async () => {
    const folders = Array.from({ length: 602 }, (_, index) => ({
      relativePath: `Folder${index}`,
      name: `Folder${index}`,
      depth: 1,
      modelCount: 1,
    }));
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        ...preview,
        folders: folders.slice(0, 500),
        foldersTotal: 602,
        foldersTruncated: true,
        nextFolderOffset: 500,
      })
      .mockResolvedValueOnce({
        ...preview,
        folders: folders.slice(500),
        foldersTotal: 602,
        foldersTruncated: false,
      });
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: { previewImport: api },
    });
    const result = await previewAllImportFolders({ approvalId: 'approval' });
    expect(result.folders).toHaveLength(602);
    expect(result.folders.at(-1)?.relativePath).toBe('Folder601');
    expect(api.mock.calls[1]?.[0]).toEqual({
      approvalId: 'approval',
      folderOffset: 500,
    });
    expect(result.foldersTruncated).toBe(false);
  });

  it('fails closed on truncated older sidecars and changing page totals', async () => {
    const api = vi
      .fn()
      .mockResolvedValue({ ...preview, foldersTruncated: true });
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: { previewImport: api },
    });
    await expect(
      previewAllImportFolders({ approvalId: 'approval' }),
    ).rejects.toThrow('incomplete');
    api
      .mockReset()
      .mockResolvedValueOnce({
        ...preview,
        foldersTotal: 502,
        foldersTruncated: true,
        nextFolderOffset: 500,
      })
      .mockResolvedValueOnce({ ...preview, foldersTotal: 503 });
    await expect(
      previewAllImportFolders({ approvalId: 'approval' }),
    ).rejects.toThrow('changed');
  });
});
