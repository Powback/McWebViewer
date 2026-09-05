// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '.cache/**', 'out/**', '*.tmp.*'],
  },
  {
    // Build scripts and the bridge run under Node, not the browser. `no-undef` has no way
    // to know that on its own, so declare the runtime's globals instead of leaving it to
    // guess. The bridge is linted with the same complexity limits as everything else —
    // it is the process that talks to a live server, so it is the last place to relax.
    files: ['scripts/**/*.mjs', 'bridge/src/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    rules: {
      // The point of these limits is that geometry code drifts toward one giant
      // function with a dozen special cases; keeping them low forces the special cases
      // into named, testable helpers.
      complexity: ['error', { max: 10 }],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      'max-lines-per-function': ['error', { max: 80, skipComments: true, skipBlankLines: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
