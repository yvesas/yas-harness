// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Asking another module for context.
 *
 * A module's pool is private (`pool-store.ts`): there is no read that spans the
 * module boundary. But a useful agent needs to cross it — the module handling a
 * question often needs something another module holds. The way across is to
 * **ask**, and the answer is the owner's to give.
 *
 * That inversion is the whole design. If the requester could read, every module
 * would need to trust every other module forever. Because the owner answers,
 * each module keeps deciding — per request, with the purpose in front of it —
 * what leaves its pool, and can reveal a summary instead of the rows, or
 * nothing at all.
 *
 * The harness owns the mechanism and none of the policy: it does not interpret
 * a purpose, rank a requester, or infer what "related" data would be. It
 * carries the question, enforces that only the owner answers it, and records
 * that the exchange happened.
 */

/** What one module asks another for. */
export interface ContextRequest {
  readonly tenantId: string;
  /** The module asking. */
  readonly requester: string;
  /** The module being asked — the one that owns the data. */
  readonly owner: string;
  /**
   * Why it is being asked for, in plain language. This is what the owner
   * judges, so it is required: a request with no stated purpose is one nobody
   * can decide on, and the safe default for an undecidable request is no.
   */
  readonly purpose: string;
  /** Optional narrowing — the keys the requester is after. */
  readonly keys?: readonly string[];
  /** The conversation this is for, when there is one. */
  readonly sessionId?: string;
}

/** One piece of what the owner chose to reveal. Its meaning is the owner's. */
export interface ContextEntry {
  readonly key: string;
  readonly value: unknown;
}

/**
 * The owner's answer. A refusal carries a reason so the requesting module can
 * tell the user why it cannot help, rather than failing silently.
 */
export type ContextGrant =
  | { readonly status: 'granted'; readonly entries: readonly ContextEntry[] }
  | { readonly status: 'denied'; readonly reason: string };

/**
 * How a module answers a request for its own context.
 *
 * Declared on the module, so the decision lives with the data. A module that
 * does not declare one shares nothing — see `ContextBroker`.
 */
export type ContextDiscloser = (request: ContextRequest) => Promise<ContextGrant>;

export function granted(entries: readonly ContextEntry[]): ContextGrant {
  return { status: 'granted', entries };
}

export function denied(reason: string): ContextGrant {
  return { status: 'denied', reason };
}

export class ContextError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextError';
  }
}
