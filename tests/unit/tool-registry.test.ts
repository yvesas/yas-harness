// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry, ok } from '../../src/core/tool.js';

const context = { tenantId: 'tenant-1', sessionId: 'session-1' };

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'Repeat the given text back.',
    input: z.object({ text: z.string().min(1) }),
    execute: (input) => Promise.resolve(ok(input.text)),
  });
}

describe('ToolRegistry', () => {
  it('rejects a name the model could not address', () => {
    const register = () =>
      new ToolRegistry().register({
        name: 'Echo Tool',
        description: 'x',
        input: z.object({}),
        execute: () => Promise.resolve(ok('')),
      });

    expect(register).toThrowError(/tool name must match/);
  });

  it('rejects an empty description, which the model needs to choose the tool', () => {
    const register = () =>
      new ToolRegistry().register({
        name: 'echo',
        description: '   ',
        input: z.object({}),
        execute: () => Promise.resolve(ok('')),
      });

    expect(register).toThrowError(/description must not be empty/);
  });

  it('rejects a duplicate name instead of shadowing the first tool', () => {
    const registry = echoRegistry();

    expect(() =>
      registry.register({
        name: 'echo',
        description: 'A different echo.',
        input: z.object({}),
        execute: () => Promise.resolve(ok('')),
      }),
    ).toThrowError(/already registered/);
  });

  it('derives the advertised JSON Schema from the Zod schema', () => {
    const [schema] = echoRegistry().schemas();

    expect(schema?.name).toBe('echo');
    expect(schema?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('runs a tool with valid input', async () => {
    const result = await echoRegistry().execute('echo', { text: 'olá' }, context);

    expect(result).toEqual({ content: 'olá', isError: false });
  });

  it('reports invalid input as an error result the model can correct', async () => {
    const result = await echoRegistry().execute('echo', { text: 42 }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('invalid input for "echo"');
    expect(result.content).toContain('text');
  });

  it('reports an unknown tool without throwing', async () => {
    const result = await echoRegistry().execute('nope', {}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown tool "nope"');
  });

  it('turns a thrown tool into an error result rather than killing the turn', async () => {
    const registry = new ToolRegistry().register({
      name: 'explode',
      description: 'Always fails.',
      input: z.object({}),
      execute: () => Promise.reject(new Error('database is on fire')),
    });

    const result = await registry.execute('explode', {}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('database is on fire');
  });
});
