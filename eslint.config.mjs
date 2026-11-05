import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // The gateway logs through pino; a stray `console.log` bypasses the
      // redaction rules that keep tokens out of the log sink.
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },

  {
    files: ['apps/gateway/src/main.ts'],
    rules: {
      // Configuration can fail before the logger exists.
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/*.config.{ts,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  {
    // The documentation test is a plain Node script, but it inspects the records
    // its subjects produce with the same browser primitives they use — `atob`,
    // `TextDecoder` — so both sets of globals are in play.
    files: ['docs/encryption-tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, atob: 'readonly', btoa: 'readonly' },
    },
  },
);
