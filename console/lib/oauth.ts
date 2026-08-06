// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The half of OAuth the harness deliberately does not own.
 *
 * ADR 0007 stops at the mechanics: the harness builds the authorization URL and
 * trades the code for tokens, and says *"a product wires the callback"*. This is
 * that wiring. It is the reason the console exists — OAuth needs a browser, so
 * it is the one thing a config file and a script cannot do at all.
 *
 * ## How `state` is kept, and why there is no key involved
 *
 * `state` defends against CSRF: without it, an attacker can hand somebody a
 * callback URL carrying *the attacker's* authorization code and quietly connect
 * the attacker's account to the victim's tenant.
 *
 * The harness mints nothing here on purpose — it treats `state` as opaque. So
 * the console generates 32 random bytes, puts them in an **HttpOnly cookie**
 * along with which connector the flow is for, and sends the same value in the
 * URL. On the callback the two must match.
 *
 * That needs no signing key, and that is the point. The cookie is unreadable
 * and unwritable from script, so an attacker cannot make one that matches the
 * URL they crafted; comparing a value they cannot see is enough. Signing would
 * add a key to manage and defend exactly nothing more.
 *
 * The cookie is short-lived, `SameSite=Lax` (the provider redirects back with a
 * GET, which Lax allows, while a cross-site POST would not carry it), and it is
 * cleared the moment the callback is handled — a state that outlives its flow
 * is one that can be replayed.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const STATE_COOKIE = 'yas_oauth_state';

/** Long enough for a person to finish a consent screen, short enough to expire. */
const STATE_TTL_SECONDS = 600;

export interface PendingFlow {
  readonly state: string;
  readonly connectorId: string;
  /** Echoed back to the token endpoint, which requires it to match exactly. */
  readonly redirectUri: string;
  /**
   * What to call this connection, if the person said.
   *
   * It travels in the cookie because it has to survive the round trip through
   * the provider, and there is nowhere else for it to wait: the connection does
   * not exist yet, and the query string comes back from the provider carrying
   * only what the provider was given.
   */
  readonly accountLabel?: string;
}

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

/** Where the provider sends the browser back. */
export function redirectUri(origin: string): string {
  return new URL('/connections/callback', origin).toString();
}

/** Start a flow: mint the state, remember it, and hand it back for the URL. */
export async function beginFlow(
  connectorId: string,
  origin: string,
  accountLabel?: string,
): Promise<PendingFlow> {
  const flow: PendingFlow = {
    state: randomBytes(32).toString('base64url'),
    connectorId,
    redirectUri: redirectUri(origin),
    ...(accountLabel ? { accountLabel } : {}),
  };

  (await cookies()).set(STATE_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    // Lax, not Strict: the provider sends the browser back with a top-level
    // GET, which Lax allows and Strict would drop — losing the state on every
    // successful flow.
    sameSite: 'lax',
    // Only over TLS in production. Left off locally because the console binds
    // 127.0.0.1 over plain HTTP, where `secure` would stop the cookie existing.
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  });

  return flow;
}

/**
 * Finish a flow, or refuse it.
 *
 * Clears the cookie **whatever the outcome**: a state that survives its own
 * callback is one an attacker can try again against.
 */
export async function completeFlow(state: string | null): Promise<PendingFlow> {
  const jar = await cookies();
  const raw = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  if (!raw) {
    throw new OAuthFlowError(
      'no OAuth flow is in progress. Start from the Connections page — a callback ' +
        'that arrives on its own is either an expired attempt or a forged one.',
    );
  }
  if (state === null) {
    throw new OAuthFlowError('the provider sent no state back, so this callback cannot be trusted');
  }

  const flow = JSON.parse(raw) as PendingFlow;
  if (!sameValue(flow.state, state)) {
    // The whole point of `state`: without this check, a crafted callback can
    // connect the attacker's account to whoever opens the link.
    throw new OAuthFlowError('the state does not match the flow this browser started');
  }
  return flow;
}

/** Constant-time, so a mismatch does not leak where it diverged. */
function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
