import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_RELOCATED,
  EXIT_UNDETERMINED,
  VERDICT_DIRECT,
  VERDICT_DRIVEN,
  VERDICT_UNDETERMINED,
  VERDICT_UNREACHABLE,
  analyse,
  classifyDefaults,
  exitCodeFor,
  findCallSites,
  findCompositionRoot,
  formatResult,
  importedFrom,
  main,
  namedExports,
  parseArgs,
  parseSource,
  readInjectedDefaults,
  runMain,
  uniqueObjectBindings,
} from '../scripts/check-injected-defaults.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_CI_STRICT = path.join(REPO_ROOT, 'scripts', 'npm-ci-strict.mjs');
const NPM_CI_STRICT_SUITE = path.join(
  REPO_ROOT,
  'tests',
  'npmCiStrict.test.ts',
);
const SELF_MODULE = path.join(
  REPO_ROOT,
  'scripts',
  'check-injected-defaults.mjs',
);

/**
 * Indexing with `?.` would let a test pass on an EMPTY array, which is the exact
 * vacuity this suite exists to rule out. This throws instead, so a missing
 * element is a loud failure rather than an undefined compared against undefined.
 */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no element at index ${index} of ${items.length}`);
  }
  return item;
}

function sourcesOf(files: Record<string, string>) {
  return (file: string) => {
    const source = files[file];
    if (source === undefined) throw new Error(`no fixture for ${file}`);
    return source;
  };
}

function verdictFor(
  classified: { key: string; verdict: string }[],
  key: string,
) {
  return classified.find((entry) => entry.key === key)?.verdict;
}

describe('the classifier is pure over resolved facts, so every verdict is drivable', () => {
  // #425 shipped a classifier with an arm no real input could provoke, and
  // deleting that arm broke nothing. Keeping judgement separate from collection
  // is what makes the four arms below reachable from a plain object.
  const base = {
    exports: new Set<string>(),
    imported: new Set<string>(),
    sites: [] as {
      line: number;
      resolution: string;
      keys: Set<string> | null;
    }[],
  };

  it('calls a default DRIVEN when a resolved call omits its key', () => {
    const classified = classifyDefaults({
      ...base,
      defaults: [
        {
          key: 'fail',
          defaultKind: 'identifier',
          defaultName: 'fail',
          line: 1,
        },
      ],
      sites: [{ line: 9, resolution: 'literal', keys: new Set(['other']) }],
    });
    expect(verdictFor(classified, 'fail')).toBe(VERDICT_DRIVEN);
    expect(at(classified, 0).why).toContain('line 9');
  });

  it('calls a default DIRECT when the module exports it and the suite imports it', () => {
    const classified = classifyDefaults({
      ...base,
      defaults: [
        {
          key: 'fail',
          defaultKind: 'identifier',
          defaultName: 'fail',
          line: 1,
        },
      ],
      exports: new Set(['fail']),
      imported: new Set(['fail']),
      sites: [{ line: 9, resolution: 'literal', keys: new Set(['fail']) }],
    });
    expect(verdictFor(classified, 'fail')).toBe(VERDICT_DIRECT);
  });

  it('exporting without importing is not a route: the suite still cannot run it', () => {
    // The #360 static leg went green on an import surface while the seams it
    // stood in for were unmeasured. Exported-but-not-imported is that leg's
    // failure case, so it is pinned rather than assumed.
    const classified = classifyDefaults({
      ...base,
      defaults: [
        {
          key: 'fail',
          defaultKind: 'identifier',
          defaultName: 'fail',
          line: 1,
        },
      ],
      exports: new Set(['fail']),
      imported: new Set(),
      sites: [{ line: 9, resolution: 'literal', keys: new Set(['fail']) }],
    });
    expect(verdictFor(classified, 'fail')).toBe(VERDICT_UNREACHABLE);
  });

  it('an inline default can never be DIRECT, because there is no name to import', () => {
    const classified = classifyDefaults({
      ...base,
      defaults: [
        { key: 'exit', defaultKind: 'inline', defaultName: null, line: 1 },
      ],
      exports: new Set(['exit']),
      imported: new Set(['exit']),
      sites: [{ line: 9, resolution: 'literal', keys: new Set(['exit']) }],
    });
    expect(verdictFor(classified, 'exit')).toBe(VERDICT_UNREACHABLE);
    expect(at(classified, 0).why).toContain('inline expression');
  });

  it('an unresolved call site yields UNDETERMINED, never a manufactured DRIVEN', () => {
    // THE DIRECTION THAT MATTERS: treating an unresolvable argument as an
    // omission would invent coverage out of ignorance — a false "still covered",
    // which is the exact failure this file exists to detect.
    const classified = classifyDefaults({
      ...base,
      defaults: [
        {
          key: 'fail',
          defaultKind: 'identifier',
          defaultName: 'fail',
          line: 1,
        },
      ],
      sites: [
        { line: 9, resolution: 'literal', keys: new Set(['fail']) },
        { line: 12, resolution: 'unresolved', keys: null },
      ],
    });
    expect(verdictFor(classified, 'fail')).toBe(VERDICT_UNDETERMINED);
  });

  it('a call with no argument at all drives every default', () => {
    const classified = classifyDefaults({
      ...base,
      defaults: [
        {
          key: 'fail',
          defaultKind: 'identifier',
          defaultName: 'fail',
          line: 1,
        },
        { key: 'exit', defaultKind: 'inline', defaultName: null, line: 2 },
      ],
      sites: [{ line: 9, resolution: 'none', keys: new Set() }],
    });
    expect(classified.map((entry) => entry.verdict)).toEqual([
      VERDICT_DRIVEN,
      VERDICT_DRIVEN,
    ]);
  });
});

describe('the exit ranking is asserted, not left to reading', () => {
  it('is 0 when every default is driven or directly imported', () => {
    expect(
      exitCodeFor([{ verdict: VERDICT_DRIVEN }, { verdict: VERDICT_DIRECT }]),
    ).toBe(EXIT_OK);
  });

  it('is 2 when nothing is proven and something is unresolved', () => {
    expect(
      exitCodeFor([
        { verdict: VERDICT_DRIVEN },
        { verdict: VERDICT_UNDETERMINED },
      ]),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('RELOCATED OUTRANKS UNDETERMINED: a proven finding is not weakened by an adjacent unknown', () => {
    // Same reasoning pinned in check-merge-landed.mjs, and deliberately the
    // OPPOSITE of mutation-harness.mjs, where confounded outranks survived
    // because a confounded arm undermines its own result. Here the unresolved
    // dependency says nothing whatsoever about the proven one.
    expect(
      exitCodeFor([
        { verdict: VERDICT_UNDETERMINED },
        { verdict: VERDICT_UNREACHABLE },
      ]),
    ).toBe(EXIT_RELOCATED);
  });
});

describe('the export surface is read from the syntax, not from a line prefix', () => {
  it('collects declaration exports and `export { ... }` alike', () => {
    const ast = parseSource(
      [
        'function hidden() {}',
        'function shown() {}',
        'export function declared() {}',
        'export const value = 1;',
        'export { shown };',
      ].join('\n'),
      'm.mjs',
    );
    const names = namedExports(ast);
    expect([...names].sort()).toEqual(['declared', 'shown', 'value']);
    expect(names.has('hidden')).toBe(false);
  });

  it('reads renamed exports under the exported name', () => {
    const ast = parseSource('const a = 1;\nexport { a as b };', 'm.mjs');
    expect([...namedExports(ast)]).toEqual(['b']);
  });
});

describe('the import surface is matched by resolved path, not by specifier text', () => {
  it('links ../scripts/x.mjs from tests/ to the same file named absolutely', () => {
    const ast = parseSource(
      "import { one, two } from '../scripts/x.mjs';",
      's.ts',
    );
    const found = importedFrom(
      ast,
      path.join(REPO_ROOT, 'tests', 's.ts'),
      path.join(REPO_ROOT, 'scripts', 'x.mjs'),
    );
    expect([...found].sort()).toEqual(['one', 'two']);
  });

  it('NEGATIVE CONTROL: imports from a different module are not counted', () => {
    // Without this, "the suite imports it" would be satisfied by importing a
    // same-named symbol from anywhere at all.
    const ast = parseSource(
      "import { one } from '../scripts/other.mjs';",
      's.ts',
    );
    const found = importedFrom(
      ast,
      path.join(REPO_ROOT, 'tests', 's.ts'),
      path.join(REPO_ROOT, 'scripts', 'x.mjs'),
    );
    expect([...found]).toEqual([]);
  });

  it('ignores bare package specifiers', () => {
    const ast = parseSource("import { parse } from 'some-package';", 's.ts');
    expect([...importedFrom(ast, 'tests/s.ts', 'scripts/x.mjs')]).toEqual([]);
  });
});

describe('the injected defaults are the destructured parameters that carry one', () => {
  it('reports a parameter with no default as no subject at all', () => {
    // A required collaborator has no default to be unreachable. Reporting it
    // would be a finding manufactured from a parameter list.
    const ast = parseSource(
      'export function main({ required, optional = impl }) {}',
      'm.mjs',
    );
    const defaults = readInjectedDefaults(findCompositionRoot(ast, 'main'));
    expect(defaults.map((entry) => entry.key)).toEqual(['optional']);
  });

  it('separates an identifier default from an inline one', () => {
    const ast = parseSource(
      'export function main({ a = impl, b = (x) => x, c = 3 } = {}) {}',
      'm.mjs',
    );
    const defaults = readInjectedDefaults(findCompositionRoot(ast, 'main'));
    expect(defaults).toEqual([
      { key: 'a', defaultKind: 'identifier', defaultName: 'impl', line: 1 },
      { key: 'b', defaultKind: 'inline', defaultName: null, line: 1 },
      { key: 'c', defaultKind: 'inline', defaultName: null, line: 1 },
    ]);
  });

  it('handles a renamed binding, where the key and the local name differ', () => {
    const ast = parseSource(
      'export function main({ fail: failImpl = fail } = {}) {}',
      'm.mjs',
    );
    const defaults = readInjectedDefaults(findCompositionRoot(ast, 'main'));
    expect(defaults).toEqual([
      { key: 'fail', defaultKind: 'identifier', defaultName: 'fail', line: 1 },
    ]);
  });

  it('finds an arrow-function root as well as a declared one', () => {
    const ast = parseSource(
      'export const main = ({ a = impl } = {}) => {};',
      'm.mjs',
    );
    expect(readInjectedDefaults(findCompositionRoot(ast, 'main'))).toHaveLength(
      1,
    );
  });

  it('returns nothing for a root whose first parameter is not destructured', () => {
    const ast = parseSource('export function main(options) {}', 'm.mjs');
    expect(readInjectedDefaults(findCompositionRoot(ast, 'main'))).toEqual([]);
  });
});

describe('call sites are resolved through one level of indirection, or not at all', () => {
  it('reads a call with no argument as omitting everything', () => {
    const ast = parseSource('main();', 's.ts');
    expect(findCallSites(ast, 'main')).toEqual([
      { line: 1, resolution: 'none', keys: new Set() },
    ]);
  });

  it('reads an inline object literal', () => {
    const sites = findCallSites(
      parseSource('main({ a: 1, b: 2 });', 's.ts'),
      'main',
    );
    expect(at(sites, 0).resolution).toBe('literal');
    expect([...(at(sites, 0).keys ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('resolves an identifier argument to its unique object literal', () => {
    const sites = findCallSites(
      parseSource('const deps = { a: 1 };\nmain(deps);', 's.ts'),
      'main',
    );
    expect(at(sites, 0).resolution).toBe('indirect');
    expect([...(at(sites, 0).keys ?? [])]).toEqual(['a']);
  });

  it('resolves harness.dependencies through the unique `dependencies` binding', () => {
    // This is the shape npm-ci-strict's suite actually uses. Without it every
    // real call site reads as unresolved and the tool reports UNDETERMINED for
    // a file it could have settled completely.
    const sites = findCallSites(
      parseSource(
        'const dependencies = { a: 1 };\nmain(harness.dependencies);',
        's.ts',
      ),
      'main',
    );
    expect(at(sites, 0).resolution).toBe('indirect');
    expect([...(at(sites, 0).keys ?? [])]).toEqual(['a']);
  });

  it('unwraps `satisfies`, which is how the real harness ends', () => {
    const sites = findCallSites(
      parseSource(
        'const dependencies = { a: 1 } satisfies Partial<X>;\nmain(harness.dependencies);',
        's.ts',
      ),
      'main',
    );
    expect(at(sites, 0).resolution).toBe('indirect');
    expect([...(at(sites, 0).keys ?? [])]).toEqual(['a']);
  });

  it('refuses a name bound more than once rather than guessing which one was reached', () => {
    const ast = parseSource(
      'const deps = { a: 1 };\nfunction f() { const deps = { b: 2 }; }\nmain(deps);',
      's.ts',
    );
    expect(at(findCallSites(ast, 'main'), 0).resolution).toBe('unresolved');
  });

  it('refuses a spread, because a spread can supply any key', () => {
    const ast = parseSource('main({ ...base, a: 1 });', 's.ts');
    const site = at(findCallSites(ast, 'main'), 0);
    expect(site.resolution).toBe('unresolved');
    expect(site.keys).toBeNull();
  });

  it('refuses a computed key, which is not statically known', () => {
    expect(
      at(findCallSites(parseSource('main({ [k]: 1 });', 's.ts'), 'main'), 0)
        .resolution,
    ).toBe('unresolved');
  });

  it('refuses a call argument it cannot reduce to a literal', () => {
    expect(
      at(findCallSites(parseSource('main(buildDeps());', 's.ts'), 'main'), 0)
        .resolution,
    ).toBe('unresolved');
  });

  it('NEGATIVE CONTROL: calls to a different function are not collected', () => {
    expect(
      findCallSites(parseSource('other({ a: 1 });', 's.ts'), 'main'),
    ).toEqual([]);
  });

  it('indexes only names bound exactly once', () => {
    const bindings = uniqueObjectBindings(
      parseSource(
        'const a = { x: 1 };\nconst b = { y: 1 };\nconst b = { z: 1 };',
        's.ts',
      ),
    );
    expect([...bindings.keys()]).toEqual(['a']);
  });
});

describe('THE POINT: injecting a collaborator relocates the seam rather than closing it', () => {
  // These read the real files. If npm-ci-strict is repaired, these tests change
  // — which is correct: the claim is about trunk, and a claim about trunk that
  // survives its repair was never reading trunk.
  //
  // What must NOT change them is an unrelated edit to a file this suite does
  // not own. b9b16d6 ("read npm ls's exit status") added call sites and turned
  // these red at 6-vs-9 without touching a single thing asserted here. So the
  // COUNT is derived, never transcribed: a number pinned against a foreign file
  // is a transcription, and a transcription reports its own staleness as a
  // finding about the subject.
  const result = analyse({
    moduleFile: NPM_CI_STRICT,
    suiteFile: NPM_CI_STRICT_SUITE,
    rootName: 'main',
  });

  it('resolves every one of the real call sites, so the result is a proof and not an over-report', () => {
    // The vacuity guard is load-bearing: `every` on an empty list is true, so
    // without it a resolver that found NOTHING would satisfy this test — the
    // "guard scanning almost nothing is green like a guard scanning everything"
    // shape, one level up.
    expect(result.sites.length).toBeGreaterThan(0);
    expect(result.sites.every((site) => site.resolution !== 'unresolved')).toBe(
      true,
    );
  });

  it('reports main() as relocated, with fail among the defaults nothing executes', () => {
    // fail() is `process.exit(1)` — the single mechanism by which this script
    // reddens CI. #360 measured that it can be made a no-op with 96 test files
    // staying green. It is behind an injection boundary and nothing runs it.
    expect(verdictFor(result.classified, 'fail')).toBe(VERDICT_UNREACHABLE);
    expect(exitCodeFor(result.classified)).toBe(EXIT_RELOCATED);
  });

  it('DISCRIMINATES: the three exported-and-imported defaults are NOT reported', () => {
    // Without this, "reports unreachable defaults" would be satisfied by a tool
    // that reports every default unreachable, which is the shape of finding
    // this whole file argues against.
    expect(verdictFor(result.classified, 'retryCleanupRemovals')).toBe(
      VERDICT_DIRECT,
    );
    expect(verdictFor(result.classified, 'writeCleanupEvidence')).toBe(
      VERDICT_DIRECT,
    );
    expect(verdictFor(result.classified, 'markCleanupEvidenceOutput')).toBe(
      VERDICT_DIRECT,
    );
  });

  it('names every default it found, so a shrinking parameter list cannot silently pass', () => {
    expect(result.classified.map((entry) => entry.key)).toEqual([
      'runNpmCi',
      'retryCleanupRemovals',
      'writeCleanupEvidence',
      'markCleanupEvidenceOutput',
      'readProductionTree',
      'fail',
      'exit',
      'writeStderr',
    ]);
  });
});

describe('the tool answers for its own composition roots', () => {
  it('drives analyse() with no substitutes, so the readFileSync default ships exercised', () => {
    // This is the remedy the tool prints, applied to the tool. Every other test
    // here that reaches the filesystem does so through this same default; an
    // arm that injected readFile everywhere would leave it unreachable and the
    // tool would fail its own check.
    const result = analyse({
      moduleFile: SELF_MODULE,
      suiteFile: path.join(REPO_ROOT, 'tests', 'injectedDefaults.test.ts'),
      rootName: 'analyse',
    });
    expect(verdictFor(result.classified, 'readFile')).toBe(VERDICT_DRIVEN);
    expect(exitCodeFor(result.classified)).toBe(EXIT_OK);
  });

  it('accepts an injected reader, which is what makes the fixtures below possible', () => {
    const result = analyse({
      moduleFile: 'm.mjs',
      suiteFile: 'm.test.ts',
      rootName: 'main',
      readFile: sourcesOf({
        'm.mjs': 'export function main({ a = impl } = {}) {}',
        'm.test.ts': "import { main } from './m.mjs';\nmain();",
      }),
    });
    expect(at(result.classified, 0).verdict).toBe(VERDICT_DRIVEN);
  });
});

describe('a clean subject reports clean, which is what makes a finding mean anything', () => {
  it('exits 0 when one arm calls the root with no substitutes', () => {
    const result = analyse({
      moduleFile: 'm.mjs',
      suiteFile: 'm.test.ts',
      rootName: 'main',
      readFile: sourcesOf({
        'm.mjs':
          'function impl() {}\nexport function main({ a = impl, b = () => 1 } = {}) {}',
        'm.test.ts': [
          "import { main } from './m.mjs';",
          'const dependencies = { a: stub, b: stub };',
          'main(harness.dependencies);',
          'main();',
        ].join('\n'),
      }),
    });
    expect(exitCodeFor(result.classified)).toBe(EXIT_OK);
    expect(result.classified.map((entry) => entry.verdict)).toEqual([
      VERDICT_DRIVEN,
      VERDICT_DRIVEN,
    ]);
  });

  it('exits 2, not 1, when the only evidence is an unresolvable call', () => {
    const result = analyse({
      moduleFile: 'm.mjs',
      suiteFile: 'm.test.ts',
      rootName: 'main',
      readFile: sourcesOf({
        'm.mjs':
          'function impl() {}\nexport function main({ a = impl } = {}) {}',
        'm.test.ts': "import { main } from './m.mjs';\nmain(buildDeps());",
      }),
    });
    expect(exitCodeFor(result.classified)).toBe(EXIT_UNDETERMINED);
  });
});

describe('AN EXCEPTION IS NOT A FINDING', () => {
  it('returns UNDETERMINED, never RELOCATED, when the root is missing', () => {
    // check-required-contexts.mjs shipped with an uncaught throw that exited 1,
    // laundering a crash into the honest-red code, in the tool built to stop
    // exactly that. Exit 1 here means "a default is unreachable" and must never
    // be reachable by failing to run.
    const code = main(
      [
        '--module',
        NPM_CI_STRICT,
        '--suite',
        NPM_CI_STRICT_SUITE,
        '--root',
        'zzqqNotReal',
      ],
      {
        log: () => {},
        error: () => {},
      },
    );
    expect(code).toBe(EXIT_UNDETERMINED);
  });

  it('returns UNDETERMINED when a file cannot be read', () => {
    const code = main(
      ['--module', 'scripts/zzqqNotReal.mjs', '--suite', NPM_CI_STRICT_SUITE],
      {
        log: () => {},
        error: () => {},
      },
    );
    expect(code).toBe(EXIT_UNDETERMINED);
  });

  it('POSITIVE CONTROL: the same entry point returns RELOCATED on the real pair', () => {
    // Without this, the two tests above are satisfied by a main() that returns
    // UNDETERMINED unconditionally.
    const code = main(
      ['--module', NPM_CI_STRICT, '--suite', NPM_CI_STRICT_SUITE],
      {
        log: () => {},
        error: () => {},
      },
    );
    expect(code).toBe(EXIT_RELOCATED);
  });

  it('returns UNDETERMINED, not a throw, when required arguments are missing', () => {
    expect(main([], { log: () => {}, error: () => {} })).toBe(
      EXIT_UNDETERMINED,
    );
  });

  it('runMain throws on a bad argument, and main is the layer that converts it', () => {
    expect(() =>
      runMain(['--nope'], { log: () => {}, error: () => {} }),
    ).toThrow(/unknown argument/);
    expect(main(['--nope'], { log: () => {}, error: () => {} })).toBe(
      EXIT_UNDETERMINED,
    );
  });
});

describe('argument parsing', () => {
  it('defaults the root to main', () => {
    expect(parseArgs(['--module', 'a', '--suite', 'b'])).toEqual({
      module: 'a',
      suite: 'b',
      root: 'main',
      help: false,
    });
  });

  it('rejects a flag whose value is another flag rather than consuming it', () => {
    expect(() => parseArgs(['--module', '--suite'])).toThrow(
      /requires a value/,
    );
  });

  it('rejects an unknown argument rather than silently ignoring it', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
  });

  it('prints usage and exits 0 for --help', () => {
    const lines: string[] = [];
    expect(
      main(['--help'], {
        log: (line: string) => lines.push(line),
        error: () => {},
      }),
    ).toBe(EXIT_OK);
    expect(lines.join('\n')).toContain('--module');
  });
});

describe('the report names the remedy, and the remedy is the one that closes it', () => {
  const result = analyse({
    moduleFile: NPM_CI_STRICT,
    suiteFile: NPM_CI_STRICT_SUITE,
    rootName: 'main',
  });
  const text = formatResult(result);

  it('states how many call sites were resolved, so the reader can see it was proven', () => {
    // Both numbers are derived SEPARATELY, so this still fails if the formatter
    // ever prints "n of n" while some site is unresolved. Deriving `resolved`
    // from `sites.length` instead would make the report agree with itself by
    // construction and assert nothing.
    const total = result.sites.length;
    const resolved = result.sites.filter(
      (site) => site.resolution !== 'unresolved',
    ).length;
    expect(total).toBeGreaterThan(0);
    expect(text).toContain(`${total} call site(s), ${resolved} resolved.`);
  });

  it('DISCRIMINATES: prints the two numbers separately when they differ', () => {
    // Without this arm the previous test is satisfied by a formatter that
    // prints the total TWICE, because every real call site on trunk resolves
    // and so total === resolved for the only input the suite reads. That is an
    // equivalent mutant, and an equivalent mutant is not a passing grade — it
    // is a sign the assertion is reading one number where it claims two.
    // Verified: mutating `resolvedCount` to `sites.length` SURVIVED the whole
    // file until this case existed, and is killed by this case alone.
    const mixed = analyse({
      moduleFile: 'm.mjs',
      suiteFile: 'm.test.ts',
      rootName: 'main',
      readFile: sourcesOf({
        'm.mjs': 'export function main({ a = impl } = {}) {}',
        'm.test.ts':
          "import { main } from './m.mjs';\nmain({});\nmain(whateverThisIs);",
      }),
    });
    const total = mixed.sites.length;
    const resolved = mixed.sites.filter(
      (site) => site.resolution !== 'unresolved',
    ).length;
    expect(total).toBeGreaterThan(resolved);
    expect(formatResult(mixed)).toContain(
      `${total} call site(s), ${resolved} resolved.`,
    );
  });

  it('offers running the root with no substitutes, not merely "add a test"', () => {
    expect(text).toContain('no');
    expect(text).toContain('substitutes at all');
  });

  it('says nothing about a remedy when there is nothing to remedy', () => {
    const clean = analyse({
      moduleFile: 'm.mjs',
      suiteFile: 'm.test.ts',
      rootName: 'main',
      readFile: sourcesOf({
        'm.mjs': 'export function main({ a = impl } = {}) {}',
        'm.test.ts': "import { main } from './m.mjs';\nmain();",
      }),
    });
    expect(formatResult(clean)).not.toContain('substitutes at all');
  });
});
