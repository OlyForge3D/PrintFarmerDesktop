// Read-only by default. --enqueue uses only enqueuePullRequest with an expected
// source head, never mergePullRequest, --admin, auto-merge, or a direct ref write.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluateQueuePolicy,
  validQueueRuleset,
} from './merge-queue-policy.mjs';
import {
  discoverToken,
  evaluateRequiredContexts as evaluateWorkflowContexts,
  readWorkflows,
} from './check-merge-queue-contexts.mjs';
import { runGh, evaluateRequiredContexts } from './check-required-contexts.mjs';
import { evaluateSequencingHold } from './check-sequencing-hold.mjs';

const REPOSITORY = 'OlyForge3D/PrintFarmerDesktop';
const ROOT = path.resolve(import.meta.dirname, '..');
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function createQueueApi(env = process.env, run = spawnSync) {
  const token = discoverToken(env, run);
  if (!token) throw new Error('No GitHub credential; queue state is unknown.');
  return (endpoint, fields = {}) => {
    const args = ['api', endpoint];
    if (endpoint !== 'graphql') args.push('--method', 'GET');
    for (const [key, value] of Object.entries(fields)) {
      args.push('-f', `${key}=${value}`);
    }
    const result = runGh(run, args, { ...env, GH_TOKEN: token });
    if (!result.spawned || result.status !== 0) {
      throw new Error(
        `GitHub ${endpoint}: ${result.stderr || 'request failed'}`,
      );
    }
    const parsed = JSON.parse(result.stdout);
    if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
    return parsed;
  };
}

export function readQueuePolicy(api) {
  const protection = api(
    `/repos/${REPOSITORY}/branches/development/protection`,
  );
  const rules = api(
    `/repos/${REPOSITORY}/rules/branches/development?per_page=100`,
  );
  if (!Array.isArray(rules) || rules.length >= 100) {
    throw new Error(
      'Effective rule listing is malformed or possibly truncated.',
    );
  }
  const rulesets = [...new Set(rules.map((rule) => rule.ruleset_id))].map(
    (id) => api(`/repos/${REPOSITORY}/rulesets/${id}`),
  );
  const policy = evaluateQueuePolicy({ protection, rules, rulesets });
  const workflows = readWorkflows(path.join(ROOT, '.github/workflows'));
  const missing = evaluateWorkflowContexts({
    workflows,
    requiredContexts: policy.checks.map((check) => check.context),
  });
  if (missing.length) {
    throw new Error(
      `Required merge-group workflow coverage missing: ${JSON.stringify(missing)}`,
    );
  }
  return policy;
}

export function readQueuePull(api, number) {
  const query = `query {
    repository(owner:"OlyForge3D",name:"PrintFarmerDesktop") {
      pullRequest(number:${number}) {
        id state isDraft headRefOid baseRefName mergeable
        mergeQueueEntry { id state position baseCommit { oid } headCommit { oid } }
        reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage } }
      }
    }
  }`;
  const pull = api('graphql', { query }).data?.repository?.pullRequest;
  const rest = api(`/repos/${REPOSITORY}/pulls/${number}`);
  const base = api(`/repos/${REPOSITORY}/git/ref/heads/development`).object
    ?.sha;
  if (
    !pull ||
    !sha(base) ||
    !sha(pull.headRefOid) ||
    rest.head?.sha !== pull.headRefOid ||
    rest.base?.ref !== pull.baseRefName ||
    rest.state !== 'open' ||
    pull.state !== 'OPEN'
  ) {
    throw new Error(
      'Open PR, source head, target, or live base could not be corroborated.',
    );
  }
  return { ...pull, labels: rest.labels, baseSha: base };
}

export function assertQueuePull(pull, expectedHead) {
  if (!sha(expectedHead) || pull.headRefOid !== expectedHead) {
    throw new Error(
      'Source head changed or no exact reviewed head was supplied.',
    );
  }
  if (
    pull.baseRefName !== 'development' ||
    pull.state !== 'OPEN' ||
    pull.isDraft !== false
  ) {
    throw new Error('Only open, non-draft development PRs are eligible.');
  }
  if (pull.mergeable !== 'MERGEABLE') {
    throw new Error('Conflicted or unknown mergeability; queue entry refused.');
  }
  if (evaluateSequencingHold(pull.labels).held) {
    throw new Error('A hold label prevents queue entry.');
  }
  const threads = pull.reviewThreads;
  if (
    !Array.isArray(threads?.nodes) ||
    threads.pageInfo?.hasNextPage !== false ||
    threads.nodes.some((thread) => thread.isResolved !== true)
  ) {
    throw new Error(
      'Unresolved or incompletely read review threads prevent queue entry.',
    );
  }
}

export function assertGroupBinding(pull, group) {
  const entry = pull.mergeQueueEntry;
  if (
    !entry?.id ||
    !['AWAITING_CHECKS', 'MERGEABLE', 'LOCKED'].includes(entry.state) ||
    entry.position !== 1 ||
    !sha(entry.baseCommit?.oid) ||
    !sha(entry.headCommit?.oid) ||
    group.base_ref !== 'refs/heads/development' ||
    entry.baseCommit.oid !== group.base_sha ||
    entry.headCommit.oid !== group.head_sha ||
    pull.baseSha !== group.base_sha
  ) {
    throw new Error(
      'Queue membership, live base, or merge-group identity is stale or unknown.',
    );
  }
}

export function checkQueueRuns(checks, runs, expectedSha) {
  if (!Array.isArray(runs) || !sha(expectedSha)) {
    throw new Error('Check runs or their exact commit could not be read.');
  }
  const matching = runs.filter(
    (run) =>
      run.head_sha === expectedSha &&
      checks.some(
        (check) => check.context === run.name && check.appId === run.app?.id,
      ),
  );
  const latest = new Map();
  for (const run of matching) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0) {
      throw new Error(
        'Cannot order required check runs without a valid check-run ID.',
      );
    }
    if (!latest.has(run.name) || latest.get(run.name).id < run.id)
      latest.set(run.name, run);
  }
  const verified = [...latest.values()].map((run) => ({
    name: run.name,
    status: run.status?.toUpperCase(),
    conclusion: run.conclusion?.toUpperCase(),
    startedAt: run.started_at,
    completedAt: run.completed_at,
  }));
  const result = evaluateRequiredContexts(
    [...new Set(checks.map((check) => check.context))],
    verified,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Required checks not successful at ${expectedSha}: ${JSON.stringify(result)}`,
    );
  }
}

function readRuns(api, commit) {
  const result = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = api(
      `/repos/${REPOSITORY}/commits/${commit}/check-runs?filter=latest&per_page=100&page=${page}`,
    );
    if (!Array.isArray(data.check_runs))
      throw new Error('Malformed check runs.');
    result.push(...data.check_runs);
    if (data.check_runs.length < 100) return result;
  }
  throw new Error('Check-run pagination limit reached.');
}

function verifyReview(number, head, env, run) {
  const result = run(
    process.execPath,
    [
      path.join(ROOT, 'scripts/verify-squad-verdict.mjs'),
      '--repo',
      REPOSITORY,
      '--pr',
      String(number),
      '--expected-head',
      head,
      '--json',
    ],
    { encoding: 'utf8', env },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Current source-head review is not usable: ${result.stderr || result.stdout || result.error}`,
    );
  }
  const verdict = JSON.parse(result.stdout);
  if (
    !['REVIEWED', 'APPROVED'].includes(verdict.classification) ||
    verdict.reviewedHeadSha !== head
  ) {
    throw new Error(
      'Review verifier did not return usable evidence at the source head.',
    );
  }
}

const fingerprint = (pull) =>
  JSON.stringify({
    head: pull.headRefOid,
    base: pull.baseSha,
    entry: pull.mergeQueueEntry,
  });

export function checkDevelopmentQueue(
  { number, head, enqueue = false },
  api,
  verify = () => {
    throw new Error('Review verifier is required.');
  },
) {
  const policy = readQueuePolicy(api);
  if (policy.mode !== 'queue') {
    throw new Error(
      'Queue not activated. Keep strict freshness checks; do not enqueue or bypass.',
    );
  }
  const pull = readQueuePull(api, number);
  assertQueuePull(pull, head);
  verify(number, head);
  checkQueueRuns(policy.checks, readRuns(api, head), head);
  if (pull.mergeQueueEntry) {
    const entry = pull.mergeQueueEntry;
    if (
      Number.isSafeInteger(entry.position) &&
      entry.position >= 1 &&
      ['QUEUED', 'AWAITING_CHECKS'].includes(entry.state) &&
      (entry.state === 'QUEUED' ||
        entry.position > 1 ||
        entry.headCommit == null)
    ) {
      throw new Error(
        'Entry is waiting its turn in the serialized queue, not yet verified. Recheck later; do not rebase or bypass.',
      );
    }
    const group = {
      base_ref: 'refs/heads/development',
      base_sha: entry.baseCommit?.oid,
      head_sha: entry.headCommit?.oid,
    };
    assertGroupBinding(pull, group);
    const runs = readRuns(api, group.head_sha);
    checkQueueRuns(policy.checks, runs, group.head_sha);
    const runIds = new Set(
      runs
        .filter((check) =>
          policy.checks.some(
            (required) =>
              required.context === check.name &&
              required.appId === check.app?.id,
          ),
        )
        .map(
          (check) =>
            /\/actions\/runs\/(\d+)\//.exec(check.details_url ?? '')?.[1],
        ),
    );
    for (const id of runIds) {
      if (!id)
        throw new Error('Cannot attribute group check to a workflow run.');
      const run = api(`/repos/${REPOSITORY}/actions/runs/${id}`);
      if (
        run.event !== 'merge_group' ||
        run.head_sha !== group.head_sha ||
        run.status !== 'completed' ||
        run.conclusion !== 'success'
      ) {
        throw new Error(
          'Check is not a successful merge_group workflow at the current group head.',
        );
      }
    }
  }
  const again = readQueuePull(api, number);
  assertQueuePull(again, head);
  if (
    fingerprint(again) !== fingerprint(pull) ||
    JSON.stringify(readQueuePolicy(api)) !== JSON.stringify(policy)
  ) {
    throw new Error(
      'Head, base, group, or live policy changed during verification. Re-read all evidence.',
    );
  }
  if (enqueue && !pull.mergeQueueEntry) {
    const response = api('graphql', {
      query: `mutation {
        enqueuePullRequest(input:{pullRequestId:${JSON.stringify(pull.id)},
          expectedHeadOid:"${head}",jump:false}) {
          mergeQueueEntry { id pullRequest { headRefOid } }
        }
      }`,
    });
    const entry = response.data?.enqueuePullRequest?.mergeQueueEntry;
    if (!entry?.id || entry.pullRequest?.headRefOid !== head) {
      throw new Error(
        'Enqueue outcome unknown; inspect live membership before retrying.',
      );
    }
    const queued = readQueuePull(api, number);
    assertQueuePull(queued, head);
    if (
      queued.mergeQueueEntry?.id !== entry.id ||
      queued.baseSha !== pull.baseSha ||
      JSON.stringify(readQueuePolicy(api)) !== JSON.stringify(policy)
    ) {
      throw new Error(
        'Enqueued, but membership/base/policy moved: inspect queue immediately; no verified completion.',
      );
    }
    return 'Enqueued exact reviewed source head; combined-result CI must still pass. Not merged.';
  }
  return pull.mergeQueueEntry
    ? 'Current queue group checks passed. GitHub alone performs the serialized merge; re-read before any later action.'
    : 'Eligible to enqueue despite source branch age. No combined-result evidence yet; not authorization for direct merge.';
}

// Runs inside the existing required Sequencing hold context, using the base's
// trusted scripts and a read-only token. It cannot read admin-only protection.
export function verifyQueueEvent(event, api, verify) {
  const group = event.merge_group;
  const match =
    /^refs\/heads\/gh-readonly-queue\/development\/pr-([1-9]\d*)-/.exec(
      group?.head_ref ?? '',
    );
  if (!match || !sha(group.base_sha) || !sha(group.head_sha)) {
    throw new Error('Not a recognizable development merge-group event.');
  }
  const rules = api(
    `/repos/${REPOSITORY}/rules/branches/development?per_page=100`,
  );
  const queues =
    Array.isArray(rules) && rules.filter((rule) => rule.type === 'merge_queue');
  if (
    !queues ||
    rules.length >= 100 ||
    queues.length !== 1 ||
    !validQueueRuleset(
      api(`/repos/${REPOSITORY}/rulesets/${queues[0].ruleset_id}`),
    )
  ) {
    throw new Error(
      'Serialized, non-bypassable development queue is not active.',
    );
  }
  const number = Number(match[1]);
  const pull = readQueuePull(api, number);
  assertQueuePull(pull, pull.headRefOid);
  assertGroupBinding(pull, group);
  const comparison = api(
    `/repos/${REPOSITORY}/compare/${pull.headRefOid}...${group.head_sha}`,
  );
  if (
    !['ahead', 'identical'].includes(comparison.status) ||
    comparison.behind_by !== 0
  ) {
    throw new Error(
      'Current source head is not contained in this merge group.',
    );
  }
  verify(number, pull.headRefOid);
  const again = readQueuePull(api, number);
  assertQueuePull(again, pull.headRefOid);
  assertGroupBinding(again, group);
  if (fingerprint(pull) !== fingerprint(again))
    throw new Error('Queue evidence changed during verification.');
  return 'Live queue membership, source-head review, holds and threads verified for this combined result.';
}

export function main(argv, env = process.env, run = spawnSync) {
  try {
    const api = createQueueApi(env, run);
    const verify = (number, head) => verifyReview(number, head, env, run);
    if (argv.length === 1 && argv[0] === '--event') {
      if (env.GITHUB_EVENT_NAME !== 'merge_group')
        throw new Error('--event requires merge_group.');
      console.log(
        verifyQueueEvent(
          JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
          api,
          verify,
        ),
      );
      return 0;
    }
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--enqueue') args.enqueue = true;
      else if (['--pr', '--head'].includes(argv[index])) {
        args[argv[index].slice(2)] = argv[++index];
      } else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!/^[1-9]\d*$/.test(args.pr ?? '') || !sha(args.head)) {
      throw new Error(
        'usage: npm run check:development-queue -- --pr N --head REVIEWED_SHA [--enqueue]',
      );
    }
    console.log(
      checkDevelopmentQueue(
        { number: Number(args.pr), head: args.head, enqueue: args.enqueue },
        api,
        verify,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`Queue verification refused: ${error.message}`);
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
