// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Home: is this set up, what is connected, and what has it been doing.
 *
 * It exists because the console had no answer to the first question. Each page
 * knew what *it* needed — Connections knew about the master key, the playground
 * knew about a model key — so somebody opening the console for the first time
 * discovered their setup one failed page at a time.
 *
 * Everything here comes through a harness port. `readiness` in particular had
 * been built for `/readyz` and consumed by nothing, which is how a port rots.
 */

import {
  ArrowRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  PlugsConnectedIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IntegrationIcon } from '@/components/integration-icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { currentTenant } from '../lib/tenant';
import { harness } from '../lib/harness';
import { status, type Part } from '../lib/status';
import { Failure } from './failure';

export const dynamic = 'force-dynamic';

const RECENT_TURNS = 6;

const SHORTCUTS = [
  { href: '/connections', label: 'Connect a source', hint: 'OAuth, through the browser' },
  { href: '/playground', label: 'Talk to the agent', hint: 'with the trace beside it' },
  { href: '/approvals', label: 'Approvals', hint: 'what is waiting on you' },
  { href: '/traces', label: 'Traces', hint: 'every step of every turn' },
] as const;

function PartRow({ part }: { part: Part }) {
  const Icon =
    part.state === 'ready'
      ? CheckCircleIcon
      : part.state === 'broken'
        ? WarningIcon
        : CircleDashedIcon;
  const tone =
    part.state === 'ready'
      ? 'text-primary'
      : part.state === 'broken'
        ? 'text-destructive'
        : 'text-muted-foreground';

  const body = (
    <div className="flex items-start gap-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${tone}`} weight="fill" />
      <div className="min-w-0">
        <div className="font-medium">{part.name}</div>
        <div className="text-muted-foreground text-sm">{part.what}</div>
        {part.todo ? <div className={`mt-1 text-sm ${tone}`}>{part.todo}</div> : null}
      </div>
    </div>
  );

  return part.href ? (
    <a
      href={part.href}
      className="hover:bg-muted/50 -mx-3 block rounded-md px-3 py-2 transition-colors"
    >
      {body}
    </a>
  ) : (
    <div className="-mx-3 px-3 py-2">{body}</div>
  );
}

export default async function Home() {
  try {
    const tenant = await currentTenant();
    const api = await harness();
    const [state, spend, recent] = await Promise.all([
      status(api, tenant.id),
      api.usage.spend(tenant.id),
      api.traceReader.recent(tenant.id, { limit: RECENT_TURNS }),
    ]);

    const connectedCount = state.integrations.reduce(
      (total, integration) => total + integration.accounts.length,
      0,
    );

    return (
      <div className="space-y-10">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.name}</h1>
          <p className="text-muted-foreground text-sm">
            {state.ready
              ? 'Everything the harness needs is in place.'
              : 'Something needs attention below.'}{' '}
            Acting as <code className="text-foreground">{tenant.slug}</code> — there is no login
            yet, so one function decides that.
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">The parts</CardTitle>
            </CardHeader>
            <CardContent className="divide-border/60 divide-y">
              {state.parts.map((part) => (
                <PartRow key={part.name} part={part} />
              ))}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Lately</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-muted-foreground text-sm">Spent</div>
                    <div className="text-xl font-semibold tabular-nums">
                      ${spend.totalCostUsd.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-sm">Model calls</div>
                    <div className="text-xl font-semibold tabular-nums">{spend.calls}</div>
                  </div>
                </div>
                {recent.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Nothing has run yet. Both fill in as soon as the agent answers something.
                  </p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {recent.map((turn) => (
                      <li key={turn.traceId}>
                        <a
                          href={`/traces/${turn.traceId}`}
                          className="hover:bg-muted/50 -mx-2 flex items-center gap-2 rounded px-2 py-1 transition-colors"
                        >
                          <span className="text-muted-foreground tabular-nums">
                            {turn.startedAt.toISOString().slice(11, 19)}
                          </span>
                          <Badge variant={turn.failed ? 'destructive' : 'secondary'}>
                            {turn.endedAs ?? 'unfinished'}
                          </Badge>
                          <span className="text-muted-foreground ml-auto">{turn.steps} steps</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Go to</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1">
                {SHORTCUTS.map((shortcut) => (
                  <a
                    key={shortcut.href}
                    href={shortcut.href}
                    className="hover:bg-muted/50 -mx-2 flex items-center gap-2 rounded-md px-2 py-2 transition-colors"
                  >
                    <span className="text-sm font-medium">{shortcut.label}</span>
                    <span className="text-muted-foreground text-sm">{shortcut.hint}</span>
                    <ArrowRightIcon className="text-muted-foreground ml-auto size-4" />
                  </a>
                ))}
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Integrations</h2>
            <span className="text-muted-foreground text-sm">
              {connectedCount === 0 ? 'none connected yet' : `${String(connectedCount)} connected`}
            </span>
          </div>

          {state.integrations.length === 0 ? (
            <Card>
              <CardContent className="text-muted-foreground py-8 text-center text-sm">
                Nothing is configured to connect. Copy an entry out of{' '}
                <code className="text-foreground">config/connectors.example.json</code> into{' '}
                <code className="text-foreground">config/connectors.json</code>, then restart.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {state.integrations.map((integration) => {
                const live = integration.accounts.filter(
                  (account) => account.status === 'active',
                ).length;
                return (
                  <a key={integration.connectorId} href="/connections" className="group">
                    <Card className="hover:border-primary/50 h-full transition-colors">
                      <CardContent className="flex items-start gap-3 py-5">
                        <IntegrationIcon
                          connectorId={integration.connectorId}
                          className={`size-8 shrink-0 ${live > 0 ? 'text-primary' : 'text-muted-foreground'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{integration.connectorId}</div>
                          {integration.accounts.length === 0 ? (
                            <div className="text-muted-foreground flex items-center gap-1 text-sm">
                              <PlugsConnectedIcon className="size-3.5" />
                              ready to connect
                            </div>
                          ) : (
                            <ul className="mt-1 space-y-0.5 text-sm">
                              {integration.accounts.map((account) => (
                                <li key={account.id} className="flex items-center gap-2">
                                  <span className="truncate">{account.label ?? 'unnamed'}</span>
                                  <Badge
                                    variant={
                                      account.status === 'active' ? 'secondary' : 'destructive'
                                    }
                                  >
                                    {account.status}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </a>
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
