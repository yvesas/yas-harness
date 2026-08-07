// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Connections — the page that justifies the console existing.
 *
 * OAuth needs a browser. It is the one thing a config file and a script cannot
 * do at all, and the harness says so three times over: it owns the mechanics and
 * leaves the callback to a product (ADR 0007). This page and its callback route
 * are that product.
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { connect, disconnect } from './actions';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function Connections({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const outcome = single(await searchParams);
    const tenant = await currentTenant();
    const api = await harness();

    if (!api.onboarding) {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-muted-foreground text-sm">
            Nothing can be connected yet. The console needs two things: a{' '}
            <code>MASTER_ENCRYPTION_KEY</code>, without which there is nowhere to seal a credential,
            and at least one OAuth provider in <code>config/connectors.json</code> with its client
            id and secret in the environment.
          </p>
          <p className="text-muted-foreground text-sm">
            Both are deliberately absent by default — a harness that connects nothing should still
            start.
          </p>
        </>
      );
    }

    const [connected, connectable] = [
      await api.connections.list(tenant.id),
      api.onboarding.connectable(),
    ];

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>

        {outcome.connected ? (
          <p>
            <strong>Connected {outcome.connected}.</strong> Its credential is sealed under this
            tenant&rsquo;s key and was never written down in the clear.{' '}
            {outcome.scopes ? (
              <span className="text-muted-foreground text-sm">
                Granted: <code>{outcome.scopes}</code>. A provider may grant less than was asked
                for, so this is what the token actually carries.
              </span>
            ) : null}{' '}
            <a href="/connections">Dismiss</a>
          </p>
        ) : null}
        {outcome.error ? (
          <>
            <p className="text-destructive">Could not finish connecting: {outcome.error}</p>
            <p className="text-muted-foreground text-sm">
              Nothing was stored. If a connection row was created before this failed it was removed
              — one that looks connected and cannot authenticate fails later, at a call, and reads
              as the source being down.
            </p>
          </>
        ) : null}

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Connected</h2>
        {connected.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing connected yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scopes granted</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {connected.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell>
                    <code>{connection.connectorId}</code>
                  </TableCell>
                  <TableCell>
                    {connection.accountLabel ?? (
                      <span className="text-muted-foreground text-sm">unnamed</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={connection.status === 'active' ? undefined : 'text-destructive'}
                  >
                    {connection.status}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <code>{connection.scopes.join(' ') || '—'}</code>
                  </TableCell>
                  <TableCell>
                    <form action={disconnect}>
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <Button type="submit" size="sm">
                        Disconnect
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-muted-foreground text-sm">
          Disconnecting erases the sealed credential along with the connection. The token is not
          revoked at the provider — only the source can do that, and doing it here would be a claim
          the console cannot keep.
        </p>

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Connect a source</h2>
        <p className="text-muted-foreground text-sm">
          A source stays here after you connect it, because connecting it again adds{' '}
          <strong>another account</strong> rather than replacing the first — two GitHub logins, two
          Drives. Name them and the list above tells them apart.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Will ask for</TableHead>
              <TableHead>Name (optional)</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connectable.map((connectorId) => {
              const already = connected.filter(
                (connection) => connection.connectorId === connectorId,
              ).length;
              return (
                <TableRow key={connectorId}>
                  <TableCell>
                    <code>{connectorId}</code>
                    {already > 0 ? (
                      <div className="text-muted-foreground text-sm">{already} connected</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <code>{api.onboarding?.scopesFor(connectorId).join(' ')}</code>
                  </TableCell>
                  <TableCell colSpan={2}>
                    <form action={connect}>
                      <input type="hidden" name="connectorId" value={connectorId} />
                      <input
                        type="text"
                        name="accountLabel"
                        size={24}
                        maxLength={60}
                        placeholder="work account"
                      />{' '}
                      <Button type="submit" size="sm">
                        Connect
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-sm">
          Connecting opens the provider&rsquo;s consent screen. Nothing is stored until you come
          back — and the credential is sealed the moment you do, so it is never written down in the
          clear.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}

/** A query string can repeat a key; the first value is the one that was meant. */
function single(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ['connected', 'scopes', 'error']) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) {
      picked[key] = first;
    }
  }
  return picked;
}
