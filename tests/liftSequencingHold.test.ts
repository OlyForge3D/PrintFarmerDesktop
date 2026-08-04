// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HOLD_LABEL_PREFIX,
  evaluateHoldsToLift,
  fetchPullRequest,
  findMergedPullRequestsCarryingHolds,
  formatLift,
  removeLabel,
} from '../scripts/lift-hold-on-close.mjs';
import {
  declaredClassOf,
  evaluateWorkflowClassification,
  readWorkflows,
  triggersOf,
} from '../scripts/check-merge-queue-contexts.mjs';

/**
 * A stub `fetch`. Cast the way tests/sequencingHold.test.ts casts its own:
 * `Response` has fourteen members these stubs do not implement, and structural
 * typing rejects the partial. The cast is confined to this helper so no
 * individual test carries one.
 */
function respondWith(response: unknown): typeof fetch {
  return (() => Promise.resolve(response)) as typeof fetch;
}

/**
 * Lines of a column-0 mapping up to the next column-0 key.
 *
 * Deliberately textual, matching tests/ciWorkflowTriggers.test.ts: the
 * repository ships no YAML parser and this change does not add one. Throws
 * rather than returning [] when the key is absent, so a renamed block fails by
 * name instead of by an empty set that reads as agreement.
 */
function topLevelSection(workflow: string, key: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) throw new Error(`workflow has no top-level "${key}:" block`);
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^\S/.test(line));
  return end < 0 ? body : body.slice(0, end);
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const workflow = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'lift-sequencing-hold.yml'),
  'utf8',
);

const repository = { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' };

/**
 * The measured failure this file exists for.
 *
 * `hold:sequenced` was removed from #154, #169, #172 and #174 in an eight-second
 * manual sweep at 07:47Z. The sweep was correct: #175 was open at the time and
 * was rightly left alone. #175 then merged at 13:21:27Z — five and a half hours
 * later — and carried the label afterwards.
 *
 * So the sweep did not fail; it expired. Every assertion here is pushed from
 * both sides, because a lifter that always lifts is as useless as one that never
 * does, and only the pair distinguishes a rule from a constant.
 */
describe('evaluateHoldsToLift', () => {
  it('lifts a hold label from a merged pull request', () => {
    const result = evaluateHoldsToLift({
      labels: ['squad', 'hold:sequenced'],
      merged: true,
    });
    expect(result.lift).toEqual(['hold:sequenced']);
  });

  it('lifts nothing from a pull request that carries no hold', () => {
    // The negative half on the label. Without it the rule could return every
    // label it was given and the assertion above would still pass.
    const result = evaluateHoldsToLift({
      labels: ['squad', 'documentation', 'squad:ripley'],
      merged: true,
    });
    expect(result.lift).toEqual([]);
    expect(result.held).toEqual([]);
  });

  it('leaves the hold alone when the pull request was closed without merging', () => {
    // The negative half on the flag, and the one that matters. A closed pull
    // request is reopenable, so its hold may still be live. Stripping it here
    // would produce exactly the state this mechanism exists to prevent — a pull
    // request that is held with nothing saying so — introduced by the
    // automation meant to fix it.
    const result = evaluateHoldsToLift({
      labels: ['hold:sequenced'],
      merged: false,
    });
    expect(result.lift).toEqual([]);
    expect(result.held).toEqual(['hold:sequenced']);
    expect(result.reason).toContain('reopenable');
  });

  it('covers the whole hold: namespace, not one label', () => {
    // Matches check-sequencing-hold.mjs, which holds on the prefix so a future
    // `hold:decision` works the day it is created. A lifter that knew only
    // `hold:sequenced` would leave the new one applied forever, and the two
    // halves would disagree about what a hold is.
    const result = evaluateHoldsToLift({
      labels: ['hold:decision', 'hold:release'],
      merged: true,
    });
    expect(result.lift).toEqual(['hold:decision', 'hold:release']);
    expect(HOLD_LABEL_PREFIX).toBe('hold:');
  });

  it('refuses a non-boolean merge flag rather than defaulting it', () => {
    // Both defaults are wrong in opposite directions: defaulting false leaves a
    // stale label, defaulting true strips a live hold. An unreadable payload
    // must not be able to reach either outcome.
    expect(() =>
      evaluateHoldsToLift({ labels: ['hold:sequenced'], merged: undefined }),
    ).toThrow(/merged must be a boolean/);
  });

  it('refuses a labels value that cannot hold a label', () => {
    // Cast because the point of the test is the runtime guard: a JavaScript
    // caller can pass this, and the types are not present at the workflow
    // boundary where the payload actually arrives.
    expect(() =>
      evaluateHoldsToLift({
        labels: undefined as unknown as readonly string[],
        merged: true,
      }),
    ).toThrow(/labels must be an array/);
  });

  it('accepts label objects as well as strings, matching the REST payload', () => {
    const result = evaluateHoldsToLift({
      labels: [{ name: 'hold:sequenced' }, { name: 'squad' }],
      merged: true,
    });
    expect(result.lift).toEqual(['hold:sequenced']);
  });
});

describe('formatLift', () => {
  it('tells the reader where the record went, because removing a label erases it', () => {
    // Measured: after `unlabeled`, the label is absent from the label list and
    // from label search. Only the events timeline retains it. A message that did
    // not say so would leave the next reader concluding the hold never existed.
    const text = formatLift(
      evaluateHoldsToLift({ labels: ['hold:sequenced'], merged: true }),
      175,
      repository,
    );
    expect(text).toContain('issues/175/events');
    expect(text).toContain('housekeeping, not a decision');
  });

  it('says what is still applied when it lifts nothing, rather than reporting silence', () => {
    const text = formatLift(
      evaluateHoldsToLift({ labels: ['hold:sequenced'], merged: false }),
      162,
      repository,
    );
    expect(text).toContain('Still carrying: hold:sequenced');
  });
});

describe('fetchPullRequest', () => {
  const ok = (payload: unknown) =>
    respondWith({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(payload),
    });

  it('reads labels and the merge flag', async () => {
    const result = await fetchPullRequest({
      ...repository,
      prNumber: 175,
      token: 't',
      fetchImpl: ok({ labels: [{ name: 'hold:sequenced' }], merged: true }),
    });
    expect(result).toEqual({ labels: ['hold:sequenced'], merged: true });
  });

  it('refuses a payload with no merge flag instead of assuming one', async () => {
    await expect(
      fetchPullRequest({
        ...repository,
        prNumber: 175,
        token: 't',
        fetchImpl: ok({ labels: [] }),
      }),
    ).rejects.toThrow(/no boolean `merged` field/);
  });

  it('refuses an unreadable response instead of reporting nothing to lift', async () => {
    await expect(
      fetchPullRequest({
        ...repository,
        prNumber: 175,
        token: 't',
        fetchImpl: respondWith({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        }),
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('removeLabel', () => {
  it('treats 404 as success, because the desired end state is that the label is gone', async () => {
    // A re-run, or a race with a human doing it by hand, must not fail the job
    // for finding the work already done.
    await expect(
      removeLabel({
        ...repository,
        prNumber: 175,
        label: 'hold:sequenced',
        token: 't',
        fetchImpl: respondWith({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        }),
      }),
    ).resolves.toBe(false);
  });

  it('fails on any other error, so a permission problem is not read as a lift', async () => {
    await expect(
      removeLabel({
        ...repository,
        prNumber: 175,
        label: 'hold:sequenced',
        token: 't',
        fetchImpl: respondWith({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        }),
      }),
    ).rejects.toThrow(/403/);
  });

  it('percent-encodes the label, which contains a colon', async () => {
    let seen = '';
    await removeLabel({
      ...repository,
      prNumber: 175,
      label: 'hold:sequenced',
      token: 't',
      fetchImpl: ((url: string) => {
        seen = url;
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: 'No Content',
        } as unknown as Response);
      }) as unknown as typeof fetch,
    });
    expect(seen).toContain('hold%3Asequenced');
  });
});

describe('findMergedPullRequestsCarryingHolds', () => {
  // The cohort that predates the workflow. An event-triggered check evaluates
  // transitions, not states, so a pull request that merged before the check
  // was deployed emits no further event and is never evaluated. A missing
  // check run is not a failing check, so nothing surfaces it.
  it('returns the merged pull requests the trigger can never reach', async () => {
    const numbers = await findMergedPullRequestsCarryingHolds({
      ...repository,
      token: 't',
      fetchImpl: respondWith({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ items: [{ number: 175 }] }),
      }),
    });
    expect(numbers).toEqual([175]);
  });

  it('refuses an unreadable search payload rather than reporting nothing to backfill', async () => {
    // "Nothing to backfill" and "could not tell" must not be the same result.
    await expect(
      findMergedPullRequestsCarryingHolds({
        ...repository,
        token: 't',
        fetchImpl: respondWith({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ message: 'rate limited' }),
        }),
      }),
    ).rejects.toThrow(/nothing to backfill/);
  });

  it('fails on a non-ok search response', async () => {
    await expect(
      findMergedPullRequestsCarryingHolds({
        ...repository,
        token: 't',
        fetchImpl: respondWith({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        }),
      }),
    ).rejects.toThrow(/403/);
  });

  it('searches for merged pull requests, not open ones', async () => {
    // The defect being counted is holds surviving INTO merged, so a filter of
    // is:open excludes the entire population by construction. That is not a
    // hypothetical: the same count is 0 with --state open and 5 with all.
    let seen = '';
    await findMergedPullRequestsCarryingHolds({
      ...repository,
      token: 't',
      fetchImpl: ((url: string) => {
        seen = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ items: [] }),
        } as unknown as Response);
      }) as unknown as typeof fetch,
    });
    expect(decodeURIComponent(seen)).toContain('is:merged');
    expect(decodeURIComponent(seen)).not.toContain('is:open');
  });
});

describe('the workflow can actually see a merge', () => {
  // Parsed, not substring-matched. The first version of this block asserted
  // `expect(workflow).not.toContain('merge_group')` and failed against a
  // workflow that is correct — the header comment explains why it does not
  // subscribe, so the string is present as prose. A file-wide substring cannot
  // tell a subscription from a sentence about one, and the same trap would have
  // hidden in the opposite direction: deleting the `on:` block while leaving the
  // comment would have kept that assertion green.
  //
  // Reusing the guard's own extractor rather than writing a second one, so this
  // test and scripts/check-merge-queue-contexts.mjs cannot disagree about what
  // a trigger is.
  const triggers = triggersOf(workflow, 'lift-sequencing-hold.yml');

  it('subscribes to pull_request, and to nothing else', () => {
    // A hold becomes permanently false at the moment of merge. There is no
    // `merged` event type — GitHub reports a merge as `closed` with
    // `merged: true` — so `closed` is the subscription and the flag is the
    // discriminator.
    expect(triggers).toEqual(['pull_request']);
    expect(topLevelSection(workflow, 'on')).toContain('    types: [closed]');
  });

  it('extracts a non-empty trigger list, so the assertion above cannot pass vacuously', () => {
    // Negative control on the extractor. Without it, a parser that returned []
    // for a file it could not read would satisfy "does not subscribe to
    // merge_group" for every workflow in the repository.
    expect(triggers.length).toBeGreaterThan(0);
  });

  it('declares itself advisory, so it can never become a required context', () => {
    // It runs only on `closed`, so its check run does not exist on an open pull
    // request. Requiring it would leave every pull request waiting for a context
    // that cannot appear until after the merge it is blocking.
    expect(declaredClassOf(workflow, 'lift-sequencing-hold.yml')).toBe(
      'advisory',
    );
  });

  it('passes the repository-wide classification guard', () => {
    // The guard enumerates the workflow directory, so this also proves the new
    // file did not break the classification of any existing one.
    expect(
      evaluateWorkflowClassification(
        readWorkflows(path.join(repositoryRoot, '.github', 'workflows')),
      ),
    ).toEqual([]);
  });

  it('requests pull-requests write and grants no contents scope', () => {
    // It checks out no code and needs none, so nothing from the merged branch
    // can execute under a token that can write labels. Read from the
    // permissions block rather than the whole file, for the reason above.
    expect(
      topLevelSection(workflow, 'permissions').filter(
        (line) => line.trim() !== '',
      ),
    ).toEqual(['  pull-requests: write']);
  });

  it('declares no job-level `if:`, keeping the merge decision in a tested rule', () => {
    // The merged/closed distinction is the whole safety property here, and a
    // conditional in YAML cannot be pushed from both sides by a unit test.
    expect(workflow).not.toMatch(/^ {4}if:/m);
  });
});
