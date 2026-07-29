// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Carries a context request to the module that owns the data, and nothing else.
 *
 * The broker is deliberately thin. It does not decide, cache, merge or widen a
 * request — every one of those would move a judgement the owner is making into
 * a place the owner cannot see. What it does is make the rules unskippable:
 * only the owner answers, an owner that never opted in answers no, and every
 * exchange is recorded whether it was granted or refused.
 */

import type { ModuleRegistry } from '../modules/module.js';
import type { TraceRecorder } from '../telemetry/trace.js';
import { TurnTrace } from '../telemetry/trace.js';

import type { ContextGrant, ContextRequest } from './context.js';
import { ContextError, denied } from './context.js';

export interface ContextBrokerOptions {
  /**
   * Where the exchange is recorded. A cross-module disclosure is the event most
   * worth being able to look up afterwards, so this is wired in production even
   * though the broker works without it.
   */
  readonly traces?: TraceRecorder;
}

export class ContextBroker {
  readonly #modules: ModuleRegistry;
  readonly #traces: TraceRecorder | undefined;

  constructor(modules: ModuleRegistry, options: ContextBrokerOptions = {}) {
    this.#modules = modules;
    this.#traces = options.traces;
  }

  /**
   * Ask the owner for context, and return exactly what it answered.
   *
   * A request the harness cannot honour — an unknown module, an empty purpose,
   * a module asking itself — throws rather than being reported as a denial:
   * those are wiring mistakes, and a caller that cannot tell them from a
   * refusal would treat a bug as a policy decision and stop looking.
   */
  async request(request: ContextRequest, traceId?: string): Promise<ContextGrant> {
    this.#validate(request);

    const owner = this.#modules.get(request.owner);
    if (!owner) {
      throw new ContextError(
        `module "${request.owner}" is not registered, so it cannot be asked for context`,
      );
    }

    const trace = new TurnTrace(this.#traces, {
      tenantId: request.tenantId,
      sessionId: request.sessionId ?? null,
      ...(traceId === undefined ? {} : { traceId }),
    });

    // Fail closed. A module that never declared how it answers has not agreed
    // to share anything, and silence is not consent.
    const grant = owner.disclose
      ? await owner.disclose(request)
      : denied(`module "${request.owner}" does not disclose context`);

    await trace.step({
      kind: 'context_request',
      label: `${request.requester} → ${request.owner}`,
      succeeded: grant.status === 'granted',
      detail: {
        requester: request.requester,
        owner: request.owner,
        purpose: request.purpose,
        // What was revealed, not what it said: the values are the owner's data
        // and belong in its pool, not copied into a diagnostic table.
        ...(grant.status === 'granted'
          ? { granted: true, entries: grant.entries.length, keys: grant.entries.map((e) => e.key) }
          : { granted: false, reason: grant.reason }),
      },
    });

    return grant;
  }

  #validate(request: ContextRequest): void {
    if (request.purpose.trim() === '') {
      throw new ContextError('a context request must state a purpose for the owner to judge');
    }
    if (request.requester === request.owner) {
      // Not a disclosure at all: a module reads its own pool directly.
      throw new ContextError(`module "${request.owner}" cannot request context from itself`);
    }
    if (!this.#modules.has(request.requester)) {
      throw new ContextError(`module "${request.requester}" is not registered`);
    }
  }
}
