// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Projects v2, over GitHub's GraphQL API — the `project:owner/number` kind.
 *
 * A project hangs off an owner (a user or an org), not off a repository, which
 * is why its id and its `parentId` are an owner login where the other kinds
 * carry `owner/repo`.
 *
 * Like discussions, mutations address a project by node id, so a write reads
 * first. `createProjectV2` also takes only a title, so a create carrying
 * content sets the readme in a follow-up — otherwise `create` would silently
 * drop a body that every other kind honours.
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

export const PROJECT_PREFIX = 'project:';

export interface GitHubProject {
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

/** A project id decoded into its owner login and number. */
interface ProjectRef {
  readonly owner: string;
  readonly number: number;
}

export class ProjectKind implements GitHubKind {
  readonly name = 'project';
  readonly prefix = PROJECT_PREFIX;
  readonly capabilities: readonly ConnectorCapability[] = ['list', 'read', 'create', 'update'];

  readonly #api: GitHubApi;

  constructor(api: GitHubApi) {
    this.#api = api;
  }

  async list(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const owner = options.parentId;
    if (!owner) {
      throw new ConnectorError(
        'listing GitHub projects needs a parent (an owner login)',
        CONNECTOR_ID,
      );
    }
    const data = await this.#api.gql<{
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

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseProjectRef(id);
    const project = await this.#find(context, ref);
    return projectToResource(project, ref.owner);
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const owner = draft.metadata?.['owner'];
    if (typeof owner !== 'string') {
      throw new ConnectorError(
        'creating a GitHub project needs metadata.owner (a user or org login)',
        CONNECTOR_ID,
      );
    }

    // createProjectV2 wants the owner's node id, not its login — resolve it.
    const ownerData = await this.#api.gql<{ repositoryOwner: { id: string } | null }>(
      context,
      OWNER_ID,
      { login: owner },
    );
    const ownerId = ownerData.repositoryOwner?.id;
    if (!ownerId) {
      throw new ResourceNotFoundError(CONNECTOR_ID, owner);
    }

    const created = await this.#api.gql<{ createProjectV2: { projectV2: GitHubProject } }>(
      context,
      CREATE_PROJECT,
      { ownerId, title: draft.title },
    );
    const project = created.createProjectV2.projectV2;

    // createProjectV2 takes only a title; if a body was given, set the readme
    // in a follow-up so create honours `content` like the other kinds do.
    if (draft.content !== undefined && draft.content !== '') {
      const updated = await this.#api.gql<{ updateProjectV2: { projectV2: GitHubProject } }>(
        context,
        UPDATE_PROJECT,
        { id: project.id, readme: draft.content },
      );
      return projectToResource(updated.updateProjectV2.projectV2, owner);
    }
    return projectToResource(project, owner);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseProjectRef(id);
    // updateProjectV2 works by node id, not number — read the project first.
    const project = await this.#find(context, ref);

    // A short description change rides in metadata, since it is GitHub's own.
    const shortDescription =
      typeof patch.metadata?.['shortDescription'] === 'string'
        ? patch.metadata['shortDescription']
        : undefined;

    const updated = await this.#api.gql<{ updateProjectV2: { projectV2: GitHubProject } }>(
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

  /** The project behind a ref, or the not-found both callers need to raise. */
  async #find(context: ConnectorContext, ref: ProjectRef): Promise<GitHubProject> {
    const data = await this.#api.gql<{
      repositoryOwner: { projectV2: GitHubProject | null } | null;
    }>(context, READ_PROJECT, { login: ref.owner, number: ref.number });

    const project = data.repositoryOwner?.projectV2;
    if (!project) {
      throw new ResourceNotFoundError(CONNECTOR_ID, `${ref.owner} project #${ref.number}`);
    }
    return project;
  }
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

// --- GraphQL documents ------------------------------------------------------

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

export function projectToResource(project: GitHubProject, owner: string): Resource {
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
