// `npm run push:force` — the force-push that reads the ref instead of trusting it.
//
// Bare `--force-with-lease` compares against your remote-tracking ref, which any
// background fetch can advance without you reading a line of what it pulled. The
// explicit form `--force-with-lease=<ref>:<sha>` is only as good as the SHA you
// put in it, and a SHA typed from memory has been wrong here before.
//
// This resolves the tip with a live `git ls-remote`, prints exactly what the
// push would destroy, and then pushes with that value as the lease plus
// `--force-if-includes` (git's own check that the tracking ref's tip is
// reachable from what you are pushing). The pre-push guard still runs behind it.
//
//   npm run push:force                  -- current branch to origin, refuses if
//                                          anything would be destroyed
//   npm run push:force -- --yes         -- proceed after printing the losses
//   npm run push:force -- --remote up   -- a remote other than origin
//   npm run push:force -- --branch b    -- a branch other than the current one

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ACK_ENV,
  ACK_FOREIGN_ENV,
  PROTECTED_REFS,
  readCommits,
  readEquivalentCommits,
  readLiveRemoteSha,
} from './push-guard.mjs';

// Every git call here runs in the CURRENT directory, and that is load-bearing
// rather than incidental.
//
// This used to pin `cwd` to the directory above this file while the helpers it
// imports from push-guard.mjs set no cwd at all and therefore inherit
// process.cwd(). Two halves of one script, reading two different repositories.
// Measured, running it with cwd set to a scratch repo: it printed
// `jpapiez-squad-81-force-push-guard does not exist on origin` — the branch name
// came from THIS worktree and the remote lookup from the scratch one, so the
// answer was about a pair that exists nowhere.
//
// `npm run push:force` sets cwd to the package root, so the advertised path is
// unchanged. What changes is that the two halves now always agree, and that the
// script can be pointed at a fixture, which is why it had no behavioural
// coverage before: nothing could aim it anywhere.
function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function parseArgs(argv) {
  const options = {
    remote: 'origin',
    branch: null,
    yes: false,
    foreign: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--yes' || flag === '-y') options.yes = true;
    else if (flag === '--remote') options.remote = argv[++index] ?? 'origin';
    else if (flag === '--branch') options.branch = argv[++index] ?? null;
    else if (flag === '--foreign') options.foreign = argv[++index] ?? null;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const branch = options.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const ref = `refs/heads/${branch}`;

  if (PROTECTED_REFS.includes(ref)) {
    console.error(`[push:force] ${ref} does not take direct pushes.`);
    return 1;
  }

  const live = readLiveRemoteSha(options.remote, ref);
  if (!live) {
    console.error(
      `[push:force] ${branch} does not exist on ${options.remote}; push it normally first.`,
    );
    return 1;
  }
  console.log(`[push:force] ${options.remote}/${branch} is at ${live}`);

  const local = git(['rev-parse', 'HEAD']);
  // `rev-list live ^local` answers "what does this push remove from the ref",
  // which is NOT "what does this push destroy". The guard learned that at
  // 822c5ed and subtracts patch-equivalent commits before it refuses; this
  // script did not, so it disagreed with the guard on the one case the guard
  // exists to produce.
  //
  // Follow the guard's own advice — rebase their work forward instead of over
  // it — and every line survives under a new sha. Measured in a fixture where
  // `git cherry` marked the removed commit `-`: this script still announced
  // "this push DESTROYS 1 commit" and refused, while the guard behind it
  // returned `rewrite-preserves-all` and allowed. The operator is told to run
  // this script BY that guard, under time pressure, and the only way out it
  // offered was `--yes`. A remedy that refuses the correct action and then
  // teaches that the override is how you proceed is worse than no remedy.
  //
  // Same source of truth as the guard, so the two cannot drift: subtract, then
  // refuse on what is left.
  const removed = readCommits([live, `^${local}`]);
  const equivalent = readEquivalentCommits(local, live);
  const preserved = removed.filter((commit) => equivalent.has(commit.sha));
  const discarded = removed.filter((commit) => !equivalent.has(commit.sha));

  if (preserved.length > 0) {
    console.log(
      `[push:force] ${preserved.length} commit(s) are rewritten but carried forward, not destroyed:`,
    );
    for (const commit of preserved) {
      console.log(
        `             ${commit.sha.slice(0, 12)}  ${commit.subject}   [preserved]`,
      );
    }
  }

  if (discarded.length === 0) {
    console.log('[push:force] nothing would be destroyed');
  } else {
    console.log(
      `[push:force] this push DESTROYS ${discarded.length} commit(s) on the remote:`,
    );
    for (const commit of discarded) {
      const sessions = commit.sessions.join(', ');
      console.log(
        `             ${commit.sha.slice(0, 12)}  ${commit.subject}${sessions ? `   [session ${sessions}]` : ''}`,
      );
    }
    if (!options.yes) {
      console.error(
        [
          '[push:force] refusing. Read them first:',
          `               git log --oneline ${local}..${live}`,
          '             then re-run with --yes if they are genuinely obsolete.',
        ].join('\n'),
      );
      return 1;
    }
  }

  const env = { ...process.env, [ACK_ENV]: live };
  if (options.foreign) env[ACK_FOREIGN_ENV] = options.foreign;
  // The guard's `unowned-discard` arm wants each destroyed commit named by sha,
  // because a sha is the one token in that refusal that cannot be transcribed
  // from an instruction — which is precisely what went wrong with the session
  // trailer it replaced.
  //
  // In THIS path that evidence has already been produced: `--yes` is only
  // reachable after the block above has printed every destroyed commit, so
  // forwarding the shas here does not weaken the gate, it moves it to where the
  // reading actually happens. The naming requirement exists for the bare
  // `git push` path, where nothing prints and the operator has been given no
  // list at all.
  //
  // Stated without overclaiming: `--yes` is still a fixed literal and can be
  // pre-written into a runbook. What it buys is that the output was emitted, not
  // that it was read. That is weaker than naming the shas by hand and it is the
  // reason this forwarding is scoped to commits this script itself displayed.
  if (options.yes && discarded.length > 0) {
    env[ACK_FOREIGN_ENV] = [
      env[ACK_FOREIGN_ENV] ?? '',
      ...discarded.map((commit) => commit.sha),
    ]
      .join(' ')
      .trim();
  }

  const args = [
    'push',
    `--force-with-lease=${ref}:${live}`,
    '--force-if-includes',
    options.remote,
    `HEAD:${ref}`,
  ];
  console.log(`[push:force] git ${args.join(' ')}`);
  try {
    execFileSync('git', args, { env, stdio: 'inherit' });
  } catch {
    return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
