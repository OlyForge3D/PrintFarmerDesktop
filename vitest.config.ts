import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { ciWindowsTimeout } from './tests/helpers/ciWindowsTimeout.js';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // #874: 48 observations/callback, default-budget subprocess tail 17.468s.
    // Windows CI gets 30s (+72%); developer/macOS limits remain 5s/10s.
    // Hook 20s is provisional: only one 13.243s hook-associated overrun,
    // not a measured hook p99. See CONTRIBUTING for evidence/revisit criteria.
    testTimeout: ciWindowsTimeout(5000, 30_000),
    hookTimeout: ciWindowsTimeout(10_000, 20_000),
    // This suite contains many subprocess-heavy files. Bounding workers avoids
    // CPU contention turning their explicit per-file budgets into false hangs.
    maxWorkers: 2,
    // Test files whose names end in `.acceptance.test.ts` exercise
    // main-process modules against fetch-shaped fakes. Under the default
    // `jsdom` environment, `AbortController`/`AbortSignal` come from jsdom's
    // Window (Web API implementations) while `fetch`/`Request` remain
    // Node/undici built-ins — so `new AbortController().signal` from a
    // desktop timeout produces a jsdom signal that undici's `new Request(
    // input, init)` rejects with "RequestInit: Expected signal (\"AbortSignal
    // {}\") to be an instance of AbortSignal." That realm mismatch is a
    // vitest-env artefact, not a production one — the Electron main process
    // is Node/undici end to end, no jsdom involved. Route these files to
    // `node` so their runtime matches production. The convention for other
    // main-process tests in this repo is a per-file `// @vitest-environment
    // node` pragma (see e.g. `tests/calibrationHttp.test.ts`). Vitest 5 removed
    // `environmentMatchGlobs`, so acceptance files use the same pragma.
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
});
