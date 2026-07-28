// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * An `ApprovalStore` decorator that redacts secrets from a held tool call's
 * input before it is stored. A pending approval keeps the tool arguments the
 * model wants to send — which can include a credential bound for an external
 * system — and they sit in the queue until a human looks. So the input is
 * scrubbed on the way in; decisions and reads pass straight through.
 */

import { redactDeep, type SecretRedactor } from '../redaction/secret-redactor.js';

import type { Approval, ApprovalStore, Decision, RequestApprovalInput } from './approval-store.js';

export class RedactingApprovalStore implements ApprovalStore {
  readonly #inner: ApprovalStore;
  readonly #redactor: SecretRedactor;

  constructor(inner: ApprovalStore, redactor: SecretRedactor) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  request(inputs: readonly RequestApprovalInput[]): Promise<Approval[]> {
    return this.#inner.request(
      inputs.map((input) => ({ ...input, input: redactDeep(this.#redactor, input.input) })),
    );
  }

  find(tenantId: string, id: string): Promise<Approval | null> {
    return this.#inner.find(tenantId, id);
  }

  forToolCalls(
    tenantId: string,
    sessionId: string,
    toolCallIds: readonly string[],
  ): Promise<Approval[]> {
    return this.#inner.forToolCalls(tenantId, sessionId, toolCallIds);
  }

  approve(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#inner.approve(tenantId, id, decision);
  }

  reject(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#inner.reject(tenantId, id, decision);
  }

  list(tenantId: string, sessionId: string): Promise<Approval[]> {
    return this.#inner.list(tenantId, sessionId);
  }
}
