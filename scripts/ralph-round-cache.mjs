// Durable, fail-closed snapshot cache for Ralph's one-shot board round.
// It deliberately caches observations only; callers must re-read an item
// immediately before claiming, dispatching, or merging it.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_SCHEMA = 1;
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const INVALIDATING_FIELDS = [
  'dependencies',
  'blockers',
  'state',
  'updatedAt',
  'headRefOid',
  'isDraft',
  'session',
  'claim',
  'linkedPr',
  'baseRef',
  'verdictComment',
  'checks',
  'policy',
  'holds',
];

export function defaultCacheDirectory(env = process.env, os = platform()) {
  if (env.RALPH_CACHE_DIR) return path.resolve(env.RALPH_CACHE_DIR);
  if (os === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
      'PrintFarmerDesktop',
      'ralph-cache',
    );
  }
  return path.join(
    env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'),
    'printfarmer-desktop',
    'ralph-cache',
  );
}

export function cachePath(repo, env = process.env, os = platform()) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('repository must be owner/name');
  return path.join(
    defaultCacheDirectory(env, os),
    `${repo.replace('/', '__')}.json`,
  );
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new Error('cache is not an object');
  if (snapshot.schema !== CACHE_SCHEMA || !Array.isArray(snapshot.items))
    throw new Error('unsupported or malformed cache schema');
  for (const item of snapshot.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isInteger(item.number) ||
      typeof item.kind !== 'string' ||
      !item.fingerprint
    ) {
      throw new Error('cache item is malformed');
    }
  }
  return snapshot;
}

export function readSnapshot(file) {
  try {
    return validateSnapshot(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw new Error(
      `Ralph cache unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function atomicWriteSnapshot(file, snapshot) {
  validateSnapshot(snapshot);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function lockPayload(pid, host, now) {
  return `${JSON.stringify({
    pid,
    host,
    acquiredAt: new Date(now).toISOString(),
    token: randomUUID(),
  })}\n`;
}

function readLock(lock) {
  let contents;
  try {
    contents = readFileSync(lock, 'utf8');
  } catch {
    throw new Error('Ralph cache lock is malformed; refusing unsafe recovery');
  }
  let holder;
  try {
    holder = JSON.parse(contents);
  } catch {
    throw new Error('Ralph cache lock is malformed; refusing unsafe recovery');
  }
  const acquiredAt = new Date(holder?.acquiredAt).getTime();
  if (
    !holder ||
    !Number.isInteger(holder.pid) ||
    holder.pid <= 0 ||
    typeof holder.host !== 'string' ||
    !Number.isFinite(acquiredAt)
  ) {
    throw new Error('Ralph cache lock is malformed; refusing unsafe recovery');
  }
  return { holder: { ...holder, acquiredAt }, contents };
}

function acquireTransition(lock, pid, host, now) {
  const transition = `${lock}.transition`;
  try {
    writeFileSync(transition, lockPayload(pid, host, now), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'Ralph cache lock transition is already in progress; refusing overlapping round',
      );
    }
    throw error;
  }
  // Every mutation first owns this exclusive transition marker, so only its
  // holder can remove and replace an assessed stale lock.
  return () => rmSync(transition, { force: true });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'
      ? true
      : error?.code === 'ESRCH'
        ? false
        : null;
  }
}

export function acquireLock(
  file,
  {
    now = Date.now(),
    pid = process.pid,
    host = hostname(),
    staleMs = LOCK_STALE_MS,
    isAlive = processIsAlive,
  } = {},
) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const payload = lockPayload(pid, host, now);
  const releaseTransition = acquireTransition(lock, pid, host, now);
  try {
    try {
      writeFileSync(lock, payload, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const { holder, contents } = readLock(lock);
      const ownerAlive = holder.host === host ? isAlive(holder.pid) : null;
      const stale = now - holder.acquiredAt >= staleMs;
      if (ownerAlive === true || (ownerAlive === null && !stale)) {
        throw new Error(
          `Ralph cache lock is already held by PID ${holder.pid} on ${holder.host}; refusing overlapping round`,
        );
      }
      try {
        if (readLock(lock).contents !== contents) {
          throw new Error(
            'Ralph cache lock changed during stale recovery; refusing overlapping round',
          );
        }
        rmSync(lock);
        writeFileSync(lock, payload, {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (recoveryError) {
        if (recoveryError && recoveryError.code === 'EEXIST') {
          throw new Error(
            'Ralph cache lock changed during stale recovery; refusing overlapping round',
          );
        }
        throw recoveryError;
      }
    }

    return () => {
      const releaseTransition = acquireTransition(lock, pid, host, now);
      try {
        try {
          if (readFileSync(lock, 'utf8') === payload) rmSync(lock);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } finally {
        releaseTransition();
      }
    };
  } finally {
    releaseTransition();
  }
}

export function fingerprint(item) {
  const fields = [
    item.number,
    item.kind,
    item.state,
    item.updatedAt,
    item.headRefOid,
    item.isDraft,
    item.dependencies,
    item.blockers,
    item.session,
    item.claim,
    item.linkedPr,
    item.baseRef,
    item.verdictComment,
    item.checks,
    item.policy,
    item.holds,
  ];
  return JSON.stringify(canonicalValue(fields));
}

/**
 * Produces the JSON value's canonical form. Snapshot files cross a JSON
 * boundary, so object identity cannot be used to decide that an observation
 * changed. Array order remains meaningful; object-key order does not.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) =>
          value[key] === undefined ? [] : [[key, canonicalValue(value[key])]],
        ),
    );
  }
  return value;
}

function valuesEqual(left, right) {
  return (
    JSON.stringify(canonicalValue(left)) ===
    JSON.stringify(canonicalValue(right))
  );
}

function itemKey(item) {
  return `${item.kind}:${item.number}`;
}

function blockerReferences(value) {
  if (Array.isArray(value)) return value.flatMap(blockerReferences);
  if (typeof value === 'number') return [`*:${value}`];
  if (typeof value === 'string') {
    const match = value.match(/^(?:(.+):)?#?(\d+)$/);
    return match ? [`${match[1] ?? '*'}:${match[2]}`] : [];
  }
  if (value && typeof value === 'object' && Number.isInteger(value.number)) {
    return [
      `${typeof value.kind === 'string' ? value.kind : '*'}:${value.number}`,
    ];
  }
  return [];
}

function referencesChangedBlocker(item, changedBlockers) {
  const references = new Set([
    ...blockerReferences(item.dependencies),
    ...blockerReferences(item.blockers),
  ]);
  return [...references].some((reference) => {
    const [, number] = reference.split(':');
    return changedBlockers.has(reference) || changedBlockers.has(`*:${number}`);
  });
}

export function snapshot(items, observedAt = new Date().toISOString()) {
  if (!Array.isArray(items)) throw new Error('snapshot items must be an array');
  const normalized = items.map((item) => ({
    ...item,
    fingerprint: fingerprint(item),
  }));
  validateSnapshot({ schema: CACHE_SCHEMA, observedAt, items: normalized });
  return { schema: CACHE_SCHEMA, observedAt, items: normalized };
}

export function diffSnapshots(previous, current) {
  const prior = new Map(
    (previous?.items || []).map((item) => [itemKey(item), item]),
  );
  const present = new Map(current.items.map((item) => [itemKey(item), item]));
  const changedBlockers = new Set();
  for (const old of prior.values()) {
    const item = present.get(itemKey(old));
    if (!item || !valuesEqual(old.state, item.state)) {
      changedBlockers.add(itemKey(old));
      changedBlockers.add(`*:${old.number}`);
    }
  }
  return current.items.map((item) => {
    const old = prior.get(itemKey(item));
    const invalidated =
      !old ||
      INVALIDATING_FIELDS.some(
        (field) => !valuesEqual(old[field], item[field]),
      ) ||
      referencesChangedBlocker(item, changedBlockers);
    return {
      kind: item.kind,
      number: item.number,
      action: invalidated ? 'inspect' : 'reuse',
      reason: old
        ? invalidated
          ? 'comparison changed'
          : 'unchanged'
        : 'new item',
    };
  });
}

// Pagination is deliberately strict: an API response must be a complete array
// and callers must explicitly signal whether another page exists.
export async function paginate(fetchPage) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchPage(page);
    if (
      !response ||
      !Array.isArray(response.items) ||
      typeof response.hasNext !== 'boolean'
    ) {
      throw new Error(`malformed or truncated API response at page ${page}`);
    }
    result.push(...response.items);
    if (!response.hasNext) return result;
  }
  throw new Error(
    'pagination exceeded 100 pages; response is treated as truncated',
  );
}

export function compactPlan(items, previous) {
  const current = snapshot(items);
  return {
    schema: CACHE_SCHEMA,
    observedAt: current.observedAt,
    plan: diffSnapshots(previous, current),
    snapshot: current,
  };
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--input') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.repo || !options.input) {
    throw new Error(
      'usage: ralph-round-cache --repo owner/name --input listing.json',
    );
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const rawItems = JSON.parse(readFileSync(options.input, 'utf8'));
  if (!Array.isArray(rawItems))
    throw new Error('input listing must be a complete JSON array');
  const file = cachePath(options.repo, env);
  const release = acquireLock(file);
  try {
    const previous = readSnapshot(file);
    const plan = compactPlan(rawItems, previous);
    atomicWriteSnapshot(file, plan.snapshot);
    process.stdout.write(
      `${JSON.stringify({ schema: plan.schema, observedAt: plan.observedAt, plan: plan.plan })}\n`,
    );
  } finally {
    release();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(
      `Ralph cache failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
