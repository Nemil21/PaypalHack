import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'docs/**',
      'spikes/**',
      'skill/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // packages/shared and apps/web run in the browser: no Node built-ins or globals.
    files: ['packages/shared/src/**/*.ts', 'apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: ['**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'packages/shared must stay browser-safe.' }] },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', 'require', '__dirname', '__filename'],
    },
  },
  {
    // HF-055 embed widget: a plain browser script served as-is from apps/web/public.
    files: ['apps/web/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
);
