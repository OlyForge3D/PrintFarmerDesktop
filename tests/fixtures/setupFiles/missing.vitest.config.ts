// Fixture: a committed vitest.config.ts that DROPS the allowlisted setup
// file entirely (setupFiles: []). Demonstrates the gate also refuses a
// silent removal of a trusted setup file, not only an addition.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
