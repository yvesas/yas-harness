// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Is this thing set up, and what is missing?
 *
 * The question every page had to answer for itself, badly. Connections knew it
 * needed a master key. The playground knew it needed a model key. Nothing knew
 * the whole picture, so somebody opening the console for the first time
 * discovered their setup one failed page at a time.
 *
 * This assembles it once. Every check reads a harness port — `readiness` for
 * the database, `vault` and `onboarding` for what a master key unlocks,
 * `models` for what was configured to route to — so nothing here duplicates a
 * rule that lives in the harness.
 *
 * A part is **not ready** only when something is genuinely wrong. A model key
 * that is absent is `optional`, not broken: everything except the playground
 * and the evals works without one, and colouring it red would teach people to
 * ignore red.
 */

import { readiness, type Harness } from 'yas-harness';

export type PartState = 'ready' | 'optional' | 'broken';

export interface Part {
  readonly name: string;
  readonly state: PartState;
  /** What it is, in one line, for somebody who has not read the architecture. */
  readonly what: string;
  /** What to do, when there is something to do. */
  readonly todo?: string;
  readonly href?: string;
}

export interface Integration {
  readonly connectorId: string;
  /** Connected accounts, most recent first. Empty when only configured. */
  readonly accounts: { id: string; label: string | null; status: string }[];
  /** True when `config/connectors.json` has an OAuth entry for it. */
  readonly connectable: boolean;
}

export interface Status {
  readonly parts: readonly Part[];
  readonly integrations: readonly Integration[];
  readonly ready: boolean;
}

export async function status(api: Harness, tenantId: string): Promise<Status> {
  const [health, connections] = await Promise.all([
    readiness([...api.probes], { lifecycle: api.lifecycle }),
    api.connections.list(tenantId),
  ]);

  const parts: Part[] = [database(health), vault(api), models(api), oauth(api), modulesPart(api)];

  return {
    parts,
    integrations: integrations(api, connections),
    // Only a broken part means not ready. An absent option is a choice nobody
    // has made yet, not a fault.
    ready: !parts.some((part) => part.state === 'broken'),
  };
}

function database(health: Awaited<ReturnType<typeof readiness>>): Part {
  const failed = health.checks.find((check) => !check.healthy);
  return {
    name: 'Database',
    state: health.healthy ? 'ready' : 'broken',
    what: 'Conversations, credentials, traces and cost — all of it, scoped per tenant.',
    ...(failed ? { todo: failed.error ?? 'The database did not answer.' } : {}),
  };
}

function vault(api: Harness): Part {
  const on = api.vault !== null;
  return {
    name: 'Credential vault',
    state: on ? 'ready' : 'optional',
    what: 'Encrypts what a connected source gave you. The agent never sees a key.',
    ...(on
      ? {}
      : {
          todo: 'No MASTER_ENCRYPTION_KEY, so nothing can be connected. ./start.sh generates one.',
        }),
  };
}

function models(api: Harness): Part {
  // The variable each provider named, and whether this process has it. The
  // name is the deployment's choice, which is why it has to be read from the
  // config rather than guessed.
  const missing = Object.entries(api.models.providers)
    .filter(([, provider]) => !process.env[provider.apiKeyEnv])
    .map(([name, provider]) => `${name} (${provider.apiKeyEnv})`);
  const total = Object.keys(api.models.providers).length;

  return {
    name: 'Model providers',
    state: missing.length < total ? 'ready' : 'optional',
    what: `${String(total)} configured. Routing sends cheap work to a cheap model and keeps sensitive work off it.`,
    ...(missing.length > 0
      ? { todo: `No key for: ${missing.join(', ')}. Only the playground and evals need one.` }
      : {}),
    href: '/config?file=models.json',
  };
}

function oauth(api: Harness): Part {
  const connectable = api.onboarding?.connectable() ?? [];
  return {
    name: 'Connectable sources',
    state: connectable.length > 0 ? 'ready' : 'optional',
    what: 'Sources you can authorise through the browser, from config/connectors.json.',
    ...(connectable.length === 0
      ? { todo: 'None configured. Copy an entry out of config/connectors.example.json.' }
      : {}),
    href: '/connections',
  };
}

function modulesPart(api: Harness): Part {
  const registered = api.modules.list();
  return {
    name: 'Modules',
    state: registered.length > 0 ? 'ready' : 'broken',
    what: 'What the router chooses between. A product registers its own; two demo ones ship.',
    ...(registered.length === 0
      ? { todo: 'None registered — the router has nothing to route to.' }
      : {}),
    href: '/modules',
  };
}

function integrations(
  api: Harness,
  connections: Awaited<ReturnType<Harness['connections']['list']>>,
): Integration[] {
  const ids = new Set<string>([
    ...(api.onboarding?.connectable() ?? []),
    ...connections.map((connection) => connection.connectorId),
  ]);

  return [...ids].sort().map((connectorId) => ({
    connectorId,
    accounts: connections
      .filter((connection) => connection.connectorId === connectorId)
      .map((connection) => ({
        id: connection.id,
        label: connection.accountLabel,
        status: connection.status,
      })),
    connectable: (api.onboarding?.connectable() ?? []).includes(connectorId),
  }));
}
