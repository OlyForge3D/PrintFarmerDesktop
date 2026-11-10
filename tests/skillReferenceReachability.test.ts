import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

export function collectFiles(directory: string) {
  // The index is stable while other workers create/remove untracked fixtures.
  // Stage new source/skill files before checking their references.
  return execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: directory,
    encoding: 'utf8',
    stdio: 'pipe',
  })
    .split('\0')
    .filter(Boolean)
    .map((file) => path.join(directory, file));
}

export function extractFileReferences(markdown: string) {
  const references: string[] = [];
  for (const match of markdown.matchAll(CODE_SPAN)) {
    const captured = match[1];
    if (captured === undefined) continue;
    const token = captured.trim();
    if (ROOTED_REFERENCE.test(token) || BARE_FILENAME.test(token)) {
      references.push(token);
    }
  }
  return references;
}

const repositoryFiles = collectFiles(repositoryRoot);

export function resolveReference(
  reference: string,
  root = repositoryRoot,
  files = repositoryFiles,
) {
  if (ROOTED_REFERENCE.test(reference)) {
    return existsSync(path.join(root, reference));
  }
  return files.some(
    (file) => path.basename(file) === reference && existsSync(file),
  );
}

const skillDocuments = repositoryFiles.filter(
  (file) =>
    file.startsWith(`${SKILLS_ROOT}${path.sep}`) && file.endsWith('.md'),
);

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('repository inventory isolation', () => {
  it('ignores transient fixtures without hiding missing tracked sources or skills', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skill-references-'));
    temporary.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const source = path.join(root, 'scripts', 'real.mjs');
    const skill = path.join(root, '.squad', 'skills', 'example.md');
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(source, 'export {};\n');
    writeFileSync(skill, '`scripts/real.mjs` and `missing.mjs`\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    const transient = path.join(root, '.test-retarget-archive-settings');
    mkdirSync(transient);
    writeFileSync(path.join(transient, 'missing.mjs'), 'fixture only\n');

    const files = collectFiles(root);
    expect(files.sort()).toEqual([skill, source].sort());
    rmSync(transient, { recursive: true });
    expect(collectFiles(root)).toEqual(files);
    expect(resolveReference('real.mjs', root, files)).toBe(true);
    expect(resolveReference('scripts/real.mjs', root, files)).toBe(true);
    expect(resolveReference('missing.mjs', root, files)).toBe(false);
    expect(resolveReference('scripts/missing.mjs', root, files)).toBe(false);

    rmSync(source);
    expect(resolveReference('real.mjs', root, files)).toBe(false);
    expect(resolveReference('scripts/real.mjs', root, files)).toBe(false);
    rmSync(skill);
    expect(collectFiles(root)).toContain(skill);
    expect(() => readFileSync(skill, 'utf8')).toThrow(/ENOENT/);
  });

  it('surfaces inventory errors instead of checking an empty corpus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skill-references-no-git-'));
    temporary.push(root);
    expect(() => collectFiles(root)).toThrow();
  });
});

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
