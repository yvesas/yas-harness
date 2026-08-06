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
          <h1>Connections</h1>
          <p className="muted">
            Nothing can be connected yet. The console needs two things: a{' '}
            <code>MASTER_ENCRYPTION_KEY</code>, without which there is nowhere to seal a credential,
            and at least one OAuth provider in <code>config/connectors.json</code> with its client
            id and secret in the environment.
          </p>
          <p className="muted">
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
        <h1>Connections</h1>

        {outcome.connected ? (
          <p>
            <strong>Connected {outcome.connected}.</strong> Its credential is sealed under this
            tenant&rsquo;s key and was never written down in the clear.{' '}
            {outcome.scopes ? (
              <span className="muted">
                Granted: <code>{outcome.scopes}</code>. A provider may grant less than was asked
                for, so this is what the token actually carries.
              </span>
            ) : null}
          </p>
        ) : null}
        {outcome.error ? (
          <>
            <p className="failed">Could not finish connecting: {outcome.error}</p>
            <p className="muted">
              Nothing was stored. If a connection row was created before this failed it was removed
              — one that looks connected and cannot authenticate fails later, at a call, and reads
              as the source being down.
            </p>
          </>
        ) : null}

        <h2>Connected</h2>
        {connected.length === 0 ? (
          <p className="muted">Nothing connected yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Account</th>
                <th>Status</th>
                <th>Scopes granted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connected.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <code>{connection.connectorId}</code>
                  </td>
                  <td>{connection.accountLabel ?? <span className="muted">unnamed</span>}</td>
                  <td className={connection.status === 'active' ? undefined : 'failed'}>
                    {connection.status}
                  </td>
                  <td className="muted">
                    <code>{connection.scopes.join(' ') || '—'}</code>
                  </td>
                  <td>
                    <form action={disconnect}>
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <button type="submit">Disconnect</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Disconnecting erases the sealed credential along with the connection. The token is not
          revoked at the provider — only the source can do that, and doing it here would be a claim
          the console cannot keep.
        </p>

        <h2>Available</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Will ask for</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connectable.map((connectorId) => (
              <tr key={connectorId}>
                <td>
                  <code>{connectorId}</code>
                </td>
                <td className="muted">
                  <code>{api.onboarding?.scopesFor(connectorId).join(' ')}</code>
                </td>
                <td>
                  <form action={connect}>
                    <input type="hidden" name="connectorId" value={connectorId} />
                    <button type="submit">Connect</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
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
