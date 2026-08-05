import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('the exit codes are the numbers the shell reads', () => {
  // #512 review: every other exit-code assertion in this file compares
  // `main`'s return against the imported constant, so both sides move together
  // and mutating the constant is invisible. `EXIT_UNMATCHED = 0` passed all 19
  // tests while turning the refusal into a success for every caller -- the
  // wrapper announced it was refusing and returned 0 to the shell, which is the
  // whole defect this script exists to prevent, reintroduced silently.
  //
  // The contract here is with the shell, not with the module: a non-zero exit
  // is the entire mechanism. So these are pinned to literals on purpose. That
  // is not brittleness -- changing one of these numbers IS a breaking change to
  // every caller, and it should require editing a test that says so.
  it('pins the wire values rather than comparing a constant to itself', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_UNMATCHED).toBe(1);
    expect(EXIT_INCONCLUSIVE).toBe(2);
    // And they must stay distinguishable from each other: a caller that cannot
    // tell "matched nothing" from "could not tell" has lost the distinction
    // this script was written to draw.
    expect(new Set([EXIT_OK, EXIT_UNMATCHED, EXIT_INCONCLUSIVE]).size).toBe(3);
  });
});

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

describe("main's own defaults are executed, not just its injected doubles", () => {
  // #512 review: every `main` arm above injects both `list` and `run`, so the
  // default bindings on the parameter list were never executed by any test.
  // Rebinding `list` to a stub that always reports a match left all 19 tests
  // green while disabling the check for every real caller -- the wiring, which
  // is the only part the shell actually runs, was the untested part.

  it('refuses an absent selector through the real listing, with no doubles', () => {
    let ran = false;
    // `list` is deliberately NOT injected: this exercises the default binding.
    // `run` is injected only to prove it is never reached -- if the default
    // listing wrongly reported a match, this would run the whole suite.
    const code = main(['run', ABSENT_TEST_FILE], {
      run: () => {
        ran = true;
        return EXIT_OK;
      },
      log: () => {},
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
  }, 180_000);

  it('proceeds on a real selector through the real listing', () => {
    // POSITIVE CONTROL for the arm above. Without it, a default listing that
    // reported UNMATCHED for everything would satisfy that assertion while
    // refusing every legitimate run -- the opposite failure, equally silent.
    let ran = false;
    const code = main(['run', REAL_TEST_FILE], {
      run: () => {
        ran = true;
        return EXIT_OK;
      },
      log: () => {},
    });
    expect(ran).toBe(true);
    expect(code).toBe(0);
  }, 180_000);

  it('runs the real vitest through the real default when invoked as a CLI', () => {
    // The `run` default is the one binding the two arms above still stub. This
    // reaches it the only way a test can without recursion: as a subprocess,
    // against a small unrelated file. Naming this file here would recurse.
    const result = spawnSync(
      process.execPath,
      ['scripts/vitest-strict.mjs', 'run', 'tests/viewer.types.test.ts'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'viewer.types.test.ts',
    );
  }, 300_000);

  // The `log` default was the third binding in this signature, and the two
  // arms above -- written to prove the defaults run -- still stubbed it. A
  // test for defaults that injects a default measures the injection.
  // With `log` mutated to a no-op every other test here stays green while
  // the CLI refuses SILENTLY: exit 1 and not one word saying why.
  // A console.error spy left installed would silence later arms in this file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the refusal through the real console.error default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ran = false;
    // `log` is deliberately NOT injected. That is the whole point of the arm.
    const code = main(['run', ABSENT_TEST_FILE], {
      run: () => {
        ran = true;
        return EXIT_OK;
      },
    });
    expect(code).toBe(EXIT_UNMATCHED);
    expect(ran).toBe(false);
    // Assert the CONTENT, not merely that something was logged: a refusal
    // that prints an empty string is as useless to the caller as silence.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      ABSENT_TEST_FILE,
    );
  }, 180_000);

  it('stays silent on the success path, so the arm above is attributable', () => {
    // NEGATIVE CONTROL. Without it, a build that wrote to console.error on
    // EVERY path would satisfy the assertion above while telling the caller
    // nothing about whether the refusal specifically was reported.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = main(['run', REAL_TEST_FILE], {
      run: () => EXIT_OK,
    });
    expect(code).toBe(EXIT_OK);
    expect(spy).not.toHaveBeenCalled();
  }, 180_000);
});

// The guard is only worth anything if something actually invokes it. Every
// test above exercises the script; none of them observed that `npm run
// test:strict` still points AT the script. Rebinding that one line of
// package.json to plain `vitest` restores the exact silent-pass defect this
// script exists to prevent, and left all 23 earlier tests green.
describe('the npm script is still wired to the guard', () => {
  const invokesGuard = (command: string): boolean =>
    /(^|\s)node\s/.test(command) &&
    command.includes('scripts/vitest-strict.mjs');

  it('runs the guard script rather than bare vitest', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.['test:strict'];

    // CONTROL on the read itself: an absent key yields undefined, and every
    // assertion below would then be vacuous rather than failing.
    expect(typeof command).toBe('string');
    expect(command).not.toBe('');

    expect(invokesGuard(command as string)).toBe(true);
  });

  it('would reject the bare-vitest form, so the check above discriminates', () => {
    // IN-BAND CONTROL. `invokesGuard` returning true for everything would
    // pass the arm above with the wiring removed.
    expect(invokesGuard('vitest')).toBe(false);
    expect(invokesGuard('vitest run')).toBe(false);
    expect(invokesGuard('node scripts/vitest-strict.mjs')).toBe(true);
  });
});
