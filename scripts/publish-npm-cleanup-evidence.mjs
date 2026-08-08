import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CLEANUP_EVIDENCE_FILENAME,
  CLEANUP_FAILURE_ANCHOR,
} from './npm-ci-strict.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const CLEANUP_TRACKING_ISSUE = 626;
export const CLEANUP_ARTIFACT_PREFIX = 'npm-cleanup-evidence-';
export const MAXIMUM_EVIDENCE_ARTIFACT_BYTES = 64 * 1024;
export const MAXIMUM_EVIDENCE_ARTIFACTS = 20;
export const CLEANUP_ARTIFACT_OUTPUT = 'has_cleanup_evidence';
export const CLEANUP_ARTIFACT_IDS_OUTPUT = 'cleanup_evidence_artifact_ids';
export const CLEANUP_SOURCE_WORKFLOWS = Object.freeze([
  'CI',
  'Release (signed)',
  'Release GPU qualification',
]);

function isBoundedLine(value, maximumLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\r\n]/.test(value)
  );
}

export function validateCleanupEvidence(evidence, expected = {}) {
  if (typeof evidence !== 'object' || evidence === null) {
    throw new TypeError('cleanup evidence must be an object');
  }
  if (evidence.anchor !== CLEANUP_FAILURE_ANCHOR) {
    throw new Error(
      `cleanup evidence anchor must be exactly "${CLEANUP_FAILURE_ANCHOR}"`,
    );
  }
  for (const field of [
    'repository',
    'runId',
    'runAttempt',
    'headSha',
    'job',
    'workflow',
  ]) {
    if (typeof evidence[field] !== 'string' || evidence[field].trim() === '') {
      throw new Error(`cleanup evidence has no ${field}`);
    }
  }
  if (!Array.isArray(evidence.cleanupPaths)) {
    throw new Error('cleanup evidence has no cleanupPaths array');
  }
  if (!/^\d+$/.test(evidence.runId)) {
    throw new Error('cleanup evidence runId must contain only digits');
  }
  if (!/^\d+$/.test(evidence.runAttempt)) {
    throw new Error('cleanup evidence runAttempt must contain only digits');
  }
  if (!/^[0-9a-f]{40}$/i.test(evidence.headSha)) {
    throw new Error('cleanup evidence headSha must be a full commit SHA');
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(evidence.job)) {
    throw new Error('cleanup evidence job contains unsupported characters');
  }
  if (!CLEANUP_SOURCE_WORKFLOWS.includes(evidence.workflow)) {
    throw new Error(
      `cleanup evidence workflow ${evidence.workflow} is not an eligible source workflow`,
    );
  }
  if (!isBoundedLine(evidence.runnerOs, 50)) {
    throw new Error('cleanup evidence runnerOs is not a bounded line');
  }
  if (
    evidence.runnerName !== null &&
    evidence.runnerName !== undefined &&
    !isBoundedLine(evidence.runnerName, 100)
  ) {
    throw new Error('cleanup evidence runnerName is not a bounded line');
  }
  if (
    evidence.cleanupPaths.length > 20 ||
    evidence.cleanupPaths.some(
      (entry) =>
        typeof entry !== 'string' || !/^@?[A-Za-z0-9._-]{1,100}$/.test(entry),
    )
  ) {
    throw new Error(
      'cleanup evidence cleanupPaths are not bounded package names',
    );
  }
  if (
    typeof evidence.recovery?.reason !== 'string' ||
    evidence.recovery.reason.length > 500 ||
    /[\r\n]/.test(evidence.recovery.reason)
  ) {
    throw new Error('cleanup evidence recovery reason is not a bounded line');
  }
  if (
    expected.repository !== undefined &&
    evidence.repository !== expected.repository
  ) {
    throw new Error(
      `cleanup evidence repository ${evidence.repository} does not match ${expected.repository}`,
    );
  }
  if (
    expected.runId !== undefined &&
    String(evidence.runId) !== String(expected.runId)
  ) {
    throw new Error(
      `cleanup evidence run ${evidence.runId} does not match ${expected.runId}`,
    );
  }
  if (
    expected.runAttempt !== undefined &&
    String(evidence.runAttempt) !== String(expected.runAttempt)
  ) {
    throw new Error(
      `cleanup evidence attempt ${evidence.runAttempt} does not match ${expected.runAttempt}`,
    );
  }
  if (
    expected.headSha !== undefined &&
    String(evidence.headSha).toLowerCase() !==
      String(expected.headSha).toLowerCase()
  ) {
    throw new Error(
      `cleanup evidence head ${evidence.headSha} does not match ${expected.headSha}`,
    );
  }
  if (
    expected.workflow !== undefined &&
    evidence.workflow !== expected.workflow
  ) {
    throw new Error(
      `cleanup evidence workflow ${evidence.workflow} does not match ${expected.workflow}`,
    );
  }
  return evidence;
}

function inlineCode(value) {
  return `\`${String(value)
    .replaceAll('`', "'")
    .replaceAll(/[\r\n]+/g, ' ')}\``;
}

export function formatCleanupEvidenceComment(evidence) {
  validateCleanupEvidence(evidence);
  const runUrl = `https://github.com/${evidence.repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}`;
  const marker = `<!-- npm-cleanup-failure run=${evidence.runId} attempt=${evidence.runAttempt} job=${evidence.job} -->`;
  return [
    marker,
    '### npm cleanup failure recorded',
    '',
    `- **Run attempt:** [${evidence.runId}/${evidence.runAttempt}](${runUrl})`,
    `- **Head:** ${inlineCode(evidence.headSha)}`,
    `- **Job:** ${inlineCode(evidence.job)}`,
    `- **Runner:** ${inlineCode(
      `${evidence.runnerOs}${evidence.runnerName ? ` / ${evidence.runnerName}` : ''}`,
    )}`,
    `- **Directories npm named:** ${
      evidence.cleanupPaths.length > 0
        ? evidence.cleanupPaths.map((entry) => inlineCode(entry)).join(', ')
        : '(none parsed)'
    }`,
    `- **Automatic recovery:** ${inlineCode(evidence.recovery.reason)}`,
    '',
    'Exact failure anchor:',
    '',
    '```text',
    CLEANUP_FAILURE_ANCHOR,
    '```',
    '',
    'This durable reference is written before any discharge. Do not rerun the',
    'failed jobs directly. Use the **NPM cleanup recovery** workflow with this',
    'run id, exact head SHA, and a specific justification. That workflow refuses',
    `mixed failures and records the authorization on tracking issue #${CLEANUP_TRACKING_ISSUE}`,
    'before it requests a rerun.',
  ].join('\n');
}

/**
 * A fixed issue number embedded in source is a reference to a mutable
 * object: nothing about writing `CLEANUP_TRACKING_ISSUE = <n>` records that
 * the target was ever checked to still be alive. #274 was closed while both
 * publishers kept writing to it — the write succeeds against a closed,
 * unlocked issue, so the failure was silent (#482). Call this immediately
 * before any write to the tracking issue, and hard-fail loudly rather than
 * publishing durable evidence into an issue nobody is watching.
 */
export async function assertTrackingIssueOpen({
  owner,
  repo,
  issueNumber,
  token,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `could not verify cleanup tracking issue #${issueNumber} is open: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  if (payload?.state !== 'open') {
    throw new Error(
      `cleanup tracking issue #${issueNumber} is ${payload?.state ?? 'unknown'}, not open; refusing to publish durable evidence into an unreachable issue`,
    );
  }
  return payload;
}

export async function publishCleanupEvidence({
  owner,
  repo,
  token,
  evidence,
  issueNumber = CLEANUP_TRACKING_ISSUE,
  fetchImpl = fetch,
}) {
  await assertTrackingIssueOpen({ owner, repo, issueNumber, token, fetchImpl });
  const body = formatCleanupEvidenceComment(evidence);
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub REST could not publish cleanup evidence: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  if (typeof payload?.html_url !== 'string') {
    throw new Error(
      'GitHub REST published cleanup evidence but returned no comment URL',
    );
  }
  return payload.html_url;
}

export async function discoverCleanupEvidenceArtifacts({
  owner,
  repo,
  token,
  runId,
  runAttempt,
  fetchImpl = fetch,
}) {
  const attempt = Number(runAttempt);
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new Error(
      `source run attempt must be a positive integer: ${runAttempt}`,
    );
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub REST could not list cleanup evidence artifacts: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.artifacts)) {
    throw new Error('artifact response has no artifacts array');
  }
  if (
    Number.isInteger(payload.total_count) &&
    payload.total_count > payload.artifacts.length
  ) {
    throw new Error(
      `run has ${payload.total_count} artifacts but only ${payload.artifacts.length} were returned`,
    );
  }
  const artifacts = payload.artifacts.filter(
    (artifact) =>
      typeof artifact?.name === 'string' &&
      artifact.name.startsWith(CLEANUP_ARTIFACT_PREFIX) &&
      artifact.name.endsWith(`-attempt-${attempt}`) &&
      artifact.expired !== true,
  );
  if (artifacts.length > MAXIMUM_EVIDENCE_ARTIFACTS) {
    throw new Error(
      `run produced ${artifacts.length} cleanup evidence artifacts; maximum is ${MAXIMUM_EVIDENCE_ARTIFACTS}`,
    );
  }
  for (const artifact of artifacts) {
    if (
      !Number.isInteger(artifact.id) ||
      artifact.id <= 0 ||
      !Number.isInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes <= 0 ||
      artifact.size_in_bytes > MAXIMUM_EVIDENCE_ARTIFACT_BYTES
    ) {
      throw new Error(
        `cleanup evidence artifact ${artifact.name} has invalid size ${artifact.size_in_bytes}`,
      );
    }
  }
  return artifacts;
}

export async function findCleanupEvidenceFiles(root, readdirImpl = readdir) {
  const entries = await readdirImpl(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findCleanupEvidenceFiles(entryPath, readdirImpl)));
    } else if (entry.isFile() && entry.name === 'npm-cleanup-evidence.json') {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export async function markArtifactDiscovery(
  artifacts,
  environment = process.env,
  appendFileImpl = appendFile,
) {
  if (!environment.GITHUB_OUTPUT) {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  const artifactIds = artifacts.map((artifact) => artifact.id).join(',');
  await appendFileImpl(
    environment.GITHUB_OUTPUT,
    [
      `${CLEANUP_ARTIFACT_OUTPUT}=${artifacts.length > 0 ? 'true' : 'false'}`,
      `${CLEANUP_ARTIFACT_IDS_OUTPUT}=${artifactIds}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const { owner, repo } = resolveRepository(process.env);
  const sourceRunId = process.env.SOURCE_RUN_ID;
  const sourceRunAttempt = process.env.SOURCE_RUN_ATTEMPT;
  const sourceWorkflow = process.env.SOURCE_WORKFLOW;
  const sourceConclusion = process.env.SOURCE_CONCLUSION;
  if (!sourceRunId) throw new Error('SOURCE_RUN_ID is not set');
  if (!sourceRunAttempt) throw new Error('SOURCE_RUN_ATTEMPT is not set');
  if (!CLEANUP_SOURCE_WORKFLOWS.includes(sourceWorkflow)) {
    throw new Error(
      `SOURCE_WORKFLOW must identify an eligible cleanup source workflow, received ${sourceWorkflow ?? 'unset'}`,
    );
  }

  if (process.argv.includes('--discover')) {
    if (sourceConclusion !== 'failure') {
      await markArtifactDiscovery([]);
      console.log(
        `Source run concluded ${sourceConclusion ?? 'unknown'}; cleanup failure evidence is not eligible.`,
      );
      return;
    }
    const artifacts = await discoverCleanupEvidenceArtifacts({
      owner,
      repo,
      token,
      runId: sourceRunId,
      runAttempt: sourceRunAttempt,
    });
    await markArtifactDiscovery(artifacts);
    console.log(
      artifacts.length > 0
        ? `Found ${artifacts.length} cleanup evidence artifact(s).`
        : 'No npm cleanup evidence artifacts were produced.',
    );
    return;
  }

  const evidenceRoot = process.env.NPM_CLEANUP_EVIDENCE_DIR;
  const sourceHeadSha = process.env.SOURCE_HEAD_SHA;
  if (!evidenceRoot) throw new Error('NPM_CLEANUP_EVIDENCE_DIR is not set');
  if (!sourceHeadSha) throw new Error('SOURCE_HEAD_SHA is not set');
  if (sourceConclusion !== 'failure') {
    throw new Error(
      `SOURCE_CONCLUSION must be failure, received ${sourceConclusion ?? 'unset'}`,
    );
  }

  const evidenceFiles = await findCleanupEvidenceFiles(evidenceRoot);
  if (evidenceFiles.length === 0) {
    throw new Error(
      `artifact discovery succeeded but no ${CLEANUP_EVIDENCE_FILENAME} file was downloaded`,
    );
  }
  if (evidenceFiles.length > MAXIMUM_EVIDENCE_ARTIFACTS) {
    throw new Error(
      `download contained ${evidenceFiles.length} cleanup evidence files; maximum is ${MAXIMUM_EVIDENCE_ARTIFACTS}`,
    );
  }
  for (const evidencePath of evidenceFiles) {
    const fileMetadata = await stat(evidencePath);
    if (
      !fileMetadata.isFile() ||
      fileMetadata.size <= 0 ||
      fileMetadata.size > MAXIMUM_EVIDENCE_ARTIFACT_BYTES
    ) {
      throw new Error(
        `cleanup evidence file ${evidencePath} has invalid size ${fileMetadata.size}`,
      );
    }
    let evidence;
    try {
      evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `could not read cleanup evidence at ${evidencePath}: ${error.message}`,
      );
    }
    validateCleanupEvidence(evidence, {
      repository: `${owner}/${repo}`,
      runId: sourceRunId,
      runAttempt: sourceRunAttempt,
      headSha: sourceHeadSha,
      workflow: sourceWorkflow,
    });
    const commentUrl = await publishCleanupEvidence({
      owner,
      repo,
      token,
      evidence,
    });
    console.log(`Published durable npm cleanup evidence: ${commentUrl}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`publish-npm-cleanup-evidence: ${error.message}`);
    process.exitCode = 1;
  });
}
