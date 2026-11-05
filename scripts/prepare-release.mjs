import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_FILES = ['package.json', 'package-lock.json'];
const RUN_MARKER = /^Release-Workflow-Run: ([\w.-]+\/[\w.-]+\/[1-9]\d*)$/m;

export function validateReleaseVersion(version) {
  const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?$`,
  );
  const match = typeof version === 'string' && pattern.exec(version);
  if (!match || match.slice(1, 4).some((part) => Number(part) > 65535)) {
    throw new Error(
      'Version must be canonical major.minor.patch[-prerelease], with core components <= 65535 and no build metadata.',
    );
  }
  return version;
}

export function compareReleaseVersions(left, right) {
  const parts = (value) => {
    validateReleaseVersion(value);
    const separator = value.indexOf('-');
    return {
      core: (separator < 0 ? value : value.slice(0, separator)).split('.'),
      pre: separator < 0 ? [] : value.slice(separator + 1).split('.'),
    };
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a.core[index]) - Number(b.core[index]);
    if (difference) return Math.sign(difference);
  }
  if (!a.pre.length || !b.pre.length) {
    return Math.sign(Number(!a.pre.length) - Number(!b.pre.length));
  }
  for (
    let index = 0;
    index < Math.max(a.pre.length, b.pre.length);
    index += 1
  ) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function readVersionDocuments(read) {
  const documents = VERSION_FILES.map((file) => JSON.parse(read(file)));
  const [manifest, lock] = documents;
  validateReleaseVersion(manifest.version);
  if (
    lock.version !== manifest.version ||
    lock.packages?.['']?.version !== manifest.version
  ) {
    throw new Error('Tracked application version fields disagree.');
  }
  return documents;
}

function withoutVersions(documents) {
  const copy = structuredClone(documents);
  delete copy[0].version;
  delete copy[1].version;
  delete copy[1].packages[''].version;
  return copy;
}

function childEnvironment(environment) {
  const clean = { ...environment };
  for (const key of ['RELEASE_PUSH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    delete clean[key];
  }
  return clean;
}

export function gitAuthenticationEnvironment(token, environment = process.env) {
  if (!token) throw new Error('A GitHub token is required for remote access.');
  return {
    ...childEnvironment(environment),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function createReleaseCommit({
  version,
  runIdentity,
  baseSha,
  git,
  npm,
  read,
}) {
  validateReleaseVersion(version);
  if (!/^[\w.-]+\/[\w.-]+\/[1-9]\d*$/.test(runIdentity)) {
    throw new Error('Invalid release workflow run identity.');
  }
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Invalid base SHA.');
  if (git(['status', '--porcelain']).trim()) {
    throw new Error('Release preparation requires a clean checkout.');
  }
  const before = readVersionDocuments(read);
  if (compareReleaseVersions(version, before[0].version) <= 0) {
    throw new Error('Release version must be newer than the tracked version.');
  }
  npm(['version', version, '--no-git-tag-version', '--ignore-scripts']);
  const after = readVersionDocuments(read);
  assert.equal(after[0].version, version);
  assert.deepEqual(withoutVersions(after), withoutVersions(before));
  const changed = git(['diff', '--name-only']).trim().split('\n').sort();
  assert.deepEqual(changed, [...VERSION_FILES].sort());
  assert.equal(git(['rev-parse', 'HEAD']).trim(), baseSha);
  git(['add', '--', ...VERSION_FILES]);
  git([
    '-c',
    'user.name=PrintFarmer release',
    '-c',
    'user.email=223556219+Copilot@users.noreply.github.com',
    'commit',
    '-m',
    `chore(release): set version to ${version}`,
    '-m',
    `Release-Workflow-Run: ${runIdentity}`,
    '-m',
    'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>',
  ]);
  const sha = git(['rev-parse', 'HEAD']).trim();
  const tag = `v${version}`;
  git([
    '-c',
    'user.name=PrintFarmer release',
    '-c',
    'user.email=223556219+Copilot@users.noreply.github.com',
    'tag',
    '-a',
    tag,
    sha,
    '-m',
    `PrintFarmer release\n\nRelease-Workflow-Run: ${runIdentity}`,
  ]);
  return { sha, tag, version };
}

export function releaseContext(sha, version, publish, build = true) {
  validateReleaseVersion(version);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid release SHA.');
  return {
    sha,
    version,
    tag: `v${version}`,
    publish: String(publish),
    build: String(build),
    stable: String(publish && !version.includes('-')),
    beta: String(publish && version.includes('-')),
  };
}

export function expectedReleaseAssets(version) {
  validateReleaseVersion(version);
  return [
    `PrintFarmer.Desktop-${version}.Setup.exe`,
    `PrintFarmer.Desktop-win32-x64-${version}.zip`,
    `PrintFarmer.Desktop-${version}-universal.dmg`,
    `PrintFarmer.Desktop-darwin-universal-${version}.zip`,
    ...(!version.includes('-') ? ['latest.json', 'latest.json.sig'] : []),
  ].sort();
}

export function verifyPublishedRelease(release, context) {
  assert.equal(release.tag_name, context.tag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, context.beta === 'true');
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    expectedReleaseAssets(context.version),
  );
}

export function main(
  environment = process.env,
  directory = process.cwd(),
  invoke = execFileSync,
) {
  const clean = childEnvironment(environment);
  const execute = (command, args, env = clean) =>
    invoke(command, args, {
      cwd: directory,
      encoding: 'utf8',
      env,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const git = (args) => execute('git', args);
  const networkGit = (args, token = environment.GH_TOKEN) =>
    execute('git', args, gitAuthenticationEnvironment(token, environment));
  const repository = environment.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY must identify the release repository.');
  }
  const gh = (args) =>
    execute('gh', args, { ...clean, GH_TOKEN: environment.GH_TOKEN });
  const unpublished = (tag, requestedVersion) => {
    const pages = JSON.parse(
      gh([
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/releases?per_page=100`,
      ]),
    );
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error('Could not read the GitHub release inventory.');
    }
    if (pages.flat().some((release) => typeof release?.tag_name !== 'string')) {
      throw new Error('GitHub release inventory contains an unreadable tag.');
    }
    if (pages.flat().some((release) => release.tag_name === tag)) {
      throw new Error(
        `Release ${tag} already exists; refusing to replace assets.`,
      );
    }
    if (
      requestedVersion &&
      pages
        .flat()
        .some(
          (release) =>
            release.tag_name.startsWith('v') &&
            compareReleaseVersions(
              requestedVersion,
              release.tag_name.slice(1),
            ) <= 0,
        )
    ) {
      throw new Error(
        'Release version must be newer than every published release.',
      );
    }
  };
  const read = (file) => readFileSync(path.join(directory, file), 'utf8');
  const version = () => readVersionDocuments(read)[0].version;
  const remoteTag = (tag) => {
    const listing = networkGit([
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]);
    const refs = new Map(
      listing
        ? listing.split('\n').map((line) => {
            const [sha, ref] = line.split(/\s+/);
            return [ref, sha];
          })
        : [],
    );
    return (
      refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
    );
  };
  const tagOrigin = (tag) => {
    if (git(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') return null;
    return (
      RUN_MARKER.exec(
        git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]),
      )?.[1] ?? null
    );
  };
  const verifyVersionCommit = (
    sha,
    identity,
    baseSha = git(['rev-parse', `${sha}^`]),
  ) => {
    assert.deepEqual(
      git(['rev-list', '--parents', '-n', '1', sha]).split(' '),
      [sha, baseSha],
      'Release version commit must have exactly the original dispatch parent.',
    );
    assert.equal(
      RUN_MARKER.exec(git(['show', '-s', '--format=%B', sha]))?.[1],
      identity,
      'Release commit must belong to the owning dispatch run.',
    );
    assert.deepEqual(
      git(['diff', '--name-only', baseSha, sha]).split('\n').sort(),
      [...VERSION_FILES].sort(),
      'Release commit may change only the two application version files.',
    );
    const before = readVersionDocuments((file) =>
      git(['show', `${baseSha}:${file}`]),
    );
    const after = readVersionDocuments((file) =>
      git(['show', `${sha}:${file}`]),
    );
    assert.deepEqual(withoutVersions(after), withoutVersions(before));
    assert.ok(compareReleaseVersions(after[0].version, before[0].version) > 0);
  };
  let context;
  if (
    environment.RELEASE_VERIFY === 'true' ||
    environment.RELEASE_VERIFY_PUBLISHED === 'true' ||
    environment.RELEASE_VERIFY_ARTIFACTS === 'true'
  ) {
    const expected = releaseContext(
      environment.RELEASE_SHA,
      environment.RELEASE_VERSION,
      environment.RELEASE_PUBLISH === 'true',
    );
    assert.equal(git(['rev-parse', 'HEAD']), expected.sha);
    assert.equal(version(), expected.version);
    if (expected.publish === 'true') {
      assert.equal(
        remoteTag(expected.tag),
        expected.sha,
        'Remote release tag moved.',
      );
      if (environment.RELEASE_VERIFY_PUBLISHED === 'true') {
        verifyPublishedRelease(
          JSON.parse(
            gh(['api', `repos/${repository}/releases/tags/${expected.tag}`]),
          ),
          expected,
        );
      } else {
        unpublished(expected.tag, expected.version);
      }
    }
    if (environment.RELEASE_VERIFY_ARTIFACTS === 'true') {
      assert.deepEqual(
        readdirSync(path.join(directory, 'dist')).sort(),
        expectedReleaseAssets(expected.version),
      );
    }
    console.log(`Verified release tree ${expected.tag} at ${expected.sha}.`);
    return expected;
  }
  if (!environment.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  accessSync(environment.GITHUB_OUTPUT, constants.W_OK);
  if (environment.GITHUB_EVENT_NAME === 'push') {
    const tag = environment.GITHUB_REF_NAME;
    const current = version();
    assert.equal(
      tag,
      `v${current}`,
      'Tag must match the tracked package version.',
    );
    const sha = git(['rev-parse', 'HEAD']);
    assert.equal(
      remoteTag(tag),
      sha,
      'Remote tag must point to the checked-out SHA.',
    );
    const managed = tagOrigin(tag);
    if (managed?.startsWith(`${repository}/`)) {
      verifyVersionCommit(sha, managed);
      console.log(
        `Managed tag belongs to ${managed}; its dispatch run owns publication.`,
      );
      context = releaseContext(sha, current, false, false);
    } else {
      unpublished(tag, current);
      context = releaseContext(sha, current, true);
    }
  } else if (environment.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    if (environment.RELEASE_DRY_RUN !== 'false') {
      if (
        environment.RELEASE_VERSION &&
        environment.RELEASE_VERSION !== version()
      ) {
        throw new Error(
          'Dry runs use the tracked version; clear the version input or select publishing.',
        );
      }
      context = releaseContext(git(['rev-parse', 'HEAD']), version(), false);
    } else {
      if (environment.GITHUB_REF !== 'refs/heads/development') {
        throw new Error('Publishing must be dispatched from development.');
      }
      const requested = validateReleaseVersion(environment.RELEASE_VERSION);
      if (!environment.RELEASE_PUSH_TOKEN) {
        throw new Error(
          'Configure the dedicated RELEASE_PUSH_TOKEN administrator credential before publishing.',
        );
      }
      if (!/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? '')) {
        throw new Error('GITHUB_RUN_ID is required.');
      }
      const identity = `${repository}/${environment.GITHUB_RUN_ID}`;
      const tag = `v${requested}`;
      unpublished(tag, requested);
      const existing = remoteTag(tag);
      if (existing) {
        networkGit([
          'fetch',
          '--no-tags',
          'origin',
          `refs/tags/${tag}:refs/tags/${tag}`,
        ]);
        if (tagOrigin(tag) !== identity) {
          throw new Error(
            `Tag ${tag} already exists and does not belong to this dispatch run.`,
          );
        }
        assert.equal(git(['rev-parse', `${tag}^{commit}`]), existing);
        verifyVersionCommit(existing, identity, environment.GITHUB_SHA);
        git(['checkout', '--detach', existing]);
        assert.equal(version(), requested);
        context = releaseContext(existing, requested, true);
      } else {
        networkGit(['fetch', '--no-tags', 'origin', 'refs/heads/development']);
        const baseSha = git(['rev-parse', 'FETCH_HEAD']);
        assert.equal(
          baseSha,
          environment.GITHUB_SHA,
          'Development moved since dispatch; start a fresh run.',
        );
        git(['checkout', '--detach', baseSha]);
        const created = createReleaseCommit({
          version: requested,
          runIdentity: identity,
          baseSha,
          git,
          read,
          npm: (args) => execute('npm', args),
        });
        networkGit(
          [
            'push',
            '--atomic',
            'origin',
            `${created.sha}:refs/heads/development`,
            `refs/tags/${created.tag}`,
          ],
          environment.RELEASE_PUSH_TOKEN,
        );
        assert.equal(remoteTag(created.tag), created.sha);
        context = releaseContext(created.sha, requested, true);
      }
    }
  } else {
    throw new Error(
      'Release preparation supports only tag pushes and manual dispatch.',
    );
  }
  appendFileSync(
    environment.GITHUB_OUTPUT,
    Object.entries(context)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  console.log(
    `Release context: ${context.tag} at ${context.sha}; publish=${context.publish}, build=${context.build}.`,
  );
  return context;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
