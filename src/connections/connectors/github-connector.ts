// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for GitHub, covering issues, discussions, projects and code.
 *
 * One connection (one OAuth token) reaches them all, so this is one connector
 * with several resource kinds. A product sees one `github` connector and the
 * same resource shape for everything; which kind answers is decided here and
 * nowhere else.
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
 * **This file routes; it does not talk to GitHub.** Each kind lives in its own
 * module beside this one and declares what it supports, so an operation a kind
 * does not implement is refused here — by name, from the same table the routing
 * uses — rather than discovered as a confusing failure inside it. Adding a kind
 * is a new module and one entry below, with nothing existing edited.
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
import { ConnectorError } from '../connector.js';

import { GitHubApi } from './github-api.js';
import { CodeKind } from './github-code.js';
import { DiscussionKind } from './github-discussions.js';
import { IssueKind } from './github-issues.js';
import type { GitHubKind } from './github-kind.js';
import { CONNECTOR_ID } from './github-kind.js';
import { ProjectKind } from './github-projects.js';

/** The order `capabilities` is reported in, so the union below reads stably. */
const CAPABILITY_ORDER: readonly ConnectorCapability[] = [
  'list',
  'read',
  'search',
  'create',
  'update',
  'delete',
];

export interface GitHubConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

export class GitHubConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description =
    'GitHub issues, discussions, projects and code across a user’s repositories and orgs.';
  /**
   * What any kind can do — computed, not written down.
   *
   * Declaring this by hand is how it drifts: a kind gains an operation and the
   * connector still says it cannot, or loses one and the manager lets the call
   * through to fail further in. No kind deletes today, so neither does this.
   */
  readonly capabilities: readonly ConnectorCapability[];

  readonly #kinds: readonly GitHubKind[];
  /** The kind for an id that matches no prefix, and for an unnamed type. */
  readonly #fallback: GitHubKind;

  constructor(options: GitHubConnectorOptions = {}) {
    const api = new GitHubApi({
      connectorId: CONNECTOR_ID,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });

    const issues = new IssueKind(api);
    this.#fallback = issues;
    this.#kinds = [issues, new DiscussionKind(api), new ProjectKind(api), new CodeKind(api)];
    this.capabilities = CAPABILITY_ORDER.filter((capability) =>
      this.#kinds.some((kind) => kind.capabilities.includes(capability)),
    );
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    const kind = this.#named(options.type);
    this.#require(kind, 'list');
    return kind.list!(context, options);
  }

  // async so a refused kind or a parse failure surfaces as a rejected promise,
  // not a throw.
  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const kind = this.#addressed(id);
    this.#require(kind, 'read');
    return kind.read!(context, id);
  }

  /**
   * Search covers issues. Discussion and code search are later slices — the
   * shape's `search` has no type selector to tell them apart yet, so this does
   * not route: it asks the kind that can answer.
   */
  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    this.#require(this.#fallback, 'search');
    return this.#fallback.search!(context, query, options);
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const kind = this.#named(draft.type);
    this.#require(kind, 'create');
    return kind.create!(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const kind = this.#addressed(id);
    this.#require(kind, 'update');
    return kind.update!(context, id, patch);
  }

  /** The kind a caller asked for by name, or the one an unnamed type means. */
  #named(type: string | undefined): GitHubKind {
    return this.#kinds.find((kind) => kind.name === type) ?? this.#fallback;
  }

  /** The kind an id names, by its prefix. No prefix matches: an issue. */
  #addressed(id: string): GitHubKind {
    return (
      this.#kinds.find((kind) => kind.prefix !== '' && id.startsWith(kind.prefix)) ?? this.#fallback
    );
  }

  /**
   * Refuse an operation the kind does not implement.
   *
   * The `!` on each call site above is what this makes safe — the same shape
   * `ConnectionManager` uses one level up, for the same reason: the check and
   * the call are one line apart, and the alternative is six interfaces.
   */
  #require(kind: GitHubKind, capability: ConnectorCapability): void {
    if (kind.capabilities.includes(capability)) {
      return;
    }
    throw new ConnectorError(
      kind.refusal ?? `GitHub ${kind.name} does not support "${capability}"`,
      this.id,
    );
  }
}
