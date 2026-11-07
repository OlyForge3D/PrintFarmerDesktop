import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeDetectorHashes,
  DETECTOR_DIR,
  formatAnnotation,
  main,
  parseArgs,
  parseDetectorOutput,
  partitionFindings,
  runDetector,
  verifyDetectorManifest,
} from '../scripts/design-detector.mjs';
import type { DetectorManifest } from '../scripts/design-detector.mjs';
import {
  extractEditedPaths,
  formatContext,
  readHookSettings,
  toRepoRelative,
} from '../scripts/design-detector-hook.mjs';
import {
  designSurfacePaths,
  isDesignGovernancePath,
  isDesignSurfacePath,
  requiresDesignReview,
} from '../scripts/design-surface.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SLOP_TSX =
  'export const B = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 ' +
  'bg-clip-text text-transparent">Hi</h1>;\n';
const CLEAN_TSX = 'export const C = () => <h1 className="title">Hi</h1>;\n';

describe('design surface classification', () => {
  it.each([
    ['src/renderer/App.tsx', true],
    ['src/renderer/styles/app.css', true],
    ['src\\renderer\\nested\\View.jsx', true],
    ['./src/renderer/index.html', true],
    ['index.html', true],
    ['src/renderer/state/store.ts', false],
    ['src/main/window.tsx', false],
    ['docs/screens.css', false],
    ['src/renderer/App.TSX', true],
    ['../src/renderer/App.tsx', false],
  ])('%s -> %s', (file, expected) => {
    expect(isDesignSurfacePath(file)).toBe(expected);
  });

  it('governance paths need design review but are not scan targets', () => {
    for (const file of [
      'DESIGN.md',
      '.impeccable/config.json',
      'tools/impeccable-detector/detect.mjs',
    ]) {
      expect(isDesignGovernancePath(file)).toBe(true);
      expect(isDesignSurfacePath(file)).toBe(false);
      expect(requiresDesignReview([file])).toBe(true);
    }
    expect(
      requiresDesignReview(['src/main/index.ts', 'docs/ARCHITECTURE.md']),
    ).toBe(false);
  });

  it('dedupes and normalizes scan targets', () => {
    expect(
      designSurfacePaths([
        'src/renderer/A.tsx',
        'src\\renderer\\A.tsx',
        'src/renderer/a.ts',
      ]),
    ).toEqual(['src/renderer/A.tsx']);
  });
});

describe('vendored detector integrity', () => {
  it('the committed manifest matches the vendored files exactly', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, DETECTOR_DIR, 'manifest.json'), 'utf8'),
    ) as DetectorManifest;
    expect(
      verifyDetectorManifest(
        manifest,
        computeDetectorHashes(path.join(repoRoot, DETECTOR_DIR)),
      ),
    ).toEqual([]);
  });

  it('control: an edited, missing, or added file is reported', () => {
    const manifest = { files: { 'a.mjs': '1', 'b.mjs': '2' } };
    expect(
      verifyDetectorManifest(manifest, { 'a.mjs': 'X', 'c.mjs': '3' }),
    ).toEqual(['modified: a.mjs', 'missing: b.mjs', 'unlisted: c.mjs']);
    expect(verifyDetectorManifest({}, {})).toEqual([
      'manifest has no "files" map',
    ]);
  });
});

describe('detector output handling', () => {
  it('only non-advisory findings block', () => {
    const { blocking, advisory } = partitionFindings([
      { antipattern: 'a' },
      { antipattern: 'b', advisory: true },
    ]);
    expect(blocking.map((f) => f.antipattern)).toEqual(['a']);
    expect(advisory.map((f) => f.antipattern)).toEqual(['b']);
  });

  it('rejects non-array JSON rather than reading it as clean', () => {
    expect(parseDetectorOutput('')).toEqual([]);
    expect(() => parseDetectorOutput('{"ok":true}')).toThrow(/not an array/);
    expect(() => parseDetectorOutput('Warning: nope')).toThrow();
  });

  it('escapes workflow-command metacharacters in annotations', () => {
    const line = formatAnnotation(
      {
        file: path.join(repoRoot, 'src/renderer/a,b.tsx'),
        line: 3,
        antipattern: 'x',
        description: '50%\nnext',
      },
      repoRoot,
    );
    expect(line).toBe(
      '::error file=src/renderer/a%2Cb.tsx,line=3,title=impeccable%3A x::50%25%0Anext',
    );
  });

  it('argument modes are mutually exclusive', () => {
    expect(() => parseArgs([])).toThrow(/exactly one/);
    expect(() => parseArgs(['--all', '--files', 'a.tsx'])).toThrow(
      /exactly one/,
    );
    expect(() => parseArgs(['--base', 'x'])).toThrow(/together/);
    expect(parseArgs(['--files', 'a.tsx', 'b.css']).files).toEqual([
      'a.tsx',
      'b.css',
    ]);
  });
});

describe('running the vendored detector', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'design-detector-'));
    cpSync(path.join(repoRoot, DETECTOR_DIR), path.join(root, DETECTOR_DIR), {
      recursive: true,
    });
    mkdirSync(path.join(root, 'src/renderer'), { recursive: true });
    writeFileSync(path.join(root, 'src/renderer/Slop.tsx'), SLOP_TSX);
    writeFileSync(path.join(root, 'src/renderer/Clean.tsx'), CLEAN_TSX);
    writeFileSync(
      path.join(root, 'src/renderer/Suppressed.tsx'),
      `// impeccable-disable gradient-text, ai-color-palette -- test fixture\n${SLOP_TSX}`,
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('flags slop and passes the clean control', () => {
    const slop = partitionFindings(
      runDetector(root, ['src/renderer/Slop.tsx']),
    ).blocking;
    expect(slop.map((f) => f.antipattern).sort()).toEqual([
      'ai-color-palette',
      'gradient-text',
    ]);
    expect(runDetector(root, ['src/renderer/Clean.tsx'])).toEqual([]);
  });

  it('honors inline impeccable-disable comments', () => {
    expect(
      partitionFindings(runDetector(root, ['src/renderer/Suppressed.tsx']))
        .blocking,
    ).toEqual([]);
  });

  it('honors .impeccable/config.json ignoreRules, and only for the listed rule', () => {
    mkdirSync(path.join(root, '.impeccable'), { recursive: true });
    const configPath = path.join(root, '.impeccable/config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ detector: { ignoreRules: ['gradient-text'] } }),
    );
    try {
      const findings = runDetector(root, ['src/renderer/Slop.tsx']).map(
        (f) => f.antipattern,
      );
      expect(findings).toEqual(['ai-color-palette']);
    } finally {
      rmSync(configPath);
    }
  });

  it('main fails on findings, passes clean files, and fails on a missing target', () => {
    expect(main(['--files', 'src/renderer/Slop.tsx'], root)).toBe(1);
    expect(
      main(['--files', 'src/renderer/Clean.tsx', 'src/main/ignored.ts'], root),
    ).toBe(0);
    expect(main(['--files', 'src/renderer/Gone.tsx'], root)).toBe(1);
  });

  it('main refuses to run a tampered detector', () => {
    const victim = path.join(root, DETECTOR_DIR, 'detector/findings.mjs');
    const original = readFileSync(victim, 'utf8');
    writeFileSync(victim, `${original}\n// tampered\n`);
    try {
      expect(main(['--files', 'src/renderer/Clean.tsx'], root)).toBe(1);
    } finally {
      writeFileSync(victim, original);
    }
  });
});

describe('the agent edit hook', () => {
  it('extracts paths from edit, create, and apply_patch payloads', () => {
    expect(
      extractEditedPaths('edit', '{"path":"src/renderer/A.tsx","old_str":"x"}'),
    ).toEqual(['src/renderer/A.tsx']);
    expect(
      extractEditedPaths('create', { path: 'src/renderer/B.css' }),
    ).toEqual(['src/renderer/B.css']);
    expect(
      extractEditedPaths(
        'apply_patch',
        '*** Begin Patch\n*** Add File: src/renderer/C.tsx\n+x\n*** Update File: src/main/d.ts\n' +
          '*** Move to: src/renderer/E.tsx\n*** Delete File: src/renderer/F.tsx\n*** End Patch',
      ),
    ).toEqual(['src/renderer/C.tsx', 'src/main/d.ts', 'src/renderer/E.tsx']);
    expect(extractEditedPaths('edit', 'not json')).toEqual([]);
    expect(extractEditedPaths('view', '{"path":"x"}')).toEqual(['x']);
  });

  it('maps absolute and cwd-relative paths into the repo, rejecting escapes', () => {
    const root = path.resolve('/repo');
    expect(toRepoRelative(root, path.join(root, 'src/renderer/A.tsx'))).toBe(
      'src/renderer/A.tsx',
    );
    expect(toRepoRelative(root, 'A.tsx', path.join(root, 'src/renderer'))).toBe(
      'src/renderer/A.tsx',
    );
    expect(toRepoRelative(root, path.resolve('/elsewhere/A.tsx'))).toBeNull();
  });

  it('is on by default and can be switched off by config or environment', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'design-hook-'));
    try {
      expect(readHookSettings(root, {}).enabled).toBe(true);
      expect(
        readHookSettings(root, { IMPECCABLE_HOOK_DISABLED: '1' }).enabled,
      ).toBe(false);
      mkdirSync(path.join(root, '.impeccable'));
      writeFileSync(
        path.join(root, '.impeccable/config.json'),
        JSON.stringify({ hook: { enabled: true, limits: { maxFindings: 2 } } }),
      );
      writeFileSync(
        path.join(root, '.impeccable/config.local.json'),
        JSON.stringify({ hook: { enabled: false } }),
      );
      const settings = readHookSettings(root, {});
      expect(settings.enabled).toBe(false);
      expect(settings.limits).toEqual({ maxFindings: 2, maxChars: 8000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps the injected context by finding count and characters', () => {
    const findings = Array.from({ length: 4 }, (_, i) => ({
      file: path.join(repoRoot, 'src/renderer/A.tsx'),
      line: i + 1,
      antipattern: 'gradient-text',
      description: 'd',
    }));
    const text = formatContext(findings, repoRoot, {
      maxFindings: 2,
      maxChars: 8000,
    });
    expect(text).toContain('flagged 4 issue(s)');
    expect(text).toContain('...and 2 more');
    expect(
      formatContext(findings, repoRoot, { maxFindings: 5, maxChars: 40 }),
    ).toHaveLength(40);
  });

  it('the committed hook manifest runs the hook after editing tools', () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(repoRoot, '.github/hooks/impeccable.json'),
        'utf8',
      ),
    ) as {
      hooks: {
        postToolUse: { matcher: string; bash: string; powershell: string }[];
      };
    };
    expect(manifest.hooks.postToolUse).toHaveLength(1);
    const entry = manifest.hooks.postToolUse[0]!;
    expect(entry.matcher).toBe('edit|create|apply_patch');
    expect(entry.bash).toContain('scripts/design-detector-hook.mjs');
    expect(entry.powershell).toContain('scripts/design-detector-hook.mjs');
  });
});
