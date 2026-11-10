import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isSha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const REMOTE = 'https://github.com/OlyForge3D/PrintFarmerDesktop.git';

// Fetch objects into an isolated bare repository: never execute source code,
// hooks, local merge drivers, replace refs, or global Git configuration.
export function verifySquashGroup({
  base,
  head,
  group,
  repository = process.cwd(),
  number,
  remote = false,
}) {
  if (![base, head, group].every(isSha) || base === group || head === group)
    throw new Error('Squash proof requires distinct full commit identities.');
  if (
    (remote || number !== undefined) &&
    (!Number.isSafeInteger(number) || number <= 0)
  )
    throw new Error('Squash proof requires an exact PR number.');
  const directory = mkdtempSync(path.join(tmpdir(), 'queue-squash-'));
  const env = Object.fromEntries(
    // The host's executable search path is toolchain selection, like PATH,
    // not repository policy. Relocatable Git needs it to find remote-https.
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') || key === 'GIT_EXEC_PATH',
    ),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
  });
  const git = (...args) => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Squash proof git ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
      );
    return result.stdout.trim();
  };
  try {
    git('init', '--bare', '--quiet', '--template=');
    git(
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--',
      remote ? REMOTE : path.resolve(repository),
      base,
      group,
      number !== undefined
        ? `refs/pull/${number}/head:refs/queue-proof/source`
        : head,
    );
    if (
      number !== undefined &&
      git('rev-parse', '--verify', 'refs/queue-proof/source') !== head
    )
      throw new Error('Fetched PR source head moved or belongs to another PR.');
    for (const commit of [base, head, group]) {
      if (git('cat-file', '-t', commit) !== 'commit')
        throw new Error('Squash proof input is not a commit.');
    }
    const headers = git('cat-file', '-p', group).split('\n\n')[0].split('\n');
    const parents = headers.filter((line) => line.startsWith('parent '));
    if (
      parents.length !== 1 ||
      parents[0] !== `parent ${base}` ||
      git('rev-list', '--count', `${base}..${group}`) !== '1'
    )
      throw new Error(
        'Squash group must be one commit with the exact base as sole parent.',
      );
    const mergeBases = git('merge-base', '--all', base, head).split('\n');
    if (mergeBases.length !== 1 || !isSha(mergeBases[0]))
      throw new Error('Squash proof requires one unambiguous true merge base.');
    const tree = git(
      'merge-tree',
      '--write-tree',
      `--merge-base=${mergeBases[0]}`,
      base,
      head,
    ).split('\n')[0];
    if (!isSha(tree) || headers[0] !== `tree ${tree}`)
      throw new Error(
        'Squash group tree differs from the independent three-way merge.',
      );
    return { base, head, group, mergeBase: mergeBases[0], tree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function main(argv) {
  try {
    const args = {};
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index];
      if (
        !['--base', '--head', '--group', '--repository'].includes(key) ||
        !argv[index + 1]
      )
        throw new Error(
          'usage: npm run check:queue-squash -- --base SHA --head SHA --group SHA [--repository PATH]',
        );
      if (Object.hasOwn(args, key.slice(2)))
        throw new Error('Duplicate argument.');
      args[key.slice(2)] = argv[index + 1];
    }
    console.log(
      JSON.stringify({
        classification: 'SQUASH_TREE_VERIFIED',
        ...verifySquashGroup(args),
        scope:
          'Offline content proof only; not live membership, review, policy or merge authorization.',
      }),
    );
    return 0;
  } catch (error) {
    console.error(`Squash verification refused: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
