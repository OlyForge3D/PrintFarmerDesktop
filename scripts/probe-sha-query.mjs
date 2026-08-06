#!/usr/bin/env node
/**
 * Re-run #379's finding instead of citing it.
 *
 * WHAT #379 ESTABLISHED. `GET actions/runs?head_sha=<7-char prefix>` returns
 * `total_count: 0` at HTTP 200 — the same artifact a commit with genuinely no
 * runs returns, and the same artifact a fabricated SHA returns. So the query
 * the squad adopted *as the safe one* cannot separate the case it exists to
 * separate. The remedy in that issue is `commits/<sha>/check-runs`, which
 * dereferences rather than filters: it resolves short SHAs and 422s on a SHA
 * it cannot resolve.
 *
 * WHY THIS FILE EXISTS AND A PARAGRAPH DOES NOT. #379's finding is an
 * empirical claim about somebody else's running system. A commitment decays
 * into folklore silently; this decays into a failing run. If GitHub changes
 * `head_sha=` to reject a prefix, or changes `check-runs` to stop resolving
 * one, the guidance built on that table becomes wrong and nothing in a
 * document would say so. This says so.
 *
 * THE VERDICT IS INVERTED HERE AND THAT IS THE WHOLE DESIGN. Everywhere else
 * BLIND is a defect. Here arm 2 is EXPECTED to be BLIND, because that is the
 * finding. So this cannot report "the instrument is sound"; it reports
 * whether the finding still REPRODUCES:
 *
 *   exit 0  reproduces      the three arms behave as #379 recorded
 *   exit 1  does not        at least one arm changed — the guidance resting on
 *                           #379 is now unsupported and must be re-derived
 *   exit 2  undetermined    nothing was established, including nothing against
 *                           #379
 *
 * ARM 1 IS A POSITIVE CONTROL AND IT IS LOAD-BEARING. Fed FULL SHAs, the
 * filter endpoint must discriminate. Without that arm, a missing credential, a
 * rate limit or an offline machine makes every call return the same thing, arm
 * 2 comes back BLIND, and the run reports "reproduces" — confirming the
 * finding from an experiment that never reached the API. That is the exact
 * shape of the defect #379 is about, committed by its own probe. A failed
 * control is therefore always exit 2 and never exit 0 or 1.
 *
 * THE CASES ARE DERIVED AT RUN TIME, NOT COMMITTED. A spec with hard-coded
 * SHAs rots: check runs age out of retention, so the "has runs" arm silently
 * becomes a "no runs" arm and the probe reports a defect forever. A permanently
 * red check is one people learn to skip, which is worse than no check. The
 * positive case defaults to the current tip and the negative case is a
 * fabricated well-formed SHA, which cannot age.
 *
 * WHY A FABRICATED SHA IS THE RIGHT NEGATIVE. #379 measured that a well-formed
 * but unmatched 40-hex SHA and a truthful zero are indistinguishable at the
 * filter endpoint, while the dereference endpoint separates them with a 422.
 * That is the pair the two endpoints disagree about, so it is the pair worth
 * probing. A malformed SHA is a different input class — it draws a 422 from
 * both, which is why an earlier reading recorded the filter endpoint as
 * self-reporting when it is not.
 *
 * DOMAIN. This says nothing about whether any PARTICULAR past reading was
 * taken with a full SHA. It answers one question — does the endpoint pair
 * still behave as recorded — and answers it by asking, every time.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  VERDICT_BLIND,
  VERDICT_SOUND,
  VERDICT_UNUSABLE,
  classifyDiscrimination,
} from './instrument-probe.mjs';

export const EXIT_REPRODUCES = 0;
export const EXIT_CHANGED = 1;
export const EXIT_UNDETERMINED = 2;

/** A well-formed SHA that no repository contains. Cannot age out. */
export const FABRICATED_SHA = '0123456789abcdef0123456789abcdef01234567';

export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * The three arms, named so a failure says which claim moved.
 *
 * `control` is not decoration. It is the arm whose failure invalidates the
 * other two, and it is marked so the reporting cannot forget that.
 */
export const ARMS = Object.freeze([
  Object.freeze({
    id: 'filter-full',
    control: true,
    endpoint: 'filter',
    truncate: false,
    expect: VERDICT_SOUND,
    describe:
      'actions/runs?head_sha=<full> — POSITIVE CONTROL: the endpoint works when used correctly',
  }),
  Object.freeze({
    id: 'filter-short',
    control: false,
    endpoint: 'filter',
    truncate: true,
    expect: VERDICT_BLIND,
    describe:
      'actions/runs?head_sha=<7-char> — #379: a prefix is matched, not resolved, so every head reads 0',
  }),
  Object.freeze({
    id: 'deref-short',
    control: false,
    endpoint: 'deref',
    truncate: true,
    expect: VERDICT_SOUND,
    describe:
      'commits/<7-char>/check-runs — #379 remedy: a path segment is dereferenced, so a prefix resolves and a bad SHA 422s',
  }),
]);

/**
 * @param {string} sha
 * @param {boolean} truncate
 * @returns {string}
 */
export function presentSha(sha, truncate) {
  return truncate ? sha.slice(0, 7) : sha;
}

/**
 * The api path for an arm.
 *
 * The two shapes are the finding. A query parameter is MATCHED and a path
 * segment is DEREFERENCED, and that difference — not the endpoint's name —
 * predicts which one goes quiet on an input it cannot use.
 *
 * @param {{endpoint: string}} arm
 * @param {string} repo
 * @param {string} sha
 * @returns {string}
 */
export function apiPath(arm, repo, sha) {
  return arm.endpoint === 'filter'
    ? `repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`
    : `repos/${repo}/commits/${sha}/check-runs?per_page=1`;
}

/**
 * The jq expression that reduces a response to the number acted on.
 *
 * Both endpoints report `total_count`, which is why they are confusable in the
 * first place: the two answers are the same shape and only one of them is
 * trustworthy.
 *
 * @returns {string}
 */
export function countExpression() {
  return '.total_count';
}

/**
 * Run one gh api call and reduce it to a reading.
 *
 * A NON-ZERO EXIT IS A READING, NOT AN ABSENCE. The 422 from the dereference
 * endpoint is the entire remedy — it is how that endpoint says "I cannot
 * resolve this", and discarding it as an error would erase the difference this
 * file measures. So a failed call reads as `error:<status>` and a successful
 * one reads as its count. Those are distinguishable, which is the point.
 *
 * `null` is reserved for "no reading was obtained at all", which
 * classifyDiscrimination treats as UNUSABLE rather than as a value.
 *
 * @param {typeof spawnSync} run
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function readCount(run, path, env) {
  const result = run('gh', ['api', path, '--jq', countExpression()], {
    encoding: 'utf8',
    env,
  });

  if (!result || result.error) return null;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '');
    const matched = /HTTP (\d{3})/.exec(stderr);
    return `error:${matched ? matched[1] : String(result.status)}`;
  }

  const stdout = String(result.stdout ?? '').trim();
  if (stdout === '') return null;
  return stdout;
}

/**
 * Collect both readings for one arm.
 *
 * @param {{endpoint: string, truncate: boolean}} arm
 * @param {{repo: string, realSha: string, run: typeof spawnSync, env: NodeJS.ProcessEnv}} ctx
 */
export function readArm(arm, { repo, realSha, run, env }) {
  const real = presentSha(realSha, arm.truncate);
  const fake = presentSha(FABRICATED_SHA, arm.truncate);
  return [
    {
      label: `real commit ${real}`,
      reading: readCount(run, apiPath(arm, repo, real), env),
    },
    {
      label: `fabricated ${fake}`,
      reading: readCount(run, apiPath(arm, repo, fake), env),
    },
  ];
}

/**
 * Judge one arm against what #379 recorded.
 *
 * Reuses instrument-probe's classifier rather than restating it, so the
 * meanings of BLIND and UNUSABLE cannot drift apart between the two files.
 * `reading` is deliberately NOT 'exitCode': these readings are counts, and the
 * vacuity rule there is about non-answer exit codes, which do not apply.
 *
 * @param {{id: string, expect: string, control: boolean, describe: string}} arm
 * @param {readonly {label: string, reading: string|null}[]} cases
 */
export function judgeArm(arm, cases) {
  const outcome = classifyDiscrimination(cases, 'stdout');
  return {
    id: arm.id,
    control: arm.control,
    describe: arm.describe,
    expected: arm.expect,
    observed: outcome.verdict,
    matches: outcome.verdict === arm.expect,
    readings: outcome.readings,
  };
}

/**
 * The whole verdict, pure over already-judged arms.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE. A failed control outranks everything,
 * including a full set of matching arms, because a run that never reached the
 * API can produce matching arms by accident: three identical failures look
 * like one BLIND and two UNUSABLE, and any rule that reads the non-control
 * arms first would publish a confirmation from an experiment that did not
 * happen.
 *
 * @param {readonly {id: string, control: boolean, expected: string, observed: string, matches: boolean}[]} judged
 */
export function overallVerdict(judged) {
  if (judged.length === 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary:
        'no arms ran, so nothing was established — including nothing against #379',
    };
  }

  const control = judged.filter((a) => a.control);
  if (control.length === 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary:
        'no control arm: without one, a run that never reached the API is indistinguishable from a reproduction',
    };
  }

  const brokenControl = control.filter((a) => !a.matches);
  if (brokenControl.length > 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary:
        `control arm ${brokenControl.map((a) => a.id).join(', ')} did not behave as required ` +
        `(expected ${brokenControl[0].expected}, observed ${brokenControl[0].observed}). ` +
        'The endpoint does not discriminate even on full SHAs, so this run reached a broken ' +
        'harness rather than the finding. Nothing is concluded either way.',
    };
  }

  const unusable = judged.filter((a) => a.observed === VERDICT_UNUSABLE);
  if (unusable.length > 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: `${unusable.map((a) => a.id).join(', ')} produced no reading, so the arm was not measured`,
    };
  }

  const changed = judged.filter((a) => !a.matches);
  if (changed.length > 0) {
    return {
      exitCode: EXIT_CHANGED,
      summary:
        `${changed.map((a) => `${a.id}: expected ${a.expected}, observed ${a.observed}`).join('; ')}. ` +
        'The behaviour #379 recorded has changed. Any guidance resting on that table is now ' +
        'unsupported and must be re-derived before it is quoted again.',
    };
  }

  return {
    exitCode: EXIT_REPRODUCES,
    summary:
      'all three arms behave as #379 recorded: the filter endpoint discriminates on full SHAs, ' +
      'goes blind on prefixes, and the dereference endpoint stays sound on prefixes.',
  };
}

/**
 * @param {readonly ReturnType<typeof judgeArm>[]} judged
 * @param {{exitCode: number, summary: string}} verdict
 * @returns {string}
 */
export function formatReport(judged, verdict) {
  const lines = [
    '#379 re-run: does actions/runs?head_sha= still go blind on a prefix?',
    '',
  ];
  for (const arm of judged) {
    lines.push(
      `  ${arm.matches ? 'as recorded' : 'CHANGED    '}  ${arm.id}${arm.control ? '  [CONTROL]' : ''}`,
    );
    lines.push(`      ${arm.describe}`);
    lines.push(`      expected ${arm.expected}, observed ${arm.observed}`);
    for (const r of arm.readings) {
      lines.push(
        `        ${r.reading === null ? '(no reading)' : JSON.stringify(r.reading)}  <- ${r.label}`,
      );
    }
  }
  lines.push('');
  lines.push(`  ${verdict.summary}`);
  return lines.join('\n');
}

/**
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{repo?: string, sha?: string, help?: boolean}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repo = argv[i + 1];
    else if (argv[i] === '--sha') out.sha = argv[i + 1];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

export const USAGE = `usage: node scripts/probe-sha-query.mjs [--repo owner/name] [--sha <40-hex>]

Re-runs #379 against the live API instead of citing it.

  --sha   a commit that HAS check runs. Defaults to the current tip, because a
          committed SHA rots once its runs age out of retention.
  --repo  defaults to GITHUB_REPOSITORY, else \`gh repo view\`.

exit 0  the finding reproduces
exit 1  it does not — guidance resting on #379 is unsupported until re-derived
exit 2  undetermined, including whenever the positive control fails`;

/**
 * Resolve the subject commit, refusing a prefix rather than expanding one.
 *
 * REFUSING IS THE POINT. Expanding a prefix here would make this file commit
 * the defect it measures, and it would do it silently, since the expansion
 * usually succeeds.
 *
 * @param {string | undefined} requested
 * @param {typeof spawnSync} run
 * @returns {{ok: true, sha: string} | {ok: false, reason: string}}
 */
export function resolveSubject(requested, run) {
  if (requested !== undefined) {
    return SHA_PATTERN.test(requested)
      ? { ok: true, sha: requested.toLowerCase() }
      : {
          ok: false,
          reason: `--sha must be a full 40-character SHA; got ${JSON.stringify(requested)}. This file will not expand a prefix, because doing so is the defect it measures.`,
        };
  }

  const result = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = String(result?.stdout ?? '').trim();
  if (result?.status !== 0 || !SHA_PATTERN.test(sha)) {
    return { ok: false, reason: 'could not resolve HEAD to a full SHA' };
  }
  return { ok: true, sha };
}

/**
 * @param {string | undefined} requested
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {string | null}
 */
export function resolveRepo(requested, env, run) {
  if (requested) return requested;
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const result = run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', env },
  );
  if (result?.status !== 0) return null;
  const slug = String(result.stdout ?? '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @param {(text: string) => void} write
 * @returns {number}
 */
export function runMain(argv, env, run, write) {
  const args = parseArgs(argv);
  if (args.help) {
    write(USAGE);
    return EXIT_REPRODUCES;
  }

  const repo = resolveRepo(args.repo, env, run);
  if (!repo) {
    write(
      'could not determine the repository; pass --repo owner/name. Exit 2, not a finding.',
    );
    return EXIT_UNDETERMINED;
  }

  const subject = resolveSubject(args.sha, run);
  if (!subject.ok) {
    write(`${subject.reason} Exit 2, not a finding.`);
    return EXIT_UNDETERMINED;
  }

  const judged = ARMS.map((arm) =>
    judgeArm(arm, readArm(arm, { repo, realSha: subject.sha, run, env })),
  );
  const verdict = overallVerdict(judged);
  write(formatReport(judged, verdict));
  return verdict.exitCode;
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @param {(text: string) => void} write
 * @returns {number}
 */
export function main(
  argv,
  env = process.env,
  run = spawnSync,
  write = (text) => process.stdout.write(`${text}\n`),
) {
  try {
    return runMain(argv, env, run, write);
  } catch (err) {
    // An exception is not evidence about #379 in either direction.
    write(
      `probe-sha-query failed: ${err instanceof Error ? err.message : String(err)}. Exit 2.`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
