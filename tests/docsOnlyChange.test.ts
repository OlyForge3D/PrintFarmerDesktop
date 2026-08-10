// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  affectsRust,
  classifyDocsAndTests,
  classifyPaths,
  classifyRustUntouched,
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

// The rust-untouched tier (#707) is not nested in the other two. It asks a question about the
// build's inputs rather than a file's genre -- can this change reach `cargo` at all? -- and so it
// admits the case neither tier above can reach: an ordinary TypeScript pull request, which is the
// common shape. Nineteen of the twenty pull requests preceding this change touched no Rust and
// each paid a full two-platform cargo matrix for it.
//
// The asymmetry is inverted relative to the predicates above, and every case below is written from
// that inversion. There, wrongly answering "yes, documentation" removed real coverage, so
// recognition was positive and doubt answered `false`. Here, wrongly answering "no, cannot affect
// the crate" is what removes coverage -- so doubt answers `true`, and `affectsRust` is the
// predicate that must never be talked out of a `true`.
describe('the rust-untouched tier recognises what can reach the cargo build', () => {
  it('claims the crate directory and its manifests', () => {
    expect(affectsRust('native/src/lib.rs')).toBe(true);
    expect(affectsRust('native/Cargo.toml')).toBe(true);
    expect(affectsRust('native/Cargo.lock')).toBe(true);
    expect(affectsRust('native/model-core/Cargo.toml')).toBe(true);
    expect(affectsRust('native/model-core/src/scene.rs')).toBe(true);
  });

  it('claims Rust anywhere, not only under native/', () => {
    // A prefix test on `native/` alone is correct only while every crate lives there. Matching
    // `.rs` and the cargo manifests by suffix and basename anywhere means a second crate added
    // elsewhere is built rather than silently skipped, without this file needing to be revisited.
    expect(affectsRust('tools/codegen/src/main.rs')).toBe(true);
    expect(affectsRust('tools/codegen/Cargo.toml')).toBe(true);
    expect(affectsRust('Cargo.lock')).toBe(true);
  });

  it('claims the workflow that defines the job and the detector that gates it', () => {
    // Both are self-certification guards. An edit to the sidecar steps, the toolchain pin or the
    // feature matrix must be exercised by the job it edits; and this tier must never be decided by
    // the version of the detector under review.
    expect(affectsRust('.github/workflows/ci.yml')).toBe(true);
    expect(affectsRust('scripts/docs-only-change.mjs')).toBe(true);
  });

  // Ripley, PR #708 review. The manifest set alone left a false negative open, which is the one
  // direction that costs correctness here: these files change what the job's commands DO without
  // appearing in any crate source or manifest, so a change to one can turn the cargo matrix red
  // while touching no `.rs` file at all. None of them exists in this repository yet -- which is
  // exactly why they are pinned now, because the predicate is wrong on the commit that ADDS one,
  // the very commit whose effect nobody has measured.
  it('claims cargo, rustfmt, clippy and toolchain configuration', () => {
    for (const file of [
      '.cargo/config.toml',
      '.cargo/config',
      'rustfmt.toml',
      '.rustfmt.toml',
      'clippy.toml',
      '.clippy.toml',
      'rust-toolchain',
      'rust-toolchain.toml',
    ]) {
      expect(affectsRust(file)).toBe(true);
    }
  });

  it('claims that configuration wherever it sits, not only at the repository root', () => {
    // Same reasoning as `.rs` and the manifests: a per-crate override is the normal place for
    // several of these, and `native/` is not the only directory a crate may ever occupy.
    for (const file of [
      'native/.cargo/config.toml',
      'native/rustfmt.toml',
      'native/model-core/clippy.toml',
      'tools/codegen/rust-toolchain.toml',
    ]) {
      expect(affectsRust(file)).toBe(true);
    }
  });

  it('claims anything under a .cargo directory, not just the two config spellings', () => {
    // The directory is what makes a file cargo's, so the directory is the test. This is what keeps
    // a future `.cargo/audit.toml` or credential/registry file from reopening the same hole under
    // a filename nobody enumerated.
    expect(affectsRust('.cargo/audit.toml')).toBe(true);
    expect(affectsRust('.cargo/registries/mirror.toml')).toBe(true);
  });

  it('does not claim a generic config file merely for being named config', () => {
    // The control on the rule above. `config` and `config.toml` are far too generic to claim
    // globally by basename -- doing so would cost build minutes on every unrelated change -- so
    // the `.cargo/` segment, not the filename, is what earns the claim.
    expect(affectsRust('src/config.toml')).toBe(false);
    expect(affectsRust('config.toml')).toBe(false);
    expect(affectsRust('resources/config')).toBe(false);
  });

  it('claims any shape it cannot reason about', () => {
    // The opposite answer from `isDocumentationPath` on the identical inputs, and for the identical
    // reason: in both cases the unknown shape resolves toward running the build, not skipping it.
    expect(affectsRust('/etc/passwd')).toBe(true);
    expect(affectsRust('../outside/lib.rs')).toBe(true);
    expect(affectsRust('native\\src\\lib.rs')).toBe(true);
    expect(affectsRust('')).toBe(true);
    expect(affectsRust(null)).toBe(true);
    expect(affectsRust(undefined)).toBe(true);
  });

  it('releases what cargo never reads', () => {
    for (const file of [
      'src/main/index.ts',
      'src/renderer/App.tsx',
      'tests/citationReachability.test.ts',
      'e2e/release.gpu.spec.ts',
      '.squad/decisions.md',
      'README.md',
      'package.json',
      'package-lock.json',
      'forge.config.ts',
      'scripts/mvp-smoke.mjs',
      '.github/workflows/release.yml',
    ]) {
      expect(affectsRust(file)).toBe(false);
    }
  });

  it('does not confuse a Rust-adjacent name for Rust', () => {
    // `.rs` is matched as a suffix, so a markdown file merely describing the crate is prose.
    expect(affectsRust('docs/native/ARCHITECTURE.md')).toBe(false);
    // Not `native/`: the prefix test is on the directory boundary, not the bare string.
    expect(affectsRust('native-notes/plan.md')).toBe(false);
  });
});

describe('the rust-untouched tier resolves uncertainty toward the full cargo matrix', () => {
  it('passes the ordinary TypeScript pull request this tier exists for', () => {
    const verdict = classifyRustUntouched([
      'src/main/index.ts',
      'src/renderer/App.tsx',
      'tests/sceneGraph.test.ts',
    ]);
    expect(verdict.rustUntouched).toBe(true);
    expect(verdict.offenders).toEqual([]);
  });

  it('passes a documentation-only change, which reaches cargo even less', () => {
    // PR #703's exact file list: three markdown files, a full two-platform cargo matrix.
    expect(
      classifyRustUntouched([
        '.github/pr-closes/dev-jpapiez-squad-268-relay-attribution.md',
        '.squad/decisions.md',
        '.squad/skills/agent-collaboration/SKILL.md',
      ]).rustUntouched,
    ).toBe(true);
  });

  it('fails on a single Rust file among many that are not', () => {
    // The load-bearing direction: one offender is enough, and it is named.
    const verdict = classifyRustUntouched([
      'src/main/index.ts',
      'README.md',
      'native/model-core/src/lib.rs',
    ]);
    expect(verdict.rustUntouched).toBe(false);
    expect(verdict.offenders).toEqual(['native/model-core/src/lib.rs']);
  });

  it('fails when the workflow being gated is itself the change', () => {
    const verdict = classifyRustUntouched([
      '.github/workflows/ci.yml',
      'src/main/index.ts',
    ]);
    expect(verdict.rustUntouched).toBe(false);
    expect(verdict.offenders).toEqual(['.github/workflows/ci.yml']);
  });

  it('fails when the detector deciding the tier is itself the change', () => {
    const verdict = classifyRustUntouched(['scripts/docs-only-change.mjs']);
    expect(verdict.rustUntouched).toBe(false);
    expect(verdict.offenders).toEqual(['scripts/docs-only-change.mjs']);
  });

  it('fails on a cargo lockfile change, which alters the resolved dependency set', () => {
    expect(classifyRustUntouched(['native/Cargo.lock']).rustUntouched).toBe(
      false,
    );
  });

  it('fails when a tool config is the only non-source path in the change', () => {
    // The end-to-end shape of Ripley's finding: a pull request that adds a formatter config
    // alongside ordinary TypeScript would, before this, have been classified rust-untouched and
    // stood the cargo matrix down -- including the `cargo fmt --check` that the new file redefines.
    const verdict = classifyRustUntouched([
      'src/main/index.ts',
      'rustfmt.toml',
    ]);
    expect(verdict.rustUntouched).toBe(false);
    expect(verdict.offenders).toEqual(['rustfmt.toml']);
  });

  it('fails on a .cargo/config.toml change with no other Rust path in sight', () => {
    const verdict = classifyRustUntouched(['.cargo/config.toml', 'README.md']);
    expect(verdict.rustUntouched).toBe(false);
    expect(verdict.offenders).toEqual(['.cargo/config.toml']);
  });

  it('treats an empty or unreadable file list as not rust-untouched (fail-safe)', () => {
    // Same rule as both tiers above, and the same reason: "nothing changed" and "the diff could
    // not be computed" arrive here as one value, and only one of them is safe to skip on.
    expect(classifyRustUntouched([]).rustUntouched).toBe(false);
    expect(classifyRustUntouched(null).rustUntouched).toBe(false);
  });

  it('is genuinely independent of the other two tiers, not nested in them', () => {
    // The whole point. This list is neither docs-only nor docs-and-tests -- `Desktop` and
    // `Release package` must and do run every step over it -- yet it cannot reach cargo, so
    // `Sidecar` has nothing to say about it.
    const files = ['src/main/index.ts'];
    expect(classifyPaths(files).docsOnly).toBe(false);
    expect(classifyDocsAndTests(files).docsAndTests).toBe(false);
    expect(classifyRustUntouched(files).rustUntouched).toBe(true);
  });
});
