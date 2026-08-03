// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // The console is a workspace with its own toolchain: its own tsconfig (JSX,
  // DOM lib, bundler resolution) and Next's own linting. Type-checked rules
  // from this config would run against a program that does not include it.
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'console/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Ports & adapters: the core must not silently swallow failures.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // An example that runs in a terminal exists to print. The rule is there to
    // keep stray logging out of library code, which `src/` still enforces.
    files: ['examples/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Config files and the scripts/ tooling are plain ESM, outside the
    // TypeScript project: lint them without type information.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
