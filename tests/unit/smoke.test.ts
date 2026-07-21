// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe as suite, expect, it } from 'vitest';

import { HARNESS_NAME, describe } from '../../src/index.js';

suite('toolchain smoke test', () => {
  it('resolves and runs source modules', () => {
    expect(HARNESS_NAME).toBe('yas-harness');
    expect(describe()).toContain('agent chassis');
  });
});
