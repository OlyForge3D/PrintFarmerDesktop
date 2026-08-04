import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

const runScript = (relativePath: string): string =>
  execFileSync('node', [path.join(repositoryRoot, relativePath)], {
    encoding: 'utf8',
    cwd: repositoryRoot,
    maxBuffer: 1 << 28,
  });

describe('the measurement scripts this change cites are executed, not merely present', () => {
  it('rebuilds the diamond DAG and reports the total the threat model names', () => {
    const output = runScript('scripts/measure-diamond-dag.mjs');

    // The divergence run D found: the log and the skill say 49,150 rows, and
    // THREAT_MODEL.md section T2.2 said 32,767. Both numbers are real and they
    // count different populations, which is why the disagreement survived
    // review - each side was quoting a true figure.
    expect(output).toContain('49150');
    expect(output).toContain('32767');
  });

  it('separates the two populations rather than reporting one as the total', () => {
    const output = runScript('scripts/measure-diamond-dag.mjs');

    // 32,767 is the m-chain row count and 16,383 comes from the s nodes. The
    // failure mode this guards is a future edit that collapses them back into a
    // single number, which is the exact shape of the original defect.
    expect(output).toContain('16383');
    expect(output).toContain('16384');
  });

  it('reports the mention-filtered figure counts across the artifacts', () => {
    const output = runScript('scripts/measure-mention-filter.mjs');

    // The filter exists because a figure quoted inside a fence or a quotation
    // is a mention, not a claim, and counting mentions as claims manufactures
    // divergences. The header proves the filtered columns are still produced.
    expect(output).toMatch(/raw/);
    expect(output).toMatch(/-fence/);
    expect(output).toMatch(/-quoted/);
  });

  it('still finds the unrepaired third rendering in the threat model', () => {
    const output = runScript('scripts/measure-mention-filter.mjs');

    // Run D's finding, expressed as a condition instead of a sentence. While
    // THREAT_MODEL.md carries 32,767 it must appear in this table; when the
    // repair lands on the mainline this assertion is the thing that notices,
    // because it will fail and force the ledger entry to be updated with it.
    const row = output
      .split('\n')
      .find((line) => line.includes('THREAT_MODEL.md'));

    expect(row).toBeDefined();
    expect(row).toContain('32,767');
  });
});
