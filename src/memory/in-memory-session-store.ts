// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: sessions in process memory.
 *
 * For tests and for running the core without a database. It enforces tenant
 * scoping exactly like the Postgres adapter — a store that is laxer than
 * production would let isolation bugs pass the test suite.
 */

import type { ModelMessage } from '../models/model-gateway.js';

import type {
  CreateSessionInput,
  ListSessionsQuery,
  Session,
  SessionStore,
  SessionSummary,
  StoredMessage,
} from './session-store.js';
import { DEFAULT_SESSION_LIMIT } from './session-store.js';

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #messages = new Map<string, StoredMessage[]>();
  #counter = 0;

  create(input: CreateSessionInput): Promise<Session> {
    this.#counter += 1;
    const session: Session = {
      id: `session-${this.#counter}`,
      tenantId: input.tenantId,
      personaId: input.personaId,
      createdAt: new Date(this.#counter * 1000),
    };
    this.#sessions.set(session.id, session);
    this.#messages.set(session.id, []);
    return Promise.resolve(session);
  }

  find(tenantId: string, sessionId: string): Promise<Session | null> {
    const session = this.#sessions.get(sessionId);
    return Promise.resolve(session && session.tenantId === tenantId ? session : null);
  }

  /**
   * Empty, not an error, when the session is not this tenant's.
   *
   * It matches the Postgres adapter, where the tenant is simply part of the
   * `WHERE` clause and a miss is indistinguishable from an empty conversation.
   * Making this one throw instead would be *stricter* but not more isolating —
   * and an adapter that exists so a product can test without a database is only
   * worth having if the two behave the same. Writing is the opposite case: a
   * cross-tenant append fails on both, because the database refuses the row.
   */
  messages(tenantId: string, sessionId: string): Promise<StoredMessage[]> {
    const session = this.#sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      return Promise.resolve([]);
    }
    return Promise.resolve([...(this.#messages.get(sessionId) ?? [])]);
  }

  async append(
    tenantId: string,
    sessionId: string,
    messages: readonly ModelMessage[],
  ): Promise<void> {
    await this.#assertVisible(tenantId, sessionId);
    const stored = this.#messages.get(sessionId) ?? [];

    for (const message of messages) {
      this.#counter += 1;
      stored.push({
        id: `message-${this.#counter}`,
        role: message.role,
        content: message.content,
        createdAt: new Date(this.#counter * 1000),
      });
    }
    this.#messages.set(sessionId, stored);
  }

  list(tenantId: string, options: ListSessionsQuery = {}): Promise<SessionSummary[]> {
    const summaries = [...this.#sessions.values()]
      .filter((session) => session.tenantId === tenantId)
      .map((session) => {
        const stored = this.#messages.get(session.id) ?? [];
        return {
          ...session,
          messages: stored.length,
          // An empty conversation has never been spoken in, so its creation is
          // the only activity there is.
          lastActivityAt: stored.at(-1)?.createdAt ?? session.createdAt,
        };
      })
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());

    return Promise.resolve(summaries.slice(0, options.limit ?? DEFAULT_SESSION_LIMIT));
  }

  async #assertVisible(tenantId: string, sessionId: string): Promise<void> {
    if (!(await this.find(tenantId, sessionId))) {
      throw new Error(`session "${sessionId}" not visible to tenant "${tenantId}"`);
    }
  }
}
