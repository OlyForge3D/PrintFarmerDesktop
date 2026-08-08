// Fixture: a clean vitest.config.ts whose setupFiles matches the live
// project's allowlist exactly. Used as the CONTROL for
// scripts/check-setup-files.mjs -- proves the gate does not falsely redden a
// config that matches the allowlist.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
