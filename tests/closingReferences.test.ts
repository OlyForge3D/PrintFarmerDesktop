import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareClosures,
  formatFailure,
  formatUnsettled,
  main,
  parseBoundClosures,
  parseDeclaredClosures,
  readSettled,
  witnessContradiction,
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
  function ghStub(closures: number[], witnessBody: string = BODY) {
    return (args: string[]) => {
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

  it('passes a settled read that matches', async () => {
    // CONTROL. Without it, the assertion above is satisfied by a `main` that
    // fails unconditionally, which would also "not pass an unsettled read".
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231]),
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

  it('reports a settled mismatch as a mismatch, not as an unsettled read', async () => {
    // The other direction of the same discrimination: the two failures must
    // stay distinguishable, or consulting `settled` just moves the conflation
    // from the exit code into the message.
    const spies = silenced();
    const result = await main(['231'], {
      run: ghStub([231, 999]),
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
    // this is the branch where the false NEGATIVE lives. Accepted anyway,
    // because the alternative reds correct PRs with no way to clear it --
    // but it is a gap, not a bound, and it is the residual risk of the fix.
    expect(witnessContradiction('prose that binds nothing', [231])).toEqual([]);
    expect(witnessContradiction(`${KEYWORD} #999`, [231])).toEqual([]);
  });

  it('says nothing when the body genuinely closes nothing', () => {
    expect(witnessContradiction('a body that mentions #231 only', [])).toEqual(
      [],
    );
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
      if (args.includes('body,closingIssuesReferences')) {
        return JSON.stringify({ body: witness, refs });
      }
      return args.includes('body') ? declBody : JSON.stringify(refs);
    };
  }

  it('reports, but does not fail, a settled empty read the body contradicts', async () => {
    const spies = silenced();
    // Declares nothing and arms nothing: on the settled value alone this is a
    // clean pass, and that is exactly the shape a stale read takes.
    const result = await main(['231'], {
      run: ghStub('no declaration here', PROSE, []),
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

  it('does not fail again on a re-run, because the body cannot change it', async () => {
    // The bound the previous design claimed -- "the cost of being wrong is
    // bounded to a retry" -- was false: the input is the PR body, so the
    // verdict is deterministic and a retry reproduces it exactly. This is
    // that claim as a test. Two identical runs, both green.
    const attempt = async () => {
      const spies = silenced();
      const result = await main(['231'], {
        run: ghStub('no declaration here', PROSE, []),
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

    expect(await attempt()).toEqual(await attempt());
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

  it('does not let the witness override a real declaration mismatch', async () => {
    const spies = silenced();
    const declared = ['```' + KEYWORD, '#231', '```'].join('\n');
    const result = await main(['231'], {
      run: ghStub(declared, 'body closing nothing in prose', []),
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
