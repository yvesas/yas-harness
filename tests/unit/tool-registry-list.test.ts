// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The read side of the tool registry.
 *
 * Asked for by the console's Modules page: there was no way to see which tools
 * are gated without holding the definitions, and handing those out means
 * handing out `execute`.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry, ok } from '../../src/core/tool.js';

function registry(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: 'read_thing',
      description: 'Read a thing.',
      input: z.object({ id: z.string() }),
      execute: () => Promise.resolve(ok('read')),
    })
    .register({
      name: 'send_email',
      description: 'Send an email.',
      input: z.object({ to: z.string() }),
      requiresApproval: true,
      execute: () => Promise.resolve(ok('sent')),
    });
}

describe('listing tools for a person', () => {
  it('says which tools are gated', () => {
    expect(registry().list()).toEqual([
      { name: 'read_thing', description: 'Read a thing.', requiresApproval: false },
      { name: 'send_email', description: 'Send an email.', requiresApproval: true },
    ]);
  });

  it('does not tell the model which tools are gated', () => {
    const schemas = registry().schemas();

    // A gate is a fact about the humans behind a tool. Telling the model
    // invites it to reason about the gate instead of about the task.
    expect(schemas.every((schema) => !('requiresApproval' in schema))).toBe(true);
  });

  it('does not hand out anything runnable', () => {
    // The point of a summary: an operator surface gets names and descriptions,
    // not `execute` and not a Zod schema it would have to know how to read.
    expect(
      registry()
        .list()
        .every((entry) => !('execute' in entry)),
    ).toBe(true);
  });
});
