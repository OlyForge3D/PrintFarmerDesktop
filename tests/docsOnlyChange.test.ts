// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  classifyDocsAndTests,
  classifyPaths,
  isDocsOrTestPath,
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

// The docs-and-tests tier (#623) is a SUPERSET of docs-only: every path the docs-only predicate
// admits, this one admits too, plus anything under `tests/`. It exists so a PR like #620 -- three
// files, none of them source, one of them a new test -- gets `Sidecar`, `Release package` and
// `Dependency advisories` standing down without losing the test run those checks never covered
// anyway. The same asymmetry as docs-only applies: calling a source path docs-and-tests would
// remove real coverage from three required checks while they still report green.
describe('the docs-and-tests fast path recognises documentation and tests', () => {
  it('admits everything the docs-only predicate admits', () => {
    expect(isDocsOrTestPath('.squad/agents/ralph/loop.md')).toBe(true);
    expect(isDocsOrTestPath('README.md')).toBe(true);
    expect(isDocsOrTestPath('docs/security/THREAT_MODEL.md')).toBe(true);
    expect(isDocsOrTestPath('LICENSE')).toBe(true);
  });

  it('admits a test file under tests/', () => {
    // PR #620: exactly this shape, plus two documentation files.
    expect(
      isDocsOrTestPath('tests/calibrationAssetManifestReachability.test.ts'),
    ).toBe(true);
    expect(isDocsOrTestPath('tests/citationReachability.test.ts')).toBe(true);
  });

  it('refuses a test-shaped path outside tests/, such as an e2e spec', () => {
    // `e2e/` is a sibling directory, not a `tests/` prefix, and this predicate is intentionally
    // narrow to the prefix named in the issue -- widening it to "anything that looks like a test"
    // would admit `native/src/lib.rs`'s own unit tests via `#[cfg(test)]`, which is source.
    expect(isDocsOrTestPath('e2e/release.gpu.spec.ts')).toBe(false);
  });

  it('refuses source, workflows and scripts', () => {
    for (const file of [
      'src/main/index.ts',
      '.github/workflows/ci.yml',
      'scripts/docs-only-change.mjs',
      'native/src/lib.rs',
    ]) {
      expect(isDocsOrTestPath(file)).toBe(false);
    }
  });

  it('refuses dependency manifests wherever they sit, including under tests/', () => {
    // The load-bearing case: the manifest denylist must win before the `tests/` allowance is
    // consulted, or a fixture manifest under `tests/fixtures/package.json` would qualify.
    for (const file of [
      'package.json',
      'package-lock.json',
      'native/Cargo.toml',
      'tests/fixtures/package.json',
    ]) {
      expect(isDocsOrTestPath(file)).toBe(false);
    }
  });

  it('refuses a path shape it cannot reason about', () => {
    expect(isDocsOrTestPath('/etc/passwd.md')).toBe(false);
    expect(isDocsOrTestPath('../outside/notes.md')).toBe(false);
    expect(isDocsOrTestPath('')).toBe(false);
  });
});

describe('the docs-and-tests fast path resolves uncertainty toward the full build', () => {
  it('passes a change confined to documentation and tests (#620 shape)', () => {
    const verdict = classifyDocsAndTests([
      '.github/PR_CLOSES.md',
      '.squad/decisions.md',
      'tests/calibrationAssetManifestReachability.test.ts',
    ]);
    expect(verdict.docsAndTests).toBe(true);
    expect(verdict.offenders).toEqual([]);
  });

  it('passes a change that is documentation-only, too, since docs-and-tests is a superset', () => {
    const verdict = classifyDocsAndTests([
      '.squad/agents/ralph/loop.md',
      'docs/README.md',
    ]);
    expect(verdict.docsAndTests).toBe(true);
  });

  it('passes a test-only change with no documentation at all', () => {
    const verdict = classifyDocsAndTests([
      'tests/citationReachability.test.ts',
    ]);
    expect(verdict.docsAndTests).toBe(true);
    expect(verdict.offenders).toEqual([]);
  });

  it('treats a change that also touches source as not docs-and-tests', () => {
    const verdict = classifyDocsAndTests([
      'tests/citationReachability.test.ts',
      'src/main/index.ts',
    ]);
    expect(verdict.docsAndTests).toBe(false);
    expect(verdict.offenders).toEqual(['src/main/index.ts']);
  });

  it('rejects package.json even though it would otherwise be the only offender', () => {
    // The manifest denylist must win outright: a PR touching `package.json` is rejected by this
    // tier and runs the full matrix, exactly as the docs-only tier already rejects it.
    const verdict = classifyDocsAndTests([
      'tests/citationReachability.test.ts',
      'package.json',
    ]);
    expect(verdict.docsAndTests).toBe(false);
    expect(verdict.offenders).toEqual(['package.json']);
  });

  it('treats an empty or unreadable file list as not docs-and-tests (fail-safe)', () => {
    expect(classifyDocsAndTests([]).docsAndTests).toBe(false);
    expect(classifyDocsAndTests(null).docsAndTests).toBe(false);
  });
});
