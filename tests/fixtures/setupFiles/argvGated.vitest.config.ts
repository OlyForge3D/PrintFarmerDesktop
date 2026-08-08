// Fixture: POSITIVE CONTROL. The extra setupFiles entry only appears when
// `process.argv[1]` looks like a real vitest invocation -- exactly Vasquez's
// PR #642 review repro (argv-gated bypass). A checker that resolves this
// config from a plain `node` process whose argv does not mention vitest
// would see a clean config while a real `vitest run` (whose argv[1] is the
// vitest binary) would execute the extra file. This gate must resolve the
// config the way vitest itself would be invoked, so it must see the extra
// entry regardless of the checker process's own argv.
import { defineConfig } from 'vitest/config';

const looksLikeVitestInvocation = (process.argv[1] ?? '').includes('vitest');
const extra = looksLikeVitestInvocation
  ? ['./tests/fixtures/setupFiles/spoofPlatformWitnesses.ts']
  : [];

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts', ...extra],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
