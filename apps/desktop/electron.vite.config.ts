import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The shared core is consumed as TypeScript source rather than as a built
 * package. Vite compiles it as part of whichever bundle imports it, so there's
 * no build step to run before the app starts and no stale `dist` to get out of
 * sync during development. The Android app resolves the same alias.
 */
const coreAlias = {
  '@longbox/core': resolve(__dirname, '../../packages/core/src/index.ts'),
};

export default defineConfig({
  main: {
    // Native and heavyweight Node dependencies stay external so they load from
    // node_modules at runtime instead of being inlined into the bundle.
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: coreAlias },
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      rollupOptions: {
        // Preload scripts run in a CommonJS context under contextIsolation.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    resolve: { alias: coreAlias },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
});
