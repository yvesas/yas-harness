// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  OAuthConfigError,
  connectorsConfigSchema,
  resolveProviders,
} from '../../src/connections/oauth-config.js';

const validEntry = {
  authorizationEndpoint: 'https://auth.atlassian.com/authorize',
  tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
  clientId: 'client-abc',
  clientSecretEnv: 'ATLASSIAN_CLIENT_SECRET',
  scopes: ['read:confluence-content.all', 'write:confluence-content'],
  authorizationParams: { audience: 'api.atlassian.com', prompt: 'consent' },
};

describe('connectors config schema', () => {
  it('accepts a well-formed entry', () => {
    expect(connectorsConfigSchema.safeParse({ atlassian: validEntry }).success).toBe(true);
  });

  it('rejects an entry with no scopes', () => {
    const parsed = connectorsConfigSchema.safeParse({
      atlassian: { ...validEntry, scopes: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-url endpoint', () => {
    const parsed = connectorsConfigSchema.safeParse({
      atlassian: { ...validEntry, tokenEndpoint: 'not a url' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a connector id the connection layer could not name', () => {
    const parsed = connectorsConfigSchema.safeParse({ 'Bad Id': validEntry });
    expect(parsed.success).toBe(false);
  });
});

describe('resolveProviders', () => {
  it('reads the client secret from its environment variable', () => {
    const providers = resolveProviders(
      { atlassian: validEntry },
      { ATLASSIAN_CLIENT_SECRET: 'the-secret' },
    );

    expect(providers.get('atlassian')).toMatchObject({
      clientId: 'client-abc',
      clientSecret: 'the-secret',
      scopes: ['read:confluence-content.all', 'write:confluence-content'],
      authorizationParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    });
  });

  it('fails when the named secret is not set', () => {
    expect(() => resolveProviders({ atlassian: validEntry }, {})).toThrowError(OAuthConfigError);
  });

  it('names the connector and the missing variable in the error', () => {
    expect(() => resolveProviders({ atlassian: validEntry }, {})).toThrowError(
      /connector "atlassian".*ATLASSIAN_CLIENT_SECRET.*not set/s,
    );
  });

  it('never carries the env-var name into the resolved provider', () => {
    const providers = resolveProviders({ atlassian: validEntry }, { ATLASSIAN_CLIENT_SECRET: 's' });

    expect(providers.get('atlassian')).not.toHaveProperty('clientSecretEnv');
  });
});
