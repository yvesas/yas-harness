// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for GitHub, covering issues, discussions, projects and code.
 *
 * One connection (one OAuth token) reaches them all, so this is one connector
 * with several resource kinds, routed by a discriminator in the id. Issues and
 * code use the REST API; discussions and projects (Projects v2) use GitHub's
 * GraphQL API. The kinds differ enough that the connector keeps them apart
 * internally, but a product sees one `github` connector and the same resource
 * shape for all.
 *
 * GitHub has no site id. Issues, discussions and code live under a repository
 * (`owner/repo`); a project lives under an owner (a user or an org):
 *  - an issue id is `owner/repo#number`
 *  - a discussion id is `discussion:owner/repo#number`
 *  - a project id is `project:owner/number`
 *  - a code id is `code:owner/repo:path` (a file or a directory)
 * The container (repo, owner login, or a directory) is addressed as the
 * `parentId`, and the kind is chosen by `options.type` / `draft.type`
 * (`"discussion"`, `"project"`, `"code"`, otherwise issue).
 *
 * Code is read-only here: `list` browses a directory and `read` fetches a
 * file's text — writing code means commits and pull requests, out of this
 * slice. And no kind declares `delete`: GitHub does not delete issues over the
 * API, and discussion/project deletion is left out too — a connector
 * legitimately exposing only what it supports.
 *
 * Nothing product-domain here: a GitHub issue, discussion, project or file is a
 * record the same in a language tutor and a CRM. Written against `fetch`; no
 * dependency.
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

import { GitHubGraphQL, GitHubGraphQLNotFound } from './github-graphql.js';

const CONNECTOR_ID = 'github';
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_LIMIT = 25;
const DISCUSSION_PREFIX = 'discussion:';
const PROJECT_PREFIX = 'project:';
const CODE_PREFIX = 'code:';
const SLASH = '/'.charCodeAt(0);

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

interface GitHubDiscussion {
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

interface GitHubProject {
  number: number;
  id: string; // GraphQL node id, needed to update
  title: string;
  readme: string | null;
  shortDescription: string | null;
  url: string;
  public?: boolean;
  closed?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** One entry from the repository contents API — a file or a directory. */
interface GitHubContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string | null;
  /** Base64 body, present only when reading a single file. */
  content?: string;
  encoding?: string;
}

/** A resource id decoded into which repo and which kind it names. */
interface Ref {
  readonly kind: 'issue' | 'discussion';
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** A project id decoded into its owner login and number. */
interface ProjectRef {
  readonly owner: string;
  readonly number: number;
}

/** A code id decoded into its repo and a path within it (empty = repo root). */
interface CodeRef {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
}

export class GitHubConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description =
    'GitHub issues, discussions, projects and code across a user’s repositories and orgs.';
  // No delete: GitHub does not delete issues over the API, and discussion /
  // project deletion is out of these slices. Code is read-only.
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;
  readonly #graphql: GitHubGraphQL;

  constructor(options: GitHubConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? GITHUB_API;
    this.#graphql = new GitHubGraphQL(this.#fetch, CONNECTOR_ID, this.#apiBase);
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    if (options.type === 'discussion') return this.#listDiscussions(context, options);
    if (options.type === 'project') return this.#listProjects(context, options);
    if (options.type === 'code') return this.#listCode(context, options);
    return this.#listIssues(context, options);
  }

  // async so a parse failure surfaces as a rejected promise, not a throw.
  async read(context: ConnectorContext, id: string): Promise<Resource> {
    if (id.startsWith(PROJECT_PREFIX)) return this.#readProject(context, parseProjectRef(id));
    if (id.startsWith(CODE_PREFIX)) return this.#readCode(context, parseCodeRef(id));
    const ref = parseRef(id);
    return ref.kind === 'discussion'
      ? this.#readDiscussion(context, ref)
      : this.#readIssue(context, ref);
  }

  create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type === 'project') return this.#createProject(context, draft);
    return draft.type === 'discussion'
      ? this.#createDiscussion(context, draft)
      : this.#createIssue(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    if (id.startsWith(PROJECT_PREFIX)) {
      return this.#updateProject(context, parseProjectRef(id), patch);
    }
    const ref = parseRef(id);
    return ref.kind === 'discussion'
      ? this.#updateDiscussion(context, ref, patch)
      : this.#updateIssue(context, ref, patch);
  }

  /**
   * Search covers issues (REST). Discussion and code search are later slices —
   * the shape's `search` has no type selector to tell them apart yet.
   */
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

    const body = await this.#rest<{ items?: GitHubIssue[]; total_count?: number }>(
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

  // --- issues (REST) --------------------------------------------------------

  async #listIssues(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const page = options.cursor ? Number(options.cursor) : 1;
    const perPage = options.limit ?? DEFAULT_LIMIT;
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });

    // A parent is a `owner/repo`: list that repo's issues. Without one, list the
    // issues assigned to the authenticated user across their repos.
    const path = options.parentId
      ? `/repos/${repoPath(options.parentId)}/issues?${query.toString()}`
      : `/issues?${query.toString()}`;

    const issues = await this.#rest<GitHubIssue[]>(context, 'GET', path);
    // GitHub lists pull requests through the issues endpoint too; drop them.
    const onlyIssues = issues.filter((issue) => !issue.pull_request);
    return {
      resources: onlyIssues.map((issue) =>
        issueToResource(issue, options.parentId ?? repoFromUrl(issue.html_url)),
      ),
      nextCursor: issues.length === perPage ? String(page + 1) : null,
    };
  }

  async #readIssue(context: ConnectorContext, ref: Ref): Promise<Resource> {
    const issue = await this.#rest<GitHubIssue>(
      context,
      'GET',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    );
    return issueToResource(issue, `${ref.owner}/${ref.repo}`);
  }

  async #createIssue(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const repo = draft.metadata?.['repo'];
    if (typeof repo !== 'string') {
      throw new ConnectorError(
        'creating a GitHub issue needs metadata.repo ("owner/repo")',
        this.id,
      );
    }
    const created = await this.#rest<GitHubIssue>(
      context,
      'POST',
      `/repos/${repoPath(repo)}/issues`,
      {
        title: draft.title,
        ...(draft.content ? { body: draft.content } : {}),
        ...(Array.isArray(draft.metadata?.['labels']) ? { labels: draft.metadata['labels'] } : {}),
      },
    );
    return issueToResource(created, repo);
  }

  async #updateIssue(context: ConnectorContext, ref: Ref, patch: ResourcePatch): Promise<Resource> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['title'] = patch.title;
    if (patch.content !== undefined) body['body'] = patch.content;
    // A state change ("closed"/"open") rides in metadata, since it is GitHub's.
    if (typeof patch.metadata?.['state'] === 'string') body['state'] = patch.metadata['state'];

    const updated = await this.#rest<GitHubIssue>(
      context,
      'PATCH',
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      body,
    );
    return issueToResource(updated, `${ref.owner}/${ref.repo}`);
  }

  // --- discussions (GraphQL) ------------------------------------------------

  async #listDiscussions(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const repo = options.parentId;
    if (!repo) {
      throw new ConnectorError('listing GitHub discussions needs a parent ("owner/repo")', this.id);
    }
    const [owner, name] = splitRepo(repo);
    const data = await this.#gql<{
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

  async #readDiscussion(context: ConnectorContext, ref: Ref): Promise<Resource> {
    const data = await this.#gql<{ repository: { discussion: GitHubDiscussion | null } | null }>(
      context,
      READ_DISCUSSION,
      { owner: ref.owner, repo: ref.repo, number: ref.number },
    );
    const discussion = data.repository?.discussion;
    if (!discussion) {
      throw new ResourceNotFoundError(
        this.id,
        `${ref.owner}/${ref.repo} discussion #${ref.number}`,
      );
    }
    return discussionToResource(discussion, `${ref.owner}/${ref.repo}`);
  }

  async #createDiscussion(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const repo = draft.metadata?.['repo'];
    const categoryName = draft.metadata?.['category'];
    if (typeof repo !== 'string') {
      throw new ConnectorError(
        'creating a GitHub discussion needs metadata.repo ("owner/repo")',
        this.id,
      );
    }
    const [owner, name] = splitRepo(repo);

    // A discussion must go in a category; resolve the repo id and the category
    // id GitHub needs from the names the caller gave.
    const repoData = await this.#gql<{
      repository: {
        id: string;
        discussionCategories: { nodes: { id: string; name: string }[] };
      } | null;
    }>(context, DISCUSSION_CATEGORIES, { owner, repo: name });

    const repository = repoData.repository;
    if (!repository) {
      throw new ResourceNotFoundError(this.id, repo);
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
        this.id,
      );
    }

    const created = await this.#gql<{ createDiscussion: { discussion: GitHubDiscussion } }>(
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

  async #updateDiscussion(
    context: ConnectorContext,
    ref: Ref,
    patch: ResourcePatch,
  ): Promise<Resource> {
    // GraphQL updates by node id, not number — read the discussion first for it.
    const current = await this.#gql<{ repository: { discussion: GitHubDiscussion | null } | null }>(
      context,
      READ_DISCUSSION,
      { owner: ref.owner, repo: ref.repo, number: ref.number },
    );
    const discussion = current.repository?.discussion;
    if (!discussion) {
      throw new ResourceNotFoundError(
        this.id,
        `${ref.owner}/${ref.repo} discussion #${ref.number}`,
      );
    }

    const updated = await this.#gql<{ updateDiscussion: { discussion: GitHubDiscussion } }>(
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

  // --- projects (GraphQL, Projects v2) --------------------------------------

  async #listProjects(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const owner = options.parentId;
    if (!owner) {
      throw new ConnectorError('listing GitHub projects needs a parent (an owner login)', this.id);
    }
    const data = await this.#gql<{
      repositoryOwner: {
        projectsV2?: {
          nodes: GitHubProject[];
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>(context, LIST_PROJECTS, {
      login: owner,
      first: options.limit ?? DEFAULT_LIMIT,
      after: options.cursor ?? null,
    });

    const page = data.repositoryOwner?.projectsV2;
    return {
      resources: (page?.nodes ?? []).map((node) => projectToResource(node, owner)),
      nextCursor: page?.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null,
    };
  }

  async #readProject(context: ConnectorContext, ref: ProjectRef): Promise<Resource> {
    const data = await this.#gql<{
      repositoryOwner: { projectV2: GitHubProject | null } | null;
    }>(context, READ_PROJECT, { login: ref.owner, number: ref.number });
    const project = data.repositoryOwner?.projectV2;
    if (!project) {
      throw new ResourceNotFoundError(this.id, `${ref.owner} project #${ref.number}`);
    }
    return projectToResource(project, ref.owner);
  }

  async #createProject(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const owner = draft.metadata?.['owner'];
    if (typeof owner !== 'string') {
      throw new ConnectorError(
        'creating a GitHub project needs metadata.owner (a user or org login)',
        this.id,
      );
    }

    // createProjectV2 wants the owner's node id, not its login — resolve it.
    const ownerData = await this.#gql<{ repositoryOwner: { id: string } | null }>(
      context,
      OWNER_ID,
      { login: owner },
    );
    const ownerId = ownerData.repositoryOwner?.id;
    if (!ownerId) {
      throw new ResourceNotFoundError(this.id, owner);
    }

    const created = await this.#gql<{ createProjectV2: { projectV2: GitHubProject } }>(
      context,
      CREATE_PROJECT,
      { ownerId, title: draft.title },
    );
    const project = created.createProjectV2.projectV2;

    // createProjectV2 takes only a title; if a body was given, set the readme
    // in a follow-up so create honours `content` like the other kinds do.
    if (draft.content !== undefined && draft.content !== '') {
      const updated = await this.#gql<{ updateProjectV2: { projectV2: GitHubProject } }>(
        context,
        UPDATE_PROJECT,
        { id: project.id, readme: draft.content },
      );
      return projectToResource(updated.updateProjectV2.projectV2, owner);
    }
    return projectToResource(project, owner);
  }

  async #updateProject(
    context: ConnectorContext,
    ref: ProjectRef,
    patch: ResourcePatch,
  ): Promise<Resource> {
    // updateProjectV2 works by node id, not number — read the project first.
    const current = await this.#gql<{
      repositoryOwner: { projectV2: GitHubProject | null } | null;
    }>(context, READ_PROJECT, { login: ref.owner, number: ref.number });
    const project = current.repositoryOwner?.projectV2;
    if (!project) {
      throw new ResourceNotFoundError(this.id, `${ref.owner} project #${ref.number}`);
    }

    // A short description change rides in metadata, since it is GitHub's own.
    const shortDescription =
      typeof patch.metadata?.['shortDescription'] === 'string'
        ? patch.metadata['shortDescription']
        : undefined;

    const updated = await this.#gql<{ updateProjectV2: { projectV2: GitHubProject } }>(
      context,
      UPDATE_PROJECT,
      {
        id: project.id,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.content !== undefined ? { readme: patch.content } : {}),
        ...(shortDescription !== undefined ? { shortDescription } : {}),
      },
    );
    return projectToResource(updated.updateProjectV2.projectV2, ref.owner);
  }

  // --- code (REST, repository contents) -------------------------------------

  async #listCode(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const container = options.parentId;
    if (!container) {
      throw new ConnectorError(
        'listing GitHub code needs a parent (a repo "owner/repo" or a directory id)',
        this.id,
      );
    }
    const ref = container.startsWith(CODE_PREFIX)
      ? parseCodeRef(container)
      : codeRootRef(container);

    const body = await this.#rest<GitHubContent[] | GitHubContent>(
      context,
      'GET',
      contentsPath(ref),
    );
    // A directory comes back as an array; a file path would return one object,
    // but a list is a directory browse, so anything else is an empty page. The
    // contents API returns a directory's entries in one unpaginated shot.
    const entries = Array.isArray(body) ? body : [];
    return {
      resources: entries.map((entry) => contentToResource(entry, ref.owner, ref.repo, container)),
      nextCursor: null,
    };
  }

  async #readCode(context: ConnectorContext, ref: CodeRef): Promise<Resource> {
    const body = await this.#rest<GitHubContent[] | GitHubContent>(
      context,
      'GET',
      contentsPath(ref),
    );
    const parentId = parentContainerId(ref.owner, ref.repo, ref.path);
    // A directory path comes back as an array; represent it as a dir resource —
    // its children come from `list`, not from a single read.
    if (Array.isArray(body)) {
      return dirToResource(ref, parentId);
    }
    return contentToResource(body, ref.owner, ref.repo, parentId);
  }

  // --- transport ------------------------------------------------------------

  async #rest<T>(
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

  async #gql<T>(
    context: ConnectorContext,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.#graphql.query<T>(this.#accessToken(context), query, variables);
    } catch (error) {
      if (error instanceof GitHubGraphQLNotFound) {
        throw new ResourceNotFoundError(this.id, error.message);
      }
      throw error;
    }
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('github connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
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

// A project is owned by a user or an org. `repositoryOwner` returns whichever it
// is, and both implement ProjectV2Owner — so one query reaches the project
// fields without the connector having to know or ask which kind of owner it is.
const PROJECT_FIELDS = `
  number id title readme shortDescription url public closed createdAt updatedAt
`;

const LIST_PROJECTS = `
  query ($login: String!, $first: Int!, $after: String) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectsV2(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${PROJECT_FIELDS} }
          pageInfo { endCursor hasNextPage }
        }
      }
    }
  }`;

const READ_PROJECT = `
  query ($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) { ${PROJECT_FIELDS} }
      }
    }
  }`;

const OWNER_ID = `
  query ($login: String!) {
    repositoryOwner(login: $login) { id }
  }`;

const CREATE_PROJECT = `
  mutation ($ownerId: ID!, $title: String!) {
    createProjectV2(input: { ownerId: $ownerId, title: $title }) {
      projectV2 { ${PROJECT_FIELDS} }
    }
  }`;

const UPDATE_PROJECT = `
  mutation ($id: ID!, $title: String, $readme: String, $shortDescription: String) {
    updateProjectV2(
      input: { projectId: $id, title: $title, readme: $readme, shortDescription: $shortDescription }
    ) {
      projectV2 { ${PROJECT_FIELDS} }
    }
  }`;

// --- translation ------------------------------------------------------------

function issueToResource(issue: GitHubIssue, repo: string | null): Resource {
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

function discussionToResource(discussion: GitHubDiscussion, repo: string): Resource {
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

function projectToResource(project: GitHubProject, owner: string): Resource {
  // The readme is a project's long-form body; the short description is a source
  // field this shape does not name, so it rides in metadata.
  const readme = project.readme ? project.readme : null;
  return {
    id: `${PROJECT_PREFIX}${owner}/${project.number}`,
    type: 'project',
    title: project.title,
    content: readme,
    mimeType: readme === null ? null : 'text/markdown',
    parentId: owner,
    url: project.url,
    metadata: {
      number: project.number,
      nodeId: project.id,
      owner,
      ...(project.shortDescription ? { shortDescription: project.shortDescription } : {}),
      ...(typeof project.public === 'boolean' ? { public: project.public } : {}),
      ...(typeof project.closed === 'boolean' ? { closed: project.closed } : {}),
    },
    createdAt: project.createdAt ? new Date(project.createdAt) : null,
    updatedAt: project.updatedAt ? new Date(project.updatedAt) : null,
  };
}

function contentToResource(
  entry: GitHubContent,
  owner: string,
  repo: string,
  parentId: string,
): Resource {
  const isDir = entry.type === 'dir';
  // The body arrives base64 only when a single file is read; in a listing it is
  // absent, so content stays null there, as the contract asks.
  const content =
    entry.type === 'file' && entry.content !== undefined && entry.encoding === 'base64'
      ? decodeBase64(entry.content)
      : null;
  return {
    id: `${CODE_PREFIX}${owner}/${repo}:${entry.path}`,
    type: isDir ? 'dir' : 'file',
    title: entry.name,
    content,
    mimeType: isDir ? null : guessMimeType(entry.name),
    parentId,
    url: entry.html_url,
    metadata: {
      path: entry.path,
      repo: `${owner}/${repo}`,
      sha: entry.sha,
      size: entry.size,
      kind: entry.type,
    },
    createdAt: null,
    updatedAt: null,
  };
}

function dirToResource(ref: CodeRef, parentId: string): Resource {
  const name = ref.path === '' ? ref.repo : ref.path.slice(ref.path.lastIndexOf('/') + 1);
  return {
    id: `${CODE_PREFIX}${ref.owner}/${ref.repo}:${ref.path}`,
    type: 'dir',
    title: name,
    content: null,
    mimeType: null,
    parentId,
    url: null,
    metadata: { path: ref.path, repo: `${ref.owner}/${ref.repo}`, kind: 'dir' },
    createdAt: null,
    updatedAt: null,
  };
}

// --- id / repo helpers ------------------------------------------------------

const REF = /^([^/]+)\/([^/#]+)#(\d+)$/;

function parseRef(id: string): Ref {
  const isDiscussion = id.startsWith(DISCUSSION_PREFIX);
  const bare = isDiscussion ? id.slice(DISCUSSION_PREFIX.length) : id;
  const match = REF.exec(bare);
  if (!match) {
    throw new ConnectorError(
      `invalid GitHub id "${id}"; expected "owner/repo#number" or "discussion:owner/repo#number"`,
      CONNECTOR_ID,
    );
  }
  return {
    kind: isDiscussion ? 'discussion' : 'issue',
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
  };
}

const PROJECT_REF = /^([^/]+)\/(\d+)$/;

/** Decode a `project:owner/number` id into its owner login and number. */
function parseProjectRef(id: string): ProjectRef {
  const match = PROJECT_REF.exec(id.slice(PROJECT_PREFIX.length));
  if (!match) {
    throw new ConnectorError(
      `invalid GitHub project id "${id}"; expected "project:owner/number"`,
      CONNECTOR_ID,
    );
  }
  return { owner: match[1]!, number: Number(match[2]) };
}

/**
 * Decode a `code:owner/repo:path` id. The first colon after the prefix splits
 * the repo from the path; the path may be empty (the repo root) or hold further
 * slashes. `code:owner/repo` with no path names the root too.
 */
function parseCodeRef(id: string): CodeRef {
  const rest = id.slice(CODE_PREFIX.length);
  const colon = rest.indexOf(':');
  const repoPart = colon === -1 ? rest : rest.slice(0, colon);
  const path = colon === -1 ? '' : rest.slice(colon + 1);
  const [owner, repo] = repoPart.split('/');
  if (!owner || !repo || repo.includes('/')) {
    throw new ConnectorError(
      `invalid GitHub code id "${id}"; expected "code:owner/repo:path"`,
      CONNECTOR_ID,
    );
  }
  return { owner, repo, path: trimSlashes(path) };
}

/** Strip leading and trailing slashes in linear time (no backtracking regex). */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path.charCodeAt(start) === SLASH) start++;
  while (end > start && path.charCodeAt(end - 1) === SLASH) end--;
  return path.slice(start, end);
}

/** A bare `owner/repo` container as a code ref at the repo root. */
function codeRootRef(repo: string): CodeRef {
  const [owner, name] = splitRepo(repo);
  return { owner, repo: name, path: '' };
}

/** The REST contents path for a code ref, url-encoding each path segment. */
function contentsPath(ref: CodeRef): string {
  const encoded =
    ref.path === '' ? '' : `/${ref.path.split('/').map(encodeURIComponent).join('/')}`;
  return `/repos/${ref.owner}/${ref.repo}/contents${encoded}`;
}

/** The container id for the directory holding `path` — the repo root if top-level. */
function parentContainerId(owner: string, repo: string, path: string): string {
  const slash = path.lastIndexOf('/');
  const parentPath = slash === -1 ? '' : path.slice(0, slash);
  return parentPath === '' ? `${owner}/${repo}` : `${CODE_PREFIX}${owner}/${repo}:${parentPath}`;
}

/** GitHub returns file bodies as base64 (with newlines); decode to text. */
function decodeBase64(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** A best-effort mime type from a file's extension; text/plain otherwise. */
function guessMimeType(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'css':
      return 'text/css';
    case 'csv':
      return 'text/csv';
    case 'xml':
      return 'application/xml';
    case 'yml':
    case 'yaml':
      return 'application/yaml';
    default:
      return 'text/plain';
  }
}

/** Validate and return `owner/repo` for use in a REST path. */
function repoPath(repo: string): string {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new ConnectorError(`invalid repo "${repo}"; expected "owner/repo"`, CONNECTOR_ID);
  }
  return repo;
}

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name || name.includes('/')) {
    throw new ConnectorError(`invalid repo "${repo}"; expected "owner/repo"`, CONNECTOR_ID);
  }
  return [owner, name];
}

/** Recover `owner/repo` from an issue's html_url, for search/user-issue results. */
function repoFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
