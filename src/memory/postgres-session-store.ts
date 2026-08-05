// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: sessions and messages in PostgreSQL.
 *
 * Every statement is scoped by `tenant_id` in its WHERE clause. That is the
 * second line of defence, not the first — the schema enforces the same thing
 * with a foreign key and a composite constraint.
 */

import type { Pool } from 'pg';

import type { ContentPart, ModelMessage } from '../models/model-gateway.js';

import type {
  CreateSessionInput,
  ListSessionsQuery,
  Session,
  SessionStore,
  SessionSummary,
  StoredMessage,
} from './session-store.js';
import { DEFAULT_SESSION_LIMIT } from './session-store.js';

interface SessionRow {
  id: string;
  tenant_id: string;
  persona_id: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: ContentPart[];
  created_at: Date;
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (tenant_id, persona_id)
       VALUES ($1, $2)
       RETURNING id, tenant_id, persona_id, created_at`,
      [input.tenantId, input.personaId],
    );

    // INSERT ... RETURNING always yields exactly one row or throws.
    return toSession(rows[0]!);
  }

  async find(tenantId: string, sessionId: string): Promise<Session | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT id, tenant_id, persona_id, created_at
         FROM sessions
        WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId],
    );

    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async messages(tenantId: string, sessionId: string): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      // Ordered by seq, not created_at: messages appended in one transaction
      // share a created_at value and would come back in arbitrary order.
      `SELECT id, role, content, created_at
         FROM messages
        WHERE session_id = $1 AND tenant_id = $2
        ORDER BY seq`,
      [sessionId, tenantId],
    );

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  /**
   * Appends in one transaction: a turn that produced several messages is
   * either wholly stored or wholly absent, never half a conversation.
   */
  async append(
    tenantId: string,
    sessionId: string,
    messages: readonly ModelMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const message of messages) {
        await client.query(
          `INSERT INTO messages (session_id, tenant_id, role, content)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, tenantId, message.role, JSON.stringify(message.content)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string, options: ListSessionsQuery = {}): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<SessionRow & { messages: string; last_at: Date }>(
      // The count and the last timestamp come from one join rather than a query
      // per session: a list of thirty conversations must not be thirty-one
      // round trips.
      `SELECT s.id, s.tenant_id, s.persona_id, s.created_at,
              count(m.id)::text                      AS messages,
              coalesce(max(m.created_at), s.created_at) AS last_at
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id AND m.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
        GROUP BY s.id
        -- By last activity, not creation: a conversation replied to this
        -- morning matters more than one opened last week and abandoned.
        ORDER BY last_at DESC
        LIMIT $2`,
      [tenantId, options.limit ?? DEFAULT_SESSION_LIMIT],
    );

    return rows.map((row) => ({
      ...toSession(row),
      messages: Number(row.messages),
      lastActivityAt: row.last_at,
    }));
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    createdAt: row.created_at,
  };
}
