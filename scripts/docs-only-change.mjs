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
 * Classifies a changed-file list.
 *
 * An empty list is NOT documentation-only. "Nothing changed" and "the diff could not be computed"
 * arrive here as the same value, and only one of them is safe to treat as a licence to skip.
 */
export const classifyPaths = (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      docsOnly: false,
      offenders: [],
      reason: 'no changed files could be read',
    };
  }
  const offenders = files.filter((file) => !isDocumentationPath(file));
  return {
    docsOnly: offenders.length === 0,
    offenders,
    reason:
      offenders.length === 0
        ? 'every changed path is documentation'
        : 'non-documentation paths changed',
  };
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

  console.log(`docs-only fast path: ${why}`);
  if (files) console.log(`changed files: ${files.length}`);
  if (offenders.length) {
    console.log('not documentation:');
    for (const file of offenders.slice(0, 20)) console.log(`  ${file}`);
    if (offenders.length > 20)
      console.log(`  ... and ${offenders.length - 20} more`);
  }
  console.log(`docs_only=${docsOnly} (${reason})`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `docs_only=${docsOnly}\n`);
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
