import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  handlePayload,
  readHookSettings,
  toRepoRelative,
} from '../scripts/design-detector-hook.mjs';
import {
  DESIGN_GOVERNANCE_FILES,
  DESIGN_GOVERNANCE_PREFIXES,
  designSurfacePaths,
  isDesignGovernancePath,
  isDesignReviewPath,
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

  // Pinned by hand, not derived from the export: dropping an entry from
  // design-surface.mjs would silently remove Lambert from that file's PRs.
  const EXPECTED_GOVERNANCE_FILES = [
    'DESIGN.md',
    'PRODUCT.md',
    'scripts/design-surface.mjs',
    'scripts/design-surface.d.mts',
    'scripts/design-detector.mjs',
    'scripts/design-detector.d.mts',
    'scripts/design-detector-hook.mjs',
    'scripts/design-detector-hook.d.mts',
    'scripts/design-baseline.mjs',
    'scripts/design-ratchet.mjs',
    'scripts/design-ratchet.d.mts',
    'reports/design-baseline.json',
    '.github/workflows/design-detector.yml',
    '.github/workflows/design-ratchet.yml',
    '.github/hooks/impeccable.json',
  ];
  const EXPECTED_GOVERNANCE_PREFIXES = [
    '.impeccable/',
    'tools/impeccable-detector/',
  ];

  it('the governance set is exactly the pinned list', () => {
    expect([...DESIGN_GOVERNANCE_FILES].sort()).toEqual(
      [...EXPECTED_GOVERNANCE_FILES].sort(),
    );
    expect([...DESIGN_GOVERNANCE_PREFIXES].sort()).toEqual(
      [...EXPECTED_GOVERNANCE_PREFIXES].sort(),
    );
  });

  it.each([
    ...EXPECTED_GOVERNANCE_FILES,
    '.impeccable/config.json',
    'tools/impeccable-detector/detect.mjs',
    'tools\\impeccable-detector\\detector\\findings.mjs',
  ])('governance path %s needs design review but is not scanned', (file) => {
    expect(isDesignGovernancePath(file)).toBe(true);
    expect(isDesignSurfacePath(file)).toBe(false);
    expect(requiresDesignReview([file])).toBe(true);
  });

  it.each([
    'docs/DESIGN.md',
    'DESIGN.md.bak',
    'PRODUCT.txt',
    'scripts/design-surfaces.mjs',
    'scripts/squad-verdict-gate.mjs',
    '.github/workflows/design-detector-old.yml',
    '.github/hooks/other.json',
    '.impeccable',
    'tools/impeccable-detector-old/detect.mjs',
    'src/main/index.ts',
  ])('control: near-miss %s is not governance', (file) => {
    expect(isDesignGovernancePath(file)).toBe(false);
    expect(requiresDesignReview([file])).toBe(false);
  });

  it('every renderer file needs review even when it is not a scan target', () => {
    for (const file of [
      'src/renderer/library/sceneMaterials.ts',
      'src/renderer/viewer/sceneGraph.ts',
      'src/renderer/assets/logo.svg',
    ]) {
      expect(isDesignSurfacePath(file)).toBe(false);
      expect(isDesignReviewPath(file)).toBe(true);
      expect(requiresDesignReview([file])).toBe(true);
    }
    expect(isDesignReviewPath('src/main/renderer.ts')).toBe(false);
    expect(isDesignReviewPath('../src/renderer/App.ts')).toBe(false);
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

  it('distinguishes JSDoc image references from real JSX images without losing lines or waivers', () => {
    const file = 'src/renderer/ImageFixture.tsx';
    writeFileSync(
      path.join(root, file),
      [
        '/** Get a React <img> element. */',
        '/**',
        ' * Another <img> example.',
        ' */',
        'const dynamic = <img src={url} alt="ok" />;',
        'const missing = <img alt="missing" />;',
        '// impeccable-disable-next-line broken-image -- fixture',
        'const suppressed = <img alt="suppressed" />;',
        '/** <img> */ const after = <img alt="after" />;',
        'const template = `<img alt="template" />`;',
        'const templateComment = `/** <img alt="literal" /> */`;',
        `const quoted = "/** <img alt='quoted' /> */";`,
      ].join('\n'),
    );
    const findings = runDetector(root, [file]).filter(
      (finding) => finding.antipattern === 'broken-image',
    );
    expect(findings.map((finding) => finding.line)).toEqual([6, 9, 10, 11, 12]);
    expect(findings[0]?.snippet).toContain('alt="missing"');
    expect(findings[1]?.snippet).toContain('alt="after"');
  });

  it('uses the same source-context rules in profiling mode', () => {
    const script = `
      import { detectText } from './tools/impeccable-detector/detector/engines/regex/detect-text.mjs';
      const source = '/** <img> */\\nconst a = <img alt="x" />;\\n<span className="pf-animate-spin rounded-full border-b-2" />;';
      const normal = detectText(source, 'src/renderer/x.tsx');
      const profiled = detectText(source, 'src/renderer/x.tsx', { profile: { events: [] } });
      if (JSON.stringify(normal) !== JSON.stringify(profiled)) process.exit(1);
      if (normal.length !== 1 || normal[0].antipattern !== 'broken-image' || normal[0].line !== 2) process.exit(2);
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not hide JSX images inside comment-like text', () => {
    const file = 'src/renderer/JsxTextFixture.tsx';
    writeFileSync(
      path.join(root, file),
      [
        'const example = <div>/** example',
        '<img alt="missing" />',
        '*/</div>;',
      ].join('\n'),
    );
    const pairedFile = 'src/renderer/PairedImageFixture.tsx';
    writeFileSync(
      path.join(root, pairedFile),
      ['const paired = <div>/** example', '<img></img>', '*/</div>;'].join(
        '\n',
      ),
    );
    const findings = runDetector(root, [file, pairedFile]).filter(
      (finding) => finding.antipattern === 'broken-image',
    );
    expect(findings.map((finding) => [finding.file, finding.line])).toEqual([
      [path.join(root, file), 2],
      [path.join(root, pairedFile), 2],
    ]);
  });

  it('excludes spinner rings only in the same class attribute, not real rounded cards', () => {
    const file = 'src/renderer/SpinnerFixture.tsx';
    writeFileSync(
      path.join(root, file),
      [
        '<span className="pf-animate-spin rounded-full border-b-2" />;',
        '<span className="animate-spin rounded-full border-t-2" />;',
        '<div className="rounded-lg border-b-2" />;',
        '',
        '',
        '<span className="animate-spin rounded-full" /><div className="rounded-lg border-b-2" />;',
        '',
        '',
        '<div className="rounded-full border-b-2" />;',
        '// impeccable-disable-next-line border-accent-on-rounded -- fixture',
        '<div className="rounded-lg border-b-2" />;',
      ].join('\n'),
    );
    const findings = runDetector(root, [file]).filter(
      (finding) => finding.antipattern === 'border-accent-on-rounded',
    );
    expect(findings.map((finding) => finding.line)).toEqual([3, 6, 9]);
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

  it('with --tool-root, a no-op detector in the scanned tree is never executed', () => {
    const trusted = mkdtempSync(path.join(tmpdir(), 'design-trusted-'));
    const prDetect = path.join(root, DETECTOR_DIR, 'detect.mjs');
    const original = readFileSync(prDetect, 'utf8');
    const manifestPath = path.join(root, DETECTOR_DIR, 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    try {
      cpSync(
        path.join(repoRoot, DETECTOR_DIR),
        path.join(trusted, DETECTOR_DIR),
        { recursive: true },
      );
      // The change under test swaps in a no-op and regenerates its manifest.
      writeFileSync(prDetect, 'console.log("[]");\n');
      expect(main(['--write-manifest'], root)).toBe(0);
      // Control: trusting the change's own copy, the slop passes.
      expect(main(['--files', 'src/renderer/Slop.tsx'], root)).toBe(0);
      // Treatment: the trusted copy still catches it.
      expect(
        main(
          ['--tool-root', trusted, '--files', 'src/renderer/Slop.tsx'],
          root,
        ),
      ).toBe(1);
    } finally {
      writeFileSync(prDetect, original);
      writeFileSync(manifestPath, originalManifest);
      rmSync(trusted, { recursive: true, force: true });
    }
  });

  it('--tool-root requires a value', () => {
    expect(() => parseArgs(['--tool-root'])).toThrow(/needs a directory/);
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

// A stand-in detector whose output and exit code the test controls through
// the environment, so runner and hook behaviour can be pinned per outcome
// without depending on which real rules happen to be advisory.
const FAKE_DETECT = [
  "const out = process.env.FAKE_DETECTOR_OUTPUT ?? '[]';",
  "process.stdout.write(out.replaceAll('__ROOT__', JSON.stringify(process.cwd()).slice(1, -1)));",
  "process.exitCode = Number(process.env.FAKE_DETECTOR_EXIT ?? '0');",
  '',
].join('\n');

function fakeFinding(advisory: boolean) {
  return JSON.stringify([
    {
      file: '__ROOT__/src/renderer/A.tsx',
      line: 1,
      antipattern: advisory ? 'advisory-rule' : 'blocking-rule',
      description: 'fake',
      ...(advisory ? { advisory: true } : {}),
    },
  ]);
}

function makeFakeRepo(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  mkdirSync(path.join(root, DETECTOR_DIR), { recursive: true });
  writeFileSync(path.join(root, DETECTOR_DIR, 'detect.mjs'), FAKE_DETECT);
  expect(main(['--write-manifest'], root)).toBe(0);
  mkdirSync(path.join(root, 'src/renderer'), { recursive: true });
  writeFileSync(path.join(root, 'src/renderer/A.tsx'), CLEAN_TSX);
  writeFileSync(path.join(root, 'src/main.ts'), 'export {};\n');
  return root;
}

function withFakeOutput<T>(output: string, exit: string, run: () => T): T {
  const saved = {
    out: process.env.FAKE_DETECTOR_OUTPUT,
    exit: process.env.FAKE_DETECTOR_EXIT,
  };
  process.env.FAKE_DETECTOR_OUTPUT = output;
  process.env.FAKE_DETECTOR_EXIT = exit;
  try {
    return run();
  } finally {
    if (saved.out === undefined) delete process.env.FAKE_DETECTOR_OUTPUT;
    else process.env.FAKE_DETECTOR_OUTPUT = saved.out;
    if (saved.exit === undefined) delete process.env.FAKE_DETECTOR_EXIT;
    else process.env.FAKE_DETECTOR_EXIT = saved.exit;
  }
}

describe('advisory findings through the enforcing runner', () => {
  let root: string;
  beforeAll(() => {
    root = makeFakeRepo('design-advisory-');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('an advisory-only result is reported but passes', () => {
    withFakeOutput(fakeFinding(true), '2', () => {
      const findings = runDetector(root, ['src/renderer/A.tsx']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.advisory).toBe(true);
      expect(main(['--files', 'src/renderer/A.tsx'], root)).toBe(0);
    });
  });

  it('control: the same result without advisory fails', () => {
    withFakeOutput(fakeFinding(false), '2', () => {
      expect(main(['--files', 'src/renderer/A.tsx'], root)).toBe(1);
    });
  });
});

describe('the agent edit hook end to end', () => {
  const hookScript = path.join(repoRoot, 'scripts/design-detector-hook.mjs');
  let root: string;
  beforeAll(() => {
    root = makeFakeRepo('design-hook-e2e-');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const editPayload = (file: string) => ({
    cwd: root,
    toolName: 'edit',
    toolArgs: JSON.stringify({ path: file }),
  });

  function blockingDetect(calls: string[][]) {
    return (_root: string, files: readonly string[]) => {
      calls.push([...files]);
      return [
        {
          file: path.join(root, files[0]!),
          line: 1,
          antipattern: 'gradient-text',
          description: 'fake',
        },
      ];
    };
  }

  it('injects blocking findings for an edited design-surface file', () => {
    const calls: string[][] = [];
    const output = handlePayload(editPayload('src/renderer/A.tsx'), {
      env: {},
      detect: blockingDetect(calls),
    });
    expect(calls).toEqual([['src/renderer/A.tsx']]);
    expect(output?.additionalContext).toContain('gradient-text');
  });

  it('control: disabled by config, it never runs the detector', () => {
    const configDir = path.join(root, '.impeccable');
    mkdirSync(configDir, { recursive: true });
    const local = path.join(configDir, 'config.local.json');
    writeFileSync(local, JSON.stringify({ hook: { enabled: false } }));
    try {
      const calls: string[][] = [];
      expect(
        handlePayload(editPayload('src/renderer/A.tsx'), {
          env: {},
          detect: blockingDetect(calls),
        }),
      ).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      rmSync(local);
    }
  });

  it('control: disabled by environment, it never runs the detector', () => {
    const calls: string[][] = [];
    expect(
      handlePayload(editPayload('src/renderer/A.tsx'), {
        env: { IMPECCABLE_HOOK_DISABLED: '1' },
        detect: blockingDetect(calls),
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it('stays silent for clean, advisory-only, and non-design edits', () => {
    expect(
      handlePayload(editPayload('src/renderer/A.tsx'), {
        env: {},
        detect: () => [],
      }),
    ).toBeNull();
    expect(
      handlePayload(editPayload('src/renderer/A.tsx'), {
        env: {},
        detect: () => [
          { file: 'x', antipattern: 'a', description: 'd', advisory: true },
        ],
      }),
    ).toBeNull();
    const calls: string[][] = [];
    expect(
      handlePayload(editPayload('src/main.ts'), {
        env: {},
        detect: blockingDetect(calls),
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  function runHook(stdin: string, output: string, exit: string) {
    return spawnSync(process.execPath, [hookScript], {
      cwd: root,
      input: stdin,
      encoding: 'utf8',
      env: {
        ...process.env,
        IMPECCABLE_HOOK_DISABLED: '',
        FAKE_DETECTOR_OUTPUT: output,
        FAKE_DETECTOR_EXIT: exit,
      },
    });
  }

  it('as a process, emits context for a blocking finding and exits 0', () => {
    const result = runHook(
      JSON.stringify(editPayload('src/renderer/A.tsx')),
      fakeFinding(false),
      '2',
    );
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { additionalContext: string };
    expect(output.additionalContext).toContain('blocking-rule');
  });

  it('as a process, malformed stdin produces no context and exits 0', () => {
    const result = runHook('not json', fakeFinding(false), '2');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('design-detector-hook');
  });

  it('as a process, a crashing detector produces no context and exits 0', () => {
    const result = runHook(
      JSON.stringify(editPayload('src/renderer/A.tsx')),
      'garbage',
      '5',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('detector exited 5');
  });
});
