import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * #267's reproduction renames `resources/sidecar` aside to demonstrate that a
 * test no longer depends on the sidecar binary. That step is correct, and it
 * has a side effect nobody wrote down: `.gitignore` keys the binary to its
 * PATH, not to the artifact, so the moment the directory is renamed a 3.4 MB
 * native executable becomes an ordinary untracked file.
 *
 * Measured on the reproduction's own path name:
 *
 *   git check-ignore resources/sidecar/model-core.exe        -> exit 0 (ignored)
 *   git check-ignore resources/_sidecar_hidden/model-core.exe -> exit 1 (NOT)
 *   git add -A --dry-run  ->  add 'resources/_sidecar_hidden/model-core.exe'
 *
 * The dangerous command is not the one that looks dangerous. `git commit -am`
 * is safe here -- `-a` stages only tracked modifications, so it lists the
 * binary under untracked and stops -- while `git add -A` and `git add .`, the
 * reflex after a rename, stage it silently.
 *
 * These assertions ask git the question rather than reading `.gitignore` as
 * text, so they describe the behaviour a contributor actually gets. They also
 * need no filesystem mutation: `check-ignore` answers about paths that do not
 * exist, which is the property the harness control below establishes.
 */
function isIgnored(
  relativePath: string,
  { consultIndex = true }: { consultIndex?: boolean } = {},
): boolean {
  const args = ['check-ignore', '-q'];
  if (!consultIndex) {
    args.push('--no-index');
  }
  const result = spawnSync('git', [...args, '--', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  // 0 = ignored, 1 = not ignored, anything else is git failing to answer and
  // must not be read as "not ignored" -- that would make every assertion below
  // pass by silently reinterpreting an error as a verdict.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore returned ${result.status} for ${relativePath}: ${result.stderr}`,
    );
  }
  return result.status === 0;
}

describe('sidecar binary stays ignored when its directory is relocated', () => {
  it('answers about paths that do not exist, in both directions', () => {
    // Harness control. Every assertion in this file is about a path that is
    // absent from the working tree, so a check-ignore that could only ever
    // report one verdict for a missing path would make the whole suite
    // decoration. Both arms are asserted in-band, in the same run.
    expect(isIgnored('resources/sidecar/no-such-file-abc123.exe')).toBe(true);
    expect(isIgnored('src/no-such-file-abc123.ts')).toBe(false);
  });

  it('ignores the binary under the name #267 relocates it to', () => {
    expect(isIgnored('resources/_sidecar_hidden/model-core.exe')).toBe(true);
    expect(isIgnored('resources/_sidecar_hidden/model-core')).toBe(true);
  });

  it('ignores it under any relocation inside resources/', () => {
    // The rule is a property of the artifact, not of one rename someone
    // happened to pick, so an arbitrary sibling name has to hold too.
    expect(isIgnored('resources/sidecar.bak/model-core.exe')).toBe(true);
    expect(isIgnored('resources/tmp/nested/model-core.exe')).toBe(true);
  });

  it('still ignores the canonical staged location', () => {
    // Regression control for the original rule: the fix must add coverage
    // rather than move it.
    expect(isIgnored('resources/sidecar/model-core.exe')).toBe(true);
    expect(isIgnored('resources/compliance/sbom.json')).toBe(true);
  });

  it('never shadows the Rust crate that shares the binary name', () => {
    // The obvious spelling of this fix is a bare `model-core` pattern, which
    // matches a directory of that name at any depth and so covers
    // native/model-core/ -- the crate this binary is built from.
    //
    // The obvious spelling of THIS ASSERTION is inert, and was, until a
    // mutation caught it: checking an existing tracked file reports "not
    // ignored" no matter what the rules say, because check-ignore consults the
    // index. It asserted "the rule does not shadow the crate" and measured
    // "the crate is already tracked", and it passed with the catastrophic
    // pattern installed.
    //
    // Two live forms replace it. First the practical hazard: tracked files
    // stay tracked, so the damage lands on the NEXT file added to the crate,
    // which would be silently unaddable. Measured at 0 (ignored) under the
    // unscoped pattern.
    expect(isIgnored('native/model-core/src/brand-new-file.rs')).toBe(false);
    // Then the rule itself, with the index taken out of the question.
    expect(
      isIgnored('native/model-core/src/lib.rs', { consultIndex: false }),
    ).toBe(false);
    expect(
      isIgnored('native/model-core/Cargo.toml', { consultIndex: false }),
    ).toBe(false);
  });
});
