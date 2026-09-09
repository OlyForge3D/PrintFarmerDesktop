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

export const CACHE_SCHEMA = 2;
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
  if (
    snapshot.schema !== CACHE_SCHEMA ||
    !Array.isArray(snapshot.items) ||
    !['complete', 'pending'].includes(snapshot.completion)
  )
    throw new Error('unsupported or malformed cache schema');
  if (
    snapshot.completion === 'pending' &&
    (typeof snapshot.roundId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        snapshot.roundId,
      ))
  ) {
    throw new Error('pending cache snapshot has no valid round ID');
  }
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

function readLock(lock, description = 'lock') {
  let contents;
  try {
    contents = readFileSync(lock, 'utf8');
  } catch {
    throw new Error(
      `Ralph cache ${description} is malformed; refusing unsafe recovery`,
    );
  }
  let holder;
  try {
    holder = JSON.parse(contents);
  } catch {
    throw new Error(
      `Ralph cache ${description} is malformed; refusing unsafe recovery`,
    );
  }
  const acquiredAt = new Date(holder?.acquiredAt).getTime();
  if (
    !holder ||
    !Number.isInteger(holder.pid) ||
    holder.pid <= 0 ||
    typeof holder.host !== 'string' ||
    !Number.isFinite(acquiredAt) ||
    typeof holder.token !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      holder.token,
    )
  ) {
    throw new Error(
      `Ralph cache ${description} is malformed; refusing unsafe recovery`,
    );
  }
  return { holder: { ...holder, acquiredAt }, contents };
}

function releaseOwnedMarker(marker, payload) {
  try {
    if (readFileSync(marker, 'utf8') === payload) rmSync(marker);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// Puts a displaced object's exact bytes back at its canonical path using an
// exclusive create, never a replace. This is invoked only when a moved-away
// object turned out not to be the stale marker we validated -- i.e. some
// other claimant wrote a fresh, live marker into the race window between our
// validation read and our rename. That marker's ownership record must
// survive, so it is restored rather than left to a caller's cleanup step. If
// the canonical path has since been reclaimed by yet another legitimate
// writer, the exclusive create fails closed with EEXIST and this displaced
// copy is superseded, not orphaned, and safe to drop -- it is never both
// clobbered onto a newer claim and never silently deleted while it was the
// only surviving copy of someone else's claim.
function restoreDisplacedMarker(canonicalPath, contents) {
  try {
    writeFileSync(canonicalPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function acquireTransition(
  lock,
  pid,
  host,
  now,
  staleMs,
  isAlive,
  onStaleRecoveryValidated,
  onStaleHandoffRecoveryValidated,
) {
  const transition = `${lock}.transition`;
  // This is a claimable handoff record, not the legacy mkdir recovery gate.
  // Its payload makes an interrupted handoff safely recoverable.
  const recoveryGate = `${transition}.handoff`;
  const payload = lockPayload(pid, host, now);

  try {
    writeFileSync(recoveryGate, payload, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    const { holder, contents } = readLock(
      recoveryGate,
      'lock transition recovery',
    );
    const ownerAlive = holder.host === host ? isAlive(holder.pid) : null;
    const stale = now - holder.acquiredAt >= staleMs;
    // A recovery handoff is never stolen while it is fresh, even when a local
    // liveness probe says its PID is dead.  That keeps a second claimant from
    // entering while the first claimant is between validation and replacement.
    if (!stale || ownerAlive === true) {
      throw new Error(
        'Ralph cache lock transition recovery is already in progress; refusing overlapping round',
      );
    }

    // The recovery marker has the same durable, verifiable ownership record as
    // a lock.  It is deliberately a file rather than a mkdir-only directory:
    // a crashed owner can be recovered using the same bounded stale/dead-owner
    // rules, rather than wedging all later rounds permanently.
    if (
      readLock(recoveryGate, 'lock transition recovery').contents !== contents
    ) {
      throw new Error(
        'Ralph cache lock transition recovery changed during stale recovery; refusing overlapping round',
      );
    }
    onStaleHandoffRecoveryValidated?.();

    // Atomically move the marker out of the claim path, then verify the moved
    // object. A claimant that observed the old marker but races after a
    // successor created a fresh one will move that fresh marker, detect the
    // different payload here, and restore it verbatim (see
    // restoreDisplacedMarker) before failing closed, instead of letting an
    // unconditional cleanup destroy the successor's only ownership record and
    // reopen the gate to a third claimant. The displaced path itself is
    // always just a temporary working copy -- by the time it is removed
    // below, its content is either genuinely consumed stale residue or has
    // already been written back to (or superseded at) the canonical path, so
    // removing the temporary copy is always safe.
    const displaced = `${recoveryGate}.${pid}.${randomUUID()}.stale`;
    try {
      renameSync(recoveryGate, displaced);
      const displacedContents = readFileSync(displaced, 'utf8');
      if (displacedContents !== contents) {
        restoreDisplacedMarker(recoveryGate, displacedContents);
        throw new Error(
          'Ralph cache lock transition recovery changed during stale recovery; refusing overlapping round',
        );
      }
      writeFileSync(recoveryGate, payload, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (recoveryError) {
      if (
        recoveryError?.code === 'EEXIST' ||
        recoveryError?.code === 'ENOENT'
      ) {
        throw new Error(
          'Ralph cache lock transition recovery changed during stale recovery; refusing overlapping round',
        );
      }
      throw recoveryError;
    } finally {
      rmSync(displaced, { force: true });
    }
  }

  try {
    try {
      writeFileSync(transition, payload, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const { holder, contents } = readLock(transition, 'lock transition');
      const ownerAlive = holder.host === host ? isAlive(holder.pid) : null;
      const stale = now - holder.acquiredAt >= staleMs;
      if (ownerAlive === true || (ownerAlive === null && !stale)) {
        throw new Error(
          'Ralph cache lock transition is already in progress; refusing overlapping round',
        );
      }
      try {
        if (readLock(transition, 'lock transition').contents !== contents) {
          throw new Error(
            'Ralph cache lock transition changed during stale recovery; refusing overlapping round',
          );
        }
        onStaleRecoveryValidated?.();
        rmSync(transition);
        writeFileSync(transition, payload, {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (recoveryError) {
        if (recoveryError && recoveryError.code === 'EEXIST') {
          throw new Error(
            'Ralph cache lock transition changed during stale recovery; refusing overlapping round',
          );
        }
        throw recoveryError;
      }
    }
    return () => {
      releaseOwnedMarker(transition, payload);
      releaseOwnedMarker(recoveryGate, payload);
    };
  } catch (error) {
    releaseOwnedMarker(recoveryGate, payload);
    throw error;
  }
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
    releaseNow = () => Date.now(),
    pid = process.pid,
    host = hostname(),
    staleMs = LOCK_STALE_MS,
    isAlive = processIsAlive,
    onStaleTransitionRecoveryValidated,
    onStaleHandoffRecoveryValidated,
  } = {},
) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const payload = lockPayload(pid, host, now);
  const releaseTransition = acquireTransition(
    lock,
    pid,
    host,
    now,
    staleMs,
    isAlive,
    onStaleTransitionRecoveryValidated,
    onStaleHandoffRecoveryValidated,
  );
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
      const releaseTransition = acquireTransition(
        lock,
        pid,
        host,
        releaseNow(),
        staleMs,
        isAlive,
        onStaleTransitionRecoveryValidated,
        onStaleHandoffRecoveryValidated,
      );
      try {
        releaseOwnedMarker(lock, payload);
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
  validateSnapshot({
    schema: CACHE_SCHEMA,
    observedAt,
    completion: 'complete',
    items: normalized,
  });
  return {
    schema: CACHE_SCHEMA,
    observedAt,
    completion: 'complete',
    items: normalized,
  };
}

export function diffSnapshots(previous, current) {
  const previousCompleted = previous?.completion === 'complete';
  const prior = new Map(
    (previousCompleted ? previous.items : []).map((item) => [
      itemKey(item),
      item,
    ]),
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
  for (const item of present.values()) {
    const old = prior.get(itemKey(item));
    if (!old || !valuesEqual(old.state, item.state)) {
      changedBlockers.add(itemKey(item));
      changedBlockers.add(`*:${item.number}`);
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
        : previous?.completion === 'pending'
          ? 'previous round incomplete'
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
    if (
      argument === '--repo' ||
      argument === '--input' ||
      argument === '--commit'
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (
    !options.repo ||
    (!options.input && !options.commit) ||
    (options.input && options.commit)
  ) {
    throw new Error(
      'usage: ralph-round-cache --repo owner/name (--input listing.json | --commit round-id)',
    );
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const file = cachePath(options.repo, env);
  const release = acquireLock(file);
  try {
    if (options.commit) {
      const pending = readSnapshot(file);
      if (
        !pending ||
        pending.completion !== 'pending' ||
        pending.roundId !== options.commit
      ) {
        throw new Error(
          'round commit does not match the current pending snapshot',
        );
      }
      atomicWriteSnapshot(file, { ...pending, completion: 'complete' });
      process.stdout.write(
        `${JSON.stringify({ schema: CACHE_SCHEMA, roundId: options.commit, committed: true })}\n`,
      );
      return;
    }

    const rawItems = JSON.parse(readFileSync(options.input, 'utf8'));
    if (!Array.isArray(rawItems))
      throw new Error('input listing must be a complete JSON array');
    const previous = readSnapshot(file);
    const plan = compactPlan(rawItems, previous);
    const roundId = randomUUID();
    atomicWriteSnapshot(file, {
      ...plan.snapshot,
      completion: 'pending',
      roundId,
    });
    process.stdout.write(
      `${JSON.stringify({ schema: plan.schema, observedAt: plan.observedAt, roundId, plan: plan.plan })}\n`,
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
