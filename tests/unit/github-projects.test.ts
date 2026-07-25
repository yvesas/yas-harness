// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The project side of the GitHub connector (Projects v2), driven by a stub of
 * the GraphQL API. What is tested is the GraphQL translation: projects to
 * resources with a `project:owner/number` id, the owner-id resolution on
 * create, the readme follow-up when a body is given, the read-then-write by
 * node id on update, and the missing-project mapping.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ResourceNotFoundError } from '../../src/connections/connector.js';
import { GitHubConnector } from '../../src/connections/connectors/github-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'gh-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

interface GqlCall {
  query: string;
  variables: Record<string, unknown>;
}

function projectNode(
  number: number,
  title: string,
  readme: string | null = 'a project readme',
  extra: Record<string, unknown> = {},
) {
  return {
    number,
    id: `PVT_node_${number}`,
    title,
    readme,
    shortDescription: 'a short description',
    url: `https://github.com/orgs/acme/projects/${number}`,
    public: true,
    closed: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

/** A GraphQL stub: routes on the operation found in the query text. */
function fakeGraphQL(handler: (op: string, vars: Record<string, unknown>) => unknown) {
  const calls: GqlCall[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    expect(u.pathname).toBe('/graphql');
    const { query, variables } = JSON.parse(init!.body as string) as GqlCall;
    calls.push({ query, variables });

    const op = /createProjectV2/.test(query)
      ? 'create'
      : /updateProjectV2/.test(query)
        ? 'update'
        : /projectsV2\(/.test(query)
          ? 'list'
          : /projectV2\(number/.test(query)
            ? 'read'
            : 'owner';

    const result = handler(op, variables);
    const payload =
      result === undefined
        ? { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }
        : { data: result };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

let calls: GqlCall[];
let connector: GitHubConnector;

function connect(handler: Parameters<typeof fakeGraphQL>[0]) {
  const fake = fakeGraphQL(handler);
  calls = fake.calls;
  connector = new GitHubConnector({ fetch: fake.fetch, baseUrl: 'https://api.test' });
}

describe('GitHubConnector — projects', () => {
  it('lists an owner’s projects, prefixing the id', async () => {
    connect((op, vars) => {
      if (op !== 'list') return undefined;
      expect(vars).toMatchObject({ login: 'acme' });
      return {
        repositoryOwner: {
          projectsV2: {
            nodes: [projectNode(1, 'Roadmap'), projectNode(2, 'Backlog')],
            pageInfo: { endCursor: 'CUR', hasNextPage: true },
          },
        },
      };
    });

    const listed = await connector.list(ctx, { type: 'project', parentId: 'acme' });

    expect(listed.resources.map((r) => r.id)).toEqual(['project:acme/1', 'project:acme/2']);
    expect(listed.resources[0]).toMatchObject({ type: 'project', title: 'Roadmap' });
    expect(listed.nextCursor).toBe('CUR');
  });

  it('ends pagination when there is no next page', async () => {
    connect((op) =>
      op === 'list'
        ? {
            repositoryOwner: {
              projectsV2: {
                nodes: [projectNode(1, 'x')],
                pageInfo: { endCursor: 'C', hasNextPage: false },
              },
            },
          }
        : undefined,
    );

    const listed = await connector.list(ctx, { type: 'project', parentId: 'acme' });

    expect(listed.nextCursor).toBeNull();
  });

  it('needs a parent to list projects', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'project' })).rejects.toThrowError(/needs a parent/);
  });

  it('reads a project, mapping readme and description, keeping the node id', async () => {
    connect((op, vars) => {
      if (op !== 'read') return undefined;
      expect(vars).toMatchObject({ login: 'acme', number: 5 });
      return { repositoryOwner: { projectV2: projectNode(5, 'Q3 plan', '## goals') } };
    });

    const resource = await connector.read(ctx, 'project:acme/5');

    expect(resource).toMatchObject({
      id: 'project:acme/5',
      type: 'project',
      title: 'Q3 plan',
      content: '## goals',
      mimeType: 'text/markdown',
      parentId: 'acme',
      metadata: {
        number: 5,
        nodeId: 'PVT_node_5',
        owner: 'acme',
        shortDescription: 'a short description',
        public: true,
        closed: false,
      },
    });
  });

  it('maps a project with no readme to null content', async () => {
    connect((op) =>
      op === 'read' ? { repositoryOwner: { projectV2: projectNode(6, 'Empty', null) } } : undefined,
    );

    const resource = await connector.read(ctx, 'project:acme/6');

    expect(resource.content).toBeNull();
    expect(resource.mimeType).toBeNull();
  });

  it('maps a missing project to ResourceNotFoundError', async () => {
    // The owner exists but has no project with that number.
    connect((op) => (op === 'read' ? { repositoryOwner: { projectV2: null } } : undefined));

    await expect(connector.read(ctx, 'project:acme/404')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('rejects a malformed project id', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'project:acme')).rejects.toThrowError(
      /expected "project:owner\/number"/,
    );
  });

  it('creates a project, resolving the owner id first', async () => {
    connect((op, vars) => {
      if (op === 'owner') {
        expect(vars).toMatchObject({ login: 'acme' });
        return { repositoryOwner: { id: 'OWNER_id' } };
      }
      if (op === 'create') {
        expect(vars).toMatchObject({ ownerId: 'OWNER_id', title: 'New board' });
        return { createProjectV2: { projectV2: projectNode(10, 'New board', null) } };
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'project',
      title: 'New board',
      metadata: { owner: 'acme' },
    });

    expect(created.id).toBe('project:acme/10');
    // Resolved the owner id, then created — no readme follow-up without content.
    expect(calls.map((c) => (/createProjectV2/.test(c.query) ? 'create' : 'owner'))).toEqual([
      'owner',
      'create',
    ]);
  });

  it('sets the readme in a follow-up when create is given content', async () => {
    connect((op, vars) => {
      if (op === 'owner') return { repositoryOwner: { id: 'OWNER_id' } };
      if (op === 'create') return { createProjectV2: { projectV2: projectNode(11, 'Docs', null) } };
      if (op === 'update') {
        expect(vars).toMatchObject({ id: 'PVT_node_11', readme: '## intro' });
        return { updateProjectV2: { projectV2: projectNode(11, 'Docs', '## intro') } };
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'project',
      title: 'Docs',
      content: '## intro',
      metadata: { owner: 'acme' },
    });

    expect(created.content).toBe('## intro');
    // Owner id, then create, then a readme update carrying the body.
    expect(
      calls.map((c) =>
        /updateProjectV2/.test(c.query)
          ? 'update'
          : /createProjectV2/.test(c.query)
            ? 'create'
            : 'owner',
      ),
    ).toEqual(['owner', 'create', 'update']);
  });

  it('needs an owner to create a project', async () => {
    connect(() => undefined);

    await expect(connector.create(ctx, { type: 'project', title: 'x' })).rejects.toThrowError(
      /needs metadata\.owner/,
    );
  });

  it('fails when the owner does not exist', async () => {
    connect((op) => (op === 'owner' ? { repositoryOwner: null } : undefined));

    await expect(
      connector.create(ctx, { type: 'project', title: 'x', metadata: { owner: 'ghost' } }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('edits a project, reading its node id first then updating by id', async () => {
    connect((op, vars) => {
      if (op === 'read') return { repositoryOwner: { projectV2: projectNode(3, 'Old', 'old') } };
      if (op === 'update') {
        expect(vars).toMatchObject({ id: 'PVT_node_3', readme: 'new body' });
        return { updateProjectV2: { projectV2: projectNode(3, 'Old', 'new body') } };
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'project:acme/3', { content: 'new body' });

    expect(updated.content).toBe('new body');
    // Read (for the node id) then update.
    expect(calls.map((c) => (/updateProjectV2/.test(c.query) ? 'update' : 'read'))).toEqual([
      'read',
      'update',
    ]);
  });

  it('passes a short-description change from metadata through to the update', async () => {
    connect((op, vars) => {
      if (op === 'read') return { repositoryOwner: { projectV2: projectNode(4, 'Board', 'b') } };
      if (op === 'update') {
        expect(vars).toMatchObject({ id: 'PVT_node_4', shortDescription: 'now with a subtitle' });
        return { updateProjectV2: { projectV2: projectNode(4, 'Board', 'b') } };
      }
      return undefined;
    });

    await connector.update(ctx, 'project:acme/4', {
      metadata: { shortDescription: 'now with a subtitle' },
    });
  });

  it('routes project ids to the projects GraphQL, not REST', async () => {
    connect((op) =>
      op === 'read' ? { repositoryOwner: { projectV2: projectNode(1, 'P') } } : undefined,
    );

    const resource = await connector.read(ctx, 'project:acme/1');

    expect(resource.type).toBe('project');
    expect(calls.every((c) => /projectV2/.test(c.query))).toBe(true);
  });
});
