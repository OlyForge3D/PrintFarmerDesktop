import { defineConfig } from 'vite';

// Vite config for the Electron main process bundle.
//
// The bundle MUST be emitted as ESM: the source uses ESM-only APIs
// (`import.meta.dirname`) and package.json declares `"type": "module"`, so Node
// loads the built `.js` through its ESM loader. Without this, the Forge Vite
// plugin's default CommonJS output injects `require`, which throws
// "require is not defined in ES module scope" before the app can start.
export default defineConfig({
  build: {
    // Providing our own `lib` config stops @electron-forge/plugin-vite from
    // forcing its default CommonJS output. We emit ESM so the built `main.js`
    // uses `import` (compatible with package.json `"type": "module"` and the
    // source's `import.meta.dirname`) instead of `require`.
    lib: {
      entry: 'src/main/main.ts',
      fileName: () => '[name].js',
      formats: ['es'],
    },
    rollupOptions: {
      // Electron and Node built-ins must stay external in the main process.
      external: ['electron'],
    },
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
});
