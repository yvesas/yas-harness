// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Module contract and registry.
 *
 * A module is how a product plugs its own capability into the harness: it
 * declares a name, a description the router reads, and the tools it exposes.
 * The harness holds the contract; the modules themselves live in the products
 * that fork this repo. Nothing about "customer" or "vocabulary" belongs here —
 * only the shape a module must have.
 */

import type { ToolRegistry } from '../core/tool.js';

export interface ModuleDefinition {
  /** Stable id used in routing decisions and traces. */
  readonly id: string;
  /**
   * What this module handles, in plain language. The router shows this to a
   * cheap model to decide whether an input belongs here, so it should read
   * like a description of the work, not a marketing line.
   */
  readonly description: string;
  /** The tools this module contributes to an agent that is routed to it. */
  readonly tools: ToolRegistry;
}

/** Module ids the router can name: lowercase, no spaces. */
const MODULE_ID = /^[a-z][a-z0-9_-]{1,63}$/;

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly moduleId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModuleError';
  }
}

/**
 * The set of modules registered with the harness.
 *
 * Registration is validated up front so a malformed module fails at startup,
 * not when the router first tries to reach it.
 */
export class ModuleRegistry {
  readonly #modules = new Map<string, ModuleDefinition>();

  register(module: ModuleDefinition): this {
    if (!MODULE_ID.test(module.id)) {
      throw new ModuleError(
        `module id must match ${MODULE_ID.source}; got "${module.id}"`,
        module.id,
      );
    }
    if (module.description.trim() === '') {
      // The router routes on this text; an empty one is unroutable.
      throw new ModuleError('module description must not be empty', module.id);
    }
    if (this.#modules.has(module.id)) {
      throw new ModuleError(`module "${module.id}" is already registered`, module.id);
    }

    this.#modules.set(module.id, module);
    return this;
  }

  get(id: string): ModuleDefinition | undefined {
    return this.#modules.get(id);
  }

  has(id: string): boolean {
    return this.#modules.has(id);
  }

  get size(): number {
    return this.#modules.size;
  }

  list(): ModuleDefinition[] {
    return [...this.#modules.values()];
  }
}
