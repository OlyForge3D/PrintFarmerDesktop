import { describe, expect, it } from 'vitest';

import {
  EXIT_INCONCLUSIVE,
  EXIT_OK,
  EXIT_UNMATCHED,
  INCONCLUSIVE,
  MATCHED,
  SKIP_AMBIGUOUS,
  SKIP_FLAG_VALUE,
  UNMATCHED,
  checkSelectors,
  classifyListing,
  formatRefusal,
  listFilesFor,
  main,
  selectorCandidates,
} from '../scripts/vitest-strict.mjs';

const REAL_TEST_FILE = 'tests/vitestStrict.test.ts';
const ABSENT_TEST_FILE = 'tests/thisFileDoesNotExistAnywhere.test.ts';

describe('selectorCandidates separates what it will check from what it will not', () => {
  it('drops the subcommand and keeps the positional selectors', () => {
    const { candidates } = selectorCandidates([
      'run',
      'tests/a.test.ts',
      'tests/b.test.ts',
    ]);
    expect(candidates).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('does not treat a recognised flag value as a selector', () => {
    const { candidates, skipped } = selectorCandidates([
      'run',
      '--reporter',
      'json',
      'tests/a.test.ts',
    ]);
    // POSITIVE CONTROL: the real selector still survives, so an empty
    // candidate list cannot be mistaken for correct flag handling.
    expect(candidates).toEqual(['tests/a.test.ts']);
    expect(skipped).toEqual([
      { token: 'json', reason: SKIP_FLAG_VALUE, after: '--reporter' },
    ]);
  });

  it('needs no flag table at all for the --flag=value form', () => {
    const { candidates, skipped } = selectorCandidates([
      'run',
      '--reporter=json',
      '--totallyUnknown=x',
      'tests/a.test.ts',
    ]);
    expect(candidates).toEqual(['tests/a.test.ts']);
    expect(skipped).toEqual([]);
  });

  it('marks the value of an unrecognised bare flag ambiguous rather than guessing', () => {
    const { candidates, skipped } = selectorCandidates([
      'run',
      '--notInTheTable',
      'someValue',
      'tests/a.test.ts',
    ]);
    expect(candidates).toEqual(['tests/a.test.ts']);
    expect(skipped).toEqual([
      { token: 'someValue', reason: SKIP_AMBIGUOUS, after: '--notInTheTable' },
    ]);
  });

  it('does not swallow the subcommand as an unknown flag value', () => {
    const { candidates, skipped } = selectorCandidates([
      '--notInTheTable',
      'run',
      'tests/a.test.ts',
    ]);
    expect(candidates).toEqual(['tests/a.test.ts']);
    expect(skipped).toEqual([]);
  });
});

describe('classifyListing reads the line count, not the exit code', () => {
  it('calls a listing with files matched', () => {
    expect(classifyListing({ code: 0, stdout: 'tests/a.test.ts\n' })).toBe(
      MATCHED,
    );
  });

  it('calls an empty listing unmatched even though vitest exited 0', () => {
    // This is the whole point: BOTH cases exit 0, so an implementation that
    // read the exit code would return MATCHED here.
    expect(classifyListing({ code: 0, stdout: '' })).toBe(UNMATCHED);
    expect(classifyListing({ code: 0, stdout: '\n  \n' })).toBe(UNMATCHED);
  });

  it('refuses to answer when the listing itself failed', () => {
    expect(classifyListing({ code: 1, stdout: 'tests/a.test.ts\n' })).toBe(
      INCONCLUSIVE,
    );
  });
});

describe('checkSelectors', () => {
  const listing = (matches: Record<string, string>) => (selector: string) => ({
    code: 0,
    stdout: matches[selector] ?? '',
  });

  it('passes when every selector matches something', () => {
    const outcome = checkSelectors(['run', 'a', 'b'], {
      list: listing({ a: 'tests/a.test.ts\n', b: 'tests/b.test.ts\n' }),
    });
    expect(outcome.verdict).toBe(MATCHED);
    expect(outcome.unmatched).toEqual([]);
  });

  it('fails when ONE selector matches nothing, which is the case vitest passes', () => {
    const outcome = checkSelectors(['run', 'a', 'b'], {
      list: listing({ a: 'tests/a.test.ts\n' }),
    });
    expect(outcome.verdict).toBe(UNMATCHED);
    expect(outcome.unmatched).toEqual(['b']);
  });

  it('reads each selector exactly once', () => {
    const seen: string[] = [];
    checkSelectors(['run', 'a', 'b'], {
      list: (selector: string) => {
        seen.push(selector);
        return { code: 0, stdout: 'tests/x.test.ts\n' };
      },
    });
    expect(seen).toEqual(['a', 'b']);
  });

  it('reports the exit code from the same call it judged, not a second one', () => {
    let call = 0;
    const outcome = checkSelectors(['run', 'a'], {
      list: () => {
        call += 1;
        return { code: call === 1 ? 3 : 0, stdout: '' };
      },
    });
    expect(outcome.verdict).toBe(INCONCLUSIVE);
    expect(outcome.code).toBe(3);
    expect(call).toBe(1);
  });
});

describe('main', () => {
  const ok = () => ({ code: 0, stdout: 'tests/a.test.ts\n' });
  const none = () => ({ code: 0, stdout: '' });

  it('delegates to vitest and returns its exit code when all selectors match', () => {
    const passed: string[][] = [];
    const code = main(['run', 'tests/a.test.ts'], {
      list: ok,
      run: (argv: string[]) => {
        passed.push(argv);
        return EXIT_OK;
      },
      log: () => {},
    });
    expect(code).toBe(EXIT_OK);
    // The original argv is forwarded unaltered.
    expect(passed).toEqual([['run', 'tests/a.test.ts']]);
  });

  it('propagates a real test failure rather than masking it', () => {
    const code = main(['run', 'tests/a.test.ts'], {
      list: ok,
      run: () => 1,
      log: () => {},
    });
    expect(code).toBe(1);
  });

  it('refuses, and does not run anything, when a selector matches nothing', () => {
    let ran = false;
    const messages: string[] = [];
    const code = main(['run', 'tests/a.test.ts'], {
      list: none,
      run: () => {
        ran = true;
        return EXIT_OK;
      },
      log: (message: string) => messages.push(message),
    });
    expect(code).toBe(EXIT_UNMATCHED);
    expect(ran).toBe(false);
    expect(messages.join('\n')).toContain('MATCHED NOTHING: tests/a.test.ts');
  });

  it('refuses when the listing is unreadable, separately from refusing on no match', () => {
    const code = main(['run', 'tests/a.test.ts'], {
      list: () => ({ code: 2, stdout: '' }),
      run: () => EXIT_OK,
      log: () => {},
    });
    expect(code).toBe(EXIT_INCONCLUSIVE);
    expect(EXIT_INCONCLUSIVE).not.toBe(EXIT_UNMATCHED);
  });

  it('names an unchecked ambiguous token instead of failing open silently', () => {
    const messages: string[] = [];
    const code = main(
      ['run', '--notInTheTable', 'someValue', 'tests/a.test.ts'],
      {
        list: ok,
        run: () => EXIT_OK,
        log: (message: string) => messages.push(message),
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(messages.join('\n')).toContain('NOT CHECKED (ambiguous): someValue');
  });
});

describe('formatRefusal', () => {
  it('names every unmatched selector', () => {
    const text = formatRefusal({
      unmatched: ['a', 'b'],
      candidates: ['a', 'b', 'c'],
    });
    expect(text).toContain('MATCHED NOTHING: a');
    expect(text).toContain('MATCHED NOTHING: b');
    expect(text).toContain('selectors checked: 3');
  });
});

describe('listFilesFor is executed for real, not merely injected past', () => {
  // #447: an injected default that no test ever runs is an unexecuted I/O
  // boundary. These two arms run the real spawn. They are slow on purpose --
  // they are the only evidence that the delegation works at all.
  it('finds files for a selector that exists, and none for one that does not', () => {
    const present = listFilesFor(REAL_TEST_FILE);
    const absent = listFilesFor(ABSENT_TEST_FILE);

    // POSITIVE CONTROL: without this arm, a listFilesFor that always returned
    // empty output would satisfy the assertion below.
    expect(present.code).toBe(0);
    expect(classifyListing(present)).toBe(MATCHED);
    expect(present.stdout).toContain('vitestStrict.test.ts');

    expect(classifyListing(absent)).toBe(UNMATCHED);
    // The defect restated as an assertion: vitest reports success either way.
    expect(absent.code).toBe(0);
  }, 180_000);
});
