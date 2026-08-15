// @vitest-environment node

// The incident: `0.1.0-beta.4` was merged to development on 2026-08-12 by #727
// and no `v0.1.0-beta.4` tag existed until 2026-08-15. Nothing was red for
// those three days, because nothing was broken — the release simply never
// happened. `0.1.0-beta.3` (#713) had done the identical thing a week earlier,
// AFTER `.github/skills/release-drop/SKILL.md` wrote the rule down.
//
// The falsifier this suite exists for is not "does it notice a missing tag" —
// that arm is trivial and would pass in a check that reported a finding
// unconditionally. It is the pair below, which a naive implementation gets
// wrong in the direction that makes the tool useless:
//
//   no tag for this version, in a clone with tags     -> finding
//   no tag for this version, in a clone with NO tags  -> unverifiable
//
// A shallow checkout produces the second and it is byte-identical to the
// first. Reported as a finding it cries wolf on every run; reported as clean it
// is the very silence the check exists to break.
//
// The effect helpers are driven against REAL git repositories built with real
// `git commit`/`git tag`, matching this repo's convention
// (strandedBranches.test.ts, safeWorktreeRemove.test.ts). A mocked `git log -S`
// cannot falsify a bump-age reader that silently returns null for every input,
// and null is the value that grants an infinite grace window.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_GRACE_HOURS,
  EXIT_TAGGED,
  EXIT_UNTAGGED,
  EXIT_UNVERIFIABLE,
  VERDICT_MISPLACED,
  VERDICT_PENDING,
  VERDICT_TAGGED,
  VERDICT_UNTAGGED,
  VERDICT_UNVERIFIABLE,
  bumpAgeHoursAt,
  classifyPublication,
  classifyTagAncestry,
  classifyTagPresence,
  countVersionTags,
  evaluateRelease,
  formatResult,
  parseVersion,
  readVersionAt,
  tagAncestryCode,
  tagExists,
  tagNameForVersion,
} from '../scripts/check-release-tagged.mjs';

const onBranch = { reached: true, reason: 'points at a commit on the branch' };
const offBranch = { reached: false, reason: 'points at a commit elsewhere' };

/** The state development was actually in for three days. */
function beta4Untagged(overrides = {}) {
  return classifyTagPresence({
    version: '0.1.0-beta.4',
    tagExists: false,
    knownTagCount: 3,
    bumpAgeHours: 72,
    ...overrides,
  });
}

describe('naming the tag a version requires', () => {
  it('prefixes with v so it matches the workflow trigger', () => {
    expect(tagNameForVersion('0.1.0-beta.4')).toBe('v0.1.0-beta.4');
  });

  it('refuses to invent a name for a version it does not have', () => {
    expect(tagNameForVersion(undefined)).toBeNull();
    expect(tagNameForVersion('')).toBeNull();
    expect(tagNameForVersion('   ')).toBeNull();
  });
});

describe('reading the declared version', () => {
  it('reads a version out of a manifest', () => {
    expect(parseVersion('{"version":"0.1.0-beta.4"}')).toBe('0.1.0-beta.4');
  });

  it('returns null rather than throwing on an unparseable manifest', () => {
    expect(parseVersion('{not json')).toBeNull();
    expect(parseVersion('{"name":"x"}')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('reading tag ancestry three-valued', () => {
  it('reads 0 as on the branch', () => {
    expect(classifyTagAncestry({ code: 0, tagName: 'v1' }).reached).toBe(true);
  });

  it('reads 1 as a real no', () => {
    expect(classifyTagAncestry({ code: 1, tagName: 'v1' }).reached).toBe(false);
  });

  // #315: `if (code !== 0)` collapses 128 into the same bucket as 1.
  it('reads 128 as no answer at all, not as a no', () => {
    const reading = classifyTagAncestry({ code: 128, tagName: 'v1' });
    expect(reading.reached).toBeNull();
    expect(reading.reached).not.toBe(false);
  });
});

describe('the #727 finding', () => {
  it('reports a version that has sat untagged past the grace window', () => {
    expect(beta4Untagged().verdict).toBe(VERDICT_UNTAGGED);
  });

  it('names the tag that is missing, so the remedy is copy-pasteable', () => {
    expect(beta4Untagged().tagName).toBe('v0.1.0-beta.4');
    expect(formatResult({ presence: beta4Untagged() })).toContain(
      'git push origin v0.1.0-beta.4',
    );
  });

  it('exits non-zero on it', () => {
    expect(evaluateRelease({ presence: beta4Untagged() }).exitCode).toBe(
      EXIT_UNTAGGED,
    );
  });

  it('is clean once the tag exists on the branch', () => {
    const presence = classifyTagPresence({
      version: '0.1.0-beta.4',
      tagExists: true,
      knownTagCount: 4,
      tagAncestry: onBranch,
    });
    expect(presence.verdict).toBe(VERDICT_TAGGED);
    expect(evaluateRelease({ presence }).exitCode).toBe(EXIT_TAGGED);
  });
});

describe('the positive control, which is the whole difficulty', () => {
  // A fresh shallow checkout answers `git tag --list 'v*'` with nothing, which
  // is byte-identical to the tag genuinely being absent.
  it('refuses to call a version untagged when NO tags are visible at all', () => {
    const presence = beta4Untagged({ knownTagCount: 0 });
    expect(presence.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(presence.verdict).not.toBe(VERDICT_UNTAGGED);
    expect(presence.reason).toMatch(/fetched no tags/);
  });

  it('reports that as unverifiable rather than as a pass', () => {
    const presence = beta4Untagged({ knownTagCount: 0 });
    expect(evaluateRelease({ presence }).exitCode).toBe(EXIT_UNVERIFIABLE);
    expect(evaluateRelease({ presence }).exitCode).not.toBe(EXIT_TAGGED);
  });

  it('still reports a finding once even one tag proves tags are visible', () => {
    expect(beta4Untagged({ knownTagCount: 1 }).verdict).toBe(VERDICT_UNTAGGED);
  });
});

describe('the grace window', () => {
  it('holds a just-merged bump as pending rather than as a finding', () => {
    const presence = beta4Untagged({ bumpAgeHours: 0.2 });
    expect(presence.verdict).toBe(VERDICT_PENDING);
    expect(evaluateRelease({ presence }).exitCode).toBe(EXIT_TAGGED);
  });

  it('names the deadline, so pending is not silence', () => {
    expect(beta4Untagged({ bumpAgeHours: 0.5 }).reason).toMatch(
      /becomes a finding in 1\.5h/,
    );
  });

  it('turns into a finding by the passage of time with no new event', () => {
    expect(
      beta4Untagged({ bumpAgeHours: DEFAULT_GRACE_HOURS - 0.01 }).verdict,
    ).toBe(VERDICT_PENDING);
    expect(beta4Untagged({ bumpAgeHours: DEFAULT_GRACE_HOURS }).verdict).toBe(
      VERDICT_UNTAGGED,
    );
  });

  // An unreadable commit date must not buy an unbounded reprieve: null read as
  // "just landed" is a grace window that never closes.
  it('refuses to grant grace to a bump whose age it could not read', () => {
    const presence = beta4Untagged({ bumpAgeHours: null });
    expect(presence.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(presence.verdict).not.toBe(VERDICT_PENDING);
  });

  it('would have caught beta.3 as well, which sat about a day', () => {
    expect(
      beta4Untagged({ version: '0.1.0-beta.3', bumpAgeHours: 24 }).verdict,
    ).toBe(VERDICT_UNTAGGED);
  });
});

describe('a tag on a commit nobody merged', () => {
  // release-drop SKILL.md step 3: merges are squash, so the SHA on the PR
  // branch is NOT the SHA on development. A tag there builds unmerged work.
  it('reports a tag that is not an ancestor of the target', () => {
    const presence = classifyTagPresence({
      version: '0.1.0-beta.4',
      tagExists: true,
      knownTagCount: 4,
      tagAncestry: offBranch,
    });
    expect(presence.verdict).toBe(VERDICT_MISPLACED);
    expect(evaluateRelease({ presence }).exitCode).toBe(EXIT_UNTAGGED);
  });

  it('does not call an unreadable ancestry a misplaced tag', () => {
    const presence = classifyTagPresence({
      version: '0.1.0-beta.4',
      tagExists: true,
      knownTagCount: 4,
      tagAncestry: classifyTagAncestry({ code: 128, tagName: 'v0.1.0-beta.4' }),
    });
    expect(presence.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(presence.verdict).not.toBe(VERDICT_MISPLACED);
  });
});

describe('a version the manifest never gave', () => {
  it('is unverifiable, not a missing release', () => {
    const presence = classifyTagPresence({ version: null, tagExists: false });
    expect(presence.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(evaluateRelease({ presence }).exitCode).toBe(EXIT_UNVERIFIABLE);
  });
});

describe('the half a tag cannot answer', () => {
  const tagged = { verdict: VERDICT_TAGGED };

  it('reports a tag whose release never published', () => {
    const publication = classifyPublication({
      tagName: 'v0.1.0-beta.4',
      presence: VERDICT_TAGGED,
      release: { found: false, assets: [] },
    });
    expect(publication.published).toBe(false);
    expect(evaluateRelease({ presence: tagged, publication }).exitCode).toBe(
      EXIT_UNTAGGED,
    );
  });

  it('reports a release that carries nothing anyone can install', () => {
    const publication = classifyPublication({
      tagName: 'v0.1.0-beta.4',
      presence: VERDICT_TAGGED,
      release: { found: true, assets: [] },
    });
    expect(publication.published).toBe(false);
  });

  it('passes a release with artifacts attached', () => {
    const publication = classifyPublication({
      tagName: 'v0.1.0-beta.4',
      presence: VERDICT_TAGGED,
      release: {
        found: true,
        isPrerelease: true,
        assets: ['a.exe', 'b.zip', 'c.dmg', 'd.zip'],
      },
    });
    expect(publication.published).toBe(true);
    expect(evaluateRelease({ presence: tagged, publication }).exitCode).toBe(
      EXIT_TAGGED,
    );
  });

  // A missing token is a fact about the runner, not about the release.
  it('degrades to the git-only reading with no credential', () => {
    const publication = classifyPublication({
      tagName: 'v0.1.0-beta.4',
      presence: VERDICT_TAGGED,
      release: null,
    });
    expect(publication.checked).toBe(false);
    expect(publication.published).toBeNull();
    expect(evaluateRelease({ presence: tagged, publication }).exitCode).toBe(
      EXIT_TAGGED,
    );
  });

  it('does not let a clean publication half mask a missing tag', () => {
    expect(
      evaluateRelease({
        presence: beta4Untagged(),
        publication: { checked: true, published: true, reason: 'n/a' },
      }).exitCode,
    ).toBe(EXIT_UNTAGGED);
  });
});

describe('the effect helpers, against real repositories', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  function git(args: string[], cwd: string) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** A repo whose package.json is bumped exactly the way `npm version` does. */
  function makeRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'release-tagged-'));
    roots.push(root);
    git(['init', '--quiet', '-b', 'development', root], os.tmpdir());
    git(['config', 'user.name', 'Release fixture'], root);
    git(['config', 'user.email', 'fixture@example.invalid'], root);

    const bump = (version: string) => {
      writeFileSync(
        path.join(root, 'package.json'),
        `${JSON.stringify({ name: 'fixture', version }, null, 2)}\n`,
      );
      git(['add', 'package.json'], root);
      git(
        ['commit', '-q', '-m', `chore(release): set version to ${version}`],
        root,
      );
    };

    bump('0.1.0-beta.3');
    git(['tag', 'v0.1.0-beta.3'], root);
    bump('0.1.0-beta.4');

    return { root, bump };
  }

  it('reads the version the branch declares', () => {
    const { root } = makeRepo();
    expect(readVersionAt('HEAD', { cwd: root })).toBe('0.1.0-beta.4');
  });

  it('returns null for a ref that has no manifest at all', () => {
    const { root } = makeRepo();
    expect(readVersionAt('refs/heads/nope', { cwd: root })).toBeNull();
  });

  it('counts the tags that prove tags are visible', () => {
    const { root } = makeRepo();
    expect(countVersionTags({ cwd: root })).toBe(1);
  });

  it('finds a tag that exists and does not find one that does not', () => {
    const { root } = makeRepo();
    expect(tagExists('v0.1.0-beta.3', { cwd: root })).toBe(true);
    expect(tagExists('v0.1.0-beta.4', { cwd: root })).toBe(false);
  });

  it('reads a tag on the branch as an ancestor', () => {
    const { root } = makeRepo();
    expect(tagAncestryCode('v0.1.0-beta.3', 'HEAD', { cwd: root })).toBe(0);
  });

  // The squash-merge shape from release-drop step 3, built for real: a tag on
  // a commit that never reached the branch.
  it('reads a tag off the branch as a real no rather than as an error', () => {
    const { root } = makeRepo();
    git(['checkout', '-q', '-b', 'sidebranch'], root);
    writeFileSync(path.join(root, 'stray.txt'), 'stray\n');
    git(['add', 'stray.txt'], root);
    git(['commit', '-q', '-m', 'unmerged work'], root);
    git(['tag', 'v9.9.9'], root);
    git(['checkout', '-q', 'development'], root);

    expect(tagAncestryCode('v9.9.9', 'development', { cwd: root })).toBe(1);
    expect(
      classifyTagAncestry({
        code: tagAncestryCode('v9.9.9', 'development', { cwd: root }),
        tagName: 'v9.9.9',
      }).reached,
    ).toBe(false);
  });

  // `git log -S` is the arm that silently answers null for everything, and
  // null is the value that grants an unbounded grace window.
  it('dates the bump from the commit that introduced the version', () => {
    const { root } = makeRepo();
    const age = bumpAgeHoursAt('HEAD', '0.1.0-beta.4', Date.now(), {
      cwd: root,
    });
    expect(age).not.toBeNull();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(1);
  });

  it('dates an older version from ITS bump, not from the branch tip', () => {
    const { root } = makeRepo();
    const hourAgo = Date.now() + 3_600_000;
    const age = bumpAgeHoursAt('HEAD', '0.1.0-beta.3', hourAgo, { cwd: root });
    expect(age).toBeGreaterThanOrEqual(1);
  });

  it('returns null, never 0, for a version no commit ever introduced', () => {
    const { root } = makeRepo();
    expect(
      bumpAgeHoursAt('HEAD', '4.5.6', Date.now(), { cwd: root }),
    ).toBeNull();
  });

  // End to end over the fixture: the repository in exactly the #727 state.
  it('classifies the real #727 shape as a finding', () => {
    const { root } = makeRepo();
    const version = readVersionAt('HEAD', { cwd: root }) as string;
    const tagName = tagNameForVersion(version) as string;
    const presence = classifyTagPresence({
      version,
      tagExists: tagExists(tagName, { cwd: root }),
      knownTagCount: countVersionTags({ cwd: root }),
      bumpAgeHours: 72,
    });
    expect(presence.verdict).toBe(VERDICT_UNTAGGED);
    expect(presence.tagName).toBe('v0.1.0-beta.4');
  });

  it('classifies the same repository as clean once the tag is pushed', () => {
    const { root } = makeRepo();
    git(['tag', 'v0.1.0-beta.4'], root);
    const version = readVersionAt('HEAD', { cwd: root }) as string;
    const tagName = tagNameForVersion(version) as string;
    const presence = classifyTagPresence({
      version,
      tagExists: tagExists(tagName, { cwd: root }),
      knownTagCount: countVersionTags({ cwd: root }),
      tagAncestry: classifyTagAncestry({
        code: tagAncestryCode(tagName, 'HEAD', { cwd: root }),
        tagName,
        targetRef: 'HEAD',
      }),
      bumpAgeHours: 72,
    });
    expect(presence.verdict).toBe(VERDICT_TAGGED);
  });
});
