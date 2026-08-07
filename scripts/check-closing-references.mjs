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
 * The declaration has to live somewhere the closing parser does not read.
 * Measured on a live pull request, with a bare keyword as the positive control:
 *
 *   bare        closes #N        -> closingIssuesReferences = [N]   BINDS
 *   fenced      ```closes #N```  -> []                              inert
 *   inline code `closes #N`      -> []                              inert
 *   no reference                 -> []                              inert
 *
 * So a fenced block is a safe declaration site, and it is what this parser
 * reads. (The inline-code result also corrects a standing belief that
 * backticking "does not reliably help": it helps when the backticks enclose the
 * reference as well as the keyword. The reported failure had them on a
 * different word than the one that fired.)
 *
 * Absence of a declaration block means the PR declares nothing, so any armed
 * closure is a mismatch. That is deliberate and fail-closed: the hazard is a
 * closure nobody intended, and a check that treats silence as consent cannot
 * see it.
 */

import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';

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
 * Reads the declared closure set out of a PR body.
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
      '  cause is almost certainly a closing keyword in the body -- including in',
      '  a sentence saying the PR must NOT close them, because the parser',
      '  does not read negation. Put the reference inside backticks or a fenced',
      '  block to discuss it without arming it.',
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
      '  This PR has no declaration block. Add one, listing every issue it is',
      '  meant to close, or none at all:',
      '',
      '      ```closes',
      '      #123',
      '      ```',
      '',
      '  The block is inert to the closing parser (measured), so it declares',
      '  intent without performing it.',
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
 * Exported and dependency-injected so the decision below is reachable from a
 * test. It was not, and that is exactly how `settled` came to be computed,
 * printed, and never consulted: every unit in this file was covered except the
 * one that decides the exit code.
 */
export async function main(argv, deps = {}) {
  const { run = gh, readClosures = readSettled } = deps;
  const prNumber = argv[0];
  if (!prNumber || !/^\d+$/.test(prNumber)) {
    throw new Error('usage: check-closing-references.mjs <pr-number>');
  }

  const body = run(['pr', 'view', prNumber, '--json', 'body', '--jq', '.body']);
  const { declared, hasBlock } = parseDeclaredClosures(body);

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
  const result = compareClosures(declared, actual);
  const summary =
    `declared=[${declared.join(', ')}] armed=[${actual.join(', ')}] ` +
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
    process.exitCode = 1;
    return { ok: false, settled: true, stale: suspect };
  }

  console.log(`Closing references match the declaration. ${summary}`);
  return { ok: true, settled: true, stale: suspect };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
