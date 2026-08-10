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
//     assigning a callable),
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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  const output = execFileSync(
    'git',
    ['ls-files', '--', 'src/**/*.ts', 'src/**/*.tsx'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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
 * A field only reads as a capability seam if its type is itself callable --
 * a plain `resolveCalibrationConflict?: string` optional field is ordinary
 * optional data, not a prototype-patchable capability, and flagging it would
 * make this check noisy on the common "optional config value" shape it is
 * not built to guard.
 */
function isFunctionTyped(typeNode, sourceFile) {
  if (!typeNode) return false;
  if (ts.isFunctionTypeNode(typeNode)) return true;
  // A parenthesized or unioned function type, e.g. `(() => void) | undefined`
  // -- walk unions/parentheses looking for at least one function member.
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isFunctionTyped(typeNode.type, sourceFile);
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some((member) => isFunctionTyped(member, sourceFile));
  }
  return false;
}

/**
 * True if the class body assigns `this.<fieldName> = ...` anywhere in its own
 * constructor or methods. A field the class assigns to itself is managed
 * internally (an ordinary optional callback threaded through a constructor
 * argument, for instance) and is not the "nothing here ever sets this except
 * an external patch" shape this check exists to catch.
 */
function isSelfAssigned(classNode, fieldName, sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.left.name.getText(sourceFile) === fieldName
    ) {
      found = true;
      return;
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
 * Finds every inert-seam candidate in one source file's text.
 *
 * Returns `[]` for a file with no such shape -- callers should not read an
 * empty array as "the file was not actually parsed"; a parse failure throws
 * instead of returning an empty result, so absence here is a genuine finding
 * of zero, not a silent skip (the #182/#270 shape this repo keeps naming: an
 * unreadable input must not report the same result as a readable one that
 * found nothing).
 */
export function findInertSeamCandidates(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations = [];

  const visitClass = (classNode) => {
    for (const member of classNode.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      if (!member.questionToken) continue;
      if (member.initializer) continue;
      if (isDeclareField(member)) continue;
      if (isStaticField(member)) continue;
      if (!isFunctionTyped(member.type, sourceFile)) continue;
      if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name))
        continue;
      const fieldName = member.name.getText(sourceFile);
      if (isSelfAssigned(classNode, fieldName, sourceFile)) continue;

      const { line } = sourceFile.getLineAndCharacterOfPosition(
        member.getStart(sourceFile),
      );
      violations.push({
        file: filePath,
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

export function scanRepository(repoRoot) {
  const files = listSourceFiles(repoRoot);
  const violations = [];
  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, relativePath);
    const sourceText = readFileSync(absolutePath, 'utf8');
    violations.push(...findInertSeamCandidates(relativePath, sourceText));
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
