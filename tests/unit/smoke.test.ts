// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { HARNESS_NAME } from '../../src/index.js';

describe('toolchain smoke test', () => {
  it('resolves and runs source modules', () => {
    expect(HARNESS_NAME).toBe('yas-harness');
  });
});
