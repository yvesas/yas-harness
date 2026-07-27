// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Notion, covering pages and databases.
 *
 * One connection reaches both, so this is one connector with two resource
 * kinds, routed by a discriminator in the id — the multi-type shape GitHub and
 * Slack use:
 *  - a page id is `page:<uuid>`
 *  - a database id is `database:<uuid>`
 *
 * Notion is block-based, and this connector treats a page's body as text, the
 * same trade Jira makes with the Atlassian document format: reading flattens
 * the page's blocks to text (headings, lists and quotes rendered with light
 * Markdown), and writing turns text back into paragraph blocks. Rich blocks
 * (tables, toggles, embeds) flatten to their text on read and are not preserved
 * on write — a text-shaped view of a page, not a faithful block editor. Setting
 * a page's content replaces its blocks; deep nesting is not recursed.
 *
 * A database is a container: listing it queries its pages. Delete archives
 * (Notion's trash), matching the contract's delete. Nothing product-domain
 * here: a Notion page is a document, the same in a language tutor and a CRM.
 * Written against `fetch`; no dependency.
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

const CONNECTOR_ID = 'notion';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DEFAULT_LIMIT = 25;
const PAGE_PREFIX = 'page:';
const DATABASE_PREFIX = 'database:';
// A page can hold many blocks; page through them but do not run away.
const MAX_BLOCK_PAGES = 10;

export interface NotionConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

interface RichText {
  plain_text?: string;
  text?: { content?: string };
}

interface NotionParent {
  type?: string;
  database_id?: string;
  page_id?: string;
  workspace?: boolean;
}

interface NotionProperty {
  type?: string;
  title?: RichText[];
}

interface NotionPage {
  object?: 'page';
  id: string;
  url?: string;
  archived?: boolean;
  parent?: NotionParent;
  properties?: Record<string, NotionProperty>;
  created_time?: string;
  last_edited_time?: string;
}

interface NotionDatabase {
  object?: 'database';
  id: string;
  url?: string;
  archived?: boolean;
  parent?: NotionParent;
  title?: RichText[];
  description?: RichText[];
  properties?: Record<string, NotionProperty>;
  created_time?: string;
  last_edited_time?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface Ref {
  readonly kind: 'page' | 'database';
  readonly id: string;
}

export class NotionConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Notion pages and databases across a workspace.';
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
    'delete',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: NotionConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? NOTION_API;
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    // A parent database is queried for its pages; without one, search with no
    // query returns everything the integration can see (pages and databases).
    if (options.parentId) {
      return this.#queryDatabase(context, parseRef(options.parentId).id, options);
    }
    return this.#searchAll(context, undefined, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    return ref.kind === 'database'
      ? databaseToResource(await this.#getDatabase(context, ref.id))
      : this.#readPage(context, ref.id);
  }

  search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    return this.#searchAll(context, query, options);
  }

  create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type === 'database') {
      throw new ConnectorError('creating a Notion database is not supported', this.id);
    }
    return this.#createPage(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseRef(id);
    return ref.kind === 'database'
      ? this.#updateDatabase(context, ref.id, patch)
      : this.#updatePage(context, ref.id, patch);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    const ref = parseRef(id);
    const path = ref.kind === 'database' ? `/databases/${ref.id}` : `/pages/${ref.id}`;
    // Notion has no hard delete over the API; archiving is its trash.
    await this.#api(context, 'PATCH', path, { archived: true });
  }

  // --- pages ----------------------------------------------------------------

  async #readPage(context: ConnectorContext, id: string): Promise<Resource> {
    const page = await this.#api<NotionPage>(context, 'GET', `/pages/${id}`);
    const content = await this.#pageText(context, id);
    return pageToResource(page, content);
  }

  async #createPage(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const parentRef = draft.parentId ?? draft.metadata?.['parent'];
    if (typeof parentRef !== 'string') {
      throw new ConnectorError(
        'creating a Notion page needs a parentId ("database:<id>" or "page:<id>")',
        this.id,
      );
    }
    const parent = parseRef(parentRef);

    let body: Record<string, unknown>;
    if (parent.kind === 'database') {
      // A page in a database is keyed by that database's title property, whose
      // name is the database's to choose — resolve it, do not assume "Name".
      const database = await this.#getDatabase(context, parent.id);
      const titleKey = titlePropertyKey(database.properties) ?? 'title';
      body = {
        parent: { database_id: parent.id },
        properties: { [titleKey]: { title: toRichText(draft.title) } },
      };
    } else {
      body = {
        parent: { page_id: parent.id },
        properties: { title: { title: toRichText(draft.title) } },
      };
    }
    if (draft.content) {
      body['children'] = textToBlocks(draft.content);
    }

    const created = await this.#api<NotionPage>(context, 'POST', '/pages', body);
    return pageToResource(created, draft.content ?? null);
  }

  async #updatePage(
    context: ConnectorContext,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource> {
    if (patch.title !== undefined) {
      const page = await this.#api<NotionPage>(context, 'GET', `/pages/${id}`);
      const titleKey = titlePropertyKey(page.properties) ?? 'title';
      await this.#api(context, 'PATCH', `/pages/${id}`, {
        properties: { [titleKey]: { title: toRichText(patch.title) } },
      });
    }
    if (patch.content !== undefined) {
      await this.#replaceContent(context, id, patch.content);
    }
    return this.#readPage(context, id);
  }

  /** Read a page's body: page through its child blocks and flatten to text. */
  async #pageText(context: ConnectorContext, id: string): Promise<string> {
    const blocks = await this.#childBlocks(context, id);
    return blocksToText(blocks);
  }

  /** Replace a page's blocks with paragraphs from `content` (set, not append). */
  async #replaceContent(context: ConnectorContext, id: string, content: string): Promise<void> {
    const existing = await this.#childBlocks(context, id);
    for (const block of existing) {
      await this.#api(context, 'DELETE', `/blocks/${block.id}`);
    }
    const children = textToBlocks(content);
    if (children.length > 0) {
      await this.#api(context, 'PATCH', `/blocks/${id}/children`, { children });
    }
  }

  async #childBlocks(context: ConnectorContext, id: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (cursor) query.set('start_cursor', cursor);
      const body = await this.#api<{
        results?: NotionBlock[];
        next_cursor?: string | null;
        has_more?: boolean;
      }>(context, 'GET', `/blocks/${id}/children?${query.toString()}`);
      blocks.push(...(body.results ?? []));
      cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
      pages += 1;
    } while (cursor && pages < MAX_BLOCK_PAGES);
    return blocks;
  }

  // --- databases ------------------------------------------------------------

  async #getDatabase(context: ConnectorContext, id: string): Promise<NotionDatabase> {
    return this.#api<NotionDatabase>(context, 'GET', `/databases/${id}`);
  }

  async #queryDatabase(
    context: ConnectorContext,
    id: string,
    options: ListOptions,
  ): Promise<ResourcePage> {
    const body = await this.#api<{
      results?: NotionPage[];
      next_cursor?: string | null;
      has_more?: boolean;
    }>(context, 'POST', `/databases/${id}/query`, {
      page_size: options.limit ?? DEFAULT_LIMIT,
      ...(options.cursor ? { start_cursor: options.cursor } : {}),
    });
    return {
      resources: (body.results ?? []).map((page) => pageToResource(page, null)),
      nextCursor: body.has_more ? (body.next_cursor ?? null) : null,
    };
  }

  async #updateDatabase(
    context: ConnectorContext,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['title'] = toRichText(patch.title);
    if (patch.content !== undefined) body['description'] = toRichText(patch.content);
    const updated = await this.#api<NotionDatabase>(context, 'PATCH', `/databases/${id}`, body);
    return databaseToResource(updated);
  }

  // --- search ---------------------------------------------------------------

  async #searchAll(
    context: ConnectorContext,
    query: string | undefined,
    options: { limit?: number; cursor?: string },
  ): Promise<ResourcePage> {
    const body = await this.#api<{
      results?: (NotionPage | NotionDatabase)[];
      next_cursor?: string | null;
      has_more?: boolean;
    }>(context, 'POST', '/search', {
      ...(query ? { query } : {}),
      page_size: options.limit ?? DEFAULT_LIMIT,
      ...(options.cursor ? { start_cursor: options.cursor } : {}),
    });
    return {
      resources: (body.results ?? []).map((item) =>
        item.object === 'database'
          ? databaseToResource(item)
          : pageToResource(item as NotionPage, null),
      ),
      nextCursor: body.has_more ? (body.next_cursor ?? null) : null,
    };
  }

  // --- transport ------------------------------------------------------------

  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#accessToken(context)}`,
        'notion-version': NOTION_VERSION,
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
        `notion responded ${response.status}: ${text.slice(0, 300)}`,
        this.id,
      );
    }
    // A 204 (no body) can come back from some writes; guard the json parse.
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('notion connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function pageToResource(page: NotionPage, content: string | null): Resource {
  return {
    id: `${PAGE_PREFIX}${page.id}`,
    type: 'page',
    title: pageTitle(page.properties),
    content,
    mimeType: content === null ? null : 'text/markdown',
    parentId: parentToId(page.parent),
    url: page.url ?? null,
    metadata: {
      object: 'page',
      ...(typeof page.archived === 'boolean' ? { archived: page.archived } : {}),
    },
    createdAt: page.created_time ? new Date(page.created_time) : null,
    updatedAt: page.last_edited_time ? new Date(page.last_edited_time) : null,
  };
}

function databaseToResource(database: NotionDatabase): Resource {
  const description = plainText(database.description);
  return {
    id: `${DATABASE_PREFIX}${database.id}`,
    type: 'database',
    title: plainText(database.title) || database.id,
    content: description === '' ? null : description,
    mimeType: description === '' ? null : 'text/markdown',
    parentId: parentToId(database.parent),
    url: database.url ?? null,
    metadata: {
      object: 'database',
      ...(typeof database.archived === 'boolean' ? { archived: database.archived } : {}),
    },
    createdAt: database.created_time ? new Date(database.created_time) : null,
    updatedAt: database.last_edited_time ? new Date(database.last_edited_time) : null,
  };
}

/** A Notion page has no top-level title; it lives in the title-typed property. */
function pageTitle(properties: Record<string, NotionProperty> | undefined): string {
  if (!properties) {
    return '';
  }
  for (const property of Object.values(properties)) {
    if (property.type === 'title') {
      return plainText(property.title);
    }
  }
  return '';
}

function titlePropertyKey(
  properties: Record<string, NotionProperty> | undefined,
): string | undefined {
  if (!properties) {
    return undefined;
  }
  for (const [key, property] of Object.entries(properties)) {
    if (property.type === 'title') {
      return key;
    }
  }
  return undefined;
}

function parentToId(parent: NotionParent | undefined): string | null {
  if (!parent) {
    return null;
  }
  if (parent.database_id) {
    return `${DATABASE_PREFIX}${parent.database_id}`;
  }
  if (parent.page_id) {
    return `${PAGE_PREFIX}${parent.page_id}`;
  }
  return null;
}

function plainText(richText: RichText[] | undefined): string {
  return (richText ?? []).map((part) => part.plain_text ?? part.text?.content ?? '').join('');
}

function toRichText(text: string): RichText[] {
  return [{ text: { content: text } }];
}

// --- block flattening -------------------------------------------------------

/** Flatten a page's top-level blocks to text, with light Markdown for structure. */
function blocksToText(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(blockToLine(block));
  }
  return lines.join('\n');
}

function blockToLine(block: NotionBlock): string {
  const data = block[block.type] as { rich_text?: RichText[]; checked?: boolean } | undefined;
  const text = plainText(data?.rich_text);
  switch (block.type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${data?.checked ? 'x' : ' '}] ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'code':
      return `\`\`\`\n${text}\n\`\`\``;
    default:
      // paragraph and any other text-bearing block: its plain text (or blank).
      return text;
  }
}

/** Turn text into paragraph blocks, one per line, so content round-trips. */
function textToBlocks(text: string): Record<string, unknown>[] {
  return text.split('\n').map((line) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: line === '' ? [] : toRichText(line) },
  }));
}

// --- id helpers -------------------------------------------------------------

function parseRef(id: string): Ref {
  if (id.startsWith(DATABASE_PREFIX)) {
    const notionId = id.slice(DATABASE_PREFIX.length);
    if (notionId === '') throw invalidId(id);
    return { kind: 'database', id: notionId };
  }
  if (id.startsWith(PAGE_PREFIX)) {
    const notionId = id.slice(PAGE_PREFIX.length);
    if (notionId === '') throw invalidId(id);
    return { kind: 'page', id: notionId };
  }
  throw invalidId(id);
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Notion id "${id}"; expected "page:<uuid>" or "database:<uuid>"`,
    CONNECTOR_ID,
  );
}
