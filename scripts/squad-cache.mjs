// A durable, machine-local cache for Ralph's per-round conclusions.
//
// WHY THIS EXISTS. `.squad/agents/ralph/.state.json` lives inside the checkout
// that wrote it. Every scheduled round runs in a fresh, ephemeral worktree, so
// that file is absent on arrival every single time — which drives the "full
// deep rescan happens only when .state.json is missing" branch on 100% of
// rounds. The delta scan was written, reviewed, and shipped, and it has never
// once taken its cheap path. A cache placed inside the thing that is destroyed
// between uses is not a cache; it is a slower way to write a file.
//
// So the store lives OUTSIDE any worktree, keyed by repository + machine +
// workflow, and survives worktree churn. Three properties follow, and each one
// is a defect this module exists to make unreachable:
//
//   1. THE CACHE IS NEVER AUTHORIZATION. A cached conclusion may skip WORK. It
//      may never skip a CLAIM or a MERGE VERIFICATION. `requiresFreshCheck()`
//      returns true for those actions unconditionally and has no parameter
//      that can turn it off — see the note on that function.
//   2. A CORRUPT CACHE IS AN EMPTY CACHE, NEVER AN ERROR AND NEVER A LIE.
//      `loadCache()` does not throw. Unparseable bytes, a wrong schema version,
//      a scope that does not match, and a plain missing file all resolve to a
//      usable empty cache carrying a `status` naming which happened. The
//      failure mode being closed off is a half-parsed file answering questions
//      about issues it never saw.
//   3. INVALIDATION IS BY FINGERPRINT, NOT BY AGE. Nothing here expires on a
//      clock. An entry is fresh only while every observation it was derived
//      from still hashes the same, and the fingerprint includes the things
//      that look like they could not matter: a blocker that CLOSED (the
//      dependency closure is fingerprinted over open AND closed members,
//      because a closed blocker is exactly what makes a blocked issue READY),
//      a verdict comment with no push behind it, a check rollup with no
//      verdict change, the holds file, and the policy version.
//
// Windows and macOS are both first-class: the round runs on whichever machine
// the scheduler picked, and the two disagree about where a durable cache
// belongs. `resolveCacheRoot()` encodes that, and refuses any root that
// resolves inside the repository it is caching — a cache that lands back in
// the worktree reintroduces the whole defect silently.
//
// No shebang: this module is imported by tests/squadCache.test.ts, and vite's
// transform does not strip one the way node does.

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Bumped whenever the on-disk shape changes in a way an older reader would
 * misread. A reader that finds a version it does not recognise reports
 * `schema-mismatch` and starts empty rather than guessing at the fields.
 */
export const CACHE_SCHEMA_VERSION = 2;

export const CACHE_DIR_ENV = 'SQUAD_CACHE_DIR';
export const APP_CACHE_NAMESPACE = 'PrintFarmerDesktop';
export const CACHE_SUBDIRECTORY = 'squad-cache';

/** Default lease for the overlap guard. Two rounds overlapping is normal on an
 * hourly schedule when one round runs long; two rounds WRITING the same cache
 * file is not. */
export const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;

export const STATUS_OK = 'ok';
export const STATUS_MISSING = 'missing';
export const STATUS_CORRUPT = 'corrupt';
export const STATUS_SCHEMA_MISMATCH = 'schema-mismatch';
export const STATUS_SCOPE_MISMATCH = 'scope-mismatch';

/**
 * Actions that a cache may never shorten, whatever it remembers.
 *
 * `claim` and `merge` are here because both are WRITES whose safety depends on
 * a value that can change between the read and the write. loop.md requires the
 * issue re-fetched immediately before a claim and `headRefOid` re-read
 * immediately before a merge; a cache that could answer either would convert
 * "verified a moment ago" into "verified some round ago", which is precisely
 * the #536 shape — six rounds gating a PR on a head SHA that had moved hours
 * earlier, every round re-confirming its own memory.
 */
export const FRESH_ONLY_ACTIONS = Object.freeze(['claim', 'merge']);

/**
 * @param {string} action
 * @returns {boolean} true when the action must be re-derived live this round.
 *
 * Deliberately takes no cache, no entry and no options. There is no argument
 * shaped like "but this one is recent", because the only way to keep a rule
 * like this true is to give callers nothing to pass.
 */
export function requiresFreshCheck(action) {
  return FRESH_ONLY_ACTIONS.includes(action);
}

function slugify(value, fallback) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : fallback;
}

/**
 * Where the durable store lives on this platform.
 *
 * @param {{ env?: Record<string, string | undefined>, platform?: string,
 *           homedir?: string }} [options]
 * @returns {string} an absolute directory path
 */
export function resolveCacheRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();

  const override = env[CACHE_DIR_ENV];
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override.trim());
  }

  if (platform === 'win32') {
    const base =
      env.LOCALAPPDATA && env.LOCALAPPDATA.trim().length > 0
        ? env.LOCALAPPDATA
        : path.join(home, 'AppData', 'Local');
    return path.resolve(base, APP_CACHE_NAMESPACE, CACHE_SUBDIRECTORY);
  }

  if (platform === 'darwin') {
    return path.resolve(
      home,
      'Library',
      'Caches',
      APP_CACHE_NAMESPACE,
      CACHE_SUBDIRECTORY,
    );
  }

  const xdg =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim().length > 0
      ? env.XDG_CACHE_HOME
      : path.join(home, '.cache');
  return path.resolve(
    xdg,
    APP_CACHE_NAMESPACE.toLowerCase(),
    CACHE_SUBDIRECTORY,
  );
}

/**
 * True when `candidate` sits inside `repoRoot`.
 *
 * Both are resolved and compared segment-wise, so `/repo-cache` is not treated
 * as inside `/repo` — a prefix compare on raw strings says it is.
 */
export function isInsideRepository(candidate, repoRoot) {
  const relative = path.relative(
    path.resolve(repoRoot),
    path.resolve(candidate),
  );
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The absolute path of one scope's cache file.
 *
 * @param {{ repo: string, machine?: string, workflow: string, root?: string,
 *           repoRoot?: string, env?: Record<string, string | undefined>,
 *           platform?: string, homedir?: string }} scope
 */
export function resolveCachePath(scope) {
  const root = scope.root ?? resolveCacheRoot(scope);
  if (scope.repoRoot && isInsideRepository(root, scope.repoRoot)) {
    throw new Error(
      `squad-cache: refusing a cache root inside the repository (${root}). ` +
        'The store must outlive the worktree; set ' +
        `${CACHE_DIR_ENV} to a durable location outside it.`,
    );
  }
  const repo = slugify(scope.repo, 'unknown-repo');
  const machine = slugify(scope.machine ?? os.hostname(), 'unknown-machine');
  const workflow = slugify(scope.workflow, 'unknown-workflow');
  return path.join(root, repo, machine, `${workflow}.json`);
}

/** An empty, valid cache for a scope. Every failure path returns one of these. */
export function emptyCache(scope) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repo: scope?.repo ?? null,
    machine: scope?.machine ?? null,
    workflow: scope?.workflow ?? null,
    policyVersion: scope?.policyVersion ?? null,
    updatedAt: null,
    entries: {},
  };
}

/**
 * Validate a parsed cache document against the schema, without repairing it.
 *
 * Returns a `status` rather than throwing so the caller has one branch, and so
 * a malformed field cannot be silently coerced into a plausible value.
 */
export function validateCacheDocument(document, scope) {
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    return {
      status: STATUS_CORRUPT,
      reason: 'cache document is not an object',
    };
  }
  if (document.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return {
      status: STATUS_SCHEMA_MISMATCH,
      reason: `schemaVersion ${String(document.schemaVersion)} != ${CACHE_SCHEMA_VERSION}`,
    };
  }
  if (
    document.entries === null ||
    typeof document.entries !== 'object' ||
    Array.isArray(document.entries)
  ) {
    return { status: STATUS_CORRUPT, reason: 'entries is not an object' };
  }
  for (const [key, entry] of Object.entries(document.entries)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        status: STATUS_CORRUPT,
        reason: `entry ${key} is not an object`,
      };
    }
    if (
      typeof entry.fingerprint !== 'string' ||
      entry.fingerprint.length === 0
    ) {
      return {
        status: STATUS_CORRUPT,
        reason: `entry ${key} has no usable fingerprint`,
      };
    }
  }
  if (scope) {
    const mismatched = ['repo', 'machine', 'workflow'].filter(
      (field) =>
        scope[field] !== undefined &&
        document[field] !== null &&
        document[field] !== undefined &&
        slugify(document[field], 'a') !== slugify(scope[field], 'b'),
    );
    if (mismatched.length > 0) {
      return {
        status: STATUS_SCOPE_MISMATCH,
        reason: `cache scope differs on ${mismatched.join(', ')}`,
      };
    }
  }
  return { status: STATUS_OK, reason: null };
}

/**
 * Read a cache. NEVER THROWS on bad content.
 *
 * @returns {{ status: string, reason: string | null, cache: object,
 *             path: string }}
 */
export function loadCache(scope, io = {}) {
  const readFile = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const cachePath = scope.path ?? resolveCachePath(scope);

  let raw;
  try {
    raw = readFile(cachePath);
  } catch {
    return {
      status: STATUS_MISSING,
      reason: 'no cache file for this scope',
      cache: emptyCache(scope),
      path: cachePath,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: STATUS_CORRUPT,
      reason: `unparseable JSON: ${error instanceof Error ? error.message : 'unknown'}`,
      cache: emptyCache(scope),
      path: cachePath,
    };
  }

  const verdict = validateCacheDocument(parsed, scope);
  if (verdict.status !== STATUS_OK) {
    return {
      status: verdict.status,
      reason: verdict.reason,
      cache: emptyCache(scope),
      path: cachePath,
    };
  }

  return { status: STATUS_OK, reason: null, cache: parsed, path: cachePath };
}

/**
 * Write a cache atomically: a temp file in the same directory, fsynced, then
 * renamed over the target. A reader either sees the whole previous document or
 * the whole new one — never a truncated prefix of either, which is the shape
 * that produces a cache reporting confident conclusions about half the board.
 */
export function saveCache(scope, cache, io = {}) {
  const cachePath = scope.path ?? resolveCachePath(scope);
  const makeDir = io.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const write = io.writeFile ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const rename = io.rename ?? renameSync;
  const sync = io.sync ?? defaultSync;
  const remove = io.remove ?? ((p) => rmSync(p, { force: true }));

  const document = {
    ...emptyCache(scope),
    ...cache,
    schemaVersion: CACHE_SCHEMA_VERSION,
    repo: scope.repo ?? cache?.repo ?? null,
    machine: scope.machine ?? cache?.machine ?? null,
    workflow: scope.workflow ?? cache?.workflow ?? null,
    updatedAt: scope.now ?? new Date().toISOString(),
  };

  const verdict = validateCacheDocument(document, scope);
  if (verdict.status !== STATUS_OK) {
    throw new Error(
      `squad-cache: refusing to write an invalid cache: ${verdict.reason}`,
    );
  }

  makeDir(path.dirname(cachePath));
  const temporary = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    write(temporary, `${JSON.stringify(document, null, 2)}\n`);
    sync(temporary);
    rename(temporary, cachePath);
  } catch (error) {
    remove(temporary);
    throw error;
  }
  return { path: cachePath, document };
}

/**
 * Flush the temp file before it is renamed into place.
 *
 * Opened `r+`: Windows refuses `FlushFileBuffers` on a read-only handle with
 * EPERM, so `openSync(target, 'r')` turns a durability nicety into a hard
 * write failure on half the platforms this runs on.
 *
 * A refused flush is swallowed. `rename` still gives the property that
 * actually matters here — a reader sees the whole old document or the whole
 * new one — and the alternative is refusing to cache at all on a filesystem
 * that does not implement fsync (network shares, some container overlays).
 * A crash losing the last write costs one recomputed round; a throw here
 * costs every round.
 */
function defaultSync(target) {
  let handle;
  try {
    handle = openSync(target, 'r+');
  } catch {
    return;
  }
  try {
    fsyncSync(handle);
  } catch {
    /* filesystem does not support flushing this handle */
  } finally {
    closeSync(handle);
  }
}

/* ---------------------------------------------------------------------------
 * Overlap guard
 * ------------------------------------------------------------------------ */

/**
 * Decide whether a lock record still holds the floor.
 *
 * Pure over a parsed record so both arms are drivable without racing real
 * processes: an expired lease is reclaimable, a live one is not, and an
 * unreadable record is treated as reclaimable rather than as a permanent
 * wedge (a corrupt lock that blocked forever would be a worse failure than
 * the overlap it guards).
 */
export function evaluateLock(
  record,
  { now, ttlMs = DEFAULT_LOCK_TTL_MS } = {},
) {
  const at = Number.isFinite(now) ? now : Date.now();
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { held: false, reason: 'no usable lock record' };
  }
  const acquiredAt = Date.parse(String(record.acquiredAt ?? ''));
  if (!Number.isFinite(acquiredAt)) {
    return { held: false, reason: 'lock record has no parseable acquiredAt' };
  }
  const lease = Number.isFinite(record.ttlMs) ? record.ttlMs : ttlMs;
  if (at - acquiredAt >= lease) {
    return {
      held: false,
      reason: `lease expired ${at - acquiredAt}ms after acquisition (ttl ${lease}ms)`,
      holder: record,
    };
  }
  return {
    held: true,
    reason: `held by pid ${String(record.pid)} on ${String(record.host)}`,
    holder: record,
  };
}

export function lockPathFor(cachePath) {
  return `${cachePath}.lock`;
}

/**
 * Take the write lease for a scope, or report who holds it.
 *
 * @returns {{ acquired: boolean, path: string, holder?: object, reason?: string }}
 */
export function acquireCacheLock(scope, io = {}) {
  const cachePath = scope.path ?? resolveCachePath(scope);
  const lockPath = lockPathFor(cachePath);
  const readFile = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const write = io.writeFile ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const makeDir = io.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const now = io.now ?? Date.now();

  let existing = null;
  try {
    existing = JSON.parse(readFile(lockPath));
  } catch {
    existing = null;
  }

  const verdict = evaluateLock(existing, { now, ttlMs: scope.ttlMs });
  if (verdict.held) {
    return {
      acquired: false,
      path: lockPath,
      holder: verdict.holder,
      reason: verdict.reason,
    };
  }

  const record = {
    pid: process.pid,
    host: scope.machine ?? os.hostname(),
    workflow: scope.workflow ?? null,
    acquiredAt: new Date(now).toISOString(),
    ttlMs: scope.ttlMs ?? DEFAULT_LOCK_TTL_MS,
  };
  makeDir(path.dirname(lockPath));
  write(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  return { acquired: true, path: lockPath, holder: record };
}

export function releaseCacheLock(scope, io = {}) {
  const cachePath = scope.path ?? resolveCachePath(scope);
  const lockPath = lockPathFor(cachePath);
  const remove = io.remove ?? ((p) => rmSync(p, { force: true }));
  remove(lockPath);
  return { path: lockPath };
}

/* ---------------------------------------------------------------------------
 * Fingerprints and invalidation
 * ------------------------------------------------------------------------ */

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 32);
}

function sortedNumbers(values) {
  return [...new Set((values ?? []).map((value) => Number(value)))]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

/**
 * Every observation a cached conclusion about ONE issue or PR depends on.
 *
 * The unobvious members, each of which was chosen because omitting it produces
 * a cache that is confidently wrong rather than merely stale:
 *
 *   dependencyClosure — the transitive `blocked_by` set INCLUDING members that
 *     have since CLOSED, each carried with its state. A closed blocker is the
 *     event that makes a blocked issue READY; a fingerprint over open blockers
 *     only does not move when the last one closes, so the issue stays cached
 *     as `blocked` forever. That is the single highest-cost staleness this
 *     module can produce, because it is silent and self-sustaining.
 *   verdictComments — digest of the `<!-- squad-verdict -->` records. A verdict
 *     can be posted, corrected, or superseded with NO push, so headRefOid does
 *     not move and nothing else in this list changes.
 *   checks — digest of the check rollup. A run can go red or green with no
 *     verdict change and no push.
 *   codeqlConfiguration — the repository's ACTUAL CodeQL configuration, not a
 *     claim that CodeQL is required. If the repo has none, this is null and
 *     stays null; nothing here invents a CodeQL requirement.
 *   holdsVersion / policyVersion — a hold applied or lifted, or a policy edit,
 *     changes what a previously-correct conclusion means.
 */
export function fingerprintInputs(observation = {}) {
  const closure = (observation.dependencyClosure ?? []).map((member) => ({
    number: Number(member?.number),
    state: String(member?.state ?? 'unknown').toLowerCase(),
  }));
  closure.sort((a, b) => a.number - b.number);

  return {
    number: observation.number ?? null,
    state: observation.state ?? null,
    updatedAt: observation.updatedAt ?? null,
    labels: [...(observation.labels ?? [])].map(String).sort(),
    assignees: [...(observation.assignees ?? [])].map(String).sort(),
    sessionClaim: observation.sessionClaim ?? null,
    linkedPullRequests: sortedNumbers(observation.linkedPullRequests),
    dependencyClosure: closure,
    headRefOid: observation.headRefOid ?? null,
    baseRefOid: observation.baseRefOid ?? null,
    isDraft: observation.isDraft ?? null,
    verdictComments: observation.verdictComments ?? null,
    checks: observation.checks ?? null,
    codeqlConfiguration: observation.codeqlConfiguration ?? null,
    holdsVersion: observation.holdsVersion ?? null,
    policyVersion: observation.policyVersion ?? null,
  };
}

export function fingerprint(observation) {
  return digest(fingerprintInputs(observation));
}

/**
 * Which fingerprint members differ between two observations.
 *
 * Reported per-field rather than as one boolean so a round can say WHY it
 * re-inspected an item — "verdict changed at an unchanged head" is a sentence
 * a report can carry; "cache miss" is not.
 */
export function changedInputs(previous, next) {
  const before = fingerprintInputs(previous ?? {});
  const after = fingerprintInputs(next ?? {});
  return Object.keys(after).filter(
    (key) => digest(before[key]) !== digest(after[key]),
  );
}

/**
 * Is a cached conclusion still usable?
 *
 * @returns {{ fresh: boolean, reason: string, changed: string[] }}
 */
export function evaluateEntry(entry, observation) {
  if (entry === null || entry === undefined || typeof entry !== 'object') {
    return { fresh: false, reason: 'no cached entry', changed: [] };
  }
  if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) {
    return {
      fresh: false,
      reason: 'cached entry has no fingerprint',
      changed: [],
    };
  }
  const current = fingerprint(observation);
  if (entry.fingerprint === current) {
    return {
      fresh: true,
      reason: 'every observed input is unchanged',
      changed: [],
    };
  }
  const changed = changedInputs(entry.inputs, fingerprintInputs(observation));
  return {
    fresh: false,
    reason:
      changed.length > 0
        ? `changed: ${changed.join(', ')}`
        : 'fingerprint differs',
    changed,
  };
}

export function cacheKey(kind, number) {
  return `${kind}#${number}`;
}

/**
 * Store a conclusion together with the exact inputs it was derived from.
 *
 * The inputs are stored, not just their hash, so `changedInputs` can name the
 * field that moved. A cache that can only say "something changed" cannot be
 * audited, and an unauditable cache is one nobody can prove is wrong.
 */
export function putEntry(cache, kind, number, observation, conclusion) {
  const inputs = fingerprintInputs(observation);
  return {
    ...cache,
    entries: {
      ...cache.entries,
      [cacheKey(kind, number)]: {
        kind,
        number,
        fingerprint: digest(inputs),
        inputs,
        conclusion,
      },
    },
  };
}

export function getEntry(cache, kind, number) {
  return cache?.entries?.[cacheKey(kind, number)] ?? null;
}

/**
 * Partition a round's observations into what may be carried forward and what
 * must be re-inspected.
 *
 * `slotBlocking` items are ALWAYS re-inspected regardless of fingerprint:
 * loop.md requires deep inspection for anything currently holding a dispatch
 * slot, and an item that has not changed is exactly the item most likely to be
 * wedged.
 */
export function planReuse({ cache, observations, slotBlocking = [] }) {
  const blocking = new Set(sortedNumbers(slotBlocking));
  const reuse = [];
  const inspect = [];

  for (const observation of observations ?? []) {
    const kind = observation.kind ?? 'issue';
    const entry = getEntry(cache, kind, observation.number);
    if (blocking.has(Number(observation.number))) {
      inspect.push({
        kind,
        number: observation.number,
        reason: 'blocking a dispatch slot — always re-inspected',
        changed: [],
      });
      continue;
    }
    const verdict = evaluateEntry(entry, observation);
    if (verdict.fresh) {
      reuse.push({
        kind,
        number: observation.number,
        conclusion: entry.conclusion,
        reason: verdict.reason,
      });
    } else {
      inspect.push({
        kind,
        number: observation.number,
        reason: verdict.reason,
        changed: verdict.changed,
      });
    }
  }

  return { reuse, inspect };
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------ */

export function formatStatus(result) {
  return [
    `path:    ${result.path}`,
    `status:  ${result.status}`,
    `reason:  ${result.reason ?? 'none'}`,
    `entries: ${Object.keys(result.cache.entries ?? {}).length}`,
    `updated: ${result.cache.updatedAt ?? 'never'}`,
  ].join('\n');
}

function parseArgv(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [flag, inline] = token.slice(2).split('=');
    const value =
      inline ?? (argv[index + 1]?.startsWith('--') ? true : argv[++index]);
    options[flag] = value ?? true;
  }
  return options;
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const scope = {
    repo: options.repo ?? 'OlyForge3D/PrintFarmerDesktop',
    workflow: options.workflow ?? 'ralph-round',
    machine: options.machine,
    repoRoot: options['repo-root'],
  };

  if (options.purge) {
    const target = resolveCachePath(scope);
    rmSync(target, { force: true });
    rmSync(lockPathFor(target), { force: true });
    process.stdout.write(`purged ${target}\n`);
    return 0;
  }

  const result = loadCache(scope);
  process.stdout.write(`${formatStatus(result)}\n`);
  return 0;
}

if (
  process.argv[1] &&
  path
    .resolve(process.argv[1])
    .endsWith(path.join('scripts', 'squad-cache.mjs'))
) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`squad-cache: ${error.message}\n`);
      process.exit(2);
    });
}
