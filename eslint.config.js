// ESLint flat config. No plugins beyond typescript-eslint: the rules that matter
// here live in tsconfig (`strict`, `noUncheckedIndexedAccess`,
// `exactOptionalPropertyTypes`), not in a second place that can drift.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'traces/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // the limit is 0 warnings: a warning nobody reads is noise that hides bugs
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `_` prefix = "exists to exclude something from the type/destructuring"
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],

      // a comment that explains why is code; a "to do" is a debt that grows
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
    },
  },
  {
    // in tests the goal is to verify behavior, not to prove that TypeScript knows
    // what a stub is
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-warning-comments': 'off',
    },
  },
  {
    // an example is code that runs: the same rules apply
    files: ['examples/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
