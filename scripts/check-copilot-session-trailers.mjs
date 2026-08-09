/**
 * Reject malformed Copilot-Session trailers in pull request commits.
 *
 * This check only judges SHAPE (one canonical UUID per value) and is
 * deliberately silent on namespace: before #670 the value was the cloud
 * Copilot-session identifier, hand-typed into a `--trailer` flag from a
 * dispatch brief; from #670 onward `scripts/prepare-commit-msg.mjs` writes it
 * mechanically from `COPILOT_AGENT_SESSION_ID`, the CLI runtime's own
 * per-process session id (see that script's header for why THAT source and
 * not the cloud id — the short version is that the cloud id is not readable
 * by any local process, so mechanizing "the trailer" necessarily means
 * mechanizing a value the tooling can actually read). Both are canonical
 * UUIDs and this check does not need to tell them apart; distinguishing "well
 * formed" from "hand-transcribed and wrong" is
 * `check-copilot-session-collisions.mjs`'s job, not this one's — see that
 * script for the collision/repetition audit this defect actually requires.
 *
 * Git decides which lines are trailers. Delegating that classification to
 * `git interpret-trailers` preserves its trailer-block rules and avoids a
 * second parser that could disagree on the exact prose shape this guard exists
 * to catch.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { resolvePullRequestNumber } from './check-pr-closure-scope.mjs';

export const COPILOT_SESSION_KEY = 'Copilot-Session';
// Exported so `scripts/prepare-commit-msg.mjs` (the mechanized source of this
// value, #670) and `scripts/check-copilot-session-collisions.mjs` (the
// companion collision audit, #670) validate against the exact same shape this
// per-PR formedness check does, rather than a second regex that could drift.
export const COPILOT_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

export function parsePullRequestCommits(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('expected the pull request commit response to be text');
  }

  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (cause) {
    throw new Error('pull request commit response is not valid JSON', {
      cause,
    });
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new TypeError(
      'pull request commit response is not an array of pages; refusing to report unreadable commits as valid',
    );
  }

  return pages.flatMap((page) =>
    page.map((entry) => {
      const sha = entry?.sha;
      const message = entry?.commit?.message;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new TypeError(
          'pull request commit entry has no full SHA; refusing to validate an unidentified commit',
        );
      }
      if (typeof message !== 'string') {
        throw new TypeError(
          'pull request commit entry has no message string; refusing to report an unreadable commit as valid',
        );
      }
      return { sha, message };
    }),
  );
}

export function parseCopilotSessionTrailerValues(message, interpret = run) {
  if (typeof message !== 'string') {
    throw new TypeError('expected a commit message string');
  }

  const parsed = interpret('git', ['interpret-trailers', '--parse'], {
    input: message,
  });
  if (typeof parsed !== 'string') {
    throw new TypeError(
      'git interpret-trailers returned no text; refusing to treat the commit as trailer-free',
    );
  }

  const values = [];
  for (const line of parsed.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key.toLowerCase() === COPILOT_SESSION_KEY.toLowerCase()) {
      values.push(line.slice(separator + 1).trim());
    }
  }
  return values;
}

export function findMalformedCopilotSessionTrailers(commits, interpret = run) {
  if (!Array.isArray(commits)) {
    throw new TypeError('expected pull request commits to be an array');
  }

  const malformed = [];
  for (const commit of commits) {
    if (
      typeof commit?.sha !== 'string' ||
      typeof commit?.message !== 'string'
    ) {
      throw new TypeError(
        'expected every pull request commit to have a SHA and message',
      );
    }
    for (const value of parseCopilotSessionTrailerValues(
      commit.message,
      interpret,
    )) {
      if (!COPILOT_SESSION_UUID.test(value)) {
        malformed.push({ sha: commit.sha, value });
      }
    }
  }
  return malformed;
}

export function formatMalformedTrailers(malformed) {
  return [
    'Malformed Copilot-Session trailer value(s).',
    '',
    ...malformed.map(
      ({ sha, value }) => `  ${sha.slice(0, 12)}  ${JSON.stringify(value)}`,
    ),
    '',
    'Each value must be exactly one canonical UUID from the cloud Copilot-session',
    'identifier namespace (8-4-4-4-12 hexadecimal digits, with UUID version and',
    'variant bits). Do not use an abbreviated UUID or append prose to the value.',
  ].join('\n');
}

function gh(args) {
  return run('gh', args).trim();
}

export function main(argv, deps = {}) {
  const {
    environment = process.env,
    invokeGh = gh,
    interpretTrailers = run,
    log = console.log,
    error = console.error,
  } = deps;
  const supplied = argv[0];
  if (supplied !== undefined && !/^[1-9]\d*$/.test(supplied)) {
    throw new Error('usage: check-copilot-session-trailers.mjs <pr-number>');
  }
  const prNumber = supplied ?? String(resolvePullRequestNumber(environment));
  const raw = invokeGh([
    'api',
    '--paginate',
    '--slurp',
    `repos/{owner}/{repo}/pulls/${prNumber}/commits?per_page=100`,
  ]);
  const commits = parsePullRequestCommits(raw);
  const malformed = findMalformedCopilotSessionTrailers(
    commits,
    interpretTrailers,
  );

  if (malformed.length > 0) {
    error(formatMalformedTrailers(malformed));
    process.exitCode = 1;
    return { ok: false, commits: commits.length, malformed };
  }

  log(
    `Copilot-Session trailers are valid. commits=${commits.length} malformed=0`,
  );
  return { ok: true, commits: commits.length, malformed: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
