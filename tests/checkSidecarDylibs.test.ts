import { describe, expect, it } from 'vitest';

import {
  checkSidecarDylibs,
  findDisallowedDylibs,
  parseOtoolDylibs,
} from '../scripts/check-sidecar-dylibs.mjs';

const SIDECAR =
  '/Applications/PrintFarmer Desktop.app/Contents/Resources/sidecar/model-core';

// Verbatim `otool -L` of the shipped 0.1.0-beta.8 universal sidecar (#828).
const BETA_8_OTOOL = `${SIDECAR} (architecture x86_64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 5026.5.4)
\t/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices (compatibility version 1.0.0, current version 1226.0.0)
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
${SIDECAR} (architecture arm64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 5026.5.4)
\t/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices (compatibility version 1.0.0, current version 1226.0.0)
\t/opt/homebrew/opt/xz/lib/liblzma.5.dylib (compatibility version 14.0.0, current version 14.4.0)
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

const FIXED_OTOOL = BETA_8_OTOOL.replace(
  /\t\/opt\/homebrew\/opt\/xz\/lib\/liblzma\.5\.dylib[^\n]*\n/,
  '',
);

describe('check-sidecar-dylibs', () => {
  it('parses every slice of a universal binary, including paths with spaces', () => {
    const slices = parseOtoolDylibs(BETA_8_OTOOL);
    expect(slices.map((slice) => slice.arch)).toEqual(['x86_64', 'arm64']);
    expect(slices[1]?.dylibs).toContain(
      '/opt/homebrew/opt/xz/lib/liblzma.5.dylib',
    );
    expect(slices[0]?.dylibs).toHaveLength(4);
  });

  it('rejects the shipped beta.8 sidecar for its arm64 Homebrew liblzma', () => {
    expect(findDisallowedDylibs(parseOtoolDylibs(BETA_8_OTOOL))).toEqual([
      'arm64: links non-system dylib /opt/homebrew/opt/xz/lib/liblzma.5.dylib',
    ]);
  });

  it('accepts the same sidecar once only OS libraries remain', () => {
    expect(findDisallowedDylibs(parseOtoolDylibs(FIXED_OTOOL))).toEqual([]);
  });

  it('parses a thin binary as a single unlabelled slice', () => {
    const thin = `${SIDECAR}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
    expect(parseOtoolDylibs(thin)).toEqual([
      { arch: null, dylibs: ['/usr/lib/libSystem.B.dylib'] },
    ]);
  });

  it.each([
    '@rpath/liblzma.5.dylib',
    '@executable_path/../Frameworks/liblzma.5.dylib',
    '/usr/local/lib/liblzma.5.dylib',
    '/opt/homebrew/lib/liblzma.5.dylib',
  ])('rejects %s', (dylib) => {
    expect(
      findDisallowedDylibs([
        { arch: 'arm64', dylibs: ['/usr/lib/libSystem.B.dylib', dylib] },
      ]),
    ).toEqual([`arm64: links non-system dylib ${dylib}`]);
  });

  it('fails closed on output it cannot have read correctly', () => {
    expect(findDisallowedDylibs([])).toEqual([
      'otool reported no architecture slices',
    ]);
    expect(findDisallowedDylibs([{ arch: 'arm64', dylibs: [] }])).toEqual([
      'arm64: otool reported no linked libraries',
    ]);
    expect(() => parseOtoolDylibs('\t/usr/lib/libSystem.B.dylib')).toThrow();
    expect(() => parseOtoolDylibs('not otool output')).toThrow();
  });

  it('runs otool across all architectures and reports a failed invocation', () => {
    const calls: unknown[][] = [];
    const ok = checkSidecarDylibs(SIDECAR, {
      run: ((...args: unknown[]) => {
        calls.push(args);
        return { status: 0, stdout: FIXED_OTOOL, stderr: '' };
      }) as never,
    });
    expect(ok).toEqual([]);
    expect(calls[0]?.slice(0, 2)).toEqual([
      'otool',
      ['-L', '-arch', 'all', SIDECAR],
    ]);

    const failed = checkSidecarDylibs(SIDECAR, {
      run: (() => ({ status: 1, stdout: '', stderr: 'no such file' })) as never,
    });
    expect(failed).toEqual(['otool exited with status 1: no such file']);
  });
});
