// Did the merge gate re-derive its premises this round, or restate them?
//
// #536: a merge/coordination session spent six consecutive rounds gating
// PR #423 on a head SHA (`cd512223`) that had not been the branch tip for
// hours. Every check it ran was internally consistent and every one of them
// confirmed the stale premise, because none of them re-derived anything:
//
//   "#423 is draft/frozen"                  -- it was state=closed, merged=true
//   "head is cd512223"                      -- head was 3bfa78f2; cd512223 was
//                                               ahead=0 behind=158
//   "reviews pinned only to 9119b5df"       -- 9 review objects existed, at
//                                               3 different SHAs
//   "squad/366-freshness-timing is cd512223" -- ls-remote said 3bfa78f2
//
// `merge_commit_sha == refs/heads/development`. #423 did not merge INTO the
// branch being held -- it HAD BECOME it, hours earlier.
//
// WHY EVERY ROUND CONFIRMED THE STALE VALUE
//
// 1. `cd512223` is a real commit with a real message, author and date. It
//    passes every EXISTENCE check. Existence and currency are independent
//    facts, and an existence check cannot report position.
// 2. One round reported `identical ahead=0 behind=0` as corroboration. That
//    compared a remembered value TO ITSELF, which returns `identical` for
//    every possible input and has zero discriminating power.
// 3. Two mechanisms (`ls-remote`, the GitHub API) were read as independent
//    confirmation while both pointed at the same stale local-clone target.
//    Agreement between two readers of one target is not agreement between
//    two independent measurements.
// 4. A closed, merged PR needs no review gate, no sync check, no freeze
//    check -- and checking `state`/`merged` FIRST would have ended this at
//    round one. Instead it was checked last, if at all.
//
// WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY LEAVES TO THE CALLER
//
// This is not a merge-landed check (see check-merge-landed.mjs, which
// verifies a MERGE reached a target). This checks whether a GATE currently
// held against a PR is still owed any gate at all, and refuses to let a
// remembered value stand in for a fresh one:
//
//   - classifyTerminalState:  state/merged decide the gate BEFORE anything
//     else is read. A closed, merged PR always resolves NO_GATE_NEEDED.
//   - classifyPosition:       refuses a comparison whose two sides were
//     read from the same named source -- "compare A to B" requires A and B
//     to have been obtained separately, never a value compared to itself.
//   - classifyRoundBudget:    if the last N rounds produced the same premise
//     hash with no new observation, that is itself the finding: STOP and
//     re-derive from scratch rather than restate.
//
// The three are independent and composable; main() wires them for the
// PR #423 shape (a PR number plus a remote branch to re-derive against), but
// any caller may drive the pure functions directly with fresh readings.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERDICT_NO_GATE_NEEDED = 'no-gate-needed';
export const VERDICT_GATE_REQUIRED = 'gate-required';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_GATE_REQUIRED = 1;
export const EXIT_UNVERIFIABLE = 2;
export const EXIT_REDERIVE = 3;

/**
 * Fix #4: check terminal state before anything else. `state` and `merged`
 * are cheap, dispositive, and answer a question no later check can
 * override -- a closed, merged PR needs no review gate, no sync check, and
 * no freeze check, regardless of what any remembered SHA says about it.
 */
export function classifyTerminalState({ prNumber, state, merged } = {}) {
  if (typeof state !== 'string' || state.trim() === '') {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      reason: `#${prNumber ?? '?'}: no usable state was read (${JSON.stringify(state)})`,
    };
  }
  if (state === 'closed' && merged === true) {
    return {
      verdict: VERDICT_NO_GATE_NEEDED,
      reason: `#${prNumber ?? '?'} is closed and merged -- no review gate, no sync check, and no freeze check are owed`,
    };
  }
  if (state === 'closed' && merged !== true) {
    return {
      verdict: VERDICT_NO_GATE_NEEDED,
      reason: `#${prNumber ?? '?'} is closed without merging -- there is no live head to gate`,
    };
  }
  return {
    verdict: VERDICT_GATE_REQUIRED,
    reason: `#${prNumber ?? '?'} is open (state=${state}) -- position must be re-derived, not recalled`,
  };
}

/**
 * Fix #3: ask position, not existence, and refuse a reflexive comparison.
 * `sourceA`/`sourceB` name where each value came from (e.g. "gh-api",
 * "ls-remote:origin"). If they name the SAME source, this is a value
 * compared to itself -- it will report `identical` for every possible
 * input and asserts nothing, exactly like the round that read
 * `ahead=0 behind=0` as corroboration.
 */
export function classifyPosition({ sourceA, valueA, sourceB, valueB } = {}) {
  if (!sourceA || !sourceB) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      reason: 'both sides of a position comparison must name their source',
    };
  }
  if (sourceA === sourceB) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      reason: `refusing to compare "${sourceA}" to itself -- a value compared to itself is always "identical" and has zero discriminating power`,
    };
  }
  if (typeof valueA !== 'string' || typeof valueB !== 'string') {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      reason: `both sides need a resolved value (${sourceA}=${JSON.stringify(valueA)}, ${sourceB}=${JSON.stringify(valueB)})`,
    };
  }
  if (valueA === valueB) {
    return {
      verdict: VERDICT_NO_GATE_NEEDED,
      reason: `${sourceA} and ${sourceB} independently agree on ${valueA.slice(0, 12)} -- a genuine confirmation, not a reflexive one`,
    };
  }
  return {
    verdict: VERDICT_GATE_REQUIRED,
    reason: `${sourceA} (${valueA.slice(0, 12)}) disagrees with ${sourceB} (${valueB.slice(0, 12)}) -- at least one side is stale; re-derive both before deciding anything`,
  };
}

/**
 * Fix #5: bound the loop. `history` is the ordered list of premise hashes
 * from prior rounds (oldest first), most-recent last; `currentHash` is this
 * round's. If the current hash matches the last `threshold` entries with no
 * new observation between them, that repetition is itself the signal to
 * re-derive from scratch -- not to restate the same premises a further time.
 */
export function classifyRoundBudget({
  history = [],
  currentHash,
  threshold = 3,
} = {}) {
  if (typeof currentHash !== 'string' || currentHash.trim() === '') {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      reason: 'no usable premise hash for this round',
      consecutive: 0,
    };
  }
  // Count how many rounds immediately preceding this one already carried the
  // identical premise hash, then add the current round itself.
  let matchingPredecessors = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] === currentHash) {
      matchingPredecessors += 1;
    } else {
      break;
    }
  }
  const consecutive = matchingPredecessors + 1;

  if (consecutive > threshold) {
    return {
      verdict: 'rederive',
      reason: `this premise hash has now repeated for ${consecutive} consecutive rounds with no new observation -- stop restating it and re-derive every input from scratch (fresh ls-remote, fresh gh api read, fresh state check)`,
      consecutive,
    };
  }
  return {
    verdict: 'within-budget',
    reason: `${consecutive} consecutive round(s) on this premise hash (threshold ${threshold})`,
    consecutive,
  };
}

export function formatVerdict(label, result) {
  return `[gate-premises] ${label}: ${result.reason}`;
}

// --- effects ---------------------------------------------------------------

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Fix #1: print the target, not just the query. Never silently read
 * `origin` (or any remote name) without saying what it resolves to.
 */
export function resolveRemoteUrl(remote = 'origin') {
  return git(['ls-remote', '--get-url', remote]);
}

export function resolveRemoteBranchHead(remote, branch) {
  const output = git(['ls-remote', remote, `refs/heads/${branch}`]);
  if (!output) {
    return null;
  }
  const [sha] = output.split(/\s+/, 1);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function fetchPullFresh({ repository, prNumber, token }) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'check-gate-premises',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for pull #${prNumber}`);
  }
  return response.json();
}

export function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') {
      out.pr = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--repo') {
      out.repo = argv[index + 1];
      index += 1;
    } else if (arg === '--branch') {
      out.branch = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-gate-premises --pr <n> --repo <owner/name> [--branch <name>]`,
      );
    }
  }
  return out;
}

function resolveRepository(explicit) {
  if (explicit) {
    return explicit;
  }
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = resolveRemoteUrl('origin');
  const match = remote && remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) {
    throw new Error(
      `cannot resolve a repository from origin (${remote ?? 'unset'})`,
    );
  }
  return match[1];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr) {
    console.error(
      '[gate-premises] usage: check-gate-premises --pr <n> [--repo owner/name] [--branch name]',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const remoteUrl = resolveRemoteUrl('origin');
  // Fix #1: print the target before reading anything through it.
  console.log(
    `[gate-premises] origin resolves to: ${remoteUrl ?? '(unresolved)'}`,
  );

  let repository;
  try {
    repository = resolveRepository(args.repo);
  } catch (error) {
    console.error(`[gate-premises] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

  let pull;
  try {
    // Fix #2: re-derive at the moment of decision. This is a fresh read
    // every invocation -- never a value carried over from an earlier round.
    pull = await fetchPullFresh({ repository, prNumber: args.pr, token });
  } catch (error) {
    console.error(`[gate-premises] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const terminal = classifyTerminalState({
    prNumber: args.pr,
    state: pull.state,
    merged: pull.merged === true || pull.merged_at != null,
  });
  console.log(formatVerdict('terminal-state', terminal));

  if (terminal.verdict !== VERDICT_GATE_REQUIRED) {
    process.exitCode = EXIT_OK;
    return;
  }

  const branch = args.branch ?? pull.head?.ref;
  if (!branch) {
    console.error(
      '[gate-premises] pull request is open but no branch was resolvable to check position',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const remoteHead = resolveRemoteBranchHead('origin', branch);
  const position = classifyPosition({
    sourceA: 'gh-api:pulls.head.sha',
    valueA: pull.head?.sha,
    sourceB: `ls-remote:origin/${branch}`,
    valueB: remoteHead,
  });
  console.log(formatVerdict('position', position));

  if (position.verdict === VERDICT_UNVERIFIABLE) {
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }
  process.exitCode =
    position.verdict === VERDICT_GATE_REQUIRED ? EXIT_GATE_REQUIRED : EXIT_OK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[gate-premises] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
