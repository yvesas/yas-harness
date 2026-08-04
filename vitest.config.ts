// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The console's own tests live beside its code: those files are compiled
    // by the console's tsconfig, and the harness's would reject their imports.
    // vitest resolves like a bundler, so it runs both without caring.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'console/tests/**/*.test.ts'],
    environment: 'node',
    // The core must be testable without network access (hexagonal architecture).
    // Anything needing Postgres or a provider belongs in tests/integration.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
