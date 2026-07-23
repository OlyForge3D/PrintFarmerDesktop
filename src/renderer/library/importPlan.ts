import {
  ImportRule as ImportRuleSchema,
  type ImportPreviewResponse,
  type ImportRule,
} from '@shared/ipc';
import { z } from 'zod';

const STORAGE_PREFIX = 'printfarmer.import-recipe.v1.';
const SavedRecipe = z.object({
  rules: z.array(ImportRuleSchema).max(1000),
  commonTags: z.array(z.string().trim().min(1).max(128)).max(100),
});

type RuleMode = ImportRule['kind'] | 'ignore';

export interface ImportFolderChoice {
  relativePath: string;
  depth: number;
  modelCount: number;
  mode: RuleMode;
  name: string;
}

export interface ImportChoices {
  rootCollection: boolean;
  rootCollectionName: string;
  folders: ImportFolderChoice[];
  commonTagsText: string;
}

export interface ImportPlan {
  rules: ImportRule[];
  commonTags: string[];
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

  return {
    rootCollection: saved ? Boolean(rootRule) : true,
    rootCollectionName: rootRule?.name ?? rootName,
    folders: preview.folders.map((folder) => {
      const prior = saved?.rules.find(
        (rule) => rule.relativePath === folder.relativePath,
      );
      return {
        relativePath: folder.relativePath,
        depth: folder.depth,
        modelCount: folder.modelCount,
        mode: prior?.kind ?? (folder.depth === 1 ? 'collection' : 'tag'),
        name: prior?.name ?? folder.name,
      };
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
    });
  }
  for (const folder of choices.folders) {
    const name = folder.name.trim();
    if (folder.mode !== 'ignore' && name) {
      rules.push({
        relativePath: folder.relativePath,
        kind: folder.mode,
        name,
      });
    }
  }
  return {
    rules,
    commonTags: parseTags(choices.commonTagsText),
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

export function rememberImportPlan(rootId: string, plan: ImportPlan): void {
  try {
    globalThis.localStorage?.setItem(
      `${STORAGE_PREFIX}${rootId}`,
      JSON.stringify(plan),
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

function readRecipe(rootId: string): ImportPlan | null {
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
