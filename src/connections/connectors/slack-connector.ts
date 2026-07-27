// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Slack, covering channels and messages.
 *
 * One connection (one token) reaches both, so this is one connector with two
 * resource kinds, routed by a discriminator in the id — the same multi-type
 * shape the GitHub connector uses. A channel is a container you browse into; a
 * message is a resource inside it:
 *  - a channel id is `channel:C123`
 *  - a message id is `message:C123:1699999999.000100` (channel + Slack `ts`)
 *
 * Channels are read-only here (list, read) — creating or archiving them is out
 * of this slice. Messages are full: list a channel's history, read one, post,
 * edit and delete. A message's container is its channel, so `parentId` is the
 * channel's resource id, and listing a channel's messages takes that (or the
 * bare channel id) as the parent.
 *
 * Nothing product-domain here: a Slack message is a record the same in a
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

const CONNECTOR_ID = 'slack';
const SLACK_API = 'https://slack.com/api';
const DEFAULT_LIMIT = 25;
const CHANNEL_PREFIX = 'channel:';
const MESSAGE_PREFIX = 'message:';
// Slack maps a missing channel or message to these error strings.
const NOT_FOUND_ERRORS = new Set(['channel_not_found', 'message_not_found', 'thread_not_found']);

export interface SlackConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_channel?: boolean;
  created?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
  num_members?: number;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  edited?: { ts?: string };
}

interface SlackMatch extends SlackMessage {
  channel?: { id?: string; name?: string };
  permalink?: string;
}

/** A resource id decoded into which kind it names and its Slack coordinates. */
type Ref =
  | { readonly kind: 'channel'; readonly channel: string }
  | { readonly kind: 'message'; readonly channel: string; readonly ts: string };

export class SlackConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Slack channels and messages across a workspace.';
  // Channels are read-only; the write capabilities are for messages. The
  // connector rejects a write against a channel id with a clear error.
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

  constructor(options: SlackConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? SLACK_API;
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    return options.type === 'message'
      ? this.#listMessages(context, options)
      : this.#listChannels(context, options);
  }

  // async so a parse failure surfaces as a rejected promise, not a throw.
  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    return ref.kind === 'channel'
      ? this.#readChannel(context, ref.channel)
      : this.#readMessage(context, ref.channel, ref.ts);
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    const page = options.cursor ? Number(options.cursor) : 1;
    const count = options.limit ?? DEFAULT_LIMIT;
    const body = await this.#get<{
      messages?: {
        matches?: SlackMatch[];
        paging?: { pages?: number; page?: number };
      };
    }>(context, 'search.messages', { query, count: String(count), page: String(page) });

    const matches = body.messages?.matches ?? [];
    const pages = body.messages?.paging?.pages ?? page;
    return {
      resources: matches.map(matchToResource),
      nextCursor: page < pages ? String(page + 1) : null,
    };
  }

  create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type === 'channel') {
      throw new ConnectorError('creating a Slack channel is not supported', this.id);
    }
    return this.#postMessage(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseRef(id);
    if (ref.kind !== 'message') {
      throw new ConnectorError('a Slack channel cannot be edited', this.id);
    }
    if (patch.content === undefined) {
      throw new ConnectorError('editing a Slack message needs new content', this.id);
    }
    const body = await this.#post<{ ts: string; channel: string; text?: string }>(
      context,
      'chat.update',
      { channel: ref.channel, ts: ref.ts, text: patch.content },
    );
    return messageToResource({ ts: body.ts, text: body.text ?? patch.content }, ref.channel);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    const ref = parseRef(id);
    if (ref.kind !== 'message') {
      throw new ConnectorError('a Slack channel cannot be deleted', this.id);
    }
    await this.#post(context, 'chat.delete', { channel: ref.channel, ts: ref.ts });
  }

  // --- channels -------------------------------------------------------------

  async #listChannels(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const params: Record<string, string> = { limit: String(options.limit ?? DEFAULT_LIMIT) };
    if (options.cursor) {
      params['cursor'] = options.cursor;
    }
    const body = await this.#get<{
      channels?: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>(context, 'conversations.list', params);

    return {
      resources: (body.channels ?? []).map(channelToResource),
      nextCursor: cursorOrNull(body.response_metadata?.next_cursor),
    };
  }

  async #readChannel(context: ConnectorContext, channel: string): Promise<Resource> {
    const body = await this.#get<{ channel?: SlackChannel }>(context, 'conversations.info', {
      channel,
    });
    if (!body.channel) {
      throw new ResourceNotFoundError(this.id, `${CHANNEL_PREFIX}${channel}`);
    }
    return channelToResource(body.channel);
  }

  // --- messages -------------------------------------------------------------

  async #listMessages(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    if (!options.parentId) {
      throw new ConnectorError('listing Slack messages needs a parent (a channel id)', this.id);
    }
    const channel = channelFromParent(options.parentId);
    const params: Record<string, string> = {
      channel,
      limit: String(options.limit ?? DEFAULT_LIMIT),
    };
    if (options.cursor) {
      params['cursor'] = options.cursor;
    }
    const body = await this.#get<{
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
    }>(context, 'conversations.history', params);

    return {
      resources: (body.messages ?? []).map((message) => messageToResource(message, channel)),
      nextCursor: cursorOrNull(body.response_metadata?.next_cursor),
    };
  }

  async #readMessage(context: ConnectorContext, channel: string, ts: string): Promise<Resource> {
    // Slack has no "get one message"; ask history for the single message at ts.
    const body = await this.#get<{ messages?: SlackMessage[] }>(context, 'conversations.history', {
      channel,
      latest: ts,
      oldest: ts,
      inclusive: 'true',
      limit: '1',
    });
    const message = body.messages?.[0];
    if (!message || message.ts !== ts) {
      throw new ResourceNotFoundError(this.id, `${MESSAGE_PREFIX}${channel}:${ts}`);
    }
    return messageToResource(message, channel);
  }

  async #postMessage(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const channelRef = draft.metadata?.['channel'] ?? draft.parentId;
    if (typeof channelRef !== 'string') {
      throw new ConnectorError(
        'posting a Slack message needs metadata.channel or a parentId (the channel)',
        this.id,
      );
    }
    const channel = channelFromParent(channelRef);
    const text = draft.content ?? draft.title;
    const body = await this.#post<{ ts: string; message?: SlackMessage }>(
      context,
      'chat.postMessage',
      {
        channel,
        text,
        ...(typeof draft.metadata?.['threadTs'] === 'string'
          ? { thread_ts: draft.metadata['threadTs'] }
          : {}),
      },
    );
    return messageToResource(body.message ?? { ts: body.ts, text }, channel);
  }

  // --- transport ------------------------------------------------------------

  async #get<T>(
    context: ConnectorContext,
    method: string,
    params: Record<string, string>,
  ): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const response = await this.#fetch(`${this.#apiBase}/${method}?${query}`, {
      headers: { authorization: `Bearer ${this.#accessToken(context)}` },
    });
    return this.#unwrap<T>(response, method);
  }

  async #post<T>(
    context: ConnectorContext,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#accessToken(context)}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    return this.#unwrap<T>(response, method);
  }

  /** Slack returns 200 with `{ ok: false, error }` for logical failures. */
  async #unwrap<T>(response: Response, method: string): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `slack ${method} responded ${response.status}: ${text.slice(0, 300)}`,
        this.id,
      );
    }
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      if (body.error && NOT_FOUND_ERRORS.has(body.error)) {
        throw new ResourceNotFoundError(this.id, `${method}: ${body.error}`);
      }
      throw new ConnectorError(`slack ${method} error: ${body.error ?? 'unknown'}`, this.id);
    }
    return body as T;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('slack connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function channelToResource(channel: SlackChannel): Resource {
  const content = channel.purpose?.value || channel.topic?.value || null;
  return {
    id: `${CHANNEL_PREFIX}${channel.id}`,
    type: 'channel',
    title: channel.name ?? channel.id,
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: null,
    url: null,
    metadata: {
      channel: channel.id,
      ...(channel.name ? { name: channel.name } : {}),
      ...(typeof channel.is_private === 'boolean' ? { isPrivate: channel.is_private } : {}),
      ...(typeof channel.num_members === 'number' ? { memberCount: channel.num_members } : {}),
      ...(channel.topic?.value ? { topic: channel.topic.value } : {}),
    },
    createdAt: channel.created ? new Date(channel.created * 1000) : null,
    updatedAt: null,
  };
}

function messageToResource(message: SlackMessage, channel: string): Resource {
  const text = message.text ?? '';
  return {
    id: `${MESSAGE_PREFIX}${channel}:${message.ts}`,
    type: 'message',
    title: messageTitle(text, message.ts),
    content: message.text ?? null,
    mimeType: message.text === undefined ? null : 'text/plain',
    parentId: `${CHANNEL_PREFIX}${channel}`,
    url: null,
    metadata: {
      channel,
      ts: message.ts,
      ...(message.user ? { author: message.user } : {}),
      ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
    },
    createdAt: tsToDate(message.ts),
    updatedAt: message.edited?.ts ? tsToDate(message.edited.ts) : null,
  };
}

function matchToResource(match: SlackMatch): Resource {
  const channel = match.channel?.id ?? '';
  const resource = messageToResource(match, channel);
  return match.permalink ? { ...resource, url: match.permalink } : resource;
}

/** A Slack message has no title; use its first line, trimmed, or its ts. */
function messageTitle(text: string, ts: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') {
    return `message ${ts}`;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/** A Slack `ts` is `seconds.micros`; turn it into a Date. */
function tsToDate(ts: string): Date | null {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

// --- id helpers -------------------------------------------------------------

function parseRef(id: string): Ref {
  if (id.startsWith(CHANNEL_PREFIX)) {
    const channel = id.slice(CHANNEL_PREFIX.length);
    if (channel === '') {
      throw invalidId(id);
    }
    return { kind: 'channel', channel };
  }
  if (id.startsWith(MESSAGE_PREFIX)) {
    const rest = id.slice(MESSAGE_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon <= 0 || colon === rest.length - 1) {
      throw invalidId(id);
    }
    return { kind: 'message', channel: rest.slice(0, colon), ts: rest.slice(colon + 1) };
  }
  throw invalidId(id);
}

/** A parent may be a channel resource id (`channel:C123`) or the bare id. */
function channelFromParent(parentId: string): string {
  return parentId.startsWith(CHANNEL_PREFIX) ? parentId.slice(CHANNEL_PREFIX.length) : parentId;
}

function cursorOrNull(cursor: string | undefined): string | null {
  return cursor && cursor !== '' ? cursor : null;
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Slack id "${id}"; expected "channel:C123" or "message:C123:ts"`,
    CONNECTOR_ID,
  );
}
