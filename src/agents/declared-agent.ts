// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A declared agent, as a module the router can choose.
 *
 * The tools are **generated from the grants** rather than written: the six
 * resource-shaped operations of the connector contract, kept only for the
 * capabilities this agent was given, over the connectors it was given them on.
 * An agent granted `read` on GitHub gets a read tool that reaches GitHub, and
 * no other tool exists for it to call.
 *
 * That is the whole reason a declared agent needs no code. It is also why the
 * Golden Rule survives: nothing here knows what a repository or a document
 * *means*, only that a source has resources and six things can be done to them.
 *
 * The tools are scoped **per connector**, not shared with a `connectorId`
 * argument. `github_read` is a different tool from `drive_read`, and an agent
 * granted only the first has no way to name the second. A single tool taking a
 * connector name would put the boundary in an argument the model chooses, which
 * is not where a permission boundary goes.
 */

import { z } from 'zod';

import type { ConnectionOperations } from '../connections/cached-connections.js';
import type { ConnectionStore } from '../connections/connection-store.js';
import type { ConnectorCapability, Resource } from '../connections/connector.js';
import { ToolRegistry, ok, failed } from '../core/tool.js';
import type { ToolDefinition } from '../core/tool.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ModuleDefinition } from '../modules/module.js';

import { grantsWrites, type AgentConfig, type ConnectionGrant } from './agent-config.js';

export interface DeclaredAgentDependencies {
  readonly operations: ConnectionOperations;
  /** So an agent can find out which connections it actually has. */
  readonly connections: ConnectionStore;
  /** Shared knowledge, when this deployment has any. */
  readonly memory?: MemoryStore;
}

/** Everything a listing hands a model — never a whole document. */
function summarise(resource: Resource): Record<string, unknown> {
  return {
    id: resource.id,
    type: resource.type,
    title: resource.title,
    ...(resource.url === null ? {} : { url: resource.url }),
  };
}

/** How many resources one call may put in front of a model. */
const PAGE = 25;

export function declaredAgent(
  config: AgentConfig,
  dependencies: DeclaredAgentDependencies,
): ModuleDefinition {
  const tools = new ToolRegistry();

  // How it discovers what it can reach. Without this, every other tool needs a
  // connection id the model has no way to learn.
  tools.register(connectionsTool(config, dependencies));

  for (const grant of config.connections) {
    for (const capability of grant.can) {
      const tool = toolFor(capability, grant, config, dependencies);
      if (tool) {
        tools.register(tool);
      }
    }
  }

  if (config.memory.length > 0 && dependencies.memory) {
    tools.register(memoryTool(config, dependencies.memory));
  }
  if (config.remembersTo !== undefined && dependencies.memory) {
    tools.register(rememberTool(config.remembersTo, dependencies.memory));
  }

  return {
    id: config.id,
    description: config.description,
    tools,
    agent: {
      instructions: config.instructions,
      ...(config.task === undefined ? {} : { task: config.task }),
      ...(config.maxToolIterations === undefined
        ? {}
        : { maxToolIterations: config.maxToolIterations }),
    },
  };
}

function connectionsTool(
  config: AgentConfig,
  dependencies: DeclaredAgentDependencies,
): ToolDefinition<Record<string, never>> {
  const granted = new Set(config.connections.map((grant) => grant.connectorId));

  return {
    name: 'my_connections',
    description:
      'List the connected sources this agent may use, with the id to pass to the other tools.',
    input: z.object({}),
    execute: async (_input, context) => {
      const all = await dependencies.connections.list(context.tenantId);
      // Filtered by grant, not merely unlisted: a connection this agent was not
      // granted must not be nameable, or the grant is a suggestion.
      const mine = all.filter((connection) => granted.has(connection.connectorId));

      if (mine.length === 0) {
        return ok(
          'No sources are connected for this agent yet. A person connects them in the console.',
        );
      }
      return ok(
        JSON.stringify(
          mine.map((connection) => ({
            connectionId: connection.id,
            source: connection.connectorId,
            account: connection.accountLabel,
            status: connection.status,
          })),
          null,
          2,
        ),
      );
    },
  };
}

/**
 * Searching the knowledge this agent was granted.
 *
 * Slugs are resolved to ids **at call time**, not at startup: a grant may name
 * a source somebody is about to create, and a source may be deleted and made
 * again. Resolving late costs one small query and means a grant never goes
 * stale.
 *
 * A slug that resolves to nothing is simply not searched. The alternative —
 * failing the call — would turn somebody's typo in a config file into an agent
 * that cannot answer anything.
 */
function memoryTool(config: AgentConfig, memory: MemoryStore): ToolDefinition<never> {
  const granted = config.memory;

  const tool: ToolDefinition<{ query: string }> = {
    name: 'memory_search',
    description:
      'Search the shared knowledge this agent may read. Use it before answering anything ' +
      'that might be written down. Returns passages, each with the document it came from.',
    input: z.object({ query: z.string().min(1) }),
    execute: async (input, context) => {
      const sources = await Promise.all(
        granted.map((slug) => memory.findSourceBySlug(context.tenantId, slug)),
      );
      const ids = sources.filter((source) => source !== null).map((source) => source.id);
      if (ids.length === 0) {
        return ok('No knowledge sources are available to this agent yet.');
      }

      const hits = await memory.search(context.tenantId, { sourceIds: ids, text: input.query });
      if (hits.length === 0) {
        // Said plainly, because the failure to avoid is a model treating "I
        // found nothing" as licence to invent.
        return ok('Nothing in the shared knowledge matched that. Say so rather than guessing.');
      }

      return ok(
        hits
          .map(
            (hit) =>
              `--- ${hit.title}${hit.url ? ` (${hit.url})` : ''} [${hit.sourceSlug}]\n${hit.text}`,
          )
          .join('\n\n'),
      );
    },
  };
  return tool as unknown as ToolDefinition<never>;
}

/**
 * Writing to memory, as a tool the model chooses to call.
 *
 * Deliberately not automatic extraction. A background pass that decides what
 * was worth keeping spends tokens on every turn, is invisible when it is wrong,
 * and cannot be measured — nobody can count how often it helped. A tool is the
 * opposite on all three: it costs nothing until called, the call is in the
 * trace, and its usefulness is countable.
 *
 * Two rules live here rather than in the store, because they are about *this*
 * writer rather than about the corpus:
 *
 *   - **`agent`, never `owner`.** The model asserting something does not make
 *     a person have said it, and the provenance column exists to keep those
 *     apart.
 *   - **Nothing already in memory is written back.** Content that reached the
 *     model *from* a search must not be re-extracted into a second copy: the
 *     copy is indistinguishable from independent corroboration, and a corpus
 *     that quietly agrees with itself is the failure mode of every memory that
 *     writes what it reads. So a remember searches first and refuses a
 *     near-identical passage.
 */
function rememberTool(slug: string, memory: MemoryStore): ToolDefinition<never> {
  // `importance?: number | undefined` rather than `importance?: number`: with
  // `exactOptionalPropertyTypes`, Zod's inferred output says the key may be
  // present and undefined, and the two are different types.
  const tool: ToolDefinition<{ title: string; body: string; importance?: number | undefined }> = {
    name: 'memory_remember',
    description:
      'Write something down so it survives this conversation. Use it for a durable fact or ' +
      'decision worth having later — not for a summary of what you just said, and not for ' +
      'anything you found with memory_search, which is already written down.',
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1),
      importance: z.number().int().min(1).max(10).optional(),
    }),
    execute: async (input, context) => {
      const source = await memory.findSourceBySlug(context.tenantId, slug);
      if (!source) {
        // The grant names a slug that does not exist yet. Not an error at
        // startup, by the same reasoning as the read grant — but by the time a
        // write is attempted, there is nowhere to put it.
        return failed(`There is no memory source called "${slug}" to write to.`);
      }

      const [nearest] = await memory.search(context.tenantId, {
        sourceIds: [source.id],
        text: input.body,
        limit: 1,
      });
      if (nearest && nearest.distance <= DUPLICATE_DISTANCE) {
        return ok(
          `Already remembered — "${nearest.title}" says this. Nothing was written; ` +
            `cite that instead of recording it twice.`,
        );
      }

      const outcome = await memory.ingest({
        tenantId: context.tenantId,
        sourceId: source.id,
        provenance: 'agent',
        title: input.title,
        body: input.body,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
      });
      return ok(`Remembered as "${outcome.document.title}" in ${slug}.`);
    },
  };
  return tool as unknown as ToolDefinition<never>;
}

/**
 * How close counts as "already written down".
 *
 * Much tighter than the search ceiling, which is a relevance question. This is
 * an identity question: 0.05 catches a restatement of the same passage and
 * leaves a genuinely new fact about the same subject alone.
 */
const DUPLICATE_DISTANCE = 0.05;

/** The argument every generated tool takes, checked against the grant at run time. */
const connectionId = z.string().min(1);

function toolFor(
  capability: ConnectorCapability,
  grant: ConnectionGrant,
  config: AgentConfig,
  dependencies: DeclaredAgentDependencies,
): ToolDefinition<never> | null {
  const { operations } = dependencies;
  const prefix = grant.connectorId.replaceAll('-', '_');
  const gated = grantsWrites(config) && config.approveWrites;

  /** Refuses a connection of the wrong connector, whatever id the model passed. */
  const guard = async (tenantId: string, id: string): Promise<void> => {
    const connection = await dependencies.connections.find(tenantId, id);
    if (!connection || connection.connectorId !== grant.connectorId) {
      // The model chooses this argument, so it is input. Without the check, a
      // tool granted on one source reaches another by being handed its id.
      throw new Error(`connection "${id}" is not a ${grant.connectorId} connection`);
    }
  };

  const build = <Input>(tool: ToolDefinition<Input>): ToolDefinition<never> =>
    tool as unknown as ToolDefinition<never>;

  switch (capability) {
    case 'list':
      return build({
        name: `${prefix}_list`,
        description: `List resources in a ${grant.connectorId} connection.`,
        input: z.object({ connectionId, parentId: z.string().optional() }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          const page = await operations.list(context.tenantId, input.connectionId, {
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            limit: PAGE,
          });
          return ok(JSON.stringify(page.resources.map(summarise), null, 2));
        },
      });

    case 'read':
      return build({
        name: `${prefix}_read`,
        description: `Read one ${grant.connectorId} resource, including its content.`,
        input: z.object({ connectionId, id: z.string().min(1) }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          const resource = await operations.read(context.tenantId, input.connectionId, input.id);
          return ok(resource.content ?? '(the resource has no text content)');
        },
      });

    case 'search':
      return build({
        name: `${prefix}_search`,
        description: `Search a ${grant.connectorId} connection for resources matching a query.`,
        input: z.object({ connectionId, query: z.string().min(1) }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          const page = await operations.search(context.tenantId, input.connectionId, input.query, {
            limit: PAGE,
          });
          return ok(JSON.stringify(page.resources.map(summarise), null, 2));
        },
      });

    case 'create':
      return build({
        name: `${prefix}_create`,
        description: `Create a resource in a ${grant.connectorId} connection.`,
        requiresApproval: gated,
        input: z.object({
          connectionId,
          title: z.string().min(1),
          content: z.string().optional(),
          parentId: z.string().optional(),
        }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          const created = await operations.create(context.tenantId, input.connectionId, {
            title: input.title,
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          });
          return ok(JSON.stringify(summarise(created), null, 2));
        },
      });

    case 'update':
      return build({
        name: `${prefix}_update`,
        description: `Change a ${grant.connectorId} resource that already exists.`,
        requiresApproval: gated,
        input: z.object({
          connectionId,
          id: z.string().min(1),
          title: z.string().optional(),
          content: z.string().optional(),
        }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          const updated = await operations.update(context.tenantId, input.connectionId, input.id, {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.content === undefined ? {} : { content: input.content }),
          });
          return ok(JSON.stringify(summarise(updated), null, 2));
        },
      });

    case 'delete':
      return build({
        name: `${prefix}_delete`,
        description: `Delete a ${grant.connectorId} resource. This cannot be undone.`,
        requiresApproval: gated,
        input: z.object({ connectionId, id: z.string().min(1) }),
        execute: async (input, context) => {
          await guard(context.tenantId, input.connectionId);
          await operations.delete(context.tenantId, input.connectionId, input.id);
          return ok(`Deleted ${input.id}.`);
        },
      });

    default:
      // Unreachable while the schema and the contract agree; returning null
      // rather than throwing keeps a future capability from breaking startup.
      return null;
  }
}

/** For a tool that failed in a way worth telling the model about. */
export { failed };
