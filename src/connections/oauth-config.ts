// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth providers, declared as configuration.
 *
 * A provider's endpoints, client id and scopes are declared per connector in
 * `config/connectors.json`, so adding an integration is editing config, not the
 * core. The one thing that must not live in the file is the client secret: it
 * is named there by its environment variable and resolved at load time, so no
 * secret is ever committed.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { OAuthProvider } from './oauth.js';

export const oauthProviderConfigSchema = z.object({
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  clientId: z.string().min(1),
  /** The environment variable holding the client secret — not the secret. */
  clientSecretEnv: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  authorizationParams: z.record(z.string(), z.string()).optional(),
});

export type OAuthProviderConfig = z.infer<typeof oauthProviderConfigSchema>;

/** Keyed by connector id, e.g. `{ "atlassian": { ... }, "google-drive": { ... } }`. */
export const connectorsConfigSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/, 'connector id must be lowercase with dashes'),
  oauthProviderConfigSchema,
);

export type ConnectorsConfig = z.infer<typeof connectorsConfigSchema>;

export class OAuthConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OAuthConfigError';
  }
}

/**
 * Resolve declared configs into usable providers, reading each client secret
 * from its environment variable.
 *
 * A named secret that is not set is a configuration error worth failing on —
 * an OAuth provider with no client secret cannot work, and finding that out at
 * the first token exchange is worse than finding it at startup.
 */
export function resolveProviders(
  config: ConnectorsConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, OAuthProvider> {
  const providers = new Map<string, OAuthProvider>();

  for (const [connectorId, entry] of Object.entries(config)) {
    const clientSecret = env[entry.clientSecretEnv];
    if (!clientSecret) {
      throw new OAuthConfigError(
        `connector "${connectorId}" names client secret in ${entry.clientSecretEnv}, which is not set`,
      );
    }

    providers.set(connectorId, {
      authorizationEndpoint: entry.authorizationEndpoint,
      tokenEndpoint: entry.tokenEndpoint,
      clientId: entry.clientId,
      clientSecret,
      scopes: entry.scopes,
      ...(entry.authorizationParams ? { authorizationParams: entry.authorizationParams } : {}),
    });
  }

  return providers;
}

/**
 * Load and resolve connector OAuth configs from a file.
 *
 * A missing file is not an error: a deployment that connects nothing has no
 * connectors config, and the connection layer simply runs without OAuth.
 */
export async function loadConnectorsConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, OAuthProvider>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return new Map();
  }

  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch (error) {
    throw new OAuthConfigError(`connectors config at ${path} is not valid JSON`, { cause: error });
  }

  const parsed = connectorsConfigSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new OAuthConfigError(`invalid connectors config in ${path}: ${detail}`);
  }

  return resolveProviders(parsed.data, env);
}
