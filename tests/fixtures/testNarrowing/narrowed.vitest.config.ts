// Positive-control fixture for tests/checkTestNarrowing.test.ts: a literal
// committed `testNamePattern`, the plain form of the narrowing this gate
// exists to refuse.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testNamePattern: 'only this one arm',
  },
});
