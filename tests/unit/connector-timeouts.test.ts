// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Deadlines on the connections layer.
 *
 * The bug this guards against is invisible in every other test: a stub `fetch`
 * always answers, so a connector that never passes the signal along looks
 * perfectly healthy right up until a real API stops responding and holds a turn
 * open forever. So the tests here check the two halves separately — that the
 * manager sets a deadline and names what blew through it, and that every
 * connector actually hands the signal to `fetch`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryConnectionStore } from '../../src/connections/in-memory-connection-store.js';
import { ConnectionManager } from '../../src/connections/connection-manager.js';
import { ConnectorRegistry } from '../../src/connections/connector-registry.js';
import type { Connector, ConnectorContext, ResourcePage } from '../../src/connections/connector.js';
import { ConnectorTimeoutError } from '../../src/connections/connector.js';
import type { CredentialResolver } from '../../src/connections/credential-resolver.js';

const TENANT = 'tenant-1';

const resolver: CredentialResolver = { resolve: () => Promise.resolve({ token: 'secret' }) };

/** Records the context it was handed, and can hang forever on demand. */
function probe(behaviour: 'answer' | 'hang'): Connector & { seen: ConnectorContext[] } {
  const seen: ConnectorContext[] = [];
  return {
    id: 'probe',
    description: 'Records what the manager passes in.',
    capabilities: ['list'],
    seen,
    list(context): Promise<ResourcePage> {
      seen.push(context);
      if (behaviour === 'answer') {
        return Promise.resolve({ resources: [], nextCursor: null });
      }
      // A source that accepted the connection and then went quiet. Only the
      // signal can end this — and it rejects with the signal's own reason,
      // exactly as `fetch` does, so the manager sees what it would in production.
      return new Promise((_resolve, reject: (reason: Error) => void) => {
        context.signal?.addEventListener('abort', () => {
          const reason: unknown = context.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        });
      });
    },
  };
}

async function managerWith(
  connector: Connector,
  requestTimeoutMs?: number,
): Promise<{ manager: ConnectionManager; connectionId: string }> {
  const connections = new InMemoryConnectionStore();
  const connection = await connections.create({
    tenantId: TENANT,
    connectorId: connector.id,
    accountLabel: 'probe',
  });
  const manager = new ConnectionManager(
    new ConnectorRegistry().register(connector),
    connections,
    resolver,
    requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
  );
  return { manager, connectionId: connection.id };
}

describe('connection deadlines', () => {
  it('hands every connector call a signal', async () => {
    const connector = probe('answer');
    const { manager, connectionId } = await managerWith(connector);

    await manager.list(TENANT, connectionId);

    expect(connector.seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(connector.seen[0]?.signal?.aborted).toBe(false);
  });

  it('abandons a source that stops answering, naming it and the operation', async () => {
    const { manager, connectionId } = await managerWith(probe('hang'), 20);

    const failure = await manager.list(TENANT, connectionId).catch((error: unknown) => error);

    // Not a bare DOMException: a trace needs to say which source went quiet.
    expect(failure).toBeInstanceOf(ConnectorTimeoutError);
    expect(failure).toMatchObject({ connectorId: 'probe', capability: 'list', timeoutMs: 20 });
    expect((failure as Error).message).toMatch(/timed out after 20ms/);
  });

  it('leaves a real failure alone rather than calling it a timeout', async () => {
    const connector: Connector = {
      id: 'probe',
      description: 'Fails for its own reasons.',
      capabilities: ['list'],
      list: () => Promise.reject(new Error('403 forbidden')),
    };
    const { manager, connectionId } = await managerWith(connector);

    const failure = await manager.list(TENANT, connectionId).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(ConnectorTimeoutError);
    expect((failure as Error).message).toBe('403 forbidden');
  });
});

/**
 * A source-level check, deliberately.
 *
 * Behavioural coverage would mean driving all ten connectors through their own
 * stub fetch, which is ten brittle fixtures for one property. What actually
 * regresses is someone adding an eleventh connector and forgetting the signal —
 * and that is exactly what reading the sources catches, cheaply and completely.
 */
describe('every connector honours the deadline', () => {
  const dir = join(process.cwd(), 'src/connections/connectors');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));

  it('finds the connectors to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of files) {
    it(`${name} passes a signal to every request it makes`, () => {
      const source = readFileSync(join(dir, name), 'utf8');
      const calls = source.split(/await this\.#?fetch\(/).length - 1;
      if (calls === 0) {
        return; // No transport of its own; nothing to honour.
      }
      const signals = source.split(/^\s*signal: /m).length - 1;
      expect(signals).toBe(calls);
    });
  }
});
