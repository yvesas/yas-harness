// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One resource kind inside the GitHub connector.
 *
 * GitHub is one connection (one OAuth token) reaching several different things:
 * issues, discussions, projects and code. They share a token and a resource
 * shape and share almost nothing else — two APIs, four id formats, and four
 * different answers to what "create" means.
 *
 * So each kind implements this, and `GitHubConnector` only routes: an id's
 * prefix picks the kind for a read or a write, `options.type` / `draft.type`
 * picks it for a listing or a creation. The methods are optional and
 * `capabilities` declares which exist — the same contract `Connector` itself
 * uses, one level down, so a kind that supports less says so instead of
 * failing later with a message about something else.
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

/** The connector these kinds belong to; on every error they raise. */
export const CONNECTOR_ID = 'github';

/** How many resources a page holds when the caller does not say. */
export const DEFAULT_LIMIT = 25;

export interface GitHubKind {
  /** The kind's own word, as it appears in `options.type` and `draft.type`. */
  readonly name: string;
  /**
   * The id prefix this kind owns, e.g. `"project:"`.
   *
   * Empty for issues, which are the bare `owner/repo#number` form — so an id
   * that matches no prefix is an issue, and the dispatcher needs no default
   * beyond "the kind whose prefix is empty".
   */
  readonly prefix: string;
  readonly capabilities: readonly ConnectorCapability[];
  /**
   * What to say when this kind is asked for a capability it does not declare.
   *
   * Optional: the dispatcher's default names the kind and the operation, which
   * is enough when the reason is obvious. A kind sets this when the honest
   * answer is a sentence rather than a fact — code being read-only is not a
   * gap somebody should try to route around, it is where this slice stops.
   */
  readonly refusal?: string;

  list?(context: ConnectorContext, options: ListOptions): Promise<ResourcePage>;
  read?(context: ConnectorContext, id: string): Promise<Resource>;
  search?(context: ConnectorContext, query: string, options: SearchOptions): Promise<ResourcePage>;
  create?(context: ConnectorContext, draft: ResourceDraft): Promise<Resource>;
  update?(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource>;
  delete?(context: ConnectorContext, id: string): Promise<void>;
}
