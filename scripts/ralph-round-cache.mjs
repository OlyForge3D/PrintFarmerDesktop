// Durable, fail-closed snapshot cache for Ralph's one-shot board round.
// It deliberately caches observations only; callers must re-read an item
// immediately before claiming, dispatching, or merging it.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_SCHEMA = 1;
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

export function acquireLock(file) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    const descriptor = openSync(lock, 'wx');
    return () => {
      closeSync(descriptor);
      rmSync(lock);
    };
  } catch (error) {
    if (error && error.code === 'EEXIST')
      throw new Error(
        'Ralph cache lock is already held; refusing overlapping round',
      );
    throw error;
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
  return blockerReferences(item.blockers).some((reference) => {
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
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--input') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.repo || !options.input) {
    throw new Error(
      'usage: ralph-round-cache --repo owner/name --input listing.json [--json]',
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
