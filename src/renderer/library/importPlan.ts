import {
  ImportRule as ImportRuleSchema,
  type ImportPreviewResponse,
  type ImportRule,
  type ImportRootResponse,
} from '@shared/ipc';
import { z } from 'zod';

const STORAGE_PREFIX = 'printfarmer.import-recipe.v1.';
const SavedRecipe = z.object({
  rules: z.array(ImportRuleSchema).max(1000),
  ignoredPaths: z.array(z.string().max(4096)).max(500).default([]),
  commonTags: z.array(z.string().trim().min(1).max(128)).max(100),
});
type StoredImportRecipe = z.infer<typeof SavedRecipe>;

type RuleMode = ImportRule['kind'] | 'ignore';

export interface ImportFolderChoice {
  relativePath: string;
  depth: number;
  modelCount: number;
  mode: RuleMode;
  name: string;
  collectionId?: string;
  collectionTargetUnresolved?: boolean;
}

export interface ImportChoices {
  rootCollection: boolean;
  rootCollectionName: string;
  rootCollectionId?: string;
  rootCollectionTargetUnresolved?: boolean;
  folders: ImportFolderChoice[];
  commonTagsText: string;
}

export interface ImportPlan {
  rules: ImportRule[];
  ignoredPaths: string[];
  commonTags: string[];
  visibleFolderPaths: string[];
}

export function initialImportChoices(
  rootId: string,
  rootName: string,
  preview: ImportPreviewResponse,
): ImportChoices {
  const saved = readRecipe(rootId);
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
    folders: preview.folders.map((folder) => {
      const prior = saved?.rules.find(
        (rule) => rule.relativePath === folder.relativePath,
      );
      const choice: ImportFolderChoice = {
        relativePath: folder.relativePath,
        depth: folder.depth,
        modelCount: folder.modelCount,
        mode: ignoredPaths.has(folder.relativePath)
          ? 'ignore'
          : (prior?.kind ?? (folder.depth === 1 ? 'collection' : 'tag')),
        name: prior?.name ?? folder.name,
      };
      return prior?.kind === 'collection' && prior.collectionId
        ? { ...choice, collectionId: prior.collectionId }
        : choice;
    }),
    commonTagsText: saved?.commonTags.join(', ') ?? '',
  };
}

export function buildImportPlan(choices: ImportChoices): ImportPlan {
  const rules: ImportRule[] = [];
  const rootName = choices.rootCollectionName.trim();
  if (choices.rootCollection && rootName) {
    rules.push({
      relativePath: '',
      kind: 'collection',
      name: rootName,
      ...(choices.rootCollectionId
        ? { collectionId: choices.rootCollectionId }
        : {}),
    });
  }
  for (const folder of choices.folders) {
    const name = folder.name.trim();
    if (folder.mode !== 'ignore' && name) {
      if (folder.mode === 'collection') {
        rules.push({
          relativePath: folder.relativePath,
          kind: folder.mode,
          name,
          ...(folder.collectionId ? { collectionId: folder.collectionId } : {}),
        });
      } else {
        rules.push({
          relativePath: folder.relativePath,
          kind: folder.mode,
          name,
        });
      }
    }
  }
  return {
    rules,
    ignoredPaths: choices.folders
      .filter((folder) => folder.mode === 'ignore')
      .map((folder) => folder.relativePath),
    commonTags: parseTags(choices.commonTagsText),
    visibleFolderPaths: choices.folders.map((folder) => folder.relativePath),
  };
}

export function parseTags(value: string): string[] {
  const unique = new Map<string, string>();
  for (const part of value.split(/[,;\n]/)) {
    const tag = part.trim();
    if (tag) {
      unique.set(tag.toLowerCase(), tag);
    }
  }
  return [...unique.values()];
}

export function rememberImportPlan(
  rootId: string,
  plan: ImportPlan,
  resolvedCollections: ImportRootResponse['resolvedCollections'] = [],
): void {
  try {
    const previous = readRecipe(rootId);
    const visiblePaths = new Set(plan.visibleFolderPaths);
    const resolvedByPath = new Map(
      resolvedCollections.map((collection) => [
        collection.relativePath,
        collection,
      ]),
    );
    const currentRules = plan.rules.map((rule): ImportRule => {
      if (rule.kind !== 'collection') {
        return rule;
      }
      const resolved = resolvedByPath.get(rule.relativePath);
      return resolved
        ? {
            ...rule,
            name: resolved.name,
            collectionId: resolved.collectionId,
          }
        : rule;
    });
    const preservedRules =
      previous?.rules.filter(
        (rule) =>
          rule.relativePath !== '' && !visiblePaths.has(rule.relativePath),
      ) ?? [];
    const preservedIgnores =
      previous?.ignoredPaths.filter((path) => !visiblePaths.has(path)) ?? [];
    const recipe = {
      rules: [...currentRules, ...preservedRules].slice(0, 1000),
      ignoredPaths: [...plan.ignoredPaths, ...preservedIgnores].slice(0, 500),
      commonTags: plan.commonTags,
    };
    globalThis.localStorage?.setItem(
      `${STORAGE_PREFIX}${rootId}`,
      JSON.stringify(recipe),
    );
  } catch {
    // Match favorites persistence: an unavailable renderer store must not block import.
  }
}

export function forgetImportPlan(rootId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${STORAGE_PREFIX}${rootId}`);
  } catch {
    // An unavailable renderer store already behaves as if no recipe is saved.
  }
}

function readRecipe(rootId: string): StoredImportRecipe | null {
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${rootId}`);
    if (!raw) {
      return null;
    }
    const result = SavedRecipe.safeParse(JSON.parse(raw) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
