// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Remembering what is broken, so the next request does not rediscover it.
 *
 * The gateway already retries and falls back, but with no memory: a provider
 * that has been down for an hour is still tried — and retried, with backoff —
 * on every single request, and every one of those requests pays the full
 * timeout before the fallback it was always going to need. Multiply by the
 * conversation and the outage becomes latency the user feels.
 *
 * So failures are remembered, at the granularity that matches whose fault they
 * are:
 *
 * - **A provider fault is everyone's.** A 5xx or a timeout says the provider is
 *   unwell, which is not a fact about one tenant, so the memory is global. After
 *   a few consecutive faults the provider is skipped outright until a cooldown
 *   passes.
 * - **A credential fault is one caller's.** A 429 says *this key* is over its
 *   limit; another tenant's key is unaffected — especially once a product lets
 *   a customer bring their own. So that memory is scoped per tenant and model,
 *   and honours the provider's own `Retry-After` when it sent one.
 *
 * Recovery is a **half-open probe**, not a clock: when the cooldown expires the
 * next request is allowed through as a test. If it works the memory clears; if
 * it fails the wait doubles, up to a ceiling. A provider that is still down
 * therefore costs one request per cooldown rather than every request.
 */

import type { FailureKind } from './model-gateway.js';

/** Why a candidate is being skipped, and until when. */
export interface Unavailable {
  readonly scope: string;
  readonly kind: FailureKind;
  readonly until: Date;
  readonly reason: string;
}

export interface AvailabilityPolicy {
  /** Consecutive faults before a scope is skipped at all. Default 3. */
  readonly faultsBeforeSkipping?: number;
  /** The first cooldown, doubling on each failed probe. Default 15s. */
  readonly cooldownMs?: number;
  /** The ceiling that doubling stops at. Default 5 minutes. */
  readonly maxCooldownMs?: number;
}

const DEFAULTS = {
  faultsBeforeSkipping: 3,
  cooldownMs: 15_000,
  maxCooldownMs: 300_000,
} as const;

/**
 * A credential fault is trusted the first time.
 *
 * A provider saying "you are over your limit" is not a symptom to corroborate —
 * it is the answer, and it usually comes with how long to wait. Waiting for it
 * three times before believing it just spends three more of a quota that is
 * already gone.
 */
const CREDENTIAL_FAULTS_BEFORE_SKIPPING = 1;

interface Memory {
  consecutiveFaults: number;
  cooldownMs: number;
  until: Date | null;
  kind: FailureKind;
  reason: string;
  /** A probe is out: the cooldown passed and one request was let through. */
  probing: boolean;
}

/**
 * Where the memory lives.
 *
 * In process, deliberately. Circuit state describes the last few seconds of a
 * running gateway, and a restart genuinely should rediscover it rather than
 * inherit a stale verdict. A deployment that wants it shared across instances
 * implements this interface over something shared — which is the reason it is
 * an interface at all.
 */
export interface Availability {
  /** Why this scope should be skipped, or null to go ahead. */
  blocked(scope: string, now: Date): Unavailable | null;
  recordFault(scope: string, fault: RecordedFault): void;
  recordSuccess(scope: string): void;
}

export interface RecordedFault {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly now: Date;
  /** From the provider's `Retry-After`; overrides the computed cooldown. */
  readonly retryAfterMs?: number;
}

export class InMemoryAvailability implements Availability {
  readonly #memories = new Map<string, Memory>();
  readonly #policy: Required<AvailabilityPolicy>;

  constructor(policy: AvailabilityPolicy = {}) {
    this.#policy = { ...DEFAULTS, ...policy };
  }

  blocked(scope: string, now: Date): Unavailable | null {
    const memory = this.#memories.get(scope);
    if (!memory?.until) {
      return null;
    }

    if (now >= memory.until) {
      // The cooldown passed. Let exactly one request through to find out
      // whether anything changed, and keep the memory until it reports back.
      memory.probing = true;
      return null;
    }
    if (memory.probing) {
      // A probe is already out. Blocking the rest is the point: one request
      // pays to find out, not all of them.
      return this.#unavailable(scope, memory);
    }

    return this.#unavailable(scope, memory);
  }

  recordFault(scope: string, fault: RecordedFault): void {
    const memory = this.#memories.get(scope) ?? {
      consecutiveFaults: 0,
      cooldownMs: this.#policy.cooldownMs,
      until: null,
      kind: fault.kind,
      reason: fault.reason,
      probing: false,
    };

    // A failed probe means the cooldown was optimistic; the next one is longer.
    if (memory.probing) {
      memory.cooldownMs = Math.min(memory.cooldownMs * 2, this.#policy.maxCooldownMs);
    }
    memory.probing = false;
    memory.consecutiveFaults += 1;
    memory.kind = fault.kind;
    memory.reason = fault.reason;

    const threshold =
      fault.kind === 'credential'
        ? CREDENTIAL_FAULTS_BEFORE_SKIPPING
        : this.#policy.faultsBeforeSkipping;

    if (memory.consecutiveFaults >= threshold) {
      // The provider's own answer beats ours whenever it gave one.
      const wait = fault.retryAfterMs ?? memory.cooldownMs;
      memory.until = new Date(fault.now.getTime() + wait);
    }

    this.#memories.set(scope, memory);
  }

  recordSuccess(scope: string): void {
    // Whatever was wrong is over — including a probe that just proved it.
    this.#memories.delete(scope);
  }

  #unavailable(scope: string, memory: Memory): Unavailable {
    return {
      scope,
      kind: memory.kind,
      until: memory.until!,
      reason: memory.reason,
    };
  }
}

/** A provider is unwell for everybody, so its memory is not scoped by tenant. */
export function providerScope(provider: string): string {
  return `provider:${provider}`;
}

/**
 * A credential belongs to one tenant and one model reference — under BYOM those
 * are literally different keys, and even without it a per-model quota says
 * nothing about the next model.
 */
export function credentialScope(tenantId: string, modelReference: string): string {
  return `credential:${tenantId}:${modelReference}`;
}
