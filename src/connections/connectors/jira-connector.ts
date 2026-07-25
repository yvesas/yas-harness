// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Jira Cloud.
 *
 * Issues become resources — the summary is the title, the description is the
 * content, the parent (epic or subtask parent) is the parentId, and status,
 * type, project and assignee land in metadata. It shares the Atlassian
 * plumbing with Confluence, so this file is only the Jira-specific part: the
 * endpoints and the translation, including Jira's document format for text.
 *
 * Nothing product-domain here: a Jira issue is a task record the same way in a
 * language tutor and a CRM. Written against `fetch` via the shared site helper.
 */

import type {
  Connector,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';

import { AtlassianNotFound, AtlassianSite } from './atlassian-site.js';

const CONNECTOR_ID = 'jira';
const DEFAULT_LIMIT = 25;
/** Fields asked of Jira, so the response is not the whole fat issue. */
const FIELDS = 'summary,description,status,issuetype,project,assignee,parent,created,updated';

export interface JiraConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the Atlassian API base; only for tests. */
  readonly baseUrl?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown; // Atlassian Document Format
    status?: { name?: string };
    issuetype?: { name?: string };
    project?: { id?: string; key?: string };
    assignee?: { displayName?: string; accountId?: string } | null;
    parent?: { key?: string } | null;
    created?: string;
    updated?: string;
  };
}

interface SearchResponse {
  issues?: JiraIssue[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

export class JiraConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Jira Cloud projects and issues.';
  readonly capabilities = ['list', 'read', 'search', 'create', 'update', 'delete'] as const;

  readonly #site: AtlassianSite;

  constructor(options: JiraConnectorOptions = {}) {
    this.#site = new AtlassianSite({
      connectorId: CONNECTOR_ID,
      product: 'jira',
      fetch: options.fetch ?? globalThis.fetch,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    // A parent lists that issue's children; otherwise, order by most recent.
    const jql = options.parentId
      ? `parent = ${JSON.stringify(options.parentId)} order by created DESC`
      : 'order by updated DESC';
    return this.#searchJql(context, jql, options.cursor, options.limit);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const issue = await this.#api<JiraIssue>(
      context,
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${FIELDS}`,
    );
    return toResource(issue);
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    // `text ~` searches summary, description and comments — Jira's free-text.
    return this.#searchJql(
      context,
      `text ~ ${JSON.stringify(query)}`,
      options.cursor,
      options.limit,
    );
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const projectKey = draft.metadata?.['projectKey'];
    const issueType = draft.metadata?.['issueType'] ?? 'Task';
    if (typeof projectKey !== 'string') {
      throw new ConnectorError(
        'creating a Jira issue needs metadata.projectKey (which project it goes in)',
        this.id,
      );
    }

    const created = await this.#api<{ key: string }>(context, 'POST', '/rest/api/3/issue', {
      fields: {
        project: { key: projectKey },
        summary: draft.title,
        issuetype: { name: issueType },
        ...(draft.content ? { description: toAdf(draft.content) } : {}),
        ...(draft.parentId ? { parent: { key: draft.parentId } } : {}),
      },
    });
    // Create returns only the key; read it back for the full resource.
    return this.read(context, created.key);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      fields['summary'] = patch.title;
    }
    if (patch.content !== undefined) {
      fields['description'] = toAdf(patch.content);
    }

    // Jira's update returns 204; read the issue back for the updated resource.
    await this.#api(context, 'PUT', `/rest/api/3/issue/${encodeURIComponent(id)}`, { fields });
    return this.read(context, id);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    await this.#api(context, 'DELETE', `/rest/api/3/issue/${encodeURIComponent(id)}`);
  }

  async #searchJql(
    context: ConnectorContext,
    jql: string,
    cursor: string | undefined,
    limit = DEFAULT_LIMIT,
  ): Promise<ResourcePage> {
    const startAt = cursor ? Number(cursor) : 0;
    const params = new URLSearchParams({
      jql,
      fields: FIELDS,
      startAt: String(startAt),
      maxResults: String(limit),
    });
    const body = await this.#api<SearchResponse>(
      context,
      'GET',
      `/rest/api/3/search?${params.toString()}`,
    );

    const issues = body.issues ?? [];
    const next = startAt + issues.length;
    return {
      resources: issues.map(toResource),
      // Jira paginates by offset; a full page implies there may be more.
      nextCursor: next < (body.total ?? next) && issues.length > 0 ? String(next) : null,
    };
  }

  /** A call against the site, mapping a 404 to this connector's not-found. */
  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return await this.#site.request<T>(context, method, path, body);
    } catch (error) {
      if (error instanceof AtlassianNotFound) {
        throw new ResourceNotFoundError(this.id, path);
      }
      throw error;
    }
  }
}

function toResource(issue: JiraIssue): Resource {
  const fields = issue.fields ?? {};
  const description = adfToText(fields.description);
  return {
    // The key (PROJ-123) is what people use; keep the numeric id in metadata.
    id: issue.key,
    type: 'issue',
    title: fields.summary ?? '',
    content: description,
    mimeType: null,
    parentId: fields.parent?.key ?? null,
    url: null,
    metadata: {
      id: issue.id,
      ...(fields.status?.name ? { status: fields.status.name } : {}),
      ...(fields.issuetype?.name ? { issueType: fields.issuetype.name } : {}),
      ...(fields.project?.key ? { projectKey: fields.project.key } : {}),
      ...(fields.assignee?.displayName ? { assignee: fields.assignee.displayName } : {}),
    },
    createdAt: fields.created ? new Date(fields.created) : null,
    updatedAt: fields.updated ? new Date(fields.updated) : null,
  };
}

/**
 * Wrap plain text in a minimal Atlassian Document Format value.
 *
 * Jira v3 takes rich ADF, not a string. The harness's content is text, so it
 * becomes a single paragraph; a product needing rich structure builds the ADF
 * itself and passes it through — but text is the common case.
 */
function toAdf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Flatten an ADF document back to plain text, best effort.
 *
 * Walks the node tree collecting `text` nodes, joining block-level nodes with
 * newlines. Enough to read an issue; a product that needs the structure reads
 * the raw description itself.
 */
function adfToText(node: unknown): string | null {
  if (node === null || node === undefined) {
    return null;
  }
  const text = collectText(node).trim();
  return text === '' ? null : text;
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem']);

function collectText(node: unknown): string {
  if (typeof node !== 'object' || node === null) {
    return '';
  }
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && typeof n.text === 'string') {
    return n.text;
  }

  const inner = (n.content ?? []).map(collectText).join('');
  return n.type && BLOCK_TYPES.has(n.type) ? `${inner}\n` : inner;
}
