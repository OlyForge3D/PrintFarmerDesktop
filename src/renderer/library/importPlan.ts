import {
  ImportRule as ImportRuleSchema,
  ImportPolicy as ImportPolicySchema,
  type ImportPreviewResponse,
  type ImportRule,
  type ImportPolicy,
  type ImportRootResponse,
} from '@shared/ipc';
import { z } from 'zod';

const LEGACY_PREFIX = 'printfarmer.import-recipe.v1.';
const STORAGE_PREFIX = 'printfarmer.import-recipe.v2.';
const SavedRecipe = z.object({
  rules: z.array(ImportRuleSchema).max(1000),
  ignoredPaths: z.array(z.string().max(4096)).max(1000).default([]),
  commonTags: z.array(z.string().trim().min(1).max(128)).max(100),
  policies: z.array(ImportPolicySchema).max(1000).default([]),
});
type StoredImportRecipe = z.infer<typeof SavedRecipe>;

export interface ImportFolderChoice {
  relativePath: string;
  depth: number;
  modelCount: number;
  mode: ImportRule['kind'] | 'ignore' | 'inherit' | 'disabled' | 'recipe';
  name: string;
  collectionId?: string;
  collectionTargetUnresolved?: boolean;
  tagsText: string;
  pattern: string;
  legacy: boolean;
}

export interface ImportChoices {
  rootCollection: boolean;
  rootCollectionName: string;
  rootCollectionId?: string;
  rootCollectionTargetUnresolved?: boolean;
  folders: ImportFolderChoice[];
  commonTagsText: string;
  legacyRules: ImportRule[];
  legacyIgnoredPaths: string[];
  policies: ImportPolicy[];
  recipeError?: string;
}

export interface ImportPlan {
  rules: ImportRule[];
  ignoredPaths: string[];
  commonTags: string[];
  visibleFolderPaths: string[];
  policies?: ImportPolicy[];
  completeRecipe?: boolean;
}

export function initialImportChoices(
  rootId: string,
  rootName: string,
  preview: ImportPreviewResponse,
): ImportChoices {
  const { recipe: saved, error } = readRecipe(rootId);
  const rootRule = saved?.rules.find(
    (rule) => rule.relativePath === '' && rule.kind === 'collection',
  );
  const ignoredPaths = new Set(saved?.ignoredPaths ?? []);
  const rootCollectionId =
    rootRule?.kind === 'collection' ? rootRule.collectionId : undefined;
  return {
    rootCollection: saved ? Boolean(rootRule) : true,
    rootCollectionName: rootRule?.name ?? rootName,
    ...(rootCollectionId ? { rootCollectionId } : {}),
    legacyRules: saved?.rules ?? [],
    legacyIgnoredPaths: saved?.ignoredPaths ?? [],
    policies: saved?.policies ?? [],
    ...(error ? { recipeError: error } : {}),
    folders: preview.folders.map((folder) => {
      const prior = saved?.rules.find(
        (rule) => rule.relativePath === folder.relativePath,
      );
      const policy = saved?.policies.find(
        (item) => item.relativePath === folder.relativePath,
      );
      const choice: ImportFolderChoice = {
        relativePath: folder.relativePath,
        depth: folder.depth,
        modelCount: folder.modelCount,
        mode: policy
          ? policy.mode === 'disabled'
            ? 'disabled'
            : policy.pattern
              ? 'recipe'
              : policy.collectionName
                ? 'collection'
                : 'tag'
          : ignoredPaths.has(folder.relativePath)
            ? 'ignore'
            : (prior?.kind ?? 'inherit'),
        name: policy
          ? (policy.collectionName ??
            (policy.pattern ? '' : policy.tags.join(', ')))
          : (prior?.name ?? folder.name),
        tagsText: policy?.tags.join(', ') ?? '',
        pattern: policy?.pattern ?? '',
        legacy:
          !policy && Boolean(prior || ignoredPaths.has(folder.relativePath)),
      };
      const id =
        policy?.collectionId ??
        (prior?.kind === 'collection' ? prior.collectionId : undefined);
      return id ? { ...choice, collectionId: id } : choice;
    }),
    commonTagsText: saved?.commonTags.join(', ') ?? '',
  };
}

export function buildImportPlan(choices: ImportChoices): ImportPlan {
  const editedPaths = new Set(
    choices.folders
      .filter((folder) => !folder.legacy)
      .map((folder) => folder.relativePath),
  );
  const rules = choices.legacyRules.filter(
    (rule) =>
      !(rule.relativePath === '' && rule.kind === 'collection') &&
      !editedPaths.has(rule.relativePath),
  );
  const rootName = choices.rootCollectionName.trim();
  if (choices.rootCollection && rootName) {
    rules.unshift({
      relativePath: '',
      kind: 'collection',
      name: rootName,
      ...(choices.rootCollectionId
        ? { collectionId: choices.rootCollectionId }
        : {}),
    });
  }
  const policies = choices.policies.filter(
    (policy) => !editedPaths.has(policy.relativePath),
  );
  for (const folder of choices.folders) {
    if (folder.legacy || folder.mode === 'inherit' || folder.mode === 'ignore')
      continue;
    if (folder.mode === 'disabled') {
      policies.push({
        relativePath: folder.relativePath,
        mode: 'disabled',
        tags: [],
      });
      continue;
    }
    const collectionName =
      folder.mode === 'collection' || folder.mode === 'recipe'
        ? folder.name.trim()
        : '';
    policies.push({
      relativePath: folder.relativePath,
      mode: 'organize',
      ...(collectionName ? { collectionName } : {}),
      ...(collectionName && folder.collectionId
        ? { collectionId: folder.collectionId }
        : {}),
      tags:
        folder.mode === 'tag'
          ? parseTags(folder.name)
          : parseTags(folder.tagsText),
      ...(folder.mode === 'recipe' ? { pattern: folder.pattern.trim() } : {}),
    });
  }
  return {
    rules,
    policies,
    completeRecipe: true,
    ignoredPaths: choices.legacyIgnoredPaths.filter(
      (path) => !editedPaths.has(path),
    ),
    commonTags: parseTags(choices.commonTagsText),
    visibleFolderPaths: choices.folders.map((folder) => folder.relativePath),
  };
}

export function parseTags(value: string): string[] {
  const unique = new Map<string, string>();
  for (const part of value.split(/[,;\n]/)) {
    const tag = part.trim();
    if (tag) unique.set(tag.toLowerCase(), tag);
  }
  return [...unique.values()];
}

export function policyValidationError(choices: ImportChoices): string | null {
  if (choices.recipeError) return choices.recipeError;
  const plan = buildImportPlan(choices);
  if (plan.rules.length > 1000 || (plan.policies?.length ?? 0) > 1000) {
    return 'Use no more than 1000 explicit folder policies or saved rules.';
  }
  for (const folder of choices.folders) {
    if (
      !folder.legacy &&
      (folder.mode === 'collection' || folder.mode === 'tag') &&
      !folder.name.trim()
    ) {
      return `Enter an organization name for ${folder.relativePath}.`;
    }
  }
  for (const policy of plan.policies ?? []) {
    if (!ImportPolicySchema.safeParse(policy).success) {
      return `Check names, tags and pattern limits for ${policy.relativePath || 'the source'}.`;
    }
    if (policy.mode === 'disabled') continue;
    if (!policy.collectionName && !policy.tags.length)
      return 'Choose a collection or at least one tag for the policy.';
    const captures = new Set<string>();
    if (policy.pattern !== undefined) {
      const segments = policy.pattern.split('/');
      if (
        segments.length > 32 ||
        segments.some((segment, index) => {
          const capture = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
          if (capture?.[1]) {
            if (captures.has(capture[1])) return true;
            captures.add(capture[1]);
            return false;
          }
          return (
            !segment ||
            segment === '.' ||
            segment === '..' ||
            (segment === '**'
              ? index !== segments.length - 1
              : /[{}*\\:]/.test(segment))
          );
        })
      )
        return 'Use literal path segments, unique {names}, and optional trailing ** (up to 32 segments).';
    }
    for (const output of [policy.collectionName, ...policy.tags]) {
      if (output === undefined) continue;
      const placeholders = [
        ...output.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
      ];
      const rest = output.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '');
      if (
        /[{}]/.test(rest) ||
        placeholders.some((match) => !captures.has(match[1] ?? ''))
      ) {
        return "Output placeholders must be named captures from this policy's path pattern.";
      }
      if (policy.collectionId && placeholders.length)
        return 'Choose a fixed collection by ID or a template name, not both.';
    }
  }
  return null;
}

/** Bulk scope includes collapsed and currently absent descendants, not just displayed rows. */
export function bulkFolderPolicies(
  choices: ImportChoices,
  selectedPaths: readonly string[],
  mode: 'inherit' | 'disabled',
): ImportChoices {
  const roots = selectedSubtreeRoots(selectedPaths);
  const inScope = (path: string): boolean =>
    roots.some(
      (selected) => path === selected || path.startsWith(`${selected}/`),
    );
  const selected = new Set(roots);
  return {
    ...choices,
    legacyRules: choices.legacyRules.filter(
      (rule) => !inScope(rule.relativePath),
    ),
    legacyIgnoredPaths: choices.legacyIgnoredPaths.filter(
      (path) => !inScope(path),
    ),
    policies: choices.policies.filter(
      (policy) => !inScope(policy.relativePath),
    ),
    folders: choices.folders.map((folder) =>
      inScope(folder.relativePath)
        ? {
            ...folder,
            mode: selected.has(folder.relativePath) ? mode : 'inherit',
            legacy: false,
          }
        : folder,
    ),
  };
}

export function applyPolicyToFolders(
  choices: ImportChoices,
  selectedPaths: readonly string[],
  policy: ImportFolderChoice,
): ImportChoices {
  const cleared = bulkFolderPolicies(choices, selectedPaths, 'inherit');
  const selected = new Set(selectedSubtreeRoots(selectedPaths));
  return {
    ...cleared,
    folders: cleared.folders.map((folder) =>
      selected.has(folder.relativePath)
        ? {
            ...policy,
            relativePath: folder.relativePath,
            depth: folder.depth,
            modelCount: folder.modelCount,
            legacy: false,
          }
        : folder,
    ),
  };
}

function selectedSubtreeRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  for (const path of [...new Set(paths)].sort((a, b) => a.length - b.length)) {
    if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      roots.push(path);
    }
  }
  return roots;
}

export function rememberImportPlan(
  rootId: string,
  plan: ImportPlan,
  resolvedCollections: ImportRootResponse['resolvedCollections'] = [],
): void {
  const { recipe: previous, error } = readRecipe(rootId);
  if (error) throw new Error(error);
  const visiblePaths = new Set(plan.visibleFolderPaths);
  const resolvedByPath = new Map(
    resolvedCollections.map((collection) => [
      collection.relativePath,
      collection,
    ]),
  );
  const rules = plan.rules.map((rule): ImportRule => {
    const resolved = resolvedByPath.get(rule.relativePath);
    return rule.kind === 'collection' && resolved
      ? { ...rule, name: resolved.name, collectionId: resolved.collectionId }
      : rule;
  });
  const policies = (plan.policies ?? []).map((policy): ImportPolicy => {
    const resolved = resolvedByPath.get(policy.relativePath);
    return policy.collectionName &&
      !/[{}]/.test(policy.collectionName) &&
      resolved
      ? {
          ...policy,
          collectionName: resolved.name,
          collectionId: resolved.collectionId,
        }
      : policy;
  });
  const rulePaths = new Set(rules.map((rule) => rule.relativePath));
  const policyPaths = new Set(policies.map((policy) => policy.relativePath));
  const recipe = SavedRecipe.parse({
    rules: [
      ...rules,
      ...(!plan.completeRecipe
        ? (previous?.rules.filter(
            (rule) =>
              rule.relativePath !== '' &&
              !visiblePaths.has(rule.relativePath) &&
              !rulePaths.has(rule.relativePath) &&
              !policyPaths.has(rule.relativePath),
          ) ?? [])
        : []),
    ],
    policies: [
      ...policies,
      ...(!plan.completeRecipe
        ? (previous?.policies.filter(
            (policy) =>
              !visiblePaths.has(policy.relativePath) &&
              !policyPaths.has(policy.relativePath),
          ) ?? [])
        : []),
    ],
    ignoredPaths: [
      ...plan.ignoredPaths,
      ...(!plan.completeRecipe
        ? (previous?.ignoredPaths.filter((path) => !visiblePaths.has(path)) ??
          [])
        : []),
    ],
    commonTags: plan.commonTags,
  });
  globalThis.localStorage.setItem(
    `${STORAGE_PREFIX}${rootId}`,
    JSON.stringify(recipe),
  );
}

export function forgetImportPlan(rootId: string): void {
  globalThis.localStorage.removeItem(`${STORAGE_PREFIX}${rootId}`);
  globalThis.localStorage.removeItem(`${LEGACY_PREFIX}${rootId}`);
}

function readRecipe(rootId: string): {
  recipe: StoredImportRecipe | null;
  error?: string;
} {
  try {
    const raw =
      globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${rootId}`) ??
      globalThis.localStorage?.getItem(`${LEGACY_PREFIX}${rootId}`);
    if (raw === null || raw === undefined) return { recipe: null };
    const saved = SavedRecipe.parse(JSON.parse(raw) as unknown);
    if (
      new Set(
        saved.policies.map((policy) => policy.relativePath.replace(/\\/g, '/')),
      ).size !== saved.policies.length
    ) {
      throw new Error('Duplicate saved folder policies.');
    }
    return {
      recipe: {
        ...saved,
        rules: saved.rules.map((rule) => ({
          ...rule,
          relativePath: rule.relativePath.replace(/\\/g, '/'),
        })),
        ignoredPaths: saved.ignoredPaths.map((path) =>
          path.replace(/\\/g, '/'),
        ),
        policies: saved.policies.map((policy) => ({
          ...policy,
          relativePath: policy.relativePath.replace(/\\/g, '/'),
        })),
      },
    };
  } catch {
    return {
      recipe: null,
      error:
        'The saved source recipe could not be read. Import is blocked to protect your organization choices.',
    };
  }
}
