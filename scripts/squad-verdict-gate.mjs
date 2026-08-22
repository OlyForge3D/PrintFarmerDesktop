// Pure evaluation logic for the squad pre-PR review record.
//
// ⚠️ THIS IS NOT INDEPENDENT REVIEW AND PROVIDES NO SEPARATION OF DUTIES.
// Every squad agent runs under the repository owner's authority and posts
// through the owner's token, so a reviewer agent "approving" an author agent is
// the owner approving the owner's own work. The reviewer-is-not-the-author rule
// implemented below is a QUALITY HEURISTIC — a second agent with fresh context
// catches more than the author re-reading its own output — and is deliberately
// NOT presented as an independence or four-eyes control. This repository has
// exactly one collaborator (`jpapiez`, admin), who authors effectively every
// agent PR; issue #206 measured that population directly.
//
// What the record genuinely provides: SHA binding (a record is valid only for
// the exact commit it names), presence (the gate fails when nothing reviewed the
// change at all), an audit trail, and legible failure reasons.
//
// The workflow (.github/workflows/squad-review-verdict.yml) collects live data
// from the GitHub API and delegates every decision to this module so the rules
// are unit-testable. Nothing here performs I/O.
//
// Ported from OlyForge3D/PrintFarmer's scripts/ci/squad-verdict-gate.mjs (PR
// #1316, fixing PrintFarmer issue #1310) for this repository's issue #740. The
// defect being fixed is identical in both repositories: the previous gate was
// `workflow_dispatch`-only and required a non-author repository administrator,
// which a single-collaborator repository can never supply, so it never fired.
//
// Canonical record comment format (see the workflow header for the full spec):
//
//   <!-- squad-verdict -->
//   Squad-Reviewer: bishop
//   Squad-Verdict: APPROVE
//   Squad-Head-SHA: 0123456789abcdef0123456789abcdef01234567

import { isDocumentationPath } from './docs-only-change.mjs';

export const verdictContext = 'squad/pre-pr-verdict';

/**
 * Squad members that form the standard review panel. Three agents reviewing
 * instead of one is a quality measure, not three independent parties.
 */
export const reviewPanel = ['bishop', 'hicks', 'vasquez'];

/**
 * Label that marks a pull request as squad-authored and therefore in scope.
 *
 * SCOPING RULE: the gate applies to squad-authored PRs only. Dependency-bot
 * bumps and ad-hoc human PRs are not agent output, so demanding a three-agent
 * adversarial panel on them would produce noise and nothing else.
 *
 * WHY AN OPT-IN LABEL IS SAFE HERE, when opt-in scoping normally is not: the
 * absence of this label removes the gate AND Ralph's merge autonomy together.
 * `.squad/agents/ralph/loop.md` §9 refuses an unattended merge on a PR whose
 * `squad/pre-pr-verdict` status reports NOT_APPLICABLE — a human merges it
 * deliberately instead. So the fail-open direction that would otherwise make
 * opt-in scoping dangerous — "forget the label, unreviewed agent code
 * auto-lands" — does not exist. Forgetting the label degrades to "a human has
 * to merge this by hand", which is strictly more conservative, not less.
 *
 * Two further properties keep it honest:
 *   * Scope is not outsider-influenceable. Applying a label by hand needs write
 *     access, and the automatic path (see `canAutoScope`) refuses to label a
 *     fork and requires the resolved author to be a real roster member — so
 *     neither the PR body nor the branch name, both attacker-controlled on a
 *     fork, can move a PR into scope.
 *   * The verdict workflow applies the label itself, in the same run that
 *     evaluates the gate, so the common path does not depend on an agent
 *     remembering and cannot race a separate labelling workflow.
 */
export const squadScopeLabel = 'squad';

/**
 * True when the pull request's labels put it in scope for the review gate.
 *
 * Matching is exact on the bare `squad` label. A `squad:{member}` assignment
 * label deliberately does NOT count: those name a responsible member and are
 * routinely applied to issues and PRs for triage (`.squad/routing.md` rule 7),
 * so treating them as scope markers would drag unrelated work back into the
 * gate.
 */
export function hasSquadScopeLabel(labels = []) {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (
      typeof name === 'string' &&
      name.trim().toLowerCase() === squadScopeLabel
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when a pull request may have the scope label applied automatically.
 *
 * The verdict workflow applies the label itself rather than delegating to a
 * separate labelling workflow. Two guards matter, and both close real holes:
 *
 *   * NEVER auto-label a fork. `resolveAuthorMembers` reads the PR body and the
 *     head branch name, BOTH of which a fork PR author fully controls, so an
 *     outsider could otherwise place their own PR into scope. Fork PRs are
 *     already handled conservatively once in scope (they need an administrator),
 *     but scope must not be outsider-influenceable at all — that property is
 *     what justifies opt-in scoping in the first place.
 *
 *   * Require every resolved member to be a real roster member. A declared
 *     `Squad-Author:` line is NOT validated against the roster by
 *     `resolveAuthorMembers` (by design — the gate only uses it to stop an agent
 *     reviewing its own work), so without this check one arbitrary line of PR
 *     body text would be enough to self-scope.
 *
 * A maintainer can still label anything by hand; that requires write access, so
 * it stays inside the trust boundary.
 */
export function canAutoScope({ authorMembers, roster, isFork } = {}) {
  if (isFork) return false;
  const members = [...(authorMembers ?? [])];
  if (members.length === 0) return false;
  const known = roster ?? new Set();
  return members.every((member) => known.has(member));
}

/**
 * Repository permission levels that may record a review.
 *
 * The authoritative author-authentication check. Ralph merges autonomously
 * using the OWNER's write access (`.squad/agents/ralph/loop.md` §1 lists PR
 * merges among its allowed writes), so a forgeable record would effectively
 * lend the owner's privileges to whoever forged it — an unauthenticated path
 * from a stranger to `development`. Everything below write is rejected,
 * including `read` (which is what a non-collaborator returns on a public
 * repository) and `triage`.
 *
 * FAILS CLOSED by construction: an unresolved lookup, a rate-limited call, an
 * unexpected shape, `undefined`, or any unrecognised string all return false.
 *
 * No bot identity is allowlisted. Allowlisting one would re-create the
 * bot-hop laundering pattern this repository's issue #206 already declined: a
 * workflow dispatched by the owner posting as `github-actions[bot]` adds no
 * judgement, it only makes the metadata imply someone else reviewed.
 */
export function hasWriteAccess(permission) {
  return (
    permission === 'admin' ||
    permission === 'maintain' ||
    permission === 'write' ||
    permission === 'push'
  );
}

/** Repository permission level required for the owner-override path. */
export function hasAdminAccess(permission) {
  return permission === 'admin';
}

/**
 * Sentinel that must appear in a verdict comment. Requiring it stops prose that
 * merely *illustrates* the format — a reviewer explaining the protocol, a doc
 * excerpt — from being read as a binding verdict.
 */
export const verdictMarker = '<!-- squad-verdict -->';

const fencedBlock =
  /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm;
// An opening fence with no closing fence is fenced through end of body, which
// is how GitHub renders it. Without this, an unterminated fence displays as
// code but parses as live text.
const unterminatedFence = /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*$/m;
const quotedLine = /^[ \t]*>.*$/gm;
// Any HTML comment other than the marker. Fields hidden inside one render as
// nothing on GitHub, so counting them would break the audit-trail property:
// a human reading the thread could not see the evidence the gate used.
const htmlComment = /<!--[\s\S]*?(?:-->|$)/g;

const verdictAliases = new Map([
  ['APPROVE', 'APPROVE'],
  ['APPROVED', 'APPROVE'],
  ['REQUEST_CHANGES', 'REQUEST_CHANGES'],
  ['CHANGES_REQUESTED', 'REQUEST_CHANGES'],
  ['REJECT', 'REQUEST_CHANGES'],
]);

const reviewerLine = /^[ \t]*Squad-Reviewer:[ \t]*(.+?)[ \t]*$/gim;
const verdictLine = /^[ \t]*Squad-Verdict:[ \t]*([A-Za-z_]+)[ \t]*$/gim;
const headShaLine = /^[ \t]*Squad-Head-SHA:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gim;

/**
 * Trees that always take the full gate even when every changed path is prose.
 *
 * This is the executable half of carve-outs 1 and 3 in
 * `.squad/skills/agent-collaboration/SKILL.md` § "Carve-outs that keep the full
 * gate even when only markdown changed". Those trees hold agent instructions,
 * review policy, merge-safety rules and CI definitions: whether a given edit
 * moves an agent's safety boundary cannot be judged from the path, so the
 * conservative reading of the carve-out is applied to the whole tree.
 * `.github/**` is covered in full — it is process configuration, not product
 * documentation, and it contains the merge-evidence rules the unattended merger
 * itself obeys.
 *
 * `.claude/` and `.cursor/` do not exist in this repository yet and are listed
 * for the same reason `scripts/docs-only-change.mjs` handles Rust tool configs
 * that do not exist either: the cost of the predicate being wrong is paid on the
 * commit that ADDS the tree, which is exactly the commit nobody has reviewed.
 *
 * Exported so a test can assert the docs enumerate exactly this list. In
 * PrintFarmer the two drifted apart once, which is how an agent-instruction file
 * could have taken the one-reviewer path without anyone noticing.
 */
export const fullGatePrefixes = [
  '.github/',
  '.githooks/',
  '.squad/',
  '.copilot/',
  '.claude/',
  '.cursor/',
];

// Root-level agent-instruction files, which are agent behaviour by content even
// though nothing in their path says so. None exists in this repository today;
// see the note on `fullGatePrefixes` for why they are handled in advance.
export const fullGateFiles = new Set([
  'agents.md',
  'claude.md',
  'gemini.md',
  'copilot.md',
  '.cursorrules',
]);

/**
 * Prose trees whose contents carry real consequences — carve-out 2 of
 * `.squad/skills/agent-collaboration/SKILL.md`: security policy, threat models,
 * architecture decisions, compliance and provenance records.
 *
 * Exported alongside `fullGateFiles`/`fullGatePrefixes` so the same
 * documentation-agreement test covers all three lists.
 */
export const sensitiveProsePrefixes = [
  'docs/security/',
  'docs/adr/',
  'docs/compliance/',
];

/**
 * Individually named published-contract and licensing documents — the rest of
 * carve-out 2. `LICENSE`, `SECURITY.md` and `docs/api-contract.md`-shaped paths
 * are matched by the pattern below instead, so only the names that pattern
 * cannot express are listed here.
 */
export const sensitiveProseFiles = new Set([
  'THIRD_PARTY_NOTICES.md',
  'docs/scene-contract.md',
]);

/**
 * Extensions a single reviewer can actually read as prose.
 *
 * `isDocumentationPath` admits ANYTHING under `docs/**` — including a `.png`
 * screenshot or another binary asset — and that is the right answer for the
 * question it exists to answer (may CI stand down the steps a prose edit cannot
 * affect). It is the wrong answer for reviewer count: the one-reviewer
 * exemption is justified by "one person read the prose", and a binary is not
 * prose. So the gate intersects that classifier with this list rather than
 * replacing it, which is strictly narrower and therefore fails toward the full
 * panel. Documented as carve-out 4 in
 * `.squad/skills/agent-collaboration/SKILL.md`.
 */
export const proseExtensions = ['.md', '.markdown', '.rst', '.adoc', '.txt'];

// Prose whose *name* marks it as security, licensing, or contract material,
// wherever it sits. Catches `LICENSE`, `SECURITY.md`, `NOTICE`, `COPYING`,
// `CODE_OF_CONDUCT.md` and `docs/api-contract.md` without enumerating them.
const sensitiveProse =
  /(^|\/)(security|threat[-_ ]?model|licen[cs]e|notice|copying|code[-_ ]?of[-_ ]?conduct|api[-_ ]?contract)(\.[a-z0-9]+)?$/i;

/**
 * Reduce a squad identity to its canonical lowercase token.
 * "squad:🔍 Bishop" and "Bishop" both normalize to "bishop".
 */
export function normalizeMember(raw) {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const stripped = raw
    .replace(/^squad:/i, '')
    .replace(/[^A-Za-z0-9 _.-]+/gu, ' ')
    .trim()
    .toLowerCase();
  const token = stripped
    .split(/[\s_.]+/)
    .filter(Boolean)
    .pop();
  return /^[a-z][a-z0-9-]{1,31}$/.test(token ?? '') ? token : undefined;
}

/** Build the roster of valid squad identities from repository label names. */
export function rosterFromLabels(labelNames) {
  const roster = new Set();
  for (const name of labelNames ?? []) {
    if (typeof name === 'string' && /^squad:/i.test(name)) {
      const member = normalizeMember(name);
      if (member) {
        roster.add(member);
      }
    }
  }
  return roster;
}

/**
 * Remove anything GitHub renders as code or as a quotation of someone else's
 * text. A verbatim quote-reply of a record, or an example inside a fence, must
 * not register as a fresh record.
 */
function stripQuotedAndFenced(body) {
  return body
    .replace(fencedBlock, '')
    .replace(unterminatedFence, '')
    .replace(quotedLine, '');
}

/**
 * Everything the gate is willing to read: visible text only, with hidden HTML
 * comments removed so the parsed evidence matches what a human sees.
 */
function sanitizeBody(body) {
  return stripQuotedAndFenced(body).replace(htmlComment, '');
}

function countMatches(pattern, body) {
  pattern.lastIndex = 0;
  const values = [];
  let match = pattern.exec(body);
  while (match) {
    values.push(match[1].trim());
    match = pattern.exec(body);
  }
  // More than one occurrence of a field is ambiguous regardless of whether the
  // values agree, so it is not evidence.
  return values.length === 1 ? values[0] : undefined;
}

function singleMatch(pattern, body) {
  return countMatches(pattern, sanitizeBody(body));
}

/**
 * Parse one PR comment into a review record, or undefined when the comment is
 * not a well-formed record from a trusted account.
 */
export function parseVerdictComment(comment) {
  const body = typeof comment?.body === 'string' ? comment.body : '';
  const visible = stripQuotedAndFenced(body);
  if (visible.split(verdictMarker).length !== 2) {
    return undefined;
  }
  // Drop the marker itself, then every remaining HTML comment, so fields cannot
  // be smuggled in text that renders as nothing.
  const clean = visible
    .split(verdictMarker)
    .join('\n')
    .replace(htmlComment, '');
  const reviewerRaw = countMatches(reviewerLine, clean);
  const verdictRaw = countMatches(verdictLine, clean);
  const headShaRaw = countMatches(headShaLine, clean);
  if (!reviewerRaw || !verdictRaw || !headShaRaw) {
    return undefined;
  }
  const verdict = verdictAliases.get(verdictRaw.toUpperCase());
  const reviewer = normalizeMember(reviewerRaw);
  if (!verdict || !reviewer) {
    return undefined;
  }
  return {
    reviewer,
    verdict,
    headSha: headShaRaw.toLowerCase(),
    commenter: comment.user?.login ?? '',
    association: comment.author_association ?? '',
    // `author_association` is retained above for audit/display only — it is
    // NOT part of the trust decision. #744: gating trust on it (originally an
    // allow-list of OWNER/MEMBER/COLLABORATOR, meant as a cheap pre-filter)
    // rejected every verdict, including from the repository's sole admin —
    // measured empirically against a real PR: the live collaborator-permission
    // lookup correctly resolved `admin`, yet GitHub reported that same admin
    // account's `author_association` as `CONTRIBUTOR`, which was never on the
    // allow-list. `author_association` is computed by GitHub from unrelated,
    // looser signals (e.g. "has previously committed") and is not guaranteed
    // to reflect current collaborator status, so it must never gate trust.
    // `squadWriteAccess` alone is the authoritative check: the caller sets it
    // from a live, fail-closed collaborator-permission lookup for every
    // comment, so this remains fail-closed for a genuine non-collaborator (who
    // resolves to `read` or an unresolved lookup) without also rejecting a
    // legitimate account whose `author_association` doesn't happen to match.
    trusted: comment.squadWriteAccess === true,
    // Set by the caller when the commenting account is a repository
    // administrator naming its own GitHub login as the reviewer. That is the
    // human owner speaking rather than an agent, and it is decisive.
    isSelfDeclaredAdmin: comment.squadAdminOverride === true,
    recordedAt: comment.updated_at ?? comment.created_at ?? '',
    url: comment.html_url ?? '',
  };
}

/**
 * Determine whether a record reviewed at an old head SHA may be carried
 * forward to a new head SHA without a fresh review. This exists so a routine
 * base-branch sync doesn't cost a full re-review of a contribution nobody
 * touched — which matters here because `development` is `strict: true`, so
 * every PR must sync before it can merge.
 *
 * BOTH conditions must hold:
 *
 *   1. The reviewed SHA is a strict ancestor of the new head — nothing was
 *      rewritten or force-pushed away. This is `recordAncestryStatus`, the
 *      `status` field GitHub's compare API returns for
 *      `compare/{reviewedSha}...{newHeadSha}`. Only `'ahead'` satisfies it.
 *      (`'identical'` never reaches this function — an unchanged head is
 *      already handled as a direct SHA match upstream — and `'behind'` /
 *      `'diverged'` mean history was rewritten, so ancestry fails.)
 *   2. The PR's *own* contribution — its diff against the base branch — is
 *      byte-for-byte unchanged between the reviewed SHA and the new head.
 *
 * Condition 2 is deliberately NOT a check of "every new commit is an ancestor
 * of base": a plain `git merge development` always creates a fresh merge
 * commit that is itself not an ancestor of base (base has no idea it exists),
 * so a naive commit-membership check rejects the exact sync it is meant to
 * allow. Comparing the PR's own diff instead sidesteps that entirely, and it
 * is robust to *why* the merge commit exists: a clean sync merge changes no
 * file the PR's diff already covers, while a conflict resolved by adding new
 * logic inside the merge commit — the actual threat this guards against —
 * does change that diff and is correctly rejected.
 *
 * The PR's diff at either point in time is obtained the same way GitHub
 * computes the PR's own file list: a three-dot compare against the base
 * branch, `compare/{baseRef}...{sha}`. Three-dot compare pivots on the merge
 * base of the two refs rather than diffing the refs directly, so it keeps
 * returning "this PR's changes" even after the base branch has advanced.
 * Both compares are obtained via `GET /repos/{owner}/{repo}/compare/{basehead}`
 * without fetching the repository, which matters because the workflow
 * deliberately checks out only the default branch (see the workflow header).
 *
 * `reviewedDiffFiles` / `currentDiffFiles` are each the `files` array from one
 * of those two compares. Every entry the compare API returns for a change to
 * matter (rename, add, delete, edit) is compared: `status`, `filename`,
 * `previous_filename`, `sha` (the resulting blob's SHA) and, when GitHub
 * supplies it, `patch` — so a same-named file with different content is
 * detected even if a diff subtlety trims the patch.
 *
 * Diff equality alone is NOT sufficient, though: an author could push a
 * commit that changes the PR's contribution and a *later* commit that
 * reverts it, landing back at the same final diff while still having
 * authored real changes in the range — exactly the review-then-push-more
 * threat model the SHA pin exists to catch, and diff-equality by itself
 * would wrongly wave it through. `nonBaseCommitsIntroduceNoExtraContent`
 * closes that gap: it must be true only when every commit introduced since
 * the review that is NOT already reachable from the base tip introduces
 * nothing beyond what a clean merge of its own two parents would produce.
 *
 * This is deliberately NOT "content-empty against its own first parent" —
 * an earlier revision of this exemption tried that in PrintFarmer and it is
 * wrong in practice: GitHub's single-commit endpoint diffs a merge commit
 * against its first parent only, and for a REAL sync merge that diff is
 * naturally non-empty, because it necessarily includes everything the merge
 * pulled in from the base side. Rejecting on that basis would reject
 * essentially every legitimate sync, defeating the whole feature.
 *
 * The correct test compares a merge commit's own diff to what merging its
 * *two parents alone* would produce: for a two-parent merge commit with
 * parents `[p1, p2]`, `compare(p1...p2)` is a three-dot compare that pivots
 * on the merge base of p1 and p2, so its `files` are exactly "what p2
 * contributes beyond its common history with p1" — precisely what a clean,
 * no-conflict merge of p2 into p1 would add. If the merge commit's own diff
 * (`GET /repos/{owner}/{repo}/commits/{sha}`, diffed against parent[0] by
 * GitHub's convention) has the same fingerprint as `compare(p1...p2).files`,
 * the merge commit added nothing beyond that — no manually-resolved
 * conflict, no extra edit. A commit with anything other than exactly two
 * parents (an ordinary single-parent commit, i.e. real author work; or a
 * rare octopus merge, which this check does not attempt to validate) is
 * always treated as introducing its own content and disqualifies the record.
 * `diffFingerprint` (below) is exported specifically so the workflow can
 * reuse the exact same equality test for this per-commit comparison.
 *
 * Fails closed:
 *
 *   - An empty `reviewedDiffFiles` is never treated as safe — the caller
 *     must always supply the PR's real recorded diff, not a default meaning
 *     "nothing to check".
 *   - GitHub's compare endpoint caps the `files` array (large diffs are
 *     silently truncated with no in-band signal). `filesMayBeTruncated` lets
 *     the caller say "either side may be incomplete"; when true, equality can
 *     never be proven, so this returns false rather than risk comparing two
 *     truncated, apparently-equal lists that actually differ past the cutoff.
 *   - `nonBaseCommitsIntroduceNoExtraContent` defaults to `false`: the caller
 *     must positively prove every non-base commit is a clean merge (or that
 *     there are none), not rely on a default meaning "assume clean".
 *
 * This function performs no I/O; the workflow computes the compares and the
 * per-commit lookups and passes their results in.
 */
export function isCarriedAcrossSync({
  recordAncestryStatus,
  reviewedDiffFiles = [],
  currentDiffFiles = [],
  filesMayBeTruncated = false,
  nonBaseCommitsIntroduceNoExtraContent = false,
} = {}) {
  if (recordAncestryStatus !== 'ahead') {
    return false;
  }
  if (filesMayBeTruncated) {
    return false;
  }
  if (!nonBaseCommitsIntroduceNoExtraContent) {
    return false;
  }
  const reviewed = Array.isArray(reviewedDiffFiles) ? reviewedDiffFiles : [];
  const current = Array.isArray(currentDiffFiles) ? currentDiffFiles : [];
  if (reviewed.length === 0) {
    return false;
  }
  return diffFingerprint(reviewed) === diffFingerprint(current);
}

/**
 * Canonical, order-independent fingerprint of a compare-API `files` array,
 * used to test two diffs for byte-for-byte equality: once for the PR's own
 * diff (see `isCarriedAcrossSync`), and again by the workflow to test a
 * merge commit's own diff against `compare(parent1...parent2).files` when
 * proving it introduced nothing beyond a clean merge of its two parents.
 * Not a content hash of anything beyond the fields the compare API actually
 * exposes, and not used for anything except these equality tests. Exported
 * so both call sites share one definition of "identical diff".
 */
export function diffFingerprint(files) {
  return files
    .map((file) =>
      JSON.stringify([
        file?.status ?? '',
        file?.previous_filename ?? '',
        file?.filename ?? '',
        file?.sha ?? '',
        file?.patch ?? '',
      ]),
    )
    .sort()
    .join('\n');
}

/**
 * Split trusted verdicts into the reviewer's decision *on the current head* and
 * everything else.
 *
 * Current-head records and stale records are ranked in separate pools on
 * purpose. Taking a single newest-overall record per reviewer would let a
 * comment naming an old SHA erase that reviewer's live REQUEST_CHANGES, since
 * the stale record would win on timestamp and then be filtered out of the
 * current pool. A stale comment can never displace a current-head one.
 *
 * `carriedShas` (a `Set`/iterable of lowercase SHAs, or an equivalent) names
 * old head SHAs the caller has already proven, via `isCarriedAcrossSync`, to
 * introduce nothing but base-branch commits since they were reviewed. A
 * record pinned to one of those SHAs is treated as current — but tagged
 * `carriedAcrossSync: true` so the audit trail never silently presents it as
 * a fresh review of the new head.
 */
export function collectVerdicts(comments, headSha, { carriedShas } = {}) {
  const head = String(headSha ?? '').toLowerCase();
  const carried =
    carriedShas instanceof Set ? carriedShas : new Set(carriedShas ?? []);
  const current = new Map();
  const staleLatest = new Map();
  const unauthenticated = [];
  for (const comment of comments ?? []) {
    const record = parseVerdictComment(comment);
    if (!record) {
      continue;
    }
    if (!record.trusted) {
      // Kept and reported rather than silently dropped: "no review recorded" is
      // a misleading failure message when a record existed but its author could
      // not be authenticated.
      unauthenticated.push(record);
      continue;
    }
    const isCurrentHead = record.headSha === head;
    const isCarried = !isCurrentHead && carried.has(record.headSha);
    const pool = isCurrentHead || isCarried ? current : staleLatest;
    const candidate = isCarried
      ? { ...record, carriedAcrossSync: true }
      : record;
    const previous = pool.get(candidate.reviewer);
    if (
      !previous ||
      Date.parse(candidate.recordedAt || 0) >=
        Date.parse(previous.recordedAt || 0)
    ) {
      pool.set(candidate.reviewer, candidate);
    }
  }
  const stale = [...staleLatest.values()].filter(
    (record) => !current.has(record.reviewer),
  );
  return { current, stale, unauthenticated };
}

/**
 * Decide whether the changed paths qualify for the one-reviewer
 * documentation-only exemption defined in
 * `.squad/skills/agent-collaboration/SKILL.md`.
 *
 * The prose test itself is NOT re-derived here: it delegates to
 * `isDocumentationPath` in `scripts/docs-only-change.mjs`, which that file and
 * the SKILL both name as the single executable definition of "documentation".
 * Two lists drift; one cannot. What this function adds on top is the carve-out
 * layer the SKILL is equally explicit about — "the CI classifier is necessary,
 * never sufficient": a change qualifies for one reviewer only when it is
 * documentation-only by that classifier AND clear of every carve-out.
 *
 * Fails toward the full gate whenever classification is not obvious.
 */
export function classifyChangeScope(paths) {
  const files = (paths ?? []).filter(
    (path) => typeof path === 'string' && path,
  );
  if (files.length === 0) {
    // "Nothing changed" and "the diff could not be computed" arrive as the same
    // value, and only one of them is safe to act on.
    return { docsOnly: false, reason: 'no changed files reported' };
  }
  for (const path of files) {
    const basename = path.split('/').pop().toLowerCase();
    if (fullGatePrefixes.some((prefix) => path.startsWith(prefix))) {
      return {
        docsOnly: false,
        reason: `${path} governs agent or CI behaviour`,
      };
    }
    if (!path.includes('/') && fullGateFiles.has(basename)) {
      return {
        docsOnly: false,
        reason: `${path} is a root agent-instruction file`,
      };
    }
    if (
      sensitiveProseFiles.has(path) ||
      sensitiveProsePrefixes.some((prefix) => path.startsWith(prefix)) ||
      sensitiveProse.test(path)
    ) {
      return {
        docsOnly: false,
        reason: `${path} is security/licensing/contract prose`,
      };
    }
    if (!isDocumentationPath(path)) {
      return { docsOnly: false, reason: `${path} is not documentation` };
    }
    if (
      !proseExtensions.some((extension) =>
        path.toLowerCase().endsWith(extension),
      )
    ) {
      // Documentation to `isDocumentationPath`, but not prose a reviewer reads
      // — a `docs/**` image or other binary asset. See `proseExtensions`.
      return { docsOnly: false, reason: `${path} is not reviewable prose` };
    }
  }
  return { docsOnly: true, reason: 'every changed path is documentation' };
}

/**
 * Resolve which squad member authored the PR.
 *
 * GitHub-account authorship is useless here because every agent acts through
 * the same owner token, so authorship is resolved at the squad-identity level:
 *   1. an explicit `Squad-Author: <member>` line in the PR body,
 *   2. otherwise the `squad:{member}` labels on the issues the PR closes,
 *   3. otherwise a known member token in the head branch name.
 */
export function resolveAuthorMembers({
  prBody = '',
  branchName = '',
  linkedIssueLabels = [],
  roster = new Set(),
} = {}) {
  const declared = singleMatch(
    /^[ \t>]*Squad-Author:[ \t]*(.+?)[ \t]*$/gim,
    prBody,
  );
  const declaredMember = normalizeMember(declared);
  if (declaredMember) {
    return {
      members: new Set([declaredMember]),
      source: 'PR body Squad-Author',
    };
  }

  const fromIssues = rosterFromLabels(linkedIssueLabels);
  if (fromIssues.size > 0) {
    return { members: fromIssues, source: 'squad: label on linked issue' };
  }

  const branchTokens = branchName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const fromBranch = new Set(branchTokens.filter((token) => roster.has(token)));
  if (fromBranch.size > 0) {
    return { members: fromBranch, source: 'head branch name' };
  }

  return { members: new Set(), source: 'unresolved' };
}

function shortSha(sha) {
  return sha.slice(0, 12);
}

function truncate(text, limit = 140) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Evaluate the gate.
 *
 * Returns the commit-status state plus a precise, single-line reason. The
 * caller posts this as `squad/pre-pr-verdict` on `headSha`.
 *
 * `squadLabeled` scopes the gate to squad-authored PRs — see `squadScopeLabel`
 * for why opt-in scoping is safe here and what must stay true for it to remain
 * safe. Callers MUST pass it explicitly; it defaults to `false` so that a caller
 * which forgets produces a harmless out-of-scope result rather than silently
 * evaluating a PR against an empty review panel.
 */
export function evaluateGate({
  headSha,
  changedPaths = [],
  comments = [],
  reviews = [],
  roster = new Set(),
  authorMembers = new Set(),
  authorSource = 'unresolved',
  squadLabeled = false,
  // Old head SHAs (see `isCarriedAcrossSync`) the caller has already proven
  // introduce nothing but base-branch commits since they were reviewed. A
  // record pinned to one of these stays valid at the current head, tagged
  // `carriedAcrossSync` so the status and audit trail say so explicitly.
  carriedShas = new Set(),
} = {}) {
  const head = String(headSha ?? '').toLowerCase();
  const notes = [];
  if (!/^[0-9a-f]{40}$/.test(head)) {
    return {
      state: 'error',
      passed: false,
      description: 'Cannot evaluate: PR head SHA is unavailable.',
      reason: 'missing head sha',
      notes,
      requiredMembers: [],
      approvals: [],
      stale: [],
    };
  }

  // 0. Scope. The gate covers squad-authored PRs, identified by the `squad`
  //    label. Everything else — dependency bumps, ad-hoc human PRs — is out of
  //    scope and reports NOT_APPLICABLE rather than a red BLOCKED that no one
  //    can clear without staging a fake agent review.
  //
  //    This is safe as opt-in scoping ONLY because Ralph refuses to auto-merge
  //    an unlabelled PR (see squadScopeLabel). Out of scope means "a human
  //    merges this deliberately", never "this merges itself unreviewed". If that
  //    coupling is ever broken, this check becomes a hole — keep them together.
  if (!squadLabeled) {
    return {
      state: 'success',
      passed: true,
      scope: 'out-of-scope',
      description: truncate(
        `NOT_APPLICABLE @ ${shortSha(head)}: not a squad PR (no '${squadScopeLabel}' label)`,
      ),
      reason:
        `the '${squadScopeLabel}' label is absent, so this PR is outside the ` +
        'squad review gate; it is not eligible for unattended merge either',
      notes: [
        `Out of scope: no '${squadScopeLabel}' label on this pull request.`,
        'The squad review gate applies to squad-authored PRs. Unlabelled PRs ' +
          'are merged by a human rather than by the unattended merger, so no ' +
          'agent review record is required or accepted here.',
      ],
      requiredMembers: [],
      approvals: [],
      stale: [],
    };
  }

  // 1. Owner override through GitHub's native review UI at the exact current
  //    head. Only each administrator's MOST RECENT decisive review at that head
  //    counts: taking any matching approval would let an earlier APPROVED
  //    survive after the same administrator later recorded CHANGES_REQUESTED on
  //    the same commit. COMMENTED reviews are not decisive — GitHub itself does
  //    not treat them as changing approval state — and DISMISSED clears.
  const latestAdminReview = new Map();
  for (const review of reviews ?? []) {
    if (
      review?.isAdmin !== true ||
      String(review.commitId ?? '').toLowerCase() !== head ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    ) {
      continue;
    }
    const login = String(review.login ?? '').toLowerCase();
    const previous = latestAdminReview.get(login);
    const rank = (entry) => [
      Date.parse(entry.submittedAt ?? '') || 0,
      Number(entry.id) || 0,
    ];
    if (!previous) {
      latestAdminReview.set(login, review);
      continue;
    }
    const [newTime, newId] = rank(review);
    const [oldTime, oldId] = rank(previous);
    if (newTime > oldTime || (newTime === oldTime && newId >= oldId)) {
      latestAdminReview.set(login, review);
    }
  }

  // A standing administrator change request outranks another approval.
  const adminBlock = [...latestAdminReview.values()].find(
    (review) => review.state === 'CHANGES_REQUESTED',
  );
  if (adminBlock) {
    return {
      state: 'failure',
      passed: false,
      override: 'github-review',
      description: truncate(
        `REQUEST_CHANGES @ ${shortSha(head)} by ${adminBlock.login}`,
      ),
      reason:
        `administrator ${adminBlock.login} requested changes on the current ` +
        'head through GitHub review',
      notes,
      requiredMembers: [],
      approvals: [],
      stale: [],
    };
  }

  const adminApproval = [...latestAdminReview.values()].find(
    (review) => review.state === 'APPROVED',
  );
  if (adminApproval) {
    return {
      state: 'success',
      passed: true,
      override: 'github-review',
      description: truncate(
        `APPROVE (owner) @ ${shortSha(head)} by ${adminApproval.login}`,
      ),
      reason: `administrator ${adminApproval.login} approved the current head on GitHub`,
      notes,
      requiredMembers: [],
      approvals: [adminApproval.login],
      stale: [],
    };
  }

  const { current, stale, unauthenticated } = collectVerdicts(comments, head, {
    carriedShas,
  });
  if (unauthenticated.length > 0) {
    notes.push(
      `Rejected ${unauthenticated.length} record(s) whose author could not be ` +
        'authenticated with repository write access: ' +
        `${[...new Set(unauthenticated.map((r) => r.commenter || '(unknown)'))].join(', ')}. ` +
        'This repository is public, so anyone can comment; only verified ' +
        'write-access authors count.',
    );
  }

  // 2. Owner override via record comment: an administrator who names their own
  //    GitHub login as the reviewer is speaking as the owner rather than as an
  //    agent. This is the one path that is a real authorisation rather than a
  //    self-attested agent record, so it is labelled `(owner)`.
  for (const record of current.values()) {
    if (record.isSelfDeclaredAdmin) {
      const passed = record.verdict === 'APPROVE';
      return {
        state: passed ? 'success' : 'failure',
        passed,
        override: 'owner-comment',
        description: truncate(
          passed
            ? `APPROVE (owner) @ ${shortSha(head)} by ${record.commenter}`
            : `REQUEST_CHANGES @ ${shortSha(head)} by ${record.commenter}`,
        ),
        reason: `repository administrator ${record.commenter} recorded ${record.verdict}`,
        notes,
        requiredMembers: [],
        approvals: passed ? [record.commenter] : [],
        stale,
      };
    }
  }

  const scope = classifyChangeScope(changedPaths);
  notes.push(
    scope.docsOnly
      ? `Documentation-only change (${scope.reason}): one reviewer required.`
      : `Full gate (${scope.reason}): the ${reviewPanel.join('/')} panel is required.`,
  );
  if (authorMembers.size > 0) {
    notes.push(
      `PR authored by ${[...authorMembers].join(', ')} (source: ${authorSource}).`,
    );
  } else {
    notes.push(
      'PR author squad identity could not be resolved; the reviewer-is-not-the-' +
        'author quality heuristic is applied only against the roster.',
    );
  }
  notes.push(
    "Self-attested: every agent here runs under the owner's authority, so this " +
      'record is not independent review and provides no separation of duties.',
  );

  // 3. Reviewer eligibility. Excluding the author agent is a quality heuristic
  //    (fresh context catches more than self-re-reading), not an independence
  //    guarantee — the author agent and the reviewer agent share one principal.
  const eligible = new Map();
  for (const [member, record] of current) {
    if (!roster.has(member)) {
      notes.push(`Ignored ${member}: not a known squad identity.`);
      continue;
    }
    if (authorMembers.has(member)) {
      return {
        state: 'failure',
        passed: false,
        description: truncate(
          `BLOCKED @ ${shortSha(head)}: reviewer ${member} is the PR author`,
        ),
        reason:
          `reviewer ${member} is the squad member who authored this PR ` +
          `(source: ${authorSource})`,
        notes,
        requiredMembers: [],
        approvals: [],
        stale,
      };
    }
    eligible.set(member, record);
  }

  // 4. Any current-head rejection blocks, regardless of approval count. This is
  //    the only path that emits a REQUEST_CHANGES status: it is a reviewer
  //    decision, unlike the BLOCKED states below, which mean evidence is
  //    absent rather than negative.
  const rejection = [...eligible.values()].find(
    (record) => record.verdict === 'REQUEST_CHANGES',
  );
  if (rejection) {
    return {
      state: 'failure',
      passed: false,
      description: truncate(
        `REQUEST_CHANGES @ ${shortSha(head)} by ${rejection.reviewer}`,
      ),
      reason: `${rejection.reviewer} recorded REQUEST_CHANGES on the current head`,
      notes,
      requiredMembers: [],
      approvals: [],
      stale,
    };
  }

  const approvals = [...eligible.values()]
    .filter((record) => record.verdict === 'APPROVE')
    .map((record) => record.reviewer)
    .sort();

  // 5. Reviewer count and panel membership.
  const requiredCount = scope.docsOnly ? 1 : 3;
  const requiredMembers = scope.docsOnly
    ? []
    : reviewPanel.filter((member) => !authorMembers.has(member));
  if (!scope.docsOnly && requiredMembers.length < reviewPanel.length) {
    notes.push(
      `Panel members ${reviewPanel.filter((m) => authorMembers.has(m)).join(', ')} ` +
        'authored this PR; substitutes from the roster may stand in.',
    );
  }

  const missingPanel = requiredMembers.filter(
    (member) => !approvals.includes(member),
  );
  if (missingPanel.length > 0 || approvals.length < requiredCount) {
    const staleNote =
      stale.length > 0
        ? ` (stale at ${stale.map((r) => `${r.reviewer}@${shortSha(r.headSha)}`).join(', ')})`
        : '';
    const detail =
      approvals.length === 0 && stale.length === 0
        ? unauthenticated.length > 0
          ? `no authenticated review for ${shortSha(head)} ` +
            `(${unauthenticated.length} unauthenticated)`
          : `no review recorded for ${shortSha(head)}`
        : `have ${approvals.length}/${requiredCount}` +
          (missingPanel.length > 0
            ? `, missing ${missingPanel.join('+')}`
            : '') +
          staleNote;
    return {
      state: 'failure',
      passed: false,
      description: truncate(`BLOCKED @ ${shortSha(head)}: ${detail}`),
      reason:
        stale.length > 0 && approvals.length === 0
          ? `every recorded review is stale: ${stale
              .map(
                (r) => `${r.reviewer} reviewed ${r.headSha}, head is ${head}`,
              )
              .join('; ')}`
          : detail,
      notes,
      requiredMembers,
      approvals,
      stale,
    };
  }

  // Records carried forward under the sync exemption (see
  // `isCarriedAcrossSync`) still count toward `approvals`, but the status and
  // audit trail must say so explicitly — never silently present a carried
  // record as a fresh review of the current head.
  const carried = [...eligible.values()].filter(
    (record) =>
      record.verdict === 'APPROVE' && record.carriedAcrossSync === true,
  );
  if (carried.length > 0) {
    notes.push(
      `Carried across sync: ${carried
        .map((record) => `${record.reviewer}@${shortSha(record.headSha)}`)
        .join(', ')} — the PR's own diff against its base branch is proven ` +
        'byte-for-byte unchanged since that review (a pure base sync), so the ' +
        'record was carried forward rather than re-earned.',
    );
  }
  const carriedSuffix = carried.length > 0 ? ', carried across sync' : '';

  // Deliberately NOT "APPROVE": this is a record that reviewer agents examined
  // this exact commit, self-attested under the owner's authority. Only the owner
  // override path emits an `APPROVE (owner)` status, because only that path is a
  // real authorisation by a distinct principal.
  return {
    state: 'success',
    passed: true,
    description: truncate(
      `REVIEWED (self-attested${carriedSuffix}) @ ${shortSha(head)} by ${approvals.join('+')}`,
    ),
    reason:
      `${approvals.length} SHA-bound self-attested review record(s) on the ` +
      'current head' +
      (carried.length > 0
        ? ` (${carried.length} carried forward across a pure base sync)`
        : ''),
    notes,
    requiredMembers,
    approvals,
    stale,
    carried: carried.map((record) => record.reviewer),
  };
}
