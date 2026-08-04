import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `.squad/skills/**` is read by every agent on activation, and one of those
 * files carries authority over CI conduct. Nothing checked that the paths it
 * names exist.
 *
 * The failure is not hypothetical. A pull request salvaged from a closed one
 * nearly shipped an instruction pointing at `ci-install.mjs`, a script this
 * repository does not contain — the real name is `scripts/npm-ci-strict.mjs`.
 * It was caught by hand. A salvage carries its source's references, and the
 * references are the part that rots.
 *
 * Note the shape of that near-miss: the wrong token was a bare filename, not a
 * path. A check that only resolves `dir/file.ext` would have passed it, so bare
 * filenames are resolved here too, against an index of the repository.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SKILLS_ROOT = path.join(repositoryRoot, '.squad', 'skills');

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'out',
  'coverage',
]);

/** Directories a full-path reference may start with. */
const ROOTED_REFERENCE =
  /^(scripts|tests|src|native|docs|\.github|\.squad)\/[A-Za-z0-9._/-]+$/;

/**
 * A bare filename with a code-ish extension. `.md` is deliberately excluded:
 * prose cites documents by title far more loosely than it cites code, and the
 * rotting references this guard exists for are scripts and workflows.
 */
const BARE_FILENAME = /^[A-Za-z0-9._-]+\.(mjs|cjs|js|ts|tsx|yml|yaml|rs)$/;

/** Inline code spans. A reference outside backticks is prose, not a citation. */
const CODE_SPAN = /`([^`\n]+)`/g;

export function collectFiles(directory: string, accumulator: string[] = []) {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) collectFiles(absolute, accumulator);
    else accumulator.push(absolute);
  }
  return accumulator;
}

export function extractFileReferences(markdown: string) {
  const references: string[] = [];
  for (const match of markdown.matchAll(CODE_SPAN)) {
    const token = match[1].trim();
    if (ROOTED_REFERENCE.test(token) || BARE_FILENAME.test(token)) {
      references.push(token);
    }
  }
  return references;
}

const repositoryFiles = collectFiles(repositoryRoot);

const filesByBasename = new Map<string, string[]>();
for (const absolute of repositoryFiles) {
  const base = path.basename(absolute);
  const bucket = filesByBasename.get(base);
  if (bucket) bucket.push(absolute);
  else filesByBasename.set(base, [absolute]);
}

export function resolveReference(reference: string) {
  if (ROOTED_REFERENCE.test(reference)) {
    return existsSync(path.join(repositoryRoot, reference));
  }
  return filesByBasename.has(reference);
}

const skillDocuments = collectFiles(SKILLS_ROOT).filter((file) =>
  file.endsWith('.md'),
);

describe('every file named by a skill document exists', () => {
  it('finds skill documents to check, rather than passing on an empty set', () => {
    // An empty corpus satisfies "no broken references" vacuously. If the
    // directory is renamed or the walk breaks, this must fail by name instead
    // of reporting agreement.
    expect(existsSync(SKILLS_ROOT)).toBe(true);
    expect(skillDocuments.length).toBeGreaterThan(0);
  });

  it('extracts references, rather than passing because it found none', () => {
    // The same vacuity one level down: a broken extractor reports zero
    // references and therefore zero broken ones.
    const total = skillDocuments.reduce(
      (count, file) =>
        count + extractFileReferences(readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it.each(skillDocuments.map((file) => [path.relative(repositoryRoot, file)]))(
    'resolves every path and script named in %s',
    (relative) => {
      const text = readFileSync(path.join(repositoryRoot, relative), 'utf8');
      const unresolved = [...new Set(extractFileReferences(text))].filter(
        (reference) => !resolveReference(reference),
      );
      expect(unresolved).toEqual([]);
    },
  );
});

describe('the extractor discriminates', () => {
  it('collects rooted paths and bare code filenames', () => {
    const references = extractFileReferences(
      'see `scripts/npm-ci-strict.mjs` and `pr-closure-scope.yml` for detail',
    );
    expect(references).toEqual([
      'scripts/npm-ci-strict.mjs',
      'pr-closure-scope.yml',
    ]);
  });

  it('ignores references outside code spans, which are prose', () => {
    expect(extractFileReferences('see scripts/npm-ci-strict.mjs')).toEqual([]);
  });

  it('ignores placeholders and prose that merely look like paths', () => {
    const noise = [
      '`<N>`',
      '`.md`',
      '`gh pr view <N> --json headRefOid`',
      '`git log --format=%B base..head`',
      '`npm ci`',
      '`squash_merge_commit_message = COMMIT_MESSAGES`',
    ].join(' ');
    expect(extractFileReferences(noise)).toEqual([]);
  });

  it('does not resolve a name the repository does not contain', () => {
    // The #227 near-miss, pinned as a case rather than described in a comment.
    expect(resolveReference('ci-install.mjs')).toBe(false);
    expect(resolveReference('scripts/npm-ci-strict.mjs')).toBe(true);
  });
});
