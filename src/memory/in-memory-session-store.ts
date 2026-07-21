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

import type { CreateSessionInput, Session, SessionStore, StoredMessage } from './session-store.js';

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

  async messages(tenantId: string, sessionId: string): Promise<StoredMessage[]> {
    await this.#assertVisible(tenantId, sessionId);
    return [...(this.#messages.get(sessionId) ?? [])];
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

  async #assertVisible(tenantId: string, sessionId: string): Promise<void> {
    if (!(await this.find(tenantId, sessionId))) {
      throw new Error(`session "${sessionId}" not visible to tenant "${tenantId}"`);
    }
  }
}
