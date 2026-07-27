// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Microsoft Teams, via the Microsoft Graph API.
 *
 * One connection reaches the whole hierarchy — teams, their channels, and the
 * messages in a channel — so this is one connector with three resource kinds,
 * routed by a discriminator in the id:
 *  - a team id is `team:<teamId>`
 *  - a channel id is `channel:<teamId>:<channelId>`
 *  - a message id is `message:<teamId>:<channelId>:<messageId>`
 *
 * A channel and a message need their whole path (a message lives in a channel,
 * which lives in a team), so those ids carry it. Graph channel ids themselves
 * contain colons and an `@` (e.g. `19:abc@thread.tacv2`); the id is still
 * unambiguous because the team id is a GUID and the message id is numeric, so
 * the team is the first segment and the message the last, with the channel id
 * (colons and all) in between.
 *
 * Teams and channels are read-only (list, read). Messages can be listed, read
 * and posted — Graph v1.0 does not offer editing or deleting a channel message
 * over the API, so the connector does not declare `update` or `delete`; it
 * exposes only what the source supports. `list` browses down the hierarchy:
 * no parent lists teams, a team lists its channels, a channel lists its
 * messages.
 *
 * Nothing product-domain here: a Teams message is a record the same in a
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
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'teams';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const DEFAULT_LIMIT = 25;
const TEAM_PREFIX = 'team:';
const CHANNEL_PREFIX = 'channel:';
const MESSAGE_PREFIX = 'message:';

export interface TeamsConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the Graph API base; only for tests. */
  readonly baseUrl?: string;
}

interface GraphTeam {
  id: string;
  displayName?: string;
  description?: string;
}

interface GraphChannel {
  id: string;
  displayName?: string;
  description?: string;
  webUrl?: string;
  membershipType?: string;
}

interface GraphMessage {
  id: string;
  subject?: string | null;
  body?: { content?: string; contentType?: string };
  from?: { user?: { displayName?: string } | null } | null;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

interface GraphList<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

type Ref =
  | { readonly kind: 'team'; readonly teamId: string }
  | { readonly kind: 'channel'; readonly teamId: string; readonly channelId: string }
  | {
      readonly kind: 'message';
      readonly teamId: string;
      readonly channelId: string;
      readonly messageId: string;
    };

export class TeamsConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Microsoft Teams teams, channels and messages.';
  // Teams and channels are read-only; messages can be posted. Graph v1.0 does
  // not offer editing or deleting a channel message, so neither is declared.
  readonly capabilities: readonly ConnectorCapability[] = ['list', 'read', 'create'];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: TeamsConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? GRAPH_API;
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    if (options.type === 'channel') return this.#listChannels(context, options);
    if (options.type === 'message') return this.#listMessages(context, options);
    return this.#listTeams(context, options);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    if (ref.kind === 'team') {
      return teamToResource(await this.#api<GraphTeam>(context, 'GET', `/teams/${ref.teamId}`));
    }
    if (ref.kind === 'channel') {
      const channel = await this.#api<GraphChannel>(
        context,
        'GET',
        `/teams/${ref.teamId}/channels/${ref.channelId}`,
      );
      return channelToResource(channel, ref.teamId);
    }
    const message = await this.#api<GraphMessage>(
      context,
      'GET',
      `/teams/${ref.teamId}/channels/${ref.channelId}/messages/${ref.messageId}`,
    );
    return messageToResource(message, ref.teamId, ref.channelId);
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type && draft.type !== 'message') {
      throw new ConnectorError(`Teams cannot create a "${draft.type}"; only a message`, this.id);
    }
    return this.#postMessage(context, draft);
  }

  // --- teams ----------------------------------------------------------------

  async #listTeams(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const body = await this.#api<GraphList<GraphTeam>>(
      context,
      'GET',
      `/me/joinedTeams?${pageQuery(options)}`,
    );
    return {
      resources: (body.value ?? []).map(teamToResource),
      nextCursor: nextCursor(body),
    };
  }

  // --- channels -------------------------------------------------------------

  async #listChannels(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    if (!options.parentId) {
      throw new ConnectorError('listing Teams channels needs a parent (a team id)', this.id);
    }
    const teamId = teamIdFromParent(options.parentId);
    const body = await this.#api<GraphList<GraphChannel>>(
      context,
      'GET',
      `/teams/${teamId}/channels?${pageQuery(options)}`,
    );
    return {
      resources: (body.value ?? []).map((channel) => channelToResource(channel, teamId)),
      nextCursor: nextCursor(body),
    };
  }

  // --- messages -------------------------------------------------------------

  async #listMessages(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    if (!options.parentId) {
      throw new ConnectorError('listing Teams messages needs a parent (a channel id)', this.id);
    }
    const parent = parseRef(options.parentId);
    if (parent.kind !== 'channel') {
      throw new ConnectorError(
        'listing Teams messages needs a channel parent ("channel:<teamId>:<channelId>")',
        this.id,
      );
    }
    const body = await this.#api<GraphList<GraphMessage>>(
      context,
      'GET',
      `/teams/${parent.teamId}/channels/${parent.channelId}/messages?${pageQuery(options)}`,
    );
    return {
      resources: (body.value ?? []).map((message) =>
        messageToResource(message, parent.teamId, parent.channelId),
      ),
      nextCursor: nextCursor(body),
    };
  }

  async #postMessage(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const parentRef = draft.parentId ?? draft.metadata?.['channel'];
    if (typeof parentRef !== 'string') {
      throw new ConnectorError(
        'posting a Teams message needs a parentId ("channel:<teamId>:<channelId>")',
        this.id,
      );
    }
    const parent = parseRef(parentRef);
    if (parent.kind !== 'channel') {
      throw new ConnectorError('posting a Teams message needs a channel parent', this.id);
    }
    const content = draft.content ?? draft.title;
    const message = await this.#api<GraphMessage>(
      context,
      'POST',
      `/teams/${parent.teamId}/channels/${parent.channelId}/messages`,
      {
        ...(draft.title && draft.content ? { subject: draft.title } : {}),
        body: { content, contentType: 'text' },
      },
    );
    return messageToResource(message, parent.teamId, parent.channelId);
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
        `teams responded ${response.status}: ${text.slice(0, 300)}`,
        this.id,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('teams connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function teamToResource(team: GraphTeam): Resource {
  const content = team.description ?? null;
  return {
    id: `${TEAM_PREFIX}${team.id}`,
    type: 'team',
    title: team.displayName ?? team.id,
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: null,
    url: null,
    metadata: { teamId: team.id },
    createdAt: null,
    updatedAt: null,
  };
}

function channelToResource(channel: GraphChannel, teamId: string): Resource {
  const content = channel.description ?? null;
  return {
    id: `${CHANNEL_PREFIX}${teamId}:${channel.id}`,
    type: 'channel',
    title: channel.displayName ?? channel.id,
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: `${TEAM_PREFIX}${teamId}`,
    url: channel.webUrl ?? null,
    metadata: {
      teamId,
      channelId: channel.id,
      ...(channel.membershipType ? { membershipType: channel.membershipType } : {}),
    },
    createdAt: null,
    updatedAt: null,
  };
}

function messageToResource(message: GraphMessage, teamId: string, channelId: string): Resource {
  const content = message.body?.content ?? null;
  const isHtml = message.body?.contentType === 'html';
  return {
    id: `${MESSAGE_PREFIX}${teamId}:${channelId}:${message.id}`,
    type: 'message',
    title: messageTitle(message, isHtml),
    content,
    mimeType: content === null ? null : isHtml ? 'text/html' : 'text/plain',
    parentId: `${CHANNEL_PREFIX}${teamId}:${channelId}`,
    url: message.webUrl ?? null,
    metadata: {
      teamId,
      channelId,
      messageId: message.id,
      ...(message.from?.user?.displayName ? { author: message.from.user.displayName } : {}),
    },
    createdAt: message.createdDateTime ? new Date(message.createdDateTime) : null,
    updatedAt: message.lastModifiedDateTime ? new Date(message.lastModifiedDateTime) : null,
  };
}

/**
 * A Teams message's title. Prefer its subject; otherwise take a snippet of a
 * plain-text body. An HTML body is not parsed for a title — stripping tags is
 * not sanitization, and the snippet would only feed a title anyway — so an
 * HTML message with no subject falls back to its id. The full body is kept in
 * `content` untouched regardless.
 */
function messageTitle(message: GraphMessage, isHtml: boolean): string {
  if (message.subject) {
    return message.subject;
  }
  if (!isHtml) {
    const firstLine = (message.body?.content ?? '').split('\n', 1)[0]?.trim() ?? '';
    if (firstLine !== '') {
      return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    }
  }
  return `message ${message.id}`;
}

// --- query helpers ----------------------------------------------------------

function pageQuery(options: ListOptions): string {
  const params = new URLSearchParams({ $top: String(options.limit ?? DEFAULT_LIMIT) });
  if (options.cursor) {
    params.set('$skiptoken', options.cursor);
  }
  return params.toString();
}

/** Graph pages with an opaque `@odata.nextLink`; carry its `$skiptoken`. */
function nextCursor(body: GraphList<unknown>): string | null {
  const next = body['@odata.nextLink'];
  if (!next) {
    return null;
  }
  try {
    return new URL(next).searchParams.get('$skiptoken');
  } catch {
    return null;
  }
}

// --- id helpers -------------------------------------------------------------

function parseRef(id: string): Ref {
  if (id.startsWith(TEAM_PREFIX)) {
    const teamId = id.slice(TEAM_PREFIX.length);
    if (teamId === '') throw invalidId(id);
    return { kind: 'team', teamId };
  }
  if (id.startsWith(CHANNEL_PREFIX)) {
    const rest = id.slice(CHANNEL_PREFIX.length);
    // The team id is a GUID (no colon); the channel id is the rest (may hold
    // colons and an @).
    const colon = rest.indexOf(':');
    if (colon <= 0 || colon === rest.length - 1) throw invalidId(id);
    return { kind: 'channel', teamId: rest.slice(0, colon), channelId: rest.slice(colon + 1) };
  }
  if (id.startsWith(MESSAGE_PREFIX)) {
    const rest = id.slice(MESSAGE_PREFIX.length);
    // Team is the first segment, message the last (both colon-free); the channel
    // id — which itself contains colons — is everything in between.
    const first = rest.indexOf(':');
    const last = rest.lastIndexOf(':');
    if (first <= 0 || last <= first || last === rest.length - 1) throw invalidId(id);
    return {
      kind: 'message',
      teamId: rest.slice(0, first),
      channelId: rest.slice(first + 1, last),
      messageId: rest.slice(last + 1),
    };
  }
  throw invalidId(id);
}

/** A team parent may be a resource id (`team:<id>`) or the bare team id. */
function teamIdFromParent(parentId: string): string {
  return parentId.startsWith(TEAM_PREFIX) ? parentId.slice(TEAM_PREFIX.length) : parentId;
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Teams id "${id}"; expected "team:<id>", "channel:<teamId>:<channelId>" or "message:<teamId>:<channelId>:<messageId>"`,
    CONNECTOR_ID,
  );
}
