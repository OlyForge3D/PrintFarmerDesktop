// Reports a deliberately held pull request as a distinct, named signal.
//
// No shebang: this module is imported by tests/sequencingHold.test.ts, and
// vite's transform does not strip one the way node does. The same lesson is
// recorded at the top of check-pr-closure-scope.mjs; it cost a whole file
// there and is repeated here so nobody re-learns it a third time.
//
// #182: merge sequencing lived only in cross-session chat. A held PR and a
// stalled PR produce the SAME API response — `mergeStateStatus: BEHIND` — so an
// automated handoff read a deliberate hold as a defect and offered to sync it
// away. From the automation's position that reading was correct: the two states
// were genuinely indistinguishable in every field it could see.
//
// The defect is therefore AMBIGUITY, not absence. `.squad/holds.md` and the
// `hold:sequenced` label already carried the intent, but only for a reader who
// had been told to go and look. This check emits the same fact as a named check
// run, which is a surface every agent already reads before proposing anything.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  resolvePullRequestNumber,
  resolveRepository,
} from './check-pr-closure-scope.mjs';

export { resolvePullRequestNumber, resolveRepository };

/**
 * Any label in this namespace asserts a deliberate hold.
 *
 * A prefix rather than a fixed list, for the reason PROTECTED_LABELS gives in
 * check-pr-closure-scope.mjs: a future `hold:decision` or `hold:release` is
 * covered the day it is created, without an edit here that nobody would
 * remember to make.
 */
export const HOLD_LABEL_PREFIX = 'hold:';

/**
 * Holds whose meaning is documented, keyed by label.
 *
 * An undocumented `hold:*` label still holds — failing open on an unrecognised
 * hold would make the namespace a footgun — but a documented one can say what
 * it is waiting for.
 */
export const DOCUMENTED_HOLDS = Object.freeze({
  'hold:sequenced':
    'Held by the lead while other work is sequenced ahead of it, usually ' +
    'because two pull requests touch the same paths and the landing order ' +
    'matters. BEHIND is intentional. See .squad/holds.md.',
});

/**
 * Decide whether a pull request is deliberately held.
 *
 * Pure: reads no environment and performs no I/O, so the rule is testable
 * without a network or a repository.
 */
export function evaluateSequencingHold(labels) {
  if (!Array.isArray(labels)) {
    throw new TypeError(
      'labels must be an array; refusing to report "not held" from a value that cannot hold a label',
    );
  }

  const matched = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string') {
      throw new TypeError(`label entry has no name: ${JSON.stringify(label)}`);
    }
    if (!name.toLowerCase().startsWith(HOLD_LABEL_PREFIX)) continue;
    matched.push({
      label: name,
      reason:
        DOCUMENTED_HOLDS[name.toLowerCase()] ??
        `Undocumented hold label. It holds anyway; document it in .squad/holds.md.`,
    });
  }

  return { held: matched.length > 0, holds: matched };
}

/**
 * The message a held pull request emits.
 *
 * This text is the whole control. A check that merely went red would recreate
 * #182's defect one surface further along: a held PR would look like a broken
 * PR, and the helpful response to a broken PR is to fix it. Every line here
 * exists to stop a reader concluding that something needs repairing.
 */
export function formatHold(holds, prNumber) {
  const lines = [
    `Pull request #${prNumber} is deliberately held. This check is RED on purpose.`,
    '',
    'DO NOT rebase it, sync it from development, merge it, or enqueue it.',
    '',
  ];

  for (const hold of holds) {
    lines.push(`  ${hold.label}`, `    ${hold.reason}`, '');
  }

  lines.push(
    'Nothing is wrong with this pull request. Held is not the same as broken',
    'and not the same as unfinished: a held pull request may be complete,',
    'reviewed and green. Being BEHIND development is part of the hold, not a',
    'defect in it — syncing would resolve a conflict against a base that is',
    'about to move again, destroy the intended landing order, and report that',
    'as a fix.',
    '',
    'To release it, remove the hold label. This check re-runs on `unlabeled`',
    'and goes green with no push, because the hold can change with no commit.',
    '',
    'Read the field, not the branch state:',
    `  gh pr view ${prNumber} --json labels`,
  );

  return lines.join('\n');
}

export async function fetchPullRequestLabels({
  owner,
  repo,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub REST returned ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.labels)) {
    throw new Error(
      'pull request payload has no labels array; refusing to treat an unreadable response as "not held"',
    );
  }

  return payload.labels.map((label) => label.name);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const { owner, repo } = resolveRepository(process.env);
  const prNumber = resolvePullRequestNumber(process.env);
  const labels = await fetchPullRequestLabels({
    owner,
    repo,
    prNumber,
    token,
  });

  const { held, holds } = evaluateSequencingHold(labels);
  console.log(
    `Pull request #${prNumber} labels: ${labels.join(', ') || '(none)'}`,
  );

  if (held) {
    console.error(`\n${formatHold(holds, prNumber)}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    'No hold label. This pull request is not sequenced behind other work.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // An inability to read the labels fails the job. A guard that could not read
  // the field must not report the same result as a guard that read it and
  // found no hold — that equivalence is the #182 defect in miniature.
  main().catch((error) => {
    console.error(`Unable to verify sequencing hold: ${error.message}`);
    process.exitCode = 1;
  });
}
