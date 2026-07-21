// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Tools: the actions an agent can take beyond producing text.
 *
 * A tool declares its input with a Zod schema, and the registry derives the
 * JSON Schema the model sees from it — one definition, no drift between what
 * is advertised and what is validated.
 */

import { z } from 'zod';

import type { ToolSchema } from '../models/model-gateway.js';

/** Everything a tool is allowed to know about the call it is serving. */
export interface ToolContext {
  readonly tenantId: string;
  readonly sessionId: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export interface ToolDefinition<Input = unknown> {
  readonly name: string;
  /** Read by the model to decide when to call this tool — be specific. */
  readonly description: string;
  readonly input: z.ZodType<Input>;
  /**
   * Marks an action as destructive or outward-facing. Until the approval
   * queue exists, the agent refuses to run these rather than running them
   * unchecked.
   */
  readonly requiresApproval?: boolean;
  execute(input: Input, context: ToolContext): Promise<ToolResult>;
}

/** Tool names the model can address: lowercase, no spaces. */
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export class ToolError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

export function ok(content: string): ToolResult {
  return { content, isError: false };
}

export function failed(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * The set of tools available to one agent.
 *
 * Registration is validated up front so a malformed tool fails at startup
 * rather than halfway through a conversation.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never>>();

  register<Input>(tool: ToolDefinition<Input>): this {
    if (!TOOL_NAME.test(tool.name)) {
      throw new ToolError(
        `tool name must match ${TOOL_NAME.source}; got "${tool.name}"`,
        tool.name,
      );
    }
    if (tool.description.trim() === '') {
      throw new ToolError('tool description must not be empty', tool.name);
    }
    if (this.#tools.has(tool.name)) {
      throw new ToolError(`tool "${tool.name}" is already registered`, tool.name);
    }

    this.#tools.set(tool.name, tool as unknown as ToolDefinition<never>);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  /** What the model is told about these tools. */
  schemas(): ToolSchema[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input),
    }));
  }

  requiresApproval(name: string): boolean {
    return this.#tools.get(name)?.requiresApproval === true;
  }

  /**
   * Validate the model's input and run the tool.
   *
   * Both a schema violation and a thrown tool are returned as error results
   * rather than exceptions: the model gets to see what went wrong and correct
   * itself, which is the whole point of feeding the result back.
   */
  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return failed(`unknown tool "${name}"`);
    }

    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      return failed(`invalid input for "${name}": ${describeIssues(parsed.error)}`);
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (error) {
      // The agent must keep going; the trace keeps the detail.
      return failed(`tool "${name}" failed: ${errorMessage(error)}`);
    }
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
