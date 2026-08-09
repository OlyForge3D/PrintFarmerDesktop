import { describe, expect, it } from 'vitest';

import {
  ALLOWED_LABEL_INDEX_USAGE,
  LABEL_INDEX_PATTERNS,
  SCANNED_DIRECTORIES,
  collectScannedFiles,
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

// The safe instrument: a per-object read. Must never be flagged, or every
// script that reads labels correctly (check-sequencing-hold.mjs,
// lift-hold-on-close.mjs's fetchPullRequest) would fail this check.
const OBJECT_READ_SNIPPET =
  "fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`)";

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
      files: [
        { path: 'scripts/example.mjs', contents: GH_ISSUE_LIST_SNIPPET },
      ],
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
      files: [
        { path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET },
      ],
      allowlist: { 'scripts/example.mjs': 'a written reason' },
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
        files: [
          { path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET },
        ],
        allowlist: { 'scripts/example.mjs': emptyReason },
      });
      expect(allowlisted).toEqual([]);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain('not a justification');
    },
  );

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
  it('names at least the four surfaces #299 measured', () => {
    expect(LABEL_INDEX_PATTERNS.length).toBeGreaterThanOrEqual(4);
    const names = LABEL_INDEX_PATTERNS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'gh pr list --label',
        'gh issue list --label',
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
  it('carries a non-empty reason for every entry', () => {
    for (const [file, reason] of Object.entries(ALLOWED_LABEL_INDEX_USAGE)) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(file.length).toBeGreaterThan(0);
    }
  });

  it('allowlists lift-hold-on-close.mjs, the one script that legitimately queries the index', () => {
    expect(ALLOWED_LABEL_INDEX_USAGE).toHaveProperty(
      'scripts/lift-hold-on-close.mjs',
    );
    expect(ALLOWED_LABEL_INDEX_USAGE['scripts/lift-hold-on-close.mjs']).toContain(
      're-read',
    );
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
    const files = collectScannedFiles();

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
