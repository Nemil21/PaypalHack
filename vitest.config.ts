import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a prior build.
  // Aliases, not a `source` resolve condition: Vitest passes SSR conditions to Node as
  // `--conditions`, and third-party packages that also export `source` (e.g. eventsource,
  // under @renderinc/sdk) would then load raw .ts from node_modules and fail.
  resolve: {
    alias: [
      { find: /^@holdfast\/shared$/, replacement: src('shared') },
      { find: /^@holdfast\/core$/, replacement: src('core') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
