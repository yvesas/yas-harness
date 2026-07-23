// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for GitHub issues.
 *
 * The third real source. Simpler than the Atlassian ones in one way — issue
 * bodies are Markdown, not a document tree — and different in another: there is
 * no site id, and a repository (`owner/repo`) is the container. So a resource's
 * id is `owner/repo#number`, and a repo is addressed as the `parentId`.
 *
 * This slice covers issues; discussions and projects (GitHub GraphQL) and code
 * reading are later slices of the same connector. GitHub does not delete issues
 * over the API, so `delete` is not declared — a legitimate use of the contract
 * exposing only what the source supports.
 *
 * Nothing product-domain here: a GitHub issue is a task record the same in a
 * language tutor and a CRM. Written against `fetch`; no dependency.
 */

import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'github';
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_LIMIT = 25;

export interface GitHubConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

interface GitHubIssue {
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

/** `owner/repo#number` — a resource id that carries which repo it belongs to. */
interface IssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export class GitHubConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'GitHub issues across a user’s repositories.';
  // No delete: GitHub does not delete issues over the API.
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: GitHubConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? GITHUB_API;
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    const page = options.cursor ? Number(options.cursor) : 1;
    const perPage = options.limit ?? DEFAULT_LIMIT;
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });

    // A parent is a `owner/repo`: list that repo's issues. Without one, list the
    // issues assigned to the authenticated user across their repos.
    const path = options.parentId
      ? `/repos/${repoPath(options.parentId)}/issues?${query.toString()}`
      : `/issues?${query.toString()}`;

    const issues = await this.#api<GitHubIssue[]>(context, 'GET', path);
    return this.#pageOf(issues, options.parentId, page, perPage);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id, this.id);
    const issue = await this.#api<GitHubIssue>(
      context,
      'GET',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    );
    return toResource(issue, `${ref.owner}/${ref.repo}`);
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    const page = options.cursor ? Number(options.cursor) : 1;
    const perPage = options.limit ?? DEFAULT_LIMIT;
    const params = new URLSearchParams({
      q: `${query} type:issue`,
      per_page: String(perPage),
      page: String(page),
    });

    const body = await this.#api<{ items?: GitHubIssue[]; total_count?: number }>(
      context,
      'GET',
      `/search/issues?${params.toString()}`,
    );
    const items = body.items ?? [];
    const total = body.total_count ?? items.length;
    return {
      resources: items.map((issue) => toResource(issue, repoFromUrl(issue.html_url))),
      nextCursor: page * perPage < total && items.length > 0 ? String(page + 1) : null,
    };
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const repo = draft.metadata?.['repo'];
    if (typeof repo !== 'string') {
      throw new ConnectorError(
        'creating a GitHub issue needs metadata.repo ("owner/repo")',
        this.id,
      );
    }

    const created = await this.#api<GitHubIssue>(
      context,
      'POST',
      `/repos/${repoPath(repo)}/issues`,
      {
        title: draft.title,
        ...(draft.content ? { body: draft.content } : {}),
        ...(Array.isArray(draft.metadata?.['labels']) ? { labels: draft.metadata['labels'] } : {}),
      },
    );
    return toResource(created, repo);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseRef(id, this.id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      body['title'] = patch.title;
    }
    if (patch.content !== undefined) {
      body['body'] = patch.content;
    }
    // A state change ("closed"/"open") rides in metadata, since it is GitHub's.
    if (typeof patch.metadata?.['state'] === 'string') {
      body['state'] = patch.metadata['state'];
    }

    const updated = await this.#api<GitHubIssue>(
      context,
      'PATCH',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      body,
    );
    return toResource(updated, `${ref.owner}/${ref.repo}`);
  }

  #pageOf(
    issues: GitHubIssue[],
    parentId: string | undefined,
    page: number,
    perPage: number,
  ): ResourcePage {
    // GitHub lists pull requests through the issues endpoint too; drop them so
    // the connector is about issues only.
    const onlyIssues = issues.filter((issue) => !issue.pull_request);
    return {
      resources: onlyIssues.map((issue) =>
        toResource(issue, parentId ?? repoFromUrl(issue.html_url)),
      ),
      // A full page implies there may be another; a short page ends it.
      nextCursor: issues.length === perPage ? String(page + 1) : null,
    };
  }

  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = this.#accessToken(context);
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 404) {
      throw new ResourceNotFoundError(this.id, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `github responded ${response.status}: ${text.slice(0, 500)}`,
        this.id,
      );
    }
    return (await response.json()) as T;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('github connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

function toResource(issue: GitHubIssue, repo: string | null): Resource {
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

const REF = /^([^/]+)\/([^/#]+)#(\d+)$/;

function parseRef(id: string, connectorId: string): IssueRef {
  const match = REF.exec(id);
  if (!match) {
    throw new ConnectorError(
      `invalid GitHub issue id "${id}"; expected "owner/repo#number"`,
      connectorId,
    );
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** Validate and return `owner/repo` for use in a path. */
function repoPath(repo: string): string {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new ConnectorError(`invalid repo "${repo}"; expected "owner/repo"`, CONNECTOR_ID);
  }
  return repo;
}

/** Recover `owner/repo` from an issue's html_url, for search/user-issue results. */
function repoFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
