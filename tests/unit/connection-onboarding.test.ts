// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * From "a person clicked connect" to "a connection with a sealed credential".
 *
 * The two cases that carry weight are about what must *not* happen: a client
 * secret reaching a caller that only wanted to render a button, and a
 * connection row surviving a credential that failed to seal.
 */

import { describe, expect, it } from 'vitest';

import {
  ConnectionOnboarding,
  grantedScopes,
  UnknownProviderError,
} from '../../src/connections/connection-onboarding.js';
import { InMemoryConnectionStore } from '../../src/connections/in-memory-connection-store.js';
import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import type { Sealed } from '../../src/connections/envelope-cipher.js';
import type { CredentialStore, TenantKeyStore } from '../../src/connections/credential-vault.js';
import { OAuthClient, OAuthError } from '../../src/connections/oauth.js';
import type { OAuthProvider, OAuthToken } from '../../src/connections/oauth.js';

const TENANT = 'tenant-1';
const REDIRECT = 'http://127.0.0.1:4100/connections/callback';

const provider: OAuthProvider = {
  authorizationEndpoint: 'https://provider.test/authorize',
  tokenEndpoint: 'https://provider.test/token',
  clientId: 'client-id',
  clientSecret: 'super-secret',
  scopes: ['files.read', 'files.write'],
  authorizationParams: { access_type: 'offline' },
};

function token(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresAt: '2026-08-04T12:00:00.000Z',
    scope: 'files.read',
    ...overrides,
  };
}

/** An OAuth client that answers as scripted, recording what it was asked. */
function client(answer: () => OAuthToken | Error = () => token()) {
  const exchanges: { code: string; redirectUri: string }[] = [];
  const fake = new OAuthClient();
  Object.defineProperty(fake, 'exchangeCode', {
    value: (_provider: OAuthProvider, params: { code: string; redirectUri: string }) => {
      exchanges.push(params);
      const outcome = answer();
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  });
  return { fake, exchanges };
}

function vaultWith(store?: CredentialStore) {
  const cipher = EnvelopeCipher.fromBase64(Buffer.alloc(32, 3).toString('base64'));
  const dek = cipher.newDataKey();
  const keys: TenantKeyStore = {
    ensure: () => Promise.resolve(dek.sealed),
    find: () => Promise.resolve(dek.sealed),
  };
  const rows = new Map<string, Sealed>();
  const credentials: CredentialStore = store ?? {
    put: (tenantId, connectionId, sealed) => {
      rows.set(`${tenantId}:${connectionId}`, sealed);
      return Promise.resolve();
    },
    get: (tenantId, connectionId) =>
      Promise.resolve(rows.get(`${tenantId}:${connectionId}`) ?? null),
    delete: (tenantId, connectionId) => Promise.resolve(rows.delete(`${tenantId}:${connectionId}`)),
  };
  return { vault: new CredentialVault(cipher, keys, credentials), rows };
}

function build(options: { answer?: () => OAuthToken | Error; credentials?: CredentialStore } = {}) {
  const connections = new InMemoryConnectionStore();
  const { fake, exchanges } = client(options.answer);
  const { vault, rows } = vaultWith(options.credentials);
  const onboarding = new ConnectionOnboarding(
    new Map([['drive', provider]]),
    fake,
    connections,
    vault,
  );
  return { onboarding, connections, vault, exchanges, rows };
}

describe('starting a flow', () => {
  it('builds an authorization url without handing out the secret', () => {
    const { onboarding } = build();

    const url = onboarding.authorizationUrl('drive', { redirectUri: REDIRECT, state: 'st-1' });

    expect(url).toContain('client_id=client-id');
    expect(url).toContain('state=st-1');
    expect(url).toContain('access_type=offline');
    // The reason callers name a connector instead of passing a provider: a
    // client secret must not reach every surface that renders a button.
    expect(url).not.toContain('super-secret');
  });

  it('says what a person is about to be asked for', () => {
    expect(build().onboarding.scopesFor('drive')).toEqual(['files.read', 'files.write']);
  });

  it('lists what can be connected at all', () => {
    expect(build().onboarding.connectable()).toEqual(['drive']);
  });

  it('names the connector when nothing is configured for it', () => {
    // The answer is a config file and two environment variables, so the error
    // should say that rather than "not found".
    expect(() =>
      build().onboarding.authorizationUrl('notion', { redirectUri: REDIRECT, state: 'x' }),
    ).toThrow(UnknownProviderError);
  });
});

describe('finishing a flow', () => {
  it('records the connection and seals the credential', async () => {
    const { onboarding, connections, vault, exchanges } = build();

    const connection = await onboarding.complete('drive', {
      tenantId: TENANT,
      code: 'auth-code',
      redirectUri: REDIRECT,
      accountLabel: 'work drive',
    });

    expect(exchanges).toEqual([{ code: 'auth-code', redirectUri: REDIRECT }]);
    expect(await connections.list(TENANT)).toHaveLength(1);
    expect(connection.accountLabel).toBe('work drive');
    // The only way back to the token is the vault, at call time.
    expect(await vault.resolve<OAuthToken>(TENANT, connection.id)).toMatchObject({
      accessToken: 'access-1',
    });
  });

  it('splits the scopes GitHub returns, which are comma-separated', async () => {
    // RFC 6749 says space-separated and GitHub answers with commas. Splitting
    // on the specification alone stored one scope named
    // "public_repo,read:user" — a string that looks right on a page and is
    // wrong in every comparison. Found by connecting a real account.
    const { onboarding } = build({ answer: () => token({ scope: 'public_repo,read:user' }) });

    const connection = await onboarding.complete('drive', {
      tenantId: TENANT,
      code: 'auth-code',
      redirectUri: REDIRECT,
    });

    expect(connection.scopes).toEqual(['public_repo', 'read:user']);
  });

  it('records the scopes granted, not the ones asked for', async () => {
    const { onboarding } = build();

    const connection = await onboarding.complete('drive', {
      tenantId: TENANT,
      code: 'auth-code',
      redirectUri: REDIRECT,
    });

    // A person can decline part of a consent screen. Storing the request would
    // make the console show an access the token does not carry.
    expect(connection.scopes).toEqual(['files.read']);
  });

  it('falls back to the requested scopes when the provider reports none', async () => {
    const { onboarding } = build({ answer: () => token({ scope: null }) });

    const connection = await onboarding.complete('drive', {
      tenantId: TENANT,
      code: 'auth-code',
      redirectUri: REDIRECT,
    });

    expect(connection.scopes).toEqual(['files.read', 'files.write']);
  });

  it('never returns the token', async () => {
    const { onboarding } = build();

    const connection = await onboarding.complete('drive', {
      tenantId: TENANT,
      code: 'auth-code',
      redirectUri: REDIRECT,
    });

    expect(JSON.stringify(connection)).not.toContain('access-1');
  });

  it('leaves nothing behind when the exchange fails', async () => {
    const { onboarding, connections } = build({
      answer: () => new OAuthError('invalid_grant', { provider: 'drive', retryable: false }),
    });

    await expect(
      onboarding.complete('drive', { tenantId: TENANT, code: 'stale', redirectUri: REDIRECT }),
    ).rejects.toThrow(/invalid_grant/);

    expect(await connections.list(TENANT)).toHaveLength(0);
  });

  it('undoes the connection when the credential cannot be sealed', async () => {
    const { onboarding, connections } = build({
      credentials: {
        put: () => Promise.reject(new Error('disk is full')),
        get: () => Promise.resolve(null),
        delete: () => Promise.resolve(false),
      },
    });

    await expect(
      onboarding.complete('drive', { tenantId: TENANT, code: 'auth-code', redirectUri: REDIRECT }),
    ).rejects.toThrow(/could not store the credential/);

    // A connection that looks connected and cannot authenticate fails later, at
    // a call, and reads as the source being down.
    expect(await connections.list(TENANT)).toHaveLength(0);
  });
});

describe('however a provider delimits its scopes', () => {
  it('splits on spaces, as the specification says', () => {
    expect(grantedScopes('files.read files.write')).toEqual(['files.read', 'files.write']);
  });

  it('splits on commas, as GitHub actually answers', () => {
    expect(grantedScopes('public_repo,read:user')).toEqual(['public_repo', 'read:user']);
  });

  it('survives a provider that uses both, or is untidy about it', () => {
    // Neither character is legal *inside* a scope — RFC 6749 draws scope tokens
    // from a set excluding both — so splitting on either can only separate
    // scopes, never cut one in half.
    expect(grantedScopes(' a, b ,  c ')).toEqual(['a', 'b', 'c']);
  });

  it('says nothing was granted when nothing was reported', () => {
    expect(grantedScopes(null)).toEqual([]);
    expect(grantedScopes('')).toEqual([]);
  });
});
