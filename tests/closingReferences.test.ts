import { describe, expect, it } from 'vitest';
import {
  CLOSING_KEYWORDS,
  compareClosures,
  compareCommitClosures,
  formatCommitFailure,
  formatFailure,
  parseCommitClosures,
  parseDeclaredClosures,
  readSettled,
  scanCommitMessages,
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

/**
 * #513. The block above verifies the pull request BODY. Commit messages close
 * issues too, and that surface was unscanned -- proven by commit 0ab96610,
 * which closed #435 while the "PR closure scope" check was green.
 *
 * The fixture below is that commit's real message. Its keyword is split across
 * a newline by ordinary paragraph wrapping, which is the whole reason these
 * tests exist: a line-wise scanner passes every plausible hand-written case and
 * misses the only real one.
 */
const WRAPPED_COMMIT_MESSAGE = [
  'docs(test): mark the two excused expansion cells provisional on #435',
  '',
  'Deliberately not repaired here. A one-issue change belongs in a one-issue',
  'pull request, and the completeness test deliberately does not assert the',
  "walker's shape — a tripwire on it would fail the very change that fixes",
  '#435.',
].join('\n');

/**
 * The keyword list stated independently of the source. Deliberately NOT
 * imported: see the per-keyword test below for the measurement that forced it.
 */
const EXPECTED_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
] as const;

describe('parseCommitClosures', () => {
  it('flags the real wrapped message of 0ab96610', () => {
    // Criterion 2, and the one assertion in this file that pins a real event.
    // A future refactor to line-wise scanning goes red here rather than at a
    // release gate.
    expect(parseCommitClosures(WRAPPED_COMMIT_MESSAGE)).toEqual([
      { keyword: 'fixes', issue: 435 },
    ]);
  });

  it('would find nothing if scanned line by line', () => {
    // The positive control for the control. Without this, the test above is
    // just "the parser works" and gives no reason for the whole-string scan --
    // and the next person to simplify it has no evidence they broke anything.
    const perLine = WRAPPED_COMMIT_MESSAGE.split('\n').flatMap((line) =>
      parseCommitClosures(line),
    );
    expect(perLine).toEqual([]);
    expect(parseCommitClosures(WRAPPED_COMMIT_MESSAGE)).toHaveLength(1);
  });

  it('flags a plain single-line reference', () => {
    expect(parseCommitClosures(`${KEYWORD} #57`)).toEqual([
      { keyword: 'closes', issue: 57 },
    ]);
  });

  it('flags negated prose, because the parser does not read sentences', () => {
    // Criterion 4. This looks like a false positive and is not: GitHub arms the
    // closure here. A scanner that tried to infer intent would disagree with
    // the thing it is modelling, and would do so in the passing direction.
    expect(parseCommitClosures(`this must not ${KEYWORD} #57`)).toEqual([
      { keyword: 'closes', issue: 57 },
    ]);
  });

  it('does not fire on a bare reference or on a non-keyword verb', () => {
    // Criterion 5. Both are how an author legitimately mentions an issue, so a
    // check that flagged them would be routed around within a day.
    expect(parseCommitClosures('follow-up to #57')).toEqual([]);
    expect(parseCommitClosures('see #57')).toEqual([]);
    expect(parseCommitClosures('#57')).toEqual([]);
  });

  it('does not fire on a keyword embedded in a longer word', () => {
    expect(parseCommitClosures('the enclosure #57 was measured')).toEqual([]);
    expect(parseCommitClosures('prefixes #57 are not keywords')).toEqual([]);
  });

  it.each([...EXPECTED_KEYWORDS])('honours the keyword %s', (keyword) => {
    // Criterion 6. One test per keyword, driven from EXPECTED_KEYWORDS rather
    // than from CLOSING_KEYWORDS, and that is the whole point.
    //
    // Written the obvious way -- `it.each([...CLOSING_KEYWORDS])` -- this
    // block draws its cases from the thing it is testing, so deleting an entry
    // deletes the test that would have caught it. Measured: dropping
    // 'resolves' from the source went from 38 passed to 37 passed, ZERO
    // failed. A control drawn from its own subject cannot detect the subject
    // shrinking; it reports a smaller green.
    expect(parseCommitClosures(`${keyword} #57`)).toEqual([
      { keyword, issue: 57 },
    ]);
  });

  it('honours exactly the keywords GitHub does, no more and no fewer', () => {
    // The second half of the fix above. The per-keyword tests prove each listed
    // word works; this proves the list itself has not been edited. Without it,
    // an ADDED keyword would go untested and a REMOVED one is caught only here.
    expect([...CLOSING_KEYWORDS].sort()).toEqual([...EXPECTED_KEYWORDS].sort());
  });

  it('is case insensitive, as GitHub is', () => {
    expect(parseCommitClosures('CLOSES #57')).toEqual([
      { keyword: 'closes', issue: 57 },
    ]);
  });

  it('survives CRLF messages', () => {
    expect(parseCommitClosures(`that ${KEYWORD}\r\n#57`)).toEqual([
      { keyword: 'closes', issue: 57 },
    ]);
  });

  it('does not read a longer number as the reference', () => {
    expect(parseCommitClosures(`${KEYWORD} #5712`)).toEqual([
      { keyword: 'closes', issue: 5712 },
    ]);
  });
});

describe('scanCommitMessages', () => {
  it('names the commit that armed each closure', () => {
    // A bare list of numbers is unactionable once a branch has more than a few
    // commits: the author has to bisect their own history to find the word.
    const scanned = scanCommitMessages([
      { oid: 'aaaaaaaa1111', message: `${KEYWORD} #57` },
      { oid: 'bbbbbbbb2222', message: 'no reference here' },
      { oid: 'cccccccc3333', message: WRAPPED_COMMIT_MESSAGE },
    ]);
    expect(scanned).toEqual([
      { issue: 57, sources: [{ oid: 'aaaaaaaa1111', keyword: 'closes' }] },
      { issue: 435, sources: [{ oid: 'cccccccc3333', keyword: 'fixes' }] },
    ]);
  });

  it('tolerates an empty or malformed commit list rather than throwing', () => {
    // A crash here reports as a failed check, which reads as "a closure was
    // found". Wrong subject, and it trains the reader to ignore the check.
    expect(scanCommitMessages([])).toEqual([]);
    expect(scanCommitMessages(undefined)).toEqual([]);
    expect(scanCommitMessages([{}])).toEqual([]);
  });
});

describe('compareCommitClosures', () => {
  it('fails an out-of-scope closure and passes a declared one', () => {
    // Criterion 7, both directions in one test so neither can be satisfied by
    // a parser that always returns the same answer.
    const scanned = scanCommitMessages([
      { oid: 'aaaaaaaa1111', message: `${KEYWORD} #435` },
    ]);
    expect(compareCommitClosures([], scanned)).toHaveLength(1);
    expect(compareCommitClosures([158], scanned)).toHaveLength(1);
    expect(compareCommitClosures([435], scanned)).toEqual([]);
  });
});

describe('formatCommitFailure', () => {
  it('names the issue, the commit and the wrapping trap', () => {
    const message = formatCommitFailure({
      unexpected: scanCommitMessages([
        { oid: 'cccccccc3333', message: WRAPPED_COMMIT_MESSAGE },
      ]),
      prNumber: 433,
    });
    expect(message).toContain('#435');
    expect(message).toContain('cccccccc');
    expect(message).toContain('different lines');
    // And it must say which surface it read, or the author edits the body and
    // watches the check fail again for a reason it never named.
    expect(message).toContain('COMMIT MESSAGE');
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
