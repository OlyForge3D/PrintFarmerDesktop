// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  classifyPaths,
  isDocumentationPath,
} from '../scripts/docs-only-change.mjs';

// The classifier decides whether the six platform build jobs and `Dependency advisories` stand
// down, so its errors are asymmetric. A path wrongly called source costs build minutes. A path
// wrongly called documentation removes a required check's actual work while the check still
// reports green, which is the false-green shape this repository's merge-queue tests exist to
// refuse. Every case below is written from that asymmetry.
describe('the docs-only fast path recognises documentation', () => {
  it('admits the markdown that prompted this, wherever it sits', () => {
    // PR #596: one file, ~41 minutes of platform build compute.
    expect(isDocumentationPath('.squad/agents/ralph/loop.md')).toBe(true);
    expect(isDocumentationPath('README.md')).toBe(true);
    expect(isDocumentationPath('docs/security/THREAT_MODEL.md')).toBe(true);
    expect(isDocumentationPath('.github/agents/reviewer.md')).toBe(true);
    expect(isDocumentationPath('.github/instructions/house-style.md')).toBe(
      true,
    );
    expect(isDocumentationPath('LICENSE')).toBe(true);
  });

  it('admits every file under a documentation directory, not only its markdown', () => {
    expect(isDocumentationPath('docs/diagrams/pipeline.svg')).toBe(true);
  });
});

describe('the docs-only fast path refuses everything else', () => {
  it('refuses source, tests, workflows and scripts', () => {
    for (const file of [
      'src/main/index.ts',
      'tests/citationReachability.test.ts',
      '.github/workflows/ci.yml',
      'scripts/docs-only-change.mjs',
      'native/src/lib.rs',
      'e2e/release.gpu.spec.ts',
    ]) {
      expect(isDocumentationPath(file)).toBe(false);
    }
  });

  it('refuses dependency manifests wherever they sit', () => {
    // `Dependency advisories` stands down on the documentation path. That is only sound while a
    // manifest cannot be classified as documentation, so this is the load-bearing case for it.
    for (const file of [
      'package.json',
      'package-lock.json',
      'native/Cargo.toml',
      'native/Cargo.lock',
      'yarn.lock',
      'pnpm-lock.yaml',
    ]) {
      expect(isDocumentationPath(file)).toBe(false);
    }
  });

  it('refuses a manifest that a documentation prefix would otherwise admit', () => {
    // The manifest check runs BEFORE the prefix allowlist. Without that ordering a fixture
    // manifest under `docs/` would read as prose.
    expect(isDocumentationPath('docs/examples/package.json')).toBe(false);
  });

  it('refuses a path shape it cannot reason about', () => {
    expect(isDocumentationPath('/etc/passwd.md')).toBe(false);
    expect(isDocumentationPath('../outside/notes.md')).toBe(false);
    expect(isDocumentationPath('')).toBe(false);
  });
});

describe('the docs-only fast path resolves uncertainty toward the full build', () => {
  it('treats a mixed documentation and source change as not documentation-only', () => {
    const verdict = classifyPaths(['README.md', 'src/main/index.ts']);
    expect(verdict.docsOnly).toBe(false);
    expect(verdict.offenders).toEqual(['src/main/index.ts']);
  });

  it('treats an empty file list as not documentation-only', () => {
    // "Nothing changed" and "the diff could not be computed" arrive here as the same value, and
    // only one of them is safe to treat as a licence to skip. So neither is.
    expect(classifyPaths([]).docsOnly).toBe(false);
    expect(classifyPaths(null).docsOnly).toBe(false);
  });

  it('passes a change that is documentation throughout', () => {
    const verdict = classifyPaths([
      '.squad/agents/ralph/loop.md',
      'docs/README.md',
    ]);
    expect(verdict.docsOnly).toBe(true);
    expect(verdict.offenders).toEqual([]);
  });
});
