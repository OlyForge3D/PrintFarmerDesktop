// Fixture: POSITIVE CONTROL. A committed vitest.config.ts with a planted,
// unexpected setupFiles entry -- the exact attack shape from issue #539: an
// extra setup file that would run inside every worker before any test
// module. Never applied to the live vitest.config.ts; this is what
// scripts/check-setup-files.mjs must refuse.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [
      './tests/setup.ts',
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
