// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The pause-and-resume path, end to end without a network or a database.
 * A gated tool must not run until a human decides, and a decided turn must
 * continue exactly where it stopped.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';
import { Agent } from '../../src/core/agent.js';
import { parsePersona } from '../../src/core/persona.js';
import { ToolRegistry, ok } from '../../src/core/tool.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway, callsTool, says } from '../../src/models/scripted-gateway.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

const persona = parsePersona(
  { id: 'test', name: 'Test', instructions: 'You are under test.', maxToolIterations: 4 },
  'test',
);

let sessions: InMemorySessionStore;
let approvals: InMemoryApprovalStore;
let ran: string[];

beforeEach(() => {
  sessions = new InMemorySessionStore();
  approvals = new InMemoryApprovalStore();
  ran = [];
});

/** A registry with one gated tool and one that runs freely, both recording. */
function tools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: 'delete_file',
      description: 'Delete a file. Destructive.',
      input: z.object({ path: z.string() }),
      requiresApproval: true,
      execute: (input) => {
        ran.push(`delete_file:${input.path}`);
        return Promise.resolve(ok(`deleted ${input.path}`));
      },
    })
    .register({
      name: 'read_file',
      description: 'Read a file.',
      input: z.object({ path: z.string() }),
      execute: (input) => {
        ran.push(`read_file:${input.path}`);
        return Promise.resolve(ok(`contents of ${input.path}`));
      },
    });
}

function agentWith(turns: ScriptedTurn[]) {
  const gateway = new ScriptedGateway(turns);
  const agent = new Agent({ gateway, sessions, tools: tools(), persona, approvals });
  return { agent, gateway };
}

async function newSession(): Promise<string> {
  const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
  return session.id;
}

describe('Agent with approval', () => {
  it('pauses before running a gated tool and runs nothing', async () => {
    const { agent, gateway } = agentWith([callsTool('delete_file', { path: '/tmp/x' })]);
    const sessionId = await newSession();

    const reply = await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });

    expect(reply.stopReason).toBe('awaiting_approval');
    expect(reply.pendingApprovals).toHaveLength(1);
    expect(reply.pendingApprovals?.[0]).toMatchObject({
      toolName: 'delete_file',
      status: 'pending',
    });
    expect(ran).toEqual([]); // nothing executed
    // The pause consumed one model call and then stopped — no further calls.
    expect(gateway.remaining).toBe(0);
  });

  it('does not run the ungated tools of a turn that also has a gated one', async () => {
    // All-or-nothing: a mixed turn waits as a whole.
    const { agent } = agentWith([
      {
        content: [
          { type: 'tool_call', id: 'a', name: 'read_file', input: { path: '/a' } },
          { type: 'tool_call', id: 'b', name: 'delete_file', input: { path: '/b' } },
        ],
        stopReason: 'tool_call',
      },
    ]);
    const sessionId = await newSession();

    await agent.run({ tenantId: TENANT, sessionId, input: 'read then delete' });

    expect(ran).toEqual([]); // read_file did not run either
    expect(reqOf(await approvals.list(TENANT, sessionId))).toEqual(['delete_file']); // only the gated one is queued
  });

  it('runs the gated tool after approval and finishes the turn', async () => {
    const { agent } = agentWith([
      callsTool('delete_file', { path: '/tmp/x' }),
      says('Done, the file is gone.'),
    ]);
    const sessionId = await newSession();

    const paused = await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });
    await approvals.approve(TENANT, paused.pendingApprovals![0]!.id, { decidedBy: 'yves' });
    const reply = await agent.resume({ tenantId: TENANT, sessionId });

    expect(ran).toEqual(['delete_file:/tmp/x']);
    expect(reply.stopReason).toBe('end_turn');
    expect(reply.text).toBe('Done, the file is gone.');
    expect(reply.toolInvocations).toEqual([
      { name: 'delete_file', input: { path: '/tmp/x' }, output: 'deleted /tmp/x', isError: false },
    ]);
  });

  it('does not run a rejected tool, and tells the model why', async () => {
    const { agent, gateway } = agentWith([
      callsTool('delete_file', { path: '/tmp/x' }),
      says('Understood, I will not delete it.'),
    ]);
    const sessionId = await newSession();

    const paused = await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });
    await approvals.reject(TENANT, paused.pendingApprovals![0]!.id, {
      decidedBy: 'yves',
      reason: 'that file is needed',
    });
    const reply = await agent.resume({ tenantId: TENANT, sessionId });

    expect(ran).toEqual([]); // never executed
    expect(reply.text).toBe('Understood, I will not delete it.');
    // The rejection, with its reason, went back to the model as a tool result.
    const resultTurn = gateway.requests.at(-1)?.messages.at(-1);
    expect(resultTurn).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'call-delete_file',
          isError: true,
        },
      ],
    });
    const part = resultTurn?.content[0];
    expect(part?.type).toBe('tool_result');
    const content = part?.type === 'tool_result' ? part.content : '';
    expect(content).toContain('rejected by yves');
    expect(content).toContain('that file is needed');
  });

  it('runs the ungated tools together with the approved gated one, in order', async () => {
    const { agent } = agentWith([
      {
        content: [
          { type: 'tool_call', id: 'a', name: 'read_file', input: { path: '/a' } },
          { type: 'tool_call', id: 'b', name: 'delete_file', input: { path: '/b' } },
        ],
        stopReason: 'tool_call',
      },
      says('Read /a and deleted /b.'),
    ]);
    const sessionId = await newSession();

    const paused = await agent.run({ tenantId: TENANT, sessionId, input: 'go' });
    await approvals.approve(TENANT, paused.pendingApprovals![0]!.id, { decidedBy: 'yves' });
    await agent.resume({ tenantId: TENANT, sessionId });

    expect(ran).toEqual(['read_file:/a', 'delete_file:/b']);
  });

  it('pauses again when asked to resume with the decision still pending', async () => {
    const { agent } = agentWith([callsTool('delete_file', { path: '/tmp/x' })]);
    const sessionId = await newSession();

    await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });
    const reply = await agent.resume({ tenantId: TENANT, sessionId });

    expect(reply.stopReason).toBe('awaiting_approval');
    expect(ran).toEqual([]);
  });

  it('does not queue the approval twice across a re-run of the same paused turn', async () => {
    const { agent } = agentWith([callsTool('delete_file', { path: '/tmp/x' })]);
    const sessionId = await newSession();

    await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });
    await agent.resume({ tenantId: TENANT, sessionId }); // still pending, must not re-queue

    expect(await approvals.list(TENANT, sessionId)).toHaveLength(1);
  });

  it('handles two approval pauses in one conversation', async () => {
    const { agent } = agentWith([
      callsTool('delete_file', { path: '/first' }, 'first'),
      callsTool('delete_file', { path: '/second' }, 'second'),
      says('Both handled.'),
    ]);
    const sessionId = await newSession();

    const p1 = await agent.run({
      tenantId: TENANT,
      sessionId,
      input: 'delete both, one at a time',
    });
    await approvals.approve(TENANT, p1.pendingApprovals![0]!.id, { decidedBy: 'yves' });

    const p2 = await agent.resume({ tenantId: TENANT, sessionId });
    expect(p2.stopReason).toBe('awaiting_approval');
    await approvals.approve(TENANT, p2.pendingApprovals![0]!.id, { decidedBy: 'yves' });

    const done = await agent.resume({ tenantId: TENANT, sessionId });

    expect(done.stopReason).toBe('end_turn');
    expect(ran).toEqual(['delete_file:/first', 'delete_file:/second']);
  });

  it('rejects a resume when nothing is paused', async () => {
    const { agent } = agentWith([says('hi')]);
    const sessionId = await newSession();
    await agent.run({ tenantId: TENANT, sessionId, input: 'hi' });

    await expect(agent.resume({ tenantId: TENANT, sessionId })).rejects.toThrow(
      /not awaiting approval/,
    );
  });

  it('still fails closed for a gated tool when no approval store is wired', async () => {
    const gateway = new ScriptedGateway([
      callsTool('delete_file', { path: '/x' }),
      says('I could not do that.'),
    ]);
    const agent = new Agent({ gateway, sessions, tools: tools(), persona }); // no approvals
    const sessionId = await newSession();

    const reply = await agent.run({ tenantId: TENANT, sessionId, input: 'delete it' });

    expect(reply.stopReason).toBe('end_turn');
    expect(ran).toEqual([]);
    expect(reply.toolInvocations[0]?.isError).toBe(true);
    expect(reply.toolInvocations[0]?.output).toContain('requires human approval');
  });
});

function reqOf(approvalsList: { toolName: string }[]): string[] {
  return approvalsList.map((a) => a.toolName);
}
