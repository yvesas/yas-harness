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
}

export class SessionNotFoundError extends Error {
  constructor(tenantId: string, sessionId: string) {
    super(`session "${sessionId}" not found for tenant "${tenantId}"`);
    this.name = 'SessionNotFoundError';
  }
}
