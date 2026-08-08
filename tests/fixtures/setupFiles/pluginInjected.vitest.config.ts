// Fixture: POSITIVE CONTROL. The extra setupFiles entry is injected by a
// Vite plugin's `config()` hook rather than committed directly in the
// exported config object -- exactly Vasquez's PR #642 review repro
// (plugin-injection bypass). Vite's own config resolution (`resolveConfig`,
// used internally by `createServer`/`createVitest`) merges every plugin's
// `config()` hook return value into the final resolved config; a checker
// that only evaluates the exported config module (e.g. vite's bare
// `loadConfigFromFile`, which does not run the plugin pipeline) would never
// see this entry, while a real `vitest run` -- which always resolves config
// through the full plugin pipeline -- would execute it.
import { defineConfig } from 'vitest/config';

function injectExtraSetupFile() {
  return {
    name: 'inject-extra-setup-file-for-test',
    config() {
      return {
        test: {
          setupFiles: [
            './tests/setup.ts',
            './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
          ],
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [injectExtraSetupFile()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
