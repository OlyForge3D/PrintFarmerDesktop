import { describe, expect, it, vi } from 'vitest';

import {
  EXIT_UP_TO_DATE,
  EXIT_BEHIND,
  EXIT_UNDETERMINED,
  evaluateBehindBase,
  formatResult,
  parseArgs,
  main,
} from '../scripts/check-behind-base.mjs';

// The git-level primitives (isAncestor, fetchBase, fetchPrHead, resolveCommit)
// come from scripts/sha-status.mjs and are already exercised there. main()
// integration tests below stub them so this file tests decision logic, not
// git plumbing.
vi.mock('../scripts/sha-status.mjs', () => ({
  isAncestor: vi.fn(),
  fetchBase: vi.fn(),
  fetchPrHead: vi.fn(),
  resolveCommit: vi.fn(),
}));

const shaStatus = await import('../scripts/sha-status.mjs');

describe('evaluateBehindBase', () => {
  it('is up to date when the base is an ancestor of the head', () => {
    const r = evaluateBehindBase({ baseIsAncestorOfHead: true });
    expect(r.state).toBe('up-to-date');
    expect(r.exitCode).toBe(EXIT_UP_TO_DATE);
  });

  it('is BEHIND when the base is not an ancestor of the head — #322s condition', () => {
    // This is the exact defect #397 is about: #322's head did not contain a
    // commit that had already landed on the base, and it merged anyway.
    const r = evaluateBehindBase({ baseIsAncestorOfHead: false });
    expect(r.state).toBe('behind');
    expect(r.exitCode).toBe(EXIT_BEHIND);
  });

  it('is undetermined when ancestry could not be measured, not a silent pass', () => {
    expect(evaluateBehindBase({ baseIsAncestorOfHead: null }).exitCode).toBe(
      EXIT_UNDETERMINED,
    );
    expect(
      evaluateBehindBase({ baseIsAncestorOfHead: undefined }).exitCode,
    ).toBe(EXIT_UNDETERMINED);
  });

  it('the three codes are distinct', () => {
    expect(
      new Set([EXIT_UP_TO_DATE, EXIT_BEHIND, EXIT_UNDETERMINED]).size,
    ).toBe(3);
  });
});

describe('formatResult', () => {
  it('says safe to merge when up to date', () => {
    const text = formatResult(1, 'development', {
      state: 'up-to-date',
      exitCode: EXIT_UP_TO_DATE,
    });
    expect(text).toContain('Safe to merge');
  });

  it('refuses and explains the sync path when BEHIND', () => {
    const text = formatResult(1, 'development', {
      state: 'behind',
      exitCode: EXIT_BEHIND,
    });
    expect(text).toContain('Do not merge');
    expect(text).toContain('rebasing');
    // The Update-branch button creates a merge commit, which this repo's
    // required_linear_history forbids on its normal squash-only path.
    expect(text).toContain('Update branch');
  });

  it('does not claim safety when undetermined', () => {
    const text = formatResult(1, 'development', {
      state: 'undetermined',
      exitCode: EXIT_UNDETERMINED,
    });
    expect(text).toContain('not evidence the PR is safe to merge');
  });
});

describe('parseArgs', () => {
  it('reads a pr number', () => {
    expect(parseArgs(['--pr', '397']).pr).toBe(397);
  });

  it('defaults remote to origin', () => {
    expect(parseArgs(['--pr', '1']).remote).toBe('origin');
  });

  it('reads an explicit remote', () => {
    expect(parseArgs(['--pr', '1', '--remote', 'upstream']).remote).toBe(
      'upstream',
    );
  });

  it('rejects a non-numeric pr', () => {
    expect(parseArgs(['--pr', 'abc']).error).toMatch(/needs a number/);
  });

  it('rejects a missing pr value', () => {
    expect(parseArgs(['--pr']).error).toMatch(/needs a number/);
  });

  it('rejects an unknown argument', () => {
    expect(parseArgs(['--wat']).error).toMatch(/unrecognised/);
  });

  it('reads help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('main', () => {
  it('refuses without a pr number, and calls it undetermined not a pass', () => {
    expect(main([], {}, () => ({ status: 0 }))).toBe(EXIT_UNDETERMINED);
  });

  it('refuses without a credential', () => {
    expect(
      main(['--pr', '1'], { SKIP_CREDENTIAL_DISCOVERY: '1' }, () => ({
        status: 0,
        stdout: '',
        stderr: '',
      })),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('AN EXCEPTION IS NOT A FINDING: a throw becomes 2, never a verdict', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => {
          throw new Error('boom');
        },
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 2 when gh output cannot be parsed', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({ status: 0, stdout: 'not json', stderr: '' }),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 2 when gh reports no baseRefName/headRefOid', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({ status: 0, stdout: JSON.stringify({}), stderr: '' }),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  function stubGh(baseRefName: string, headRefOid: string) {
    return () => ({
      status: 0,
      stdout: JSON.stringify({ baseRefName, headRefOid }),
      stderr: '',
    });
  }

  it('returns 0 when the base is an ancestor of the fetched head', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.resolveCommit).mockReturnValue('deadbeef');
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/base',
      fresh: true,
      refreshable: true,
    });
    vi.mocked(shaStatus.isAncestor).mockReturnValue(true);

    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        stubGh('development', 'deadbeef'),
      ),
    ).toBe(EXIT_UP_TO_DATE);
  });

  it('returns 1 (BEHIND) when the base is not an ancestor of the head — #322', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.resolveCommit).mockReturnValue('deadbeef');
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/base',
      fresh: true,
      refreshable: true,
    });
    vi.mocked(shaStatus.isAncestor).mockReturnValue(false);

    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        stubGh('development', 'deadbeef'),
      ),
    ).toBe(EXIT_BEHIND);
  });

  it('returns 2 when the PR head cannot be fetched', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue(null);

    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        stubGh('development', 'deadbeef'),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 2 when the base ref cannot be refreshed, rather than trusting a stale cache', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.resolveCommit).mockReturnValue('deadbeef');
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'origin/development',
      fresh: false,
      refreshable: true,
    });

    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        stubGh('development', 'deadbeef'),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 2 when the PR moved between gh reporting and the fetch resolving it', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.resolveCommit).mockReturnValue('newer-sha');
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/base',
      fresh: true,
      refreshable: true,
    });

    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        stubGh('development', 'deadbeef'),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('the three exit codes are distinct', () => {
    expect(
      new Set([EXIT_UP_TO_DATE, EXIT_BEHIND, EXIT_UNDETERMINED]).size,
    ).toBe(3);
  });
});
