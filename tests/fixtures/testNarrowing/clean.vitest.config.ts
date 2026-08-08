// Positive-control fixture for tests/checkTestNarrowing.test.ts: a config
// with no committed narrowing, structurally identical to the real
// vitest.config.ts otherwise. This is the "does the gate stay quiet on a
// clean config" arm -- without it, a gate that always reports a violation
// would look identical to one that actually checks anything.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
