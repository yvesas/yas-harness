// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * The two things a person does on the Connections page.
 *
 * Server actions rather than API routes: both are mutations issued by a form on
 * a page that already runs on the server, and giving them URLs would mean
 * designing and defending a second surface for no gain. Next protects an action
 * against cross-site invocation on its own.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { beginFlow } from '../../lib/oauth';

/** Start an OAuth flow: mint the state, then hand the browser to the provider. */
export async function connect(form: FormData): Promise<never> {
  const connectorId = String(form.get('connectorId') ?? '');
  const api = await harness();
  if (!api.onboarding) {
    throw new Error('no OAuth provider is configured');
  }

  const flow = await beginFlow(connectorId, await origin());
  // `redirect` throws to unwind, so nothing after it runs — which is why the
  // state cookie is set first.
  redirect(
    api.onboarding.authorizationUrl(connectorId, {
      redirectUri: flow.redirectUri,
      state: flow.state,
    }),
  );
}

/**
 * Forget a connection and its credential.
 *
 * The token is not revoked at the provider: only the source can do that, and
 * pretending otherwise would leave a live token behind a console that says it
 * is gone. What this does guarantee is that *we* can no longer use it.
 */
export async function disconnect(form: FormData): Promise<void> {
  const connectionId = String(form.get('connectionId') ?? '');
  const tenant = await currentTenant();
  const api = await harness();

  // The credential first. A connection removed with its secret still sealed
  // would leave an unreachable row holding a live token.
  await api.vault?.forget(tenant.id, connectionId);
  await api.connections.remove(tenant.id, connectionId);
}

/**
 * Where this console is reachable, as the browser sees it.
 *
 * The redirect URI has to match byte for byte at the token endpoint, so it is
 * read from the request rather than configured — a value written in two places
 * is a value that will disagree.
 */
async function origin(): Promise<string> {
  const header = await headers();
  const host = header.get('host') ?? '127.0.0.1:4100';
  const proto = header.get('x-forwarded-proto') ?? (host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
