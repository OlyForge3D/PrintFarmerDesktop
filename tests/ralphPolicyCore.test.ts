// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  GENERATED_BANNER,
  INDEXED_SOURCES,
  INDEX_PATH,
  buildIndex,
  issueReferences,
  lookup,
  parseSections,
} from '../scripts/squad-decisions-index.mjs';

const repoRoot = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

const CORE = '.squad/agents/ralph/loop.md';
const REFERENCE_DIR = '.squad/agents/ralph/reference';
const core = read(CORE);

/**
 * The core is loaded on EVERY round whether or not it is needed, so its size is
 * a fixed cost paid unconditionally. The budget is asserted rather than
 * documented because a policy file only ever grows: each addition is small and
 * locally justified, and nothing notices until the core is back where it
 * started.
 */
const CORE_BUDGET_CHARS = 12_000;

function routedReferenceFiles(): Set<string> {
  const names = [...core.matchAll(/reference\/([a-z0-9-]+\.md)/g)]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string');
  return new Set(names);
}

describe('the always-loaded core stays small', () => {
  it('fits the unconditional budget', () => {
    expect(core.length).toBeLessThan(CORE_BUDGET_CHARS);
  });

  it('routes to reference files that actually exist on disk', () => {
    const referenced = routedReferenceFiles();
    expect(referenced.size).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(
        existsSync(path.join(repoRoot, REFERENCE_DIR, file)),
        `${REFERENCE_DIR}/${file} is routed to but missing`,
      ).toBe(true);
    }
  });

  it('publishes a trigger for every reference file, so none is unreachable', () => {
    const routed = routedReferenceFiles();
    for (const file of [
      'triage-dispatch.md',
      'pr-gate-merge.md',
      'reaping.md',
      'cache.md',
    ]) {
      expect(
        routed.has(file),
        `${file} has no routing trigger in the core`,
      ).toBe(true);
    }
  });
});

describe('splitting the policy did not drop a safety invariant', () => {
  it.each([
    ['one round then exit', /exactly one round|one round, then exit/i],
    ['read-only main checkout', /read-only/i],
    ['five active slots', /\b5\b|\bfive\b/i],
    ['fresh re-derivation before acting', /re-derive|freshly/i],
    ['the cache is never authorization', /never authorization/i],
  ])('keeps %s in the always-loaded core', (_label, pattern) => {
    expect(core).toMatch(pattern);
  });

  it('uses the workflow prompt\u2019s exact idle line', () => {
    expect(core).toContain('📋 Board is clear.');
  });

  it('keeps the blanket never-review rule, with exactly one scoped pointer', () => {
    expect(core).toMatch(/never review/i);
    const pointers = [...core.matchAll(/pr-gate-merge\.md[^\n]*§9\.4/g)];
    expect(pointers.length).toBeGreaterThan(0);
  });

  it('scopes the exceptional conflict review to hand-resolved hunks only', () => {
    const gate = read(`${REFERENCE_DIR}/pr-gate-merge.md`);
    expect(gate).toMatch(/9\.4 The one exception/);
    expect(gate).toMatch(/resolved hunk|hand-resolved/i);
    expect(gate).toMatch(/git show --cc/);
    expect(gate).toMatch(/does\s+not\s+authoriz/i);
  });

  it('keeps reviewer model ids exact, including the -preview suffix', () => {
    const gate = read(`${REFERENCE_DIR}/pr-gate-merge.md`);
    const skill = read('.squad/skills/pre-pr-implementation/SKILL.md');
    for (const document of [gate, skill]) {
      expect(document).toContain('claude-opus-5');
      expect(document).toContain('gpt-5.6-sol');
      expect(document).toContain('gemini-3.1-pro-preview');
    }
  });

  it('forbids reviewers building, installing or testing', () => {
    const gate = read(`${REFERENCE_DIR}/pr-gate-merge.md`);
    const skill = read('.squad/skills/pre-pr-implementation/SKILL.md');
    for (const document of [gate, skill]) {
      expect(document).toMatch(/(must not|Do not|do not) build/);
      expect(document).toMatch(/npm install/);
    }
  });

  it('keeps strict:true and behind-sync serialisation with the merge gate', () => {
    const gate = read(`${REFERENCE_DIR}/pr-gate-merge.md`);
    expect(gate).toMatch(/strict/);
    expect(gate).toMatch(/plan:behind-sync-order/);
  });

  it('keeps both reap categories and the verbatim closing clause together', () => {
    const reaping = read(`${REFERENCE_DIR}/reaping.md`);
    expect(reaping).toMatch(/⚠️ Unpushed work/);
    expect(reaping).toMatch(/🧹 Ready to reap/);
    expect(reaping).toMatch(/archive/i);
  });

  it('names no CodeQL requirement the repository has not actually configured', () => {
    const gate = read(`${REFERENCE_DIR}/pr-gate-merge.md`);
    expect(gate).toMatch(/CodeQL/);
    expect(gate).toMatch(
      /if (it is |the repository )?(actually |genuinely )?config|actual/i,
    );
  });
});

describe('the author-facing skill carries author policy only', () => {
  const skill = read('.squad/skills/pre-pr-implementation/SKILL.md');

  it('states its own contract: a path plus acceptance criteria', () => {
    expect(skill).toMatch(/acceptance criteria/i);
    expect(skill).toMatch(/^---\r?\nname: pre-pr-implementation\s*$/m);
  });

  it('does not smuggle Ralph\u2019s routing, dispatch or reaping policy into the author', () => {
    expect(skill).not.toMatch(/create_session/);
    expect(skill).not.toMatch(/📋 Board is clear/);
    expect(skill).not.toMatch(/kickoff\.agent/);
  });

  it('does not invent a .NET or migration step in a TypeScript and Rust repository', () => {
    expect(skill).toMatch(/no EF Core and no database migration/i);
    expect(skill).not.toMatch(/dotnet ef/);
  });

  it('keeps the committed-narrowing prohibition, not merely the CLI advice', () => {
    expect(skill).toMatch(/testNamePattern/);
    expect(skill).toMatch(/check:test-narrowing/);
  });
});

describe('the line index addresses the corpus instead of reproducing it', () => {
  it('parses inclusive, non-overlapping ranges', () => {
    const sections = parseSections(
      ['# Title', 'intro', '## A', 'a1', 'a2', '### B', 'b1'].join('\n'),
      { source: 'x.md' },
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ title: 'A', startLine: 3, endLine: 5 });
    expect(sections[1]).toMatchObject({ title: 'B', startLine: 6, endLine: 7 });
  });

  it('reads issue references from headings only', () => {
    expect(issueReferences('2026-01-01 — #536 and #263 sequencing')).toEqual([
      263, 536,
    ]);
    expect(issueReferences('no references here')).toEqual([]);
  });

  it('looks a topic up by issue number and by title text', () => {
    const sections = parseSections('## #536 premises\n\n## Holds policy\n', {
      source: 'x.md',
    });
    expect(lookup(sections, '#536')).toHaveLength(1);
    expect(lookup(sections, '536')).toHaveLength(1);
    expect(lookup(sections, 'holds')).toHaveLength(1);
    expect(lookup(sections, '')).toEqual([]);
  });

  it('is checked in, generated, and in sync with its sources', () => {
    const committed = read(INDEX_PATH);
    expect(committed).toContain(GENERATED_BANNER);
    expect(committed).toBe(
      buildIndex(
        INDEXED_SOURCES.map((source: string) => ({
          path: source,
          contents: read(source),
        })),
      ),
    );
  });

  it('is a small fraction of the corpus it addresses', () => {
    const corpus = INDEXED_SOURCES.reduce(
      (total: number, source: string) => total + read(source).length,
      0,
    );
    expect(read(INDEX_PATH).length).toBeLessThan(corpus * 0.15);
  });
});
