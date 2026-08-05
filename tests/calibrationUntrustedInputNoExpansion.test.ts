// @vitest-environment node

/**
 * Nothing on the untrusted calibration input path expands its input (#158).
 *
 * #158 asks for one malicious-input corpus across the three untrusted
 * calibration entry points, and lists thirteen vectors. Two of them —
 * `zip / archive decompression bomb` and `decompression-bomb image in a staged
 * photo` — are **not applicable to any entry point**, and the issue's own
 * acceptance criteria say a deliberately skipped pair must carry a reason.
 *
 * Measured, the reason is an **absence**:
 *
 *   - no `node:zlib`, `gunzip`, `inflate`, `brotli` or archive reader is
 *     reachable from any of the three entry points;
 *   - no image decoder is a runtime dependency at all, and nothing decodes
 *     pixels. `calibrationImportV4` base64-decodes photo bytes, bounds them by
 *     `MAX_PHOTO_DECODED_BYTES`, and compares magic bytes. Bytes in, bytes
 *     compared — the decoded size is the transfer size, so there is no
 *     amplification step for a bomb to exploit;
 *   - a legacy v4 backup is plain JSON text, not an archive. The magic-marker
 *     check requires the file to start with `{`.
 *
 * ## Why this file exists rather than a comment saying the above
 *
 * That absence is a real safety property with **no owner**. It holds because of
 * what the code does not do, so nothing in a diff, a review or CI marks the
 * moment it stops holding. Add `zlib` to the import path to support compressed
 * backups, or `sharp` to generate thumbnails, and both vectors become live
 * against an entry point that already accepts untrusted files — with no code
 * change anywhere near this test, and with #158's matrix still recording both
 * cells as excused.
 *
 * An excuse that outlives its reason is worse than no excuse, because it is
 * documented. A commitment is not a control; this is the control.
 *
 * ## Scope
 *
 * The closure is computed transitively from the three entry points through
 * relative imports, rather than checking the four named files, because the
 * property has to hold for everything they can reach. `nativeImage` is included
 * in the banned set: it decodes images, and it is legitimate elsewhere in the
 * main process, which is exactly why the ban is scoped to this closure instead
 * of the whole tree.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mainDir = path.join(repoRoot, 'src', 'main');

/** The three untrusted calibration entry points named by #158. */
const ENTRY_POINTS = [
  'calibrationImportV4.ts', // legacy v4 backup files, native picker
  'orcaProfileDiscovery.ts', // upstream-Orca profiles, scanned from disk
  'orcaProfileInstall.ts', // upstream-Orca profiles, install/save targets
  'calibrationAssetManifest.ts', // external calibration asset files
];

/**
 * APIs that turn a small input into a large one, or that hand attacker-shaped
 * bytes to a decoder. Each is the enabling step for one of the two vectors
 * #158 lists and this repository currently cannot receive.
 */
const EXPANDING_APIS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bfrom\s+['"]node:zlib['"]/, why: 'node:zlib (decompression)' },
  {
    pattern: /\brequire\(\s*['"](?:node:)?zlib['"]\s*\)/,
    why: 'zlib via require',
  },
  { pattern: /\bcreateGunzip\b/, why: 'createGunzip' },
  { pattern: /\bcreateInflate(?:Raw)?\b/, why: 'createInflate' },
  { pattern: /\bcreateBrotliDecompress\b/, why: 'createBrotliDecompress' },
  { pattern: /\bgunzipSync\b/, why: 'gunzipSync' },
  { pattern: /\binflateSync\b/, why: 'inflateSync' },
  { pattern: /\bbrotliDecompressSync\b/, why: 'brotliDecompressSync' },
  {
    pattern:
      /\bfrom\s+['"](?:adm-zip|yauzl|unzipper|node-stream-zip|decompress|tar|tar-stream|tar-fs)['"]/,
    why: 'archive reader package',
  },
  {
    pattern: /\bfrom\s+['"](?:sharp|jimp|canvas|pngjs|jpeg-js|image-size)['"]/,
    why: 'image decoder package',
  },
  { pattern: /\bnativeImage\b/, why: 'electron nativeImage (decodes images)' },
];

/** Runtime dependencies that would make the above reachable at all. */
const EXPANDING_PACKAGES =
  /^(?:adm-zip|yauzl|unzipper|node-stream-zip|decompress|tar|tar-stream|tar-fs|sharp|jimp|canvas|pngjs|jpeg-js|image-size)$/;

function resolveLocalImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  // Source is authored as .ts and imported as .js.
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type NonLiteralReferenceKind = 'dynamic import' | 'require';

function literalSpecifier(
  expression: ts.Expression | undefined,
): string | null {
  return expression !== undefined && ts.isStringLiteralLike(expression)
    ? expression.text
    : null;
}

function moduleSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const unresolved: string[] = [];

  const collectReference = (
    expression: ts.Expression | undefined,
    node: ts.Node,
    kind: NonLiteralReferenceKind,
  ): void => {
    const specifier = literalSpecifier(expression);
    if (specifier !== null) {
      specifiers.push(specifier);
      return;
    }

    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    unresolved.push(
      `${file}:${position.line + 1}:${position.character + 1}: ${kind} uses a ` +
        `non-literal specifier: ${node.getText(sourceFile)}`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      collectReference(
        node.moduleReference.expression,
        node.moduleReference,
        'require',
      );
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        collectReference(node.arguments[0], node, 'dynamic import');
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        collectReference(node.arguments[0], node, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (unresolved.length > 0) {
    throw new Error(
      `Cannot statically resolve module references in the untrusted ` +
        `calibration closure:\n${unresolved.map((item) => `- ${item}`).join('\n')}`,
    );
  }

  return specifiers;
}

/** Transitive closure of local imports reachable from the entry points. */
function reachableFromEntryPoints(
  entryDirectory = mainDir,
  entryPoints: readonly string[] = ENTRY_POINTS,
): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = entryPoints.map((name) => path.join(entryDirectory, name));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const specifier of moduleSpecifiers(file, source)) {
      const resolved = resolveLocalImport(file, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function withSourceFixture<T>(
  files: Readonly<Record<string, string>>,
  run: (directory: string) => T,
): T {
  const directory = mkdtempSync(path.join(tmpdir(), 'pfd-expansion-closure-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(path.join(directory, name), source, 'utf8');
    }
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function scannedFileNames(closure: ReadonlyMap<string, string>): string[] {
  return [...closure.keys()].map((file) => path.basename(file)).sort();
}

function expansionOffenders(
  closure: ReadonlyMap<string, string>,
  pattern: RegExp,
): string[] {
  return [...closure]
    .filter(([, source]) => pattern.test(source))
    .map(([file]) => file);
}

function expansionMatches(
  closure: ReadonlyMap<string, string>,
): { file: string; why: string }[] {
  return EXPANDING_APIS.flatMap(({ pattern, why }) =>
    expansionOffenders(closure, pattern).map((file) => ({
      file: path.basename(file),
      why,
    })),
  );
}

describe('the closure walker follows every supported module-reference form', () => {
  it('follows a literal static import specifier', () => {
    withSourceFixture(
      {
        'entry.ts': "import './static.js';\n",
        'static.ts': 'export const reached = true;\n',
      },
      (directory) => {
        const closure = reachableFromEntryPoints(directory, ['entry.ts']);
        expect(scannedFileNames(closure)).toEqual(['entry.ts', 'static.ts']);
      },
    );
  });

  it('detects a banned API reached only through a literal dynamic import', () => {
    withSourceFixture(
      {
        'entry.ts':
          "export async function load() { return await import('./expanding.js'); }\n",
        'expanding.ts':
          "import { gunzipSync } from 'node:zlib';\nexport const expand = gunzipSync;\n",
      },
      (directory) => {
        const closure = reachableFromEntryPoints(directory, ['entry.ts']);
        expect(scannedFileNames(closure)).toEqual(['entry.ts', 'expanding.ts']);
        expect(expansionMatches(closure)).toEqual([
          { file: 'expanding.ts', why: 'node:zlib (decompression)' },
          { file: 'expanding.ts', why: 'gunzipSync' },
        ]);
      },
    );
  });

  it('follows a literal require specifier', () => {
    withSourceFixture(
      {
        'entry.ts': "export const loaded = require('./required.js');\n",
        'required.ts': 'export const reached = true;\n',
      },
      (directory) => {
        const closure = reachableFromEntryPoints(directory, ['entry.ts']);
        expect(scannedFileNames(closure)).toEqual(['entry.ts', 'required.ts']);
      },
    );
  });

  it('reports zero expansion matches only after scanning a safe dynamic import', () => {
    withSourceFixture(
      {
        'entry.ts':
          "export async function load() { return await import('./safe.js'); }\n",
        'safe.ts': 'export const safe = true;\n',
      },
      (directory) => {
        const closure = reachableFromEntryPoints(directory, ['entry.ts']);
        expect(scannedFileNames(closure)).toEqual(['entry.ts', 'safe.ts']);
        expect(expansionMatches(closure)).toEqual([]);
      },
    );
  });

  it('fails closed and reports a non-literal dynamic import expression', () => {
    withSourceFixture(
      {
        'entry.ts':
          "const target = './hidden.js';\nexport async function load() { return await import(target); }\n",
        'hidden.ts': 'export const hidden = true;\n',
      },
      (directory) => {
        expect(() =>
          reachableFromEntryPoints(directory, ['entry.ts']),
        ).toThrowError(
          /dynamic import uses a non-literal specifier: import\(target\)/,
        );
      },
    );
  });

  it('fails closed and reports a non-literal require expression', () => {
    withSourceFixture(
      {
        'entry.ts':
          "const target = './hidden.js';\nexport const loaded = require(target);\n",
        'hidden.ts': 'export const hidden = true;\n',
      },
      (directory) => {
        expect(() =>
          reachableFromEntryPoints(directory, ['entry.ts']),
        ).toThrowError(
          /require uses a non-literal specifier: require\(target\)/,
        );
      },
    );
  });

  it('ignores module-like text in comments and string literals', () => {
    withSourceFixture(
      {
        'entry.ts':
          "const examples = ['import(target)', 'require(target)'];\n" +
          '// await import(commentedTarget); require(commentedTarget);\n' +
          'export { examples };\n',
      },
      (directory) => {
        const closure = reachableFromEntryPoints(directory, ['entry.ts']);
        expect(scannedFileNames(closure)).toEqual(['entry.ts']);
      },
    );
  });
});

describe('the untrusted calibration input path expands nothing', () => {
  const closure = reachableFromEntryPoints();

  it('reaches every entry point, which is the precondition for the ban below', () => {
    // Without this, a broken resolver produces an empty closure and every
    // assertion below passes for having nothing to scan. The ban would then be
    // reported as enforced on a path it never read.
    for (const name of ENTRY_POINTS) {
      expect(
        closure.has(path.join(mainDir, name)),
        `${name} is not in the scanned closure`,
      ).toBe(true);
    }
  });

  it('reaches beyond the entry points themselves, so the ban is transitive', () => {
    // A closure of exactly four files means import resolution failed and the
    // guard silently degraded to checking only the files it was handed.
    expect(closure.size).toBeGreaterThan(ENTRY_POINTS.length);
  });

  it.each(EXPANDING_APIS)(
    'does not reach $why anywhere in that closure',
    ({ pattern, why }) => {
      const offenders = expansionOffenders(closure, pattern).map(relative);
      expect(
        offenders,
        `${why} is now reachable from an untrusted calibration entry point. ` +
          `#158 excuses the archive-bomb and image-bomb vectors as inapplicable ` +
          `because nothing on this path expands its input. That is no longer true, ` +
          `so those two cells must become real tests before this guard is relaxed.`,
      ).toEqual([]);
    },
  );

  it('declares no decompression or image-decoding runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const offenders = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      EXPANDING_PACKAGES.test(name),
    );
    // Deliberately `dependencies` only. A build-time zip maker is not an input
    // path, and banning it would make this guard fire on something that cannot
    // receive untrusted calibration content.
    expect(offenders).toEqual([]);
  });
});

describe('the two excused vectors, and what makes them excusable', () => {
  it('a legacy v4 backup is JSON text rather than an archive', () => {
    const source = readFileSync(
      path.join(mainDir, 'calibrationImportV4.ts'),
      'utf8',
    );
    // The magic-marker check is what makes "this is not an archive" a property
    // of the code and not of the file the user happened to pick.
    expect(source).toContain("trimmed.startsWith('{')");
  });

  it('staged photo bytes are bounded and compared, never decoded', () => {
    const source = readFileSync(
      path.join(mainDir, 'calibrationImportV4.ts'),
      'utf8',
    );
    // A cap on decoded bytes is only a defence against an image bomb while the
    // decoded size is the final size. It stops being one the moment a decoder
    // turns those bytes into pixels, which is what the closure ban protects.
    expect(source).toContain('MAX_PHOTO_DECODED_BYTES');
    expect(source).toMatch(/JPEG_MAGIC|PNG_MAGIC/);
  });
});
