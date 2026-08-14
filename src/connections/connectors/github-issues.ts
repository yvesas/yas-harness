// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Issues, over GitHub's REST API — the bare `owner/repo#number` kind.
 *
 * This is the kind with no id prefix, so an id that names no other kind is one
 * of these. It is also the only kind that searches: GitHub's search API covers
 * issues, and the resource shape's `search` has no type selector to ask for
 * anything else.
 *
 * Pull requests come back through the issues endpoint and are dropped: a PR is
 * a different thing with a different id, and returning them here would make a
 * repo's issue list quietly wrong.
 */

import type {
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from '../connector.js';
import { ConnectorError } from '../connector.js';

import type { GitHubApi } from './github-api.js';
import type { GitHubKind } from './github-kind.js';
import { CONNECTOR_ID, DEFAULT_LIMIT } from './github-kind.js';
import type { RepoNumberRef } from './github-refs.js';
import { parseRepoNumberRef, repoFromUrl, repoPath } from './github-refs.js';
import { pageNumber } from './page-cursor.js';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels?: ({ name?: string } | string)[];
  assignee?: { login?: string } | null;
  user?: { login?: string } | null;
  pull_request?: unknown; // present when the "issue" is really a PR
  created_at?: string;
  updated_at?: string;
}

export class IssueKind implements GitHubKind {
  readonly name = 'issue';
  readonly prefix = '';
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
  ];

  readonly #api: GitHubApi;

  constructor(api: GitHubApi) {
    this.#api = api;
  }

  async list(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const page = pageNumber(options.cursor, CONNECTOR_ID);
    const perPage = options.limit ?? DEFAULT_LIMIT;
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });

    // A parent is a `owner/repo`: list that repo's issues. Without one, list the
    // issues assigned to the authenticated user across their repos.
    const path = options.parentId
      ? `/repos/${repoPath(options.parentId, CONNECTOR_ID)}/issues?${query.toString()}`
      : `/issues?${query.toString()}`;

    const issues = await this.#api.rest<GitHubIssue[]>(context, 'GET', path);
    // GitHub lists pull requests through the issues endpoint too; drop them.
    const onlyIssues = issues.filter((issue) => !issue.pull_request);
    return {
      resources: onlyIssues.map((issue) =>
        issueToResource(issue, options.parentId ?? repoFromUrl(issue.html_url)),
      ),
      nextCursor: issues.length === perPage ? String(page + 1) : null,
    };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = this.#ref(id);
    const issue = await this.#api.rest<GitHubIssue>(
      context,
      'GET',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    );
    return issueToResource(issue, `${ref.owner}/${ref.repo}`);
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions,
  ): Promise<ResourcePage> {
    const page = pageNumber(options.cursor, CONNECTOR_ID);
    const perPage = options.limit ?? DEFAULT_LIMIT;
    const params = new URLSearchParams({
      q: `${query} type:issue`,
      per_page: String(perPage),
      page: String(page),
    });

    const body = await this.#api.rest<{ items?: GitHubIssue[]; total_count?: number }>(
      context,
      'GET',
      `/search/issues?${params.toString()}`,
    );
    const items = body.items ?? [];
    const total = body.total_count ?? items.length;
    return {
      resources: items.map((issue) => issueToResource(issue, repoFromUrl(issue.html_url))),
      nextCursor: page * perPage < total && items.length > 0 ? String(page + 1) : null,
    };
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const repo = draft.metadata?.['repo'];
    if (typeof repo !== 'string') {
      throw new ConnectorError(
        'creating a GitHub issue needs metadata.repo ("owner/repo")',
        CONNECTOR_ID,
      );
    }
    const created = await this.#api.rest<GitHubIssue>(
      context,
      'POST',
      `/repos/${repoPath(repo, CONNECTOR_ID)}/issues`,
      {
        title: draft.title,
        ...(draft.content ? { body: draft.content } : {}),
        ...(Array.isArray(draft.metadata?.['labels']) ? { labels: draft.metadata['labels'] } : {}),
      },
    );
    return issueToResource(created, repo);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = this.#ref(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['title'] = patch.title;
    if (patch.content !== undefined) body['body'] = patch.content;
    // A state change ("closed"/"open") rides in metadata, since it is GitHub's.
    if (typeof patch.metadata?.['state'] === 'string') body['state'] = patch.metadata['state'];

    const updated = await this.#api.rest<GitHubIssue>(
      context,
      'PATCH',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      body,
    );
    return issueToResource(updated, `${ref.owner}/${ref.repo}`);
  }

  #ref(id: string): RepoNumberRef {
    return parseRepoNumberRef(id, this.prefix, CONNECTOR_ID);
  }
}

export function issueToResource(issue: GitHubIssue, repo: string | null): Resource {
  return {
    id: repo ? `${repo}#${issue.number}` : String(issue.number),
    type: 'issue',
    title: issue.title,
    content: issue.body ?? null,
    mimeType: issue.body === null || issue.body === undefined ? null : 'text/markdown',
    parentId: repo,
    url: issue.html_url,
    metadata: {
      number: issue.number,
      ...(issue.state ? { state: issue.state } : {}),
      ...(repo ? { repo } : {}),
      ...(issue.user?.login ? { author: issue.user.login } : {}),
      ...(issue.assignee?.login ? { assignee: issue.assignee.login } : {}),
      labels: (issue.labels ?? []).map((label) =>
        typeof label === 'string' ? label : (label.name ?? ''),
      ),
    },
    createdAt: issue.created_at ? new Date(issue.created_at) : null,
    updatedAt: issue.updated_at ? new Date(issue.updated_at) : null,
  };
}
