// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Stopping without dropping the turn in flight, and saying so honestly while
 * it happens.
 *
 * The interesting cases are the orderings: refusing new work before waiting for
 * old work, going unready before anything closes, and not letting one failed
 * turn hold the drain open.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  databaseProbe,
  liveness,
  readiness,
  type HealthProbe,
} from '../../src/lifecycle/health.js';
import {
  handleShutdownSignals,
  Lifecycle,
  NotAcceptingError,
} from '../../src/lifecycle/shutdown.js';

/** A promise the test resolves by hand, standing in for a turn. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('graceful shutdown', () => {
  it('counts what is running', async () => {
    const lifecycle = new Lifecycle();
    const turn = deferred();

    const running = lifecycle.run(() => turn.promise);
    expect(lifecycle.inFlight).toBe(1);

    turn.resolve();
    await running;
    expect(lifecycle.inFlight).toBe(0);
  });

  it('waits for the turn in flight before reporting done', async () => {
    const lifecycle = new Lifecycle();
    const turn = deferred();
    const running = lifecycle.run(() => turn.promise);

    let drained = false;
    const draining = lifecycle.drain().then((result) => {
      drained = true;
      return result;
    });

    // The whole point: the drain has not finished while a turn is still open.
    await Promise.resolve();
    expect(drained).toBe(false);

    turn.resolve();
    await running;
    expect(await draining).toMatchObject({ completed: 1, abandoned: 0, timedOut: false });
  });

  it('refuses new work the moment draining begins', async () => {
    const lifecycle = new Lifecycle();
    const turn = deferred();
    const running = lifecycle.run(() => turn.promise);

    const draining = lifecycle.drain();
    expect(lifecycle.accepting).toBe(false);

    // Refused before the old work finishes, not after: a request arriving mid
    // drain belongs to the sibling that is still ready.
    await expect(lifecycle.run(() => Promise.resolve('late'))).rejects.toBeInstanceOf(
      NotAcceptingError,
    );

    turn.resolve();
    await running;
    await draining;
  });

  it('returns immediately when nothing is running', async () => {
    const result = await new Lifecycle().drain({ timeoutMs: 60_000 });

    // A deploy of an idle pod should not wait out a deadline meant for busy ones.
    expect(result).toMatchObject({ completed: 0, abandoned: 0, timedOut: false, waitedMs: 0 });
  });

  it('gives up at the deadline and says how much was abandoned', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new Lifecycle();
      const stuck = deferred();
      void lifecycle.run(() => stuck.promise).catch(() => undefined);

      const draining = lifecycle.drain({ timeoutMs: 15_000 });
      await vi.advanceTimersByTimeAsync(15_000);

      // Counted, not hidden: a deploy that keeps abandoning turns should be
      // visible as exactly that.
      expect(await draining).toMatchObject({ completed: 0, abandoned: 1, timedOut: true });
      stuck.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a failing turn hold the drain open', async () => {
    const lifecycle = new Lifecycle();
    const turn = deferred();
    const running = lifecycle.run(() => turn.promise);
    running.catch(() => undefined);

    const draining = lifecycle.drain({ timeoutMs: 60_000 });
    turn.reject(new Error('the model refused'));

    // A turn that throws on the way out is still a turn that finished.
    expect(await draining).toMatchObject({ completed: 1, abandoned: 0, timedOut: false });
  });

  it('lets one failure through without abandoning the others', async () => {
    const lifecycle = new Lifecycle();
    const bad = deferred();
    const good = deferred();
    void lifecycle.run(() => bad.promise).catch(() => undefined);
    const ok = lifecycle.run(() => good.promise);

    const draining = lifecycle.drain({ timeoutMs: 60_000 });
    bad.reject(new Error('boom'));
    good.resolve();
    await ok;

    expect(await draining).toMatchObject({ completed: 2, abandoned: 0 });
  });

  it('drains once when the platform sends a second signal', async () => {
    const handlers: (() => void)[] = [];
    const fakeProcess = {
      on: (_signal: string, handler: () => void) => {
        handlers.push(handler);
        return fakeProcess;
      },
      off: () => fakeProcess,
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;

    const lifecycle = new Lifecycle();
    const drain = vi.spyOn(lifecycle, 'drain');
    const exits: number[] = [];
    handleShutdownSignals(lifecycle, {
      signals: ['SIGTERM'],
      process: fakeProcess,
      exit: (code) => exits.push(code),
    });

    handlers[0]?.();
    handlers[0]?.();
    await vi.waitFor(() => {
      expect(exits).toEqual([0]);
    });

    // An operator pressing harder must not abandon the turns the first signal
    // is still waiting for; SIGKILL is the real escalation.
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('closes what the drain was protecting, and only after it', async () => {
    const order: string[] = [];
    const handlers: (() => void)[] = [];
    const fakeProcess = {
      on: (_signal: string, handler: () => void) => {
        handlers.push(handler);
        return fakeProcess;
      },
      off: () => fakeProcess,
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;

    const lifecycle = new Lifecycle();
    const turn = deferred();
    const running = lifecycle.run(() =>
      turn.promise.then(() => {
        order.push('turn finished');
      }),
    );

    handleShutdownSignals(lifecycle, {
      signals: ['SIGTERM'],
      process: fakeProcess,
      exit: () => undefined,
      onShutdown: () => {
        order.push('closed');
      },
    });

    handlers[0]?.();
    turn.resolve();
    await running;
    await vi.waitFor(() => {
      expect(order).toEqual(['turn finished', 'closed']);
    });
  });

  it('exits non-zero when work was abandoned', async () => {
    vi.useFakeTimers();
    try {
      const handlers: (() => void)[] = [];
      const fakeProcess = {
        on: (_signal: string, handler: () => void) => {
          handlers.push(handler);
          return fakeProcess;
        },
        off: () => fakeProcess,
      } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;

      const lifecycle = new Lifecycle();
      const stuck = deferred();
      void lifecycle.run(() => stuck.promise).catch(() => undefined);

      const exits: number[] = [];
      handleShutdownSignals(lifecycle, {
        signals: ['SIGTERM'],
        process: fakeProcess,
        exit: (code) => exits.push(code),
        timeoutMs: 5_000,
      });

      handlers[0]?.();
      await vi.advanceTimersByTimeAsync(5_000);

      // A deploy that keeps losing turns should show up as failing pods rather
      // than as clean ones.
      await vi.waitFor(() => {
        expect(exits).toEqual([1]);
      });
      stuck.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be uninstalled', () => {
    const removed: string[] = [];
    const fakeProcess = {
      on: () => fakeProcess,
      off: (signal: string) => {
        removed.push(signal);
        return fakeProcess;
      },
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;

    handleShutdownSignals(new Lifecycle(), { process: fakeProcess })();

    // A test that installs handlers it cannot remove leaks them into the next.
    expect(removed).toEqual(['SIGTERM', 'SIGINT']);
  });
});

describe('health checks', () => {
  it('answers liveness without touching anything', () => {
    // The design, not an omission: a dependency in the liveness path lets
    // someone else's outage restart a process that was fine.
    expect(liveness()).toEqual({ healthy: true, checks: [] });
  });

  it('is ready when its dependencies answer', async () => {
    const report = await readiness([databaseProbe({ query: () => Promise.resolve([]) })]);

    expect(report.healthy).toBe(true);
    expect(report.checks[0]).toMatchObject({ name: 'database', healthy: true });
  });

  it('is not ready when a dependency is down, and says which', async () => {
    const report = await readiness([
      databaseProbe({ query: () => Promise.reject(new Error('ECONNREFUSED')) }),
    ]);

    expect(report.healthy).toBe(false);
    expect(report.checks[0]).toMatchObject({ healthy: false, error: 'ECONNREFUSED' });
  });

  it('reports every probe, not just the first failure', async () => {
    const report = await readiness([
      databaseProbe({ query: () => Promise.reject(new Error('down')) }, 'primary'),
      databaseProbe({ query: () => Promise.resolve([]) }, 'replica'),
    ]);

    // An operator opening /readyz wants the whole picture, not the first line
    // of it.
    expect(report.checks.map((check) => check.name)).toEqual(['primary', 'replica']);
  });

  it('answers "no" rather than hanging when a probe does not return', async () => {
    vi.useFakeTimers();
    try {
      const hung: HealthProbe = { name: 'database', check: () => new Promise<never>(() => {}) };
      const pending = readiness([hung], { timeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(2_000);

      // A probe that never answers is worse than one answering no: the platform
      // waits out its own timeout while the pod keeps taking traffic.
      const report = await pending;
      expect(report.healthy).toBe(false);
      expect(report.checks[0]?.error).toMatch(/did not answer within 2000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not ready while draining, whatever the dependencies say', async () => {
    const lifecycle = new Lifecycle();
    await lifecycle.drain();

    const probe = vi.fn(() => Promise.resolve([]));
    const report = await readiness([databaseProbe({ query: probe })], { lifecycle });

    // Going unready before anything closes is what makes the shutdown graceful.
    expect(report).toMatchObject({ healthy: false, shuttingDown: true });
    // And it is answered without asking: the probes cannot change the answer.
    expect(probe).not.toHaveBeenCalled();
  });

  it('stays live while draining', async () => {
    const lifecycle = new Lifecycle();
    await lifecycle.drain();

    // Draining is not wedged. Reporting otherwise invites the orchestrator to
    // SIGKILL a pod that is doing exactly what it was asked to do.
    expect(liveness().healthy).toBe(true);
    expect(lifecycle.accepting).toBe(false);
  });

  it('asks the database the cheapest question there is', async () => {
    const queries: string[] = [];
    await readiness([
      databaseProbe({
        query: (sql: string) => {
          queries.push(sql);
          return Promise.resolve([]);
        },
      }),
    ]);

    // Anything touching a table would also fail for reasons that are not about
    // readiness, and would cost more the busier the database is.
    expect(queries).toEqual(['select 1']);
  });
});
