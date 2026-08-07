#!/usr/bin/env node
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT_SUCCESS = 0;
export const EXIT_UNUSABLE = 2;

export const SHA_INPUT_PATTERN = /^[0-9a-f]{4,40}$/i;
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const USAGE = `usage: node scripts/actions-runs-for-sha.mjs --sha <sha-or-prefix> [--repo owner/name]

Resolves the commit first, validates the returned full SHA, and only then queries
GitHub Actions runs. A successful total_count=0 is therefore distinct from an
unusable input, which exits 2 without querying actions/runs.`;

/**
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{repo?: string, sha?: string, help?: boolean, error?: string}} */
  const out = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--repo' || arg === '--sha') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        out.error = `${arg} requires a value`;
        return out;
      }
      if (arg === '--repo') out.repo = value;
      else out.sha = value;
      i += 1;
    } else {
      out.error = `unknown argument ${JSON.stringify(arg)}`;
      return out;
    }
  }

  return out;
}

/**
 * @param {string | undefined} requested
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {string | null}
 */
export function resolveRepo(requested, env, run) {
  if (requested) return /^[^/\s]+\/[^/\s]+$/.test(requested) ? requested : null;
  if (env.GITHUB_REPOSITORY) {
    return /^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY)
      ? env.GITHUB_REPOSITORY
      : null;
  }

  const result = run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', env },
  );
  if (!result || result.error || result.status !== 0) return null;
  const slug = String(result.stdout ?? '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

/**
 * @param {string} input
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {{ok: true, sha: string} | {ok: false, reason: string}}
 */
export function resolveCommitSha(input, repo, env, run) {
  if (!SHA_INPUT_PATTERN.test(input)) {
    return {
      ok: false,
      reason: `${JSON.stringify(input)} is not a 4-to-40-character hexadecimal SHA or prefix`,
    };
  }

  const result = run(
    'gh',
    [
      'api',
      `repos/${repo}/commits/${encodeURIComponent(input)}`,
      '--jq',
      '.sha',
    ],
    { encoding: 'utf8', env },
  );

  if (!result || result.error) {
    return { ok: false, reason: 'the commit resolver could not be executed' };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    const status = /HTTP (\d{3})/.exec(stderr)?.[1];
    return {
      ok: false,
      reason: `the commit did not resolve${status ? ` (HTTP ${status})` : ''}`,
    };
  }

  const sha = String(result.stdout ?? '')
    .trim()
    .toLowerCase();
  if (!FULL_SHA_PATTERN.test(sha)) {
    return {
      ok: false,
      reason: `the commit resolver returned an invalid full SHA: ${JSON.stringify(sha)}`,
    };
  }

  return { ok: true, sha };
}

/**
 * @param {string} sha
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {{ok: true, totalCount: number} | {ok: false, reason: string}}
 */
export function queryActionsRuns(sha, repo, env, run) {
  if (!FULL_SHA_PATTERN.test(sha)) {
    return {
      ok: false,
      reason: 'refusing to query actions/runs without a validated full SHA',
    };
  }

  const result = run(
    'gh',
    [
      'api',
      `repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`,
      '--jq',
      '.total_count',
    ],
    { encoding: 'utf8', env },
  );

  if (!result || result.error) {
    return { ok: false, reason: 'the Actions query could not be executed' };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    const status = /HTTP (\d{3})/.exec(stderr)?.[1];
    return {
      ok: false,
      reason: `the Actions query failed${status ? ` (HTTP ${status})` : ''}`,
    };
  }

  const raw = String(result.stdout ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      reason: `the Actions query returned an invalid total_count: ${JSON.stringify(raw)}`,
    };
  }

  const totalCount = Number(raw);
  if (!Number.isSafeInteger(totalCount)) {
    return {
      ok: false,
      reason: `the Actions query returned an unsafe total_count: ${JSON.stringify(raw)}`,
    };
  }

  return { ok: true, totalCount };
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @param {(text: string) => void} write
 */
export function runMain(argv, env, run, write) {
  const args = parseArgs(argv);
  if (args.help) {
    write(USAGE);
    return EXIT_SUCCESS;
  }
  if (args.error) {
    write(`${args.error}\n\n${USAGE}`);
    return EXIT_UNUSABLE;
  }
  if (!args.sha) {
    write(`--sha is required\n\n${USAGE}`);
    return EXIT_UNUSABLE;
  }

  const repo = resolveRepo(args.repo, env, run);
  if (!repo) {
    write('unusable input: could not determine a valid owner/name repository');
    return EXIT_UNUSABLE;
  }

  const resolved = resolveCommitSha(args.sha, repo, env, run);
  if (!resolved.ok) {
    write(`unusable input: ${resolved.reason}`);
    return EXIT_UNUSABLE;
  }

  const runs = queryActionsRuns(resolved.sha, repo, env, run);
  if (!runs.ok) {
    write(`query unusable: ${runs.reason}`);
    return EXIT_UNUSABLE;
  }

  write(`resolved_sha=${resolved.sha}\ntotal_count=${runs.totalCount}`);
  return EXIT_SUCCESS;
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @param {(text: string) => void} write
 */
export function main(
  argv,
  env = process.env,
  run = spawnSync,
  write = (text) => process.stdout.write(`${text}\n`),
) {
  try {
    return runMain(argv, env, run, write);
  } catch (error) {
    write(
      `query unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_UNUSABLE;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
