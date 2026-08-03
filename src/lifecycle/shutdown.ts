// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Stopping without dropping the turn in flight.
 *
 * A session already survives a restart — it lives in Postgres, not in memory.
 * What a restart loses is the **turn being run right now**: the model has been
 * paid for, a tool may have already sent the email, and the user gets nothing
 * back. Deploys are routine, so that loss is routine unless something waits.
 *
 * The harness does not own the process, so it cannot decide when to stop. What
 * it owns is the answer to "is anything still running": a product's transport
 * calls `run` around each turn and `drain` when the platform says to go.
 *
 * The order matters and is the whole point:
 *
 * 1. **Stop accepting.** New turns are refused, and readiness turns false so a
 *    load balancer sends the next request to a sibling.
 * 2. **Wait for what is running**, up to a deadline the platform allows.
 * 3. **Then** close the pool and flush telemetry.
 *
 * Closing before draining is the mistake this exists to prevent: it makes every
 * in-flight turn fail with a connection error, which reads in the logs as a
 * database problem rather than as a deploy.
 *
 * Nothing here installs a signal handler by itself. A library that hooks
 * `SIGTERM` on import silently takes over a process it does not own, and two
 * such libraries in one product fight. `handleShutdownSignals` is opt-in, in
 * one line, and returns the way to undo it.
 */

/** Refused because the process is stopping — not a failure of the request. */
export class NotAcceptingError extends Error {
  constructor(message = 'the harness is shutting down and is not accepting work') {
    super(message);
    this.name = 'NotAcceptingError';
  }
}

export interface DrainOptions {
  /**
   * How long to wait for in-flight work. Default 15s.
   *
   * Keep it under the platform's own grace period — Kubernetes sends `SIGKILL`
   * after `terminationGracePeriodSeconds` whatever anyone is waiting for, so a
   * longer deadline here is a number that never gets used.
   */
  readonly timeoutMs?: number;
}

export interface DrainResult {
  /** Work that finished, however it finished, before the deadline. */
  readonly completed: number;
  /** Still running when the deadline passed. These turns are the ones lost. */
  readonly abandoned: number;
  readonly timedOut: boolean;
  readonly waitedMs: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export interface LifecycleOptions {
  /** Injectable for tests. */
  readonly now?: () => Date;
}

/**
 * What is running, and whether more may start.
 *
 * Deliberately not a queue and not a scheduler: it counts. A product that needs
 * concurrency limits or backpressure has a transport that already does that
 * better than a chassis could guess.
 */
export class Lifecycle {
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #now: () => Date;
  #accepting = true;

  constructor(options: LifecycleOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** False once draining has begun. Readiness should follow this. */
  get accepting(): boolean {
    return this.#accepting;
  }

  /** How much work is running right now. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /**
   * Run one unit of work — a turn, usually — counted while it runs.
   *
   * Rejects with `NotAcceptingError` once draining has begun, which a transport
   * should turn into a 503 with `Connection: close`. That is a retryable answer,
   * and by then the load balancer already has a sibling to retry against.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      throw new NotAcceptingError();
    }

    const running = work();
    this.#inFlight.add(running);
    try {
      return await running;
    } finally {
      // Whatever happened, it is no longer in flight — a failed turn must not
      // hold the drain open forever.
      this.#inFlight.delete(running);
    }
  }

  /**
   * Stop accepting, then wait for what is running.
   *
   * Safe to call twice: the second call waits alongside the first rather than
   * starting a second shutdown. Platforms do send a second `SIGTERM`.
   */
  async drain(options: DrainOptions = {}): Promise<DrainResult> {
    const startedAt = this.#now().getTime();
    this.#accepting = false;

    const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const before = this.#inFlight.size;
    if (before === 0) {
      return { completed: 0, abandoned: 0, timedOut: false, waitedMs: 0 };
    }

    // `allSettled`, not `all`: a turn that throws on the way out is still a
    // turn that finished, and one rejection must not abandon the rest.
    const finished = Promise.allSettled([...this.#inFlight]).then(() => 'drained' as const);
    const expired = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      // The deadline must not itself keep the process alive once work is done.
      timer.unref?.();
    });

    const outcome = await Promise.race([finished, expired]);
    const abandoned = this.#inFlight.size;
    return {
      completed: before - abandoned,
      abandoned,
      timedOut: outcome === 'timeout',
      waitedMs: this.#now().getTime() - startedAt,
    };
  }
}

export interface ShutdownSignalOptions extends DrainOptions {
  /** Default `SIGTERM` and `SIGINT` — orchestrators and a terminal. */
  readonly signals?: readonly NodeJS.Signals[];
  /**
   * Called after the drain, to close what the drain was protecting: the pool,
   * the trace exporter, a product's own connections. `Harness.close` does both
   * of the first two.
   */
  readonly onShutdown?: (result: DrainResult) => Promise<void> | void;
  /** Told how it went, before the process exits. */
  readonly onError?: (error: Error) => void;
  /** Injectable for tests, so nothing here ever kills the test runner. */
  readonly exit?: (code: number) => void;
  readonly process?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/**
 * Drain on `SIGTERM`, opt-in.
 *
 * Returns the way to undo it, because a test that installs handlers and cannot
 * remove them leaks them into the next test.
 */
export function handleShutdownSignals(
  lifecycle: Lifecycle,
  options: ShutdownSignalOptions = {},
): () => void {
  const target = options.process ?? process;
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const exit = options.exit ?? ((code: number): void => void (process.exitCode = code));
  let shuttingDown = false;

  const handler = (): void => {
    if (shuttingDown) {
      // A second signal is an operator asking harder. Honouring it would
      // abandon the turns the first one is still waiting for, so it is noted
      // and ignored; the platform's own SIGKILL is the real escalation.
      return;
    }
    shuttingDown = true;

    void (async (): Promise<void> => {
      let failed = false;
      try {
        const result = await lifecycle.drain(options);
        await options.onShutdown?.(result);
        failed = result.timedOut;
      } catch (error) {
        failed = true;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        remove();
        // Non-zero when work was abandoned: a deploy that keeps losing turns
        // should show up as failing pods rather than as clean ones.
        exit(failed ? 1 : 0);
      }
    })();
  };

  for (const signal of signals) {
    target.on(signal, handler);
  }

  function remove(): void {
    for (const signal of signals) {
      target.off(signal, handler);
    }
  }
  return remove;
}
