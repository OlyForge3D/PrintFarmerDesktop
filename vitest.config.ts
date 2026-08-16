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
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
});
