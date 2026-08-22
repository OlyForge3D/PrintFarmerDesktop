import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canAutoScope,
  classifyChangeScope,
  collectVerdicts,
  diffFingerprint,
  evaluateGate,
  fullGateFiles,
  fullGatePrefixes,
  hasAdminAccess,
  hasSquadScopeLabel,
  hasWriteAccess,
  isCarriedAcrossSync,
  normalizeMember,
  parseVerdictComment,
  resolveAuthorMembers,
  rosterFromLabels,
  sensitiveProseFiles,
  sensitiveProsePrefixes,
} from '../scripts/squad-verdict-gate.mjs';

// Ported from OlyForge3D/PrintFarmer's scripts/ci/tests/test-squad-verdict-gate.mjs
// (PR #1316, fixing PrintFarmer issue #1310) for this repository's issue #740.
// Every case is carried across; the harness is vitest to match this repo's
// convention rather than PrintFarmer's node:test, and the fixtures are rewritten
// against this repository's real roster, paths and workflows.

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const headSha = 'a'.repeat(40);
const staleSha = 'b'.repeat(40);

// This repository's `squad:*` labels are plain (no emoji), unlike PrintFarmer's.
// One decorated entry is kept so `normalizeMember`'s emoji handling stays
// covered even though nothing here produces that shape today.
const roster = rosterFromLabels([
  'squad:bishop',
  'squad:hicks',
  'squad:vasquez',
  'squad:ripley',
  'squad:dallas',
  'squad:rai',
  'squad:scribe',
  'squad:fact-checker',
  'squad:ralph',
  'squad:copilot',
  'squad:🔍 nostromo-crew',
  'priority:p1',
]);

const codePaths = ['src/main/index.ts'];
const docPaths = ['docs/ARCHITECTURE.md'];

function comment(
  reviewer: string,
  verdict: string,
  sha: string = headSha,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: Math.floor(Math.random() * 1e6),
    body: [
      '<!-- squad-verdict -->',
      `Squad-Reviewer: ${reviewer}`,
      `Squad-Verdict: ${verdict}`,
      `Squad-Head-SHA: ${sha}`,
    ].join('\n'),
    user: { login: 'jpapiez' },
    author_association: 'OWNER',
    squadWriteAccess: true,
    created_at: '2026-08-08T01:00:00Z',
    updated_at: '2026-08-08T01:00:00Z',
    ...overrides,
  };
}

function gate(overrides: Record<string, unknown> = {}) {
  return evaluateGate({
    headSha,
    changedPaths: codePaths,
    comments: [],
    reviews: [],
    roster,
    // Ripley is on the roster but not on the review panel, so it stands in for
    // PrintFarmer's `parker` without colliding with bishop/hicks/vasquez.
    authorMembers: new Set(['ripley']),
    authorSource: 'squad: label on linked issue',
    // Scope defaults to in-scope here so each test exercises the review logic;
    // the out-of-scope path has its own dedicated tests below.
    squadLabeled: true,
    ...overrides,
  });
}

const workflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'squad-review-verdict.yml',
);
const readWorkflow = () =>
  readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');

describe('parsing a review record comment', () => {
  it('normalizes emoji-decorated squad identities', () => {
    expect(normalizeMember('squad:🔍 Bishop')).toBe('bishop');
    expect(normalizeMember('Bishop')).toBe('bishop');
    expect(normalizeMember('🔍')).toBeUndefined();
    expect(roster.has('vasquez')).toBe(true);
    expect(roster.has('fact-checker')).toBe(true);
    expect(roster.has('p1')).toBe(false);
  });

  it('parses a canonical verdict comment', () => {
    const record = parseVerdictComment(comment('Bishop', 'APPROVE'));
    expect(record?.reviewer).toBe('bishop');
    expect(record?.verdict).toBe('APPROVE');
    expect(record?.headSha).toBe(headSha);
    expect(record?.trusted).toBe(true);
  });

  it('normalizes REJECT and CHANGES_REQUESTED to REQUEST_CHANGES', () => {
    for (const alias of ['REJECT', 'CHANGES_REQUESTED', 'request_changes']) {
      expect(parseVerdictComment(comment('hicks', alias))?.verdict).toBe(
        'REQUEST_CHANGES',
      );
    }
  });

  it('ignores a comment carrying two different verdicts', () => {
    const ambiguous = comment('bishop', 'APPROVE');
    ambiguous.body += '\nSquad-Verdict: REQUEST_CHANGES';
    expect(parseVerdictComment(ambiguous)).toBeUndefined();
  });

  it('requires the squad-verdict marker', () => {
    const unmarked = comment('bishop', 'APPROVE');
    unmarked.body = unmarked.body.replace(
      '<!-- squad-verdict -->',
      'Looks good:',
    );
    expect(parseVerdictComment(unmarked)).toBeUndefined();
  });

  it('a fenced example of the format is not a binding verdict', () => {
    const illustration = comment('bishop', 'APPROVE');
    illustration.body = [
      'Record verdicts like this:',
      '```text',
      '<!-- squad-verdict -->',
      'Squad-Reviewer: bishop',
      'Squad-Verdict: APPROVE',
      `Squad-Head-SHA: ${headSha}`,
      '```',
    ].join('\n');
    expect(parseVerdictComment(illustration)).toBeUndefined();
  });

  it('a verbatim quote-reply of a verdict is not a fresh verdict', () => {
    const quoted = comment('bishop', 'APPROVE');
    quoted.body = `${quoted.body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\nAgreed.`;
    expect(parseVerdictComment(quoted)).toBeUndefined();
  });

  it('a repeated field is ambiguous even when the values agree', () => {
    const doubled = comment('bishop', 'APPROVE');
    doubled.body += '\nSquad-Verdict: APPROVE';
    expect(parseVerdictComment(doubled)).toBeUndefined();
  });

  it('fields hidden in an HTML comment are not a record', () => {
    // Such a comment renders as two innocuous sentences on GitHub. Counting it
    // would break the audit-trail property: a human reading the thread could
    // not see the evidence the gate used.
    const hidden = comment('bishop', 'APPROVE');
    hidden.body = [
      'Thanks, looks fine to me!',
      '<!-- squad-verdict -->',
      '<!--',
      'Squad-Reviewer: bishop',
      'Squad-Verdict: APPROVE',
      `Squad-Head-SHA: ${headSha}`,
      '-->',
      'Nothing to see here.',
    ].join('\n');
    expect(parseVerdictComment(hidden)).toBeUndefined();
  });

  it('an unterminated fence hides its contents, matching how GitHub renders it', () => {
    const unterminated = comment('bishop', 'APPROVE');
    unterminated.body = [
      'Here is the format:',
      '```text',
      unterminated.body,
    ].join('\n');
    expect(parseVerdictComment(unterminated)).toBeUndefined();
  });
});

describe('authenticating the account behind a record', () => {
  it('drops verdicts from accounts without repository write access', () => {
    // author_association alone is not a permission level: GitHub reports MEMBER
    // for any organisation member and COLLABORATOR for read-only collaborators.
    const readOnlyMember = comment('bishop', 'APPROVE', headSha, {
      author_association: 'MEMBER',
      user: { login: 'org-member' },
      squadWriteAccess: false,
    });
    expect(parseVerdictComment(readOnlyMember)?.trusted).toBe(false);
    expect(collectVerdicts([readOnlyMember], headSha).current.size).toBe(0);
  });

  it('#744 control pair: write access authenticates regardless of author_association, but read access never does', () => {
    // #744 root cause, measured against a real PR: the live collaborator-
    // permission lookup correctly resolved a genuine repository admin to
    // `admin`, but that same account's GitHub-computed `author_association`
    // was `CONTRIBUTOR` — not `OWNER`/`MEMBER`/`COLLABORATOR` — so the old
    // allow-list rejected every verdict, including the owner's own. Trust must
    // key off `squadWriteAccess` (the live, authoritative permission check)
    // alone; `author_association` is audit metadata, never a gate.
    //
    // POSITIVE: an authenticated write-access account is trusted even though
    // its association is an unrecognised/unexpected value.
    const genuineAdminWithUnexpectedAssociation = comment(
      'bishop',
      'APPROVE',
      headSha,
      {
        author_association: 'CONTRIBUTOR',
        user: { login: 'jpapiez' },
        squadWriteAccess: hasWriteAccess('admin'),
      },
    );
    expect(
      parseVerdictComment(genuineAdminWithUnexpectedAssociation)?.trusted,
    ).toBe(true);
    expect(
      collectVerdicts([genuineAdminWithUnexpectedAssociation], headSha).current
        .size,
    ).toBe(1);

    // CONTROL (same predicate, same data shape): a non-collaborator resolves
    // to `read` on this public repository. Loosening the association
    // requirement must not also loosen the write-access requirement — this
    // must still fail, proving the fix does not convert the fail-closed gate
    // into one that trusts everyone.
    const strangerWithSameShapedComment = comment(
      'bishop',
      'APPROVE',
      headSha,
      {
        author_association: 'CONTRIBUTOR',
        user: { login: 'drive-by-stranger' },
        squadWriteAccess: hasWriteAccess('read'),
      },
    );
    expect(parseVerdictComment(strangerWithSameShapedComment)?.trusted).toBe(
      false,
    );
    expect(
      collectVerdicts([strangerWithSameShapedComment], headSha).current.size,
    ).toBe(0);
    expect(
      collectVerdicts([strangerWithSameShapedComment], headSha).unauthenticated
        .length,
    ).toBe(1);
  });

  it('only write or better may record a review, and lookups fail closed', () => {
    // This repository is public: any GitHub user can comment on a PR with no
    // permission at all, and a non-collaborator resolves to `read`.
    for (const permission of ['admin', 'maintain', 'write', 'push']) {
      expect(hasWriteAccess(permission)).toBe(true);
    }
    for (const permission of [
      'read',
      'triage',
      'none',
      '',
      'ADMIN',
      'Write',
      'unresolved',
      undefined,
      null,
      0,
      {},
      [],
      NaN,
      true,
    ]) {
      expect(hasWriteAccess(permission)).toBe(false);
    }
    // The owner override needs admin specifically, not merely write.
    expect(hasAdminAccess('admin')).toBe(true);
    for (const permission of [
      'maintain',
      'write',
      'push',
      'read',
      'unresolved',
      undefined,
    ]) {
      expect(hasAdminAccess(permission)).toBe(false);
    }
  });

  it('an outsider on a public repo cannot forge a review record', () => {
    // The attack this closes: a stranger opens a PR, posts a canonical APPROVE
    // comment at the current head, and Ralph merges it unattended using the
    // owner's write access.
    const outsiders = ['bishop', 'hicks', 'vasquez'].map((member) =>
      comment(member, 'APPROVE', headSha, {
        user: { login: 'drive-by-stranger' },
        author_association: 'NONE',
        // Models the live permission lookup returning `read`, which is what a
        // non-collaborator resolves to on a public repository.
        squadWriteAccess: hasWriteAccess('read'),
      }),
    );
    const result = gate({ comments: outsiders });
    expect(result.state).toBe('failure');
    expect(result.description).toMatch(/^BLOCKED @ /);
    expect(result.description).toMatch(/no authenticated review/);
    expect(
      result.notes.some((note) => note.includes('could not be authenticated')),
    ).toBe(true);
  });

  it('an unresolvable permission lookup fails closed rather than open', () => {
    const unresolved = comment('bishop', 'APPROVE', headSha, {
      user: { login: 'rate-limited-user' },
      // Models the workflow's catch path: the lookup threw or returned an
      // unexpected shape, so no write access could be established.
      squadWriteAccess: hasWriteAccess('unresolved'),
    });
    const { current, unauthenticated } = collectVerdicts([unresolved], headSha);
    expect(current.size).toBe(0);
    expect(unauthenticated.length).toBe(1);
    expect(gate({ changedPaths: docPaths, comments: [unresolved] }).state).toBe(
      'failure',
    );
  });

  it('identity comes from the account, never from the comment text', () => {
    // A comment merely *claiming* to be the owner is not the owner. The
    // override flag is set by the workflow from the API-supplied login plus an
    // admin permission lookup, so text alone can never trigger it.
    const impostor = comment('jpapiez', 'APPROVE', headSha, {
      user: { login: 'not-jpapiez' },
      author_association: 'NONE',
      squadWriteAccess: hasWriteAccess('read'),
    });
    const parsed = parseVerdictComment(impostor);
    expect(parsed?.commenter).toBe('not-jpapiez');
    expect(parsed?.trusted).toBe(false);
    expect(parsed?.isSelfDeclaredAdmin).toBe(false);
    expect(gate({ comments: [impostor] }).state).toBe('failure');
  });

  it('drops verdicts from untrusted commenters', () => {
    const outsider = comment('bishop', 'APPROVE', headSha, {
      author_association: 'NONE',
      user: { login: 'drive-by' },
      squadWriteAccess: false,
    });
    expect(collectVerdicts([outsider], headSha).current.size).toBe(0);
  });
});

describe('ranking records against the live head', () => {
  it('keeps only the newest verdict per reviewer', () => {
    const older = comment('bishop', 'APPROVE', headSha, {
      updated_at: '2026-08-08T01:00:00Z',
    });
    const newer = comment('bishop', 'REQUEST_CHANGES', headSha, {
      updated_at: '2026-08-08T02:00:00Z',
    });
    const { current } = collectVerdicts([older, newer], headSha);
    expect(current.get('bishop')?.verdict).toBe('REQUEST_CHANGES');
  });

  it('a stale verdict cannot erase a live rejection from the same reviewer', () => {
    const rejection = comment('bishop', 'REQUEST_CHANGES', headSha, {
      updated_at: '2026-08-08T01:00:00Z',
    });
    const staleApproval = comment('bishop', 'APPROVE', staleSha, {
      updated_at: '2026-08-08T03:00:00Z',
    });
    const { current, stale } = collectVerdicts(
      [rejection, staleApproval],
      headSha,
    );
    expect(current.get('bishop')?.verdict).toBe('REQUEST_CHANGES');
    expect(stale.length).toBe(0);

    const result = gate({
      changedPaths: docPaths,
      comments: [rejection, staleApproval, comment('hicks', 'APPROVE')],
    });
    expect(result.state).toBe('failure');
    expect(result.description).toMatch(/^REQUEST_CHANGES @ .* by bishop$/);
  });

  it('accepts a full panel approval at the current head', () => {
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE'),
        comment('hicks', 'APPROVE'),
        comment('vasquez', 'APPROVE'),
      ],
    });
    expect(result.state).toBe('success');
    expect(result.description).toBe(
      `REVIEWED (self-attested) @ ${headSha.slice(0, 12)} by bishop+hicks+vasquez`,
    );
    expect(
      result.notes.some((note) => note.includes('not independent review')),
    ).toBe(true);
  });

  it('rejects verdicts pinned to a stale SHA', () => {
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE', staleSha),
        comment('hicks', 'APPROVE', staleSha),
        comment('vasquez', 'APPROVE', staleSha),
      ],
    });
    expect(result.state).toBe('failure');
    expect(result.stale.length).toBe(3);
    expect(result.reason).toMatch(/every recorded review is stale/);
    expect(result.description).toMatch(/^BLOCKED @ /);
  });
});

// --- Sync carry-forward exemption ------------------------------------------
//
// A record at an old head SHA stays valid at the new head when (1) the old
// SHA is a strict ancestor of the new head, (2) the PR's own diff against the
// base branch is byte-for-byte unchanged between the old SHA and the new
// head, AND (3) every commit introduced since review that isn't already
// reachable from base is a clean two-parent merge introducing nothing beyond
// merging its own two parents (proven via `compare(parent1...parent2)` — NOT
// "content-empty against its own first parent", which is a real,
// verified-wrong assumption for this case).
// `isCarriedAcrossSync` is the pure predicate; `carriedShas` is how a caller
// (the workflow, having already computed the compares and per-commit
// lookups) tells `collectVerdicts`/`evaluateGate` which old SHAs satisfy it.
//
// Condition 2 is deliberately a diff-equality check, not "every new commit is
// an ancestor of base": a plain `git merge development` always creates a
// fresh merge commit that is itself NOT an ancestor of base, so a naive
// commit-membership check would reject the very sync this feature exists to
// allow. `development` is `strict: true`, so that sync is mandatory here.
//
// Condition 3 exists because (1)+(2) alone permit a revert-then-readd trick:
// an author pushes a commit that changes the PR's contribution and a later
// commit that reverts it, landing back on the same final diff while still
// having authored real changes in the range.

function file(overrides: Record<string, unknown> = {}) {
  return {
    status: 'modified',
    filename: 'src/main/index.ts',
    sha: 'a'.repeat(40),
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  };
}

describe('carrying a record across a pure base sync', () => {
  it('a pure base-sync merge (identical PR diff, clean merge commit) is carried forward', () => {
    // Both compares recover exactly the PR's own contribution: three-dot
    // compare pivots on the merge base, so `compare(base...oldSha)` still
    // finds the PR's original diff and `compare(base...newHead)` finds the
    // same diff again now that the sync merge has folded base in.
    const reviewedDiffFiles = [
      file({ filename: 'src/main/index.ts' }),
      file({ filename: 'src/renderer/App.tsx', sha: 'b'.repeat(40) }),
    ];
    const currentDiffFiles = [
      file({ filename: 'src/renderer/App.tsx', sha: 'b'.repeat(40) }),
      file({ filename: 'src/main/index.ts' }),
    ];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles,
        nonBaseCommitsIntroduceNoExtraContent: true,
      }),
    ).toBe(true);
  });

  it('a new author commit that changes the PR diff is not carried forward', () => {
    const reviewedDiffFiles = [
      file({ filename: 'src/main/index.ts', sha: 'a'.repeat(40) }),
    ];
    // Same file, but its resulting content (and patch) changed since review —
    // this is exactly what a new author-authored commit looks like, whether it
    // stands alone or was folded into the sync merge commit as a "conflict
    // resolution".
    const currentDiffFiles = [
      file({
        filename: 'src/main/index.ts',
        sha: 'c'.repeat(40),
        patch: '@@ -1 +1 @@\n-old\n+malicious',
      }),
    ];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles,
        nonBaseCommitsIntroduceNoExtraContent: true,
      }),
    ).toBe(false);
  });

  it('a new author commit that adds a file to the PR diff is not carried forward', () => {
    const reviewedDiffFiles = [file({ filename: 'src/main/index.ts' })];
    const currentDiffFiles = [
      file({ filename: 'src/main/index.ts' }),
      file({ filename: 'src/main/newFile.ts', sha: 'd'.repeat(40) }),
    ];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles,
        nonBaseCommitsIntroduceNoExtraContent: true,
      }),
    ).toBe(false);
  });

  it('a revert-then-readd of the same final diff is NOT carried forward', () => {
    // An author pushes a commit changing the PR, then a later commit reverting
    // it, landing back on the exact same final diff — diff-equality (condition
    // 2) alone would wrongly approve this. Neither of those commits is a
    // two-parent merge commit whose own diff matches `compare(p1...p2)`, so the
    // workflow can never prove they introduce nothing beyond a clean merge; it
    // reports nonBaseCommitsIntroduceNoExtraContent: false, and that alone must
    // block carry forward regardless of how the final diffs compare.
    const reviewedDiffFiles = [
      file({ filename: 'src/main/index.ts', sha: 'a'.repeat(40) }),
    ];
    const currentDiffFiles = [
      file({ filename: 'src/main/index.ts', sha: 'a'.repeat(40) }),
    ];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles,
        nonBaseCommitsIntroduceNoExtraContent: false,
      }),
    ).toBe(false);
  });

  it('fails closed when nonBaseCommitsIntroduceNoExtraContent is omitted', () => {
    // The caller must positively prove every non-base commit is a clean merge
    // (or that there are none); omitting the flag must never default to
    // "assume clean".
    const reviewedDiffFiles = [file()];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles: reviewedDiffFiles,
      }),
    ).toBe(false);
  });

  it('fails closed when the record SHA is not a strict ancestor', () => {
    // A rebase or force-push rewrites history: GitHub's compare status is
    // 'diverged' or 'behind' rather than 'ahead', so ancestry condition (1)
    // fails regardless of whether the diffs happen to match.
    const reviewedDiffFiles = [file()];
    for (const status of ['diverged', 'behind', 'identical', undefined]) {
      expect(
        isCarriedAcrossSync({
          recordAncestryStatus: status,
          reviewedDiffFiles,
          currentDiffFiles: reviewedDiffFiles,
          nonBaseCommitsIntroduceNoExtraContent: true,
        }),
      ).toBe(false);
    }
  });

  it('fails closed on an empty reviewed diff', () => {
    // The caller must always supply the PR's actual recorded diff; an empty
    // list never means "safe by default".
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles: [],
        currentDiffFiles: [],
        nonBaseCommitsIntroduceNoExtraContent: true,
      }),
    ).toBe(false);
  });

  it('fails closed when either diff may be truncated', () => {
    // GitHub's compare endpoint silently caps `files` with no in-band
    // truncation signal, so a diff at or beyond that cap can never be proven
    // unchanged — equality would be unprovable, not merely unproven.
    const reviewedDiffFiles = [file()];
    expect(
      isCarriedAcrossSync({
        recordAncestryStatus: 'ahead',
        reviewedDiffFiles,
        currentDiffFiles: reviewedDiffFiles,
        filesMayBeTruncated: true,
        nonBaseCommitsIntroduceNoExtraContent: true,
      }),
    ).toBe(false);
  });

  it('diffFingerprint is order-independent and detects content changes', () => {
    // The workflow reuses this exact function to compare a merge commit's own
    // diff against `compare(parent1...parent2).files`, proving the merge
    // introduced nothing beyond its two parents.
    const a = file({ filename: 'src/main/index.ts' });
    const b = file({ filename: 'src/renderer/App.tsx', sha: 'b'.repeat(40) });
    expect(diffFingerprint([a, b])).toBe(diffFingerprint([b, a]));
    expect(diffFingerprint([a])).not.toBe(
      diffFingerprint([
        file({
          filename: 'src/main/index.ts',
          patch: '@@ -1 +1 @@\n-old\n+different',
        }),
      ]),
    );
  });

  it('carries the record forward with the carried-status wording', () => {
    const reviewedSha = staleSha;
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE', reviewedSha),
        comment('hicks', 'APPROVE', reviewedSha),
        comment('vasquez', 'APPROVE', reviewedSha),
      ],
      carriedShas: new Set([reviewedSha]),
    });
    expect(result.state).toBe('success');
    expect(result.stale.length).toBe(0);
    expect(result.description).toBe(
      `REVIEWED (self-attested, carried across sync) @ ${headSha.slice(0, 12)} by bishop+hicks+vasquez`,
    );
    expect(result.reason).toMatch(/3 carried forward across a pure base sync/);
    expect([...(result.carried ?? [])].sort()).toEqual([
      'bishop',
      'hicks',
      'vasquez',
    ]);
    expect(
      result.notes.some((note) => note.startsWith('Carried across sync:')),
    ).toBe(true);
  });

  it('a mix of fresh and carried approvals is still reported and still carries', () => {
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE', staleSha),
        comment('hicks', 'APPROVE'), // already at the current head
        comment('vasquez', 'APPROVE'),
      ],
      carriedShas: new Set([staleSha]),
    });
    expect(result.state).toBe('success');
    expect(result.description).toMatch(
      /^REVIEWED \(self-attested, carried across sync\) @/,
    );
    expect(result.carried).toEqual(['bishop']);
  });

  it('any author commit in the sync range still supersedes the record normally', () => {
    // The workflow's diff-equality check failed (the PR's own diff changed
    // since review), so `carriedShas` was never populated. The record must
    // supersede exactly as it does today — regression coverage for the
    // review-then-push-more threat model.
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE', staleSha),
        comment('hicks', 'APPROVE', staleSha),
        comment('vasquez', 'APPROVE', staleSha),
      ],
      carriedShas: new Set(), // nothing proven carry-forward eligible
    });
    expect(result.state).toBe('failure');
    expect(result.stale.length).toBe(3);
    expect(result.description).toMatch(/^BLOCKED @ /);
  });

  it('carriedShas is keyed on the reviewed SHA, not the current head', () => {
    // Carrying record at SHA X forward to head Y must not accidentally validate
    // an unrelated record pinned to some other stale SHA Z.
    const otherStaleSha = 'c'.repeat(40);
    const { current, stale } = collectVerdicts(
      [
        comment('bishop', 'APPROVE', staleSha),
        comment('hicks', 'APPROVE', otherStaleSha),
      ],
      headSha,
      { carriedShas: new Set([staleSha]) },
    );
    expect(current.get('bishop')?.carriedAcrossSync).toBe(true);
    expect(current.has('hicks')).toBe(false);
    expect(stale.length).toBe(1);
    expect(stale[0]?.reviewer).toBe('hicks');
  });
});

describe('reviewer count, eligibility and rejection', () => {
  it('a single approval never satisfies a code change', () => {
    const result = gate({ comments: [comment('bishop', 'APPROVE')] });
    expect(result.state).toBe('failure');
    expect(result.description).toMatch(/have 1\/3, missing hicks\+vasquez/);
  });

  it('a single approval satisfies a documentation-only change', () => {
    const result = gate({
      changedPaths: ['docs/ARCHITECTURE.md', 'README.md'],
      comments: [comment('dallas', 'APPROVE')],
    });
    expect(result.state).toBe('success');
    expect(result.approvals.join()).toBe('dallas');
  });

  it('reviewer may not be the squad member who authored the PR', () => {
    const result = gate({
      changedPaths: docPaths,
      comments: [comment('ripley', 'APPROVE')],
    });
    expect(result.state).toBe('failure');
    expect(result.description).toMatch(/reviewer ripley is the PR author/);
  });

  it('any current-head rejection blocks even with enough approvals', () => {
    const result = gate({
      comments: [
        comment('bishop', 'APPROVE'),
        comment('hicks', 'APPROVE'),
        comment('vasquez', 'REQUEST_CHANGES'),
      ],
    });
    expect(result.state).toBe('failure');
    expect(result.description).toBe(
      `REQUEST_CHANGES @ ${headSha.slice(0, 12)} by vasquez`,
    );
  });

  it('only a reviewer decision emits REQUEST_CHANGES; absent evidence is BLOCKED', () => {
    // verify-squad-verdict.mjs distinguishes these: REQUEST_CHANGES routes back
    // to the author, BLOCKED means no usable evidence exists yet.
    const noVerdict = gate();
    const insufficient = gate({ comments: [comment('bishop', 'APPROVE')] });
    const authorReview = gate({
      changedPaths: docPaths,
      comments: [comment('ripley', 'APPROVE')],
    });
    const staleOnly = gate({
      comments: [comment('bishop', 'APPROVE', staleSha)],
    });
    for (const result of [noVerdict, insufficient, authorReview, staleOnly]) {
      expect(result.description).toMatch(/^BLOCKED @ /);
      expect(result.description).not.toMatch(/^REQUEST_CHANGES/);
    }
  });

  it('an unknown reviewer identity is ignored, not counted', () => {
    const result = gate({
      changedPaths: docPaths,
      comments: [comment('sulaco', 'APPROVE')],
    });
    expect(result.state).toBe('failure');
    expect(
      result.notes.some((note) => note.includes('not a known squad identity')),
    ).toBe(true);
  });

  it('a panel member who authored the PR is substitutable, not a deadlock', () => {
    const result = evaluateGate({
      headSha,
      changedPaths: codePaths,
      comments: [
        comment('hicks', 'APPROVE'),
        comment('vasquez', 'APPROVE'),
        comment('dallas', 'APPROVE'),
      ],
      reviews: [],
      roster,
      authorMembers: new Set(['bishop']),
      authorSource: 'PR body Squad-Author',
      squadLabeled: true,
    });
    // Assert the substitution actually happened rather than only that the gate
    // went green: without squadLabeled this returns success as out-of-scope, so
    // a bare state check would pass while exercising none of this logic.
    expect(result.scope).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.description.startsWith('REVIEWED')).toBe(true);
    expect(result.description).toContain('dallas');
  });

  it('unresolved head SHA fails closed', () => {
    expect(gate({ headSha: 'not-a-sha' }).state).toBe('error');
  });
});

describe('the owner override', () => {
  it('an administrator GitHub approval at the current head satisfies the gate', () => {
    const result = gate({
      reviews: [
        {
          state: 'APPROVED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
        },
      ],
    });
    expect(result.state).toBe('success');
    expect(result.override).toBe('github-review');
  });

  it('needs no comments, files or roster — the fork path', () => {
    // Fork PRs are evaluated with reviews only, so this call shape must work.
    // The fork call site declares scope explicitly, matching the workflow.
    const result = evaluateGate({
      headSha,
      squadLabeled: true,
      reviews: [
        {
          state: 'APPROVED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
        },
      ],
    });
    expect(result.state).toBe('success');
    expect(result.override).toBe('github-review');
    expect(result.description).toMatch(/^APPROVE \(owner\) @ /);

    // ...and a non-admin approval on that same path must not pass.
    const outsider = evaluateGate({
      headSha,
      squadLabeled: true,
      reviews: [
        {
          state: 'APPROVED',
          commitId: headSha,
          login: 'stranger',
          isAdmin: false,
        },
      ],
    });
    expect(outsider.state).toBe('failure');
    expect(outsider.override).not.toBe('github-review');
  });

  it('an administrator GitHub approval at a stale head does not satisfy the gate', () => {
    const result = gate({
      reviews: [
        {
          state: 'APPROVED',
          commitId: staleSha,
          login: 'jpapiez',
          isAdmin: true,
        },
      ],
    });
    expect(result.state).toBe('failure');
  });

  it('a later administrator change request outranks their earlier approval', () => {
    // Same admin, same SHA, approval first. Taking any matching approval would
    // let the superseded one keep satisfying the gate.
    const result = gate({
      reviews: [
        {
          id: 1,
          state: 'APPROVED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T01:00:00Z',
        },
        {
          id: 2,
          state: 'CHANGES_REQUESTED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T02:00:00Z',
        },
      ],
    });
    expect(result.state).toBe('failure');
    expect(result.override).toBe('github-review');
    expect(result.description).toMatch(/^REQUEST_CHANGES @ .* by jpapiez$/);
  });

  it('a later administrator approval clears their earlier change request', () => {
    const result = gate({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T01:00:00Z',
        },
        {
          id: 2,
          state: 'APPROVED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T02:00:00Z',
        },
      ],
    });
    expect(result.state).toBe('success');
    expect(result.description).toMatch(/^APPROVE \(owner\) @ /);
  });

  it('review recency falls back to id when timestamps tie', () => {
    const result = gate({
      reviews: [
        {
          id: 7,
          state: 'APPROVED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T01:00:00Z',
        },
        {
          id: 8,
          state: 'CHANGES_REQUESTED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T01:00:00Z',
        },
      ],
    });
    expect(result.state).toBe('failure');
  });

  it('a COMMENTED review is not decisive and cannot clear a change request', () => {
    // GitHub does not treat COMMENTED as changing approval state; neither do we.
    const result = gate({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T01:00:00Z',
        },
        {
          id: 2,
          state: 'COMMENTED',
          commitId: headSha,
          login: 'jpapiez',
          isAdmin: true,
          submittedAt: '2026-08-08T03:00:00Z',
        },
      ],
    });
    expect(result.state).toBe('failure');
    expect(result.description).toMatch(/^REQUEST_CHANGES @ /);
  });

  it('a change request from a non-administrator does not block the gate', () => {
    const result = gate({
      changedPaths: docPaths,
      comments: [comment('dallas', 'APPROVE')],
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          commitId: headSha,
          login: 'stranger',
          isAdmin: false,
          submittedAt: '2026-08-08T02:00:00Z',
        },
      ],
    });
    expect(result.state).toBe('success');
  });

  it('the owner overrides the panel by naming their own login as reviewer', () => {
    const owner = comment('jpapiez', 'APPROVE', headSha, {
      squadAdminOverride: true,
    });
    const result = gate({ comments: [owner] });
    expect(result.state).toBe('success');
    expect(result.override).toBe('owner-comment');
  });

  it('the owner can also block through the same override path', () => {
    const owner = comment('jpapiez', 'REQUEST_CHANGES', headSha, {
      squadAdminOverride: true,
    });
    const result = gate({ comments: [owner] });
    expect(result.state).toBe('failure');
    expect(result.override).toBe('owner-comment');
    expect(result.description).toMatch(/^REQUEST_CHANGES @ /);
  });
});

describe('documentation-only classification', () => {
  it('honours the policy carve-outs', () => {
    expect(classifyChangeScope(['docs/ARCHITECTURE.md']).docsOnly).toBe(true);
    expect(classifyChangeScope(['README.md']).docsOnly).toBe(true);
    expect(classifyChangeScope([]).docsOnly).toBe(false);
    for (const carveOut of [
      '.github/workflows/ci.yml',
      '.github/copilot-instructions.md',
      '.github/pr-closes/README.md',
      '.github/instructions/a11y.instructions.md',
      '.githooks/pre-push',
      '.squad/agents/ralph/loop.md',
      '.squad/skills/agent-collaboration/SKILL.md',
      '.copilot/skills/reflect/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      'SECURITY.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'docs/security/THREAT_MODEL.md',
      'docs/adr/0001-printer-calibration-source-provenance.md',
      'docs/compliance/anything.md',
      'docs/scene-contract.md',
      'docs/api-contract.md',
      'src/renderer/package.json',
      'src/main/index.ts',
      'docs/screenshot.png',
      'native/model-core/src/lib.rs',
      'tests/squadVerdictGate.test.ts',
    ]) {
      expect(
        classifyChangeScope([carveOut]).docsOnly,
        `${carveOut} must take the full gate`,
      ).toBe(false);
    }
    // "Every path", not "mostly prose".
    expect(
      classifyChangeScope(['docs/ARCHITECTURE.md', 'src/main/index.ts'])
        .docsOnly,
    ).toBe(false);
  });

  it('every exported full-gate path is actually escalated', () => {
    for (const prefix of fullGatePrefixes) {
      expect(classifyChangeScope([`${prefix}notes.md`]).docsOnly, prefix).toBe(
        false,
      );
    }
    for (const name of fullGateFiles) {
      expect(classifyChangeScope([name]).docsOnly, name).toBe(false);
      expect(classifyChangeScope([name.toUpperCase()]).docsOnly, name).toBe(
        false,
      );
    }
    for (const prefix of sensitiveProsePrefixes) {
      expect(classifyChangeScope([`${prefix}notes.md`]).docsOnly, prefix).toBe(
        false,
      );
    }
    for (const name of sensitiveProseFiles) {
      expect(classifyChangeScope([name]).docsOnly, name).toBe(false);
    }
  });

  it('the documented full-gate escalation list matches the code exactly', () => {
    // These drifted apart once in PrintFarmer: the code force-escalated paths
    // the docs never mentioned, so a reader could not tell which changes take
    // the full gate. `.squad/skills/agent-collaboration/SKILL.md` is this
    // repository's single definition of the reviewer-count rule, so that is
    // where the list has to agree.
    const skill = readFileSync(
      path.join(
        repositoryRoot,
        '.squad',
        'skills',
        'agent-collaboration',
        'SKILL.md',
      ),
      'utf8',
    );
    const marker = '**How the gate automates this.**';
    expect(skill).toContain(marker);
    const section = skill.slice(skill.indexOf(marker)).slice(0, 3000);

    for (const prefix of fullGatePrefixes) {
      expect(section, `${prefix}** must be documented`).toContain(
        `\`${prefix}**\``,
      );
    }
    for (const name of fullGateFiles) {
      expect(section, `${name} must be documented`).toMatch(
        new RegExp(name.replaceAll('.', '\\.'), 'i'),
      );
    }
    for (const prefix of sensitiveProsePrefixes) {
      expect(section, `${prefix}** must be documented`).toContain(
        `\`${prefix}**\``,
      );
    }
    for (const name of sensitiveProseFiles) {
      expect(section, `${name} must be documented`).toContain(`\`${name}\``);
    }

    // ...and nothing may be documented that the code does not actually
    // escalate, in either direction.
    for (const [, documented] of section.matchAll(/`(\.[a-z]+\/)\*\*`/g)) {
      expect(
        fullGatePrefixes,
        `${documented} is documented but not escalated`,
      ).toContain(documented);
    }
    for (const [, documented] of section.matchAll(/`(docs\/[a-z]+\/)\*\*`/g)) {
      expect(
        sensitiveProsePrefixes,
        `${documented} is documented but not escalated`,
      ).toContain(documented);
    }
  });
});

describe('resolving the authoring squad member', () => {
  it('prefers an explicit declaration over inference', () => {
    const resolved = resolveAuthorMembers({
      prBody: 'Squad-Author: Vasquez\n\nCloses #1',
      branchName: 'squad/1-ripley-issue',
      linkedIssueLabels: ['squad:ripley'],
      roster,
    });
    expect([...resolved.members]).toEqual(['vasquez']);
    expect(resolved.source).toMatch(/Squad-Author/);
  });

  it('falls back to the linked issue label, then the branch name', () => {
    const fromIssue = resolveAuthorMembers({
      linkedIssueLabels: ['squad:ripley', 'priority:p1'],
      branchName: 'squad/2-dallas-thing',
      roster,
    });
    expect([...fromIssue.members]).toEqual(['ripley']);

    const fromBranch = resolveAuthorMembers({
      branchName: 'squad/2-dallas-thing',
      roster,
    });
    expect([...fromBranch.members]).toEqual(['dallas']);

    const unresolved = resolveAuthorMembers({
      branchName: 'squad/3-x',
      roster,
    });
    expect(unresolved.members.size).toBe(0);
    expect(unresolved.source).toBe('unresolved');
  });
});

describe('scoping the gate to squad pull requests', () => {
  it('auto-scoping refuses forks and unrostered self-declared authors', () => {
    const inRoster = {
      authorMembers: new Set(['bishop']),
      roster,
      isFork: false,
    };
    expect(canAutoScope(inRoster)).toBe(true);

    // A fork PR controls both its body and its branch name, which are exactly
    // the inputs resolveAuthorMembers reads. If forks could auto-scope, an
    // outsider could place their own PR into the gate's scope.
    expect(canAutoScope({ ...inRoster, isFork: true })).toBe(false);

    // resolveAuthorMembers does NOT validate a declared Squad-Author against
    // the roster, so canAutoScope must, or one line of PR body text self-scopes.
    const declared = resolveAuthorMembers({
      prBody: 'Squad-Author: attacker',
      branchName: 'feature/x',
      roster,
    });
    expect([...declared.members]).toEqual(['attacker']);
    expect(
      canAutoScope({ authorMembers: declared.members, roster, isFork: false }),
    ).toBe(false);

    // Every member must be rostered, not merely one of them: a `some` check
    // would let an attacker ride along by naming a real member beside
    // themselves.
    expect(
      canAutoScope({
        authorMembers: new Set(['bishop', 'attacker']),
        roster,
        isFork: false,
      }),
    ).toBe(false);
    expect(
      canAutoScope({
        authorMembers: new Set(['bishop', 'hicks']),
        roster,
        isFork: false,
      }),
    ).toBe(true);

    expect(
      canAutoScope({ authorMembers: new Set(), roster, isFork: false }),
    ).toBe(false);
    expect(canAutoScope({})).toBe(false);
  });

  it('the gate is scoped to squad-labelled pull requests', () => {
    // Scope marker recognition.
    expect(hasSquadScopeLabel([{ name: 'squad' }])).toBe(true);
    expect(hasSquadScopeLabel(['squad'])).toBe(true);
    expect(hasSquadScopeLabel([{ name: ' Squad ' }])).toBe(true);
    expect(hasSquadScopeLabel([])).toBe(false);
    expect(hasSquadScopeLabel([{ name: 'squadron' }])).toBe(false);
    // A member-assignment label names who is responsible, not that the PR is in
    // scope; counting it would drag routine triage back into the gate.
    expect(hasSquadScopeLabel([{ name: 'squad:bishop' }])).toBe(false);
    expect(hasSquadScopeLabel([null, undefined, {}])).toBe(false);

    // An unlabelled PR is out of scope and says so, rather than emitting a
    // BLOCKED that nobody can clear without staging a fake agent review.
    const out = gate({ squadLabeled: false });
    expect(out.state).toBe('success');
    expect(out.scope).toBe('out-of-scope');
    expect(out.description).toMatch(
      /^NOT_APPLICABLE @ [0-9a-f]{12}: not a squad PR \(no 'squad' label\)$/,
    );
    expect(out.approvals.length).toBe(0);

    // Scope is evaluated before everything else: a full panel of records on an
    // unlabelled PR still reports out of scope rather than REVIEWED, so an
    // out-of-scope PR can never accumulate merge evidence.
    const withRecords = gate({
      squadLabeled: false,
      comments: [
        comment('bishop', 'APPROVE'),
        comment('hicks', 'APPROVE'),
        comment('vasquez', 'APPROVE'),
      ],
    });
    expect(withRecords.scope).toBe('out-of-scope');
    expect(withRecords.description).not.toMatch(/REVIEWED/);

    // Callers that forget the flag must fail safe to out-of-scope, never to an
    // empty-panel evaluation that could look like a pass.
    const omitted = evaluateGate({
      headSha,
      changedPaths: codePaths,
      roster,
    });
    expect(omitted.scope).toBe('out-of-scope');

    // Labelled PRs still take the full gate.
    const inScope = gate({ squadLabeled: true });
    expect(inScope.scope).toBeUndefined();
    expect(inScope.description).toMatch(
      /^BLOCKED @ [0-9a-f]{12}: no review recorded/,
    );
  });
});

describe('the workflow wiring the gate depends on', () => {
  it('keeps its default-branch, SHA-binding and least-privilege controls', () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/^\s+statuses: write$/m);
    // pull-requests: write is intentional — this workflow applies the scope
    // label itself. It is the ONLY write scope beyond statuses, and it does not
    // let a PR influence the judgement: the gate logic is always read from the
    // default branch. contents: write would, so it stays out.
    expect(workflow).toMatch(/^\s+pull-requests: write$/m);
    expect(workflow).not.toMatch(/contents: write/);
    expect(workflow).not.toMatch(/(?:actions|checks|packages|id-token): write/);
    // A pull_request (head-ref) trigger would let a PR rewrite its own gate.
    expect(workflow).not.toMatch(/^ {2}pull_request:$/m);
    expect(workflow).toMatch(/^ {2}pull_request_target:$/m);
    expect(workflow).toMatch(
      /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
    );
    expect(workflow).toMatch(/persist-credentials: false/);
    expect(workflow).toMatch(/squad-verdict-gate\.mjs/);
    expect(workflow).toMatch(/getCollaboratorPermissionLevel/);
    // #744: no `permissions:` grant fixes trust here — the live permission
    // lookup already succeeds without any extra scope, and #744's actual
    // defect was the (now-removed) `author_association` allow-list gating
    // trust in `parseVerdictComment`. The debug logging used to prove that,
    // in commits leading up to this fix, must never reappear in the shipped
    // workflow.
    expect(workflow).not.toMatch(/#744 debug/);
    expect(workflow).toMatch(
      /gate\.hasWriteAccess\(await permissionOf\(login\)\)/,
    );
    expect(workflow).toMatch(
      /gate\.hasAdminAccess\(await permissionOf\(login\)\)/,
    );
    expect(workflow).toMatch(/squadWriteAccess: await canWrite\(login\)/);
    // Fork PRs must never accept an agent record, but an administrator's native
    // approval is still evaluated in code rather than deferred to prose.
    expect(workflow).toMatch(/fork PR needs a repository administrator/);
    expect(workflow).toMatch(/if \(forkResult\.override === 'github-review'\)/);
    expect(workflow).toMatch(/types: \[created, edited, deleted\]/);
    expect(workflow).toMatch(
      /run-name: ['"]Squad review record for PR #\$\{\{ github\.event\.pull_request\.number/,
    );
    // The gate must not present itself as independent review or four-eyes.
    expect(workflow).toMatch(/THIS IS NOT INDEPENDENT REVIEW/);
    expect(workflow).toMatch(/NO SEPARATION OF DUTIES/);
    expect(workflow).toMatch(/QUALITY\s*#?\s*HEURISTIC/i);
    // ...and it must not present itself as a merge requirement either: #206
    // struck a verdict-shaped required check, and this design does not reopen it.
    expect(workflow).toMatch(/NOT A REQUIRED CHECK, DELIBERATELY/);
    expect(workflow).toMatch(/ripley-206-review-verdicts-cannot-bind\.md/);
    // ...including in the job summary, which is the surface a human scans first.
    expect(workflow).toMatch(
      /addHeading\('Squad review record \(self-attested\)'\)/,
    );
    expect(workflow).toMatch(/Self-attested review records/);
    expect(workflow).not.toMatch(/'Approvals'/);
    expect(workflow).not.toMatch(/Stale verdicts/);
    expect(workflow).not.toMatch(/Squad pre-PR verdict gate/);
    expect(workflow).not.toMatch(/\? 'PASS'/);
  });

  it('keeps the sync carry-forward wiring intact', () => {
    // Regression coverage for the merge-commit bug PrintFarmer's rewrite fixed:
    // the workflow must compute the ancestry check AND the diff-equality check
    // against the base ref — not the old commit-SET-membership shape passed
    // directly into the gate — and must thread the resulting `carriedShas` into
    // `gate.evaluateGate`. A silent revert back to the commit-list design would
    // reintroduce a feature that never actually fires for a real `git merge`
    // sync. It must also still verify every non-base commit introduces nothing
    // beyond a clean merge of its own two parents.
    const workflow = readWorkflow();

    // Ancestry compare (condition 1) still targets old-sha...head.
    expect(workflow).toMatch(/basehead: `\$\{oldSha\}\.\.\.\$\{headSha\}`/);
    // Diff-equality compares (condition 2) target the base ref on BOTH sides —
    // not old-sha...head or base...head alone, which is the exact shape that let
    // a sync merge commit sit in both "new" and "ahead of base" sets.
    expect(workflow).toMatch(/basehead: `\$\{baseRef\}\.\.\.\$\{oldSha\}`/);
    expect(workflow).toMatch(/basehead: `\$\{baseRef\}\.\.\.\$\{headSha\}`/);

    // The gate call receives file lists, not raw commit-SHA sets, plus the
    // ancestry status, a files-truncation guard, and the clean-merge proof for
    // non-base commits (condition 3).
    expect(workflow).toMatch(/reviewedDiffFiles:\s*reviewedFiles/);
    expect(workflow).toMatch(/currentDiffFiles:\s*currentFiles/);
    expect(workflow).toMatch(/recordAncestryStatus:\s*ancestryCompare\.status/);
    expect(workflow).toMatch(/filesMayBeTruncated:/);
    expect(workflow).toMatch(/compareFilesCap/);
    expect(workflow).toMatch(/nonBaseCommitsIntroduceNoExtraContent/);

    // Condition 3's own per-commit check: for each non-base commit, the
    // workflow must fetch its parents, require EXACTLY two, and compare the
    // commit's own diff against `compare(parent1...parent2)` — NOT check for an
    // empty own-diff, which is a verified-wrong assumption for a clean merge.
    expect(workflow).toMatch(/getCommit\(/);
    expect(workflow).toMatch(/parentShas\.length !== 2/);
    expect(workflow).toMatch(
      /basehead: `\$\{parentShas\[0\]\}\.\.\.\$\{parentShas\[1\]\}`/,
    );
    expect(workflow).toMatch(/gate\.diffFingerprint\(singleCommitFiles\)/);
    expect(workflow).toMatch(/gate\.diffFingerprint\(parentsCompareFiles\)/);
    expect(workflow).not.toMatch(
      /singleCommit\.files\s*\?\?\s*\[\]\)\.length\s*>\s*0/,
    );
    // The per-commit equality check has its own truncation exposure, guarded by
    // two independent signals: either firing disqualifies.
    expect(workflow).toMatch(/singleCommitFiles\.length >= compareFilesCap/);
    expect(workflow).toMatch(/singleCommit\.stats\?\.total/);
    expect(workflow).toMatch(
      /singleCommitFilesSum !== singleCommit\.stats\.total/,
    );
    expect(workflow).toMatch(/singleCommitFilesTruncated/);
    expect(workflow).toMatch(/parentsCompareFiles\.length >= compareFilesCap/);

    // The bulk commit lists that feed condition 3 must be checked for
    // truncation too.
    expect(workflow).toMatch(/commitsIncomplete/);
    expect(workflow).toMatch(/total_commits/);

    // The old shape (raw commit-SHA sets passed directly as the gate's own
    // condition-2 inputs) must be gone entirely.
    expect(workflow).not.toMatch(/newCommitShas/);

    // Eligibility still fails closed and still threads into evaluateGate.
    expect(workflow).toMatch(/carriedShas\.add\(oldSha\)/);
    expect(workflow).toMatch(/carriedShas,\s*\n/);
    expect(workflow).toMatch(/Treating the record as superseded\./);
  });

  it('keeps the scoping wiring intact', () => {
    const workflow = readWorkflow();
    // Scope is checked before the fork branch, and both real call sites declare
    // their scope explicitly rather than relying on the default.
    expect(workflow).toMatch(
      /gate\.hasSquadScopeLabel\(pull\.labels \?\? \[\]\)/,
    );
    expect(workflow).toMatch(/squadLabeled: false/);
    expect(workflow).toMatch(/squadLabeled: true/);
    // The label changes scope, so the status must re-evaluate when it moves.
    expect(workflow).toMatch(/- labeled/);
    expect(workflow).toMatch(/- unlabeled/);

    // Labelling lives in THIS workflow, guarded by canAutoScope, and needs
    // write access to do it. A separate labelling workflow is not a valid
    // refactor: the default GITHUB_TOKEN does not start new workflow runs, so
    // its `labeled` event would never re-trigger the evaluation that depends on
    // it, and the two workflows would race on `opened`.
    expect(workflow).toMatch(/gate\.canAutoScope\(/);
    expect(workflow).toMatch(/issues\.addLabels/);
    expect(workflow).toMatch(/pull-requests: write/);
    expect(workflow).toMatch(/isFork/);
  });
});

// Labelling must not migrate back out into a dedicated workflow. The primary
// guard keys on CAPABILITY, not on call sites: a workflow cannot write a label
// using GITHUB_TOKEN by ANY mechanism — issues.addLabels, issues.update, GraphQL
// addLabelsToLabelable, `gh pr edit --add-label`, actions/labeler, raw REST —
// without granting GITHUB_TOKEN `issues: write` or `pull-requests: write` (or
// `write-all`). GitHub enforces that at the token level; scanning for call sites
// cannot, because the transports are open-ended and the label value can be
// indirected through a variable.
//
// PrintFarmer's version of this test parses each workflow with js-yaml, having
// been defeated three rounds running by valid YAML a regex did not anticipate
// (flow mappings, quoted inner keys, a quoted OUTER key). This repository ships
// no YAML parser by policy — see the header of
// `scripts/check-merge-queue-contexts.mjs`, which makes the same textual choice
// for the same reason — so the shapes are handled by the small structured
// reader below rather than by a pattern match against raw text, and the
// `permissionShapes` test below is its control: it asserts the reader returns
// the SAME structure for every one of those surface forms, including the ones
// that defeated the regex, and returns nothing for the forms that grant nothing.
// If you are tempted to replace this with a regex over raw text, read that
// control first.

/** Parse a flow mapping (`{ issues: write }`) or a scalar (`write-all`). */
function parseInlinePermissions(text: string): unknown {
  if (!text.startsWith('{')) return text;
  const inner = text.replace(/^\{/, '').replace(/\}$/, '').trim();
  const map: Record<string, string> = {};
  if (inner === '') return map;
  for (const pair of inner.split(',')) {
    const entry =
      /^\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^,]+?))\s*$/.exec(
        pair,
      );
    const key = entry?.[1] ?? entry?.[2] ?? entry?.[3];
    const value = entry?.[4] ?? entry?.[5] ?? entry?.[6];
    if (key !== undefined && value !== undefined) {
      map[key] = value;
    }
  }
  return map;
}

/**
 * Every `permissions:` mapping a workflow declares, at any level — the
 * top-level one plus each job's own. A grant at either level is a capability.
 *
 * Deliberately over-matches: it accepts a `permissions:` key at any
 * indentation, so a stray one inside a `run:` block would be counted too. That
 * direction fails toward MORE review, which is the correct side to be wrong on.
 */
function permissionBlocks(contents: string): unknown[] {
  const lines = contents.split(/\r?\n/);
  const blocks: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header =
      /^(\s*)(?:permissions|'permissions'|"permissions"):(.*)$/.exec(
        lines[index] ?? '',
      );
    if (!header) continue;
    const indent = (header[1] ?? '').length;
    const inline = (header[2] ?? '').trim();
    if (inline !== '' && !inline.startsWith('#')) {
      blocks.push(parseInlinePermissions(inline));
      continue;
    }
    const map: Record<string, string> = {};
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      if (line.length - line.trimStart().length <= indent) break;
      const entry =
        /^\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/.exec(
          line,
        );
      const key = entry?.[1] ?? entry?.[2] ?? entry?.[3];
      const value = entry?.[4] ?? entry?.[5] ?? entry?.[6];
      if (key !== undefined && value !== undefined) {
        map[key] = value;
      }
    }
    blocks.push(map);
  }
  return blocks;
}

/**
 * A single permissions value grants label write if it is the `write-all`
 * scalar shorthand, or a mapping granting `issues: write` or
 * `pull-requests: write`. `permissions: {}` parses to an empty object and
 * grants nothing; `read-all`, `read`, `none`, and an absent block likewise.
 */
function blockGrantsLabelWrite(permissions: unknown): boolean {
  if (permissions === 'write-all') return true;
  if (typeof permissions !== 'object' || permissions === null) return false;
  const map = permissions as Record<string, unknown>;
  return map.issues === 'write' || map['pull-requests'] === 'write';
}

describe('label-write capability across every workflow', () => {
  const workflowDir = path.join(repositoryRoot, '.github', 'workflows');
  const names = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  const bodies = new Map(
    names.map((name) => [
      name,
      readFileSync(path.join(workflowDir, name), 'utf8'),
    ]),
  );
  const grantsLabelWrite = (name: string) =>
    permissionBlocks(bodies.get(name) as string).some(blockGrantsLabelWrite);
  const capable = names.filter(grantsLabelWrite);

  it('permissionShapes: the reader survives every surface form of the same grant', () => {
    // The control this whole approach rests on. Each of these parses to the
    // same structure in real YAML, and the first three are the exact forms that
    // defeated PrintFarmer's successive regexes.
    const granting = [
      'permissions:\n  issues: write\n',
      'permissions: { issues: write }\n',
      'permissions:\n  \'issues\': "write"\n',
      '"permissions": {"issues": "write"}\n',
      'permissions: write-all\n',
      'permissions:\n  pull-requests: write\n',
      'jobs:\n  build:\n    permissions:\n      issues: write\n',
    ];
    for (const source of granting) {
      expect(permissionBlocks(source).some(blockGrantsLabelWrite), source).toBe(
        true,
      );
    }
    // The opposite result on the same reader and the same shapes: nothing here
    // grants label write, so a reader that answered `true` for everything would
    // fail here rather than silently passing above.
    const nonGranting = [
      'permissions:\n  contents: read\n',
      'permissions: {}\n',
      'permissions: read-all\n',
      'permissions:\n  issues: read\n',
      'permissions:\n  pull-requests: read\n',
      '"permissions": {"contents": "read"}\n',
      'name: something\non:\n  push:\n',
    ];
    for (const source of nonGranting) {
      expect(permissionBlocks(source).some(blockGrantsLabelWrite), source).toBe(
        false,
      );
    }
  });

  it('only allowlisted workflows can write labels with GITHUB_TOKEN', () => {
    // Adding an entry is a deliberate act: any of these could apply the bare
    // scope label and silently place a PR in scope, which is what the review
    // gate exists to prevent.
    //
    // KNOWN, ACCEPTED RESIDUAL: the `permissions:` block constrains only
    // GITHUB_TOKEN. A workflow holding just `contents: write` that runs `gh pr
    // edit --add-label squad` authenticated with a `secrets.*` PAT bypasses this
    // entirely, because that token's scopes are not visible in the workflow
    // file. This is defence-in-depth against a future refactor reintroducing a
    // standalone labeller; it is NOT the enforced safety property. That is
    // `canAutoScope`, which refuses forks and unrostered authors and is tested
    // directly above.
    const permittedLabelWriters = new Set([
      'lift-sequencing-hold.yml',
      'npm-cleanup-recovery.yml',
      'publish-npm-cleanup-evidence.yml',
      'squad-heartbeat.yml',
      'squad-issue-assign.yml',
      'squad-label-enforce.yml',
      'squad-review-verdict.yml',
      'squad-triage.yml',
      'sync-squad-labels.yml',
    ]);

    expect(
      capable.filter((name) => !permittedLabelWriters.has(name)),
      'a workflow not on the allowlist grants itself issues/pull-requests write ' +
        'and could therefore apply the bare squad scope label; if legitimate ' +
        'add it above, but first confirm it cannot place a PR in scope',
    ).toEqual([]);
    // Fail closed the other way too: a stale entry reserves a name and silently
    // widens the set a reintroduced labeller could occupy.
    expect(
      [...permittedLabelWriters].filter((name) => !capable.includes(name)),
      'the allowlist names a workflow that no longer holds label-write ' +
        'capability; prune it',
    ).toEqual([]);
  });

  it('no workflow silently inherits the repository default permissions', () => {
    // A workflow omitting `permissions:` inherits the repository default, which
    // this test cannot read — so flipping `default_workflow_permissions` from
    // restricted to permissive would make every blockless workflow
    // label-capable without changing any file here. Every workflow in this
    // repository currently declares one, so pin that: a new file gaining or
    // losing its block is what this catches.
    const inheritsDefault = names.filter(
      (name) => permissionBlocks(bodies.get(name) as string).length === 0,
    );
    expect(
      inheritsDefault,
      'a workflow has no explicit permissions block; one without a block ' +
        'inherits the repository default and is label-capable if that default ' +
        'is permissive',
    ).toEqual([]);
  });

  it('scope labelling stays inside the verdict workflow', () => {
    // Secondary guard: a permitted writer must not start applying the BARE
    // scope label. Those workflows apply `squad:*`, never `squad`. Covers the
    // literal forms plus assignment to a variable, which is how an indirected
    // CLI call reads it. The last pattern is intentionally broad and will also
    // flag an innocuous `name: squad` line — that fails toward MORE review, and
    // it is the only form that still catches a label indirected through a
    // variable such as `SCOPE_LABEL: squad`.
    const bareScopeLabel = [
      /squadScopeLabel|canAutoScope/,
      /labels:\s*\[[^\]]*(['"])squad\1/,
      /--add-label[=\s]+['"]?squad['"]?(?![\w:-])/,
      /^\s*[A-Za-z_][\w-]*:\s*(['"])?squad\1?\s*$/m,
    ];
    const strays = capable.filter(
      (name) =>
        name !== 'squad-review-verdict.yml' &&
        bareScopeLabel.some((pattern) =>
          pattern.test(bodies.get(name) as string),
        ),
    );
    expect(
      strays,
      `squad scope labelling must stay in squad-review-verdict.yml; found: ${strays.join(', ')}`,
    ).toEqual([]);
    // Control: the same patterns DO fire on the workflow that legitimately
    // labels, so an empty result above cannot be an artefact of patterns that
    // match nothing at all.
    expect(
      bareScopeLabel.some((pattern) =>
        pattern.test(bodies.get('squad-review-verdict.yml') as string),
      ),
    ).toBe(true);
  });
});
