import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type SourceFile = {
  path: string;
  contents: string;
};

type CallSite = {
  file: string;
  receiver: string;
  line: number;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mainRoot = path.join(repositoryRoot, 'src', 'main');

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

function findManifestValidatorCallSites(files: SourceFile[]): CallSite[] {
  const sites: CallSite[] = [];
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
        const receiver = validatorReceiver(node.expression, sourceFile);
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

function siteIdentity(site: CallSite): string {
  return `${site.file}:${site.receiver}.validateFile`;
}

function assertExactCallSites(
  discovered: CallSite[],
  expected: readonly string[],
): void {
  if (discovered.length === 0) {
    throw new Error(
      'calibrationAssetManifest validator reachability discovery returned zero call sites',
    );
  }

  const remainingExpected = [...expected];
  const unexpected: CallSite[] = [];
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

const productionSources = collectTypeScriptFiles(mainRoot).map((absolute) => ({
  path: path.relative(repositoryRoot, absolute).replaceAll('\\', '/'),
  contents: readFileSync(absolute, 'utf8'),
}));

const expectedCallSites = [
  'src/main/ipc.ts:calibrationAssetManifest.validateFile',
] as const;

describe('calibrationAssetManifest validator reachability', () => {
  it('equals the explicit current production call-site set', () => {
    const discovered = findManifestValidatorCallSites(productionSources);
    expect(() =>
      assertExactCallSites(discovered, expectedCallSites),
    ).not.toThrow();
    expect(discovered.map(siteIdentity)).toEqual(expectedCallSites);
  });

  it('fails closed when discovery returns no call sites', () => {
    expect(() => assertExactCallSites([], expectedCallSites)).toThrow(
      'discovery returned zero call sites',
    );
  });

  it('names a fabricated attacker-influenced call site', () => {
    const discovered = findManifestValidatorCallSites([
      ...productionSources,
      {
        path: 'src/main/fabricatedArchiveImport.ts',
        contents:
          "attackerInfluencedManifest['validateFile'](approvalId, method);",
      },
    ]);

    expect(() => assertExactCallSites(discovered, expectedCallSites)).toThrow(
      'unexpected call site src/main/fabricatedArchiveImport.ts:attackerInfluencedManifest.validateFile',
    );
  });

  it('ignores formatting while retaining distinct calls', () => {
    const discovered = findManifestValidatorCallSites([
      {
        path: 'src/main/formatted.ts',
        contents: [
          'service',
          '  .validateFile(',
          '    approvalId,',
          '    method,',
          '  );',
          "service ['validateFile'] (approvalId, method);",
        ].join('\n'),
      },
    ]);

    expect(discovered.map(siteIdentity)).toEqual([
      'src/main/formatted.ts:service.validateFile',
      'src/main/formatted.ts:service.validateFile',
    ]);
  });
});
