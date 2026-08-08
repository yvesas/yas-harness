// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * An agent assembled from configuration rather than written.
 *
 * Most of these are about the boundary the grants draw. A declared agent is
 * built by somebody filling in a form, so the interesting question is never
 * "does the happy path work" — it is what the agent cannot reach, and whether
 * the model can talk its way past it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAgents } from '../../src/agents/load-agents.js';

import { parseAgentConfig, AgentConfigError } from '../../src/agents/agent-config.js';
import { declaredAgent } from '../../src/agents/declared-agent.js';
import type { ConnectionOperations } from '../../src/connections/cached-connections.js';
import type { Connection, ConnectionStore } from '../../src/connections/connection-store.js';
import type { Resource } from '../../src/connections/connector.js';

const BASE = {
  id: 'research',
  name: 'Research',
  description: 'Reads the team wiki and answers questions from it.',
  instructions: 'Answer only from what you read. Say so when you did not find it.',
};

function resource(id: string): Resource {
  return {
    id,
    type: 'page',
    title: `Page ${id}`,
    content: `the content of ${id}`,
    mimeType: null,
    parentId: null,
    url: `https://wiki.test/${id}`,
    metadata: {},
    createdAt: null,
    updatedAt: null,
  };
}

function connection(id: string, connectorId: string): Connection {
  return {
    id,
    tenantId: 'tenant-1',
    connectorId,
    accountLabel: null,
    status: 'active',
    scopes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function deps(connections: Connection[] = [connection('c-github', 'github')]) {
  const calls: string[] = [];
  const operations = {
    list: (_t: string, id: string) => {
      calls.push(`list:${id}`);
      return Promise.resolve({ resources: [resource('r1')], nextCursor: null });
    },
    read: (_t: string, id: string, resourceId: string) => {
      calls.push(`read:${id}`);
      return Promise.resolve(resource(resourceId));
    },
    search: (_t: string, id: string) => {
      calls.push(`search:${id}`);
      return Promise.resolve({ resources: [resource('r1')], nextCursor: null });
    },
    delete: (_t: string, id: string) => {
      calls.push(`delete:${id}`);
      return Promise.resolve();
    },
  } as unknown as ConnectionOperations;

  const store = {
    list: () => Promise.resolve(connections),
    find: (_t: string, id: string) =>
      Promise.resolve(connections.find((entry) => entry.id === id) ?? null),
  } as unknown as ConnectionStore;

  return { operations, connections: store, calls };
}

const CONTEXT = { tenantId: 'tenant-1', sessionId: 'session-1' };

describe('the tools a grant generates', () => {
  it('creates one tool per granted capability, named for the source', () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['list', 'read'] }] },
      'test',
    );

    const module = declaredAgent(config, deps());

    expect(
      module.tools
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['github_list', 'github_read', 'my_connections']);
  });

  it('creates no tool for a capability that was not granted', () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['read'] }] },
      'test',
    );

    const module = declaredAgent(config, deps());

    // The boundary is the absence of the tool, not a check inside it. There is
    // nothing for the model to call and nothing to talk its way past.
    expect(module.tools.list().map((tool) => tool.name)).not.toContain('github_delete');
  });

  it('names the tool per connector, so one grant cannot reach another source', async () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['read'] }] },
      'test',
    );
    const dependencies = deps([connection('c-github', 'github'), connection('c-drive', 'drive')]);
    const module = declaredAgent(config, dependencies);

    const result = await module.tools.execute(
      'github_read',
      { connectionId: 'c-drive', id: 'r1' },
      CONTEXT,
    );

    // A single tool taking a connector name would put the boundary in an
    // argument the model chooses. Here the id is still an argument, so it is
    // checked: a Drive connection handed to a GitHub tool is refused.
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a github connection/);
    expect(dependencies.calls).toEqual([]);
  });

  it('defaults to reading only', () => {
    const config = parseAgentConfig({ ...BASE, connections: [{ connectorId: 'github' }] }, 'test');

    const names = declaredAgent(config, deps())
      .tools.list()
      .map((tool) => tool.name);

    // Granting a source must not silently grant the ability to change it.
    expect(names).toEqual(expect.arrayContaining(['github_list', 'github_read', 'github_search']));
    expect(names).not.toContain('github_create');
  });
});

describe('what the agent can find out', () => {
  it('lists only the connections it was granted', async () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['read'] }] },
      'test',
    );
    const module = declaredAgent(
      config,
      deps([connection('c-github', 'github'), connection('c-drive', 'drive')]),
    );

    const result = await module.tools.execute('my_connections', {}, CONTEXT);

    // Not merely unlisted: a connection it was not granted must not be
    // nameable, or the grant is a suggestion.
    expect(result.content).toContain('c-github');
    expect(result.content).not.toContain('c-drive');
  });

  it('says so plainly when nothing is connected yet', async () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['read'] }] },
      'test',
    );
    const module = declaredAgent(config, deps([]));

    const result = await module.tools.execute('my_connections', {}, CONTEXT);

    expect(result.content).toMatch(/No sources are connected/);
  });
});

describe('writes pause for a person by default', () => {
  it('gates every write when the agent was granted one', () => {
    const config = parseAgentConfig(
      { ...BASE, connections: [{ connectorId: 'github', can: ['read', 'delete'] }] },
      'test',
    );

    const module = declaredAgent(config, deps());

    // An agent assembled from a form by somebody who never read the schema
    // should not be able to delete things unattended.
    expect(module.tools.requiresApproval('github_delete')).toBe(true);
    expect(module.tools.requiresApproval('github_read')).toBe(false);
  });

  it('leaves them ungated only when somebody said so', () => {
    const config = parseAgentConfig(
      {
        ...BASE,
        approveWrites: false,
        connections: [{ connectorId: 'github', can: ['delete'] }],
      },
      'test',
    );

    expect(declaredAgent(config, deps()).tools.requiresApproval('github_delete')).toBe(false);
  });
});

describe('the configuration itself', () => {
  it('carries the prompt and the limits onto the module', () => {
    const config = parseAgentConfig(
      { ...BASE, task: 'simple', maxToolIterations: 3, connections: [] },
      'test',
    );

    const module = declaredAgent(config, deps());

    expect(module.agent).toMatchObject({
      instructions: BASE.instructions,
      task: 'simple',
      maxToolIterations: 3,
    });
  });

  it('refuses the same source granted twice', () => {
    // Merging them would grant the union, which is the wrong way to resolve an
    // ambiguity about permission.
    expect(() =>
      parseAgentConfig(
        {
          ...BASE,
          connections: [
            { connectorId: 'github', can: ['read'] },
            { connectorId: 'github', can: ['delete'] },
          ],
        },
        'test',
      ),
    ).toThrow(AgentConfigError);
  });

  it('refuses an id that is not a usable file name', () => {
    expect(() => parseAgentConfig({ ...BASE, id: 'My Agent!' }, 'test')).toThrow(AgentConfigError);
  });

  it('requires a description, because it is all the router reads', () => {
    const { description: _dropped, ...withoutDescription } = BASE;

    expect(() => parseAgentConfig(withoutDescription, 'test')).toThrow(AgentConfigError);
  });
});

describe('loading a directory of agents', () => {
  it('reads one file per agent, in a stable order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yas-agents-'));
    await writeFile(join(dir, 'zeta.json'), JSON.stringify({ ...BASE, id: 'zeta' }), 'utf8');
    await writeFile(join(dir, 'alpha.json'), JSON.stringify({ ...BASE, id: 'alpha' }), 'utf8');

    const agents = await loadAgents(dir);

    // Sorted, so the order a router sees does not depend on a filesystem.
    expect(agents.map((agent) => agent.id)).toEqual(['alpha', 'zeta']);
  });

  it('treats a missing directory as no declared agents', async () => {
    // A deployment whose modules are all in code, which is how every product
    // on the harness worked until now.
    expect(await loadAgents(join(tmpdir(), 'yas-agents-that-do-not-exist'))).toEqual([]);
  });

  it('stops startup on a file that will not parse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yas-agents-'));
    await writeFile(join(dir, 'broken.json'), '{ "id": ', 'utf8');

    // Skipping it would give a harness quietly missing an agent, and the first
    // sign is the router choosing something else and answering plausibly.
    await expect(loadAgents(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a file whose name and id disagree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yas-agents-'));
    await writeFile(join(dir, 'notes.json'), JSON.stringify({ ...BASE, id: 'research' }), 'utf8');

    // Both are used to find an agent — the console edits <id>.json and the
    // router returns the id. Two names for one thing is how an edit lands on
    // the wrong agent.
    await expect(loadAgents(dir)).rejects.toThrow(/file name must match/);
  });

  it('ignores anything that is not JSON, so a README can live there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yas-agents-'));
    await writeFile(join(dir, 'README.md'), '# agents', 'utf8');
    await writeFile(join(dir, 'notes.json.example'), 'not json at all', 'utf8');
    await writeFile(join(dir, 'real.json'), JSON.stringify({ ...BASE, id: 'real' }), 'utf8');

    expect((await loadAgents(dir)).map((agent) => agent.id)).toEqual(['real']);
  });
});
