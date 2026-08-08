import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type SourceFile = {
  path: string;
  contents: string;
};

type ReachabilitySite = {
  file: string;
  receiver: string;
  line: number;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const productionRoot = path.join(repositoryRoot, 'src');

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(absolute);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function validatorReceiver(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string | null {
  const target = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'validateFile'
  ) {
    return target.expression.getText(sourceFile);
  }
  if (
    ts.isElementAccessExpression(target) &&
    target.argumentExpression !== undefined &&
    ts.isStringLiteralLike(target.argumentExpression) &&
    target.argumentExpression.text === 'validateFile'
  ) {
    return target.expression.getText(sourceFile);
  }
  return null;
}

function reflectedValidatorReceiver(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string | null {
  const target = unwrapExpression(node.expression);
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.expression.getText(sourceFile) !== 'Reflect' ||
    target.name.text !== 'get' ||
    node.arguments.length < 2
  ) {
    return null;
  }
  const property = node.arguments[1];
  if (!property || !ts.isStringLiteralLike(property)) return null;
  return property.text === 'validateFile'
    ? (node.arguments[0]?.getText(sourceFile) ?? 'unknown receiver')
    : null;
}

function destructuredValidatorReceiver(
  node: ts.BindingElement,
  sourceFile: ts.SourceFile,
): string | null {
  const property = node.propertyName ?? node.name;
  if (!ts.isIdentifier(property) || property.text !== 'validateFile') {
    return null;
  }
  const declaration = node.parent.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer
    ? declaration.initializer.getText(sourceFile)
    : 'destructured receiver';
}

function findManifestValidatorReferences(
  files: SourceFile[],
): ReachabilitySite[] {
  const sites: ReachabilitySite[] = [];
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.contents,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const receiver =
          validatorReceiver(node.expression, sourceFile) ??
          reflectedValidatorReceiver(node, sourceFile);
        if (receiver !== null) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          sites.push({ file: file.path, receiver, line: line + 1 });
        }
      } else if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        const receiver = validatorReceiver(node, sourceFile);
        if (receiver !== null) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          sites.push({ file: file.path, receiver, line: line + 1 });
        }
      } else if (ts.isBindingElement(node)) {
        const receiver = destructuredValidatorReceiver(node, sourceFile);
        if (receiver !== null) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          sites.push({ file: file.path, receiver, line: line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.receiver.localeCompare(right.receiver),
  );
}

function siteIdentity(site: ReachabilitySite): string {
  return `${site.file}:${site.receiver}.validateFile`;
}

function assertExactReferences(
  discovered: ReachabilitySite[],
  expected: readonly string[],
): void {
  if (discovered.length === 0) {
    throw new Error(
      'calibrationAssetManifest validator reachability discovery returned zero call sites',
    );
  }

  const remainingExpected = [...expected];
  const unexpected: ReachabilitySite[] = [];
  for (const site of discovered) {
    const identity = siteIdentity(site);
    const expectedIndex = remainingExpected.indexOf(identity);
    if (expectedIndex === -1) unexpected.push(site);
    else remainingExpected.splice(expectedIndex, 1);
  }

  if (unexpected.length > 0 || remainingExpected.length > 0) {
    const details = [
      ...unexpected.map(
        (site) =>
          `unexpected call site ${siteIdentity(site)} (line ${site.line})`,
      ),
      ...remainingExpected.map((site) => `missing expected call site ${site}`),
    ];
    throw new Error(details.join('\n'));
  }
}

const productionSources = collectTypeScriptFiles(productionRoot).map(
  (absolute) => ({
    path: path.relative(repositoryRoot, absolute).replaceAll('\\', '/'),
    contents: readFileSync(absolute, 'utf8'),
  }),
);

const expectedCallSites = [
  'src/main/ipc.ts:calibrationAssetManifest.validateFile',
] as const;

describe('calibrationAssetManifest validator reachability', () => {
  it('equals the explicit current production call-site set', () => {
    const discovered = findManifestValidatorReferences(productionSources);
    expect(() =>
      assertExactReferences(discovered, expectedCallSites),
    ).not.toThrow();
    expect(discovered.map(siteIdentity)).toEqual(expectedCallSites);
  });

  it('fails closed when discovery returns no call sites', () => {
    expect(() => assertExactReferences([], expectedCallSites)).toThrow(
      'discovery returned zero call sites',
    );
  });

  it('names a fabricated attacker-influenced call site', () => {
    const discovered = findManifestValidatorReferences([
      ...productionSources,
      {
        path: 'src/preload/fabricatedArchiveImport.ts',
        contents:
          "attackerInfluencedManifest['validateFile'](approvalId, method);",
      },
    ]);

    expect(() => assertExactReferences(discovered, expectedCallSites)).toThrow(
      'unexpected call site src/preload/fabricatedArchiveImport.ts:attackerInfluencedManifest.validateFile',
    );
  });

  it('ignores formatting while retaining direct and indirect reachability', () => {
    const discovered = findManifestValidatorReferences([
      {
        path: 'src/main/formatted.ts',
        contents: [
          'service',
          '  .validateFile(',
          '    approvalId,',
          '    method,',
          '  );',
          "service ['validateFile'] (approvalId, method);",
          'const bound = service.validateFile.bind(service);',
          'const { validateFile: detached } = otherService;',
          "const reflected = Reflect.get(thirdService, 'validateFile');",
        ].join('\n'),
      },
    ]);

    expect(discovered.map(siteIdentity)).toEqual([
      'src/main/formatted.ts:service.validateFile',
      'src/main/formatted.ts:service.validateFile',
      'src/main/formatted.ts:service.validateFile',
      'src/main/formatted.ts:otherService.validateFile',
      'src/main/formatted.ts:thirdService.validateFile',
    ]);
  });
});
