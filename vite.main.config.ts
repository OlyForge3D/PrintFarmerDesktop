import { defineConfig } from 'vite';

// Vite config for the Electron main process bundle.
export default defineConfig({
  build: {
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
