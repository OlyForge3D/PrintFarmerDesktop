// #270. An optional class field meant as a prototype-patchable capability
// seam is silently inert under this project's `useDefineForClassFields`
// (ES2022 target): TypeScript emits a per-instance own property initialised
// to `undefined` for every plain field declaration, which shadows whatever
// gets assigned to the class prototype afterwards. `typeof
// instance.someSeam === 'function'` then reports `false` forever, with
// typecheck, lint, and the whole test suite green, because nothing about that
// state is a type error or a lint violation -- it is a fact about the ES2022
// class-fields spec that only shows up at runtime.
//
// `src/main/calibrationService.ts` shipped exactly this shape:
//
//   readonly resolveCalibrationConflict?: (...) => Promise<...>;
//
// and was fixed by turning the capability into a real prototype method
// instead (`async resolveCalibrationConflict(...) { ... }` on
// `SidecarCalibrationAdapter`). A `declare`d field would have worked too --
// `declare` tells TypeScript the field is defined elsewhere and suppresses
// the emitted own-property entirely -- but nothing stopped a later edit from
// quietly dropping the `declare` and reintroducing the exact bug, silently,
// because removing one keyword from a field declaration is invisible to
// typecheck, lint, and every test that only exercises the capability-absent
// path (see tests/calibration.availability-negotiation.test.ts's
// "the refusal is derived from the absent capability, not asserted" block,
// added alongside the same fix, for the counterfactual shape that DOES
// notice).
//
// This check is the general guard: it finds every class field declaration in
// `src/` that has the exact shape of a prototype-patchable seam --
//
//   - optional (`?`),
//   - function-typed (the only kind of field a caller "activates" by
//     assigning a callable) -- determined via the real TypeScript type
//     checker, not name-based AST heuristics (see below),
//   - not `declare`d,
//   - not `static` (statics live on the constructor function, not instances,
//     and are unaffected by useDefineForClassFields),
//   - never assigned by the class's own constructor or methods (a field the
//     class assigns to itself is an ordinary optional field, not a seam
//     waiting for an external patch) --
//
// and fails. The fix at each flagged site is either `declare` the field (if
// something outside the class really does assign it directly, e.g. a test
// harness patching the prototype) or turn it into a real method/getter on the
// prototype (as calibrationService.ts now does), which sidesteps
// useDefineForClassFields entirely because methods are never instance own
// properties.
//
// PR #706 review history (why this uses the real type checker, not AST
// name-matching): the first version resolved "is this field function-typed"
// by walking the type annotation's AST and, for a named type, looking up a
// same-file type alias or interface declaration by name. Reviewers (Ripley,
// Vasquez, Bishop) found this kept missing real #270 shapes one edge case at
// a time -- a callable type alias, a callable interface, `typeof
// someFunction`, `typeof` on an *imported* function, and finally a genuine
// false positive where an out-of-scope callable happened to share a name
// with an in-scope non-callable binding (name-based lookup has no concept of
// lexical scope, so it can match the wrong binding entirely). Each fix
// closed one gap and reviewers kept finding the next, because the underlying
// approach -- matching identifiers by text across the whole file -- can
// never be complete: real scoping and cross-file symbol resolution is
// exactly what a type checker exists to do. Rather than add a fourth
// special case, this now builds a real `ts.Program` and asks its
// `TypeChecker` whether the field's annotated type has call signatures
// (`isCallableType`, below). That single check correctly and simultaneously
// handles inline function types, type aliases, callable interfaces,
// `typeof` on any in-scope binding (local or imported), unions of the above,
// and lexical scoping/shadowing -- because it is the same resolution
// TypeScript itself uses, not a re-implementation of a slice of it.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Lists every TypeScript source file tracked under `src/` in the given repo
 * root, via `git ls-files` rather than a filesystem walk -- consistent with
 * how this script's siblings enumerate a "population" (see
 * check-test-narrowing.mjs's `tests/` enumeration), and it naturally skips
 * anything gitignored (build output, `native/` bindings) without a bespoke
 * ignore list to keep in sync.
 */
export function listSourceFiles(repoRoot) {
  // `src/**/*.ts` alone misses root-level `src/*.ts` files: git's pathspec
  // glob treats `**` as requiring at least one full directory segment, so it
  // does not also match zero segments the way some other glob dialects do.
  // Pass both the nested and root-level patterns explicitly rather than
  // relying on `**` to cover both -- a scan that silently skips files it
  // should have scanned is exactly the #270-shaped failure mode this check
  // exists to prevent (a clean result must mean "genuinely nothing found",
  // never "some inputs were never looked at").
  const output = execFileSync(
    'git',
    ['ls-files', '--', 'src/**/*.ts', 'src/**/*.tsx', 'src/*.ts', 'src/*.tsx'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return Array.from(
    new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function isDeclareField(member) {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    )
  );
}

function isStaticField(member) {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    )
  );
}

/**
 * True if a checker-resolved `Type` is callable -- has at least one call
 * signature -- including through a union (e.g. `(() => void) | undefined`,
 * or a named union type alias): a union type is callable here if *any*
 * member is, since assigning a callable to the prototype only needs one
 * arm of the union to be a function for `typeof field === 'function'` to
 * become observable.
 *
 * This single function is what replaced the earlier name-based AST walk
 * (resolving type aliases, callable interfaces, and `typeof` queries by
 * text-matching identifiers across the file). The checker already resolves
 * type aliases, interfaces, `typeof` on any in-scope binding (including
 * imports), and lexical scoping correctly, because that is its job --
 * asking it directly is both simpler and strictly more correct than
 * re-implementing a slice of TypeScript's own name resolution.
 */
function isCallableType(type) {
  if (type.getCallSignatures().length > 0) return true;
  if (type.isUnion()) {
    return type.types.some((member) => isCallableType(member));
  }
  return false;
}

/**
 * True if a node is an ObjectLiteralExpression property (init, shorthand, or
 * method) whose key text equals `fieldName`, OR a spread element -- a spread
 * (`...rest`) could bring in a property with any name, so it is treated as a
 * potential match rather than assumed not to assign `fieldName`.
 */
function objectLiteralAssignsProperty(objectLiteral, fieldName, sourceFile) {
  return objectLiteral.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true;
    const name = property.name;
    if (!name) return false;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.getText(sourceFile) === fieldName;
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text === fieldName;
    }
    // Computed key, e.g. `[someExpr]: value` -- cannot statically resolve
    // the key text, so treat it as a potential match rather than a
    // definite non-match (see module doc: absence of a finding must mean
    // "genuinely not found", not "we didn't look here").
    return true;
  });
}

/**
 * True if the class body assigns `fieldName` to itself anywhere in its own
 * constructor or methods. A field the class assigns to itself is managed
 * internally (an ordinary optional callback threaded through a constructor
 * argument, for instance) and is not the "nothing here ever sets this except
 * an external patch" shape this check exists to catch.
 *
 * Recognises three assignment shapes, since all three are ordinary,
 * self-managed field writes rather than external prototype patches:
 *   - `this.foo = ...`               (dotted property access)
 *   - `this['foo'] = ...`            (bracket / computed property access,
 *                                     including a computed key that cannot
 *                                     be statically resolved -- treated as a
 *                                     potential match to avoid a false
 *                                     positive)
 *   - `Object.assign(this, { foo: ... })` (and any `Object.assign(this, ...)`
 *     call with a spread or computed key among its source objects, treated
 *     as a potential match for the same reason)
 */
function isSelfAssigned(classNode, fieldName, sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left } = node;
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        left.name.getText(sourceFile) === fieldName
      ) {
        found = true;
        return;
      }
      if (
        ts.isElementAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const argument = left.argumentExpression;
        if (ts.isStringLiteralLike(argument) && argument.text === fieldName) {
          found = true;
          return;
        }
        if (
          !ts.isStringLiteralLike(argument) &&
          !ts.isNumericLiteral(argument)
        ) {
          // A non-literal computed key, e.g. `this[key] = ...` -- cannot
          // statically resolve which property it targets, so treat as a
          // potential match rather than assume it is unrelated.
          found = true;
          return;
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === 'Object' &&
      node.expression.name.getText(sourceFile) === 'assign' &&
      node.arguments.length > 0 &&
      node.arguments[0].kind === ts.SyntaxKind.ThisKeyword
    ) {
      const sources = node.arguments.slice(1);
      const matches = sources.some(
        (source) =>
          ts.isObjectLiteralExpression(source)
            ? objectLiteralAssignsProperty(source, fieldName, sourceFile)
            : true, // non-literal source (e.g. a spread variable) -- potential match
      );
      if (matches) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const member of classNode.members) {
    if (
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      if (member.body) visit(member.body);
    }
    if (found) break;
  }
  return found;
}

/**
 * Finds every inert-seam candidate in one already-typechecked source file,
 * given the `TypeChecker` of the `Program` it belongs to.
 *
 * `displayPath` is used only for the returned violations' `file` field --
 * callers pass a repo-relative path for real files, or the original fixture
 * name in tests, independent of whatever virtual/absolute path the file
 * lives at inside the `Program`.
 */
function findSeamViolationsInSourceFile(sourceFile, checker, displayPath) {
  const violations = [];

  const visitClass = (classNode) => {
    for (const member of classNode.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      if (!member.questionToken) continue;
      if (member.initializer) continue;
      if (isDeclareField(member)) continue;
      if (isStaticField(member)) continue;
      if (!member.type) continue;
      const resolvedType = checker.getTypeFromTypeNode(member.type);
      if (!isCallableType(resolvedType)) continue;
      if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name))
        continue;
      const fieldName = member.name.getText(sourceFile);
      if (isSelfAssigned(classNode, fieldName, sourceFile)) continue;

      const { line } = sourceFile.getLineAndCharacterOfPosition(
        member.getStart(sourceFile),
      );
      violations.push({
        file: displayPath,
        line: line + 1,
        name: fieldName,
        typeText: member.type.getText(sourceFile),
      });
    }
  };

  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClass(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

const VIRTUAL_ROOT = '/virtual-inert-seam-check';
const VIRTUAL_COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
};

function toVirtualPath(relativePath) {
  return path.posix.join(VIRTUAL_ROOT, relativePath.replace(/\\/g, '/'));
}

/**
 * A `ts.CompilerHost` that serves a small in-memory set of files (a fixture
 * under test, plus any files it imports) and falls back to the real
 * filesystem for everything else (lib.d.ts and friends), via
 * `ts.createCompilerHost`. This is what lets `findInertSeamCandidates` run
 * a real type-checking `Program` -- and so get real scope/symbol resolution
 * for callable-type detection -- without needing the fixture to be written
 * to disk as part of the actual repository tree.
 */
function createVirtualHost(virtualFiles) {
  const realHost = ts.createCompilerHost(VIRTUAL_COMPILER_OPTIONS, true);
  // Every ancestor directory of a virtual file, so `directoryExists` (which
  // module resolution consults, e.g. before probing for a sibling
  // package.json) reports the virtual tree as present -- it does not exist
  // on the real filesystem, and a `false` here can short-circuit resolution
  // of a perfectly valid relative import between two virtual files.
  const virtualDirectories = new Set();
  for (const fileName of virtualFiles.keys()) {
    let directory = path.posix.dirname(fileName);
    while (directory && directory !== '/' && directory !== '.') {
      virtualDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  return {
    ...realHost,
    fileExists(fileName) {
      return virtualFiles.has(fileName) || realHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (virtualFiles.has(fileName)) return virtualFiles.get(fileName);
      return realHost.readFile(fileName);
    },
    directoryExists(directoryName) {
      return (
        virtualDirectories.has(directoryName) ||
        (realHost.directoryExists?.(directoryName) ?? false)
      );
    },
    getSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    ) {
      if (virtualFiles.has(fileName)) {
        const languageVersion =
          typeof languageVersionOrOptions === 'object'
            ? languageVersionOrOptions.languageVersion
            : languageVersionOrOptions;
        const scriptKind = fileName.endsWith('.tsx')
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS;
        return ts.createSourceFile(
          fileName,
          virtualFiles.get(fileName),
          languageVersion,
          true,
          scriptKind,
        );
      }
      return realHost.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };
}

/**
 * Finds every inert-seam candidate in one source file's text, using a real
 * (small, in-memory) `ts.Program` and its `TypeChecker` -- see the module
 * doc for why this replaced pure AST name-matching.
 *
 * `additionalFiles` is an optional map of `{ relativePath: sourceText }` for
 * any files `filePath` imports (via a relative specifier resolved next to
 * it in the same virtual directory), so a fixture can exercise cross-file
 * resolution -- e.g. `typeof` on an imported function -- without needing a
 * second file on disk.
 *
 * Returns `[]` for a file with no such shape -- callers should not read an
 * empty array as "the file was not actually parsed"; a parse failure throws
 * instead of returning an empty result, so absence here is a genuine finding
 * of zero, not a silent skip (the #182/#270 shape this repo keeps naming: an
 * unreadable input must not report the same result as a readable one that
 * found nothing).
 */
export function findInertSeamCandidates(
  filePath,
  sourceText,
  additionalFiles = {},
) {
  const mainVirtualPath = toVirtualPath(filePath);
  const virtualFiles = new Map();
  virtualFiles.set(mainVirtualPath, sourceText);
  for (const [relativePath, text] of Object.entries(additionalFiles)) {
    virtualFiles.set(toVirtualPath(relativePath), text);
  }

  const host = createVirtualHost(virtualFiles);
  const program = ts.createProgram({
    rootNames: [...virtualFiles.keys()],
    options: VIRTUAL_COMPILER_OPTIONS,
    host,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(mainVirtualPath);

  return findSeamViolationsInSourceFile(sourceFile, checker, filePath);
}

export function formatViolation(violation) {
  return (
    `${violation.file}:${violation.line}  ` +
    `${violation.name}?: ${violation.typeText}\n` +
    `  This field is optional, function-typed, not \`declare\`d, and never\n` +
    `  assigned by its own class -- the exact shape of the #270 seam that\n` +
    `  \`useDefineForClassFields\` (ES2022 target) silently makes inert:\n` +
    `  TypeScript emits an own \`undefined\` property on every instance,\n` +
    `  which shadows whatever a caller assigns to the prototype afterwards.\n` +
    `  Fix by either turning it into a real method/getter on the prototype\n` +
    `  (assign a callable there instead of declaring a field), or by adding\n` +
    `  \`declare\` if something outside the class truly assigns the field\n` +
    `  directly.`
  );
}

/**
 * Scans the real repository tree: builds one real `ts.Program` from the
 * project's own `tsconfig.json` (so path mappings like `@shared/*` and real
 * cross-file/module imports resolve exactly as they do for `npm run
 * typecheck`), rooted at every file `listSourceFiles` reports, then runs
 * the same seam-detection pass against each of those files' `SourceFile`
 * from that program.
 */
export function scanRepository(repoRoot) {
  const files = listSourceFiles(repoRoot);
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    repoRoot,
  );
  const rootNames = files.map((relativePath) =>
    path.join(repoRoot, relativePath),
  );
  const program = ts.createProgram({
    rootNames,
    options: parsedConfig.options,
  });
  const checker = program.getTypeChecker();

  const violations = [];
  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, relativePath);
    const sourceFile = program.getSourceFile(absolutePath);
    if (!sourceFile) {
      // Every file here was passed as a Program root name; if the Program
      // does not have a SourceFile for it, something is badly wrong with
      // config resolution -- fail loudly rather than silently skip it (the
      // #270-shaped failure mode this check exists to prevent).
      throw new Error(
        `check-inert-class-field-seams: expected a SourceFile for ` +
          `${relativePath}, but the Program did not produce one.`,
      );
    }
    violations.push(
      ...findSeamViolationsInSourceFile(sourceFile, checker, relativePath),
    );
  }
  return violations;
}

function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const violations = scanRepository(repoRoot);

  if (violations.length === 0) {
    console.log(
      'No inert-seam candidates found: every optional, function-typed, ' +
        'non-static class field under src/ is either `declare`d or ' +
        'self-assigned by its own class.',
    );
    return;
  }

  console.error(`Found ${violations.length} inert-seam candidate(s) (#270):\n`);
  for (const violation of violations) {
    console.error(formatViolation(violation));
    console.error('');
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
