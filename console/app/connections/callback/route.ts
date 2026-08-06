// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The callback — the loose end ADR 0007 left for a product.
 *
 * A **Route Handler**, not a page, and the reason is not style. Finishing a flow
 * clears the state cookie, and clearing a cookie is a mutation: Next allows that
 * in a Route Handler or a Server Action and nowhere else. This was a page first,
 * on the reasoning that the provider sends a *person* here rather than a
 * machine — true for rendering, and beside the point for the cookie. The real
 * flow failed on it at the first attempt.
 *
 * So the handler does the work and redirects back to Connections with the
 * outcome. That also puts somebody where they wanted to be, looking at a list
 * that now includes what they just connected.
 *
 * The order below is the security-relevant part: **state is checked before the
 * code is spent.** Trading a code first and validating afterwards would already
 * have attached the account by the time the check fails.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { completeFlow } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

/** Long enough to explain, short enough not to carry a provider's essay. */
const MAX_MESSAGE = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  // The provider said no — usually the person declined. Not a failure of ours,
  // and it must not read like one.
  const declined = params.get('error');
  if (declined) {
    const description = params.get('error_description');
    return back(request, {
      error: description ? `${declined}: ${description}` : declined,
    });
  }

  try {
    // State first, always. Spending the code before checking it would attach
    // the account and *then* discover the callback was forged.
    const flow = await completeFlow(params.get('state'));
    const code = params.get('code');
    if (!code) {
      throw new Error('the provider sent no authorization code');
    }

    const tenant = await currentTenant();
    const api = await harness();
    if (!api.onboarding) {
      throw new Error('no OAuth provider is configured');
    }

    const connection = await api.onboarding.complete(flow.connectorId, {
      tenantId: tenant.id,
      code,
      redirectUri: flow.redirectUri,
      ...(flow.accountLabel ? { accountLabel: flow.accountLabel } : {}),
    });

    return back(request, {
      connected: connection.connectorId,
      scopes: connection.scopes.join(' '),
    });
  } catch (error) {
    return back(request, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Back to the Connections page, carrying what happened.
 *
 * In the query string rather than a cookie or a flash message: there is nothing
 * secret in it — a connector id, the scopes granted, or why it failed — and a
 * URL somebody can re-read, screenshot or paste into a bug report is worth more
 * than a message that vanishes on refresh.
 *
 * A **relative** Location, which HTTP allows and the browser resolves against
 * the URL it is already on. `NextResponse.redirect` wants an absolute one, and
 * building it from the request would use the address the server is bound to —
 * inside a container that is `0.0.0.0`, which is not anywhere the browser can
 * go. Deriving it from the `host` header would work and is a guess; not
 * guessing is better.
 */
function back(_request: NextRequest, outcome: Record<string, string>): NextResponse {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(outcome)) {
    query.set(key, value.slice(0, MAX_MESSAGE));
  }
  return new NextResponse(null, {
    status: 303,
    // 303, not 307: the browser must follow with a GET. The provider sent one,
    // but a redirect that preserves the method is a promise this does not want
    // to make about a URL that finished a one-time code.
    headers: { location: `/connections?${query.toString()}` },
  });
}
