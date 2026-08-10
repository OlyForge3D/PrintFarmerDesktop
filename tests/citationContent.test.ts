import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ancestorStatus,
  addedLinesOf,
  classify,
  findLiveControlCommit,
  parseAssertions,
  reachabilityOf,
  readerRevisions,
} from '../scripts/check-citation-content.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// #528: a new, SEPARATE instrument from check-citation-reachability.mjs. It must be able to
// disagree with that check's verdict on the same SHA - that is the entire premise of having two
// instruments rather than one - so this suite spins up its own synthetic repositories rather than
// importing any fixture helper from citationReachability.test.ts, whose fixtures are shaped for
// that harness's ledger grammar (twins, declarations) and not this one's (assertions).
const CONTENT_HARNESS = 'scripts/check-citation-content.mjs';
const REACHABILITY_HARNESS = 'scripts/check-citation-reachability.mjs';
const CORPUS_MODULE = 'scripts/citation-corpus.mjs';
const DOCS_ONLY_MODULE = 'scripts/docs-only-change.mjs';
const HARNESS_MODULES = [
  CONTENT_HARNESS,
  REACHABILITY_HARNESS,
  CORPUS_MODULE,
  DOCS_ONLY_MODULE,
];

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const run = (dir: string, args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const commit = (dir: string, message: string) => {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', message], {
    stdio: 'ignore',
  });
  return run(dir, ['rev-parse', 'HEAD']);
};

const ledger = (dir: string, rows: string) =>
  writeFileSync(
    path.join(dir, '.squad', 'fact-checker', 'content-assertions.md'),
    [
      '# Content assertions',
      '',
      '## Citations with a pinned content assertion',
      '',
      rows,
    ].join('\n'),
  );

const assertionRow = (sha: string, text: string) =>
  `- \`${sha}\` \u2014 asserts: \`${text}\`\n`;

/**
 * A fresh repository carrying: a commit whose diff adds a known, quotable line (`cited`); a
 * second commit built on top of it so `cited` is not HEAD (a real ancestor, not a tautology); and
 * a third, independent branch commit that is never merged in, so it resolves in this repository's
 * object store but is not reachable from HEAD or origin/development - the exact position of a
 * citation orphaned by a rebase, and the position this content check must WITHHOLD from rather
 * than fail.
 */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'content-'));
  made.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
  for (const script of HARNESS_MODULES) {
    copyFileSync(
      path.join(repositoryRoot, script),
      path.join(dir, script.replace(/\//g, path.sep)),
    );
  }
  writeFileSync(path.join(dir, '.squad', 'fact-checker', 'audit-trail.md'), '');
  writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

  const notes = path.join(dir, 'notes.md');
  writeFileSync(notes, 'opening line\n');
  ledger(dir, assertionRow('0'.repeat(40), 'placeholder'));
  commit(dir, 'seed');

  const CLAIM = 'the guard rejects a request with no signature\n';
  writeFileSync(notes, `opening line\n${CLAIM}`);
  const cited = commit(dir, 'add the guard');

  writeFileSync(path.join(dir, 'other.md'), 'unrelated follow-up work\n');
  commit(dir, 'follow-up commit so cited is not HEAD');

  // A commit that exists in the object database (this is one repository) but is never an
  // ancestor of the branch this fixture leaves checked out - built and then orphaned by reset,
  // mirroring how a rebase orphans a citation in the real repository this check protects.
  execFileSync('git', ['-C', dir, 'checkout', '-qb', 'throwaway'], {
    stdio: 'ignore',
  });
  writeFileSync(notes, 'opening line\na branch that is never merged back\n');
  const orphan = commit(dir, 'orphaned branch tip');
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'master'], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'branch', '-D', 'throwaway'], {
    stdio: 'ignore',
  });

  return { dir, cited, orphan, claim: CLAIM.trim() };
};

/**
 * check-citation-reachability.mjs scans audit-trail.md/policy.md, not this file's own ledger, so
 * a SHA must be cited there too before that sibling check can render a verdict on it at all.
 * Written per-test rather than unconditionally into every fixture, because embedding BOTH
 * `cited` and `orphan` unconditionally would make every reachability run report the orphan as an
 * ORPHAN regardless of which SHA a given test means to exercise.
 */
const citeInAuditTrail = (dir: string, sha: string) =>
  writeFileSync(
    path.join(dir, '.squad', 'fact-checker', 'audit-trail.md'),
    `# Audit trail\n\nThe finding under test sits at \`${sha}\`.\n`,
  );

const runContentCheck = (dir: string) => {
  const r = spawnSync('node', [CONTENT_HARNESS], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const runReachabilityCheck = (dir: string) => {
  const r = spawnSync('node', [REACHABILITY_HARNESS, '--floor=0'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

describe('check-citation-content.mjs is a separate instrument from check-citation-reachability.mjs', () => {
  it('a reachable citation with a TRUE assertion: content check PASSes, run exits 0', () => {
    const { dir, cited, claim } = fixture();
    ledger(dir, assertionRow(cited, claim));

    const { status, out } = runContentCheck(dir);

    expect(out).toMatch(/PASS 1\s+FAIL 0\s+WITHHOLD 0/);
    expect(status).toBe(0);
  });

  /**
   * The acceptance criterion this test exists to satisfy: "at least one test pins a sighted
   * FAILING verdict, so the check cannot pass merely by never being able to look." The cited
   * commit here is genuinely reachable - the same commit as the passing case above - so this is
   * not a withheld verdict. The assertion is false, and the check says so.
   */
  it('a reachable citation with a FALSE assertion: content check FAILs, run exits 1', () => {
    const { dir, cited } = fixture();
    ledger(
      dir,
      assertionRow(cited, 'text that this commit never added anywhere'),
    );

    const { status, out } = runContentCheck(dir);

    expect(out).toMatch(/PASS 0\s+FAIL 1\s+WITHHOLD 0/);
    expect(out).toContain('reachable and wrong');
    expect(status).toBe(1);
  });

  /**
   * The other acceptance criterion this test exists to satisfy: a blind position (the cited
   * object is not reachable from this reader's revisions) WITHHOLDS rather than fails. Failing
   * here would duplicate check-citation-reachability.mjs's ORPHAN verdict under this file's exit
   * code, which is the exact defect #528 was filed to prevent.
   */
  it('an unreachable citation: content check WITHHOLDs, run still exits 0', () => {
    const { dir, orphan } = fixture();
    ledger(dir, assertionRow(orphan, 'anything at all'));

    const { status, out } = runContentCheck(dir);

    expect(out).toMatch(/PASS 0\s+FAIL 0\s+WITHHOLD 1/);
    expect(status).toBe(0);
  });

  it('a citation naming a SHA that does not resolve here at all: WITHHOLDs, never FAILs (git\u2019s 128 is "no answer", never "no")', () => {
    const { dir } = fixture();
    ledger(
      dir,
      assertionRow('89abcdef0123456789abcdef0123456789abcdef', 'anything'),
    );

    const { status, out } = runContentCheck(dir);

    expect(out).toMatch(/PASS 0\s+FAIL 0\s+WITHHOLD 1/);
    expect(status).toBe(0);
  });

  /**
   * The pair the issue demands: on the SAME cited SHA, check-citation-reachability.mjs and
   * check-citation-content.mjs return DIFFERENT verdicts. Reachability only ever asks "can a
   * reader reach this revision" and the cited commit plainly can be, so it passes clean. Content
   * asks the adjacent question this repository had no instrument for, and the assertion attached
   * to the citation is false - so it fails, on the exact commit the sibling check just cleared.
   */
  it('the SAME reachable citation gets a different verdict from each instrument', () => {
    const { dir, cited } = fixture();
    ledger(
      dir,
      assertionRow(cited, 'a claim this commit never actually added'),
    );
    citeInAuditTrail(dir, cited);

    const reachability = runReachabilityCheck(dir);
    const content = runContentCheck(dir);

    expect(reachability.status).toBe(0);
    expect(reachability.out).toMatch(
      /REACHABLE \d+\s+TWIN 0\s+DECLARED 0\s+ORPHAN 0/,
    );

    expect(content.status).toBe(1);
    expect(content.out).toMatch(/PASS 0\s+FAIL 1\s+WITHHOLD 0/);
  });

  /**
   * And the reverse direction: an orphaned citation reads as ORPHAN (a real, exit-1 finding) to
   * the reachability harness, while the content check - which must never answer the reachability
   * question under its own exit code - reports WITHHOLD and a clean exit. Two different verdicts
   * on one SHA, in the other direction from the pair above.
   */
  it('an orphaned citation: reachability FAILs (ORPHAN), content check WITHHOLDs and exits clean', () => {
    const { dir, orphan } = fixture();
    ledger(dir, assertionRow(orphan, 'anything'));
    citeInAuditTrail(dir, orphan);

    const reachability = runReachabilityCheck(dir);
    const content = runContentCheck(dir);

    expect(reachability.status).toBe(1);
    expect(reachability.out).toMatch(/ORPHAN [1-9]\d*/);

    expect(content.status).toBe(0);
    expect(content.out).toMatch(/PASS 0\s+FAIL 0\s+WITHHOLD 1/);
  });

  it('refuses to publish a verdict over an empty corpus rather than pass vacuously', () => {
    const { dir } = fixture();
    ledger(dir, '');

    const { status, out } = runContentCheck(dir);

    expect(status).toBe(2);
    expect(out).toMatch(/INCONCLUSIVE|CONTROL FAILED/);
  });

  /**
   * Hicks (QA), reviewing #688: a deletion-only commit at HEAD is entirely ordinary - reverts,
   * dead-code removal, a `.gitignore` trim - and this workflow step runs on every `synchronize`.
   * The live control must not treat "HEAD itself added nothing" as "the diff-reading machinery is
   * broken": it walks back to the nearest ancestor that did add a line. This pins that a real
   * deletion-only commit at HEAD does not spuriously trip CONTROL FAILED, and the run still
   * reaches and reports the real ledger.
   */
  it('HEAD is a deletion-only commit: the live control is still built from an earlier commit, not CONTROL FAILED', () => {
    const { dir, cited, claim } = fixture();
    ledger(dir, assertionRow(cited, claim));

    // A commit at HEAD that removes a line and adds nothing.
    const notes = path.join(dir, 'notes.md');
    const before = readFileSync(notes, 'utf8');
    writeFileSync(
      notes,
      before.split('\n').slice(0, 1).join('\n') +
        (before.endsWith('\n') ? '\n' : ''),
    );
    commit(dir, 'delete-only: trim a stale line, add nothing');

    const { status, out } = runContentCheck(dir);

    expect(out).not.toMatch(/CONTROL FAILED/);
    expect(out).toMatch(/PASS 1\s+FAIL 0\s+WITHHOLD 0/);
    expect(status).toBe(0);
  });

  /**
   * Same hazard, the other ordinary shape: HEAD is a merge commit. `addedLinesOf` already refuses
   * to read a merge's combined diff (see its own header comment), so a control built naively from
   * HEAD alone would find no lines and report CONTROL FAILED on every merge commit - which, on a
   * branch that receives routine merges from its base, is not a rare event.
   */
  it('HEAD is a merge commit: the live control is still built from an earlier, non-merge commit', () => {
    const { dir, cited, claim } = fixture();
    ledger(dir, assertionRow(cited, claim));

    execFileSync('git', ['-C', dir, 'checkout', '-qb', 'side'], {
      stdio: 'ignore',
    });
    writeFileSync(path.join(dir, 'side.md'), 'work done on a side branch\n');
    commit(dir, 'side-branch commit');
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'master'], {
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-C',
        dir,
        'merge',
        '--no-ff',
        '-q',
        '-m',
        'merge side into master',
        'side',
      ],
      { stdio: 'ignore' },
    );
    execFileSync('git', ['-C', dir, 'branch', '-D', 'side'], {
      stdio: 'ignore',
    });

    const { status, out } = runContentCheck(dir);

    expect(out).not.toMatch(/CONTROL FAILED/);
    expect(out).toMatch(/PASS 1\s+FAIL 0\s+WITHHOLD 0/);
    expect(status).toBe(0);
  });
});

describe('findLiveControlCommit walks back past HEAD to build the live control', () => {
  it('skips a deletion-only HEAD and returns the nearest ancestor with a non-blank added line', () => {
    const { dir } = fixture();
    const notes = path.join(dir, 'notes.md');
    const before = readFileSync(notes, 'utf8');
    writeFileSync(
      notes,
      before.split('\n').slice(0, 1).join('\n') +
        (before.endsWith('\n') ? '\n' : ''),
    );
    commit(dir, 'delete-only, nothing added');

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const found = findLiveControlCommit();
      expect(found).not.toBeNull();
      // The fixture's own follow-up commit (walked past the deletion-only HEAD) adds this line,
      // not `claim` -- `claim` is two commits further back, behind that intervening one.
      expect(found?.line).toBe('unrelated follow-up work');
    } finally {
      process.chdir(cwd);
    }
  });

  it('returns null, rather than throwing, when nothing in the searched depth added a line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'no-content-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'x.md'), '\n');
    commit(dir, 'a commit that adds only a blank line');

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(findLiveControlCommit(50)).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('the pure classifier', () => {
  const revs = readerRevisions();

  it('resolves this repository\u2019s own HEAD as reachable', () => {
    expect(ancestorStatus('HEAD', 'HEAD')).toBe('ANCESTOR');
  });

  it('reports NO_ANSWER, never NOT_ANCESTOR, for a SHA that does not resolve', () => {
    expect(
      ancestorStatus('89abcdef0123456789abcdef0123456789abcdef', 'HEAD'),
    ).toBe('NO_ANSWER');
  });

  it('reachabilityOf refuses to call a mix of NO_ANSWER and NOT_ANCESTOR a negative', () => {
    expect(
      reachabilityOf('89abcdef0123456789abcdef0123456789abcdef', revs),
    ).toBe('NO_ANSWER');
  });

  it('addedLinesOf reads real added lines for a real commit in this repository', () => {
    // scripts/citation-corpus.mjs's introducing commit - reachable, non-merge, and its own
    // opening comment line is asserted verbatim in .squad/fact-checker/content-assertions.md.
    const lines = addedLinesOf('42054254e06e26d164cf8f56c8f776dd5d828e2a');
    expect(lines).not.toBeNull();
    expect(
      (lines ?? []).some((line) =>
        line.includes(
          'This module is deliberately the *mechanism* and never the *number*.',
        ),
      ),
    ).toBe(true);
  });

  it('classify PASSes the real ledger row this repository ships', () => {
    const result = classify(
      '42054254e06e26d164cf8f56c8f776dd5d828e2a',
      'This module is deliberately the *mechanism* and never the *number*.',
      revs,
    );
    expect(result.verdict).toBe('PASS');
  });

  it('classify FAILs the same reachable commit against a false assertion', () => {
    const result = classify(
      '42054254e06e26d164cf8f56c8f776dd5d828e2a',
      'a sentence this commit never wrote',
      revs,
    );
    expect(result.verdict).toBe('FAIL');
  });
});

describe('the ledger this repository ships is parsed correctly', () => {
  it('parses at least one real assertion row', () => {
    const text = readFileSync(
      path.join(
        repositoryRoot,
        '.squad',
        'fact-checker',
        'content-assertions.md',
      ),
      'utf8',
    );
    const rows = parseAssertions(
      new Map([['.squad/fact-checker/content-assertions.md', text]]),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(rows[0]?.assertion.length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * #528's third acceptance criterion: registered wherever check-script-reachability.mjs expects
 * checks to be registered, so it is actually invoked and not merely added and left dormant.
 */
describe('the new check is registered, not merely written', () => {
  it('is wired into package.json as an npm script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['check:citation-content']).toBe(
      'node scripts/check-citation-content.mjs',
    );
  });

  it('is invoked by a workflow run: step, so check-script-reachability.mjs need not allowlist it', () => {
    const workflowsDir = path.join(repositoryRoot, '.github', 'workflows');
    const files = execFileSync(
      'git',
      ['-C', repositoryRoot, 'ls-files', '.github/workflows'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    const invoked = files.some((file) =>
      readFileSync(path.join(repositoryRoot, file), 'utf8').includes(
        'npm run check:citation-content',
      ),
    );
    expect(invoked).toBe(true);
    expect(workflowsDir).toContain('workflows');
  });
});
