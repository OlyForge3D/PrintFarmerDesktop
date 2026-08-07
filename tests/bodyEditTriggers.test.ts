// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BODY_EDIT_TYPE,
  DEFAULT_PULL_REQUEST_TYPES,
  bodyDerivedReads,
  droppedDefaultTypes,
  effectiveTypes,
  evaluateBodyEditTriggers,
  formatDroppedDefaults,
  formatFindings,
  invokedScripts,
  pullRequestTypes,
} from '../scripts/check-body-edit-triggers.mjs';
import { triggersOf } from '../scripts/check-merge-queue-contexts.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const scriptsDir = path.join(repoRoot, 'scripts');

const workflows = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    path: path.join('.github', 'workflows', file),
    contents: readFileSync(path.join(workflowsDir, file), 'utf8'),
  }));

const scripts = readdirSync(scriptsDir)
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => ({
    basename: file,
    contents: readFileSync(path.join(scriptsDir, file), 'utf8'),
  }));

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const npmScripts: Record<string, string> = manifest.scripts;
const guardScript = path.join(scriptsDir, 'check-body-edit-triggers.mjs');

/** First element, or a thrown error — an assertion on `undefined` passes too easily. */
function first<T>(items: T[]): T {
  const [head] = items;
  if (head === undefined)
    throw new Error('expected at least one item, got none');
  return head;
}
describe('a guard that reads a PR body re-runs when the body changes', () => {
  // The scan must find guards before "no findings" means anything. A zero over
  // an empty corpus is the vacuous pass this class of check keeps producing.
  it('finds the body-reading guards, so a clean result is not vacuous', () => {
    const { guards } = evaluateBodyEditTriggers({
      workflows,
      scripts,
      npmScripts,
    });
    expect(guards).toContain('check-closing-references.mjs');
    expect(guards).toContain('check-pr-closure-scope.mjs');
    expect(guards).not.toContain('check-body-edit-triggers.mjs');
    expect(guards).not.toContain('check-injected-defaults.mjs');
  });

  it('sees each guard invoked by at least one workflow', () => {
    const { findings, compliant, guards, uninvokedGuards } =
      evaluateBodyEditTriggers({
        workflows,
        scripts,
        npmScripts,
      });
    const covered = [...findings, ...compliant]
      .flatMap((entry) => entry.guards)
      .sort();
    expect([...new Set(covered)]).toEqual(guards);
    expect(uninvokedGuards).toEqual([]);
  });

  it('reports every discovered guard that no pull-request workflow runs', () => {
    const { uninvokedGuards } = evaluateBodyEditTriggers({
      workflows: [],
      scripts: [
        {
          basename: 'check-new-body-contract.mjs',
          contents: "gh(['pr', 'view', '--json', 'body'])",
        },
      ],
      npmScripts,
    });
    expect(uninvokedGuards).toEqual(['check-new-body-contract.mjs']);
  });

  it('runs this policy through the required closing-reference context', () => {
    const workflow = readFileSync(
      path.join(workflowsDir, 'closing-reference-declaration.yml'),
      'utf8',
    );
    expect(npmScripts['check:body-edit-triggers']).toBe(
      'node scripts/check-body-edit-triggers.mjs',
    );
    expect(workflow).toContain('npm run check:body-edit-triggers');
    expect(pullRequestTypes(workflow)).toContain(BODY_EDIT_TYPE);
    expect(triggersOf(workflow, 'closing-reference-declaration.yml')).toContain(
      'merge_group',
    );
  });

  // The gate itself. #436: ci.yml runs the arming guard inside the required
  // `Desktop` context but subscribes only to the defaults, so a body edited
  // after a green run is certified by a check that never read it.
  it('leaves no workflow running a body-reading guard blind to edits', () => {
    const { findings } = evaluateBodyEditTriggers({
      workflows,
      scripts,
      npmScripts,
    });

    expect(formatFindings(findings)).toEqual([]);
  });

  // POSITIVE CONTROL: the check can say no. Without this, the assertion above
  // is satisfied by a function that returns [] unconditionally.
  it('reports a workflow that runs a body-reading guard without `edited`', () => {
    const { findings } = evaluateBodyEditTriggers({
      workflows: [
        {
          path: '.github/workflows/synthetic.yml',
          contents: [
            'on:',
            '  pull_request:',
            'jobs:',
            '  a:',
            '    steps:',
            '      - run: npm run check:closing-references',
          ].join('\n'),
        },
      ],
      scripts: [
        {
          basename: 'check-closing-references.mjs',
          contents: "gh(['pr','view','--json','body'])",
        },
      ],
      npmScripts,
    });

    expect(findings).toHaveLength(1);
    expect(first(findings).types).toEqual(DEFAULT_PULL_REQUEST_TYPES);
    expect(first(formatFindings(findings))).toContain('synthetic.yml');
    expect(first(formatFindings(findings))).toContain(BODY_EDIT_TYPE);
  });

  // NEGATIVE CONTROL, same run: the fixed shape passes.
  it('accepts the same workflow once `edited` is listed', () => {
    const { findings, compliant } = evaluateBodyEditTriggers({
      workflows: [
        {
          path: '.github/workflows/synthetic.yml',
          contents: [
            'on:',
            '  pull_request:',
            '    types: [opened, synchronize, reopened, edited]',
            'jobs:',
            '  a:',
            '    steps:',
            '      - run: npm run check:closing-references',
          ].join('\n'),
        },
      ],
      scripts: [
        {
          basename: 'check-closing-references.mjs',
          contents: "gh(['pr','view','--json','body'])",
        },
      ],
      npmScripts,
    });

    expect(findings).toEqual([]);
    expect(compliant).toHaveLength(1);
  });

  it('treats a body-derived field as a body read', () => {
    expect(bodyDerivedReads('const x = pr.closingIssuesReferences')).toEqual([
      'reads closingIssuesReferences, which GitHub derives from the body text',
    ]);
    expect(bodyDerivedReads('const x = 1')).toEqual([]);
  });

  it('does not confuse unrelated properties or its own matcher with body reads', () => {
    expect(bodyDerivedReads('for (const node of ast.body) {}')).toEqual([]);
    expect(
      bodyDerivedReads(
        readFileSync(
          path.join(scriptsDir, 'check-body-edit-triggers.mjs'),
          'utf8',
        ),
      ),
    ).toEqual([]);
  });

  // The mirror of the workflow-citation test, and it exists because this
  // module got it wrong first: its opening run attributed
  // `closingIssuesReferences` to check-closing-references.mjs, which only
  // discusses the field in prose. A guard is what a file does.
  it('does not treat a field named in a comment as a read', () => {
    expect(bodyDerivedReads('// closingIssuesReferences is derived')).toEqual(
      [],
    );
    expect(bodyDerivedReads('/* reads .body eventually */')).toEqual([]);
    expect(
      bodyDerivedReads(
        '// discusses .body\nconst x = pr.closingIssuesReferences',
      ),
    ).toHaveLength(1);
  });

  // A script NAMED in a comment is a citation, not an invocation — the
  // distinction #472 exists for. If this collapsed, a workflow could satisfy
  // the gate by mentioning a guard it never runs.
  it('counts only run: invocations, never citations in comments', () => {
    const cited = [
      '# scripts/check-closing-references.mjs enforces this',
      'on:',
      '  pull_request:',
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: echo hello',
    ].join('\n');
    expect(invokedScripts(cited, npmScripts)).toEqual([]);
  });

  it('resolves a guard invoked through its npm alias', () => {
    const yaml = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: npm run check:closure-scope',
    ].join('\n');
    expect(invokedScripts(yaml, npmScripts)).toContain(
      'check-pr-closure-scope.mjs',
    );
  });

  // `null` (no pull_request trigger) and `[]` (trigger with no types) are
  // different obligations. Collapsing them would let release.yml report as
  // compliant for a reason that has nothing to do with body edits.
  it('separates "no pull_request trigger" from "no types listed"', () => {
    expect(pullRequestTypes('on:\n  push:\n    branches: [main]\n')).toBeNull();
    expect(pullRequestTypes('on:\n  pull_request:\n  push:\n')).toEqual([]);
    expect(effectiveTypes(null)).toBeNull();
    expect(effectiveTypes([])).toEqual(DEFAULT_PULL_REQUEST_TYPES);
  });

  it('reads a block-sequence types list as well as an inline one', () => {
    const block = [
      'on:',
      '  pull_request:',
      '    types:',
      '      - opened',
      '      - edited',
      'jobs:',
    ].join('\n');
    expect(pullRequestTypes(block)).toEqual(['opened', 'edited']);
  });

  // `types:` replaces the defaults rather than extending them, so a listed set
  // that omits `synchronize` silently stops running on pushes. Pinning the
  // default set keeps that fact in a test rather than in a comment.
  it('does not treat a listed set as additive to the defaults', () => {
    expect(effectiveTypes(['edited'])).toEqual(['edited']);
    expect(DEFAULT_PULL_REQUEST_TYPES).toEqual([
      'opened',
      'synchronize',
      'reopened',
    ]);
  });
});

describe('the wired CLI discriminates a bad trigger configuration', () => {
  it('fails without edited and passes when the same workflow is restored', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'body-edit-triggers-'));
    const workflowDirectory = path.join(fixture, '.github', 'workflows');
    const fixtureScripts = path.join(fixture, 'scripts');
    mkdirSync(workflowDirectory, { recursive: true });
    mkdirSync(fixtureScripts);
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({
        scripts: {
          'check:closing-references':
            'node scripts/check-closing-references.mjs',
        },
      }),
    );
    writeFileSync(
      path.join(fixtureScripts, 'check-closing-references.mjs'),
      "export const currentBody = gh(['pr', 'view', '--json', 'body']);\n",
    );

    const run = () =>
      spawnSync('node', [guardScript, fixture], {
        encoding: 'utf8',
      });
    const workflow = (types: string) =>
      [
        'on:',
        '  pull_request:',
        `    types: [${types}]`,
        '  merge_group:',
        'jobs:',
        '  closing-references:',
        '    steps:',
        '      - run: npm run check:closing-references',
      ].join('\n');

    try {
      writeFileSync(
        path.join(workflowDirectory, 'closing-reference-declaration.yml'),
        workflow('opened, synchronize, reopened'),
      );
      const red = run();
      expect(red.status).toBe(1);
      expect(`${red.stdout}${red.stderr}`).toContain(
        "Add 'edited' to its pull_request types",
      );

      writeFileSync(
        path.join(workflowDirectory, 'closing-reference-declaration.yml'),
        workflow('opened, synchronize, reopened, edited'),
      );
      const green = run();
      expect(green.status).toBe(0);
      expect(`${green.stdout}${green.stderr}`).toContain(
        '1 workflow invocation(s) subscribe to edited',
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('a types: list that opts in partially loses events silently', () => {
  // `types:` REPLACES the default set. A workflow listing some of the defaults
  // has opted into the code-changing lifecycle and then dropped part of it, and
  // the dropped events simply never dispatch -- which reads exactly like a
  // workflow that was never triggered. This case exists because the repo comment
  // claimed the gate "fails if any of the four types is dropped" and, measured by
  // mutation, dropping `synchronize` was not detected by anything.
  it('flags a list that keeps some defaults and drops others', () => {
    expect(droppedDefaultTypes(['opened', 'reopened', 'edited'])).toEqual([
      'synchronize',
    ]);
    expect(droppedDefaultTypes(['opened', 'synchronize', 'edited'])).toEqual([
      'reopened',
    ]);
  });

  // The exoneration half. Without this the rule would flag every lifecycle
  // workflow in the repo, and a check that fires on correct input is not a
  // stricter check -- it is one nobody can leave green.
  it('exonerates a list scoped to a different lifecycle entirely', () => {
    expect(droppedDefaultTypes(['closed'])).toEqual([]);
    expect(droppedDefaultTypes(['completed'])).toEqual([]);
    expect(droppedDefaultTypes([])).toEqual([]);
    expect(droppedDefaultTypes(null)).toEqual([]);
  });

  it('accepts a full default set with extras alongside', () => {
    expect(
      droppedDefaultTypes([...DEFAULT_PULL_REQUEST_TYPES, 'labeled']),
    ).toEqual([]);
  });

  // The live corpus. This is the assertion the mutation moves.
  it('leaves no workflow in this repo dropping part of the default set', () => {
    const { droppedDefaults } = evaluateBodyEditTriggers({
      workflows,
      scripts,
      npmScripts,
    });
    expect(formatDroppedDefaults(droppedDefaults)).toEqual([]);
  });

  // Vacuity control: the formatter must actually produce text, or the assertion
  // above passes by comparing two empty arrays for the wrong reason.
  it('renders a finding naming the omitted events', () => {
    const rendered = first(
      formatDroppedDefaults([
        {
          workflow: '.github/workflows/ci.yml',
          types: ['opened', 'reopened', 'edited'],
          dropped: ['synchronize'],
        },
      ]),
    );
    expect(rendered).toContain('ci.yml');
    expect(rendered).toContain('synchronize');
    expect(rendered).toContain('replaces the default set');
  });
});
