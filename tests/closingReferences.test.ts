import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyClosingReferenceReadError,
  ClosingReferenceReadBudgetError,
  compareClosures,
  declarationFilePathForBranch,
  DECLARATION_FILE_PATH,
  formatFailure,
  formatUnsettled,
  main,
  parseBoundClosures,
  parseClosingReferenceResponse,
  parseCommitClosures,
  parseDeclaredClosures,
  parsePullRequestCommitResponse,
  PR_CLOSES_DIR,
  readDeclarationFile,
  readDeclarationForPullRequest,
  readPullRequestCommitClosures,
  readSettled,
  resolveDeclarationPath,
  resolveHeadBranchName,
  slugifyBranchName,
  toGitHubCliError,
  witnessContradiction,
  witnessUnreadableBinding,
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

const INCIDENT_0AB96610 = `docs(test): mark the two excused expansion cells provisional on #435

The matrix is eleven wide because #357 settled two vectors as
excused-and-enforced. The excuse is an absence — no decompressor and no
image decoder anywhere in the entry points' transitive import closure —
and #357 enforces it by walking that closure rather than by asserting a
comment.

#435 records that the walker keys on \`from '...'\` only, so a module
reached solely through \`await import('./x.js')\` is scanned by none of its
ban patterns. A closure gap disables every pattern at once, where a
pattern gap disables one.

Measured at this head rather than assumed: building the closure both ways
adds zero files and finds zero non-literal specifiers, so the excuse is
true and its enforcement is evadable. The exposure is prospective, not
live. That distinction is the whole content of the note, and it is the
part a reader would otherwise have to reconstruct.

Deliberately not repaired here. A one-issue change belongs in a one-issue
pull request, and the completeness test deliberately does not assert the
walker's shape — a tripwire on it would fail the very change that fixes
#435.

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
Copilot-Session: f4512f41-e807-4472-9d9d-baa2b1a45b98`;

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

describe('parseCommitClosures', () => {
  it('flags the exact 0ab96610 message whose keyword wraps onto the next line', () => {
    expect(parseCommitClosures([INCIDENT_0AB96610])).toEqual([435]);
  });

  it('reads every GitHub closing keyword form', () => {
    const keywords = [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ];
    expect(
      parseCommitClosures(
        keywords.map((keyword, index) => `${keyword} #${index + 1}`),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('flags negated prose because GitHub does not interpret the sentence', () => {
    expect(parseCommitClosures(['this must not close #57'])).toEqual([57]);
  });

  it('ignores a bare reference and a see reference without a keyword', () => {
    expect(parseCommitClosures(['Parent: #57', 'see #57 for context'])).toEqual(
      [],
    );
  });

  it('reads every paginated commit message and rejects malformed entries', () => {
    const response = JSON.stringify([
      [{ commit: { message: 'first page' } }],
      [{ commit: { message: 'second page' } }],
    ]);
    expect(parsePullRequestCommitResponse(response)).toEqual([
      'first page',
      'second page',
    ]);
    expect(() =>
      parsePullRequestCommitResponse(JSON.stringify([[{ commit: {} }]])),
    ).toThrow(/no message string/);
  });

  it('requests every commit page rather than only the first page', () => {
    const run = vi.fn(() =>
      JSON.stringify([
        [{ commit: { message: 'see #1' } }],
        [{ commit: { message: 'fixes\n#2' } }],
      ]),
    );
    expect(readPullRequestCommitClosures(418, run)).toEqual([2]);
    expect(run).toHaveBeenCalledWith([
      'api',
      '--paginate',
      '--slurp',
      'repos/{owner}/{repo}/pulls/418/commits?per_page=100',
    ]);
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
    const result = await readSettled(
      // Holds at the final value once the script is exhausted, because that
      // is what GitHub does: a settled field keeps returning the same answer.
      // A fixture that runs off its end instead throws deep inside the
      // function, which reads as a code fault rather than as "this scenario
      // needs more time than the budget allows" -- and that distinction is
      // the whole subject here.
      () => readings[Math.min(index++, readings.length - 1)] as number[],
      {
        ...fakeClock(),
        delayMs: 20_000,
        minElapsedMs: 60_000,
      },
    );
    expect(result.value).toEqual([231]);
    expect(result.settled).toBe(true);
    // It settled on the value that ARRIVED, having held still for the floor --
    // not merely because polling had been running that long.
    expect(result.stableMs).toBeGreaterThanOrEqual(60_000);
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

  it('requires the agreement and not only the floor', async () => {
    // The docblock claims BOTH a floor and agreement, and `requiredAgreements`
    // is a documented option. Every other fixture here lets the floor dominate
    // -- the second agreement always lands at or before it -- so the agreement
    // counter is never the binding constraint and could be dropped to 1 with
    // nothing noticing. Removing the floor makes agreement the only thing left
    // holding the guard up. The first reading never recurs: at 1 it settles on
    // that single read, at 2 it must wait for a value that repeats.
    // Deliberately does NOT pass `requiredAgreements`: the guard being pinned is
    // the DEFAULT, and a spec that supplies the value it means to test is immune
    // to a mutation of that default. (Measured -- the first version of this spec
    // passed `requiredAgreements: 2` and the 2 -> 1 mutant survived it.)
    const readings = [[231], [999], [999]];
    let index = 0;
    const result = await readSettled(() => readings[index++] as number[], {
      ...fakeClock(),
      delayMs: 20_000,
      minElapsedMs: 0,
    });
    expect(result.value).toEqual([999]);
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

describe('readSettled failure classification', () => {
  function clock() {
    let t = 0;
    return {
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
    };
  }

  function ghFailure(stderr: string, code?: string) {
    return toGitHubCliError(
      ['pr', 'view', '530', '--json', 'body,closingIssuesReferences'],
      Object.assign(new Error('Command failed: gh'), {
        status: 1,
        stderr,
        ...(code === undefined ? {} : { code }),
      }),
    );
  }

  it('preserves structured execFileSync failure details', () => {
    const cause = Object.assign(new Error('Command failed: gh'), {
      status: 1,
      stderr: 'HTTP 401: Bad credentials\n',
      stdout: '',
      code: 'EACCES',
    });
    const error = toGitHubCliError(['pr', 'view', '530'], cause);

    expect(error).toMatchObject({
      status: 1,
      stderr: 'HTTP 401: Bad credentials',
      stdout: '',
      code: 'EACCES',
    });
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('HTTP 401: Bad credentials');
  });

  it('settles the stable no-error control at the normal call count', async () => {
    const fake = clock();
    let calls = 0;
    const result = await readSettled(() => {
      calls += 1;
      return [231];
    }, fake);

    expect(result).toMatchObject({
      reads: 13,
      settled: true,
      stableMs: 60_000,
      retryableFailures: 0,
    });
    expect(calls).toBe(13);
  });

  it('distinguishes an absent sample from a successful empty result', async () => {
    const cleanClock = clock();
    let cleanCalls = 0;
    const clean = await readSettled(
      () => {
        cleanCalls += 1;
        return [];
      },
      { ...cleanClock, maxReads: 2, minElapsedMs: 0 },
    );

    expect(clean).toMatchObject({
      value: [],
      reads: 2,
      settled: true,
      retryableFailures: 0,
    });
    expect(cleanCalls).toBe(2);

    const failedClock = clock();
    const failure = ghFailure('connect ETIMEDOUT', 'ETIMEDOUT');
    let failedCalls = 0;
    const recovered = await readSettled(
      () => {
        failedCalls += 1;
        if (failedCalls === 1) {
          throw failure;
        }
        return [];
      },
      { ...failedClock, maxReads: 3, minElapsedMs: 0 },
    );

    // The failed first call supplied no value. Treating it as [] would settle
    // on call two, exactly like the clean control, and erase the distinction
    // between "GitHub returned no references" and "GitHub returned nothing."
    expect(recovered).toMatchObject({
      value: [],
      reads: 3,
      settled: true,
      retryableFailures: 1,
    });
    expect(failedCalls).toBe(3);
  });

  it('aborts a terminal credential failure on its first call', async () => {
    const fake = clock();
    const failure = ghFailure('HTTP 401: Bad credentials');
    let calls = 0;

    expect(classifyClosingReferenceReadError(failure)).toMatchObject({
      disposition: 'abort',
      reason: 'authentication',
    });
    await expect(
      readSettled(() => {
        calls += 1;
        throw failure;
      }, fake),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(fake.now()).toBe(0);
  });

  it('retries an explicit rate limit but aborts an ordinary permission failure', () => {
    const rateLimit = ghFailure('HTTP 403: API rate limit exceeded');
    const permission = ghFailure(
      'HTTP 403: Resource not accessible by integration',
    );

    expect(classifyClosingReferenceReadError(rateLimit)).toMatchObject({
      disposition: 'retry',
      reason: 'rate-limit',
    });
    expect(classifyClosingReferenceReadError(permission)).toMatchObject({
      disposition: 'abort',
      reason: 'terminal-gh',
    });
  });

  it('retries an early transient server failure and restarts continuity', async () => {
    const fake = clock();
    const failure = ghFailure('HTTP 502: Bad Gateway');
    let calls = 0;
    const result = await readSettled(() => {
      calls += 1;
      if (calls === 3) {
        throw failure;
      }
      return [231];
    }, fake);

    expect(classifyClosingReferenceReadError(failure)).toMatchObject({
      disposition: 'retry',
      reason: 'server',
    });
    expect(result).toMatchObject({
      reads: 16,
      settled: true,
      stableMs: 60_000,
      retryableFailures: 1,
    });
    expect(calls).toBe(16);
  });

  it('reaches and recovers from a transient failure just before normal settling', async () => {
    const fake = clock();
    const failure = ghFailure('connect ETIMEDOUT', 'ETIMEDOUT');
    let calls = 0;
    const result = await readSettled(() => {
      calls += 1;
      if (calls === 12) {
        throw failure;
      }
      return [231];
    }, fake);

    expect(classifyClosingReferenceReadError(failure)).toMatchObject({
      disposition: 'retry',
      reason: 'transport',
    });
    // The no-error control settles on call 13. A failed call 12 is therefore
    // reached, and resetting the agreement run makes call 25 the first honest
    // settle point: 60 seconds after the next successful sample.
    expect(result).toMatchObject({
      reads: 25,
      settled: true,
      stableMs: 60_000,
      retryableFailures: 1,
    });
    expect(calls).toBe(25);
  });

  it('fails with actionable diagnostics when transient failures exhaust the budget', async () => {
    const fake = clock();
    const failure = ghFailure('connect ETIMEDOUT', 'ETIMEDOUT');
    let calls = 0;
    let caught: unknown;

    try {
      await readSettled(
        () => {
          calls += 1;
          throw failure;
        },
        { ...fake, maxReads: 4 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClosingReferenceReadBudgetError);
    if (!(caught instanceof ClosingReferenceReadBudgetError)) {
      throw new Error('expected the retry budget error');
    }
    expect(caught).toMatchObject({
      attempts: 4,
      successfulReads: 0,
      retryableFailures: 4,
      elapsedMs: 15_000,
      cause: failure,
    });
    expect(caught.message).toContain('4 attempts');
    expect(caught.message).toContain('4 retryable failures');
    expect(caught.message).toContain('ETIMEDOUT');
    expect(caught.message).toContain('No read succeeded');
    expect(caught.message).not.toContain('Last successful value');
    expect(caught.message).toContain('Re-run');
    expect(calls).toBe(4);
  });

  it('reports post-recovery value churn as unsettled, not as a transport failure', async () => {
    const fake = clock();
    const failure = ghFailure('connect ETIMEDOUT', 'ETIMEDOUT');
    let calls = 0;
    const result = await readSettled(
      () => {
        calls += 1;
        if (calls === 2) {
          throw failure;
        }
        return [calls % 2];
      },
      { ...fake, maxReads: 6, minElapsedMs: 0 },
    );

    expect(result).toMatchObject({
      reads: 6,
      settled: false,
      retryableFailures: 1,
    });
    expect(calls).toBe(6);
    const message = formatUnsettled({
      prNumber: 530,
      reads: result.reads,
      elapsedMs: result.elapsedMs,
      value: result.value,
      retryableFailures: result.retryableFailures,
    });
    expect(message).toContain('1 attempt failed');
    expect(message).toContain('reset the stability interval');
    expect(message).not.toContain('retry budget exhausted');
  });

  it('classifies a truncated API response explicitly and retries it', async () => {
    const fake = clock();
    let classification: ReturnType<
      typeof classifyClosingReferenceReadError
    > | null = null;
    try {
      parseClosingReferenceResponse('{"body":"","refs":[');
    } catch (error) {
      classification = classifyClosingReferenceReadError(error);
    }
    expect(classification).toMatchObject({
      disposition: 'retry',
      reason: 'malformed-response',
    });

    let calls = 0;
    const result = await readSettled(
      () => {
        calls += 1;
        const raw =
          calls === 1 ? '{"body":"","refs":[' : '{"body":"","refs":[231]}';
        return parseClosingReferenceResponse(raw).refs;
      },
      {
        ...fake,
        maxReads: 3,
        minElapsedMs: 0,
      },
    );

    expect(result).toMatchObject({
      reads: 3,
      settled: true,
      retryableFailures: 1,
    });
    expect(calls).toBe(3);
  });

  it('aborts a valid response with the wrong schema instead of retrying drift', async () => {
    const fake = clock();
    let failure: unknown;
    try {
      parseClosingReferenceResponse('{"body":"","refs":"not-an-array"}');
    } catch (error) {
      failure = error;
    }

    expect(classifyClosingReferenceReadError(failure)).toMatchObject({
      disposition: 'abort',
      reason: 'invalid-response-shape',
    });
    let calls = 0;
    await expect(
      readSettled(() => {
        calls += 1;
        throw failure;
      }, fake),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(fake.now()).toBe(0);
  });

  it('fails closed on an unknown error instead of treating SyntaxError as transient', async () => {
    const fake = clock();
    const failure = new SyntaxError('bug outside the response parser');
    let calls = 0;

    expect(classifyClosingReferenceReadError(failure)).toMatchObject({
      disposition: 'abort',
      reason: 'unknown',
    });
    await expect(
      readSettled(() => {
        calls += 1;
        throw failure;
      }, fake),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(fake.now()).toBe(0);
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

  it('names past-tense narration as another way to arm a closure', () => {
    const message = formatFailure({
      unexpected: [121],
      missing: [],
      hasBlock: true,
      prNumber: 328,
    });
    expect(message).toContain('#121');
    expect(message).toMatch(/narrat(?:e|ing).*another PR closed/i);
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
describe('readDeclarationFile', () => {
  it('reads the declaration from a tracked file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'closing-decl-'));
    const filePath = path.join(directory, 'PR_CLOSES.md');
    writeFileSync(filePath, ['```closes', '#415', '```'].join('\n'));
    try {
      expect(readDeclarationFile(filePath)).toBe(
        ['```closes', '#415', '```'].join('\n'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a missing file as "declares nothing", not as an error', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'closing-decl-'));
    const filePath = path.join(directory, 'does-not-exist.md');
    try {
      expect(readDeclarationFile(filePath)).toBe('');
      expect(parseDeclaredClosures(readDeclarationFile(filePath))).toEqual({
        hasBlock: false,
        declared: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not swallow an unreadable path that is not simply absent', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'closing-decl-'));
    try {
      // A directory at the declaration path is not ENOENT -- it is a distinct
      // failure this must not report identically to "no declaration".
      expect(() => readDeclarationFile(directory)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('defaults to DECLARATION_FILE_PATH, tracked in the commit tree', () => {
    expect(DECLARATION_FILE_PATH).toBe('.github/PR_CLOSES.md');
  });
});

/**
 * #622. Concurrent PRs conflicted because `DECLARATION_FILE_PATH` was one
 * shared slot every PR edited. These specs pin the per-PR replacement: a
 * branch-keyed path, a migration fallback to the legacy file, and the
 * branch-name resolution that avoids a network call in the common case.
 */
describe('per-PR declaration files (#622)', () => {
  it('slugifies a branch name into a safe, lowercase, hyphenated path segment', () => {
    expect(slugifyBranchName('dev/jpapiez/squad-622-per-pr-closes')).toBe(
      'dev-jpapiez-squad-622-per-pr-closes',
    );
    expect(slugifyBranchName('Feature/Foo_Bar.Baz')).toBe(
      'feature-foo-bar-baz',
    );
    expect(slugifyBranchName('--weird//branch--')).toBe('weird-branch');
  });

  it('rejects a branch name with nothing usable in a file name', () => {
    expect(() => slugifyBranchName('')).toThrow();
    expect(() => slugifyBranchName('///')).toThrow();
  });

  it('builds the per-PR declaration path under PR_CLOSES_DIR', () => {
    expect(declarationFilePathForBranch('dev/jpapiez/squad-622')).toBe(
      `${PR_CLOSES_DIR}/dev-jpapiez-squad-622.md`,
    );
  });

  it('resolves the head branch from GITHUB_HEAD_REF without calling run', () => {
    const run = vi.fn();
    const branch = resolveHeadBranchName('123', {
      run,
      environment: { GITHUB_HEAD_REF: 'dev/someone/thing' },
    });
    expect(branch).toBe('dev/someone/thing');
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back to gh pr view when GITHUB_HEAD_REF is unset (merge_group)', () => {
    const run = vi.fn().mockReturnValue('dev/someone/thing');
    const branch = resolveHeadBranchName('123', { run, environment: {} });
    expect(branch).toBe('dev/someone/thing');
    expect(run).toHaveBeenCalledWith([
      'pr',
      'view',
      '123',
      '--json',
      'headRefName',
      '--jq',
      '.headRefName',
    ]);
  });

  it('resolves the declaration path for a PR from its head branch', () => {
    const run = vi.fn();
    const resolved = resolveDeclarationPath('123', {
      run,
      environment: { GITHUB_HEAD_REF: 'dev/jpapiez/squad-622' },
    });
    expect(resolved).toBe(`${PR_CLOSES_DIR}/dev-jpapiez-squad-622.md`);
  });

  describe('readDeclarationForPullRequest', () => {
    let directory: string;
    let originalCwd: string;

    beforeEach(() => {
      directory = mkdtempSync(path.join(tmpdir(), 'closing-decl-repo-'));
      originalCwd = process.cwd();
      process.chdir(directory);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(directory, { recursive: true, force: true });
    });

    it("reads a PR's own file when one exists, in preference to the legacy file", () => {
      mkdirSync(PR_CLOSES_DIR, { recursive: true });
      writeFileSync(
        declarationFilePathForBranch('dev/jpapiez/squad-622'),
        ['```closes', '#622', '```'].join('\n'),
      );
      writeFileSync(
        DECLARATION_FILE_PATH,
        ['```closes', '#464', '```'].join('\n'),
      );

      const content = readDeclarationForPullRequest('1', {
        run: vi.fn(),
        environment: { GITHUB_HEAD_REF: 'dev/jpapiez/squad-622' },
      });
      expect(parseDeclaredClosures(content)).toEqual({
        hasBlock: true,
        declared: [622],
      });
    });

    it('falls back to the legacy shared file when the PR has no file of its own', () => {
      mkdirSync(path.dirname(DECLARATION_FILE_PATH), { recursive: true });
      writeFileSync(
        DECLARATION_FILE_PATH,
        ['```closes', '#464', '```'].join('\n'),
      );

      const content = readDeclarationForPullRequest('1', {
        run: vi.fn(),
        environment: { GITHUB_HEAD_REF: 'dev/unmigrated/branch' },
      });
      expect(parseDeclaredClosures(content)).toEqual({
        hasBlock: true,
        declared: [464],
      });
    });

    it('treats an explicit empty per-PR block as "closes nothing", not a fallback', () => {
      mkdirSync(PR_CLOSES_DIR, { recursive: true });
      writeFileSync(
        declarationFilePathForBranch('dev/jpapiez/squad-622'),
        ['```closes', '```'].join('\n'),
      );
      writeFileSync(
        DECLARATION_FILE_PATH,
        ['```closes', '#464', '```'].join('\n'),
      );

      const content = readDeclarationForPullRequest('1', {
        run: vi.fn(),
        environment: { GITHUB_HEAD_REF: 'dev/jpapiez/squad-622' },
      });
      expect(parseDeclaredClosures(content)).toEqual({
        hasBlock: true,
        declared: [],
      });
    });

    it('declares nothing when neither the per-PR nor the legacy file exists', () => {
      const content = readDeclarationForPullRequest('1', {
        run: vi.fn(),
        environment: { GITHUB_HEAD_REF: 'dev/brand-new/branch' },
      });
      expect(parseDeclaredClosures(content)).toEqual({
        hasBlock: false,
        declared: [],
      });
    });
  });
});

/**
 * #415's own acceptance criteria: the declaration must be pinned to the head
 * commit, not the PR body, so these exercise `main` with the two inputs moved
 * independently of one another -- exactly what a body edit with no new
 * commit, and a commit that edits the declaration, each do in practice.
 */
describe('main: declaration is pinned to the commit tree, not the PR body', () => {
  const DECLARATION = ['```closes', '#415', '```'].join('\n');

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

  function ghStub(witnessBody: string, refs: number[]) {
    return (args: string[]) => {
      if (args[0] === 'api') {
        return JSON.stringify([[]]);
      }
      return JSON.stringify({ body: witnessBody, refs });
    };
  }

  async function run(witnessBody: string, refs: number[]) {
    return main(['415'], {
      run: ghStub(witnessBody, refs),
      readDeclaration: () => DECLARATION,
      readClosures: async (read) => ({
        value: await read(),
        reads: 13,
        settled: true,
        elapsedMs: 60000,
        stableMs: 60000,
      }),
    });
  }

  it('is unchanged by a PR-body edit that leaves the head SHA untouched', async () => {
    // The head commit -- and so the declaration -- has not moved between
    // these two calls. Only the body (read here purely for the arming half)
    // differs, the shape of an `edited` event with no new commit.
    silenced();
    const before = await run('closes #415', [415]);
    const after = await run(
      'a completely rewritten body, still closes #415',
      [415],
    );

    expect(before).toEqual({ ok: true, settled: true, stale: false });
    expect(after).toEqual({ ok: true, settled: true, stale: false });
    expect(after).toEqual(before);
  });

  it('changes when the in-commit declaration changes, so the previous test cannot pass vacuously', async () => {
    silenced();
    const declaresNothing = await main(['415'], {
      run: ghStub('closes #415', [415]),
      readDeclaration: () => ['```closes', '```'].join('\n'),
      readClosures: async (read) => ({
        value: await read(),
        reads: 13,
        settled: true,
        elapsedMs: 60000,
        stableMs: 60000,
      }),
    });

    // Same body, same armed set as the passing case above -- only the
    // committed declaration differs, and the verdict flips with it.
    expect(declaresNothing).toEqual({ ok: false, settled: true, stale: false });
    expect(process.exitCode).toBe(1);
  });

  it('still fails an armed reference with no matching in-commit declaration, with the existing message', async () => {
    const spies = silenced();
    const result = await main(['415'], {
      run: ghStub('closes #415', [415]),
      readDeclaration: () => '',
      readClosures: async (read) => ({
        value: await read(),
        reads: 13,
        settled: true,
        elapsedMs: 60000,
        stableMs: 60000,
      }),
    });

    expect(result).toEqual({ ok: false, settled: true, stale: false });
    expect(process.exitCode).toBe(1);
    const printed = spies.error.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(printed).toContain('do not match its declaration');
    expect(printed).toContain('ARMED BUT NOT DECLARED');
    expect(printed).toContain('#415');
    expect(printed).toContain(DECLARATION_FILE_PATH);
  });
});

describe('main', () => {
  const BODY = ['```' + KEYWORD, '#231', '```'].join('\n');

  /** `gh` stub: body on the first call shape, closures on the other. */
  function ghStub(
    closures: number[],
    witnessBody: string = BODY,
    commitMessages: string[] = [],
  ) {
    return (args: string[]) => {
      if (args[0] === 'api') {
        return JSON.stringify([
          commitMessages.map((message) => ({ commit: { message } })),
        ]);
      }
      // The witness read asks for both fields at once. Checked before the
      // bare-`body` shape because the combined selector is a single argument
      // and would not match it.
      if (args.includes('body,closingIssuesReferences')) {
        return JSON.stringify({ body: witnessBody, refs: closures });
      }
      return args.includes('body') ? BODY : JSON.stringify(closures);
    };
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
      readDeclaration: () => BODY,
      // Matches the declaration exactly. Under the previous implementation
      // this was the passing case, which is the defect: the value may still
      // be arriving, so the match is not evidence of anything.
      readClosures: () =>
        Promise.resolve({
          value: [231],
          reads: 20,
          settled: false,
          elapsedMs: 95000,
        }),
    });

    expect(result).toEqual({ ok: false, settled: false, stale: false });
    expect(process.exitCode).toBe(1);
    const printed = spies.error.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    // It must not be reported as a mismatch: the references may be correct.
    expect(printed).toContain('Could not read the closing references');
    expect(printed).not.toContain('do not match its declaration');
  });

  it('preserves body scanning when no commit message arms a closure', async () => {
    // CONTROL. Without it, the assertion above is satisfied by a `main` that
    // fails unconditionally, which would also "not pass an unsettled read".
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231]),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [231],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    });

    expect(result).toEqual({ ok: true, settled: true, stale: false });
    expect(process.exitCode).toBeUndefined();
    expect(
      spies.log.mock.calls.map((call) => String(call[0])).join('\n'),
    ).toContain('match the declaration');
  });

  it('fails when a commit closes an issue outside the declared scope', async () => {
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231], BODY, ['fixes #999']),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [231],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    });

    expect(result).toEqual({ ok: false, settled: true, stale: false });
    expect(process.exitCode).toBe(1);
    expect(
      spies.error.mock.calls.map((call) => String(call[0])).join('\n'),
    ).toContain('#999');
  });

  it('passes when a commit closes exactly the declared issue', async () => {
    silenced();
    const result = await main(['231'], {
      run: ghStub([], BODY, ['fixes\n#231']),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    });

    expect(result).toEqual({ ok: true, settled: true, stale: false });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a settled mismatch as a mismatch, not as an unsettled read', async () => {
    // The other direction of the same discrimination: the two failures must
    // stay distinguishable, or consulting `settled` just moves the conflation
    // from the exit code into the message.
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231, 999]),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [231, 999],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    });

    expect(result).toEqual({ ok: false, settled: true, stale: false });
    expect(process.exitCode).toBe(1);
    const printed = spies.error.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(printed).toContain('do not match its declaration');
    expect(printed).toContain('#999');
    expect(printed).not.toContain('Could not read the closing references');
  });

  it('does not report the last value as a result when unsettled', () => {
    const message = formatUnsettled({
      prNumber: 366,
      // The exhausted-budget figures, kept in step with the shipped defaults
      // so the fixture reads as a scenario that can actually occur.
      reads: 40,
      elapsedMs: 195000,
      value: [231],
    });
    expect(message).toContain('It is not reported as a result');
    expect(message).toContain('reading too early');
  });

  // #527: `main` writes `process.exitCode = 1` on every failure branch but
  // never clears it on success. The suite-wide `afterEach` above resets
  // `process.exitCode` between every `it()`, which means no cross-spec test
  // can ever observe that -- only a single spec calling `main` twice, inside
  // one `it()`, can. This is that spec.
  it('clears process.exitCode on a successful call that follows a failed one, within a single spec', async () => {
    const passingDeps = {
      run: ghStub([231]),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [231],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    };
    const failingDeps = {
      run: ghStub([231, 999]),
      readDeclaration: () => BODY,
      readClosures: () =>
        Promise.resolve({
          value: [231, 999],
          reads: 13,
          settled: true,
          elapsedMs: 61000,
        }),
    };

    // POSITIVE CONTROL, same block: the success arm alone, run first, must
    // leave `process.exitCode` clear. Without this arm a green result below
    // would be produced just as easily by a `main` whose success path never
    // actually ran (or that always leaves `exitCode` undefined regardless of
    // history) -- the control is what proves this spec can fail.
    silenced();
    const controlResult = await main(['231'], passingDeps);
    expect(controlResult).toEqual({ ok: true, settled: true, stale: false });
    expect(process.exitCode).toBeUndefined();

    // ARM 1: a failing call in the same process, matching the defect report.
    const spies = silenced();
    const failureResult = await main(['231'], failingDeps);
    expect(failureResult).toEqual({ ok: false, settled: true, stale: false });
    expect(process.exitCode).toBe(1);
    spies.error.mockRestore();
    spies.log.mockRestore();

    // SUBJECT: a successful call, in the SAME process, right after the
    // failure above. Before the fix this stayed `1`, reporting failure for a
    // run whose own result was `ok: true`.
    const subjectSpies = silenced();
    const successResult = await main(['231'], passingDeps);
    expect(successResult).toEqual({ ok: true, settled: true, stale: false });
    expect(process.exitCode).toBeUndefined();
    subjectSpies.error.mockRestore();
    subjectSpies.log.mockRestore();
  });
});

/**
 * The wall-clock floor is the load-bearing half of `readSettled`, and these
 * pin WHICH interval it measures. Anchored to the start of polling it answers
 * "have we been asking for a minute"; the claim being made is "has the value
 * held still for a minute". A run that churns and then agrees twice satisfies
 * the first and not the second, and it is the arrangement a slow, noisy field
 * produces naturally.
 */
describe('readSettled wall-clock floor', () => {
  /** Virtual clock: advances only on sleep, so elapsed figures are exact. */
  function clock() {
    let t = 0;
    return {
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
    };
  }

  it('refuses a value that agreed only briefly, however long polling ran', async () => {
    const { sleep, now } = clock();
    let i = 0;
    // Twelve different values, then agreement. Total elapsed clears 60s only
    // because of the churn -- the returned value is five seconds old.
    //
    // `maxReads` is pinned rather than left to the default on purpose. The
    // property under test is WHICH interval the floor measures, and the run
    // has to end while the agreement is still young for that to be visible.
    // Given enough reads this value does eventually hold still for a real
    // sixty seconds and settling becomes correct -- so a version of this spec
    // that relied on the default budget would pass today and go green the
    // moment the budget widened, which is exactly what happened to it once.
    const result = await readSettled(
      () => {
        i += 1;
        return i <= 12 ? [i] : [999];
      },
      { sleep, now, maxReads: 14 },
    );

    expect(result.settled).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(60000);
    expect(result.stableMs).toBeLessThan(60000);
  });

  it('can still settle a value that arrives as late as the measurement allows', async () => {
    const { sleep, now } = clock();
    // The budget and the floor are one design, not two knobs. With the floor
    // anchored to the agreement run, the defaults must cover worst measured
    // arrival (45s) PLUS the floor (60s). They did not when the floor was
    // first tightened: the earliest reachable settle became 98s against a 95s
    // budget, so this check would have reported unsettled on every pull
    // request that armed a closure, and gone red on all of them.
    //
    // Nothing else in this file fails when that happens, because every other
    // spec passes its own budget. This one runs on the shipped defaults on
    // purpose.
    const result = await readSettled(() => (now() < 45_000 ? [] : [231]), {
      sleep,
      now,
    });

    expect(result.settled).toBe(true);
    expect(result.value).toEqual([231]);
  });

  it('settles a value that has actually held still for the floor', async () => {
    const { sleep, now } = clock();
    const result = await readSettled(() => [231], { sleep, now });

    // The control for the spec above: same instrument, same floor, and the
    // only difference is that this value really did hold still. Without it,
    // "settled: false" above could just mean the function never settles.
    expect(result.settled).toBe(true);
    expect(result.value).toEqual([231]);
    expect(result.stableMs).toBeGreaterThanOrEqual(60000);
  });

  it('measures stability from the last change, not from the first read', async () => {
    const { sleep, now } = clock();
    let i = 0;
    const result = await readSettled(
      () => {
        i += 1;
        return i <= 2 ? [1] : [2];
      },
      { sleep, now },
    );

    // elapsedMs and stableMs are different quantities and a caller cannot
    // derive one from the other. The value changed once, ten seconds in.
    expect(result.value).toEqual([2]);
    expect(result.settled).toBe(true);
    expect(result.elapsedMs).toBeGreaterThan(result.stableMs);
    expect(result.elapsedMs - result.stableMs).toBe(10000);
  });
});

describe('parseBoundClosures', () => {
  it('finds a reference GitHub would bind', () => {
    expect(
      parseBoundClosures(`This ${KEYWORD} #231 and nothing else.`),
    ).toEqual([231]);
  });

  it('ignores the regions measured to be inert', () => {
    const body = [
      '```' + KEYWORD,
      '#111',
      '```',
      '',
      '```',
      `${KEYWORD} #222`,
      '```',
      '',
      `an inline \`${KEYWORD} #333\` span`,
      `<!-- ${KEYWORD} #444 -->`,
    ].join('\n');

    // All four suppressions were measured live on PR #352, not assumed. The
    // declaration block is inert for the same reason as any other fence,
    // which is the fact the whole declaration-site design rests on.
    expect(parseBoundClosures(body)).toEqual([]);
  });

  it('reads every documented keyword form', () => {
    const body = ['fixes #1', 'resolved #2', 'close #3'].join('\n\n');
    expect(parseBoundClosures(body)).toEqual([1, 2, 3]);
  });

  /**
   * #558. The separator is `[\s:]+`. Each accepted separator is pinned on its
   * own below, so narrowing the class back to either single alternative turns
   * exactly one of these red rather than leaving both green.
   */
  it('binds the whitespace separator', () => {
    // Fails if the class is narrowed to `:+`.
    expect(
      parseBoundClosures(`This ${KEYWORD} #472 and nothing else.`),
    ).toEqual([472]);
  });

  it('binds the colon separator, measured armed on PR #554', () => {
    // Fails if the class is narrowed back to `\s+`, which is the defect.
    // Measured: an ordinary prose phrase in this shape armed #436 across 13
    // guard reads, and removing it retracted the reference on read 1.
    const FIX = 'fi' + 'x';
    expect(parseBoundClosures(`regardless of that ${FIX}: #436`)).toEqual([
      436,
    ]);
    expect(parseBoundClosures(`${KEYWORD.replace('c', 'C')}: #472`)).toEqual([
      472,
    ]);
  });

  it('returns a non-empty result for a body that binds', () => {
    // Vacuity control. Every other assertion in this block but the two above
    // is satisfied by a function that returns [] unconditionally, so without
    // this one the suite could go green on a parser that reads nothing.
    expect(parseBoundClosures(`This ${KEYWORD} #231.`).length).toBeGreaterThan(
      0,
    );
  });

  it('does not bind a colon after a word that is not a closing keyword', () => {
    // The widening is to the separator only. A regex that matched everything
    // would pass the two separator tests above; these hold it to the keyword
    // list, and the inert-region and mention-only controls hold the rest.
    expect(parseBoundClosures('see: #436')).toEqual([]);
    expect(parseBoundClosures('affects: #436')).toEqual([]);
    expect(parseBoundClosures('unfixed: #436')).toEqual([]);
  });

  it('still ignores a bare mention', () => {
    expect(parseBoundClosures('see #436')).toEqual([]);
  });

  it('still ignores the inert regions when the colon form appears in them', () => {
    // The negative controls have to survive the widening in the widened form
    // too, not only in the shape they were written against.
    const FIX = 'fi' + 'x';
    const body = [
      '```',
      `${FIX}: #436`,
      '```',
      '',
      `an inline \`${FIX}: #472\` span`,
      `<!-- ${FIX}: #558 -->`,
    ].join('\n');
    expect(parseBoundClosures(body)).toEqual([]);
  });
});

describe('witnessContradiction', () => {
  it('reports a derived field its own source contradicts', () => {
    expect(witnessContradiction(`${KEYWORD} #231`, [])).toEqual([231]);
  });

  it('says nothing when the derived field is non-empty', () => {
    // Deliberately one-directional. Firing here would assert that
    // parseBoundClosures reproduces GitHub's grammar; it does not, and a
    // guard that claims someone else's parser goes stale toward the false
    // red. The measured counter-examples are in check-closing-references.mjs.
    //
    // The residual risk is NOT bounded to a retry, and an earlier version of
    // this comment claimed it was. That claim is retracted at the witness's
    // own docblock and refuted by an executable test below. Nothing is
    // retried when THIS direction is wrong: a stale non-empty snapshot taken
    // after an unintended closure was added is reported clean, and the
    // closure ships silently. A retry is what a false POSITIVE costs, and
    // this is the branch where the false NEGATIVE lives.
    //
    // That gap is no longer silent. `witnessUnreadableBinding` covers the
    // reachable half of it -- a non-empty field beside a body binding nothing
    // readable -- and `main` reports it. This function stays one-directional
    // because the OTHER half, where the two sets merely disagree on which
    // numbers, is the half that cannot be judged without claiming parity with
    // GitHub's grammar.
    expect(witnessContradiction('prose that binds nothing', [231])).toEqual([]);
    expect(witnessContradiction(`${KEYWORD} #999`, [231])).toEqual([]);
  });

  it('says nothing when the body genuinely closes nothing', () => {
    expect(witnessContradiction('a body that mentions #231 only', [])).toEqual(
      [],
    );
  });
});

describe('witnessUnreadableBinding', () => {
  it('reports a non-empty field beside a body that binds nothing readable', () => {
    expect(witnessUnreadableBinding('prose that binds nothing', [231])).toEqual(
      [231],
    );
  });

  it('says nothing when the body binds something this parser can read', () => {
    // The narrowing that keeps it usable. Once the parser sees ANY binding
    // construct, the question becomes which numbers are right, and answering
    // that asserts parity with GitHub's grammar.
    expect(witnessUnreadableBinding(`${KEYWORD} #999`, [231])).toEqual([]);
  });

  it('says nothing when the derived field is empty', () => {
    // That case belongs to witnessContradiction. Both firing on it would
    // report one condition twice and tell a reader nothing extra.
    expect(witnessUnreadableBinding('prose that binds nothing', [])).toEqual(
      [],
    );
  });

  it('reports the unreadable field in a stable order', () => {
    // Every other fixture in this block is single-element, so the sort is
    // unverified and could be removed without any of them noticing. The
    // equivalent sort in parseDeclaredClosures is covered by a two-element
    // fixture; this one was not.
    expect(
      witnessUnreadableBinding('prose that binds nothing', [999, 231]),
    ).toEqual([231, 999]);
  });

  it('fires on the binding forms this parser cannot read', () => {
    // Stated as a COST, not hidden. These are correct pull requests, and the
    // witness fires on every one of them -- which is precisely why it must
    // never move the exit code. The bare form is the positive control: it is
    // readable, so it must NOT fire, or the three arms below would pass for a
    // function that fires unconditionally.
    expect(witnessUnreadableBinding(`${KEYWORD} #123`, [123])).toEqual([]);
    for (const unreadable of [
      `${KEYWORD} OlyForge3D/PrintFarmerDesktop#123`,
      `${KEYWORD} GH-123`,
      `${KEYWORD} https://github.com/OlyForge3D/PrintFarmerDesktop/issues/123`,
    ]) {
      expect(witnessUnreadableBinding(unreadable, [123])).toEqual([123]);
    }
  });
});

/**
 * The composition. `main` is where the two reads meet, and the stale case is
 * invisible in either one alone: the derived field settles on [], which is
 * the correct answer for most pull requests, so it fails toward passing.
 */
describe('main staleness witness', () => {
  const PROSE = `This one ${KEYWORD} #231.`;

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

  /** Serves both call shapes; `witness` is the body the combined read returns. */
  function ghStub(declBody: string, witness: string, refs: number[]) {
    return (args: string[]) => {
      if (args[0] === 'api') {
        return '[[]]';
      }
      if (args.includes('body,closingIssuesReferences')) {
        return JSON.stringify({ body: witness, refs });
      }
      return args.includes('body') ? declBody : JSON.stringify(refs);
    };
  }

  it('passes the merge-queue PR number through to every gh read', async () => {
    silenced();
    const directory = mkdtempSync(path.join(tmpdir(), 'closing-reference-'));
    const eventPath = path.join(directory, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        merge_group: {
          head_ref:
            'refs/heads/gh-readonly-queue/development/pr-398-2426904fbd97',
        },
      }),
    );
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api') return '[[]]';
      return args.includes('body,closingIssuesReferences')
        ? JSON.stringify({ body: 'a bare mention of #398', refs: [] })
        : 'no declaration here';
    };

    try {
      const result = await main([], {
        environment: { GITHUB_EVENT_PATH: eventPath },
        run,
        readDeclaration: () => 'no declaration here',
        readClosures: async (read) => ({
          value: await read(),
          reads: 2,
          settled: true,
          elapsedMs: 1000,
          stableMs: 1000,
        }),
      });
      expect(result).toMatchObject({ ok: true, settled: true });
      const prCalls = calls.filter((args) => args[0] === 'pr');
      // Declaration reading (#415) no longer goes through `gh`, so there is
      // exactly one `pr` call left -- the combined-field witness read -- and
      // it must still carry the resolved merge-queue PR number.
      expect(prCalls.length).toBeGreaterThan(0);
      expect(prCalls.map((args) => args.slice(0, 3))).toEqual(
        prCalls.map(() => ['pr', 'view', '398']),
      );
      expect(calls.find((args) => args[0] === 'api')?.at(-1)).toContain(
        '/pulls/398/commits',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports, but does not fail, a settled empty read the body contradicts', async () => {
    const spies = silenced();
    // Declares nothing and arms nothing: on the settled value alone this is a
    // clean pass, and that is exactly the shape a stale read takes.
    const result = await main(['231'], {
      run: ghStub('no declaration here', PROSE, []),
      readDeclaration: () => 'no declaration here',
      readClosures: async (read) => {
        await read();
        return {
          value: [],
          reads: 13,
          settled: true,
          elapsedMs: 60000,
          stableMs: 60000,
        };
      },
    });

    // The witness is observable in the result and in the output, and changes
    // no verdict. It fires identically on a stale field and on a body that
    // closes a PR number, a nonexistent issue, or a `~~~` fence -- and it
    // cannot tell those apart, so the exit code must not depend on it.
    expect(result).toEqual({ ok: true, settled: true, stale: true });
    expect(process.exitCode).toBeUndefined();
    const printed = spies.error.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(printed).toContain('#231');
    // It must not read as an authoring mistake. Nothing is known to be wrong.
    expect(printed).not.toContain('do not match its declaration');
  });

  it('keeps the witness on the unsettled path, where certainty is lowest', async () => {
    silenced();
    // The unsettled early return is taken BEFORE both note branches, so on this
    // one path suspicion is carried only by the returned field -- nothing is
    // printed. Without this spec `stale: suspect` can be replaced by
    // `stale: false` and all the others still pass. `false` here would not mean
    // "fresh" or "not suspected", it would mean "unchecked", and asserting
    // freshness the check has not established is the exact overclaim this
    // module exists to refuse.
    const result = await main(['231'], {
      run: ghStub('no declaration here', PROSE, []),
      readDeclaration: () => 'no declaration here',
      readClosures: async (read) => {
        await read();
        return {
          value: [],
          reads: 13,
          settled: false,
          elapsedMs: 60000,
          stableMs: 0,
        };
      },
    });

    expect(result).toEqual({ ok: false, settled: false, stale: true });
    // Unsettled is fatal on its own; the witness must not be what decides that.
    expect(process.exitCode).toBe(1);
  });

  it('does not fail again on a re-run, because the body cannot change it', async () => {
    // The bound the previous design claimed -- "the cost of being wrong is
    // bounded to a retry" -- was false: the input is the PR body, so the
    // verdict is deterministic and a retry reproduces it exactly. This is
    // that claim as a test. Two identical runs, both green.
    const attempt = async () => {
      const spies = silenced();
      const result = await main(['231'], {
        run: ghStub('no declaration here', PROSE, []),
        readDeclaration: () => 'no declaration here',
        readClosures: async (read) => {
          await read();
          return {
            value: [],
            reads: 13,
            settled: true,
            elapsedMs: 60000,
            stableMs: 60000,
          };
        },
      });
      spies.error.mockRestore?.();
      return { result, exitCode: process.exitCode };
    };

    // Assert the CONTENT of each run, not merely that the two agree with each
    // other. `attempt` closes over nothing but literals and pure stubs, so
    // comparing the two attempts holds for EVERY possible implementation --
    // including one that fails unconditionally, whose arms would simply be
    // equally failed and still equal. The determinism claim needs a fixed
    // point to bite on, or it is an assertion that cannot fail.
    const expected = {
      result: { ok: true, settled: true, stale: true },
      exitCode: undefined,
    };
    expect(await attempt()).toEqual(expected);
    expect(await attempt()).toEqual(expected);
    expect(process.exitCode).toBeUndefined();
  });

  it('passes the same settled empty read when the body really closes nothing', async () => {
    const spies = silenced();
    // The control. Identical in every respect the check can see except the
    // one the witness reads, so a pass here is attributable to the witness
    // and not to the scenario being easy.
    const result = await main(['231'], {
      run: ghStub(
        'no declaration here',
        'a body that merely mentions #231',
        [],
      ),
      readDeclaration: () => 'no declaration here',
      readClosures: async (read) => {
        await read();
        return {
          value: [],
          reads: 13,
          settled: true,
          elapsedMs: 60000,
          stableMs: 60000,
        };
      },
    });

    expect(result).toEqual({ ok: true, settled: true, stale: false });
    expect(process.exitCode).toBeUndefined();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('reports a stale non-empty field that matches an inert declaration', async () => {
    // The reachable false pass, with its own control. The body still DECLARES
    // #231 while its prose no longer binds it -- the shape left behind when a
    // closing reference is removed from a body and the declaration block is
    // not removed with it.
    const BODY = [
      'This PR does some work.',
      'The prose no longer binds any closing reference.',
      '',
      '```' + KEYWORD,
      '#231',
      '```',
    ].join('\n');

    const arm = async (refs: number[]) => {
      const spies = silenced();
      const result = await main(['231'], {
        run: ghStub(BODY, BODY, refs),
        readDeclaration: () => BODY,
        readClosures: async (read) => {
          await read();
          return {
            value: refs,
            reads: 13,
            settled: true,
            elapsedMs: 60000,
            stableMs: 60000,
          };
        },
      });
      const printed = spies.error.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      const exitCode = process.exitCode;
      vi.restoreAllMocks();
      process.exitCode = undefined;
      return { result, printed, exitCode };
    };

    const stale = await arm([231]);
    const fresh = await arm([]);

    // Observable in the result and in the output, and it changes NO verdict.
    // The exit code must not move: this fires on every pull request that binds
    // through a cross-repository reference, a GH-123 form, or an issue URL,
    // and failing on those would be a red no author could clear.
    expect(stale.result).toEqual({ ok: true, settled: true, stale: true });
    expect(stale.exitCode).toBeUndefined();
    expect(stale.printed).toContain('binds');
    expect(stale.printed).toContain('#231');
    expect(stale.printed).not.toContain('do not match its declaration');

    // THE CONTROL, and it is what makes the arm above attributable. The same
    // declaration and the same body fail the moment the read is fresh, so the
    // pass is caused by the stale field rather than by a fixture that cannot
    // fail. Without this arm both results are one observation.
    expect(fresh.result).toEqual({ ok: false, settled: true, stale: false });
    expect(fresh.exitCode).toBe(1);
  });

  it('does not let the witness override a real declaration mismatch', async () => {
    const spies = silenced();
    const declared = ['```' + KEYWORD, '#231', '```'].join('\n');
    const result = await main(['231'], {
      run: ghStub(declared, 'body closing nothing in prose', []),
      readDeclaration: () => declared,
      readClosures: async (read) => {
        await read();
        return {
          value: [],
          reads: 13,
          settled: true,
          elapsedMs: 60000,
          stableMs: 60000,
        };
      },
    });

    // Declared #231, armed nothing, and the body does not contradict the read.
    // That is a genuine finding and must still be reported as one.
    expect(result).toEqual({ ok: false, settled: true, stale: false });
    const printed = spies.error.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(printed).toContain('do not match its declaration');
    expect(printed).not.toContain('the derived field settled on');
  });
});
