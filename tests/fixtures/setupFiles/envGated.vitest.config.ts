// Fixture: POSITIVE CONTROL. The extra setupFiles entry only appears when
// `process.env.VITEST` is set -- exactly Vasquez's PR #642 review repro
// (env-gated bypass). Vitest's own CLI sets `process.env.VITEST = 'true'`
// before resolving config (see `prepareVitest` in vitest's cli-api chunk);
// a checker that resolves this config without first setting that variable
// would see a clean config while a real `vitest run` would execute the
// extra file.
import { defineConfig } from 'vitest/config';

const extra = process.env.VITEST
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
