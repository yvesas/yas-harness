// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The discussion side of the GitHub connector, driven by a stub of the GraphQL
 * API. What is tested is the GraphQL translation: discussions to resources with
 * a `discussion:owner/repo#number` id, the category resolution on create, the
 * read-then-write by node id on update, and the NOT_FOUND mapping.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
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

function discussionNode(number: number, title: string, body = 'a discussion body', extra: Record<string, unknown> = {}) {
  return {
    number,
    id: `D_node_${number}`,
    title,
    body,
    url: `https://github.com/acme/widgets/discussions/${number}`,
    author: { login: 'octocat' },
    category: { name: 'General' },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

/** A GraphQL stub: routes on the operation name found in the query text. */
function fakeGraphQL(handler: (op: string, vars: Record<string, unknown>) => unknown) {
  const calls: GqlCall[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    expect(u.pathname).toBe('/graphql');
    const { query, variables } = JSON.parse(init!.body as string) as GqlCall;
    calls.push({ query, variables });

    const op = /discussions\(/.test(query)
      ? 'list'
      : /discussion\(number/.test(query)
        ? 'read'
        : /discussionCategories/.test(query)
          ? 'categories'
          : /createDiscussion/.test(query)
            ? 'create'
            : /updateDiscussion/.test(query)
              ? 'update'
              : 'unknown';

    const result = handler(op, variables);
    const payload =
      result === undefined
        ? { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }
        : { data: result };
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
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

describe('GitHubConnector — discussions', () => {
  it('lists a repo’s discussions, prefixing the id', async () => {
    connect((op, vars) => {
      if (op !== 'list') return undefined;
      expect(vars).toMatchObject({ owner: 'acme', repo: 'widgets' });
      return {
        repository: {
          discussions: {
            nodes: [discussionNode(1, 'Roadmap'), discussionNode(2, 'Ideas')],
            pageInfo: { endCursor: 'CUR', hasNextPage: true },
          },
        },
      };
    });

    const listed = await connector.list(ctx, { type: 'discussion', parentId: 'acme/widgets' });

    expect(listed.resources.map((r) => r.id)).toEqual([
      'discussion:acme/widgets#1',
      'discussion:acme/widgets#2',
    ]);
    expect(listed.resources[0]).toMatchObject({ type: 'discussion', title: 'Roadmap' });
    expect(listed.nextCursor).toBe('CUR');
  });

  it('ends pagination when there is no next page', async () => {
    connect((op) =>
      op === 'list'
        ? { repository: { discussions: { nodes: [discussionNode(1, 'x')], pageInfo: { endCursor: 'C', hasNextPage: false } } } }
        : undefined,
    );

    const listed = await connector.list(ctx, { type: 'discussion', parentId: 'acme/widgets' });

    expect(listed.nextCursor).toBeNull();
  });

  it('needs a parent to list discussions', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'discussion' })).rejects.toThrowError(
      /needs a parent/,
    );
  });

  it('reads a discussion, mapping body and category, keeping the node id', async () => {
    connect((op, vars) => {
      if (op !== 'read') return undefined;
      expect(vars).toMatchObject({ owner: 'acme', repo: 'widgets', number: 5 });
      return { repository: { discussion: discussionNode(5, 'How do we deploy?', '## steps') } };
    });

    const resource = await connector.read(ctx, 'discussion:acme/widgets#5');

    expect(resource).toMatchObject({
      id: 'discussion:acme/widgets#5',
      type: 'discussion',
      title: 'How do we deploy?',
      content: '## steps',
      mimeType: 'text/markdown',
      parentId: 'acme/widgets',
      metadata: { number: 5, nodeId: 'D_node_5', repo: 'acme/widgets', category: 'General', author: 'octocat' },
    });
  });

  it('maps a GraphQL NOT_FOUND to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'discussion:acme/widgets#404')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('creates a discussion, resolving the repo and category ids', async () => {
    connect((op, vars) => {
      if (op === 'categories') {
        return {
          repository: {
            id: 'REPO_id',
            discussionCategories: { nodes: [{ id: 'CAT_general', name: 'General' }, { id: 'CAT_qa', name: 'Q&A' }] },
          },
        };
      }
      if (op === 'create') {
        expect(vars).toMatchObject({ repositoryId: 'REPO_id', categoryId: 'CAT_qa', title: 'Deploy question' });
        return { createDiscussion: { discussion: discussionNode(10, 'Deploy question', 'how?') } };
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'discussion',
      title: 'Deploy question',
      content: 'how?',
      metadata: { repo: 'acme/widgets', category: 'Q&A' },
    });

    expect(created.id).toBe('discussion:acme/widgets#10');
    // Resolved the category by name before creating.
    expect(calls.map((c) => (/discussionCategories/.test(c.query) ? 'cat' : 'create'))).toEqual(['cat', 'create']);
  });

  it('defaults to the first category when none is named', async () => {
    connect((op, vars) => {
      if (op === 'categories') {
        return { repository: { id: 'R', discussionCategories: { nodes: [{ id: 'FIRST', name: 'General' }] } } };
      }
      if (op === 'create') {
        expect(vars['categoryId']).toBe('FIRST');
        return { createDiscussion: { discussion: discussionNode(11, 'x') } };
      }
      return undefined;
    });

    await connector.create(ctx, { type: 'discussion', title: 'x', metadata: { repo: 'acme/widgets' } });
  });

  it('fails when the named category does not exist', async () => {
    connect((op) =>
      op === 'categories'
        ? { repository: { id: 'R', discussionCategories: { nodes: [{ id: 'G', name: 'General' }] } } }
        : undefined,
    );

    await expect(
      connector.create(ctx, {
        type: 'discussion',
        title: 'x',
        metadata: { repo: 'acme/widgets', category: 'Nonexistent' },
      }),
    ).rejects.toThrowError(/category "Nonexistent" not found/);
  });

  it('needs a repo to create a discussion', async () => {
    connect(() => undefined);

    await expect(
      connector.create(ctx, { type: 'discussion', title: 'x' }),
    ).rejects.toThrowError(/needs metadata\.repo/);
  });

  it('edits a discussion, reading its node id first then updating by id', async () => {
    connect((op, vars) => {
      if (op === 'read') return { repository: { discussion: discussionNode(3, 'Old title', 'old') } };
      if (op === 'update') {
        expect(vars).toMatchObject({ id: 'D_node_3', title: 'Old title', body: 'new body' });
        return { updateDiscussion: { discussion: discussionNode(3, 'Old title', 'new body') } };
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'discussion:acme/widgets#3', { content: 'new body' });

    expect(updated.content).toBe('new body');
    // Read (for the node id) then update.
    expect(calls.map((c) => (/updateDiscussion/.test(c.query) ? 'update' : 'read'))).toEqual(['read', 'update']);
  });

  it('routes issue ids to REST, discussion ids to GraphQL', async () => {
    // A discussion id must not hit the REST issues endpoint.
    connect((op) => (op === 'read' ? { repository: { discussion: discussionNode(1, 'D') } } : undefined));

    const resource = await connector.read(ctx, 'discussion:acme/widgets#1');

    expect(resource.type).toBe('discussion');
    expect(calls.every((c) => c.query.includes('discussion'))).toBe(true);
  });

  it('surfaces a non-NOT_FOUND GraphQL error as a ConnectorError', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ type: 'FORBIDDEN', message: 'no access' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const c = new GitHubConnector({ fetch, baseUrl: 'https://api.test' });

    await expect(c.read(ctx, 'discussion:acme/widgets#1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
