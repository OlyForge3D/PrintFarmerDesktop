import { defineConfig } from 'vite';
import { createPublicKey } from 'node:crypto';

function decodeUpdatePublicKey(): string {
  const encoded = process.env.PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64?.trim();
  if (!encoded) return '';

  const publicKey = Buffer.from(encoded, 'base64').toString('utf8');
  if (!publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error(
      'PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64 must contain a base64-encoded PEM public key',
    );
  }
  try {
    createPublicKey(publicKey);
  } catch (error) {
    throw new Error(
      'PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64 does not contain a valid PEM public key',
      { cause: error },
    );
  }
  return publicKey;
}

// Vite config for the Electron main process bundle.
//
// The bundle MUST be emitted as ESM: the source uses ESM-only APIs
// (`import.meta.dirname`) and package.json declares `"type": "module"`, so Node
// loads the built `.js` through its ESM loader. Without this, the Forge Vite
// plugin's default CommonJS output injects `require`, which throws
// "require is not defined in ES module scope" before the app can start.
export default defineConfig({
  define: {
    __PRINTFARMER_E2E_BUILD__: JSON.stringify(
      process.env.PRINTFARMER_BUILD_E2E === '1',
    ),
    __PRINTFARMER_UPDATE_PUBLIC_KEY__: JSON.stringify(decodeUpdatePublicKey()),
    __PRINTFARMER_UPDATE_METADATA_URL__: JSON.stringify(
      'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/latest/download/latest.json',
    ),
  },
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
