// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  citationSentences,
  commentParagraphs,
  evaluateEnforcementCitations,
  formatFindings,
  runInvokedScripts,
  testImportedScripts,
} from '../scripts/check-enforcement-citations.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relative: string) {
  return {
    path: relative,
    contents: readFileSync(path.join(repoRoot, relative), 'utf8'),
  };
}

const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflows = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => read(path.join('.github', 'workflows', file)));

// The fifth citation in #472 lives outside .github/workflows — it is a staged
// workflow document under .squad/, which GitHub never dispatches. Included
// because a false enforcement claim misleads a reader wherever it is written.
const stagedWorkflows = readdirSync(
  path.join(repoRoot, '.squad', 'fact-checker'),
)
  .filter((file) => /\.workflow\.ya?ml$/.test(file))
  .map((file) => read(path.join('.squad', 'fact-checker', file)));

const testsDir = path.join(repoRoot, 'tests');
const testFiles = readdirSync(testsDir)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => read(path.join('tests', file)));

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const npmScripts: Record<string, string> = manifest.scripts;

const documents = [...workflows, ...stagedWorkflows];

/** First element, or a thrown error — an assertion on `undefined` passes too easily. */
function first<T>(items: T[]): T {
  const [head] = items;
  if (head === undefined)
    throw new Error('expected at least one item, got none');
  return head;
}
describe('an enforcement citation names a mechanism that runs', () => {
  it('finds enforcement citations at all, so a clean result is not vacuous', () => {
    const { citations } = evaluateEnforcementCitations({
      documents,
      workflows,
      testFiles,
      npmScripts,
    });
    expect(citations).toBeGreaterThan(0);
  });

  // The gate. #472: five headers cite check-merge-queue-contexts.mjs as
  // enforcing required-context agreement, and no workflow runs it.
  it('leaves no citation asserting an enforcement nothing performs', () => {
    const { findings } = evaluateEnforcementCitations({
      documents,
      workflows,
      testFiles,
      npmScripts,
    });
    expect(formatFindings(findings)).toEqual([]);
  });

  // POSITIVE CONTROL: it can say no.
  it('reports a citation whose script nothing runs and nothing imports', () => {
    const { findings } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'synthetic.yml',
          contents: '# scripts/ghost-guard.mjs enforces the invariant.\non:\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(findings).toHaveLength(1);
    expect(first(formatFindings(findings))).toContain('Nothing runs it at all');
  });

  // NEGATIVE CONTROL, same run: each of the three honest shapes clears.
  it('accepts a citation that names a mechanism which exists', () => {
    const base = {
      workflows: [
        {
          path: 'w.yml',
          contents:
            'jobs:\n  a:\n    steps:\n      - run: node scripts/wired.mjs\n',
        },
      ],
      testFiles: [
        {
          path: 'tests/t.ts',
          contents: "import x from '../scripts/pure.mjs';",
        },
      ],
      npmScripts: {},
    };

    const wired = evaluateEnforcementCitations({
      ...base,
      documents: [
        {
          path: 'a.yml',
          contents: '# scripts/wired.mjs enforces the invariant.\n',
        },
      ],
    });
    expect(wired.findings).toEqual([]);
    expect(first(wired.honest).mechanism).toBe('run:');

    const byTests = evaluateEnforcementCitations({
      ...base,
      documents: [
        {
          path: 'b.yml',
          contents:
            '# scripts/pure.mjs enforces the classification under `npm run test`.\n',
        },
      ],
    });
    expect(byTests.findings).toEqual([]);
    expect(first(byTests.honest).mechanism).toBe('tests');

    const byHand = evaluateEnforcementCitations({
      ...base,
      documents: [
        {
          path: 'c.yml',
          contents: '# scripts/ghost.mjs enforces it, run by hand.\n',
        },
      ],
    });
    expect(byHand.findings).toEqual([]);
    expect(first(byHand.honest).mechanism).toBe('by hand');
  });

  // Claiming the test suite carries it is not enough — a test must import it.
  // Otherwise the escape hatch is a sentence anyone can write.
  it('rejects a tests/ claim that no test import backs', () => {
    const { findings } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'd.yml',
          contents: '# scripts/absent.mjs enforces it under `npm run test`.\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(findings).toHaveLength(1);
  });

  // A sentence that merely POINTS AT a script makes no enforcement claim, and
  // flagging it would make the check unusable noise.
  it('ignores a citation that asserts nothing', () => {
    const { findings, citations } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'e.yml',
          contents: '# See scripts/notes.mjs for background.\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(findings).toEqual([]);
    expect(citations).toBe(0);
  });

  // Regression for a mutant that SURVIVED at sentence granularity: a header
  // reading "scripts/x.mjs holds that classification. It is enforced." dropped
  // out of the scan entirely, because the sentence naming the script had no
  // verb and the sentence with the verb named no script. Splitting a claim
  // across a full stop must not be a way out.
  it('sees a claim split across sentences in the same comment block', () => {
    const { findings, citations } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'g.yml',
          contents:
            '# scripts/ghost-guard.mjs holds that classification.\n# It is enforced.\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(citations).toBe(1);
    expect(findings).toHaveLength(1);
  });

  // A separate comment block is a separate claim; the widening above must not
  // reach across a blank line and invent an assertion.
  it('does not join claims across separate comment blocks', () => {
    const { citations } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'h.yml',
          contents:
            '# See scripts/notes.mjs.\n\nname: x\n\n# It is enforced.\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(citations).toBe(0);
  });

  // The verb has to come from the claim, not from the subject's name. This
  // module got it wrong first: /\bchecks?\b/ matched inside
  // `check-merge-queue-contexts.mjs`, so every `check-*.mjs` citation fired on
  // its own filename regardless of what the sentence said.
  it('does not read an enforcement verb out of the script name', () => {
    const { findings, citations } = evaluateEnforcementCitations({
      documents: [
        {
          path: 'f.yml',
          contents: '# See scripts/check-something.mjs for background.\n',
        },
      ],
      workflows: [],
      testFiles: [],
      npmScripts: {},
    });
    expect(citations).toBe(0);
    expect(findings).toEqual([]);
  });

  // The claims wrap across comment lines. A line-anchored reader sees a verb
  // with no object and reports nothing, which is a false clean.
  it('joins wrapped comment lines before splitting sentences', () => {
    const wrapped = [
      '# contexts. scripts/check-merge-queue-contexts.mjs enforces that against live',
      '# branch protection rather than leaving it to this comment.',
    ].join('\n');
    const found = first(citationSentences(wrapped));
    expect(found.sentence).toContain('against live branch protection');
    expect(found.scripts).toEqual(['check-merge-queue-contexts.mjs']);
    expect(commentParagraphs(wrapped)).toHaveLength(1);
  });

  it('separates what workflows run from what tests import', () => {
    const invoked = runInvokedScripts(workflows, npmScripts);
    const imported = testImportedScripts(testFiles);
    // The measurement #472 rests on: imported, never executed.
    expect(imported.has('check-merge-queue-contexts.mjs')).toBe(true);
    expect(invoked.has('check-merge-queue-contexts.mjs')).toBe(false);
    // Control: a script that genuinely is run by a workflow.
    expect(invoked.has('npm-ci-strict.mjs')).toBe(true);
  });
});
