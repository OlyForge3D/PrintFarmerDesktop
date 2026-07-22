import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the React renderer.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
});
