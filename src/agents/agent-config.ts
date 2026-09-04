// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * An agent, declared rather than written.
 *
 * Until now a module was TypeScript: to add one you wrote a file, registered it
 * and forked the repository. That made the person the console is *for* unable
 * to add the one thing that decides what their assistant does.
 *
 * A declared agent needs no code because the harness already has the tools. The
 * connector contract (ADR 0006) reduced every source to six resource-shaped
 * operations — list, read, search, create, update, delete — and the MCP server
 * has been exposing exactly those since ADR 0009. An agent's toolset is those
 * operations, over the connectors it was granted, and nothing else.
 *
 * So this file is a shape and a validator, and the Golden Rule survives it: an
 * id, a description, a prompt and a list of grants name no domain. The domain
 * lives in what somebody writes into the prompt, which is where it belongs.
 *
 * One file per agent, in `config/agents/`. Versioned in Git like the rest of
 * `config/` (doc 13, decision 1) — so a diff shows which agent changed, and
 * adding one does not touch the others.
 */

import { z } from 'zod';

/** Which of the six operations an agent may perform on a granted connector. */
export const grantedCapabilitySchema = z.enum([
  'list',
  'read',
  'search',
  'create',
  'update',
  'delete',
]);

export const connectionGrantSchema = z.object({
  /**
   * The connector, not a connection.
   *
   * A connection is a row a tenant owns, created at runtime with an id nobody
   * can write into a file that ships in Git. The grant is therefore "this agent
   * may work with GitHub", and at call time it reaches whichever GitHub
   * connections that tenant has.
   */
  connectorId: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  /**
   * What it may do there. Defaults to reading only.
   *
   * Read-only by default for the same reason MCP is (ADR 0009): granting a
   * source should not silently grant the ability to change it.
   */
  can: z.array(grantedCapabilitySchema).min(1).default(['list', 'read', 'search']),
});

export type ConnectionGrant = z.infer<typeof connectionGrantSchema>;

const WRITES = new Set(['create', 'update', 'delete']);

export const agentConfigSchema = z.object({
  /** Matches the file name, and is what the router returns. */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, 'id must be lowercase, digits and dashes'),
  /** For a person reading a list. */
  name: z.string().min(1),
  /**
   * What this agent is for, in the router's words.
   *
   * The router reads this and nothing else when deciding. A description that
   * does not distinguish this agent from its neighbours is the single most
   * common cause of a wrong route — worth saying what it does *and* what it
   * does not.
   */
  description: z.string().min(1),
  /** Appended to the product's persona when this agent answers. */
  instructions: z.string().min(1),
  /**
   * A model reference from `config/models.json`, when this agent wants a
   * specific one. Absent, the task kind below picks a tier.
   */
  model: z.string().min(1).optional(),
  task: z.enum(['simple', 'reasoning', 'sensitive']).optional(),
  maxToolIterations: z.number().int().min(1).max(20).optional(),
  /** Which sources it may reach, and what it may do there. */
  connections: z.array(connectionGrantSchema).default([]),
  /**
   * Which memory sources it may search, by slug.
   *
   * Slugs rather than ids, because this file is in Git and an id is a uuid
   * created at runtime. A slug that names no source is not an error at startup:
   * a grant can legitimately precede the source somebody is about to create,
   * and failing on it would make the order of two edits matter.
   *
   * Empty means it searches nothing. It does **not** mean everything — an empty
   * grant that read the whole corpus would be the opposite of what it says.
   */
  memory: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).default([]),
  /**
   * The one source it may **write** to, by slug. Absent means it writes none.
   *
   * Separate from `memory` and singular on purpose. Reading is a grant over a
   * set; writing is a decision about one place, and an agent that could write
   * into any source it can read would let anything it was shown become
   * something it asserts. A slug here may also appear in `memory` — an agent
   * usually should read back what it wrote — but it has to be named twice,
   * because the two permissions are not the same permission.
   */
  remembersTo: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,63}$/)
    .optional(),
  /**
   * Whether a write it performs pauses for a person.
   *
   * Defaults to **true**, and the default is the point: an agent assembled from
   * a form by somebody who did not read this file should not be able to delete
   * things unattended. Turning it off is a sentence somebody wrote.
   */
  approveWrites: z.boolean().default(true),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

export function parseAgentConfig(source: unknown, origin: string): AgentConfig {
  const parsed = agentConfigSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AgentConfigError(`invalid agent in ${origin}: ${detail}`);
  }

  const config = parsed.data;

  // A grant that names the same connector twice is ambiguous about which set of
  // capabilities applies, and merging them silently would grant the union —
  // which is the wrong way to resolve an ambiguity about permission.
  const seen = new Set<string>();
  for (const grant of config.connections) {
    if (seen.has(grant.connectorId)) {
      throw new AgentConfigError(
        `agent "${config.id}" grants "${grant.connectorId}" twice in ${origin}`,
      );
    }
    seen.add(grant.connectorId);
  }

  return config;
}

/** True when this agent was granted anything that changes a source. */
export function grantsWrites(config: AgentConfig): boolean {
  return config.connections.some((grant) => grant.can.some((capability) => WRITES.has(capability)));
}
