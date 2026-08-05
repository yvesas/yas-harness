// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The shipped example must be a file the harness can load.
 *
 * It had stopped being one, in two ways at once: a `"//"` comment key the
 * schema rejects, and a Notion entry with no scopes when at least one was
 * required. Neither showed up anywhere, because nothing read the example —
 * it was documentation that happened to be JSON.
 *
 * The instructions say to copy it. So this copies it, and refuses the release
 * if what comes out will not load.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConnectorsConfig } from '../../src/connections/oauth-config.js';

const EXAMPLE = join(process.cwd(), 'config', 'connectors.example.json');

/** Every secret the example names, so the loader has something to resolve. */
const SECRETS: NodeJS.ProcessEnv = {
  ATLASSIAN_CLIENT_SECRET: 'test',
  GITHUB_CLIENT_SECRET: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  SLACK_CLIENT_SECRET: 'test',
  NOTION_CLIENT_SECRET: 'test',
  CALENDLY_CLIENT_SECRET: 'test',
  MICROSOFT_CLIENT_SECRET: 'test',
};

describe('the shipped connectors example', () => {
  it('loads', async () => {
    const providers = await loadConnectorsConfig(EXAMPLE, SECRETS);

    expect(providers.size).toBeGreaterThan(0);
    expect(providers.has('github')).toBe(true);
  });

  it('names its secrets rather than carrying them', async () => {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(EXAMPLE, 'utf8'));

    // This file is in Git. `clientSecretEnv` names a variable; `clientSecret`
    // would be the secret itself.
    expect(raw).not.toMatch(/"clientSecret"\s*:/);
  });

  it('says which variable each secret comes from', async () => {
    const providers = await loadConnectorsConfig(EXAMPLE, SECRETS);

    // Resolved from the environment passed in — so every name in the file is
    // one a deployment can actually set, not one nobody reads.
    for (const provider of providers.values()) {
      expect(provider.clientSecret).toBe('test');
    }
  });
});
