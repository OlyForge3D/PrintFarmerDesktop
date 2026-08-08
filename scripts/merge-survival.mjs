// Answers one question about a merged pull request: **did the change this branch
// introduced survive the merge that closed it?**
//
// Why this exists. The push guard beside this file refuses force-pushes that would
// destroy unread commits. That is one door. The other door is the merge button, and
// it is the busy one: a squash merge is a server-side write that no client-side hook
// can observe, `allow_force_pushes` is false repository-wide, and the guard is
// correct and silent throughout. A branch's commits stop being reachable from
// `refs/heads` the moment it squashes, and nothing in this repository could tell the
// author whether that cost them anything.
//
// It has cost real time. Sessions here have repeatedly concluded their own merged
// work was gone, from five separate instruments, every one of which answers a
// neighbouring question:
//
//   --is-ancestor <head> development   a squash replaces the object, so this is 1 for
//                                      EVERY squashed PR. It detects the merge
//                                      strategy, not the loss.
//   blob comparison                    a blob changes if any later commit touches the
//                                      file at all. Measured here: 35 of 36 files
//                                      reported "not shipped" across eight PRs that
//                                      had all merged intact.
//   git log -S '<line>'                answers "is this byte sequence on trunk NOW",
//                                      so it fails hardest on the branches that were
//                                      reviewed the most, where the text was revised
//                                      after the citation was written.
//   git diff A...B                     diffs from the merge base, which under squash
//                                      never advances past the landing, so finished
//                                      work is reported as outstanding.
//   refs/pull/N/head                   tracks the branch's CURRENT head, not the
//                                      history of heads; recovers the one SHA that was
//                                      never at risk and none of the ones a force-push
//                                      took.
//
// All five ask the graph. Reachability is genuinely destroyed by a squash and asking
// harder about reachability cannot stop being alarming. The question worth asking is
// about the CHANGE, and git has a primitive for exactly it.
//
// The instrument. `git patch-id --stable` hashes a diff with line numbers and hunk
// offsets removed, so the same change computes the same identity after a rebase, a
// squash, or a base sync that shifted every line in the file. Compare two patch ids:
//
//   what the branch introduced   merge-base(head, mergeParent1) -> head
//   what the merge introduced    mergeParent1 -> mergeCommit
//
// Equal means every line the branch added and every line it removed is in the commit
// that landed, whatever the merge strategy did to the objects carrying them.
//
// Measured before it was written, over thirty merged pull requests chosen only by
// being the thirty most recent — not by being convenient:
//
//   patch-id equal                       30 / 30
//     of which squash merges (1 parent)   9 / 9
//     of which behind their base         15 / 15
//
// The behind-base half is the reason this file does not compare raw patch text. Whole
// patch equality agrees on 27 of the same 30 and calls the other three DIVERGENT —
// all three merely stale, their context lines shifted by trunk moving under them.
// Those three would have been false alarms, and a false alarm about destroyed work is
// not a cheap error: its remedy is to stop believing the instrument.
//
// What this does NOT establish. Patch identity is a claim about the change, not about
// authorship: an identical change from another author satisfies it. Provenance is a
// different question and `originLabel` in the push guard is what answers it. Nor does
// INTACT mean the commit objects survived — under squash they demonstrably do not.
// The claim is exactly "no line of this change was dropped on the way in", which is
// the thing people were actually afraid of when they reached for the other five.
//
// Third state, not a soft failure. Every input here can be unavailable — the PR head
// ref may not be fetched, the merge commit may not be local, the diff may fail. None
// of those are allowed to render as DIVERGENT, because "I could not look" reported as
// "work is missing" is the same defect as `128` collapsed into `false`, pointed at a
// louder alarm. They exit 2, which is neither the success code nor the loss code.
//
// Run:  node scripts/merge-survival.mjs --head <sha> --merge <sha>
//       npm run merge:survival -- --head <sha> --merge <sha>
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Full-length object names only, for the same reason `sha-status.mjs` demands them. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const EXIT_INTACT = 0;
export const EXIT_DIVERGENT = 1;
export const EXIT_INDETERMINATE = 2;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/** True only when git answered; a missing object must not read as "not a commit". */
export function commitExists(sha, cwd) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], cwd ? { cwd } : {});
    return true;
  } catch {
    return false;
  }
}

/**
 * The patch identity of the change between two revisions, or `null` when it could not
 * be computed.
 *
 * `null` is also returned for an EMPTY diff, and that is deliberate rather than lazy:
 * `git patch-id` prints nothing for an empty patch, so an empty change and a failed
 * read are indistinguishable at this boundary. Collapsing them here would let a
 * comparison of two nothings report INTACT — the same shape as the ref-pair detector
 * that agreed because both refs were absent. The caller separates them with
 * `diffIsEmpty` before classifying.
 */
export function patchIdOf(from, to, cwd) {
  const options = cwd ? { cwd } : {};
  let diff;
  try {
    diff = git(['diff', '--no-color', from, to], options);
  } catch {
    return null;
  }
  if (diff.trim() === '') return null;
  let printed;
  try {
    // stdin must be a pipe for `input` to arrive at all. The shared `git()` default
    // ignores stdin, and with it ignored `patch-id` reads an empty patch, prints
    // nothing, and this function returns null — which classify() would then read as
    // "could not compute" for a change that is sitting right there.
    printed = git(['patch-id', '--stable'], {
      ...options,
      input: diff,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const id = printed.trim().split(/\s+/)[0];
  return SHA_PATTERN.test(id ?? '') ? id.toLowerCase() : null;
}

/** Whether a revision range introduces no change at all. Separated from `patchIdOf`. */
export function diffIsEmpty(from, to, cwd) {
  try {
    return (
      git(['diff', '--no-color', from, to], cwd ? { cwd } : {}).trim() === ''
    );
  } catch {
    return null;
  }
}

/** The first parent of a merge or squash commit — the base side, in both shapes. */
export function firstParent(sha, cwd) {
  try {
    const parents = git(
      ['rev-list', '--parents', '-n', '1', sha],
      cwd ? { cwd } : {},
    )
      .trim()
      .split(/\s+/);
    return parents.length > 1 ? parents[1] : null;
  } catch {
    return null;
  }
}

export function mergeBase(a, b, cwd) {
  try {
    return git(['merge-base', a, b], cwd ? { cwd } : {}).trim() || null;
  } catch {
    return null;
  }
}

/** Whether this repository is shallow, or `null` when git could not answer. */
export function repositoryIsShallow(cwd) {
  try {
    const answer = git(
      ['rev-parse', '--is-shallow-repository'],
      cwd ? { cwd } : {},
    ).trim();
    if (answer === 'true') return true;
    if (answer === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * List paths changed from a merge base to a head. Git failures deliberately
 * propagate: an exit 128 is not an empty diff.
 */
export function changedPaths(base, head, pathspecs, cwd) {
  const output = git(
    ['diff', '--name-only', `${base}...${head}`, '--', ...pathspecs],
    cwd ? { cwd } : {},
  ).trim();
  return output === '' ? [] : output.split(/\r?\n/);
}

/**
 * Classify from facts already gathered, so every verdict — including the ones that
 * need git to fail — is reachable in a test without arranging a broken repository.
 *
 * @param {{
 *   headKnown: boolean,
 *   mergeKnown: boolean,
 *   parent: string | null,
 *   base: string | null,
 *   repositoryShallow: boolean | null,
 *   branchEmpty: boolean | null,
 *   mergeEmpty: boolean | null,
 *   branchPatchId: string | null,
 *   mergePatchId: string | null,
 * }} facts
 */
export function classify(facts) {
  if (!facts.headKnown) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason:
        'the pull request head is not in this repository — fetch refs/pull/<n>/head first',
    };
  }
  if (!facts.mergeKnown) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason: 'the merge commit is not in this repository',
    };
  }
  if (facts.parent === null) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason:
        'the merge commit has no parent, so there is nothing it merged into',
    };
  }
  if (facts.base === null) {
    if (facts.repositoryShallow === true) {
      return {
        verdict: 'INDETERMINATE',
        code: EXIT_INDETERMINATE,
        reason:
          'repository history is incomplete because this is a shallow clone; run `git fetch --unshallow` and retry',
      };
    }
    if (facts.repositoryShallow !== false) {
      return {
        verdict: 'INDETERMINATE',
        code: EXIT_INDETERMINATE,
        reason:
          'a merge base could not be determined, and repository history completeness could not be read',
      };
    }
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason: 'head and merge share no common ancestor',
    };
  }
  if (facts.branchEmpty === null || facts.mergeEmpty === null) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason: 'a diff could not be read, so neither side is known',
    };
  }
  // An empty branch change is not survival, and it is not loss either. Reporting
  // INTACT here would let a mis-resolved head — one that happens to equal its own
  // merge base — pass as verified, which is the failure the ref-pair detector had.
  if (facts.branchEmpty) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason:
        'the branch introduces no change against its merge base — nothing to look for',
    };
  }
  if (facts.mergeEmpty) {
    return {
      verdict: 'DIVERGENT',
      code: EXIT_DIVERGENT,
      reason:
        'the merge introduced nothing while the branch introduced a change',
    };
  }
  if (facts.branchPatchId === null || facts.mergePatchId === null) {
    return {
      verdict: 'INDETERMINATE',
      code: EXIT_INDETERMINATE,
      reason: 'a patch identity could not be computed for a non-empty change',
    };
  }
  if (facts.branchPatchId === facts.mergePatchId) {
    return {
      verdict: 'INTACT',
      code: EXIT_INTACT,
      reason: 'the merge introduced exactly the change the branch introduced',
    };
  }
  return {
    verdict: 'DIVERGENT',
    code: EXIT_DIVERGENT,
    reason:
      'the merge introduced a different change from the branch — compare the two diffs before assuming loss',
  };
}

/**
 * Gather the facts for one pull request head and the commit that merged it.
 *
 * The self-check is not decoration. An instrument that reports INTACT is
 * indistinguishable from one that cannot report anything else, and this file's whole
 * subject is checks that come back clean because they cannot see. So before any
 * verdict is returned, the comparator is shown to produce BOTH answers on real input
 * from this repository: a patch compared with itself must match, and the branch's
 * patch compared with its own inverse must not. If either control fails the run
 * refuses to report rather than reporting a clean result it has not earned.
 */
export function evaluateMergeSurvival(head, merge, cwd) {
  const headKnown = commitExists(head, cwd);
  const mergeKnown = commitExists(merge, cwd);
  const parent = headKnown && mergeKnown ? firstParent(merge, cwd) : null;
  const base = parent ? mergeBase(head, parent, cwd) : null;
  const repositoryShallow =
    parent && base === null ? repositoryIsShallow(cwd) : null;
  const branchEmpty = base ? diffIsEmpty(base, head, cwd) : null;
  const mergeEmpty = parent ? diffIsEmpty(parent, merge, cwd) : null;
  const branchPatchId =
    base && branchEmpty === false ? patchIdOf(base, head, cwd) : null;
  const mergePatchId =
    parent && mergeEmpty === false ? patchIdOf(parent, merge, cwd) : null;

  const facts = {
    headKnown,
    mergeKnown,
    parent,
    base,
    repositoryShallow,
    branchEmpty,
    mergeEmpty,
    branchPatchId,
    mergePatchId,
  };
  const result = classify(facts);
  return { ...result, facts };
}

/**
 * Judge the three control readings. Pure, so every arm — including the one that
 * cannot be provoked with real objects — is drivable in a test.
 *
 * Keeping this separate is the point. When the arms were computed and judged in one
 * function, the negative arm was unfalsifiable: no pair of real commits makes a change
 * equal its own inverse, so deleting that arm broke no test and it was decoration
 * asserting it was a control. That is the exact defect this file was written about,
 * one level up, in the check rather than in the repository.
 */
export function controlsFrom(forward, again, inverse) {
  if (forward === null)
    return 'positive control: the branch change has no patch identity';
  if (again !== forward)
    return 'positive control: the same change hashed two ways';
  if (inverse === null)
    return 'negative control: the inverse change has no patch identity';
  if (inverse === forward) {
    return 'negative control: a change and its inverse compared equal, so the comparator cannot say no';
  }
  return null;
}

/**
 * Both arms of the comparator, exercised on real objects.
 *
 * Returns `null` when the controls behaved, or a string naming the one that did not.
 */
export function runComparatorControls(base, head, cwd) {
  return controlsFrom(
    patchIdOf(base, head, cwd),
    patchIdOf(base, head, cwd),
    patchIdOf(head, base, cwd),
  );
}

export function parseArgs(argv) {
  const out = { head: null, merge: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--head' || flag === '--merge') {
      const value = argv[i + 1];
      if (!value || !SHA_PATTERN.test(value)) {
        throw new Error(
          `${flag} needs a full 40-character object name; got ${value ?? '(nothing)'}`,
        );
      }
      out[flag === '--head' ? 'head' : 'merge'] = value.toLowerCase();
      i += 1;
    }
  }
  if (!out.head || !out.merge) {
    throw new Error('usage: merge-survival.mjs --head <sha> --merge <sha>');
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    return EXIT_INDETERMINATE;
  }

  const outcome = evaluateMergeSurvival(args.head, args.merge);
  const { facts } = outcome;

  if (facts.base && facts.branchEmpty === false) {
    const controlFailure = runComparatorControls(facts.base, args.head);
    if (controlFailure) {
      process.stderr.write(
        `[merge-survival] REFUSING TO REPORT — ${controlFailure}\n`,
      );
      return EXIT_INDETERMINATE;
    }
  }

  process.stdout.write(
    `[merge-survival] ${outcome.verdict}: ${outcome.reason}\n`,
  );
  process.stdout.write(`  branch change  ${facts.base ?? '?'}..${args.head}\n`);
  process.stdout.write(
    `  merge  change  ${facts.parent ?? '?'}..${args.merge}\n`,
  );
  process.stdout.write(
    `  patch ids      branch=${facts.branchPatchId ?? '(none)'} merge=${facts.mergePatchId ?? '(none)'}\n`,
  );
  if (outcome.verdict === 'INTACT') {
    process.stdout.write(
      '  Commit objects are NOT claimed to survive; under a squash merge they do not.\n',
    );
  }
  return outcome.code;
}

/* c8 ignore start */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
/* c8 ignore stop */
