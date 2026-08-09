import { describe, expect, it } from 'vitest';

import {
  ALLOWED_LABEL_INDEX_USAGE,
  LABEL_INDEX_PATTERNS,
  SCANNED_DIRECTORIES,
  collectScannedFiles,
  flattenGhArgvInvocations,
  formatViolation,
  scanLabelIndexUsage,
} from '../scripts/check-label-index-usage.mjs';

// #299: five merged pull requests, `labels: []` at the object, still returned
// by `gh pr list --label hold:sequenced --state all` more than 27 hours after
// the removal. This is the CLI shape that produced that measurement.
const GH_PR_LIST_SNIPPET =
  'gh pr list --repo owner/repo --state all --label "hold:sequenced" --json number';

const GH_ISSUE_LIST_SNIPPET =
  'gh issue list --repo owner/repo --label "hold:sequenced" --state all';

const REST_LIST_SNIPPET =
  "fetch('https://api.github.com/repos/owner/repo/issues?labels=hold%3Asequenced&state=all')";

const SEARCH_API_SNIPPET =
  "fetch(`https://api.github.com/search/issues?q=${encodeURIComponent('repo:owner/repo label:hold:sequenced')}`)";

// Vasquez: `gh pr list --help`/`gh issue list --help` document `-l` as the
// short form of `--label`, so this is the same hazard as GH_PR_LIST_SNIPPET
// under a shorter spelling, not a different command.
const GH_PR_LIST_SHORTHAND_SNIPPET =
  'gh pr list --repo owner/repo --state all -l "hold:sequenced" --json number';

const GH_ISSUE_LIST_SHORTHAND_SNIPPET =
  'gh issue list --repo owner/repo -l "hold:sequenced" --state all';

// Hicks: `--search "label:..."` hands the label filter to the search index
// through a third spelling that the `--label`/`-l` patterns and the
// URL-anchored REST/search patterns above do not cover.
const GH_PR_LIST_SEARCH_LABEL_SNIPPET =
  'gh pr list --repo owner/repo --search "label:hold:sequenced" --state all';

const GH_ISSUE_LIST_SEARCH_LABEL_SNIPPET =
  'gh issue list --repo owner/repo --search "label:hold:sequenced"';

// Vasquez (round 1): the same `gh pr list --label` shape, but built as an
// argv array (execFileSync-style) rather than one contiguous string -- the
// pattern this repo's own scripts actually use to call `gh`/`git` to avoid
// shell injection. A scan that only read contiguous text would miss it.
const GH_PR_LIST_ARGV_ARRAY_SNIPPET = `
execFileSync('gh', [
  'pr',
  'list',
  '--repo',
  'owner/repo',
  '--label',
  'hold:sequenced',
  '--state',
  'all',
]);
`;

// Vasquez (round 2): naming the array before passing it -- a one-step
// refactor of the shape above -- must not evade detection. This is the
// argument-injection-shaped bypass the reviewer demonstrated: shape 1 alone
// only reconstructed the array literal written directly at the call site.
const GH_PR_LIST_ARGV_VARIABLE_SNIPPET = `
const ghArgs = [
  'pr',
  'list',
  '--repo',
  'owner/repo',
  '--label',
  'hold:sequenced',
];
execFileSync('gh', ghArgs);
`;

const GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET = `
const args = ['issue', 'list', '--repo', 'owner/repo', '-l', 'hold:sequenced'];
execFileSync('gh', args, { encoding: 'utf8' });
`;

// Vasquez (round 3): a binding declared safely and then REASSIGNED to a
// banned form before the call must resolve to the reassignment that
// actually reaches execFileSync, not the original safe declaration -- the
// bypass was "most recent in the whole file" (which finds the first/only
// match under a non-global regex) instead of "most recent before the call".
const GH_PR_LIST_ARGV_REASSIGNED_SNIPPET = `
let ghArgs = ['pr', 'list', '--repo', 'owner/repo'];
ghArgs = ['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced'];
execFileSync('gh', ghArgs);
`;

// Negative control: a safe declaration alone (no unsafe reassignment before
// the call) must NOT be flagged -- only the reassignment shape is a hazard.
const GH_PR_LIST_ARGV_SAFE_ONLY_SNIPPET = `
let ghArgs = ['pr', 'list', '--repo', 'owner/repo', '--state', 'all'];
execFileSync('gh', ghArgs);
`;

// The safe instrument: a per-object read. Must never be flagged, or every
// script that reads labels correctly (check-sequencing-hold.mjs,
// lift-hold-on-close.mjs's fetchPullRequest) would fail this check.
const OBJECT_READ_SNIPPET =
  'fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`)';

describe('scanLabelIndexUsage', () => {
  it('flags gh pr list --label as an unlisted violation', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: GH_PR_LIST_SNIPPET }],
    });
    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('scripts/example.mjs');
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list --label as an unlisted violation', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: GH_ISSUE_LIST_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  it('flags the REST issues collection filtered by labels=', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: REST_LIST_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'REST issues collection filtered by label',
    );
  });

  it('flags the search API label: qualifier', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('search API label: qualifier');
  });

  // Vasquez: the -l shorthand must be caught, not just --label.
  it('flags gh pr list -l (the --label shorthand)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_SHORTHAND_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list -l (the --label shorthand)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_SHORTHAND_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Hicks: --search "label:..." is a third spelling of the same bypass.
  it('flags gh pr list --search "label:..."', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_SEARCH_LABEL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'gh pr/issue list --search label:',
    );
  });

  it('flags gh issue list --search "label:..."', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_SEARCH_LABEL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'gh pr/issue list --search label:',
    );
  });

  // Vasquez: an argv-array invocation of the identical banned shape must be
  // caught, not just the contiguous-string spelling.
  it('flags gh pr list --label built as an execFileSync argv array', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_ARGV_ARRAY_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 2): the one-step evasion of the direct-array-literal
  // shape above -- name the array, then pass the identifier. Must be caught
  // exactly like the direct-literal shape, or the "fix" for round 1 would
  // be defeated by the most obvious refactor of the code it was meant to
  // catch.
  it('flags gh pr list --label built via a named argv variable (the direct-literal bypass)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_ARGV_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list -l built via a named argv variable, with an options object after it', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Negative control for the variable-indirection path: an argv variable
  // that holds a SAFE per-object gh call must not be flagged.
  it('does not flag a named argv variable holding a safe per-object gh call', () => {
    const safeVariableSnippet = `
const args = ['api', 'repos/owner/repo/issues/175/labels'];
execFileSync('gh', args);
`;
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: safeVariableSnippet }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  // Negative control for the argv-array flatten path itself: an execFileSync
  // argv array for a SAFE per-object gh call must not be flagged, or the
  // flatten step would be as useless as a scanner that matched every
  // execFileSync call regardless of arguments.
  it('does not flag an execFileSync argv array for a safe per-object gh call', () => {
    const safeArgvSnippet = `
execFileSync('gh', [
  'api',
  'repos/owner/repo/issues/175/labels',
]);
`;
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: safeArgvSnippet }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  // Negative control: the safe per-object read must never be flagged. Without
  // this, a scanner that matched every fetch() call would pass every positive
  // test above while being useless -- the same reasoning
  // forbiddenJobLiteral.test.ts applies to its absent-string control.
  it('does not flag a per-object label read', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: OBJECT_READ_SNIPPET }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  it('does not flag a file with no matching content at all', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: 'console.log("hi");' }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  it('permits a matched file present in the allowlist with a real reason', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
      allowlist: {
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier'],
          reason: 'a written reason',
        },
      },
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toHaveLength(1);
    expect(allowlisted[0]!.reason).toBe('a written reason');
  });

  // An allowlist entry must carry a reason, or it is indistinguishable from
  // silently deleting the check for that file -- the same requirement
  // check-script-reachability.mjs states for UNINVOKED_SCRIPTS.
  it.each(['', '   '])(
    'rejects an allowlist entry with an empty reason (%j)',
    (emptyReason) => {
      const { violations, allowlisted } = scanLabelIndexUsage({
        files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
        allowlist: {
          'scripts/example.mjs': {
            patterns: ['search API label: qualifier'],
            reason: emptyReason,
          },
        },
      });
      expect(allowlisted).toEqual([]);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain('not a justification');
    },
  );

  // Vasquez: a blanket per-file allow would let a NEW, unreviewed shape ride
  // in on a different shape's justification, silently, because the file
  // already "has an entry". Pattern-scoping must catch that.
  it('rejects an allowlist entry with no `patterns` list as excusing the whole file', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
      allowlist: {
        'scripts/example.mjs': { reason: 'a reason with no patterns list' },
      },
    });
    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain('patterns');
  });

  it('still flags a NEW pattern added to an already-allowlisted file', () => {
    const contentsWithTwoShapes = [SEARCH_API_SNIPPET, GH_PR_LIST_SNIPPET].join(
      '\n',
    );

    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: contentsWithTwoShapes }],
      allowlist: {
        // Only excuses the search-API shape -- the gh pr list --label shape
        // added later must still be reported, even though this file already
        // has an allowlist entry.
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier'],
          reason: 'the search-API shape re-reads before acting',
        },
      },
    });

    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toEqual(['gh pr list --label']);
    expect(violations[0]!.reason).toContain('DIFFERENT pattern');
  });

  it('allows only the covered patterns when a file matches both an allowlisted and a new shape', () => {
    const contentsWithTwoShapes = [
      SEARCH_API_SNIPPET,
      GH_ISSUE_LIST_SNIPPET,
    ].join('\n');

    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: contentsWithTwoShapes }],
      allowlist: {
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier', 'gh issue list --label'],
          reason: 'both shapes reviewed and re-read before acting',
        },
      },
    });

    expect(violations).toEqual([]);
    expect(allowlisted).toHaveLength(1);
    expect(allowlisted[0]!.matches.sort()).toEqual(
      ['gh issue list --label', 'search API label: qualifier'].sort(),
    );
  });

  it('scans every file independently, reporting each matched file once', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        { path: 'scripts/a.mjs', contents: GH_PR_LIST_SNIPPET },
        { path: 'scripts/b.mjs', contents: 'nothing interesting here' },
        { path: 'scripts/c.mjs', contents: GH_ISSUE_LIST_SNIPPET },
      ],
    });
    expect(violations.map((v) => v.path).sort()).toEqual([
      'scripts/a.mjs',
      'scripts/c.mjs',
    ]);
  });
});

describe('flattenGhArgvInvocations', () => {
  it('reconstructs a gh argv-array call as a plain-text command', () => {
    const flattened = flattenGhArgvInvocations(GH_PR_LIST_ARGV_ARRAY_SNIPPET);
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('returns an empty string when there is no gh argv-array call', () => {
    expect(flattenGhArgvInvocations('console.log("hi");')).toBe('');
  });

  // Vasquez (round 2): the bypass was resolving a named argv variable back
  // to its array-literal assignment, not giving up on it.
  it('resolves a named argv variable back to its own array-literal assignment', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_VARIABLE_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('resolves a named argv variable even when the call has a trailing options object', () => {
    const flattened = flattenGhArgvInvocations(
      GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET,
    );
    expect(flattened).toContain('gh issue list');
    expect(flattened).toContain('-l');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does not resolve an argv variable with no matching array-literal assignment in the file', () => {
    // Documented limit: an argv assembled through .push()/.concat()/spread
    // from another variable, or declared in a file this scan cannot see,
    // cannot be resolved by a text scan without executing the program --
    // the same interpolated-value limit LABEL_INDEX_PATTERNS already has.
    const variableArgvSnippet = "execFileSync('gh', ghArgs);";
    expect(flattenGhArgvInvocations(variableArgvSnippet)).toBe('');
  });

  // Vasquez (round 3): reassignment bypass -- a binding declared safely and
  // then reassigned to a banned form before the call must resolve to the
  // reassignment, not the original declaration.
  it('resolves a reassigned argv variable to its most recent assignment before the call', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_REASSIGNED_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does not flag a safe-only argv variable with no unsafe reassignment', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_SAFE_ONLY_SNIPPET,
    );
    expect(flattened).not.toContain('--label');
    expect(flattened).not.toContain('hold:sequenced');
  });
});

describe('formatViolation', () => {
  it('renders the path, matched patterns and reason', () => {
    const rendered = formatViolation({
      path: 'scripts/example.mjs',
      matches: ['gh pr list --label'],
      reason: 'no allowlist entry',
    });
    expect(rendered).toContain('scripts/example.mjs');
    expect(rendered).toContain('gh pr list --label');
    expect(rendered).toContain('no allowlist entry');
  });
});

describe('LABEL_INDEX_PATTERNS and SCANNED_DIRECTORIES', () => {
  it('names at least the five surfaces this check covers', () => {
    expect(LABEL_INDEX_PATTERNS.length).toBeGreaterThanOrEqual(5);
    const names = LABEL_INDEX_PATTERNS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'gh pr list --label',
        'gh issue list --label',
        'gh pr/issue list --search label:',
        'REST issues collection filtered by label',
        'search API label: qualifier',
      ]),
    );
  });

  it('scans scripts/ and .github/workflows/, not documentation', () => {
    expect(SCANNED_DIRECTORIES).toEqual(
      expect.arrayContaining(['scripts/', '.github/workflows/']),
    );
    // .squad/holds.md quotes `gh pr list --label` at length as a worked
    // example of #299 -- it must stay out of scope, or this guard would nag
    // every retelling of the issue it exists to prevent recurrence of.
    expect(SCANNED_DIRECTORIES).not.toEqual(
      expect.arrayContaining(['.squad/']),
    );
  });
});

describe('ALLOWED_LABEL_INDEX_USAGE', () => {
  it('carries a non-empty reason and a non-empty patterns list for every entry', () => {
    for (const [file, entry] of Object.entries(ALLOWED_LABEL_INDEX_USAGE)) {
      expect(file.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(entry.patterns)).toBe(true);
      expect(entry.patterns?.length).toBeGreaterThan(0);
      // Every named pattern must be a pattern this file actually defines --
      // an allowlist entry that names a typo'd or removed pattern would
      // silently excuse nothing while looking like it excuses something.
      const knownNames = LABEL_INDEX_PATTERNS.map((p) => p.name);
      for (const patternName of entry.patterns ?? []) {
        expect(knownNames).toContain(patternName);
      }
    }
  });

  it('allowlists lift-hold-on-close.mjs, the one script that legitimately queries the index', () => {
    expect(ALLOWED_LABEL_INDEX_USAGE).toHaveProperty(
      'scripts/lift-hold-on-close.mjs',
    );
    const entry = ALLOWED_LABEL_INDEX_USAGE['scripts/lift-hold-on-close.mjs'];
    expect(entry?.reason).toContain('re-read');
    expect(entry?.patterns).toEqual(['search API label: qualifier']);
  });
});

// Vasquez: `collectScannedFiles` must never follow a tracked symbolic link
// -- it could point outside this repository entirely, smuggling an
// unreviewed file's content into the scan under a `scripts/`-looking path.
describe('collectScannedFiles', () => {
  it('refuses a tracked symbolic link instead of reading through it', () => {
    const { files, refusedSymlinks } = collectScannedFiles({
      listFiles: () => ['scripts/real-file.mjs', 'scripts/escape-hatch.mjs'],
      lstat: (path) => ({
        isSymbolicLink: () => path === 'scripts/escape-hatch.mjs',
      }),
      readFile: (path) => {
        // The symlink path must never reach readFile at all -- if it does,
        // the guard ran too late to matter.
        if (path === 'scripts/escape-hatch.mjs') {
          throw new Error('readFile must not be called for a symbolic link');
        }
        return `contents of ${path}`;
      },
    });

    expect(refusedSymlinks).toEqual(['scripts/escape-hatch.mjs']);
    expect(files).toEqual([
      {
        path: 'scripts/real-file.mjs',
        contents: 'contents of scripts/real-file.mjs',
      },
    ]);
  });

  it('does not refuse a regular tracked file', () => {
    const { files, refusedSymlinks } = collectScannedFiles({
      listFiles: () => ['scripts/real-file.mjs'],
      lstat: () => ({ isSymbolicLink: () => false }),
      readFile: (path) => `contents of ${path}`,
    });

    expect(refusedSymlinks).toEqual([]);
    expect(files).toEqual([
      {
        path: 'scripts/real-file.mjs',
        contents: 'contents of scripts/real-file.mjs',
      },
    ]);
  });
});

// Real-repo scan: the tracked tree, right now, must be clean except for the
// one allowlisted file. This is the assertion that actually enforces #299's
// remedy going forward -- a future script that copies the `gh pr list
// --label` shape without reading this file first will fail this test.
describe('the tracked tree has no unlisted use of the label search/list index', () => {
  it('scans scripts/ and .github/workflows/ and finds only the allowlisted file, if any', () => {
    // Uses collectScannedFiles' real defaults (fs.readFileSync + `git
    // ls-files`, both resolved relative to the process cwd, which vitest
    // runs from the repository root) rather than reading a specific commit --
    // this test must see files as they are in the working tree, including
    // this change's own new/uncommitted files, not a stale HEAD.
    const { files, refusedSymlinks } = collectScannedFiles();

    // The real tree must contain no tracked symlinks under the scanned
    // directories; if it ever does, that is itself something to review, not
    // something this test should silently pass through.
    expect(refusedSymlinks).toEqual([]);

    // Controls, so a scan that read zero files is not indistinguishable from
    // a clean tree.
    expect(files.length).toBeGreaterThan(10);

    const { violations, allowlisted } = scanLabelIndexUsage({ files });

    if (violations.length > 0) {
      throw new Error(
        `label-index-usage violation(s):\n${violations.map(formatViolation).join('\n')}`,
      );
    }

    for (const entry of allowlisted) {
      expect(Object.keys(ALLOWED_LABEL_INDEX_USAGE)).toContain(entry.path);
    }
  });
});
