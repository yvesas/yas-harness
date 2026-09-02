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

import type {
  Approval,
  ApprovalStatus,
  ApprovalStore,
  Decision,
  RequestApprovalInput,
  Risk,
} from './approval-store.js';
import { ApprovalNotPendingError, DEFAULT_PENDING_LIMIT } from './approval-store.js';

interface ApprovalRow {
  id: string;
  tenant_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  status: ApprovalStatus;
  risk: Risk;
  consequence: string | null;
  policy_source: string | null;
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
          `INSERT INTO approvals
             (tenant_id, session_id, tool_call_id, tool_name, input,
              risk, consequence, policy_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            input.tenantId,
            input.sessionId,
            input.toolCallId,
            input.toolName,
            JSON.stringify(input.input),
            input.risk ?? 'medium',
            input.consequence ?? null,
            input.policySource ?? null,
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

  requestChanges(
    tenantId: string,
    id: string,
    decision: Decision & { reason: string },
  ): Promise<Approval> {
    return this.#decide(tenantId, id, 'changes_requested', decision);
  }

  async recent(tenantId: string, limit = DEFAULT_PENDING_LIMIT): Promise<Approval[]> {
    const { rows } = await this.pool.query<ApprovalRow>(
      // Ordered by when it was asked rather than when it was decided: a row
      // still waiting has no decision time, and sorting on a null would put
      // exactly the rows somebody cares about at the wrong end.
      `SELECT * FROM approvals
        WHERE tenant_id = $1
        ORDER BY requested_at DESC, id DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map(toApproval);
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

  async pending(tenantId: string, limit = DEFAULT_PENDING_LIMIT): Promise<Approval[]> {
    const { rows } = await this.pool.query<ApprovalRow>(
      // Oldest first: that is the turn that has been parked longest, and a
      // parked turn is a person waiting on the other end.
      `SELECT * FROM approvals
        WHERE tenant_id = $1 AND status = 'pending'
        ORDER BY requested_at, id
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map(toApproval);
  }

  async #decide(
    tenantId: string,
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
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
    risk: row.risk,
    consequence: row.consequence,
    policySource: row.policy_source,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reason: row.reason,
  };
}
