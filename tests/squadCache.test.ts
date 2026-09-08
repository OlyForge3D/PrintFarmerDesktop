// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  CACHE_DIR_ENV,
  CACHE_SCHEMA_VERSION,
  DEFAULT_LOCK_TTL_MS,
  FRESH_ONLY_ACTIONS,
  STATUS_CORRUPT,
  STATUS_MISSING,
  STATUS_OK,
  STATUS_SCHEMA_MISMATCH,
  STATUS_SCOPE_MISMATCH,
  acquireCacheLock,
  changedInputs,
  emptyCache,
  evaluateEntry,
  evaluateLock,
  fingerprint,
  getEntry,
  isInsideRepository,
  loadCache,
  lockPathFor,
  planReuse,
  putEntry,
  releaseCacheLock,
  requiresFreshCheck,
  resolveCacheRoot,
  resolveCachePath,
  saveCache,
  validateCacheDocument,
} from '../scripts/squad-cache.mjs';

const scratch: string[] = [];

function scratchDir(): string {
  const directory = mkdtempSync(path.join(process.cwd(), '.pf-cache-test-'));
  scratch.push(directory);
  return directory;
}

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop() as string, { recursive: true, force: true });
  }
});

const SCOPE = {
  repo: 'OlyForge3D/PrintFarmerDesktop',
  machine: 'runner-a',
  workflow: 'ralph-round',
};

function observation(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'issue',
    number: 42,
    state: 'open',
    updatedAt: '2026-09-01T00:00:00Z',
    labels: ['squad:bishop', 'priority:p1'],
    assignees: [],
    sessionClaim: null,
    linkedPullRequests: [],
    dependencyClosure: [{ number: 12, state: 'open' }],
    holdsVersion: 'holds-v1',
    policyVersion: 'policy-v1',
    ...overrides,
  };
}

describe('the store outlives the worktree that wrote it', () => {
  it('places the root outside any checkout, per platform', () => {
    expect(
      resolveCacheRoot({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
        homedir: 'C:\\Users\\x',
      }),
    ).toBe(
      path.resolve(
        'C:\\Users\\x\\AppData\\Local',
        'PrintFarmerDesktop',
        'squad-cache',
      ),
    );

    expect(
      resolveCacheRoot({ platform: 'darwin', env: {}, homedir: '/Users/x' }),
    ).toBe(
      path.resolve('/Users/x/Library/Caches/PrintFarmerDesktop/squad-cache'),
    );

    expect(
      resolveCacheRoot({ platform: 'linux', env: {}, homedir: '/home/x' }),
    ).toBe(path.resolve('/home/x/.cache/printfarmerdesktop/squad-cache'));
  });

  it('honours an explicit override ahead of every platform default', () => {
    const root = scratchDir();
    expect(
      resolveCacheRoot({ platform: 'win32', env: { [CACHE_DIR_ENV]: root } }),
    ).toBe(path.resolve(root));
  });

  it('refuses a root inside the repository — that is the whole defect returning', () => {
    const repoRoot = scratchDir();
    expect(() =>
      resolveCachePath({
        ...SCOPE,
        root: path.join(repoRoot, '.squad'),
        repoRoot,
      }),
    ).toThrow(/inside the repository/);
  });

  it('does not mistake a sibling path for a child of the repository', () => {
    expect(isInsideRepository('/repo-cache', '/repo')).toBe(false);
    expect(isInsideRepository('/repo/.squad/x', '/repo')).toBe(true);
  });

  it('survives the worktree: a second, unrelated checkout reads the same entries', () => {
    const root = scratchDir();
    const worktreeA = scratchDir();
    const worktreeB = scratchDir();
    const scope = { ...SCOPE, root, repoRoot: worktreeA };

    const written = putEntry(emptyCache(scope), 'issue', 42, observation(), {
      bucket: 'blocked',
      blockers: [12],
    });
    saveCache(scope, written);

    // A different worktree, same machine, same repo, same workflow.
    const reread = loadCache({ ...SCOPE, root, repoRoot: worktreeB });
    expect(reread.status).toBe(STATUS_OK);
    expect(getEntry(reread.cache, 'issue', 42)?.conclusion).toEqual({
      bucket: 'blocked',
      blockers: [12],
    });
  });

  it('scopes by repo, machine and workflow so conclusions do not leak between them', () => {
    const root = scratchDir();
    const a = resolveCachePath({ ...SCOPE, root });
    const b = resolveCachePath({ ...SCOPE, machine: 'runner-b', root });
    const c = resolveCachePath({ ...SCOPE, workflow: 'reaper', root });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('a corrupt cache is an empty cache, never an error and never a lie', () => {
  it('reports missing without throwing', () => {
    const root = scratchDir();
    const result = loadCache({ ...SCOPE, root });
    expect(result.status).toBe(STATUS_MISSING);
    expect(result.cache.entries).toEqual({});
  });

  it('reports corrupt for unparseable bytes and still returns a usable cache', () => {
    const root = scratchDir();
    const target = resolveCachePath({ ...SCOPE, root });
    saveCache({ ...SCOPE, root }, emptyCache(SCOPE));
    writeFileSync(target, '{"schemaVersion": 2, "entries": {', 'utf8');

    const result = loadCache({ ...SCOPE, root });
    expect(result.status).toBe(STATUS_CORRUPT);
    expect(result.reason).toMatch(/unparseable/);
    expect(result.cache.entries).toEqual({});
  });

  it('reports schema-mismatch rather than guessing at an older shape', () => {
    const root = scratchDir();
    const target = resolveCachePath({ ...SCOPE, root });
    saveCache({ ...SCOPE, root }, emptyCache(SCOPE));
    writeFileSync(
      target,
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION - 1, entries: {} }),
      'utf8',
    );
    expect(loadCache({ ...SCOPE, root }).status).toBe(STATUS_SCHEMA_MISMATCH);
  });

  it('reports scope-mismatch when the document describes another repo', () => {
    const root = scratchDir();
    const target = resolveCachePath({ ...SCOPE, root });
    saveCache({ ...SCOPE, root }, emptyCache(SCOPE));
    writeFileSync(
      target,
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        repo: 'OlyForge3D/PrintFarmer',
        machine: 'runner-a',
        workflow: 'ralph-round',
        entries: {},
      }),
      'utf8',
    );
    expect(loadCache({ ...SCOPE, root }).status).toBe(STATUS_SCOPE_MISMATCH);
  });

  it('rejects an entry with no fingerprint rather than trusting its conclusion', () => {
    const verdict = validateCacheDocument(
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        entries: {
          'issue#1': { kind: 'issue', number: 1, conclusion: 'ready' },
        },
      },
      undefined,
    );
    expect(verdict.status).toBe(STATUS_CORRUPT);
    expect(verdict.reason).toMatch(/fingerprint/);
  });

  it('refuses to WRITE an invalid document, so corruption cannot originate here', () => {
    const root = scratchDir();
    expect(() =>
      saveCache({ ...SCOPE, root }, { entries: { bad: { kind: 'issue' } } }),
    ).toThrow(/refusing to write/);
  });
});

describe('writes are atomic and leave no debris', () => {
  it('leaves only the target file behind on success', () => {
    const root = scratchDir();
    const scope = { ...SCOPE, root };
    saveCache(
      scope,
      putEntry(emptyCache(scope), 'issue', 7, observation(), 'ready'),
    );
    const directory = path.dirname(resolveCachePath(scope));
    expect(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('never truncates the previous document when the write fails midway', () => {
    const root = scratchDir();
    const scope = { ...SCOPE, root };
    saveCache(
      scope,
      putEntry(emptyCache(scope), 'issue', 7, observation(), 'ready'),
    );
    const target = resolveCachePath(scope);
    const before = readFileSync(target, 'utf8');

    expect(() =>
      saveCache(scope, emptyCache(scope), {
        rename: () => {
          throw new Error('simulated rename failure');
        },
      }),
    ).toThrow(/simulated rename failure/);

    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(
      readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('the overlap guard serialises concurrent rounds', () => {
  it('refuses a second acquisition while a lease is live', () => {
    const root = scratchDir();
    const scope = { ...SCOPE, root };
    const first = acquireCacheLock(scope);
    expect(first.acquired).toBe(true);

    const second = acquireCacheLock(scope);
    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/held by pid/);

    releaseCacheLock(scope);
    expect(existsSync(lockPathFor(resolveCachePath(scope)))).toBe(false);
    expect(acquireCacheLock(scope).acquired).toBe(true);
  });

  it('reclaims an expired lease rather than wedging forever', () => {
    const acquiredAt = new Date(0).toISOString();
    const live = evaluateLock(
      { pid: 1, host: 'h', acquiredAt, ttlMs: DEFAULT_LOCK_TTL_MS },
      { now: 1000 },
    );
    expect(live.held).toBe(true);

    const expired = evaluateLock(
      { pid: 1, host: 'h', acquiredAt, ttlMs: 500 },
      { now: 1000 },
    );
    expect(expired.held).toBe(false);
    expect(expired.reason).toMatch(/lease expired/);
  });

  it('treats an unreadable lock as reclaimable, not as a permanent wedge', () => {
    expect(evaluateLock(null, { now: 1000 }).held).toBe(false);
    expect(evaluateLock({ pid: 1 }, { now: 1000 }).held).toBe(false);
  });
});

describe('invalidation is by fingerprint, and every input is load-bearing', () => {
  it('carries a conclusion forward when nothing observed has moved — the no-op round', () => {
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      observation(),
      'blocked',
    );
    const verdict = evaluateEntry(getEntry(cache, 'issue', 42), observation());
    expect(verdict.fresh).toBe(true);
    expect(verdict.reason).toMatch(/unchanged/);
  });

  it('invalidates when a BLOCKER CLOSES, though nothing else about the issue changed', () => {
    // The highest-cost staleness this module can produce: a closed blocker is
    // exactly what makes a blocked issue READY, and a fingerprint over open
    // blockers only never moves when the last one closes.
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      observation(),
      'blocked',
    );
    const nowUnblocked = observation({
      dependencyClosure: [{ number: 12, state: 'closed' }],
    });

    const verdict = evaluateEntry(getEntry(cache, 'issue', 42), nowUnblocked);
    expect(verdict.fresh).toBe(false);
    expect(verdict.changed).toContain('dependencyClosure');
  });

  it('invalidates when the dependency closure gains a member', () => {
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      observation(),
      'ready',
    );
    const verdict = evaluateEntry(
      getEntry(cache, 'issue', 42),
      observation({
        dependencyClosure: [
          { number: 12, state: 'open' },
          { number: 13, state: 'open' },
        ],
      }),
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.changed).toEqual(['dependencyClosure']);
  });

  it('invalidates on a VERDICT change alone, at an unchanged head and unchanged checks', () => {
    const base = {
      kind: 'pr',
      number: 700,
      headRefOid: 'a'.repeat(40),
      baseRefOid: 'b'.repeat(40),
      isDraft: false,
      checks: 'checks-digest-1',
      verdictComments: 'verdict-digest-1',
    };
    const cache = putEntry(emptyCache(SCOPE), 'pr', 700, base, 'mergeable');

    const verdict = evaluateEntry(getEntry(cache, 'pr', 700), {
      ...base,
      verdictComments: 'verdict-digest-2',
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.changed).toEqual(['verdictComments']);
  });

  it('invalidates on a CHECKS change alone, at an unchanged head and unchanged verdict', () => {
    const base = {
      kind: 'pr',
      number: 700,
      headRefOid: 'a'.repeat(40),
      checks: 'checks-digest-1',
      verdictComments: 'verdict-digest-1',
    };
    const cache = putEntry(emptyCache(SCOPE), 'pr', 700, base, 'mergeable');
    const verdict = evaluateEntry(getEntry(cache, 'pr', 700), {
      ...base,
      checks: 'checks-digest-2',
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.changed).toEqual(['checks']);
  });

  it('invalidates on a hold or a policy version change', () => {
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      observation(),
      'ready',
    );
    expect(
      evaluateEntry(
        getEntry(cache, 'issue', 42),
        observation({ holdsVersion: 'holds-v2' }),
      ).changed,
    ).toEqual(['holdsVersion']);
    expect(
      evaluateEntry(
        getEntry(cache, 'issue', 42),
        observation({ policyVersion: 'policy-v2' }),
      ).changed,
    ).toEqual(['policyVersion']);
  });

  it('invalidates on the CodeQL configuration, and invents no requirement when there is none', () => {
    const withoutCodeql = observation({ codeqlConfiguration: null });
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      withoutCodeql,
      'ready',
    );
    expect(
      evaluateEntry(getEntry(cache, 'issue', 42), withoutCodeql).fresh,
    ).toBe(true);
    expect(
      evaluateEntry(
        getEntry(cache, 'issue', 42),
        observation({ codeqlConfiguration: 'codeql-config-digest' }),
      ).changed,
    ).toEqual(['codeqlConfiguration']);
  });

  it('names the field that moved, so a round can report WHY it re-inspected', () => {
    expect(
      changedInputs(observation(), observation({ labels: ['squad:hicks'] })),
    ).toEqual(['labels']);
  });

  it('never reuses an entry with no cached record at all', () => {
    expect(evaluateEntry(null, observation()).fresh).toBe(false);
    expect(evaluateEntry(undefined, observation()).fresh).toBe(false);
  });

  it('produces a stable fingerprint regardless of label or assignee ordering', () => {
    expect(fingerprint(observation({ labels: ['a', 'b'] }))).toBe(
      fingerprint(observation({ labels: ['b', 'a'] })),
    );
  });
});

describe('planReuse partitions a round', () => {
  it('reuses everything unchanged and re-inspects what moved', () => {
    let cache = emptyCache(SCOPE);
    cache = putEntry(cache, 'issue', 42, observation(), 'blocked');
    cache = putEntry(cache, 'issue', 43, observation({ number: 43 }), 'ready');

    const { reuse, inspect } = planReuse({
      cache,
      observations: [
        observation(),
        observation({ number: 43, updatedAt: '2026-09-02T00:00:00Z' }),
      ],
    });

    expect(reuse.map((entry) => entry.number)).toEqual([42]);
    expect(inspect.map((entry) => entry.number)).toEqual([43]);
    expect(inspect[0]?.changed).toContain('updatedAt');
  });

  it('always re-inspects an item blocking a dispatch slot, however fresh it looks', () => {
    const cache = putEntry(
      emptyCache(SCOPE),
      'issue',
      42,
      observation(),
      'blocked',
    );
    const { reuse, inspect } = planReuse({
      cache,
      observations: [observation()],
      slotBlocking: [42],
    });
    expect(reuse).toEqual([]);
    expect(inspect[0]?.reason).toMatch(/blocking a dispatch slot/);
  });
});

describe('the cache is never authorization', () => {
  it('demands a fresh check for a claim and for a merge', () => {
    expect(requiresFreshCheck('claim')).toBe(true);
    expect(requiresFreshCheck('merge')).toBe(true);
    expect(FRESH_ONLY_ACTIONS).toEqual(['claim', 'merge']);
  });

  it('permits reuse for ordinary read-only work', () => {
    expect(requiresFreshCheck('triage')).toBe(false);
    expect(requiresFreshCheck('report')).toBe(false);
  });

  it('exposes no parameter that could relax it', () => {
    // The single declared parameter is the action name. There is no cache,
    // entry, or options argument, so no call site can pass "but this one is
    // recent" — the seam for a bypass does not exist.
    expect(requiresFreshCheck.length).toBe(1);
    const loose = requiresFreshCheck as unknown as (
      ...args: unknown[]
    ) => boolean;
    expect(loose('merge', { recent: true })).toBe(true);
  });
});
