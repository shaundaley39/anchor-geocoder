// Conservative configuration. Type checking already comes from `tsc --noEmit`
// with strict settings, so ESLint's job here is the classes of bug the compiler
// does not see — not stylistic preference, which would only generate findings
// that get routinely ignored.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.mts', '*.mjs', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.test.json'] },
    },
    rules: {
      // The hot paths index typed arrays in loops, where a non-null assertion
      // is the point: `noUncheckedIndexedAccess` is on, and asserting is how
      // you take the check off a loop that runs tens of millions of times.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Deliberate: an unawaited promise in a request handler is a real defect.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
