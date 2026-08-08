#!/usr/bin/env node
/**
 * seam:injected-defaults — for every dependency a composition root injects,
 * decide what executes its DEFAULT.
 *
 * WHY THIS EXISTS
 *
 * Issue #360 found that `scripts/npm-ci-strict.mjs` had a `main()` no test
 * could reach, so three mutations that deleted whole production gates left the
 * suite green. The remedy landed: `main` is exported and the suite now calls it
 * six times, and a re-run showed all three seams reddening. That part is fixed.
 *
 * The remedy was applied by INJECTION — `main` takes its collaborators as
 * destructured parameters with defaults, and each test supplies substitutes.
 * A comment on that same issue predicted the consequence and it is worth
 * quoting because it is the whole subject of this file:
 *
 *   "Injecting a collaborator to make its caller testable makes the
 *    collaborator itself untested. The seam does not close; it moves down one
 *    level, to whatever is on the far side of the new injection boundary."
 *
 * That prediction was made against a CLOSED branch. It is true on trunk today.
 * The issue also names the tell, and names it as something to be asked rather
 * than run:
 *
 *   "For every dependency you inject, ask what now executes its default."
 *
 * An instruction to ask a question is a commitment. This is the question asked
 * by a command instead. That is the entire delta.
 *
 * WHAT IT MEASURES
 *
 * A default is executable by the suite through exactly two routes, and both
 * have to be checked because each is silent about the other:
 *
 *   DRIVEN  the suite calls the root and OMITS the key, so the default runs.
 *   DIRECT  the default is a named binding, the module exports it, and the
 *           suite imports it — so the suite can run it without the root.
 *
 * Neither route ⇒ the default is unreachable: it ships, and nothing in the
 * suite has ever executed it. That is a relocated seam, not a covered one.
 *
 * WHY BOTH ROUTES, AND WHY AN IMPORT SURFACE IS NOT ENOUGH
 *
 * #360's own static leg — "is the entry point on the module's import surface" —
 * was correctly red before the remedy and went green after it, while the three
 * seams it was standing in for had not yet been shown to redden. The import
 * surface answers "is this symbol importable". It is read as "is this code
 * reached". Those are neighbouring questions and they render identically.
 * So `DIRECT` here is necessary evidence and never sufficient on its own, and
 * `DRIVEN` is checked independently rather than inferred from it.
 *
 * THE DIRECTION THIS ERRS IN, DELIBERATELY
 *
 * When a call site's argument cannot be resolved, this does NOT assume the key
 * was omitted. Assuming omission would manufacture a `DRIVEN` verdict out of
 * ignorance — a false "still covered", which is the failure this file exists to
 * detect, committed by the detector. Unresolvable sites produce UNDETERMINED
 * for the deps they could have settled. Over-reporting costs one re-derivation;
 * under-reporting costs a false clean bill.
 *
 * EXIT CODES
 *
 *   0  OK               every injected default is DRIVEN or DIRECT
 *   1  RELOCATED        at least one injected default is provably unreachable
 *   2  UNDETERMINED     nothing was proven unreachable and something is unresolved
 *   3  ROOT_NOT_DRIVEN  --root names a function that exists, injects no
 *                       defaults of its own, and the suite has zero call
 *                       sites reaching it
 *
 * RELOCATED outranks UNDETERMINED. The reasoning is the one pinned in
 * check-merge-landed.mjs: a dependency this tool could not resolve says nothing
 * about a dependency it proved unreachable. A proven finding is not weakened by
 * an adjacent unknown. This ordering is asserted by a test, not left to reading.
 *
 * WHY ROOT_NOT_DRIVEN IS ITS OWN CODE, AND WHY IT IS NARROWER THAN "ZERO CALL
 * SITES" (#549)
 *
 * `--root` defaults to `main`, and a module can genuinely define a `main` that
 * exists, is syntactically well-formed, and is simply not the composition root
 * the suite drives — `scripts/sign-macos-release.mjs` is exactly this: its
 * `main()` takes no injected parameters at all, so zero call sites for `main`
 * in the suite reported `0 call site(s), 0 resolved` at exit 0, indistinguishable
 * from a module with nothing to report. The real root, `signMacRelease`, has
 * three UNREACHABLE defaults under the same suite.
 *
 * The guard is NOT "zero call sites", though — that would be too wide. DIRECT
 * coverage (above) proves a default reachable WITHOUT the suite ever calling
 * the root at all: the default is a named export the suite imports and calls
 * directly. A root with injected defaults and zero call sites still produces
 * one real verdict per default from `classifyDefaults` — DIRECT where the
 * suite imports the default, UNREACHABLE where it does not — and that is
 * correct, provable output, not silence. The failure this exit code targets is
 * narrower and sharper: `defaults.length === 0` as well, so `classified` is
 * vacuously `[]` and `exitCodeFor([])` is EXIT_OK by construction, with
 * nothing underneath that verdict at all.
 *
 * A root that does not exist already fails loudly, at exit 2, by throwing out of
 * `findCompositionRoot`. A root that exists, injects nothing, and the suite
 * never calls is a different fact and must not collapse into the same code: it
 * says the suite never drives this root, not merely that something about it
 * could not be resolved. That is exit 3, and it names the root and the module
 * in the message, so the fix is "point --root at what the suite calls", not
 * "add an override somewhere".
 *
 * PARSER CHOICE
 *
 * `@typescript-eslint/parser` is used for BOTH the module and the suite. It is a
 * declared devDependency; `acorn` and `espree` are present in node_modules only
 * as transitive dependencies of eslint, and a tool that reaches into another
 * package's transitive tree breaks on a dedupe that changes nothing else.
 *
 * DOMAIN — what this does NOT establish
 *
 * It answers "can the suite execute this default", by import and by omission.
 * It does not answer "does executing it assert anything", which is the rung
 * above and is the one #360 spent its length on. A default that is DRIVEN by a
 * test making no assertion about it reads as OK here. This is a necessary
 * condition made checkable, offered as exactly that.
 *
 * It is also static. A default reached only through `spawnSync` of the script,
 * through a re-export chain, or through a renamed/re-assigned local alias of
 * the root (`import { main as run } from './m.mjs'; run();`), is invisible
 * here and will be reported unreachable. All three are over-reports, in the
 * direction chosen above — see the note on `findCallSites` for why alias
 * tracking was tried and deliberately reverted.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@typescript-eslint/parser';

export const EXIT_OK = 0;
export const EXIT_RELOCATED = 1;
export const EXIT_UNDETERMINED = 2;
export const EXIT_ROOT_NOT_DRIVEN = 3;

/**
 * Thrown by analyse() when --root names a function that EXISTS in the module
 * but the suite has zero call sites reaching it. This is deliberately a
 * distinct class from a plain Error: `main()` catches both, but a missing root
 * (findCompositionRoot returns null) is a different fact from an existing root
 * the suite never drives, and the two must not share an exit code (#549) or a
 * reader loses the one piece of information that tells them what to fix.
 */
export class RootNotDrivenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RootNotDrivenError';
  }
}

export const VERDICT_DRIVEN = 'DRIVEN';
export const VERDICT_DIRECT = 'DIRECT';
export const VERDICT_UNREACHABLE = 'UNREACHABLE';
export const VERDICT_UNDETERMINED = 'UNDETERMINED';

/**
 * TS wraps object literals in `satisfies` / `as` nodes. `main`'s own test
 * harness ends in `} satisfies Partial<MainDependencies>`, so a resolver that
 * does not unwrap these reports every real call site as unresolvable — and then
 * reports UNDETERMINED for a file it could have settled completely.
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSInstantiationExpression')
  ) {
    current = current.expression;
  }
  return current;
}

function isNode(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof value.type === 'string'
  );
}

/** Depth-first walk with no external dependency. Visits every AST node once. */
export function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value) || isNode(value)) walk(value, visit);
  }
}

export function parseSource(source, filename) {
  return parse(source, {
    sourceType: 'module',
    loc: true,
    range: false,
    filePath: filename,
    ecmaFeatures: { jsx: false },
  });
}

/** Named exports, resolved from declarations and from `export { a, b }` alike. */
export function namedExports(ast) {
  const names = new Set();
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const declaration = node.declaration;
    if (declaration) {
      if (declaration.id?.type === 'Identifier') names.add(declaration.id.name);
      for (const one of declaration.declarations ?? []) {
        if (one.id.type === 'Identifier') names.add(one.id.name);
      }
    }
    for (const specifier of node.specifiers ?? []) {
      const exported = specifier.exported;
      if (exported?.type === 'Identifier') names.add(exported.name);
    }
  }
  return names;
}

/**
 * Symbols the suite imports FROM the module under test, matched by resolved
 * path rather than by specifier text: '../scripts/x.mjs' and './x.mjs' are the
 * same module read from two files, and a string comparison says they are not.
 */
export function importedFrom(ast, suitePath, modulePath) {
  const target = path.resolve(modulePath);
  const fromDir = path.dirname(path.resolve(suitePath));
  const names = new Set();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const specifier = node.source.value;
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
    if (path.resolve(fromDir, specifier) !== target) continue;
    for (const one of node.specifiers ?? []) {
      if (
        one.type === 'ImportSpecifier' &&
        one.imported?.type === 'Identifier'
      ) {
        names.add(one.imported.name);
      }
    }
  }
  return names;
}

/**
 * Local names in the suite that can invoke `rootName`, accounting for a
 * renamed import.
 *
 * `import { main as run } from './m.mjs'; run();` calls `main` under the
 * local name `run`. Tried and DELIBERATELY REVERTED: see the note on
 * `findCallSites` for why a flat name-based alias set is the wrong shape for
 * this and was pulled out again.
 */
/** The exported function `rootName`, or null. */
export function findCompositionRoot(ast, rootName) {
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === rootName) {
      found = node;
      return;
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === rootName
    ) {
      const init = unwrap(node.init);
      if (
        init &&
        (init.type === 'ArrowFunctionExpression' ||
          init.type === 'FunctionExpression')
      ) {
        found = init;
      }
    }
  });
  return found;
}

/**
 * The injected defaults: the first parameter's destructured properties that
 * carry a default. A property with no default is a REQUIRED collaborator — it
 * has no default to be unreachable, so it is not a subject here and is not
 * reported as a finding.
 */
export function readInjectedDefaults(rootNode) {
  const first = rootNode?.params?.[0];
  const pattern = first?.type === 'AssignmentPattern' ? first.left : first;
  if (!pattern || pattern.type !== 'ObjectPattern') return [];
  const defaults = [];
  for (const property of pattern.properties) {
    if (property.type !== 'Property') continue;
    if (property.value.type !== 'AssignmentPattern') continue;
    const key = property.key?.type === 'Identifier' ? property.key.name : null;
    if (!key) continue;
    const right = unwrap(property.value.right);
    const isIdentifier = right?.type === 'Identifier';
    defaults.push({
      key,
      defaultKind: isIdentifier ? 'identifier' : 'inline',
      defaultName: isIdentifier ? right.name : null,
      line: property.loc?.start?.line ?? null,
    });
  }
  return defaults;
}

function objectKeys(objectExpression) {
  const keys = new Set();
  for (const property of objectExpression.properties) {
    if (property.type === 'SpreadElement') return null; // a spread can supply anything
    if (property.type !== 'Property') return null;
    if (property.computed) return null; // a computed key is not statically known
    const name =
      property.key.type === 'Identifier'
        ? property.key.name
        : property.key.type === 'Literal'
          ? String(property.key.value)
          : null;
    if (name === null) return null;
    keys.add(name);
  }
  return keys;
}

/**
 * Object literals bound to a name, indexed by name, but ONLY where the name is
 * bound exactly once. `harness.dependencies` is resolved through the unique
 * `const dependencies = {...}` in the same file. Uniqueness is required rather
 * than preferred: with two bindings of one name there is no evidence which one
 * a member expression reached, and picking either is a guess rendered as a fact.
 */
export function uniqueObjectBindings(ast) {
  const counts = new Map();
  const bindings = new Map();
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (node.id?.type !== 'Identifier') return;
    const name = node.id.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const init = unwrap(node.init);
    if (init?.type === 'ObjectExpression') bindings.set(name, init);
  });
  const unique = new Map();
  for (const [name, literal] of bindings) {
    if (counts.get(name) === 1) unique.set(name, literal);
  }
  return unique;
}

/**
 * Every call of `rootName`, by its literal identifier only, with the keys its
 * argument supplies.
 *
 * Ripley's review of #549 found that this only matches the literal
 * identifier `rootName`, so a renamed import (`import { main as run } from
 * './m.mjs'; run();`) is invisible to it: the call is real, but the
 * unaliased match here does not see it. A `resolveCallNames`/aliased-set
 * variant was tried against that finding and reverted — Ripley's own
 * follow-up review (a transitive `const alsoRun = run; alsoRun();` alias hop
 * the wider set still missed) and Vasquez's follow-up (a local `const run =
 * () => {}` REDECLARATION after `import { main as run }`, which the flat
 * name set could not tell apart from the import and so counted as DRIVEN
 * when `main` is never actually called) both showed that a name-based alias
 * set cannot be partially correct here: it either needs full scope-aware
 * binding resolution (tracking, for every identifier, which declaration it
 * currently resolves to at the point of each call — a small type-checker,
 * not a tool addition) or it reproduces the exact false-clean failure this
 * file exists to prevent. The literal-name match over-reports an aliased
 * call as unreachable — the same accepted, documented direction as the
 * `spawnSync`/re-export-chain limitations above — rather than under-report a
 * shadowed rebind as driven.
 *
 * resolution:
 *   'none'       called with no argument   -> every default runs
 *   'literal'    an inline object literal
 *   'indirect'   an identifier or `x.y` resolved to a unique object literal
 *   'unresolved' anything else             -> settles nothing, in either direction
 */
export function findCallSites(ast, rootName) {
  const bindings = uniqueObjectBindings(ast);
  const sites = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!(callee.type === 'Identifier' && callee.name === rootName)) return;
    const line = node.loc?.start?.line ?? null;
    if (node.arguments.length === 0) {
      sites.push({ line, resolution: 'none', keys: new Set() });
      return;
    }
    const argument = unwrap(node.arguments[0]);
    if (argument?.type === 'ObjectExpression') {
      const keys = objectKeys(argument);
      sites.push(
        keys === null
          ? { line, resolution: 'unresolved', keys: null }
          : { line, resolution: 'literal', keys },
      );
      return;
    }
    let name = null;
    if (argument?.type === 'Identifier') name = argument.name;
    else if (
      argument?.type === 'MemberExpression' &&
      !argument.computed &&
      argument.property?.type === 'Identifier'
    ) {
      name = argument.property.name;
    }
    const literal = name === null ? undefined : bindings.get(name);
    if (!literal) {
      sites.push({ line, resolution: 'unresolved', keys: null });
      return;
    }
    const keys = objectKeys(literal);
    sites.push(
      keys === null
        ? { line, resolution: 'unresolved', keys: null }
        : { line, resolution: 'indirect', keys },
    );
  });
  return sites;
}

/**
 * PURE over already-resolved facts, so every verdict is drivable from a plain
 * object. #425 shipped a classifier with an arm no real input could provoke and
 * deleting it broke nothing; the fix there, and the shape here, is to keep the
 * judgement separable from the collection.
 */
export function classifyDefaults({
  defaults,
  exports: exportedNames,
  imported,
  sites,
}) {
  const resolved = sites.filter((site) => site.resolution !== 'unresolved');
  const anyUnresolved = sites.length !== resolved.length;
  return defaults.map((entry) => {
    if (
      entry.defaultKind === 'identifier' &&
      exportedNames.has(entry.defaultName) &&
      imported.has(entry.defaultName)
    ) {
      return {
        ...entry,
        verdict: VERDICT_DIRECT,
        why: `the suite imports ${entry.defaultName}`,
      };
    }
    const omitting = resolved.find((site) => !site.keys.has(entry.key));
    if (omitting) {
      return {
        ...entry,
        verdict: VERDICT_DRIVEN,
        why: `the call at line ${omitting.line} omits it, so the default runs`,
      };
    }
    if (anyUnresolved) {
      return {
        ...entry,
        verdict: VERDICT_UNDETERMINED,
        why: 'every resolved call overrides it and some calls could not be resolved',
      };
    }
    return {
      ...entry,
      verdict: VERDICT_UNREACHABLE,
      why:
        entry.defaultKind === 'inline'
          ? 'the default is an inline expression, so no import can reach it, and every call overrides it'
          : `${entry.defaultName} is not on the suite's import surface, and every call overrides it`,
    };
  });
}

export function exitCodeFor(classified) {
  if (classified.some((entry) => entry.verdict === VERDICT_UNREACHABLE))
    return EXIT_RELOCATED;
  if (classified.some((entry) => entry.verdict === VERDICT_UNDETERMINED))
    return EXIT_UNDETERMINED;
  return EXIT_OK;
}

export function formatResult({
  moduleFile,
  suiteFile,
  rootName,
  classified,
  sites,
}) {
  const lines = [];
  const width = Math.max(4, ...classified.map((entry) => entry.key.length));
  lines.push(`${rootName}() in ${moduleFile}, as driven by ${suiteFile}`);
  lines.push('');
  for (const entry of classified) {
    lines.push(
      `  ${entry.verdict.padEnd(13)}${entry.key.padEnd(width + 2)}${entry.why}`,
    );
  }
  lines.push('');
  const resolvedCount = sites.filter(
    (site) => site.resolution !== 'unresolved',
  ).length;
  lines.push(`  ${sites.length} call site(s), ${resolvedCount} resolved.`);
  const unreachable = classified.filter(
    (entry) => entry.verdict === VERDICT_UNREACHABLE,
  );
  if (unreachable.length > 0) {
    lines.push('');
    lines.push(
      `  ${unreachable.length} injected default(s) ship and are executed by nothing in this suite.`,
    );
    lines.push(
      '  Injecting a collaborator to make its caller testable does not cover the collaborator.',
    );
    lines.push(
      '  Export the default and exercise it, or add one arm that calls the root with no',
    );
    lines.push(
      '  substitutes at all, so the wiring that actually ships runs once.',
    );
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = { module: null, suite: null, root: 'main', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (
      argument === '--module' ||
      argument === '--suite' ||
      argument === '--root'
    ) {
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const USAGE = [
  'Usage: node scripts/check-injected-defaults.mjs --module <file> --suite <file> [--root main]',
  '',
  'For every dependency the composition root injects, decide what executes its default.',
  '  exit 0  every injected default is driven by a call that omits it, or imported directly',
  '  exit 1  at least one injected default is provably unreachable from the suite',
  '  exit 2  nothing proven unreachable and at least one call site could not be resolved',
  '  exit 3  --root names a function that exists but injects nothing, and the suite never calls it',
].join('\n');

export function analyse({
  moduleFile,
  suiteFile,
  rootName,
  readFile = readFileSync,
}) {
  const moduleSource = String(readFile(moduleFile, 'utf8'));
  const suiteSource = String(readFile(suiteFile, 'utf8'));
  const moduleAst = parseSource(moduleSource, moduleFile);
  const suiteAst = parseSource(suiteSource, suiteFile);
  const rootNode = findCompositionRoot(moduleAst, rootName);
  if (!rootNode) {
    throw new Error(`${rootName} is not defined in ${moduleFile}`);
  }
  const defaults = readInjectedDefaults(rootNode);
  const sites = findCallSites(suiteAst, rootName);
  if (sites.length === 0 && defaults.length === 0) {
    // #549: `rootName` exists — it parsed, it has a body — but the suite has
    // zero call sites that reach it, AND the root injects no defaults at all.
    // That combination is NOT the same fact as "nothing was proven
    // unreachable": it means this run proves nothing whatsoever about the
    // module, because `classified` is vacuously `[]` and `exitCodeFor([])` is
    // EXIT_OK — a clean bill for a module nobody exercised under this root.
    //
    // This guard is deliberately narrower than "zero call sites": when
    // `defaults.length > 0`, classifyDefaults() below still produces one
    // verdict per default even with zero call sites, and DIRECT is exactly
    // the supported route that proves coverage WITHOUT the suite ever calling
    // the root — a default that is exported by the module and imported by the
    // suite directly. Refusing on `sites.length === 0` alone would reject that
    // legitimate, documented case (see the file banner's DIRECT route, and
    // classifyDefaults()'s DIRECT arm) along with the genuinely vacuous one.
    // Only the truly empty verdict list — nothing to classify AND nothing
    // called — is refused here.
    throw new RootNotDrivenError(
      `${rootName} exists in ${moduleFile}, but ${suiteFile} has 0 call sites ` +
        `that reach it, and ${rootName} injects no defaults for DIRECT ` +
        `coverage to apply to. Zero call sites is not evidence ${rootName} is ` +
        'clean — the suite never drives this root at all. Pass --root naming ' +
        'the function the suite actually calls.',
    );
  }
  const classified = classifyDefaults({
    defaults,
    exports: namedExports(moduleAst),
    imported: importedFrom(suiteAst, suiteFile, moduleFile),
    sites,
  });
  return { moduleFile, suiteFile, rootName, defaults, sites, classified };
}

export function runMain(
  argv,
  { log = console.log, error = console.error } = {},
) {
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT_OK;
  }
  if (!options.module || !options.suite) {
    error('--module and --suite are both required.');
    error(USAGE);
    return EXIT_UNDETERMINED;
  }
  const result = analyse({
    moduleFile: options.module,
    suiteFile: options.suite,
    rootName: options.root,
  });
  log(formatResult(result));
  return exitCodeFor(result.classified);
}

/**
 * An uncaught throw exits 1, and 1 here means "a default is unreachable" — a
 * crash would be laundered into a real finding by the tool built to report one.
 * check-required-contexts.mjs shipped with exactly that defect and it was found
 * only by running it against an unresolvable input.
 */
export function main(argv, io) {
  const error = io?.error ?? console.error;
  try {
    return runMain(argv, io);
  } catch (caught) {
    error(`check-injected-defaults: ${caught.message}`);
    // A RootNotDrivenError is a different fact from every other throw here — a
    // missing root, a bad argument, an unreadable file — which all say "this
    // run proved nothing, for a reason unrelated to the root's reachability".
    // ROOT_NOT_DRIVEN says specifically "the root exists and the suite never
    // reaches it", and #549 is exactly the defect of collapsing that into the
    // same code as everything else, so it must not share EXIT_UNDETERMINED.
    if (caught instanceof RootNotDrivenError) {
      return EXIT_ROOT_NOT_DRIVEN;
    }
    return EXIT_UNDETERMINED;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
