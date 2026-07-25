// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { assertConnectorConsistent } from '../../src/connections/connector.js';
import type { Connector } from '../../src/connections/connector.js';
import { ConnectorRegistry } from '../../src/connections/connector-registry.js';
import { MemoryConnector } from '../../src/connections/memory-connector.js';

describe('ConnectorRegistry', () => {
  it('registers a connector and finds it', () => {
    const registry = new ConnectorRegistry().register(new MemoryConnector({ id: 'google-drive' }));

    expect(registry.has('google-drive')).toBe(true);
    expect(registry.get('google-drive')?.id).toBe('google-drive');
    expect(registry.size).toBe(1);
  });

  it('rejects an id the connection layer could not name', () => {
    expect(() =>
      new ConnectorRegistry().register(new MemoryConnector({ id: 'Google Drive' })),
    ).toThrow(/connector id must match/);
  });

  it('rejects an empty description', () => {
    expect(() =>
      new ConnectorRegistry().register(new MemoryConnector({ id: 'drive', description: ' ' })),
    ).toThrow(/description must not be empty/);
  });

  it('rejects a duplicate id', () => {
    const registry = new ConnectorRegistry().register(new MemoryConnector({ id: 'drive' }));

    expect(() => registry.register(new MemoryConnector({ id: 'drive' }))).toThrow(
      /already registered/,
    );
  });

  it('lists connectors in registration order', () => {
    const registry = new ConnectorRegistry()
      .register(new MemoryConnector({ id: 'drive' }))
      .register(new MemoryConnector({ id: 'notion' }));

    expect(registry.list().map((c) => c.id)).toEqual(['drive', 'notion']);
  });
});

describe('assertConnectorConsistent', () => {
  it('accepts a connector whose capabilities and methods agree', () => {
    expect(() => assertConnectorConsistent(new MemoryConnector())).not.toThrow();
  });

  it('rejects a capability declared without its method', () => {
    const broken: Connector = {
      id: 'broken',
      description: 'x',
      capabilities: ['read'], // but no read method
    };

    expect(() => assertConnectorConsistent(broken)).toThrowError(
      /declares "read" but does not implement it/,
    );
  });

  it('allows a connector to implement more than it declares (read-only mode)', () => {
    // A full connector exposing only reads: the write methods exist but are
    // not declared, and the manager will refuse them.
    const readonly = new MemoryConnector({ capabilities: ['list', 'read', 'search'] });

    expect(() => assertConnectorConsistent(readonly)).not.toThrow();
  });

  it('registration runs the consistency check', () => {
    const broken: Connector = { id: 'broken', description: 'x', capabilities: ['create'] };

    expect(() => new ConnectorRegistry().register(broken)).toThrow(/does not implement it/);
  });
});
