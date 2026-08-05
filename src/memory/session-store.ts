// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: where conversation state lives.
 *
 * The agent loop holds no history of its own — it reads a session, appends to
 * it and moves on. That is what lets a conversation survive a restart, and
 * what lets the core be tested without a database.
 */

import type { ModelMessage } from '../models/model-gateway.js';

export interface Session {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly createdAt: Date;
}

/** A stored turn: a model message plus what the store knows about it. */
export interface StoredMessage extends ModelMessage {
  readonly id: string;
  readonly createdAt: Date;
}

export interface CreateSessionInput {
  readonly tenantId: string;
  readonly personaId: string;
}

/**
 * Every method takes `tenantId` because tenant scoping is not optional: there
 * is no "fetch this session" that skips the isolation check.
 */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  find(tenantId: string, sessionId: string): Promise<Session | null>;
  /** Conversation history, oldest first. */
  messages(tenantId: string, sessionId: string): Promise<StoredMessage[]>;
  append(tenantId: string, sessionId: string, messages: readonly ModelMessage[]): Promise<void>;
  /**
   * A tenant's conversations, most recent first.
   *
   * `find` answers about a session whose id you already hold, which is only
   * true of the one you just created. Anything that lets a person come back —
   * a console, an inbox, a support view — starts from "which conversations are
   * there", and there was no way to ask.
   *
   * Ordered by last activity rather than creation, because a conversation
   * someone replied to this morning is more relevant than one opened last week
   * and abandoned.
   */
  list(tenantId: string, options?: ListSessionsQuery): Promise<SessionSummary[]>;
}

export interface ListSessionsQuery {
  readonly limit?: number;
}

/** One conversation, as a list of them shows it. */
export interface SessionSummary extends Session {
  readonly messages: number;
  /** When something was last said. Equal to `createdAt` for an empty session. */
  readonly lastActivityAt: Date;
}

/** How many conversations a listing returns unless told otherwise. */
export const DEFAULT_SESSION_LIMIT = 30;

export class SessionNotFoundError extends Error {
  constructor(tenantId: string, sessionId: string) {
    super(`session "${sessionId}" not found for tenant "${tenantId}"`);
    this.name = 'SessionNotFoundError';
  }
}
