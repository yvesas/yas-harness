// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The console's tsconfig extends the harness's, which pins `types` to `node`.
 * That is right for a library and it means TypeScript never picks up ambient
 * declarations for a stylesheet import, which the bundler handles on its own.
 * Declaring it here is cheaper than loosening the harness's compiler settings
 * for the sake of one import.
 */
declare module '*.css';
