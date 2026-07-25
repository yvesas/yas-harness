// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: the approval queue in PostgreSQL.
 *
 * A decision moves a row from pending only if it is still pending — the WHERE
 * clause carries the guard, so two operators deciding the same approval race
 * on the database, not in application code.
 */

import type { Pool } from 'pg';

import type { Approval, ApprovalStore, Decision, RequestApprovalInput } from './approval-store.js';
import { ApprovalNotPendingError } from './approval-store.js';

interface ApprovalRow {
  id: string;
  tenant_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
}

export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly pool: Pool) {}

  async request(inputs: readonly RequestApprovalInput[]): Promise<Approval[]> {
    const created: Approval[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const input of inputs) {
        const { rows } = await client.query<ApprovalRow>(
          `INSERT INTO approvals (tenant_id, session_id, tool_call_id, tool_name, input)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            input.tenantId,
            input.sessionId,
            input.toolCallId,
            input.toolName,
            JSON.stringify(input.input),
          ],
        );
        created.push(toApproval(rows[0]!));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return created;
  }

  async find(tenantId: string, id: string): Promise<Approval | null> {
    const { rows } = await this.pool.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    const row = rows[0];
    return row ? toApproval(row) : null;
  }

  async forToolCalls(
    tenantId: string,
    sessionId: string,
    toolCallIds: readonly string[],
  ): Promise<Approval[]> {
    if (toolCallIds.length === 0) {
      return [];
    }
    const { rows } = await this.pool.query<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE tenant_id = $1 AND session_id = $2 AND tool_call_id = ANY($3)`,
      [tenantId, sessionId, toolCallIds],
    );
    return rows.map(toApproval);
  }

  approve(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#decide(tenantId, id, 'approved', decision);
  }

  reject(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#decide(tenantId, id, 'rejected', decision);
  }

  async list(tenantId: string, sessionId: string): Promise<Approval[]> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE tenant_id = $1 AND session_id = $2
        ORDER BY requested_at, id`,
      [tenantId, sessionId],
    );
    return rows.map(toApproval);
  }

  async #decide(
    tenantId: string,
    id: string,
    status: 'approved' | 'rejected',
    decision: Decision,
  ): Promise<Approval> {
    // The `status = 'pending'` guard makes the transition atomic: a second
    // decision on the same row updates nothing and is rejected below.
    const { rows } = await this.pool.query<ApprovalRow>(
      `UPDATE approvals
          SET status = $3, decided_by = $4, decided_at = now(), reason = $5
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING *`,
      [id, tenantId, status, decision.decidedBy, decision.reason ?? null],
    );

    const row = rows[0];
    if (!row) {
      throw new ApprovalNotPendingError(id);
    }
    return toApproval(row);
  }
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: row.input,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reason: row.reason,
  };
}
