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

/** True when `void` at `index` starts a statement rather than naming a type. */
function isStatementPosition(code: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k -= 1;
  if (k < 0) return true;
  return code[k] === ';' || code[k] === '{' || code[k] === '}';
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

/** True when the argument list at `parenIndex` has a top-level comma. */
function callHasTopLevelComma(expression: string, parenIndex: number): boolean {
  let depth = 0;
  for (let k = parenIndex; k < expression.length; k += 1) {
    const ch = expression[k]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return false;
    } else if (ch === ',' && depth === 1) {
      return true;
    }
  }
  return false;
}

/**
 * True only when the outer chain carries a rejection handler.
 *
 * Depth is load-bearing: the bootstrap body contains nested catches that do
 * not protect the `app.whenReady()` chain itself.
 */
function hasRejectionHandler(expression: string): boolean {
  if (topLevelOccurrences(expression, '.catch(').length > 0) return true;
  return topLevelOccurrences(expression, '.then(').some((at) =>
    callHasTopLevelComma(expression, at + '.then'.length),
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
    if (!isStatementPosition(code, at)) continue;
    const expression = readExpression(code, at + 'void'.length).trim();
    found.push({
      file,
      line: code.slice(0, at).split('\n').length,
      expression,
      isCall: expression.includes('('),
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
