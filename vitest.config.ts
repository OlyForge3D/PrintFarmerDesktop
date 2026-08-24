import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Deliberate, explicit default (matches vitest's own built-in value) so the
    // budget is a number someone picked, not a silently-inherited framework
    // default. Kept tight so a genuine hang fails fast almost everywhere.
    // Known-heavy files (see tests/calibrationActionInterlock.test.ts and
    // tests/orcaProfileDiscoveryScale.test.ts) opt into a larger per-file
    // budget via `vi.setConfig({ testTimeout })` instead of raising this
    // global value — see issue #734.
    testTimeout: 5000,
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
    // node` pragma (see e.g. `tests/calibrationHttp.test.ts`); this glob
    // covers acceptance files that a sibling branch owns and cannot receive
    // an in-file pragma via this repo's changes without cross-branch
    // coordination.
    environmentMatchGlobs: [['tests/**/*.acceptance.test.ts', 'node']],
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
});
