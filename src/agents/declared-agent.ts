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
import type { ModuleDefinition } from '../modules/module.js';

import { grantsWrites, type AgentConfig, type ConnectionGrant } from './agent-config.js';

export interface DeclaredAgentDependencies {
  readonly operations: ConnectionOperations;
  /** So an agent can find out which connections it actually has. */
  readonly connections: ConnectionStore;
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
