// @vitest-environment node

/**
 * `void`-suppressed promises in `src/main` must carry a rejection handler.
 *
 * This is deliberately a structural sweep rather than a list of the sites
 * fixed by #432. A site list cannot detect the next bare suppression.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mainDir = path.join(repoRoot, 'src', 'main');

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Blank comments and literals without changing offsets so prose cannot become
 * a finding and reported line numbers remain accurate.
 */
function blankCommentsAndStrings(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === ch) break;
        k += 1;
      }
      blank(i, Math.min(k + 1, source.length));
      i = Math.min(k + 1, source.length);
      continue;
    }
    i += 1;
  }

  return out.join('');
}

function voidOperand(expression: string): ts.Expression | null {
  const sourceFile = ts.createSourceFile(
    'void-expression.ts',
    `void ${expression};`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];
  if (
    !statement ||
    !ts.isExpressionStatement(statement) ||
    !ts.isVoidExpression(statement.expression)
  ) {
    return null;
  }
  return unwrapExpression(statement.expression.expression);
}

function promiseCallOperands(expression: string): ts.CallExpression[] {
  const collect = (operand: ts.Expression): ts.CallExpression[] => {
    const unwrapped = unwrapExpression(operand);
    if (ts.isCallExpression(unwrapped)) return [unwrapped];
    if (ts.isConditionalExpression(unwrapped)) {
      return [...collect(unwrapped.whenTrue), ...collect(unwrapped.whenFalse)];
    }
    if (
      ts.isBinaryExpression(unwrapped) &&
      (unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        unwrapped.operatorToken.kind ===
          ts.SyntaxKind.AmpersandAmpersandToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return [...collect(unwrapped.left), ...collect(unwrapped.right)];
    }
    return [];
  };

  const operand = voidOperand(expression);
  return operand ? collect(operand) : [];
}

/** True when `void` at `index` is an operator rather than a type annotation. */
function isVoidOperatorPosition(
  code: string,
  index: number,
  expression: string,
): boolean {
  let k = index - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k -= 1;
  if (k < 0) return true;
  if (code[k] === ';' || code[k] === '{' || code[k] === '}') return true;

  // Single-statement branches, case clauses, arrow bodies, and operator
  // operands are valid `void` positions. Requiring a call-shaped operand keeps
  // type annotations such as `() => void` out of this expanded population.
  if (code[k] === ':') {
    const linePrefix = code.slice(code.lastIndexOf('\n', k) + 1, k + 1);
    return (
      /\b(?:case\b[^:]*|default)\s*:$/.test(linePrefix) &&
      promiseCallOperands(expression).length > 0
    );
  }

  if (/[)>?=,&|!+\-*%~^]/.test(code[k]!)) {
    return promiseCallOperands(expression).length > 0;
  }

  const precedingWord = code.slice(0, k + 1).match(/([A-Za-z]+)$/)?.[1];
  return (
    /^(?:return|throw|yield|else|do)$/.test(precedingWord ?? '') &&
    promiseCallOperands(expression).length > 0
  );
}

/** Expression text between `void` and its terminating depth-zero semicolon. */
function readExpression(code: string, start: number): string {
  let depth = 0;
  for (let k = start; k < code.length; k += 1) {
    const ch = code[k]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return code.slice(start, k);
  }
  return code.slice(start);
}

function isPresentHandler(argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  const unwrapped = unwrapExpression(argument);
  const nonCallableKeyword =
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword;
  const nonCallableLiteral =
    ts.isNumericLiteral(unwrapped) ||
    ts.isBigIntLiteral(unwrapped) ||
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped) ||
    ts.isTemplateExpression(unwrapped) ||
    ts.isObjectLiteralExpression(unwrapped) ||
    ts.isArrayLiteralExpression(unwrapped) ||
    ts.isRegularExpressionLiteral(unwrapped) ||
    ts.isClassExpression(unwrapped) ||
    ts.isNewExpression(unwrapped) ||
    ts.isPrefixUnaryExpression(unwrapped);
  return !(
    nonCallableKeyword ||
    nonCallableLiteral ||
    ts.isVoidExpression(unwrapped) ||
    (ts.isIdentifier(unwrapped) &&
      /^(?:undefined|NaN|Infinity)$/.test(unwrapped.text))
  );
}

/**
 * True only when the outer chain ends in a rejection handler.
 *
 * Walking the outer call receiver is the AST equivalent of the recovered
 * depth-zero check: catches inside callback arguments are never visited. A
 * handler followed by another `.then` is not terminal and cannot answer for
 * failures introduced by that later callback.
 */
function callHasRejectionHandler(initialCall: ts.CallExpression): boolean {
  let call: ts.CallExpression | null = initialCall;
  let allowSettlementObserver = true;
  while (call) {
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    const method = call.expression.name.text;
    if (method === 'catch') {
      return allowSettlementObserver && isPresentHandler(call.arguments[0]);
    }
    if (method === 'then') {
      return allowSettlementObserver && isPresentHandler(call.arguments[1]);
    }
    if (method !== 'finally') allowSettlementObserver = false;

    const receiver = unwrapExpression(call.expression.expression);
    call = ts.isCallExpression(receiver) ? receiver : null;
  }
  return false;
}

function hasRejectionHandler(expression: string): boolean {
  const calls = promiseCallOperands(expression);
  return calls.length > 0 && calls.every(callHasRejectionHandler);
}

interface VoidStatement {
  file: string;
  line: number;
  expression: string;
  isCall: boolean;
  hasRejectionHandler: boolean;
}

function scanVoidStatements(source: string, file: string): VoidStatement[] {
  const code = blankCommentsAndStrings(source);
  const found: VoidStatement[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const astVoidExpressions = new Map<number, ts.VoidExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVoidExpression(node)) {
      astVoidExpressions.set(node.getStart(sourceFile), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const candidateOffsets = new Set(astVoidExpressions.keys());
  const pattern = /\bvoid\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    candidateOffsets.add(match.index);
  }

  for (const at of [...candidateOffsets].sort((left, right) => left - right)) {
    const astVoid = astVoidExpressions.get(at);
    const expression = astVoid
      ? astVoid.expression.getText(sourceFile)
      : readExpression(code, at + 'void'.length).trim();
    if (!astVoid && !isVoidOperatorPosition(code, at, expression)) continue;
    found.push({
      file,
      line: code.slice(0, at).split('\n').length,
      expression,
      isCall: promiseCallOperands(expression).length > 0,
      hasRejectionHandler: hasRejectionHandler(expression),
    });
  }

  return found;
}

function typeScriptFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFilesUnder(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

const sourceFiles = typeScriptFilesUnder(mainDir);
const allVoidStatements = sourceFiles.flatMap((file) =>
  scanVoidStatements(readFileSync(file, 'utf8'), path.relative(repoRoot, file)),
);

describe('void-suppressed promises in src/main carry rejection handlers', () => {
  it('dynamically discovers source files and void statements', () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
    expect(allVoidStatements.length).toBeGreaterThan(10);
  });

  it('accepts handled calls and rejects a newly planted bare call', () => {
    const bare = scanVoidStatements(
      'function f() {\n  void reader.cancel();\n}\n',
      'control-bare.ts',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]?.isCall).toBe(true);
    expect(bare[0]?.hasRejectionHandler).toBe(false);

    const mergedReaderCancelForm = scanVoidStatements(
      'function f() {\n  void reader.cancel().catch(() => undefined);\n}\n',
      'control-reader-cancel.ts',
    );
    expect(mergedReaderCancelForm).toHaveLength(1);
    expect(mergedReaderCancelForm[0]?.hasRejectionHandler).toBe(true);

    const finallyOnly = scanVoidStatements(
      'function f() {\n  void p().finally(() => undefined);\n}\n',
      'control-finally.ts',
    );
    expect(finallyOnly[0]?.hasRejectionHandler).toBe(false);

    const twoArgumentThen = scanVoidStatements(
      'function f() {\n  void reader.read().then(resolve, reject);\n}\n',
      'control-two-argument-then.ts',
    );
    expect(twoArgumentThen[0]?.hasRejectionHandler).toBe(true);

    // The recovered contract distinguishes a bare suppression from a chain
    // that already has a rejection path. A trailing settlement observer does
    // not erase the two-argument `.then` handler and exists in current source.
    const handledBeforeFinally = scanVoidStatements(
      'function f() {\n  void reader.read().then(resolve, reject).finally(cleanup);\n}\n',
      'control-handled-before-finally.ts',
    );
    expect(handledBeforeFinally[0]?.hasRejectionHandler).toBe(true);

    for (const expression of [
      'promise.catch()',
      'promise.catch(null)',
      'promise.catch((null))',
      'promise.catch(undefined)',
      'promise.catch((undefined))',
      'promise.catch(false as any)',
      'promise.catch({} as any)',
      'promise.catch(new (class {})() as any)',
      'promise.then(resolve,)',
      'promise.then(resolve, 0 as any)',
      'promise.then(resolve, undefined)',
      'promise.then(makeHandler<Result, Error>())',
      'promise.catch(handler).then(next)',
      'promise.then(resolve, reject).then(next)',
    ]) {
      const absentHandler = scanVoidStatements(
        `function f() {\n  void ${expression};\n}\n`,
        'control-absent-handler.ts',
      );
      expect(
        absentHandler[0]?.hasRejectionHandler,
        `${expression} does not attach a rejection handler`,
      ).toBe(false);
    }
  });

  it('discovers void calls in every supported statement position', () => {
    const statements = scanVoidStatements(
      [
        'function f(condition: boolean, value: number) {',
        '  if (condition) void first();',
        '  switch (value) { case 1: void second(); }',
        '  return () => void third();',
        '}',
      ].join('\n'),
      'control-statement-positions.ts',
    );
    expect(statements.map((statement) => statement.expression)).toEqual([
      'first()',
      'second()',
      'third()',
    ]);
    expect(statements.every((statement) => statement.isCall)).toBe(true);
    expect(statements.every((statement) => statement.hasRejectionHandler)).toBe(
      false,
    );
  });

  it('requires the bootstrap chain own top-level rejection handler', () => {
    const withoutOuterCatch = scanVoidStatements(
      [
        'function f() {',
        '  void app.whenReady().then(() => {',
        '    void syncEngine.start().catch(() => undefined);',
        '    void updateManager.initialize().catch(() => undefined);',
        '  });',
        '}',
      ].join('\n'),
      'control-bootstrap-without-outer-catch.ts',
    );
    const unhandledBootstrap = withoutOuterCatch.find((statement) =>
      statement.expression.startsWith('app.whenReady()'),
    );
    expect(
      unhandledBootstrap,
      'the outer bootstrap statement must be discovered',
    ).toBeDefined();
    expect(unhandledBootstrap?.hasRejectionHandler).toBe(false);

    const withOuterCatch = scanVoidStatements(
      [
        'function f() {',
        '  void app.whenReady().then(() => {',
        '    void syncEngine.start().catch(() => undefined);',
        '  }).catch(() => undefined);',
        '}',
      ].join('\n'),
      'control-bootstrap-with-outer-catch.ts',
    );
    expect(
      withOuterCatch.find((statement) =>
        statement.expression.startsWith('app.whenReady()'),
      )?.hasRejectionHandler,
    ).toBe(true);
  });

  it('classifies IIFEs instead of exempting them', () => {
    const handled = scanVoidStatements(
      'function f() {\n  void (async () => undefined)().catch(() => undefined);\n}\n',
      'control-handled-iife.ts',
    );
    expect(handled).toHaveLength(1);
    expect(handled[0]?.hasRejectionHandler).toBe(true);

    const bare = scanVoidStatements(
      'function f() {\n  void (async () => undefined)();\n}\n',
      'control-bare-iife.ts',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]?.hasRejectionHandler).toBe(false);
  });

  it('classifies parenthesized calls and template interpolations', () => {
    const statements = scanVoidStatements(
      [
        'function f() {',
        '  void (reader.cancel());',
        '  const diagnostic = `${void report()}`;',
        '}',
      ].join('\n'),
      'control-wrapped-calls.ts',
    );
    expect(statements.map((statement) => statement.expression)).toEqual([
      '(reader.cancel())',
      'report()',
    ]);
    expect(statements.every((statement) => statement.isCall)).toBe(true);
    expect(statements.every((statement) => statement.hasRejectionHandler)).toBe(
      false,
    );
  });

  it('classifies calls wrapped by conditionals and sequences', () => {
    const statements = scanVoidStatements(
      [
        'function f(condition: boolean) {',
        '  void (condition ? reader.cancel() : reader.read());',
        '  void (first(), second());',
        '}',
      ].join('\n'),
      'control-wrapped-promise-expressions.ts',
    );
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.isCall)).toBe(true);
    expect(statements.every((statement) => statement.hasRejectionHandler)).toBe(
      false,
    );
  });

  it('does not read types, prose, comments, or strings as statements', () => {
    const noise = scanVoidStatements(
      [
        'function f(): void {',
        '  let release: () => void = () => undefined;',
        '  // void shell.openExternal(url);',
        '  /* void shell.openExternal(url); */',
        "  const s = 'void shell.openExternal(url);';",
        '}',
      ].join('\n'),
      'control-noise.ts',
    );
    expect(noise).toEqual([]);

    const unusedValue = scanVoidStatements(
      'function f() {\n  void _exhaustive;\n}\n',
      'control-unused-value.ts',
    );
    expect(unusedValue).toHaveLength(1);
    expect(unusedValue[0]?.isCall).toBe(false);

    // These predecessor characters are statement-valid, so only the blanking
    // pass prevents false positives. Removing it makes both controls fail.
    const quotedStatement = scanVoidStatements(
      "function f() {\n  const s = '{ void shell.openExternal(url); }';\n}\n",
      'control-quoted-statement.ts',
    );
    expect(quotedStatement).toEqual([]);

    const commentedStatement = scanVoidStatements(
      [
        'function f() {',
        '  /* nothing here;',
        '     void shell.openExternal(url); */',
        '}',
      ].join('\n'),
      'control-commented-statement.ts',
    );
    expect(commentedStatement).toEqual([]);
  });

  it('finds no bare void-suppressed call in src/main', () => {
    const offenders = allVoidStatements.filter(
      (statement) => statement.isCall && !statement.hasRejectionHandler,
    );
    expect(
      offenders.map(
        (offender) =>
          `${offender.file}:${offender.line} - void ${offender.expression}`,
      ),
      'attach a rejection handler instead of widening this guard (issue #468)',
    ).toEqual([]);

    const calls = allVoidStatements.filter((statement) => statement.isCall);
    expect(calls.length).toBeGreaterThan(10);
    expect(
      calls.filter((statement) => statement.hasRejectionHandler).length,
    ).toBeGreaterThan(8);
  });
});
