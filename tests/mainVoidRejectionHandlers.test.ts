// @vitest-environment node

/**
 * `void`-suppressed promises in `src/main` must carry a rejection handler
 * (issue #314).
 *
 * `@typescript-eslint/no-floating-promises` offers four remedies in one
 * sentence — `await`, `.catch`, `.then` with a rejection handler, or "be
 * explicitly marked as ignored with the `void` operator". Three attach a
 * handler; the fourth suppresses the diagnostic and changes nothing at
 * runtime. It is also the shortest and the only one that requires no decision
 * about what to do on failure. So lint being green tells us nothing here: the
 * rule cannot distinguish "I handled this" from "I told you to stop asking".
 *
 * This file is deliberately NOT a list of the six sites #314 found. A guard
 * keyed to known-bad locations shares a vocabulary with the fix, so it can only
 * answer questions about sites someone already noticed — the seventh site is
 * exactly the one such a guard cannot see. The sweep below enumerates every
 * `void` statement in `src/main` and classifies it, so a new one has to satisfy
 * the rule rather than be absent from a list.
 *
 * The scanner is itself apparatus, and apparatus that is never made to fail is
 * indistinguishable from apparatus that cannot fail. Every assertion about
 * absence below is therefore paired with a control that produces the presence.
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
 * Remove comments and string/template literals, replacing each with spaces of
 * the same length so byte offsets — and therefore reported line numbers —
 * survive. Prose is a real hazard here: this very file discusses `void`, and a
 * scanner that reads its own docblock as code would report findings that are
 * sentences.
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

/** True when `void` at `index` begins a statement rather than naming a type. */
function isStatementPosition(code: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k -= 1;
  if (k < 0) return true;
  return code[k] === ';' || code[k] === '{' || code[k] === '}';
}

/** Expression text between `void` and its terminating `;` at depth zero. */
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

/** True when `name(` appears with a comma at the top level of its arguments. */
function hasTwoArgumentCall(expression: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = expression.indexOf(name, from);
    if (at === -1) return false;
    let depth = 0;
    for (let k = at + name.length - 1; k < expression.length; k += 1) {
      const ch = expression[k]!;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) return true;
    }
    from = at + name.length;
  }
}

interface VoidStatement {
  file: string;
  line: number;
  expression: string;
  isCall: boolean;
  isImmediatelyInvoked: boolean;
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
      isImmediatelyInvoked: expression.startsWith('('),
      // `.catch(handler)` and `.then(onFulfilled, onRejected)` are the two
      // forms the rule itself accepts. `.finally` is not one: it observes
      // settlement without consuming rejection.
      hasRejectionHandler:
        expression.includes('.catch(') ||
        hasTwoArgumentCall(expression, '.then('),
    });
  }
  return found;
}

function typeScriptFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...typeScriptFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const sourceFiles = typeScriptFilesUnder(mainDir);
const allVoidStatements = sourceFiles.flatMap((file) =>
  scanVoidStatements(readFileSync(file, 'utf8'), path.relative(repoRoot, file)),
);

describe('void-suppressed promises in src/main carry a rejection handler', () => {
  it('finds source files and void statements at all', () => {
    // Non-vacuity. Every assertion below is of the form "this set is empty",
    // and an empty set is what a broken reader returns. If the sweep silently
    // stopped reading `src/main`, the guard would pass by reading nothing.
    expect(sourceFiles.length).toBeGreaterThan(10);
    expect(allVoidStatements.length).toBeGreaterThan(10);
  });

  it('detects a missing rejection handler, and does not flag a present one', () => {
    // Positive control on the classifier. Without this, "no unhandled sites"
    // is indistinguishable from a classifier that never returns a finding.
    const unhandled = scanVoidStatements(
      'function f() {\n  void shell.openExternal(url);\n}\n',
      'control-unhandled.ts',
    );
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]?.isCall).toBe(true);
    expect(unhandled[0]?.hasRejectionHandler).toBe(false);

    const handled = scanVoidStatements(
      'function f() {\n  void shell.openExternal(url).catch(() => undefined);\n}\n',
      'control-handled.ts',
    );
    expect(handled).toHaveLength(1);
    expect(handled[0]?.hasRejectionHandler).toBe(true);

    // Negative control on the other axis: `.finally` settles but does not
    // consume a rejection, so it must not read as a handler.
    const finallyOnly = scanVoidStatements(
      'function f() {\n  void p().finally(() => undefined);\n}\n',
      'control-finally.ts',
    );
    expect(finallyOnly[0]?.hasRejectionHandler).toBe(false);

    // And `.then` with two arguments must, because the rule accepts it.
    const twoArgThen = scanVoidStatements(
      'function f() {\n  void reader.read().then(resolve, reject);\n}\n',
      'control-two-arg-then.ts',
    );
    expect(twoArgThen[0]?.hasRejectionHandler).toBe(true);
  });

  it('does not read types, prose or string contents as statements', () => {
    // The scanner's own blind spots, asserted rather than assumed. Each of
    // these appears in `src/main` and would produce a false finding.
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

    // `void identifier;` is the unused-value suppression, not a promise.
    const unusedValue = scanVoidStatements(
      'function f() {\n  void _exhaustive;\n}\n',
      'control-unused.ts',
    );
    expect(unusedValue).toHaveLength(1);
    expect(unusedValue[0]?.isCall).toBe(false);
  });

  it('leaves no void-suppressed call without a rejection handler', () => {
    const offenders = allVoidStatements.filter(
      (statement) =>
        statement.isCall &&
        !statement.isImmediatelyInvoked &&
        !statement.hasRejectionHandler,
    );
    expect(
      offenders.map((o) => `${o.file}:${o.line} — void ${o.expression}`),
      'these void-suppressed promises have no rejection handler; attach ' +
        '`.catch` rather than widening this guard (issue #314)',
    ).toEqual([]);

    // The filter above has three conjuncts, and a filter that removes
    // everything also produces an empty list. Assert the population it drew
    // from is real and that the excluded classes are genuinely present, so an
    // over-broad exclusion shows up here rather than as a pass.
    const calls = allVoidStatements.filter((s) => s.isCall);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((s) => s.hasRejectionHandler).length).toBeGreaterThan(
      8,
    );
  });
});
