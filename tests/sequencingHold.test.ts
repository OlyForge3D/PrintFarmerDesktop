import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENTED_HOLDS,
  HOLD_LABEL_PREFIX,
  evaluateSequencingHold,
  fetchPullRequestLabels,
  formatHold,
} from '../scripts/check-sequencing-hold.mjs';

type LabelInput = readonly (string | { name?: unknown })[];

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * #182: a deliberately held pull request and a merely stale one produced the
 * same API response, so an automated handoff offered to rebase away a hold.
 * Every assertion below is pushed from both sides — a rule that only ever says
 * "held" is as useless as one that only ever says "clear", and only the pair
 * distinguishes a control from a constant.
 */
describe('evaluateSequencingHold', () => {
  it('reports a hold when the sequencing label is present', () => {
    const result = evaluateSequencingHold(['hold:sequenced']);
    expect(result.held).toBe(true);
    expect(result.holds.map((hold) => hold.label)).toEqual(['hold:sequenced']);
  });

  it('reports no hold when it is absent', () => {
    // The negative half. Without it the rule could return `held: true`
    // unconditionally and the assertion above would still pass.
    const result = evaluateSequencingHold(['bug', 'squad:hicks', 'ci']);
    expect(result.held).toBe(false);
    expect(result.holds).toEqual([]);
  });

  it('reports no hold for an empty label set', () => {
    expect(evaluateSequencingHold([]).held).toBe(false);
  });

  it('accepts the object form the REST API returns', () => {
    // resolveRepository-style shape tolerance: `labels` from the REST payload
    // is an array of objects, but a caller holding names has an array of
    // strings. Both are real inputs, so both are covered.
    const result = evaluateSequencingHold([
      { name: 'squad:hicks' },
      { name: 'hold:sequenced' },
    ]);
    expect(result.held).toBe(true);
  });

  it('holds on an undocumented label in the hold namespace', () => {
    // Failing open on an unrecognised `hold:*` would make the namespace a
    // footgun: creating `hold:release` would silently do nothing, and the
    // person creating it would have no way to discover that.
    const result = evaluateSequencingHold(['hold:release']);
    expect(result.held).toBe(true);
    expect(result.holds[0]?.reason).toContain('Undocumented');
  });

  it('does not match a label that merely contains the prefix', () => {
    // `withhold:x` and `on-hold` are not holds. Guards the difference between
    // startsWith and includes, which is invisible until someone creates a
    // label that trips it.
    expect(evaluateSequencingHold(['withhold:sequenced']).held).toBe(false);
    expect(evaluateSequencingHold(['on-hold']).held).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(evaluateSequencingHold(['Hold:Sequenced']).held).toBe(true);
  });

  it('refuses a non-array rather than reporting "not held"', () => {
    // The #182 defect in miniature: a value that CANNOT carry a label must not
    // produce the same answer as one that carries none. `undefined` is what a
    // missing field deserialises to, so this is the realistic failure.
    expect(() =>
      evaluateSequencingHold(undefined as unknown as LabelInput),
    ).toThrow(/must be an array/);
    expect(() => evaluateSequencingHold(null as unknown as LabelInput)).toThrow(
      /must be an array/,
    );
  });

  it('refuses a label entry with no name', () => {
    expect(() =>
      evaluateSequencingHold([{ colour: 'red' }] as unknown as LabelInput),
    ).toThrow(/no name/);
  });

  it('documents the label the repository actually uses', () => {
    // Pins the contract to the live label rather than to a paraphrase of it.
    expect(Object.keys(DOCUMENTED_HOLDS)).toContain('hold:sequenced');
    expect(HOLD_LABEL_PREFIX).toBe('hold:');
  });
});

describe('formatHold', () => {
  const message = formatHold(
    evaluateSequencingHold(['hold:sequenced']).holds,
    175,
  );

  it('states that the red is deliberate', () => {
    // The text IS the control. A check that only went red would move #182's
    // ambiguity one surface along: a held pull request would look like a broken
    // one, and the helpful response to a broken pull request is to repair it.
    expect(message).toContain('deliberately held');
    expect(message).toContain('RED on purpose');
  });

  it('names the actions that must not be taken', () => {
    // These four verbs are exactly what the handoff in #182 proposed.
    for (const action of ['rebase', 'sync', 'merge', 'enqueue']) {
      expect(message.toLowerCase()).toContain(action);
    }
  });

  it('separates held from broken and from unfinished', () => {
    expect(message).toContain('Held is not the same as broken');
    expect(message).toContain('complete');
  });

  it('explains that BEHIND is part of the hold', () => {
    // The specific misreading that started #182.
    expect(message).toContain('BEHIND');
  });

  it('gives the machine-readable field, not the branch state', () => {
    expect(message).toContain('--json labels');
    expect(message).toContain('#175');
  });

  it('says how to release it and that no push is needed', () => {
    expect(message).toContain('remove the hold label');
    expect(message).toContain('no push');
  });
});

describe('fetchPullRequestLabels', () => {
  const request = {
    owner: 'OlyForge3D',
    repo: 'PrintFarmerDesktop',
    prNumber: 175,
    token: 'test-token',
  };

  // Same shape as tests/prClosureScope.test.ts: a literal is not a Response,
  // and the double assertion is what lets a two-field stub stand in for one.
  const respondWith = (payload: unknown, ok = true, status = 200) =>
    (() =>
      Promise.resolve({
        ok,
        status,
        statusText: 'Test',
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;

  it('returns the label names', async () => {
    const labels = await fetchPullRequestLabels({
      ...request,
      fetchImpl: respondWith({
        labels: [{ name: 'hold:sequenced' }, { name: 'ci' }],
      }),
    });
    expect(labels).toEqual(['hold:sequenced', 'ci']);
  });

  it('throws on a non-ok response', async () => {
    await expect(
      fetchPullRequestLabels({
        ...request,
        fetchImpl: respondWith({}, false, 403),
      }),
    ).rejects.toThrow(/403/);
  });

  it('throws rather than reporting "not held" when labels are missing', async () => {
    // A rate-limited or malformed response has no `labels` key. Treating that
    // as an empty array would report every held pull request as clear at
    // precisely the moment the API is least reliable.
    await expect(
      fetchPullRequestLabels({
        ...request,
        fetchImpl: respondWith({ message: 'API rate limit exceeded' }),
      }),
    ).rejects.toThrow(/unreadable/);
  });
});

describe('the sequencing-hold workflow sees label-only changes', () => {
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'sequencing-hold.yml'),
    'utf8',
    // Normalised because the parsers below anchor on '\n'. Written on Windows
    // this file was CRLF throughout, and `indexOf('\non:\n')` then found
    // nothing — reported as `workflow has no top-level "on:" block`, which
    // reads as a malformed workflow rather than a parser that cannot see a
    // well-formed one. The same parser in tests/prClosureScope.test.ts is
    // CRLF-fragile in exactly this way and passes only because the file it
    // reads happens to be LF.
  ).replace(/\r\n/g, '\n');

  /**
   * Event names the workflow subscribes to. Textual for the same reason
   * tests/prClosureScope.test.ts and tests/ciWorkflowTriggers.test.ts are
   * textual: the repository ships no YAML parser.
   */
  const triggersOf = (contents: string): string[] => {
    const start = contents.indexOf('\non:\n');
    if (start < 0) throw new Error('workflow has no top-level "on:" block');
    const rest = contents.slice(start + 5);
    const end = rest.search(/\n[a-z]/);
    const block = end < 0 ? rest : rest.slice(0, end);
    return [...block.matchAll(/^ {2}([a-z_]+):/gm)]
      .map((match) => match[1] ?? '')
      .sort();
  };

  const typesOf = (contents: string): string[] => {
    const match = /^ {4}types: \[(.+)\]$/m.exec(contents);
    if (!match?.[1]) throw new Error('workflow declares no pull_request types');
    return match[1].split(',').map((entry) => entry.trim());
  };

  it('parses something at all', () => {
    // Positive control on the parsers above. Every assertion in this block is
    // of the form "the list does/does not contain X", and a parser that
    // silently returned [] would satisfy the negative ones forever.
    expect(triggersOf(workflow).length).toBeGreaterThan(0);
    expect(typesOf(workflow).length).toBeGreaterThan(0);
  });

  it('runs on pull requests', () => {
    expect(triggersOf(workflow)).toEqual(['pull_request']);
  });

  it('runs on labeled and unlabeled', () => {
    // The load-bearing assertion of this file.
    //
    // A hold is applied and released by a label, which is not a commit: no
    // push, no new head, no `synchronize`. With only the commit-shaped
    // defaults, a hold applied after opening would never be seen, and a hold
    // RELEASED after opening would leave the check red with no way to clear it
    // but an empty commit — which is itself a push to a held branch.
    expect(typesOf(workflow)).toContain('labeled');
    expect(typesOf(workflow)).toContain('unlabeled');
  });

  it('keeps the default types that `types:` would otherwise replace', () => {
    // `types:` overrides the default set rather than adding to it. A
    // well-meaning `types: [labeled, unlabeled]` would stop this workflow
    // running on new pull requests entirely, and the check would simply be
    // absent rather than failing — which reads as "not held". Same trap
    // pr-closure-scope.yml documents for `edited`.
    for (const type of ['opened', 'synchronize', 'reopened']) {
      expect(typesOf(workflow)).toContain(type);
    }
  });

  it('stays out of the merge queue', () => {
    // A `merge_group` entry carries no pull request and therefore no labels,
    // so this check cannot run there. It must not become a required context
    // while that is true: a required context that no workflow emits stays
    // Pending forever and blocks the entry rather than failing it — which is
    // exactly the deadlock #122 fixed in ci.yml.
    expect(triggersOf(workflow)).not.toContain('merge_group');
  });

  it('does not install dependencies', () => {
    // The check imports only node: builtins. Keeping `npm ci` out holds the
    // job to seconds and off the contended runner pools.
    //
    // Structural, not textual. The first draft asserted
    // `expect(workflow).not.toContain('npm ci')` and failed — on the comment
    // in the workflow that says "No `npm ci`". A token search cannot tell an
    // assertion from its negation, so the more carefully the absence was
    // documented, the more certainly the search reported it as present. Read
    // the `run:` directives instead, where the polarity lives in the syntax.
    const runSteps = [...workflow.matchAll(/^ +run: (.+)$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(runSteps.length).toBeGreaterThan(0);
    expect(runSteps.some((step) => step.includes('npm ci'))).toBe(false);
  });
});

describe('.squad/holds.md describes the enforced mechanism', () => {
  const holds = readFileSync(
    path.join(repositoryRoot, '.squad', 'holds.md'),
    'utf8',
  );

  it('names the label and the check that reports it', () => {
    // #182's acceptance criterion is that a hold is readable by an automated
    // agent WITHOUT being told to look. The document is the half for a reader
    // who was told; it has to point at the half that finds them.
    expect(holds).toContain('hold:sequenced');
    expect(holds).toContain('Sequencing hold');
  });

  it('no longer claims nothing is wired to the label', () => {
    // Two-sided, and deliberately pinned to the sentence that was actually
    // there before this change: "Nothing in GitHub is wired to this label: no
    // required status check, no branch protection rule, no automation."
    //
    // The first draft of this test asserted `not.toMatch(/convention only/i)`.
    // That phrase is the LABEL's description, not this document's text, so the
    // assertion passed against the unmodified file and could never have
    // failed. It is the exact error this file exists to catch, found by
    // reading the document instead of trusting the phrase.
    expect(holds).not.toContain('no automation');
    expect(holds).not.toContain('Nothing in GitHub is wired to this label');
  });

  it('still says the check binds nothing', () => {
    // The opposite failure, and the more dangerous one: overstating the new
    // control. It reports; it does not prevent. A document that claimed
    // otherwise would license exactly the reliance the section warns against.
    expect(holds).toContain('not a required context');
    expect(holds).toContain('It prevents nothing');
  });
});
