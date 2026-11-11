import { defineConfig, defaultClientConditions } from 'vite';

// `source` resolves workspace packages to their TypeScript sources, so the browser bundle is
// built from packages/shared/src directly. No Node polyfills are configured: if shared ever
// imports a Node built-in, this build breaks (see HF-001).
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
