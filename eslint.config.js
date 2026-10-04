// ESLint flat config. Zero plugin oltre a typescript-eslint: le regole che valgono
// qui stanno nel tsconfig (`strict`, `noUncheckedIndexedAccess`,
// `exactOptionalPropertyTypes`), non in un secondo posto che può divergere.
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
      // il limite è 0 warning: un warning che nessuno legge è rumore che copre i bug
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `_` davanti = "esiste per escludere qualcosa dal tipo/dalla destrutturazione"
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],

      // un commento che spiega il perché è codice; un "da fare" è un debito che cresce
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
    },
  },
  {
    // nei test l'obiettivo è verificare il comportamento, non dimostrare che
    // TypeScript sa cosa sia uno stub
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-warning-comments': 'off',
    },
  },
  {
    // un esempio è codice che gira: le stesse regole valgono
    files: ['examples/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);