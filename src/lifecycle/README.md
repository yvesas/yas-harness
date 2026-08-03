# `src/lifecycle/` — starting, stopping, and being asked if you are alive

## Boundary

**This folder answers questions; it does not serve them.** There is no HTTP
server here and there will not be one — a product owns its transport
([ADR 0007](../../docs/adr/0007-oauth-and-transparent-refresh.md) onwards), so
it owns `/healthz` and `/readyz`. What the harness owns is what those endpoints
should say, which is where the mistakes actually live.

It also installs no signal handler on its own. A library that hooks `SIGTERM`
when it is imported has quietly taken over a process it does not own, and two
such libraries in one product fight over it.

## Graceful shutdown

A session already survives a restart — it is in Postgres, not in memory. What a
restart loses is **the turn running right now**: the model has been paid for, a
tool may have already sent the email, and the user gets nothing back. Deploys
are routine, so that loss is routine unless something waits.

```ts
const lifecycle = new Lifecycle();

// around each turn, in the transport
await lifecycle.run(() => harness.agent.run(turn));

// once, at startup
handleShutdownSignals(lifecycle, {
  timeoutMs: 15_000,
  onShutdown: () => harness.close(),
});
```

The order is the whole point:

1. **Stop accepting.** New turns are refused with `NotAcceptingError`, and
   readiness turns false so the load balancer picks a sibling.
2. **Wait for what is running**, up to a deadline.
3. **Then** close the pool and flush telemetry.

Closing first is the mistake this exists to prevent: every in-flight turn fails
with a connection error, and the logs read like a database problem rather than a
deploy.

Keep `timeoutMs` under the platform's grace period —
`terminationGracePeriodSeconds` in Kubernetes. It sends `SIGKILL` when that
expires whatever anyone is waiting for, so a longer deadline here is a number
that never gets used.

## Health checks

Two questions, deliberately kept apart.

**Liveness — "is this process wedged?"** Checks nothing.

```ts
app.get('/healthz', () => liveness());
```

Having `/healthz` ping the database is the most damaging mistake in this area: a
blip fails the liveness probe on every replica at once and the orchestrator
kills all of them. Restarting a pod does not fix a database, so a recoverable
outage becomes a crash loop — the platform amplifying the fault instead of
absorbing it.

**Readiness — "should I be sent a request?"** Checks dependencies, and the
lifecycle.

```ts
app.get('/readyz', () => readiness([databaseProbe(pool)], { lifecycle }));
```

A pod that fails readiness is pulled from the load balancer and left running, so
it recovers on its own the moment its dependency does. Readiness is also false
while draining, before anything is closed — that is what makes the shutdown
above graceful.

Probes carry their own timeout (2s by default). A probe that never answers is
worse than one answering "no": the platform waits out its own timeout on every
check while the pod keeps taking traffic.

## What is not here

- **Metrics** (F6.6). Latency per stage and cost per tenant are `src/telemetry/`
  and its OTLP exporter, not this folder.
- **Restart safety for sessions.** Already true, by living in Postgres.
