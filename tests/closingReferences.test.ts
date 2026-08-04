import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareClosures,
  formatFailure,
  formatUnsettled,
  main,
  parseDeclaredClosures,
  readSettled,
} from '../scripts/check-closing-references.mjs';

/**
 * #231. See the header of scripts/check-closing-references.mjs for the
 * measurement these tests encode.
 *
 * Note what this file does NOT contain: a literal closing keyword followed by a
 * bare issue reference. Every fixture below keeps the two apart, or wraps them,
 * because a pull request that describes this defect in prose performs it. The
 * first write-up of the underlying incident re-registered the link twice while
 * documenting it.
 */

const KEYWORD = 'clo' + 'ses';

describe('parseDeclaredClosures', () => {
  it('reads a fenced declaration block', () => {
    const body = ['intro', '```closes', '#231', '#122', '```', 'outro'].join(
      '\n',
    );
    expect(parseDeclaredClosures(body)).toEqual({
      hasBlock: true,
      declared: [122, 231],
    });
  });

  it('distinguishes "declares nothing" from "declares an empty set"', () => {
    // Same list, different states. A PR with no block has not made an
    // assertion; a PR with an empty block has asserted that it closes nothing,
    // which is exactly what a precondition-verifier PR needs to say. Collapsing
    // them would make the fail-closed default unstatable.
    expect(parseDeclaredClosures('no block here')).toEqual({
      hasBlock: false,
      declared: [],
    });
    expect(parseDeclaredClosures('```closes\n```')).toEqual({
      hasBlock: true,
      declared: [],
    });
  });

  it('survives CRLF bodies', () => {
    // The GitHub API returns bodies with CRLF. A parser anchored on \n alone
    // reports "no block" for a body that plainly has one, and the failure names
    // the wrong subject -- the same defect already filed as #252 against a
    // sibling parser in this repository.
    const body = '```closes\r\n#231\r\n```\r\n';
    expect(parseDeclaredClosures(body)).toEqual({
      hasBlock: true,
      declared: [231],
    });
  });

  it('ignores prose that merely mentions a reference', () => {
    // The block is the only declaration site. Text outside it -- including the
    // sentence that arms the real closure -- must not be read as intent, or the
    // check would derive both sides of its comparison from the same string.
    const body = `This ${KEYWORD} #999 in prose.\n\n\`\`\`closes\n#231\n\`\`\``;
    expect(parseDeclaredClosures(body).declared).toEqual([231]);
  });

  it('refuses a block it cannot parse rather than reporting an empty set', () => {
    // A tolerant parser here is a silent downgrade to "declares nothing", which
    // is the fail-closed branch and looks like a deliberate declaration.
    expect(() => parseDeclaredClosures('```closes\ncloses #231\n```')).toThrow(
      /not a bare issue reference/,
    );
    expect(() => parseDeclaredClosures('```closes\n231\n```')).toThrow();
  });

  it('does not treat an ordinary fenced block as a declaration', () => {
    expect(parseDeclaredClosures('```\n#231\n```')).toEqual({
      hasBlock: false,
      declared: [],
    });
    expect(parseDeclaredClosures('```js\n#231\n```')).toEqual({
      hasBlock: false,
      declared: [],
    });
  });
});

describe('compareClosures', () => {
  it('passes when the sets agree, in either order', () => {
    expect(compareClosures([1, 2], [2, 1]).ok).toBe(true);
    expect(compareClosures([], []).ok).toBe(true);
  });

  it('fails on an armed closure that was never declared', () => {
    // This is the case the issue exists for: the PR closes something nobody
    // asked it to.
    const result = compareClosures([], [57]);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([57]);
    expect(result.missing).toEqual([]);
  });

  it('fails on a declaration that never armed', () => {
    const result = compareClosures([231], []);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([231]);
  });

  it('reports both directions at once rather than the first one found', () => {
    const result = compareClosures([231], [57]);
    expect(result.unexpected).toEqual([57]);
    expect(result.missing).toEqual([231]);
  });
});

describe('readSettled', () => {
  /** Deterministic clock: sleeping advances it, so no test waits in real time. */
  function fakeClock() {
    let t = 0;
    return {
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
    };
  }

  it('waits out a value that has not arrived yet', async () => {
    // Measured on a live PR: a read taken straight after an edit returns the
    // pre-edit value and takes roughly 38-45s to settle. The arming event this
    // check exists to catch IS an edit, so a single read is the one
    // implementation guaranteed to report the stale value.
    const readings = [[], [], [231], [231]];
    let index = 0;
    const result = await readSettled(() => readings[index++] as number[], {
      ...fakeClock(),
      delayMs: 20_000,
      minElapsedMs: 60_000,
    });
    expect(result.value).toEqual([231]);
    expect(result.settled).toBe(true);
  });

  it('would settle on the stale value without the wall-clock floor', async () => {
    // This is why the floor exists, and it is the assertion that makes the
    // previous one mean something. "Poll until the value stops changing" is the
    // obvious remedy and it is wrong: a value that has not arrived is perfectly
    // stable, so two agreeing reads settle on [] and report settled: true.
    //
    // Stability separates "changing" from "not changing". It cannot separate
    // "not yet" from "never" -- those are the same observation -- and it fails
    // in the direction of passing, since an empty set matches the common case
    // of a PR that declares no closures.
    const readings = [[], [], [231], [231]];
    let index = 0;
    const result = await readSettled(() => readings[index++] as number[], {
      ...fakeClock(),
      delayMs: 20_000,
      minElapsedMs: 0,
    });
    expect(result.value).toEqual([]);
    expect(result.settled).toBe(true);
  });

  it('reports settled: false rather than guessing when it runs out of reads', async () => {
    const result = await readSettled(() => [231], {
      ...fakeClock(),
      delayMs: 20_000,
      minElapsedMs: 60_000,
      maxReads: 2,
    });
    expect(result.settled).toBe(false);
  });

  it('treats order as insignificant', async () => {
    const readings = [
      [2, 1],
      [1, 2],
      [1, 2],
    ];
    let index = 0;
    const result = await readSettled(() => readings[index++] as number[], {
      ...fakeClock(),
      delayMs: 40_000,
      minElapsedMs: 40_000,
    });
    expect(result.settled).toBe(true);
    expect(result.value).toEqual([1, 2]);
  });
});

describe('formatFailure', () => {
  it('names the negation trap when a closure is armed but not declared', () => {
    const message = formatFailure({
      unexpected: [57],
      missing: [],
      hasBlock: true,
      prNumber: 209,
    });
    expect(message).toContain('#57');
    expect(message).toContain('does not read negation');
  });

  it('prints a declaration block a reader can paste', () => {
    // The remedy a guard prints has to be tested with the guard. A failure
    // message that instructs the reader to write something is a second
    // artifact, and an unexecuted one is where wrong advice survives.
    const message = formatFailure({
      unexpected: [57],
      missing: [],
      hasBlock: false,
      prNumber: 209,
    });
    expect(message).toContain('```closes');
    // And the suggestion must round-trip through the parser this check uses.
    const suggested = message
      .split('\n')
      .filter((line: string) => line.startsWith('      '))
      .map((line: string) => line.slice(6))
      .join('\n');
    expect(parseDeclaredClosures(suggested)).toEqual({
      hasBlock: true,
      declared: [123],
    });
  });
});

/**
 * Reviewer finding on #366: `main` destructured `settled`, printed it in the
 * summary, and never branched on it -- so a read that never stabilised passed
 * whenever its last value happened to match the declaration.
 *
 * Every other unit in the script was covered. The one that decides the exit
 * code was not, because `main` was the only export the test file did not
 * import. These specs exist as much to close that seam as to pin the branch.
 */
describe('main', () => {
  const BODY = ['```' + KEYWORD, '#231', '```'].join('\n');

  /** `gh` stub: body on the first call shape, closures on the other. */
  function ghStub(closures: number[]) {
    return (args: string[]) =>
      args.includes('body') ? BODY : JSON.stringify(closures);
  }

  function silenced() {
    return {
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('fails an unsettled read even when the value matches', async () => {
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231]),
      // Matches the declaration exactly. Under the previous implementation
      // this was the passing case, which is the defect: the value may still
      // be arriving, so the match is not evidence of anything.
      readClosures: async () => ({
        value: [231],
        reads: 20,
        settled: false,
        elapsedMs: 95000,
      }),
    });

    expect(result).toEqual({ ok: false, settled: false });
    expect(process.exitCode).toBe(1);
    const printed = spies.error.mock.calls.map((call) => call[0]).join('\n');
    // It must not be reported as a mismatch: the references may be correct.
    expect(printed).toContain('Could not read the closing references');
    expect(printed).not.toContain('do not match its declaration');
  });

  it('passes a settled read that matches', async () => {
    // CONTROL. Without it, the assertion above is satisfied by a `main` that
    // fails unconditionally, which would also "not pass an unsettled read".
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231]),
      readClosures: async () => ({
        value: [231],
        reads: 13,
        settled: true,
        elapsedMs: 61000,
      }),
    });

    expect(result).toEqual({ ok: true, settled: true });
    expect(process.exitCode).toBeUndefined();
    expect(spies.log.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'match the declaration',
    );
  });

  it('reports a settled mismatch as a mismatch, not as an unsettled read', async () => {
    // The other direction of the same discrimination: the two failures must
    // stay distinguishable, or consulting `settled` just moves the conflation
    // from the exit code into the message.
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231, 999]),
      readClosures: async () => ({
        value: [231, 999],
        reads: 13,
        settled: true,
        elapsedMs: 61000,
      }),
    });

    expect(result).toEqual({ ok: false, settled: true });
    expect(process.exitCode).toBe(1);
    const printed = spies.error.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('do not match its declaration');
    expect(printed).toContain('#999');
    expect(printed).not.toContain('Could not read the closing references');
  });

  it('does not report the last value as a result when unsettled', async () => {
    const message = formatUnsettled({
      prNumber: 366,
      reads: 20,
      elapsedMs: 95000,
      value: [231],
    });
    expect(message).toContain('It is not reported as a result');
    expect(message).toContain('reading too early');
  });
});
