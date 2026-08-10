// Decides whether the change under test is documentation-only, so ci.yml can skip the steps a
// documentation edit cannot affect while every job still runs and still reports.
//
// Why a step and not a path filter. `development` carries eight REQUIRED status checks:
//
//   Desktop (windows-latest)          Sidecar (windows-latest)
//   Desktop (macos-latest)            Sidecar (macos-latest)
//   Release package (windows-latest)  Dependency advisories
//   Release package (macos-latest)    Closing-reference declaration
//
// A required context that is never reported does not merge -- GitHub holds the pull request at
// "Expected - waiting for status" indefinitely -- so `paths-ignore:` and workflow-level path
// filtering are unavailable here: they suppress the workflow, and a suppressed workflow reports
// nothing. A job-level `if:` is unavailable for a second, independent reason: it reports a
// `skipped` conclusion, which branch protection accepts as success, so the required check would
// be satisfied by a job that never executed. tests/ciWorkflowTriggers.test.ts bans that shape
// outright ("declares no job-level `if:` and no event-name branching"), and this file is written
// to live under that ban rather than around it. Every job keeps running under its exact existing
// name and reaches a real `success`; only the expensive steps inside it stand down.
//
// The output is therefore load-bearing in one direction only. `docs_only=true` removes checks, so
// every uncertainty must resolve to `false`: an event that is not a pull request, a HEAD that is
// not the merge commit GitHub builds for a pull request, a diff that cannot be computed, an empty
// file list, a path this file does not positively recognise as documentation. There is no branch
// here that infers "documentation" from the absence of evidence.
//
// Run:  node scripts/docs-only-change.mjs
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Files whose change alters what the build produces or what it depends on, listed by basename so
 * a manifest is caught wherever it sits in the tree.
 *
 * Checked BEFORE the documentation allowlist rather than left to it. The allowlist already
 * excludes every one of these, so this list adds no authority today -- it exists so that widening
 * the allowlist later cannot silently admit a dependency change as documentation. `Dependency
 * advisories` stands down on the documentation path, and that is only sound while a manifest
 * cannot reach it.
 */
const MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Gemfile',
  'Gemfile.lock',
]);

/**
 * Directory prefixes whose entire contents are prose or agent instructions.
 *
 * `.squad/` is deliberately NOT here. It holds skill definitions and policy that the vitest suite
 * reads and asserts against, and it is not exclusively markdown; a `.squad/**` prefix would admit
 * whatever non-prose files that tree grows later. `.squad/agents/ralph/loop.md` -- the file whose
 * one-line edit cost ~41 minutes of platform build compute and prompted this -- is admitted by the
 * `.md` rule below instead, which is narrower and does not expire.
 */
const DOC_PREFIXES = ['docs/', '.github/agents/', '.github/instructions/'];

/** Root-level files that are prose and are not read by the build. */
const DOC_FILES = new Set(['LICENSE']);

/**
 * True when a repository-relative path is documentation.
 *
 * Positive recognition only: anything this does not name is source. Source, tests, workflow YAML,
 * scripts, native code, assets and manifests all fall through to `false` because none of them is
 * listed, which is the failure direction that costs build minutes rather than correctness.
 */
export const isDocumentationPath = (file) => {
  if (typeof file !== 'string' || file === '') return false;
  // Git reports repository-relative POSIX paths. Anything else -- an absolute path, a traversal --
  // is not a shape this reasons about, so it is not documentation.
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').includes('..')
  ) {
    return false;
  }
  if (MANIFESTS.has(path.posix.basename(file))) return false;
  if (DOC_FILES.has(file)) return true;
  if (DOC_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
  return file.endsWith('.md');
};

/**
 * True when a repository-relative path is documentation OR a test file.
 *
 * Reuses `isDocumentationPath` wholesale rather than re-deriving its shape checks and manifest
 * denylist: the manifest denylist in particular must keep winning by basename before the `tests/`
 * allowance is ever consulted, and the surest way to guarantee that ordering is to not repeat it. A
 * dependency manifest under `tests/fixtures/package.json`, say, is rejected by
 * `isDocumentationPath`'s manifest check before this function's own `tests/` prefix check ever
 * runs -- the `if` below short-circuits on `true`, not on the denylist, so a manifest never reaches
 * the `tests/` branch to begin with.
 */
export const isDocsOrTestPath = (file) => {
  if (isDocumentationPath(file)) return true;
  // isDocumentationPath already returned false for every shape it refuses to reason about --
  // absolute paths, traversal, empty strings -- and for every manifest by basename. Re-running
  // those same rejections here would be redundant, but the manifest one is spelled out again
  // because it is the load-bearing property this predicate must never regress: a manifest must
  // never qualify via the `tests/` allowance either.
  if (typeof file !== 'string' || file === '') return false;
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').includes('..')
  ) {
    return false;
  }
  if (MANIFESTS.has(path.posix.basename(file))) return false;
  return file.startsWith('tests/');
};

/**
 * Paths outside `native/` whose change can still alter what the `Sidecar` job does or how it is
 * run, and which therefore deny the rust-untouched tier on their own.
 *
 * `ci.yml` is here because it *is* the job definition: an edit to the sidecar steps, the toolchain
 * action pin or the feature matrix must be exercised by the job it edits, and a tier that let a
 * change to those steps skip those steps would be self-certifying.
 *
 * `scripts/docs-only-change.mjs` is here for the same reason one level up: this file decides the
 * tier, so a change to it must never be classified by the version of itself under review.
 */
const RUST_GATE_FILES = new Set([
  '.github/workflows/ci.yml',
  'scripts/docs-only-change.mjs',
]);

/** Manifest basenames that belong to a cargo build specifically. */
const RUST_MANIFESTS = new Set(['Cargo.toml', 'Cargo.lock']);

/**
 * True when a repository-relative path can affect the `Sidecar` job.
 *
 * The safety direction is inverted relative to `isDocumentationPath`, and deliberately so. There
 * the load-bearing answer was "this IS documentation", so recognition had to be positive and
 * absence of evidence could not imply it. Here the load-bearing answer is "this DOES affect the
 * crate", so *that* is what must never be inferred from absence: anything this cannot reason
 * about, and anything carrying a Rust smell wherever it sits, answers `true` and the job runs.
 *
 * A prefix test on `native/` alone would be the fragile form: it is correct only for as long as
 * every crate lives there, and a second crate added elsewhere would silently stop being built.
 * `.rs` and the cargo manifests are matched by suffix and basename anywhere in the tree so the
 * predicate survives that move without needing to be revisited.
 */
export const affectsRust = (file) => {
  if (typeof file !== 'string' || file === '') return true;
  // A shape this cannot reason about is treated as affecting the crate, not as exempt from it.
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').includes('..')
  ) {
    return true;
  }
  if (file.startsWith('native/')) return true;
  if (file.endsWith('.rs')) return true;
  if (RUST_MANIFESTS.has(path.posix.basename(file))) return true;
  return RUST_GATE_FILES.has(file);
};

/**
 * Classifies a changed-file list against a path predicate, shared by both the docs-only and the
 * docs-and-tests tiers so their "empty list is not a licence to skip" and "list every offender"
 * behaviour cannot drift apart.
 *
 * An empty list is NOT a pass under either tier. "Nothing changed" and "the diff could not be
 * computed" arrive here as the same value, and only one of them is safe to treat as a licence to
 * skip.
 */
const classifyBy = (files, predicate, allLabel, offendersLabel) => {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      pass: false,
      offenders: [],
      reason: 'no changed files could be read',
    };
  }
  const offenders = files.filter((file) => !predicate(file));
  return {
    pass: offenders.length === 0,
    offenders,
    reason: offenders.length === 0 ? allLabel : offendersLabel,
  };
};

/**
 * Classifies a changed-file list for the documentation-only tier.
 */
export const classifyPaths = (files) => {
  const { pass, offenders, reason } = classifyBy(
    files,
    isDocumentationPath,
    'every changed path is documentation',
    'non-documentation paths changed',
  );
  return { docsOnly: pass, offenders, reason };
};

/**
 * Classifies a changed-file list for the docs-and-tests tier: every path is documentation or lives
 * under `tests/`. This tier is intentionally a SUPERSET of docs-only -- every docs-only change also
 * qualifies here -- so `ci.yml` only needs to consult it where the docs-only tier does not already
 * cover the same ground (the heavy `Sidecar`, `Release package` and `Dependency advisories` steps).
 * `Desktop`'s own steps stay gated on docs-only alone: a change that is docs-and-tests but not
 * docs-only, by construction, includes a `tests/` file, and `npm run test`, typecheck and lint must
 * all still run over it.
 */
export const classifyDocsAndTests = (files) => {
  const { pass, offenders, reason } = classifyBy(
    files,
    isDocsOrTestPath,
    'every changed path is documentation or a test',
    'paths outside documentation and tests changed',
  );
  return { docsAndTests: pass, offenders, reason };
};

/**
 * Classifies a changed-file list for the rust-untouched tier: no changed path can affect the
 * cargo build, so the `Sidecar` job's toolchain install, two format/clippy passes, four test
 * invocations and lib3mf build have nothing to say about the change under review (#707).
 *
 * This tier is INDEPENDENT of the other two rather than nested inside them. A pull request that
 * rewrites `src/main/index.ts` is neither docs-only nor docs-and-tests, and every `Desktop` and
 * `Release package` step correctly runs over it -- but it cannot change a line of Rust, and until
 * this tier existed it still paid for a full two-platform cargo matrix. That case is the common
 * one, not the exotic one: over the twenty pull requests preceding this change, nineteen touched
 * no Rust at all, and `Sidecar (windows-latest)` was the longest single job in the run on several
 * of them -- the wall-clock critical path, compiling a crate the change never reached.
 *
 * Because the tiers are independent, `ci.yml` composes them rather than replacing one with
 * another: the `Sidecar` steps stand down on docs-only OR docs-and-tests OR rust-untouched, and
 * the first two remain in the condition even though this tier now subsumes them in practice. They
 * are not redundant by construction, only by coincidence of the current predicates, and dropping
 * them would make `Sidecar`'s gating depend on that coincidence holding.
 */
export const classifyRustUntouched = (files) => {
  const { pass, offenders, reason } = classifyBy(
    files,
    (file) => !affectsRust(file),
    'no changed path can affect the cargo build',
    'paths that can affect the cargo build changed',
  );
  return { rustUntouched: pass, offenders, reason };
};

const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The pull request's base..head file list, or null when it cannot be established.
 *
 * Taken from the checkout rather than from the API, which buys three things: no token, no
 * pagination to get wrong on a large pull request, and no `github.event.pull_request.*`
 * interpolation -- which tests/ciWorkflowTriggers.test.ts forbids in ci.yml steps, because such a
 * step would fail on a merge-queue entry where no pull request object exists.
 *
 * For `pull_request`, actions/checkout resolves `refs/pull/N/merge`: a merge commit whose first
 * parent is the base branch tip and whose second is the pull request head. Diffing the first
 * parent against that merge commit is exactly the net change under review, which is why the two
 * parents are required to be present -- on any other event HEAD is an ordinary commit, `HEAD^1` is
 * merely its predecessor, and diffing it would answer a different question than the one asked.
 */
const changedFiles = () => {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  if (event !== 'pull_request') {
    return {
      files: null,
      why: `event is '${event || '(none)'}', not 'pull_request'`,
    };
  }

  let parents;
  try {
    parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'])
      .trim()
      .split(/\s+/);
  } catch (error) {
    return { files: null, why: `HEAD could not be resolved: ${error.message}` };
  }
  if (parents.length !== 3) {
    return {
      files: null,
      why: `HEAD has ${parents.length - 1} parent(s); the pull_request merge commit has 2`,
    };
  }
  const base = parents[1];

  try {
    // `-z` because `core.quotePath` would otherwise C-escape any non-ASCII path and the escaped
    // form would not match a suffix or prefix rule. `--no-renames` so a rename is reported as both
    // paths: moving a source file under docs/ must not read as a documentation change.
    const out = git([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      'HEAD',
    ]);
    return {
      files: out.split('\0').filter(Boolean),
      why: `diff ${base.slice(0, 8)}..HEAD`,
    };
  } catch (error) {
    // A checkout too narrow to hold the base tree lands here. Reported, and treated as a full
    // build: a fast path that cannot see what changed is the blind check this repository keeps
    // refusing to ship.
    return {
      files: null,
      why: `diff against ${base.slice(0, 8)} failed: ${error.message}`,
    };
  }
};

const main = () => {
  const { files, why } = changedFiles();
  const { docsOnly, offenders, reason } = classifyPaths(files ?? []);
  const {
    docsAndTests,
    offenders: docsAndTestsOffenders,
    reason: docsAndTestsReason,
  } = classifyDocsAndTests(files ?? []);
  const {
    rustUntouched,
    offenders: rustOffenders,
    reason: rustReason,
  } = classifyRustUntouched(files ?? []);

  console.log(`docs-only fast path: ${why}`);
  if (files) console.log(`changed files: ${files.length}`);
  if (offenders.length) {
    console.log('not documentation:');
    for (const file of offenders.slice(0, 20)) console.log(`  ${file}`);
    if (offenders.length > 20)
      console.log(`  ... and ${offenders.length - 20} more`);
  }
  console.log(`docs_only=${docsOnly} (${reason})`);

  if (docsAndTestsOffenders.length) {
    console.log('not documentation or tests:');
    for (const file of docsAndTestsOffenders.slice(0, 20))
      console.log(`  ${file}`);
    if (docsAndTestsOffenders.length > 20)
      console.log(`  ... and ${docsAndTestsOffenders.length - 20} more`);
  }
  console.log(`docs_and_tests=${docsAndTests} (${docsAndTestsReason})`);

  if (rustOffenders.length) {
    console.log('can affect the cargo build:');
    for (const file of rustOffenders.slice(0, 20)) console.log(`  ${file}`);
    if (rustOffenders.length > 20)
      console.log(`  ... and ${rustOffenders.length - 20} more`);
  }
  console.log(`rust_untouched=${rustUntouched} (${rustReason})`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `docs_only=${docsOnly}\n`);
    appendFileSync(out, `docs_and_tests=${docsAndTests}\n`);
    appendFileSync(out, `rust_untouched=${rustUntouched}\n`);
  }
};

// Written to $GITHUB_OUTPUT by this file rather than by a shell redirect in ci.yml: the jobs that
// invoke it run on windows-latest (pwsh) and macos-latest (bash), and a single `node ...` line is
// the same command under both.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
