// Fixture: POSITIVE CONTROL variant. The unexpected setup file is added via
// a spread/computed array construction rather than a literal entry in the
// setupFiles array -- mirroring #518's computed-key evasion for
// testNamePattern. Because this gate resolves the config through vite's OWN
// `loadConfigFromFile` (which evaluates the module) rather than a
// source-text match, this must be caught identically to the literal form in
// spoofed.vitest.config.ts.
import { defineConfig } from 'vitest/config';

const extra = ['./tests/fixtures/setupFiles/spoofPlatformWitnesses.ts'];

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts', ...extra],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
