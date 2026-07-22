// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/core/tool.js';
import { ModuleError, ModuleRegistry } from '../../src/modules/module.js';

function moduleDef(id: string, description = 'Handles something.') {
  return { id, description, tools: new ToolRegistry() };
}

describe('ModuleRegistry', () => {
  it('registers and returns a module', () => {
    const registry = new ModuleRegistry().register(moduleDef('finance'));

    expect(registry.has('finance')).toBe(true);
    expect(registry.get('finance')?.description).toBe('Handles something.');
    expect(registry.size).toBe(1);
  });

  it('rejects an id the router could not name', () => {
    expect(() => new ModuleRegistry().register(moduleDef('Finance Module'))).toThrowError(
      /module id must match/,
    );
  });

  it('rejects an empty description, which the router routes on', () => {
    expect(() => new ModuleRegistry().register(moduleDef('finance', '  '))).toThrowError(
      /description must not be empty/,
    );
  });

  it('rejects a duplicate id rather than shadowing the first', () => {
    const registry = new ModuleRegistry().register(moduleDef('finance'));

    expect(() => registry.register(moduleDef('finance'))).toThrow(ModuleError);
  });

  it('lists modules in registration order', () => {
    const registry = new ModuleRegistry()
      .register(moduleDef('finance'))
      .register(moduleDef('calendar'));

    expect(registry.list().map((module) => module.id)).toEqual(['finance', 'calendar']);
  });
});
