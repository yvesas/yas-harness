// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Crossing the module boundary.
 *
 * The rule being tested is an inversion: the module that owns the data answers,
 * and everyone else asks. So the tests care about who decides — that an owner
 * which never opted in refuses, that the broker delivers the owner's answer
 * without widening it, and that a wiring mistake is not reported as a refusal.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/core/tool.js';
import { ModuleRegistry } from '../../src/modules/module.js';
import { ContextBroker } from '../../src/pools/context-broker.js';
import type { ContextDiscloser, ContextRequest } from '../../src/pools/context.js';
import { ContextError, denied, granted } from '../../src/pools/context.js';
import { InMemoryTraceRecorder } from '../../src/telemetry/trace.js';

const TENANT = 'tenant-1';

function registry(...modules: { id: string; disclose?: ContextDiscloser }[]): ModuleRegistry {
  const out = new ModuleRegistry();
  for (const module of modules) {
    out.register({
      id: module.id,
      description: `Handles ${module.id}.`,
      tools: new ToolRegistry(),
      ...(module.disclose ? { disclose: module.disclose } : {}),
    });
  }
  return out;
}

function ask(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    tenantId: TENANT,
    requester: 'planner',
    owner: 'ledger',
    purpose: 'to say whether the trip is affordable',
    ...overrides,
  };
}

describe('ContextBroker', () => {
  it('delivers exactly what the owner chose to reveal', async () => {
    const modules = registry(
      { id: 'planner' },
      {
        id: 'ledger',
        // The owner answers with a summary, not its rows — the point of asking.
        disclose: () => Promise.resolve(granted([{ key: 'balance-band', value: 'comfortable' }])),
      },
    );

    const grant = await new ContextBroker(modules).request(ask());

    expect(grant).toEqual({
      status: 'granted',
      entries: [{ key: 'balance-band', value: 'comfortable' }],
    });
  });

  it('refuses on behalf of a module that never said how it shares', async () => {
    const modules = registry({ id: 'planner' }, { id: 'ledger' });

    const grant = await new ContextBroker(modules).request(ask());

    // Fails closed: silence is not consent.
    expect(grant.status).toBe('denied');
    expect(grant.status === 'denied' && grant.reason).toContain('does not disclose');
  });

  it('passes the purpose to the owner, which is what it judges', async () => {
    const seen: ContextRequest[] = [];
    const modules = registry(
      { id: 'planner' },
      {
        id: 'ledger',
        disclose: (request) => {
          seen.push(request);
          return Promise.resolve(
            request.purpose.includes('affordable') ? granted([]) : denied('purpose not covered'),
          );
        },
      },
    );

    const allowed = await new ContextBroker(modules).request(ask());
    const refused = await new ContextBroker(modules).request(ask({ purpose: 'curiosity' }));

    expect(allowed.status).toBe('granted');
    expect(refused).toMatchObject({ status: 'denied', reason: 'purpose not covered' });
    expect(seen[0]?.requester).toBe('planner');
  });

  it('carries a refusal reason back so the requester can explain itself', async () => {
    const modules = registry(
      { id: 'planner' },
      { id: 'ledger', disclose: () => Promise.resolve(denied('balances are never shared')) },
    );

    const grant = await new ContextBroker(modules).request(ask());

    expect(grant).toEqual({ status: 'denied', reason: 'balances are never shared' });
  });

  it('throws on a wiring mistake instead of reporting it as a refusal', async () => {
    const broker = new ContextBroker(registry({ id: 'planner' }, { id: 'ledger' }));

    // Each of these is a bug, not a policy decision. Reporting them as denials
    // would have the caller shrug at a mistake it should be fixing.
    await expect(broker.request(ask({ owner: 'ghost' }))).rejects.toThrow(ContextError);
    await expect(broker.request(ask({ requester: 'ghost' }))).rejects.toThrow(/not registered/);
    await expect(broker.request(ask({ purpose: '  ' }))).rejects.toThrow(/purpose/);
    await expect(broker.request(ask({ owner: 'planner' }))).rejects.toThrow(/from itself/);
  });

  it('records a granted exchange without copying the data into the trace', async () => {
    const traces = new InMemoryTraceRecorder();
    const modules = registry(
      { id: 'planner' },
      {
        id: 'ledger',
        disclose: () => Promise.resolve(granted([{ key: 'balance-band', value: 'comfortable' }])),
      },
    );

    await new ContextBroker(modules, { traces }).request(ask());

    const step = traces.steps[0]!;
    expect(step).toMatchObject({
      kind: 'context_request',
      label: 'planner → ledger',
      succeeded: true,
      detail: {
        requester: 'planner',
        owner: 'ledger',
        granted: true,
        entries: 1,
        keys: ['balance-band'],
      },
    });
    // The values are the owner's data and stay in the owner's pool.
    expect(JSON.stringify(step.detail)).not.toContain('comfortable');
  });

  it('records a refusal, with the reason, as a step that did not succeed', async () => {
    const traces = new InMemoryTraceRecorder();
    const modules = registry({ id: 'planner' }, { id: 'ledger' });

    await new ContextBroker(modules, { traces }).request(ask());

    expect(traces.steps[0]).toMatchObject({
      kind: 'context_request',
      succeeded: false,
      detail: { granted: false },
    });
  });

  it('joins the exchange to the turn that caused it', async () => {
    const traces = new InMemoryTraceRecorder();
    const modules = registry({ id: 'planner' }, { id: 'ledger' });

    await new ContextBroker(modules, { traces }).request(
      ask({ sessionId: 'session-1' }),
      '66666666-6666-4666-8666-666666666666',
    );

    expect(traces.steps[0]).toMatchObject({
      traceId: '66666666-6666-4666-8666-666666666666',
      sessionId: 'session-1',
    });
  });

  it('works with no recorder wired', async () => {
    const modules = registry(
      { id: 'planner' },
      { id: 'ledger', disclose: () => Promise.resolve(granted([])) },
    );

    await expect(new ContextBroker(modules).request(ask())).resolves.toMatchObject({
      status: 'granted',
    });
  });
});
