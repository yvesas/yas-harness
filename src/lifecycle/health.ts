// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Answering "is this process alive" and "should it get traffic" — two
 * questions, deliberately kept apart.
 *
 * There are no endpoints here. The harness has no HTTP surface by decision
 * (ADRs 0007–0009): a product owns its transport, so it owns `/healthz` and
 * `/readyz` too. What the harness owns is the answer, and the answer is where
 * the mistakes live.
 *
 * **Liveness must not check dependencies.** It is tempting to have `/healthz`
 * ping the database, and it is the single most damaging mistake in this area: a
 * database blip then makes every replica fail its liveness probe at once, and
 * the orchestrator kills all of them. Restarting a pod does not fix a database,
 * so a recoverable outage becomes a crash loop — the platform amplifying the
 * fault instead of absorbing it. Liveness asks one thing: *is this process
 * still able to work at all, or is it wedged and only a restart will help?*
 *
 * **Readiness is where dependencies belong.** "Should I be sent a request right
 * now" is exactly the question a broken database changes the answer to. A pod
 * that fails readiness is taken out of the load balancer and left running, so
 * it comes back on its own the moment the dependency does.
 *
 * **Readiness is also false while draining**, before any connection is closed.
 * That is what makes a graceful shutdown graceful: traffic stops arriving while
 * the turns already in flight finish (`shutdown.ts`).
 */

/** One thing that can be checked, named so a report says what broke. */
export interface HealthProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface ProbeReport {
  readonly name: string;
  readonly healthy: boolean;
  readonly durationMs: number;
  /** Why it failed. Absent when it did not. */
  readonly error?: string;
}

export interface HealthReport {
  readonly healthy: boolean;
  readonly checks: readonly ProbeReport[];
  /** Set when the process is draining, so a reader knows it is not a fault. */
  readonly shuttingDown?: boolean;
}

export interface ReadinessOptions {
  /**
   * Give up on a probe after this long. Default 2s.
   *
   * Without it a hung database hangs the probe, and a probe that never answers
   * is worse than one that answers "no": the platform waits out its own
   * timeout on every check while the pod keeps taking traffic.
   */
  readonly timeoutMs?: number;
  /** Consulted first: draining is not ready, however healthy the parts are. */
  readonly lifecycle?: { readonly accepting: boolean };
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Is the process itself working?
 *
 * Nothing is checked, and that is the design: reaching this line means the
 * event loop is turning and the module graph is intact, which is all liveness
 * is allowed to mean. Anything more would let someone else's outage restart a
 * process that was fine.
 */
export function liveness(): HealthReport {
  return { healthy: true, checks: [] };
}

/** Should this process be sent work? */
export async function readiness(
  probes: readonly HealthProbe[],
  options: ReadinessOptions = {},
): Promise<HealthReport> {
  if (options.lifecycle && !options.lifecycle.accepting) {
    // Answered before the probes run: the dependencies may be perfectly fine,
    // and asking them delays the one answer that already matters.
    return { healthy: false, checks: [], shuttingDown: true };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const checks = await Promise.all(probes.map((probe) => runProbe(probe, timeoutMs)));
  return { healthy: checks.every((check) => check.healthy), checks };
}

async function runProbe(probe: HealthProbe, timeoutMs: number): Promise<ProbeReport> {
  const startedAt = Date.now();
  try {
    await Promise.race([probe.check(), rejectAfter(timeoutMs, probe.name)]);
    return { name: probe.name, healthy: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name: probe.name,
      healthy: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function rejectAfter(timeoutMs: number, name: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`health probe '${name}' did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
    // A losing race must not keep the process alive.
    timer.unref?.();
  });
}

/**
 * Anything that answers a trivial query — a `pg.Pool`, typically.
 *
 * Typed structurally so this file imports no driver: `src/lifecycle/` is core
 * and stays that way.
 */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

/**
 * The database is reachable and answering.
 *
 * `SELECT 1` rather than a count of anything: the question is whether a
 * connection can be had and a round trip completed. A query that touches a
 * table would also fail for reasons that are not about readiness, and would
 * cost more the busier the database is — exactly when probes should be cheapest.
 */
export function databaseProbe(db: Queryable, name = 'database'): HealthProbe {
  return {
    name,
    check: async (): Promise<void> => {
      await db.query('select 1');
    },
  };
}
