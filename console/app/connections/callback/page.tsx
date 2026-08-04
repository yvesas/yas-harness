// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The callback — the loose end ADR 0007 left for a product.
 *
 * A page rather than a route handler, because the provider sends a *person*
 * here, not a machine. Something has to be rendered either way, and a redirect
 * that swallows the error would leave somebody staring at a Connections page
 * that quietly did not change.
 *
 * The order below is the security-relevant part: **state is checked before the
 * code is spent.** Trading a code first and validating afterwards would already
 * have attached the account by the time the check fails.
 */

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { completeFlow } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

interface CallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export default async function Callback({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = single(await searchParams);

  // The provider said no — usually the person declined. Not a failure of ours,
  // and it must not read like one.
  if (params.error) {
    return (
      <>
        <h1>Not connected</h1>
        <p>
          The provider returned <code>{params.error}</code>
          {params.error_description ? `: ${params.error_description}` : ''}.
        </p>
        <p className="muted">
          Nothing was stored. Declining a consent screen lands here too, which is the same outcome
          by a different route.
        </p>
        <p>
          <a href="/connections">Back to connections</a>
        </p>
      </>
    );
  }

  try {
    // State first, always. Spending the code before checking it would attach
    // the account and *then* discover the callback was forged.
    const flow = await completeFlow(params.state ?? null);
    if (!params.code) {
      throw new Error('the provider sent no authorization code');
    }

    const tenant = await currentTenant();
    const api = await harness();
    if (!api.onboarding) {
      throw new Error('no OAuth provider is configured');
    }

    const connection = await api.onboarding.complete(flow.connectorId, {
      tenantId: tenant.id,
      code: params.code,
      redirectUri: flow.redirectUri,
    });

    return (
      <>
        <h1>Connected</h1>
        <p>
          <code>{connection.connectorId}</code> is connected, and its credential is sealed under
          this tenant&rsquo;s key. It was never written down in the clear.
        </p>
        <p className="muted">
          Granted: <code>{connection.scopes.join(' ') || 'nothing reported'}</code>. A provider may
          grant less than was asked for — a person can decline part of a consent screen — so this is
          what the token actually carries, not what we requested.
        </p>
        <p>
          <a href="/connections">Back to connections</a>
        </p>
      </>
    );
  } catch (error) {
    return (
      <>
        <h1>Could not finish connecting</h1>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
        <p className="muted">
          Nothing was stored. If a connection row was created before this failed, it was removed — a
          connection that looks connected and cannot authenticate fails later, at a call, and reads
          as the source being down.
        </p>
        <p>
          <a href="/connections">Back to connections</a>
        </p>
      </>
    );
  }
}

/** A query string can repeat a key; the first value is the one that was meant. */
function single(params: Record<string, string | string[] | undefined>): CallbackParams {
  const picked: Record<string, string> = {};
  for (const key of ['code', 'state', 'error', 'error_description']) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) {
      picked[key] = first;
    }
  }
  return picked as CallbackParams;
}
