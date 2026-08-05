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
import { execFileSync } from 'node:child_process';

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
 */
export async function readSettled(read, options = {}) {
  const {
    requiredAgreements = 2,
    maxReads = 20,
    delayMs = 5000,
    minElapsedMs = 60000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const start = now();
  let previous;
  let agreements = 0;
  let reads = 0;

  for (let i = 0; i < maxReads; i += 1) {
    if (i > 0) {
      await sleep(delayMs);
    }
    const value = await read();
    reads += 1;
    const key = JSON.stringify([...value].sort((a, b) => a - b));
    if (key === previous) {
      agreements += 1;
    } else {
      agreements = 1;
      previous = key;
    }
    const elapsedMs = now() - start;
    if (agreements >= requiredAgreements && elapsedMs >= minElapsedMs) {
      return { value: JSON.parse(previous), reads, settled: true, elapsedMs };
    }
  }

  return {
    value: previous === undefined ? [] : JSON.parse(previous),
    reads,
    settled: false,
    elapsedMs: now() - start,
  };
}

/**
 * #513. The check above reads `closingIssuesReferences`, which GitHub derives
 * from the pull request BODY. Commit messages close issues too, on merge to the
 * default branch, and that surface was unscanned -- so a green "PR closure
 * scope" did not mean "no issue will be closed by this merge".
 *
 * Measured, not hypothetical. Commit 0ab96610 is a docs-only commit whose prose
 * argues that it is deliberately NOT repairing #435, and it closed #435:
 *
 *   PR #433 body        -> closingIssuesReferences = [158]   check GREEN
 *   commit 0ab96610     -> closed #435 at 07:54:14Z          unscanned
 *
 * The control was sound and aimed at the wrong surface.
 *
 * THE TRAP, and the reason this is not a three-line addition. The keyword in
 * that message is split across a newline by ordinary paragraph wrapping:
 *
 *     ... would fail the very change that fixes
 *     #435.
 *
 * GitHub honoured it. A scanner that iterates lines and matches each one
 * independently -- the natural way to write this -- finds NOTHING on the one
 * real instance we have, and ships green. So the scan runs over the whole
 * message as a single string and `\s+` is allowed to cross newlines.
 *
 * Two deliberate asymmetries with the body parser above:
 *
 *   - Code fences and backticks are NOT stripped here. They are stripped for
 *     the body because fenced and inline-code references were MEASURED inert to
 *     the closing parser on a live pull request. No equivalent measurement
 *     exists for commit messages, and the fail-closed direction is to flag. The
 *     cost of a false positive is rewording a commit; the cost of a false
 *     negative is a release gate closed with every check green. If someone
 *     takes that measurement, this comment is where the answer belongs.
 *
 *   - Only the unexpected direction is reported. A DECLARED closure that no
 *     commit message arms is not a defect: declarations are armed through the
 *     body, which the check above already verifies. Requiring both surfaces to
 *     arm would fail every correctly-formed pull request in the repository.
 */

/**
 * Every keyword GitHub honours. Deliberately a list of whole literal words
 * rather than a compressed pattern like `close[sd]?`: dropping one entry then
 * fails exactly one test, so the per-keyword tests in
 * tests/closingReferences.test.ts are individually load-bearing. Under a
 * compressed pattern a single edit silently disarms three of them at once.
 */
export const CLOSING_KEYWORDS = Object.freeze([
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]);

/**
 * Longest-first so the alternation cannot settle on a prefix. Backtracking
 * would rescue it here, because a `close` match is followed by `s` where the
 * pattern wants whitespace -- but that is an accident of this keyword set, and
 * relying on it makes the ordering silently load-bearing.
 */
function closingReferencePattern() {
  const alternation = [...CLOSING_KEYWORDS]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .join('|');
  return new RegExp(String.raw`\b(${alternation})\s+#(\d+)\b`, 'gi');
}

/**
 * Finds every closing reference in one commit message.
 *
 * Runs against the message as a single string, so a keyword and its reference
 * separated by a newline are found. That case is not an edge case: it is the
 * only real instance this repository has.
 */
export function parseCommitClosures(message) {
  const source =
    typeof message === 'string' ? message.replace(/\r\n/g, '\n') : '';
  return [...source.matchAll(closingReferencePattern())].map((match) => ({
    keyword: match[1].toLowerCase(),
    issue: Number(match[2]),
  }));
}

/**
 * Scans every commit in a pull request's range.
 *
 * Keeps the originating commit and keyword per issue rather than collapsing to
 * a set of numbers, because "which commit did this" is the first thing the
 * author needs and the last thing they can recover from a bare list once the
 * branch has grown.
 */
export function scanCommitMessages(commits) {
  const bySubject = new Map();
  for (const commit of commits ?? []) {
    const oid = typeof commit?.oid === 'string' ? commit.oid : '';
    for (const { keyword, issue } of parseCommitClosures(commit?.message)) {
      if (!bySubject.has(issue)) {
        bySubject.set(issue, []);
      }
      bySubject.get(issue).push({ oid, keyword });
    }
  }
  return [...bySubject.entries()]
    .map(([issue, sources]) => ({ issue, sources }))
    .sort((a, b) => a.issue - b.issue);
}

/** Commit-armed closures the pull request never declared. */
export function compareCommitClosures(declared, scanned) {
  const declaredSet = new Set(declared);
  return scanned.filter((entry) => !declaredSet.has(entry.issue));
}

export function formatCommitFailure({ unexpected, prNumber }) {
  const lines = [
    `Commit messages in PR #${prNumber} arm closures the PR does not declare.`,
    '',
    '  A closing keyword in a COMMIT MESSAGE closes its issue on merge, and',
    '  `closingIssuesReferences` does not report it -- that field is derived',
    '  from the pull request body alone. This surface is why a release gate can',
    '  close with every check green.',
  ];
  for (const { issue, sources } of unexpected) {
    lines.push(
      '',
      `  ARMED BY COMMIT, NOT DECLARED: #${issue}`,
      ...sources.map(
        ({ oid, keyword }) =>
          `    ${oid.slice(0, 8) || '(unknown)'}  ${keyword} #${issue}`,
      ),
    );
  }
  lines.push(
    '',
    '  The parser does not read sentences, so a message explaining that the',
    '  change must NOT close the issue arms it anyway. Note also that the',
    '  keyword and the reference may sit on different lines: ordinary paragraph',
    '  wrapping is how the one real instance in this repository was written.',
    '',
    '  Either add the issue to the body declaration block, or reword the commit',
    '  message so the keyword and the reference are not adjacent.',
  );
  return lines.join('\n');
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
      '  it. Note that the field is briefly stale after an edit; this check',
      '  already re-reads until it settles, so a persistent mismatch means the',
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

async function main(argv) {
  const prNumber = argv[0];
  if (!prNumber || !/^\d+$/.test(prNumber)) {
    throw new Error('usage: check-closing-references.mjs <pr-number>');
  }

  const body = gh(['pr', 'view', prNumber, '--json', 'body', '--jq', '.body']);
  const { declared, hasBlock } = parseDeclaredClosures(body);

  // Read before the settling loop below: this is a plain string comparison with
  // no eventual consistency to wait out, so a failure here should not cost the
  // author sixty seconds of polling on an unrelated field.
  const commits = JSON.parse(
    gh([
      'pr',
      'view',
      prNumber,
      '--json',
      'commits',
      '--jq',
      '[.commits[] | {oid: .oid, message: ((.messageHeadline // "") + "\n\n" + (.messageBody // ""))}]',
    ]),
  );
  const commitUnexpected = compareCommitClosures(
    declared,
    scanCommitMessages(commits),
  );
  if (commitUnexpected.length > 0) {
    console.error(
      formatCommitFailure({ unexpected: commitUnexpected, prNumber }),
    );
    console.error(
      `\n  declared=[${declared.join(', ')}] commits=${commits.length}`,
    );
    process.exitCode = 1;
    return;
  }

  const {
    value: actual,
    reads,
    settled,
  } = await readSettled(() => {
    const raw = gh([
      'pr',
      'view',
      prNumber,
      '--json',
      'closingIssuesReferences',
      '--jq',
      '[.closingIssuesReferences[].number]',
    ]);
    return JSON.parse(raw);
  });

  const result = compareClosures(declared, actual);
  const summary =
    `declared=[${declared.join(', ')}] armed=[${actual.join(', ')}] ` +
    `reads=${reads} settled=${settled}`;

  if (!result.ok) {
    console.error(formatFailure({ ...result, hasBlock, prNumber }));
    console.error(`\n  ${summary}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Closing references match the declaration. ${summary} ` +
      `commitsScanned=${commits.length}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
