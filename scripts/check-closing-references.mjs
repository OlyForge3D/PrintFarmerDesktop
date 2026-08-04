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
export function formatUnsettled({ prNumber, reads, elapsedMs, value }) {
  return [
    `Could not read the closing references for PR #${prNumber} reliably.`,
    '',
    `  ${reads} reads over ${Math.round(elapsedMs / 1000)}s never produced a`,
    '  stable value for the required interval. The field is eventually',
    '  consistent, so an unstable read means the answer is still arriving --',
    '  not that it is empty.',
    '',
    `  Last value seen: [${value.join(', ')}]. It is not reported as a result,`,
    '  because a value that may still change cannot support either verdict:',
    '  if it happens to match the declaration, the match may be an artifact of',
    '  reading too early.',
    '',
    '  Re-run this check. If it persists, GitHub is not converging and the',
    '  declaration must be confirmed by hand before merging.',
  ].join('\n');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
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

  const {
    value: actual,
    reads,
    settled,
    elapsedMs = 0,
  } = await readClosures(() => {
    const raw = run([
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

  // Before the comparison, not after. An unsettled read that happens to match
  // is not a pass: `compareClosures` is being handed a value that may still
  // change, so its `ok` says nothing about the merged state.
  if (!settled) {
    console.error(formatUnsettled({ prNumber, reads, elapsedMs, value: actual }));
    console.error(`\n  ${summary}`);
    process.exitCode = 1;
    return { ok: false, settled: false };
  }

  if (!result.ok) {
    console.error(formatFailure({ ...result, hasBlock, prNumber }));
    console.error(`\n  ${summary}`);
    process.exitCode = 1;
    return { ok: false, settled: true };
  }

  console.log(`Closing references match the declaration. ${summary}`);
  return { ok: true, settled: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
