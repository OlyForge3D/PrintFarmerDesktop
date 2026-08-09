import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_ENV_VAR,
  SKIPPED_SOURCES,
  appendSessionTrailer,
  main,
  resolveSessionId,
} from '../scripts/prepare-commit-msg.mjs';

const VALID_V4 = 'a361e68b-8ced-488c-8d6c-9f43d2b3207a';
const VALID_V7 = '01890f4e-7cc2-7d00-93e0-3d70a36a33d5';

describe('resolveSessionId', () => {
  it('reads a well-formed UUID from the CLI runtime env var', () => {
    expect(resolveSessionId({ [SESSION_ENV_VAR]: VALID_V4 })).toBe(VALID_V4);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveSessionId({ [SESSION_ENV_VAR]: `  ${VALID_V7}  ` })).toBe(
      VALID_V7,
    );
  });

  it.each([
    ['absent entirely', {}],
    ['empty string', { [SESSION_ENV_VAR]: '' }],
    ['truncated', { [SESSION_ENV_VAR]: 'a361e68b-...' }],
    [
      'prose appended',
      { [SESSION_ENV_VAR]: `${VALID_V4} while discussing a session` },
    ],
  ])('returns null for %s', (_name, environment) => {
    expect(resolveSessionId(environment)).toBeNull();
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends the trailer via git interpret-trailers when the env var is present', () => {
    const exec = vi.fn();
    const result = main(['/tmp/COMMIT_EDITMSG', undefined, undefined], {
      environment: { [SESSION_ENV_VAR]: VALID_V4 },
      exec,
    });

    expect(result).toEqual({ applied: true, sessionId: VALID_V4 });
    expect(exec).toHaveBeenCalledWith(
      'git',
      [
        'interpret-trailers',
        '--in-place',
        '--trailer',
        `Copilot-Session=${VALID_V4}`,
        'COMMIT_EDITMSG',
      ],
      { cwd: path.dirname('/tmp/COMMIT_EDITMSG') },
    );
  });

  it('skips merge commits without touching the message', () => {
    const exec = vi.fn();
    const result = main(['/tmp/COMMIT_EDITMSG', 'merge', undefined], {
      environment: { [SESSION_ENV_VAR]: VALID_V4 },
      exec,
    });

    expect(result).toEqual({
      applied: false,
      reason: 'commit source is "merge"',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not skip squash sources', () => {
    expect(SKIPPED_SOURCES.has('squash')).toBe(false);

    const exec = vi.fn();
    const result = main(['/tmp/COMMIT_EDITMSG', 'squash', undefined], {
      environment: { [SESSION_ENV_VAR]: VALID_V4 },
      exec,
    });

    expect(result.applied).toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it('is a no-op for a human committing outside the CLI runtime', () => {
    const exec = vi.fn();
    const result = main(['/tmp/COMMIT_EDITMSG', 'message', undefined], {
      environment: {},
      exec,
    });

    expect(result).toEqual({
      applied: false,
      reason: `${SESSION_ENV_VAR} is absent or not a well-formed UUID`,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws when invoked with no commit-message file, the one argument git always supplies', () => {
    expect(() => main([], { environment: { [SESSION_ENV_VAR]: VALID_V4 } })).toThrow(
      /usage: prepare-commit-msg/,
    );
  });
});

describe('appendSessionTrailer end-to-end, against real git interpret-trailers', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  function tempMessageFile(contents: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prepare-commit-msg-'));
    dirs.push(dir);
    const file = path.join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, contents);
    return file;
  }

  it('adds a well-formed trailer to a plain commit message', () => {
    const file = tempMessageFile('feat: something\n\nWhy this change.\n');
    appendSessionTrailer(file, VALID_V4);
    expect(readFileSync(file, 'utf8')).toContain(
      `Copilot-Session: ${VALID_V4}`,
    );
  });

  it('is idempotent: invoking twice with the same id does not duplicate the line', () => {
    const file = tempMessageFile('feat: something\n\nWhy this change.\n');
    appendSessionTrailer(file, VALID_V4);
    appendSessionTrailer(file, VALID_V4);

    const occurrences = readFileSync(file, 'utf8').split(
      `Copilot-Session: ${VALID_V4}`,
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  it('adds a second line, not a replacement, when a different session amends the commit', () => {
    const file = tempMessageFile(
      `feat: something\n\nWhy this change.\n\nCopilot-Session: ${VALID_V7}\n`,
    );
    appendSessionTrailer(file, VALID_V4);

    const content = readFileSync(file, 'utf8');
    expect(content).toContain(`Copilot-Session: ${VALID_V7}`);
    expect(content).toContain(`Copilot-Session: ${VALID_V4}`);
  });
});
