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

function callExpressionOperand(expression: string): ts.CallExpression | null {
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
    !ts.isVoidExpression(statement.expression) ||
    !ts.isCallExpression(statement.expression.expression)
  ) {
    return null;
  }
  return statement.expression.expression;
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
      callExpressionOperand(expression) !== null
    );
  }

  if (/[)>?=,&|!+\-*%~^]/.test(code[k]!)) {
    return callExpressionOperand(expression) !== null;
  }

  const precedingWord = code.slice(0, k + 1).match(/([A-Za-z]+)$/)?.[1];
  return (
    /^(?:return|throw|yield|else|do)$/.test(precedingWord ?? '') &&
    callExpressionOperand(expression) !== null
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

/** Offsets of `name` that are at bracket depth zero in `expression`. */
function topLevelOccurrences(expression: string, name: string): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let k = 0; k < expression.length; k += 1) {
    if (depth === 0 && expression.startsWith(name, k)) found.push(k);
    const ch = expression[k]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
  }
  return found;
}

/** Arguments parsed from the call whose opening parenthesis is `parenIndex`. */
function callArguments(
  expression: string,
  parenIndex: number,
): ts.NodeArray<ts.Expression> | null {
  const sourceFile = ts.createSourceFile(
    'handler-call.ts',
    `probe${expression.slice(parenIndex)};`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let current: ts.Expression | undefined = (
    sourceFile.statements[0] as ts.ExpressionStatement | undefined
  )?.expression;
  while (current && ts.isCallExpression(current)) {
    if (
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'probe'
    ) {
      return current.arguments;
    }
    current = ts.isPropertyAccessExpression(current.expression)
      ? current.expression.expression
      : current.expression;
  }
  return null;
}

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

function isPresentHandler(argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  const unwrapped = unwrapExpression(argument);
  return (
    unwrapped.kind !== ts.SyntaxKind.NullKeyword &&
    !ts.isVoidExpression(unwrapped) &&
    !(ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined')
  );
}

/**
 * True only when the outer chain carries a rejection handler.
 *
 * Depth is load-bearing: the bootstrap body contains nested catches that do
 * not protect the `app.whenReady()` chain itself.
 */
function hasRejectionHandler(expression: string): boolean {
  if (
    topLevelOccurrences(expression, '.catch(').some((at) =>
      isPresentHandler(callArguments(expression, at + '.catch'.length)?.[0]),
    )
  ) {
    return true;
  }
  return topLevelOccurrences(expression, '.then(').some((at) =>
    isPresentHandler(callArguments(expression, at + '.then'.length)?.[1]),
  );
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
  const pattern = /\bvoid\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const at = match.index;
    const expression = readExpression(code, at + 'void'.length).trim();
    if (!isVoidOperatorPosition(code, at, expression)) continue;
    found.push({
      file,
      line: code.slice(0, at).split('\n').length,
      expression,
      isCall: callExpressionOperand(expression) !== null,
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

    for (const expression of [
      'promise.catch()',
      'promise.catch(null)',
      'promise.catch((null))',
      'promise.catch(undefined)',
      'promise.catch((undefined))',
      'promise.then(resolve,)',
      'promise.then(resolve, undefined)',
      'promise.then(makeHandler<Result, Error>())',
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
