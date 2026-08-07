import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * #121. Two measurement scripts shipped in this pull request had zero call
 * sites. The only occurrence of either filename anywhere in the repository was
 * the "Run it:" comment in its own header - no npm script, no workflow, no
 * import, no test. They were landed in the same change that discharged a
 * blocker raised for exactly that shape, by an author who had just written the
 * ledger entry about it.
 *
 * The reason it survived review twice is that an uninvoked script is not
 * visibly different from an invoked one. It is present, it is correct, it runs
 * when a human runs it, and every gate in the repository is green because no
 * gate ever asks. The distinguishing evidence is the call site, which is the
 * one thing nobody reads.
 *
 * That would be a tidiness complaint if the scripts were incidental. They are
 * not: `docs/security/THREAT_MODEL.md` states in the present tense that
 * `measure-diamond-dag.mjs` "rebuilds the fixture and measures the two
 * populations separately", and the figure family it produces is the evidence
 * for the cross-artifact divergence this whole change exists to detect. So a
 * document asserted what a script does while nothing ran the script - the same
 * sentence-without-a-check that the citation harness was blocked for, one file
 * over, undetected while that blocker was being discharged.
 *
 * These tests execute both scripts and assert the figures they are cited for.
 * The point is not coverage. It is that the numbers quoted across six artifacts
 * stop being a reading someone once took and become a condition that fails the
 * build when it stops holding.
 */

const runScript = (
  relativePath: string,
  cwd = repositoryRoot,
): { output: string; status: number } => {
  const result = spawnSync('node', [path.join(repositoryRoot, relativePath)], {
    encoding: 'utf8',
    cwd,
    maxBuffer: 1 << 28,
  });
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status ?? -1,
  };
};

const mentionFixturePaths = [
  '.squad/decisions/inbox/ripley-false-outcome-invented-mechanism.md',
  '.squad/decisions/inbox/ripley-falsifier-before-publishing.md',
  '.squad/decisions/inbox/ripley-go-and-look.md',
  '.squad/decisions.md',
  '.squad/skills/test-discipline/SKILL.md',
  'docs/security/THREAT_MODEL.md',
  '.squad/fact-checker/audit-trail.md',
];

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createBranchOnlyMentionFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mention-filter-'));
  git(root, ['init', '-q', '-b', 'fixture']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  for (const relative of mentionFixturePaths) {
    const absolute = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'fixture 49,150 32,767 16,383 16,384\n');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

describe('the measurement scripts this change cites are executed, not merely present', () => {
  it('rebuilds the diamond DAG and reports the total the threat model names', () => {
    const { output, status } = runScript('scripts/measure-diamond-dag.mjs');
    expect(status).toBe(0);

    // The divergence run D found: the log and the skill say 49,150 rows, and
    // THREAT_MODEL.md section T2.2 said 32,767. Both numbers are real and they
    // count different populations, which is why the disagreement survived
    // review - each side was quoting a true figure.
    expect(output).toContain('49150');
    expect(output).toContain('32767');
  });

  it('separates the two populations rather than reporting one as the total', () => {
    const { output, status } = runScript('scripts/measure-diamond-dag.mjs');
    expect(status).toBe(0);

    // 32,767 is the m-chain row count and 16,383 comes from the s nodes. The
    // failure mode this guards is a future edit that collapses them back into a
    // single number, which is the exact shape of the original defect.
    expect(output).toContain('16383');
    expect(output).toContain('16384');
  });

  it('reports the mention-filtered figure counts across the artifacts', () => {
    const { output, status } = runScript('scripts/measure-mention-filter.mjs');

    expect(status).toBe(0);
    // The filter exists because a figure quoted inside a fence or a quotation
    // is a mention, not a claim, and counting mentions as claims manufactures
    // divergences. The header proves the filtered columns are still produced.
    expect(output).toMatch(/raw/);
    expect(output).toMatch(/-fence/);
    expect(output).toMatch(/-quoted/);
  });

  it('confirms run D is discharged in the commit under test', () => {
    const { output, status } = runScript('scripts/measure-mention-filter.mjs');

    expect(status).toBe(0);

    // Run D found docs/security/THREAT_MODEL.md rendering the diamond-DAG row
    // count as 32,767 where every other artifact rendered it 49,150. That
    // divergence was repaired on the mainline by c8d379ff0dfd06095defb36792b8b1d1393bdd41,
    // whose parent still reads "expanded to 32,767 rows".
    //
    // The table alone cannot certify the repair: the file legitimately still
    // carries 32,767 as a *path* count, so a row-level substring test passes
    // whether the figure is used or mentioned. The discriminator has to be the
    // sentence, which is why this reads the blob rather than trusting the row.
    const sentence = execFileSync(
      'git',
      ['show', 'HEAD:docs/security/THREAT_MODEL.md'],
      { encoding: 'utf8', cwd: repositoryRoot, maxBuffer: 1 << 28 },
    )
      .split('\n')
      .find((line) => line.includes('diamond DAG expanded to'));

    expect(sentence).toBeDefined();
    expect(sentence).toContain('49,150 rows');
    expect(sentence).not.toContain('32,767 rows');

    // And the figure must still be one the script actually reports, so this
    // cannot pass against a table that has silently stopped being produced.
    const rows = output
      .split('\n')
      .filter((line) => line.includes('THREAT_MODEL.md'));

    expect(rows.some((line) => line.includes('49,150'))).toBe(true);
  });

  it('runs from a branch-only checkout and still refuses a missing committed input', () => {
    const root = createBranchOnlyMentionFixture();
    try {
      const complete = runScript('scripts/measure-mention-filter.mjs', root);
      expect(complete.status, complete.output).toBe(0);
      expect(complete.output).not.toContain('INCOMPLETE');

      const missing = mentionFixturePaths[0]!;
      rmSync(path.join(root, ...missing.split('/')));
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', 'remove required input']);

      const incomplete = runScript('scripts/measure-mention-filter.mjs', root);
      expect(incomplete.status).toBe(2);
      expect(incomplete.output).toContain(`MISSING HEAD:${missing}`);
      expect(incomplete.output).toContain('INCOMPLETE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
