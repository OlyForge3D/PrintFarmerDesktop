import { describe, expect, it } from 'vitest';

import { packagedSidecarPath } from '../e2e/helpers/retargetFixture.js';

describe('packagedSidecarPath', () => {
  it('resolves the Windows sidecar beside the executable', () => {
    expect(
      packagedSidecarPath(
        'C:\\out\\PrintFarmer Desktop-win32-x64\\PrintFarmer Desktop.exe',
        'win32',
      ),
    ).toBe(
      'C:\\out\\PrintFarmer Desktop-win32-x64\\resources\\sidecar\\model-core.exe',
    );
  });

  it('resolves the macOS sidecar from Contents/Resources, not Contents/MacOS', () => {
    expect(
      packagedSidecarPath(
        '/out/PrintFarmer Desktop-darwin-arm64/PrintFarmer Desktop.app/Contents/MacOS/PrintFarmer Desktop',
        'darwin',
      ),
    ).toBe(
      '/out/PrintFarmer Desktop-darwin-arm64/PrintFarmer Desktop.app/Contents/Resources/sidecar/model-core',
    );
  });

  it('resolves the Linux sidecar beside the executable', () => {
    expect(
      packagedSidecarPath(
        '/out/PrintFarmer Desktop-linux-x64/PrintFarmer Desktop',
        'linux',
      ),
    ).toBe('/out/PrintFarmer Desktop-linux-x64/resources/sidecar/model-core');
  });
});
