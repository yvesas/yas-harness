// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { OAuthClient, OAuthError, isTokenExpired } from '../../src/connections/oauth.js';
import type { OAuthProvider, OAuthToken } from '../../src/connections/oauth.js';

const provider: OAuthProvider = {
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
  clientSecret: 'secret-xyz',
  scopes: ['read', 'write'],
  authorizationParams: { prompt: 'consent', access_type: 'offline' },
};

const FIXED_NOW = new Date('2026-07-23T12:00:00.000Z');

function stubFetch(payload: unknown, init: { status?: number } = {}) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      body: new URLSearchParams(options?.body as string),
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return new OAuthClient({ fetch, now: () => FIXED_NOW });
}

describe('OAuthClient', () => {
  describe('buildAuthorizationUrl', () => {
    it('builds a url with the standard and extra params', () => {
      const url = new URL(
        client(stubFetch({}).fetch).buildAuthorizationUrl(provider, {
          redirectUri: 'https://app.example.com/callback',
          state: 'opaque-state',
        }),
      );

      expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('client-123');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(url.searchParams.get('scope')).toBe('read write');
      expect(url.searchParams.get('state')).toBe('opaque-state');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('access_type')).toBe('offline');
    });

    it('does not put the client secret in the url', () => {
      const url = client(stubFetch({}).fetch).buildAuthorizationUrl(provider, {
        redirectUri: 'https://app/cb',
        state: 's',
      });

      expect(url).not.toContain('secret-xyz');
    });
  });

  describe('exchangeCode', () => {
    it('posts the code grant and returns the token with a computed expiry', async () => {
      const { fetch, calls } = stubFetch({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      });

      const token = await client(fetch).exchangeCode(provider, {
        code: 'the-code',
        redirectUri: 'https://app/cb',
      });

      expect(calls[0]?.url).toBe('https://auth.example.com/token');
      expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
      expect(calls[0]?.body.get('code')).toBe('the-code');
      expect(calls[0]?.body.get('client_secret')).toBe('secret-xyz');
      expect(token).toEqual({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        tokenType: 'Bearer',
        expiresAt: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
        scope: 'read write',
      });
    });

    it('treats a token with no expires_in as non-expiring', async () => {
      const { fetch } = stubFetch({ access_token: 'at', token_type: 'Bearer' });

      const token = await client(fetch).exchangeCode(provider, { code: 'c', redirectUri: 'u' });

      expect(token.expiresAt).toBeNull();
    });

    it('fails clearly when the response has no access_token', async () => {
      const { fetch } = stubFetch({ error: 'invalid_grant' });

      await expect(
        client(fetch).exchangeCode(provider, { code: 'c', redirectUri: 'u' }),
      ).rejects.toThrowError(/no access_token/);
    });

    it('marks a 5xx as retryable and a 400 as not', async () => {
      const server = stubFetch({ error: 'oops' }, { status: 503 });
      await expect(
        client(server.fetch).exchangeCode(provider, { code: 'c', redirectUri: 'u' }),
      ).rejects.toMatchObject({ detail: { retryable: true } });

      const bad = stubFetch({ error: 'bad' }, { status: 400 });
      await expect(
        client(bad.fetch).exchangeCode(provider, { code: 'c', redirectUri: 'u' }),
      ).rejects.toMatchObject({ detail: { retryable: false } });
    });

    it('marks a transport failure as retryable', async () => {
      const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));

      await expect(
        new OAuthClient({ fetch: fetch as unknown as typeof globalThis.fetch }).exchangeCode(
          provider,
          { code: 'c', redirectUri: 'u' },
        ),
      ).rejects.toBeInstanceOf(OAuthError);
    });
  });

  describe('refresh', () => {
    it('posts the refresh grant', async () => {
      const { fetch, calls } = stubFetch({
        access_token: 'at-2',
        refresh_token: 'rt-2',
        expires_in: 3600,
      });

      const token = await client(fetch).refresh(provider, 'rt-1');

      expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
      expect(calls[0]?.body.get('refresh_token')).toBe('rt-1');
      expect(token.accessToken).toBe('at-2');
      expect(token.refreshToken).toBe('rt-2');
    });

    it('keeps the old refresh token when the provider omits a new one', async () => {
      // Google and others do not return a refresh_token on refresh.
      const { fetch } = stubFetch({ access_token: 'at-2', expires_in: 3600 });

      const token = await client(fetch).refresh(provider, 'rt-original');

      expect(token.refreshToken).toBe('rt-original');
    });
  });
});

describe('isTokenExpired', () => {
  const at = (iso: string | null): OAuthToken => ({
    accessToken: 'a',
    refreshToken: null,
    tokenType: 'Bearer',
    expiresAt: iso,
    scope: null,
  });

  it('is never expired when there is no expiry', () => {
    expect(isTokenExpired(at(null), FIXED_NOW)).toBe(false);
  });

  it('is not expired well before expiry', () => {
    const future = new Date(FIXED_NOW.getTime() + 3600_000).toISOString();
    expect(isTokenExpired(at(future), FIXED_NOW)).toBe(false);
  });

  it('is expired past expiry', () => {
    const past = new Date(FIXED_NOW.getTime() - 1000).toISOString();
    expect(isTokenExpired(at(past), FIXED_NOW)).toBe(true);
  });

  it('is expired within the skew window, to avoid racing expiry', () => {
    const soon = new Date(FIXED_NOW.getTime() + 30_000).toISOString(); // 30s away
    expect(isTokenExpired(at(soon), FIXED_NOW, 60)).toBe(true); // 60s skew
  });
});
