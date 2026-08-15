// Does the version development claims correspond to a release that shipped?
//
// No shebang, matching check-script-reachability.mjs: this module is imported
// by tests/releaseTagged.test.ts, and vite's transform does not strip one the
// way node does. Nothing executes it as `./check-release-tagged.mjs` — the
// workflow and package.json both spell it `node scripts/...`.
//
// `.github/workflows/release.yml` triggers on `push: tags: ['v*']` and nothing
// else. The version bump and the tag are two separate acts, and only the second
// one publishes. Between them sits a state nothing observes: `package.json` on
// development names a version, no tag names it, and every check in the
// repository is green because nothing is broken -- the release simply never
// happened.
//
//   A VERSION IS NOT EVIDENCE THAT A RELEASE SHIPPED.
//
// Measured here, this state is the norm rather than the exception:
//
//   0.1.0-beta.3   #713 merged 2026-08-10, tagged by hand ~1 day later
//   0.1.0-beta.4   #727 merged 2026-08-12, tagged by hand 2026-08-15 (3 days)
//
// Both were noticed by a person asking "what happened to the beta?", which is
// the detection mechanism this replaces. `.github/skills/release-drop/SKILL.md`
// already wrote the rule down after the first occurrence -- "Merging the
// version-bump PR publishes nothing" -- and the second occurrence happened
// anyway. A documented step is a convention, not a control, until something
// runs it for you.
//
// WHY THIS CANNOT RUN ON pull_request
//
// The subject is the state of development BETWEEN two events, and the interval
// is open-ended. At the moment the bump PR merges there is legitimately no tag,
// so a per-PR run would be green and correct and useless -- the same shape as
// `# merge-queue: publication` in merge-landed.yml (#391). The unit of
// assertion is the branch as it stands now, so this runs on a schedule.
//
// WHY A GRACE WINDOW, AND WHY IT IS NOT A SILENCER
//
// The tag legitimately trails the merge by the time it takes a human to push
// it, and the matrix build itself takes 20-40 minutes. Reporting instantly
// would make the ordinary release procedure red for its whole duration, and a
// check that is red during correct conduct is one whose remedy is to switch it
// off. So an untagged bump inside the window is PENDING, which is a distinct
// verdict rather than a pass: it is printed, it names the deadline, and it
// turns into a finding by the passage of time alone with no new event needed.
//
// THE POSITIVE CONTROL, WHICH IS THE WHOLE DIFFICULTY
//
//   git tag --list 'v*'   in a fresh shallow clone   -> (nothing)
//   git tag --list 'v*'   with the tag genuinely gone -> (nothing)
//
// "No tag matches this version" and "this clone has no tags at all" are
// byte-identical readings, and the second one is what a checkout without
// `fetch-depth: 0` / `fetch-tags` produces. Reported as a finding it would be a
// false alarm on every run in a misconfigured job; reported as a pass it would
// be the #391 failure exactly -- the instrument built to catch a silent absence
// going silent itself. So the tag universe must be non-empty before any absence
// reading is admitted, and an empty one is UNVERIFIABLE.
//
// THREE-VALUED THROUGHOUT (#315)
//
// `git merge-base --is-ancestor` answers 1 for "no" and 128 for "could not
// answer". A tag that exists but is not an ancestor of development is a real
// finding (the release-drop skill's step 3: a squash merge means the SHA on the
// PR branch is NOT the SHA on development, and tagging the branch commit tags
// something no one will ever ship). A tag git could not resolve is not that,
// and must not be reported as it.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERDICT_TAGGED = 'tagged';
export const VERDICT_UNTAGGED = 'untagged';
export const VERDICT_PENDING = 'pending';
export const VERDICT_MISPLACED = 'misplaced';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_TAGGED = 0;
export const EXIT_UNTAGGED = 1;
export const EXIT_UNVERIFIABLE = 2;

export const DEFAULT_GRACE_HOURS = 2;

/**
 * The tag name a version must carry. Never hand-written at a call site: the
 * leading `v` is what `push: tags: ['v*']` matches, and the presence of `-` is
 * what release.yml reads as IS_BETA_RELEASE, so both are consequences of the
 * version rather than choices.
 */
export function tagNameForVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }
  return `v${version.trim()}`;
}

/**
 * The version `package.json` declares, or null if the file cannot be read as
 * one. Null is never a finding here -- an unparseable manifest says nothing
 * about whether a release shipped.
 */
export function parseVersion(packageJsonText) {
  if (typeof packageJsonText !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(packageJsonText);
    const version = parsed?.version;
    return typeof version === 'string' && version.trim() !== ''
      ? version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Ancestry, read three-valued. `code` is the raw exit status of
 * `git merge-base --is-ancestor`, taken AFTER the tag object has been fetched.
 */
export function classifyTagAncestry({ code, tagName, targetRef } = {}) {
  if (code === 0) {
    return {
      reached: true,
      reason: `${tagName} points at a commit on ${targetRef}`,
    };
  }
  if (code === 1) {
    return {
      reached: false,
      reason: `${tagName} points at a commit that is NOT on ${targetRef}`,
    };
  }
  return {
    reached: null,
    reason: `git could not answer whether ${tagName} is on ${targetRef} (exit ${code})`,
  };
}

/**
 * Is the version development claims tagged?
 *
 * Every input is already-resolved fact so that each arm is drivable from a
 * plain object; an arm no real input can provoke is unbound and equivalent to a
 * deleted one.
 *
 * Order is load-bearing. The positive control is consulted BEFORE absence is
 * read, because an empty tag universe explains the absence by the clone rather
 * than by the release -- and an absence assertion that passes for the wrong
 * reason is the defect, not the report.
 */
export function classifyTagPresence({
  version,
  tagExists,
  knownTagCount,
  tagAncestry,
  bumpAgeHours,
  graceHours = DEFAULT_GRACE_HOURS,
} = {}) {
  const tagName = tagNameForVersion(version);

  if (tagName === null) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      tagName: null,
      reason: `no usable version on the target (${JSON.stringify(version ?? null)}), so there is nothing to look for a tag for`,
    };
  }

  if (tagExists === true) {
    if (!tagAncestry || tagAncestry.reached === null) {
      return {
        verdict: VERDICT_UNVERIFIABLE,
        tagName,
        reason: tagAncestry
          ? tagAncestry.reason
          : `${tagName} exists but its ancestry was never read`,
      };
    }
    if (tagAncestry.reached === false) {
      return {
        verdict: VERDICT_MISPLACED,
        tagName,
        reason: `${tagName} exists but ${tagAncestry.reason}; a squash merge puts the shipped commit on the branch, not on the PR head, so this tag builds something that was never merged`,
      };
    }
    return {
      verdict: VERDICT_TAGGED,
      tagName,
      reason: `${tagName} exists and ${tagAncestry.reason}`,
    };
  }

  // POSITIVE CONTROL. Consulted only once absence is what is being claimed.
  if (!Number.isFinite(knownTagCount) || knownTagCount <= 0) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      tagName,
      reason: `no v* tags are visible at all, so "${tagName} is absent" is indistinguishable from a clone that fetched no tags; no absence reading from this run means anything`,
    };
  }

  if (!Number.isFinite(bumpAgeHours)) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      tagName,
      reason: `${tagName} is absent, but the age of the commit that set version ${version} could not be read, so it cannot be told from a bump that landed a minute ago`,
    };
  }

  if (bumpAgeHours < graceHours) {
    const remaining = graceHours - bumpAgeHours;
    return {
      verdict: VERDICT_PENDING,
      tagName,
      reason: `${tagName} is not pushed yet, and the bump is ${bumpAgeHours.toFixed(1)}h old; this becomes a finding in ${remaining.toFixed(1)}h with no further event`,
    };
  }

  return {
    verdict: VERDICT_UNTAGGED,
    tagName,
    reason: `${tagName} does not exist, yet the target has claimed version ${version} for ${bumpAgeHours.toFixed(1)}h; merging the version-bump PR publishes nothing, so nothing has shipped`,
  };
}

/**
 * The half a tag cannot answer: the build passing is not the same as the
 * release existing, and a tag whose build failed leaves the same green tag
 * behind as one whose build published four artifacts.
 *
 * `release` is null when no credential was available. That degrades to
 * git-only rather than failing (the pattern check-merge-queue-contexts.mjs uses
 * for its remote half), because a missing token is a fact about the runner and
 * not about the release.
 */
export function classifyPublication({ tagName, presence, release } = {}) {
  if (presence !== VERDICT_TAGGED) {
    return {
      checked: false,
      published: null,
      reason: 'no reachable tag, so there is no release to look for',
    };
  }
  if (release === null || release === undefined) {
    return {
      checked: false,
      published: null,
      reason: `no credential available, so whether ${tagName} actually published a release is unread`,
    };
  }
  if (release.found !== true) {
    return {
      checked: true,
      published: false,
      reason: `${tagName} exists on the branch but no GitHub release was published for it; the tag build did not finish, or it failed`,
    };
  }
  const assetCount = Array.isArray(release.assets) ? release.assets.length : 0;
  if (assetCount === 0) {
    return {
      checked: true,
      published: false,
      reason: `the release for ${tagName} exists but carries no assets, so there is nothing for anyone to install`,
    };
  }
  return {
    checked: true,
    published: true,
    reason: `${tagName} published a release with ${assetCount} asset(s)`,
  };
}

/**
 * The run's verdict and exit code.
 *
 * A published-half failure is reported as UNTAGGED (exit 1) deliberately: from
 * the outside, a tag with no release and no tag at all are the same event --
 * the version development claims is not installable by anyone.
 */
export function evaluateRelease({ presence, publication } = {}) {
  if (
    presence?.verdict === VERDICT_UNTAGGED ||
    presence?.verdict === VERDICT_MISPLACED
  ) {
    return { exitCode: EXIT_UNTAGGED, verdict: presence.verdict };
  }
  if (presence?.verdict === VERDICT_UNVERIFIABLE) {
    return { exitCode: EXIT_UNVERIFIABLE, verdict: VERDICT_UNVERIFIABLE };
  }
  if (publication?.checked === true && publication.published === false) {
    return { exitCode: EXIT_UNTAGGED, verdict: VERDICT_UNTAGGED };
  }
  return {
    exitCode: EXIT_TAGGED,
    verdict: presence?.verdict ?? VERDICT_UNVERIFIABLE,
  };
}

export function formatResult({ targetRef, version, presence, publication }) {
  const lines = [
    `[release-tagged] ${targetRef ?? '(unknown)'} claims version ${version ?? '(unreadable)'} — ${presence?.verdict ?? VERDICT_UNVERIFIABLE}`,
    `  ${presence?.reason ?? 'nothing was read'}`,
  ];
  if (publication?.reason) {
    lines.push(`  ${publication.reason}`);
  }
  if (presence?.verdict === VERDICT_UNTAGGED) {
    lines.push(
      `  Remedy: git tag ${presence.tagName} <sha on ${targetRef}> && git push origin ${presence.tagName}`,
      '  See .github/skills/release-drop/SKILL.md step 4.',
    );
  }
  if (presence?.verdict === VERDICT_MISPLACED) {
    lines.push(
      '  Remedy: delete the tag and re-cut it from the commit on the branch. See .github/skills/release-drop/SKILL.md step 3.',
    );
  }
  return lines.join('\n');
}

// --- effects -------------------------------------------------------------

function git(args, { allowFailure = false, cwd } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }
    return { code: error.status ?? 128, stdout: '' };
  }
}

export function readVersionAt(targetRef, { cwd } = {}) {
  const result = git(['show', `${targetRef}:package.json`], {
    allowFailure: true,
    cwd,
  });
  return result.code === 0 ? parseVersion(result.stdout) : null;
}

export function countVersionTags({ cwd } = {}) {
  const result = git(['tag', '--list', 'v*'], { allowFailure: true, cwd });
  if (result.code !== 0) {
    return 0;
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
    .length;
}

export function tagExists(tagName, { cwd } = {}) {
  return (
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`], {
      allowFailure: true,
      cwd,
    }).code === 0
  );
}

export function tagAncestryCode(tagName, targetRef, { cwd } = {}) {
  return git(
    ['merge-base', '--is-ancestor', `${tagName}^{commit}`, targetRef],
    {
      allowFailure: true,
      cwd,
    },
  ).code;
}

/**
 * Hours since the commit that gave the target this version.
 *
 * `-S` on the exact version string finds the commit that INTRODUCED it, which
 * is the bump itself rather than the most recent commit to touch the file. A
 * commit date git cannot produce yields null, never 0 -- 0 would read as "just
 * landed" and grant a grace window to a bump from last month.
 */
export function bumpAgeHoursAt(
  targetRef,
  version,
  now = Date.now(),
  { cwd } = {},
) {
  const result = git(
    [
      'log',
      '-1',
      '--format=%cI',
      `-S"version": "${version}"`,
      targetRef,
      '--',
      'package.json',
    ],
    { allowFailure: true, cwd },
  );
  const stamp = result.stdout.trim();
  if (result.code !== 0 || stamp === '') {
    return null;
  }
  const committedAt = Date.parse(stamp);
  if (!Number.isFinite(committedAt)) {
    return null;
  }
  return (now - committedAt) / 3_600_000;
}

function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = git(['remote', 'get-url', 'origin'], {
    allowFailure: true,
  }).stdout.trim();
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

export async function fetchRelease({ repository, token, tagName }) {
  if (!repository || !token) {
    return null;
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${tagName}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'check-release-tagged',
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status === 404) {
    return { found: false, assets: [] };
  }
  if (!response.ok) {
    // Not a finding: an API that would not answer says nothing about the
    // release. Degrades to the git-only reading.
    return null;
  }
  const release = await response.json();
  return {
    found: true,
    isPrerelease: release.prerelease === true,
    assets: (release.assets ?? []).map((asset) => asset.name),
  };
}

export async function main(argv = process.argv.slice(2)) {
  let targetRef = 'origin/development';
  let graceHours = DEFAULT_GRACE_HOURS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      targetRef = argv[index + 1];
      index += 1;
    } else if (arg === '--grace-hours') {
      graceHours = Number.parseFloat(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-release-tagged [--target <ref>] [--grace-hours <n>]`,
      );
    }
  }

  git(['fetch', '--quiet', '--tags', 'origin'], { allowFailure: true });

  const version = readVersionAt(targetRef);
  const tagName = tagNameForVersion(version);
  const exists = tagName === null ? false : tagExists(tagName);

  const presence = classifyTagPresence({
    version,
    tagExists: exists,
    knownTagCount: countVersionTags(),
    tagAncestry: exists
      ? classifyTagAncestry({
          code: tagAncestryCode(tagName, targetRef),
          tagName,
          targetRef,
        })
      : undefined,
    bumpAgeHours: version === null ? null : bumpAgeHoursAt(targetRef, version),
    graceHours,
  });

  const publication = classifyPublication({
    tagName,
    presence: presence.verdict,
    release:
      presence.verdict === VERDICT_TAGGED
        ? await fetchRelease({
            repository: resolveRepository(),
            token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '',
            tagName,
          })
        : null,
  });

  console.log(formatResult({ targetRef, version, presence, publication }));
  return evaluateRelease({ presence, publication }).exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`[release-tagged] ${error.message}`);
      process.exitCode = EXIT_UNVERIFIABLE;
    });
}
