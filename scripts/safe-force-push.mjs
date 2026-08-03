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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACK_ENV,
  ACK_FOREIGN_ENV,
  PROTECTED_REFS,
  readCommits,
  readLiveRemoteSha,
} from './push-guard.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
  const discarded = readCommits([live, `^${local}`]);
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

  const args = [
    'push',
    `--force-with-lease=${ref}:${live}`,
    '--force-if-includes',
    options.remote,
    `HEAD:${ref}`,
  ];
  console.log(`[push:force] git ${args.join(' ')}`);
  try {
    execFileSync('git', args, { cwd: repoRoot, env, stdio: 'inherit' });
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
