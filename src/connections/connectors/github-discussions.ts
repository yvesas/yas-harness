// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Discussions, over GitHub's GraphQL API — the `discussion:owner/repo#number` kind.
 *
 * GraphQL rather than REST because that is the only place discussions exist,
 * and it costs two round trips where REST would take one: mutations address a
 * discussion by node id, not by number, so an update reads the discussion
 * first. That is GitHub's shape, not a choice made here.
 *
 * No delete: GitHub exposes one, but deleting a conversation people took part
 * in is not something this slice offers.
 */

import type {
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';

import type { GitHubApi } from './github-api.js';
import type { GitHubKind } from './github-kind.js';
import { CONNECTOR_ID, DEFAULT_LIMIT } from './github-kind.js';
import type { RepoNumberRef } from './github-refs.js';
import { parseRepoNumberRef, splitRepo } from './github-refs.js';

export const DISCUSSION_PREFIX = 'discussion:';

export interface GitHubDiscussion {
  number: number;
  id: string; // GraphQL node id, needed to update
  title: string;
  body: string | null;
  url: string;
  category?: { name?: string } | null;
  author?: { login?: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

export class DiscussionKind implements GitHubKind {
  readonly name = 'discussion';
  readonly prefix = DISCUSSION_PREFIX;
  readonly capabilities: readonly ConnectorCapability[] = ['list', 'read', 'create', 'update'];

  readonly #api: GitHubApi;

  constructor(api: GitHubApi) {
    this.#api = api;
  }

  async list(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const repo = options.parentId;
    if (!repo) {
      throw new ConnectorError(
        'listing GitHub discussions needs a parent ("owner/repo")',
        CONNECTOR_ID,
      );
    }
    const [owner, name] = splitRepo(repo, CONNECTOR_ID);
    const data = await this.#api.gql<{
      repository: {
        discussions: {
          nodes: GitHubDiscussion[];
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>(context, LIST_DISCUSSIONS, {
      owner,
      repo: name,
      first: options.limit ?? DEFAULT_LIMIT,
      after: options.cursor ?? null,
    });

    const page = data.repository?.discussions;
    return {
      resources: (page?.nodes ?? []).map((node) => discussionToResource(node, repo)),
      nextCursor: page?.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null,
    };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = this.#ref(id);
    const discussion = await this.#find(context, ref);
    return discussionToResource(discussion, `${ref.owner}/${ref.repo}`);
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const repo = draft.metadata?.['repo'];
    const categoryName = draft.metadata?.['category'];
    if (typeof repo !== 'string') {
      throw new ConnectorError(
        'creating a GitHub discussion needs metadata.repo ("owner/repo")',
        CONNECTOR_ID,
      );
    }
    const [owner, name] = splitRepo(repo, CONNECTOR_ID);

    // A discussion must go in a category; resolve the repo id and the category
    // id GitHub needs from the names the caller gave.
    const repoData = await this.#api.gql<{
      repository: {
        id: string;
        discussionCategories: { nodes: { id: string; name: string }[] };
      } | null;
    }>(context, DISCUSSION_CATEGORIES, { owner, repo: name });

    const repository = repoData.repository;
    if (!repository) {
      throw new ResourceNotFoundError(CONNECTOR_ID, repo);
    }
    const categories = repository.discussionCategories.nodes;
    const category =
      typeof categoryName === 'string'
        ? categories.find((c) => c.name === categoryName)
        : categories[0];
    if (!category) {
      throw new ConnectorError(
        typeof categoryName === 'string'
          ? `discussion category "${categoryName}" not found in ${repo}`
          : `repo ${repo} has no discussion category to create in`,
        CONNECTOR_ID,
      );
    }

    const created = await this.#api.gql<{ createDiscussion: { discussion: GitHubDiscussion } }>(
      context,
      CREATE_DISCUSSION,
      {
        repositoryId: repository.id,
        categoryId: category.id,
        title: draft.title,
        body: draft.content ?? '',
      },
    );
    return discussionToResource(created.createDiscussion.discussion, repo);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = this.#ref(id);
    // GraphQL updates by node id, not number — read the discussion first for it.
    const discussion = await this.#find(context, ref);

    const updated = await this.#api.gql<{ updateDiscussion: { discussion: GitHubDiscussion } }>(
      context,
      UPDATE_DISCUSSION,
      {
        id: discussion.id,
        title: patch.title ?? discussion.title,
        body: patch.content ?? discussion.body ?? '',
      },
    );
    return discussionToResource(updated.updateDiscussion.discussion, `${ref.owner}/${ref.repo}`);
  }

  /** The discussion behind a ref, or the not-found both callers need to raise. */
  async #find(context: ConnectorContext, ref: RepoNumberRef): Promise<GitHubDiscussion> {
    const data = await this.#api.gql<{
      repository: { discussion: GitHubDiscussion | null } | null;
    }>(context, READ_DISCUSSION, { owner: ref.owner, repo: ref.repo, number: ref.number });

    const discussion = data.repository?.discussion;
    if (!discussion) {
      throw new ResourceNotFoundError(
        CONNECTOR_ID,
        `${ref.owner}/${ref.repo} discussion #${ref.number}`,
      );
    }
    return discussion;
  }

  #ref(id: string): RepoNumberRef {
    return parseRepoNumberRef(id, this.prefix, CONNECTOR_ID);
  }
}

// --- GraphQL documents ------------------------------------------------------

const DISCUSSION_FIELDS = `
  number id title body url createdAt updatedAt
  author { login } category { name }
`;

const LIST_DISCUSSIONS = `
  query ($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      discussions(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { ${DISCUSSION_FIELDS} }
        pageInfo { endCursor hasNextPage }
      }
    }
  }`;

const READ_DISCUSSION = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) { ${DISCUSSION_FIELDS} }
    }
  }`;

const DISCUSSION_CATEGORIES = `
  query ($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      id
      discussionCategories(first: 50) { nodes { id name } }
    }
  }`;

const CREATE_DISCUSSION = `
  mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(
      input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }
    ) {
      discussion { ${DISCUSSION_FIELDS} }
    }
  }`;

const UPDATE_DISCUSSION = `
  mutation ($id: ID!, $title: String, $body: String) {
    updateDiscussion(input: { discussionId: $id, title: $title, body: $body }) {
      discussion { ${DISCUSSION_FIELDS} }
    }
  }`;

// --- translation ------------------------------------------------------------

export function discussionToResource(discussion: GitHubDiscussion, repo: string): Resource {
  return {
    id: `${DISCUSSION_PREFIX}${repo}#${discussion.number}`,
    type: 'discussion',
    title: discussion.title,
    content: discussion.body ?? null,
    mimeType: discussion.body === null || discussion.body === undefined ? null : 'text/markdown',
    parentId: repo,
    url: discussion.url,
    metadata: {
      number: discussion.number,
      nodeId: discussion.id,
      repo,
      ...(discussion.category?.name ? { category: discussion.category.name } : {}),
      ...(discussion.author?.login ? { author: discussion.author.login } : {}),
    },
    createdAt: discussion.createdAt ? new Date(discussion.createdAt) : null,
    updatedAt: discussion.updatedAt ? new Date(discussion.updatedAt) : null,
  };
}
