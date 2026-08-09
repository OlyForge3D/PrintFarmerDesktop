/**
 * #231. A pull request body cannot discuss an issue closure without writing the
 * tokens that perform one: GitHub's parser does not read negation, so the
 * sentence "this does not close #N" registers a closing link for #N. Three
 * armed closures were caught by hand on one day, and the third was written by
 * the person who knew the rule best -- because the protective act and the
 * triggering act are the same act.
 *
 * This check compares what a PR *declares* it closes against what GitHub has
 * actually armed, and fails when they differ.
 *
 * #415. The declaration used to be read out of the PR body -- a fenced block
 * chosen (see below) because it is inert to GitHub's closing-keyword parser.
 * That made the declaration a second, *independent* mutable input: the body
 * can be edited without touching the head commit, so a check result pinned to
 * a SHA said nothing about the declaration in place when it ran, or at merge
 * time. #400 merged with seven green contexts, every one of which had judged
 * a body that had since been replaced twice.
 *
 * A check cannot be all three of body-sensitive, required, and re-run on
 * every body edit (job-level `if:` is banned -- a skipped job reports success
 * -- so a required context can never be conditioned on an event a `push` or
 * `merge_group` entry does not carry). The fix is to stop the declaration half
 * from being a body input at all: it is now read from `DECLARATION_FILE_PATH`,
 * a file tracked in the commit tree, via `readDeclarationFile`. `synchronize`
 * already re-runs this check whenever the head commit changes, so "green at
 * SHA X" becomes a true statement about the declaration -- nothing needs to
 * subscribe to `edited` for the declaration half, and editing the body can no
 * longer silently invalidate a passing gate.
 *
 * Arming stays in the body: GitHub's own closing-keyword parser reads the
 * body and that is not ours to change. `parseBoundClosures` below, and the
 * witness machinery around it, are therefore unchanged -- only the source of
 * `declared` moved. Measured on a live pull request, with a bare keyword as
 * the positive control, at a time when the declaration was still read from
 * the body and had to hide from this same parser:
 *
 *   bare        closes #N        -> closingIssuesReferences = [N]   BINDS
 *   fenced      ```closes #N```  -> []                              inert
 *   inline code `closes #N`      -> []                              inert
 *   no reference                 -> []                              inert
 *
 * The declaration file reuses the fenced-block format purely for continuity
 * with that convention and the parser tested against it; nothing in the file
 * is read by GitHub's closing-keyword parser, because GitHub does not scan
 * repository file contents for closing keywords at all.
 *
 * Absence of a declaration (no file, or a file with no fenced block) means
 * the PR declares nothing, so any armed closure is a mismatch. That is
 * deliberate and fail-closed: the hazard is a closure nobody intended, and a
 * check that treats silence as consent cannot see it.
 *
 * #622. `DECLARATION_FILE_PATH` was a single shared file every PR edited to
 * declare its own closure, which meant every pair of concurrently-open PRs
 * conflicted on it -- guaranteed by the design, not bad luck (12 of 20
 * commits on `development` touched it; a live rotation caught #619, #610 and
 * #620 each `CONFLICTING` in turn within one ten-minute window, purely on
 * this file, with `git merge-tree` confirming no implementation-file
 * conflict). The declaration now lives at one file PER PR, keyed by a
 * sanitised slug of the head branch name (`declarationFilePathForBranch`), so
 * concurrent PRs on different branches touch disjoint paths and cannot
 * conflict with each other on this half of the check. Every #415 property is
 * unchanged: the declaration still lives in the commit tree, at a path
 * resolved from the branch of the exact head commit this run checks out
 * (`GITHUB_HEAD_REF`, or `gh pr view --json headRefName` when that is unset,
 * as on `merge_group`), so it still changes only via a commit and `synchronize`
 * still re-runs the check when it changes.
 *
 * Migration: a PR whose branch has no file under `PR_CLOSES_DIR` falls back
 * to reading the legacy shared `DECLARATION_FILE_PATH`, so every PR open
 * before this change keeps working, unmigrated, exactly as before -- still
 * subject to the old shared-file contention among the PRs that haven't moved,
 * but not with any PR that has. A PR migrates simply by adding its own file
 * under `PR_CLOSES_DIR`; nothing needs to delete the legacy file's content for
 * that PR, because the per-branch file is checked first and wins outright.
 *
 * #563. Exit code 1 used to mean two different things: "I looked, and the
 * declaration does not match what GitHub armed" (a real defect in the PR),
 * and "I never got far enough to compare the two at all" (no PR number could
 * be resolved, `gh` failed outside a git/PR context, the declaration file was
 * unreadable, or the API returned something this parser could not read as
 * `{ body, refs }`). An agent -- or a human -- reading a red required check
 * cannot tell those apart from the exit code alone, which risks "fixing" a
 * PR body that this run never actually judged.
 *
 * This file now follows the exit-code convention already used elsewhere in
 * this repo (`check-behind-base.mjs`, `check-citation-reachability.mjs`):
 *
 *   exit 0 -- looked, and the declaration matches what GitHub armed.
 *   exit 1 -- looked, and found a genuine mismatch. A real defect in the PR.
 *   exit 2 -- could not look at all. No verdict either way: not a pass, not
 *             a fail. Covers no git-repository/PR context, an unresolvable
 *             PR number, an unreadable declaration file, a `gh` failure, or
 *             a response this parser could not read.
 *
 * Every exception that reaches `main`'s own `try`/`catch` is, by
 * construction, a "could not look" failure: the two branches that decide a
 * genuine mismatch (`!result.ok`) and an inconclusive-but-observed read
 * (`!settled`) both `return` rather than `throw`, so nothing that represents
 * an actual completed comparison ever reaches that `catch`. That is what
 * makes a single, uniform `process.exitCode = 2` there correct rather than
 * merely convenient: anything landing in it is -- unconditionally -- a
 * failure to look, never a look that found a defect.
 */

import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolvePullRequestNumber } from './check-pr-closure-scope.mjs';

const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

const AUTHENTICATION_FAILURE =
  /\b(?:HTTP\s+401|bad credentials|authentication (?:failed|required)|not logged into any github hosts|gh auth login|invalid (?:oauth )?token|token (?:has )?(?:expired|invalid))\b/i;
const RATE_LIMIT_FAILURE =
  /\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\b(?:api |secondary )?rate limit(?:ed| exceeded)?\b|\babuse detection\b/i;
const RETRYABLE_SERVER_FAILURE =
  /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:408|425|500|502|503|504)\b/i;
const RETRYABLE_TRANSPORT_FAILURE =
  /\b(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b|error connecting to (?:api\.)?github\.com|connection (?:closed|refused|reset|timed out)|TLS handshake timeout|client\.timeout exceeded|context deadline exceeded|temporary failure in name resolution|could not resolve host|no such host|dial tcp|forcibly closed by the remote host/i;

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function outputText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').trim();
  }
  return '';
}

function errorMessage(value) {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  const record = asRecord(value);
  return typeof record?.message === 'string' ? record.message : '';
}

function errorCode(record) {
  const direct = record?.code;
  if (typeof direct === 'string' || typeof direct === 'number') {
    return direct;
  }
  const nested = asRecord(record?.cause)?.code;
  return typeof nested === 'string' || typeof nested === 'number'
    ? nested
    : null;
}

/**
 * Typed boundary around `execFileSync`'s platform-dependent thrown object.
 *
 * The original object remains the cause. The fields used for classification
 * are copied so a later layer never has to guess them back out of a rendered
 * message, and fields not recognized here remain available through `cause`.
 */
export class GitHubCliError extends Error {
  constructor({ args, status, stderr, stdout, code, signal, cause }) {
    const metadata = [
      status === null ? '' : `status=${status}`,
      code === null ? '' : `code=${code}`,
      signal === null ? '' : `signal=${signal}`,
    ].filter(Boolean);
    const detail = stderr || errorMessage(cause) || 'no diagnostic output';
    super(
      `gh ${args.join(' ')} failed${
        metadata.length === 0 ? '' : ` (${metadata.join(', ')})`
      }: ${detail}`,
      { cause },
    );
    this.name = 'GitHubCliError';
    this.args = [...args];
    this.status = status;
    this.stderr = stderr;
    this.stdout = stdout;
    this.code = code;
    this.signal = signal;
  }
}

export function toGitHubCliError(args, cause) {
  if (cause instanceof GitHubCliError) {
    return cause;
  }
  const record = asRecord(cause);
  const status =
    typeof record?.status === 'number' && Number.isInteger(record.status)
      ? record.status
      : null;
  const signal = typeof record?.signal === 'string' ? record.signal : null;
  return new GitHubCliError({
    args,
    status,
    stderr: outputText(record?.stderr),
    stdout: outputText(record?.stdout),
    code: errorCode(record),
    signal,
    cause,
  });
}

export class MalformedClosingReferenceResponseError extends Error {
  constructor(reason, responseLength, cause) {
    const detail = errorMessage(cause);
    super(
      `gh returned a malformed closing-reference response (${reason}, ${responseLength} bytes)${
        detail === '' ? '' : `: ${detail}`
      }`,
      { cause },
    );
    this.name = 'MalformedClosingReferenceResponseError';
    this.reason = reason;
    this.responseLength = responseLength;
  }
}

/**
 * Parses only the response shape emitted by `main`'s combined-field query.
 * Invalid JSON and schema drift are wrapped separately so only truncation-like
 * JSON failures are retryable; a valid response with the wrong shape aborts.
 */
export function parseClosingReferenceResponse(raw) {
  if (typeof raw !== 'string') {
    throw new MalformedClosingReferenceResponseError(
      'invalid-shape',
      0,
      new TypeError('expected a string response'),
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MalformedClosingReferenceResponseError(
      'invalid-json',
      raw.length,
      cause,
    );
  }

  const record = asRecord(parsed);
  if (
    typeof record?.body !== 'string' ||
    !Array.isArray(record.refs) ||
    !record.refs.every(
      (value) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new MalformedClosingReferenceResponseError(
      'invalid-shape',
      raw.length,
      new TypeError('expected { body: string, refs: positive integer[] }'),
    );
  }

  return { body: record.body, refs: [...record.refs] };
}

/**
 * Closed classification: only errors produced by the two boundaries above can
 * be retried. Authentication and every unrecognized `gh` failure abort; an
 * arbitrary Error (including an unrelated SyntaxError) also aborts.
 */
export function classifyClosingReferenceReadError(error) {
  if (error instanceof MalformedClosingReferenceResponseError) {
    if (error.reason === 'invalid-shape') {
      return {
        disposition: 'abort',
        reason: 'invalid-response-shape',
        error,
      };
    }
    return {
      disposition: 'retry',
      reason: 'malformed-response',
      error,
    };
  }

  if (!(error instanceof GitHubCliError)) {
    return { disposition: 'abort', reason: 'unknown', error };
  }

  const text = [
    error.stderr,
    error.message,
    error.code === null ? '' : String(error.code),
    errorMessage(error.cause),
  ].join('\n');

  if (AUTHENTICATION_FAILURE.test(text)) {
    return { disposition: 'abort', reason: 'authentication', error };
  }
  if (RATE_LIMIT_FAILURE.test(text)) {
    return { disposition: 'retry', reason: 'rate-limit', error };
  }
  if (RETRYABLE_SERVER_FAILURE.test(text)) {
    return { disposition: 'retry', reason: 'server', error };
  }

  const code =
    typeof error.code === 'string' ? error.code.toUpperCase() : error.code;
  if (
    (typeof code === 'string' && RETRYABLE_TRANSPORT_CODES.has(code)) ||
    RETRYABLE_TRANSPORT_FAILURE.test(text)
  ) {
    return { disposition: 'retry', reason: 'transport', error };
  }

  return { disposition: 'abort', reason: 'terminal-gh', error };
}

export class ClosingReferenceReadBudgetError extends Error {
  constructor({
    attempts,
    successfulReads,
    retryableFailures,
    elapsedMs,
    lastFailure,
    lastFailureReason,
    lastValue,
  }) {
    const seconds = Math.round(elapsedMs / 1000);
    const attemptNoun = attempts === 1 ? 'attempt' : 'attempts';
    const readNoun = successfulReads === 1 ? 'read' : 'reads';
    const failureNoun = retryableFailures === 1 ? 'failure' : 'failures';
    const lastValueLine =
      lastValue === null
        ? 'No read succeeded, so there is no closing-reference value to report.'
        : `Last successful value: [${lastValue.join(', ')}]. It is not trusted because the read never settled.`;
    super(
      [
        `Closing-reference read retry budget exhausted after ${attempts} ${attemptNoun} over ${seconds}s ` +
          `(${successfulReads} successful ${readNoun}, ${retryableFailures} retryable ${failureNoun}).`,
        `Last retryable failure (${lastFailureReason}): ${lastFailure.message}`,
        lastValueLine,
        'Re-run this required check. If it persists, inspect gh/API connectivity and the response diagnostics above.',
      ].join('\n'),
      { cause: lastFailure },
    );
    this.name = 'ClosingReferenceReadBudgetError';
    this.attempts = attempts;
    this.successfulReads = successfulReads;
    this.retryableFailures = retryableFailures;
    this.elapsedMs = elapsedMs;
    this.lastFailureReason = lastFailureReason;
    this.lastValue = lastValue === null ? null : [...lastValue];
  }
}

/** Fenced block whose info string is exactly `closes`. */
const DECLARATION_FENCE = /^```closes[^\S\n]*$([\s\S]*?)^```[^\S\n]*$/gm;

/**
 * Legacy shared declaration file, from before #622. Tracked in the commit
 * tree so `synchronize` -- an event every required-context workflow already
 * receives -- re-runs this check whenever the declaration changes. See the
 * module header (#415) for why this moved out of the PR body, and (#622) for
 * why a single shared path was replaced by one file per PR.
 *
 * Kept only as a migration fallback: a PR opened before #622 that has not
 * added its own file under `PR_CLOSES_DIR` is still read from here, so it
 * keeps working unmigrated. Any PR with a file under `PR_CLOSES_DIR` never
 * touches this path.
 */
export const DECLARATION_FILE_PATH = '.github/PR_CLOSES.md';

/**
 * Directory holding one declaration file per PR (#622), keyed by a sanitised
 * slug of the PR's head branch name. Concurrent PRs on different branches
 * write to disjoint paths under this directory, so they cannot conflict with
 * each other the way every pair sharing `DECLARATION_FILE_PATH` did.
 */
export const PR_CLOSES_DIR = '.github/pr-closes';

/**
 * Sanitises a branch name into a filesystem- and git-safe slug: lowercase,
 * runs of anything other than `[a-z0-9]` collapsed to a single `-`, leading
 * and trailing `-` trimmed. Two branches that differ only in case or in
 * separator characters would otherwise collide on one file, silently
 * reintroducing the shared-slot hazard this change removes.
 */
export function slugifyBranchName(branchName) {
  if (typeof branchName !== 'string' || branchName.trim() === '') {
    throw new Error(
      `cannot derive a declaration file path from an empty branch name: ${JSON.stringify(branchName)}`,
    );
  }
  const slug = branchName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new Error(
      `branch name ${JSON.stringify(branchName)} has no characters usable in a file name`,
    );
  }
  return slug;
}

/** Where a PR's declaration lives, given its head branch name. */
export function declarationFilePathForBranch(branchName) {
  return `${PR_CLOSES_DIR}/${slugifyBranchName(branchName)}.md`;
}

/**
 * The head branch name for `prNumber`, without a network call in the common
 * case. `GITHUB_HEAD_REF` is populated by GitHub Actions on every
 * `pull_request` event without an API call; it is empty on `merge_group`
 * (there the queue's own synthetic ref is what `GITHUB_HEAD_REF` would name,
 * not the original branch), so that case falls back to asking `gh` directly.
 */
export function resolveHeadBranchName(
  prNumber,
  { run = gh, environment = process.env } = {},
) {
  const fromEvent = environment.GITHUB_HEAD_REF;
  if (typeof fromEvent === 'string' && fromEvent.trim() !== '') {
    return fromEvent;
  }
  return run([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'headRefName',
    '--jq',
    '.headRefName',
  ]);
}

/** The declaration file path this PR is judged against. */
export function resolveDeclarationPath(prNumber, options = {}) {
  return declarationFilePathForBranch(resolveHeadBranchName(prNumber, options));
}

/**
 * Reads the declaration file from the checked-out worktree.
 *
 * A missing file is not an error: it means the PR declares nothing, which
 * `parseDeclaredClosures` already renders as `{ hasBlock: false, declared: [] }`
 * -- the same fail-closed state a body with no fenced block produced before
 * #415. Any other read failure (permissions, a directory at that path) is not
 * swallowed, because that is not "no declaration", it is "declaration
 * unreadable", and the two must not be reported identically.
 */
export function readDeclarationFile(filePath = DECLARATION_FILE_PATH) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * Reads the declaration for `prNumber`: its own file under `PR_CLOSES_DIR`
 * when one exists, otherwise the legacy shared file (#622 migration path).
 * `existsSync` is used rather than treating an ENOENT from `readDeclarationFile`
 * as "fall back", because an existing-but-empty per-PR file is itself a valid
 * declaration ("closes nothing") and must not be overridden by the legacy
 * file's contents.
 */
export function readDeclarationForPullRequest(prNumber, options = {}) {
  const path = resolveDeclarationPath(prNumber, options);
  if (existsSync(path)) {
    return readDeclarationFile(path);
  }
  return readDeclarationFile(DECLARATION_FILE_PATH);
}

/**
 * Reads the declared closure set out of the declaration source (#415: the
 * tracked file at `DECLARATION_FILE_PATH`, not the PR body).
 *
 * `hasBlock` is reported separately from an empty set because they are
 * different states with the same list: "declares nothing" and "declares
 * explicitly that it closes nothing" both yield [], and only the second is an
 * assertion by the author.
 */
export function parseDeclaredClosures(body) {
  const source = typeof body === 'string' ? body.replace(/\r\n/g, '\n') : '';
  const declared = new Set();
  let hasBlock = false;

  for (const match of source.matchAll(DECLARATION_FENCE)) {
    hasBlock = true;
    for (const line of match[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#!')) {
        continue;
      }
      const ref = /^#(\d+)$/.exec(trimmed);
      if (!ref) {
        throw new Error(
          `closes block contains a line that is not a bare issue reference: ${JSON.stringify(trimmed)}. ` +
            'Write one "#123" per line, nothing else.',
        );
      }
      declared.add(Number(ref[1]));
    }
  }

  return { hasBlock, declared: [...declared].sort((a, b) => a - b) };
}

/**
 * GitHub's closing keywords, as documented.
 *
 * The separator is `[\s:]+`, not `\s+`. Both accepted forms are individually
 * measured, and only those two:
 *
 *   whitespace  `${keyword} #231`  -- documented, and armed on PR #231
 *   colon       `${keyword}: #436` -- armed on PR #554, where the ordinary
 *   prose phrase "regardless of that fix: #436" held #436 in
 *   closingIssuesReferences across 13 guard reads (settled=true,
 *   stableMs=65120), and deleting that phrase alone retracted it on read 1.
 *   Nothing else in that body armed 436. See #558.
 *
 * No other separator is claimed. The comment this replaces said "as measured
 * on this repo" of a pattern the colon measurement above falsifies, which is
 * the unbacked-prose failure this module exists to eliminate. Widening past
 * these two would repeat it: each addition needs its own live measurement, and
 * the module's standing objection to reproducing GitHub's grammar (below)
 * still forbids guessing at the rest of it.
 */
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+#(\d+)/gi;

/** Regions GitHub does not read closing references out of. Measured on PR #352. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const FENCED_BLOCK = /^```[\s\S]*?^```[^\S\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * The references a body would bind, used ONLY as a staleness witness.
 *
 * `closingIssuesReferences` is DERIVED from the body. Read the two together
 * and they become mutually checkable: if the body in a response carries a
 * live closing reference while the derived field in that SAME response is
 * empty, the response is internally inconsistent, and the derived half is the
 * stale one. That is the only way found to detect the failure this module's
 * header calls undecidable -- not by watching the value, which is exactly what
 * cannot work, but by reading the thing it is computed FROM. A derived field
 * and its source, read together, are a freshness witness; either alone is not.
 *
 * Deliberately used in one direction only, and deliberately NOT fatal.
 *
 * A witness that fires when the derived field is NON-empty would be asserting
 * that this function reproduces GitHub's parser, which it does not and should
 * not try to: that is a hard-coded claim about someone else's grammar, and it
 * goes stale toward the FALSE RED -- GitHub adds a keyword, a correct PR goes
 * red. Compare #146.
 *
 * An earlier revision kept the `derived is empty` direction on the grounds
 * that it left "the cost of being wrong bounded to a retry". Three reviewers
 * refuted that, and the argument above is why: this direction encodes the
 * claim `GitHub WOULD have bound this number`, which is the same kind of
 * claim about the same grammar. Measured cases where it is false, all with
 * the correct derived value of []:
 *
 *   ~~~ fences, indented fences, 4-space indented blocks, inline code
 *   spanning a newline   -- code to GitHub, prose to the regexes above
 *   `closes #349` where #349 is a PULL REQUEST -- closingIssuesReferences
 *   holds issues only, and this repo cross-references PRs routinely
 *   a nonexistent, cross-repo, or `owner/repo#n` number
 *
 * And the bound was not real. The input is the PR body, which is
 * deterministic, so every re-run reproduces the verdict: the failure told the
 * author nothing was wrong and to retry, and retrying could never clear it.
 * A false red an author cannot clear is worse than the missed detection it
 * was bought with, so the caller reports this and does not fail on it.
 */
export function parseBoundClosures(body) {
  const source = typeof body === 'string' ? body.replace(/\r\n/g, '\n') : '';
  const prose = source
    .replace(HTML_COMMENT, '')
    .replace(FENCED_BLOCK, '')
    .replace(INLINE_CODE, '');
  const bound = new Set();
  for (const match of prose.matchAll(CLOSING_KEYWORD)) {
    bound.add(Number(match[1]));
  }
  return [...bound].sort((a, b) => a - b);
}

/**
 * Read closing references from commit messages.
 *
 * Unlike pull request bodies, commit messages have no markdown regions that
 * GitHub treats as inert. In particular, quoting a closing phrase does not
 * protect it. The whitespace separator deliberately spans newlines: commit
 * 0ab96610 closed #435 when ordinary paragraph wrapping separated the keyword
 * from the issue number.
 */
export function parseCommitClosures(messages) {
  if (!Array.isArray(messages)) {
    throw new TypeError(
      'expected commit messages to be an array; refusing to report no commit closures from an unreadable value',
    );
  }

  const bound = new Set();
  for (const message of messages) {
    if (typeof message !== 'string') {
      throw new TypeError(
        'expected every commit message to be a string; refusing to treat an unreadable commit as closure-free',
      );
    }
    for (const match of message.matchAll(CLOSING_KEYWORD)) {
      bound.add(Number(match[1]));
    }
  }
  return [...bound].sort((a, b) => a - b);
}

/**
 * Parse every page returned by `gh api --paginate --slurp`.
 *
 * Keeping the page boundary in the response makes truncation visible in tests
 * and avoids a first-page-only implementation that silently misses commit 101.
 */
export function parsePullRequestCommitResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(
      'expected the pull request commit response to be a string',
    );
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
      'pull request commit response is not an array of pages; refusing to report no commit closures from an unreadable response',
    );
  }

  return pages.flatMap((page) =>
    page.map((entry) => {
      const message = entry?.commit?.message;
      if (typeof message !== 'string') {
        throw new TypeError(
          'pull request commit entry has no message string; refusing to treat an unreadable commit as closure-free',
        );
      }
      return message;
    }),
  );
}

export function readPullRequestCommitClosures(prNumber, run) {
  const raw = run([
    'api',
    '--paginate',
    '--slurp',
    `repos/{owner}/{repo}/pulls/${prNumber}/commits?per_page=100`,
  ]);
  return parseCommitClosures(parsePullRequestCommitResponse(raw));
}

/**
 * A settled read that its own source contradicts.
 *
 * Returns the references the body implies and the derived field lacks. Empty
 * means no contradiction -- which is NOT the same as "the read is fresh", and
 * the caller must not read it that way. This detects one stale case: the one
 * where staleness is invisible precisely because the stale value, `[]`, is
 * also the correct answer for most pull requests, so it fails toward passing.
 */
export function witnessContradiction(body, derived) {
  if (derived.length > 0) {
    return [];
  }
  return parseBoundClosures(body);
}

/**
 * The other direction, and the one `witnessContradiction` deliberately leaves
 * alone: a NON-EMPTY derived field beside a body that binds nothing readable.
 *
 * Reachable and measured: with the declaration block still listing #231 and
 * the live `fix`+`es #231` removed from the prose, a derived field still
 * holding `[231]` matches the declaration and `main` returns ok. The same
 * fixture fails the moment the read is fresh, so the pass is caused by the
 * staleness rather than by the fixture.
 *
 * Reported, never fatal, and the narrowness is the whole point. Firing
 * whenever the two sets merely DISAGREE would assert that
 * `parseBoundClosures` reproduces GitHub's grammar. It does not, measured
 * against a positive control that returns [123] for a bare reference:
 *
 *   fix+es OlyForge3D/PrintFarmerDesktop#123   -> []   cross-repo
 *   fix+es GH-123                              -> []   GH- form
 *   fix+es https://github.com/o/r/issues/123   -> []   issue URL
 *
 * GitHub binds all three. Failing on them would be a red no author could
 * clear by any action the message names -- #146's shape, which is the thing
 * this check exists to avoid. So this fires only when the parser sees NO
 * binding construct anywhere, which is the narrowest form that still covers
 * the case above, and it moves `stale`, never the exit code.
 */
export function witnessUnreadableBinding(body, derived) {
  if (derived.length === 0) {
    return [];
  }
  if (parseBoundClosures(body).length > 0) {
    return [];
  }
  return [...derived].sort((a, b) => a - b);
}

/** Set comparison, reported as the two directions rather than a boolean. */
export function compareClosures(declared, actual) {
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);
  const unexpected = [...actualSet]
    .filter((n) => !declaredSet.has(n))
    .sort((a, b) => a - b);
  const missing = [...declaredSet]
    .filter((n) => !actualSet.has(n))
    .sort((a, b) => a - b);
  return {
    ok: unexpected.length === 0 && missing.length === 0,
    unexpected,
    missing,
  };
}

/**
 * `closingIssuesReferences` is eventually consistent. A read taken straight
 * after an edit returns the pre-edit value -- measured at roughly 38-45 seconds
 * to settle -- and the arming event this check exists to catch is a retarget,
 * which is an edit. So a single read is the one implementation guaranteed to
 * report the value the check was written to replace.
 *
 * "Poll until the value stops changing" is the obvious remedy and it does not
 * work, which the tests for this function demonstrate directly: a value that
 * has not arrived yet is perfectly stable, so two agreeing reads settle on the
 * stale answer and report `settled: true` about it. Stability distinguishes
 * "changing" from "not changing"; it cannot distinguish "not yet" from "never",
 * because those are the same observation.
 *
 * The only thing that separates them is elapsed time against a measured
 * settling interval, so this requires BOTH a wall-clock floor and agreement.
 * The floor is the load-bearing half; agreement alone is decoration.
 *
 * The floor is therefore measured from the start of the CURRENT AGREEMENT RUN,
 * not from the start of polling. Those are different quantities and only the
 * first one is the claim being made. Anchored to the start of polling, the
 * floor answers "have we been asking for a minute", when what makes a value
 * trustworthy is "has it held still for a minute" -- so a value that churned
 * for a minute and then agreed twice five seconds apart cleared a
 * sixty-second floor. Worse, that arrangement is perverse in the direction
 * that matters: the longer the field was unstable, the more elapsed time
 * accrued toward the threshold, so instability made the guard EASIER to
 * satisfy rather than harder.
 *
 * `stableMs` is reported alongside `elapsedMs` because a caller cannot derive
 * one from the other, and it is the one the verdict rests on.
 *
 * A retryable failed probe resets the agreement run. It did not observe a
 * contradictory value, but it also cannot support the claim that the value
 * held still through that point. Preserving continuity would let a failure one
 * read before the normal settle point disappear into a passing result on the
 * next read. Resetting costs another floor but stays within the coupled budget.
 */
export async function readSettled(read, options = {}) {
  const {
    requiredAgreements = 2,
    // The budget is COUPLED to the floor and cannot be tuned apart from it.
    // Tightening the floor to the agreement run means the value must arrive
    // AND then hold still, so the budget has to cover both: worst measured
    // arrival (45s) + floor (60s) = 105s. At the previous 20 reads the budget
    // was 95s, and the earliest possible settle became 98s -- unreachable, so
    // every armed pull request would have reported unsettled and gone red.
    // A stricter floor without a wider budget does not make the check safer,
    // it converts a false pass into a false red on every subject.
    maxReads = 40,
    delayMs = 5000,
    minElapsedMs = 60000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const start = now();
  let previous;
  let agreements = 0;
  let reads = 0;
  let successfulReads = 0;
  let retryableFailures = 0;
  let lastRetryableFailure;
  let lastValue = [];
  let agreementStart = start;

  for (let i = 0; i < maxReads; i += 1) {
    if (i > 0) {
      await sleep(delayMs);
    }
    reads += 1;
    let value;
    try {
      value = await read();
    } catch (error) {
      const classification = classifyClosingReferenceReadError(error);
      if (classification.disposition === 'abort') {
        throw classification.error;
      }

      retryableFailures += 1;
      lastRetryableFailure = classification;
      previous = undefined;
      agreements = 0;
      agreementStart = now();
      continue;
    }

    successfulReads += 1;
    lastValue = [...value].sort((a, b) => a - b);
    const key = JSON.stringify(lastValue);
    if (key === previous) {
      agreements += 1;
    } else {
      agreements = 1;
      previous = key;
      agreementStart = now();
    }
    const elapsedMs = now() - start;
    const stableMs = now() - agreementStart;
    if (agreements >= requiredAgreements && stableMs >= minElapsedMs) {
      return {
        value: lastValue,
        reads,
        settled: true,
        elapsedMs,
        stableMs,
        retryableFailures,
      };
    }
  }

  if (lastRetryableFailure !== undefined && successfulReads === 0) {
    throw new ClosingReferenceReadBudgetError({
      attempts: reads,
      successfulReads,
      retryableFailures,
      elapsedMs: now() - start,
      lastFailure: lastRetryableFailure.error,
      lastFailureReason: lastRetryableFailure.reason,
      lastValue: null,
    });
  }

  return {
    value: lastValue,
    reads,
    settled: false,
    elapsedMs: now() - start,
    stableMs: now() - agreementStart,
    retryableFailures,
  };
}

export function formatFailure({ unexpected, missing, hasBlock, prNumber }) {
  const lines = [
    `Closing references for PR #${prNumber} do not match its declaration.`,
  ];
  if (unexpected.length > 0) {
    lines.push(
      '',
      '  ARMED BUT NOT DECLARED: ' + unexpected.map((n) => `#${n}`).join(', '),
      '  Merging this PR would close those issues. If that is not intended, the',
      '  cause is a closing keyword in the body or a contributed commit message.',
      '  GitHub does not read negation. Narrating that another PR closed an issue',
      '  also arms it because the parser does not track who performed the closure.',
      '  In the body, put the phrase inside backticks or a fenced block. In a',
      '  commit message, reword it so no closing keyword precedes the number;',
      '  markdown formatting does not make commit-message references inert.',
    );
  }
  if (missing.length > 0) {
    lines.push(
      '',
      `  DECLARED BUT NOT ARMED: ${missing.map((n) => `#${n}`).join(', ')}`,
      '  The declaration says this PR closes them and GitHub has not registered',
      '  it. The field is briefly stale after an edit, so this check re-reads',
      '  against a wall-clock floor and reports separately when it cannot',
      '  settle -- meaning this result was read from a settled value, and the',
      '  keyword is absent, misspelled, or the issue is in another repository.',
    );
  }
  if (!hasBlock) {
    lines.push(
      '',
      `  This PR has no declaration file. Add one at ` +
        `${PR_CLOSES_DIR}/<branch-slug>.md (see ${PR_CLOSES_DIR}/README.md),`,
      '  committed alongside the change, listing every issue it is meant to',
      '  close, or none at all:',
      '',
      '      ```closes',
      '      #123',
      '      ```',
      '',
      `  A PR without its own file falls back to the legacy shared ` +
        `${DECLARATION_FILE_PATH}.`,
      '  Either way, the declaration is read from a tracked file, not the PR',
      '  body (#415): a file in the commit tree is pinned to the head SHA, so',
      '  editing the body alone can no longer change this verdict.',
    );
  }
  return lines.join('\n');
}

/**
 * Rendered when the read never settled. This is deliberately not the mismatch
 * message: "the references do not match" and "I could not determine what the
 * references are" are different findings, and reporting the second as the
 * first would be a false accusation as easily as a false pass.
 */
export function formatUnsettled({
  prNumber,
  reads,
  elapsedMs,
  value,
  retryableFailures = 0,
}) {
  const lines = [
    `Could not read the closing references for PR #${prNumber} reliably.`,
    '',
    `  ${reads} read attempts over ${Math.round(elapsedMs / 1000)}s never produced`,
    '  a stable value for the required interval. A missing stable interval means',
    '  the answer may still be arriving -- not that the field is empty.',
  ];
  if (retryableFailures > 0) {
    const attemptNoun = retryableFailures === 1 ? 'attempt' : 'attempts';
    lines.push(
      '',
      `  ${retryableFailures} ${attemptNoun} failed with explicitly retryable read errors.`,
      '  Each failed attempt reset the stability interval; the last successful',
      '  value below was retained only for diagnostics, never as a replacement',
      '  for an error or as evidence of a settled result.',
    );
  }
  lines.push(
    '',
    `  Last value seen: [${value.join(', ')}]. It is not reported as a result,`,
    '  because a value that may still change cannot support either verdict:',
    '  if it happens to match the declaration, the match may be an artifact of',
    '  reading too early.',
    '',
    '  Re-run this check. If it persists, GitHub is not converging and the',
    '  declaration must be confirmed by hand before merging.',
  );
  return lines.join('\n');
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw toGitHubCliError(args, error);
  }
}

/**
 * #527 follow-up (Vasquez, PR #638): a monotonic counter, bumped every time a
 * `main` invocation records a failure. A success return only clears
 * `process.exitCode` when this counter has not moved since ITS OWN call
 * started -- i.e. no failure was recorded by any invocation, including a
 * concurrent one still in flight, during this call's lifetime. Two
 * invocations racing via `Promise.all` therefore cannot have the later one
 * erase the earlier one's failure: the failing call bumps the epoch before
 * it returns, so a concurrent success that observes a different epoch than
 * the one it started with knows a failure happened on its watch and leaves
 * `exitCode` alone. A purely SEQUENTIAL failure-then-success (the case this
 * fix exists for, #527) still clears: the failing call has already returned
 * -- and already bumped the epoch -- before the success call even starts, so
 * the epoch it captures at entry already includes that bump, and it matches
 * the epoch read at its own exit.
 */
let failureEpoch = 0;

/**
 * Exported and dependency-injected so the decision below is reachable from a
 * test. It was not, and that is exactly how `settled` came to be computed,
 * printed, and never consulted: every unit in this file was covered except the
 * one that decides the exit code.
 *
 * #638 (Vasquez, second round): the epoch guard alone was not enough,
 * because not every failure exits through the two explicit
 * `process.exitCode = 1` branches below. A rejection from `readClosures`
 * (e.g. `ClosingReferenceReadBudgetError`, a terminal credential failure, or
 * the usage-error `throw` for a malformed argv) used to propagate straight
 * out of `main` uncounted -- `failureEpoch` never moved, so a concurrent
 * success racing against that rejection could still clear `process.exitCode`
 * a caller's own `.catch` had just set. `main` now wraps its whole body so
 * EVERY exit path -- return or throw -- bumps `failureEpoch` before it can
 * leak out. `checkClosingReferences` below still returns `{ ok: false }` on
 * its two "handled" failure branches; the wrapper's `catch` only fires for a
 * genuine exception, but it always fires for one, and always bumps the same
 * counter the return branches already do.
 *
 * #563: the wrapper's `catch` sets `process.exitCode = 2`, not `1`. Nothing
 * that reaches it is a completed comparison -- see the module header -- so
 * every exception caught here is a "could not look" failure, distinct from
 * both the exit-1 mismatch (`!result.ok`, below) and the exit-1 unsettled
 * read (`!settled`, below), which are unchanged. The original error is
 * rethrown unmodified: this is a classification of the catch site, not a
 * transformation of the error, and callers (including the CLI entry point
 * below) still see the exact failure that occurred.
 */
export async function main(argv, deps = {}) {
  // Read before any `await` in this call so a concurrent failure that starts
  // and finishes entirely within this call's lifetime is never mistaken for
  // one that happened before it and is therefore safe to treat as cleared.
  const epochAtStart = failureEpoch;
  try {
    return await checkClosingReferences(argv, deps, epochAtStart);
  } catch (error) {
    failureEpoch += 1;
    process.exitCode = 2;
    throw error;
  }
}

/**
 * The actual check, split out of `main` so `main` can wrap it uniformly in
 * try/catch (see the note above). Not exported: every existing caller and
 * test goes through `main`, and this split exists purely to make the epoch
 * bump on a thrown/rejected path structurally unmissable rather than
 * something each new failure branch has to remember to add by hand.
 */
async function checkClosingReferences(argv, deps, epochAtStart) {
  const {
    run = gh,
    readClosures = readSettled,
    readCommitClosures = readPullRequestCommitClosures,
    readDeclaration = readDeclarationForPullRequest,
    environment = process.env,
  } = deps;
  const supplied = argv[0];
  if (supplied !== undefined && !/^[1-9]\d*$/.test(supplied)) {
    throw new Error('usage: check-closing-references.mjs <pr-number>');
  }
  const prNumber = supplied ?? String(resolvePullRequestNumber(environment));

  // #415: read from the commit tree, not `gh pr view --json body`. The
  // checked-out worktree is pinned to the head commit this run is judging, so
  // this can no longer disagree with the SHA the check reports against.
  // #622: read from this PR's own file under PR_CLOSES_DIR (falling back to
  // the legacy shared file), not from one path every PR shares.
  const { declared, hasBlock } = parseDeclaredClosures(
    readDeclaration(prNumber, { run, environment }),
  );
  const commitClosures = readCommitClosures(prNumber, run);

  // Both fields out of ONE response. Fetched separately they cannot witness
  // each other: two calls can straddle the propagation, so a fresh body and a
  // stale derived field would be an ordinary result rather than a contradiction.
  let witnessBody = '';
  // Whether the body was actually observed ALONGSIDE the field, rather than
  // left at its initial value. An unread body and a body that binds nothing
  // are both `''`, and only the second is evidence -- so without this the
  // witness below fires on a non-observation, which is the failure mode this
  // whole file exists to remove.
  let witnessSeen = false;
  const {
    value: actual,
    reads,
    settled,
    elapsedMs = 0,
    stableMs = 0,
    retryableFailures = 0,
  } = await readClosures(() => {
    const raw = run([
      'pr',
      'view',
      prNumber,
      '--json',
      'body,closingIssuesReferences',
      '--jq',
      '{body: .body, refs: [.closingIssuesReferences[].number]}',
    ]);
    const parsed = parseClosingReferenceResponse(raw);
    witnessBody = parsed.body;
    witnessSeen = true;
    return parsed.refs;
  });

  const contradiction = witnessContradiction(witnessBody, actual);
  const unreadable = witnessSeen
    ? witnessUnreadableBinding(witnessBody, actual)
    : [];
  const suspect = contradiction.length > 0 || unreadable.length > 0;
  const armed = [...new Set([...actual, ...commitClosures])].sort(
    (a, b) => a - b,
  );
  const result = compareClosures(declared, armed);
  const summary =
    `declared=[${declared.join(', ')}] armed=[${armed.join(', ')}] ` +
    `bodyArmed=[${actual.join(', ')}] commitArmed=[${commitClosures.join(', ')}] ` +
    `reads=${reads} retryableFailures=${retryableFailures} ` +
    `settled=${settled} stableMs=${stableMs}`;

  // Before the comparison, not after. An unsettled read that happens to match
  // is not a pass: `compareClosures` is being handed a value that may still
  // change, so its `ok` says nothing about the merged state.
  if (!settled) {
    console.error(
      formatUnsettled({
        prNumber,
        reads,
        elapsedMs,
        value: actual,
        retryableFailures,
      }),
    );
    console.error(`\n  ${summary}`);
    failureEpoch += 1;
    process.exitCode = 1;
    return { ok: false, settled: false, stale: suspect };
  }

  // Settled and self-contradictory. Reported, never fatal: the witness cannot
  // tell a stale derived field from a reference GitHub was never going to
  // bind, and the body is deterministic, so failing here is a red the author
  // cannot clear by any action the message names. The verdict below belongs
  // to the comparison; this only tells a human where to look.
  if (contradiction.length > 0) {
    console.error(
      `Note: the body closes ${contradiction.map((n) => `#${n}`).join(', ')} ` +
        `while the derived field settled on []. Either the field is stale, or ` +
        `those references are not issues this repository can close (a pull ` +
        `request number, another repository, or a code block). Not failing on ` +
        `it: re-reading cannot distinguish the two.`,
    );
  }

  // The mirror case, on the same terms: reported, never fatal. `stale` moves,
  // the exit code does not, so a body binding through a form this parser
  // cannot read costs a note rather than a red nobody can clear.
  if (unreadable.length > 0) {
    console.error(
      `Note: the derived field settled on ` +
        `${unreadable.map((n) => `#${n}`).join(', ')} while the body binds ` +
        `nothing this check can read. Either the field is stale -- a closing ` +
        `reference removed from the body within the propagation window still ` +
        `matches a declaration that was not removed with it -- or the body ` +
        `binds through a cross-repository reference, a GH-123 form, or an ` +
        `issue URL, none of which this parser reads. Not failing on it: ` +
        `re-reading cannot distinguish the two.`,
    );
  }

  if (!result.ok) {
    console.error(formatFailure({ ...result, hasBlock, prNumber }));
    console.error(`\n  ${summary}`);
    failureEpoch += 1;
    process.exitCode = 1;
    return { ok: false, settled: true, stale: suspect };
  }

  console.log(`Closing references match the declaration. ${summary}`);
  // #527: clear a failure recorded by an earlier `main` call in the same
  // process. The CLI entry point below only ever calls `main` once, so this
  // costs nothing there -- but leaving `exitCode` at whatever a previous
  // SEQUENTIAL call's failure branch set it to means a successful call
  // reports failure to anything that inspects `process.exitCode` afterward,
  // which is the opposite overclaim this module exists to refuse.
  //
  // #638 (Vasquez): guarded by `failureEpoch`, not unconditional. Two
  // invocations racing in the same process (e.g. `Promise.all([main(...),
  // main(...)])`) must not let a later success erase an earlier, still
  // relevant failure from the OTHER invocation. If the epoch moved since this
  // call started, some invocation -- possibly still in flight when this one
  // began -- recorded a failure during this call's own lifetime, so this
  // success does not get to clear it.
  if (failureEpoch === epochAtStart) {
    process.exitCode = undefined;
  }
  return { ok: true, settled: true, stale: suspect };
}

/**
 * #563 (Hicks & Vasquez, round 1): the `import.meta.url === pathToFileURL(...)`
 * guard below is `true` only when this file is the process entry point,
 * which is never the case under the test runner (`process.argv[1]` is
 * vitest's own entry, not this script) -- so nothing in
 * `tests/closingReferences.test.ts` ever executed this handler. Both
 * reviewers independently mutated it (`exitCode = 1` and `exitCode = 0`)
 * and the suite stayed green either time. Pulling the handler out into an
 * exported function lets a test invoke the *real* code directly, with no
 * process spawn and no copy-of-the-logic drift, while the guard below
 * stays the only thing that decides whether it runs unsolicited as a side
 * effect of import.
 */
export function reportCliOutcome(error) {
  console.error(
    'NO VERDICT: could not determine whether closing references match the ' +
      'declaration -- this is not a mismatch, the check never got to compare ' +
      'declared and armed closures.',
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(reportCliOutcome);
}
