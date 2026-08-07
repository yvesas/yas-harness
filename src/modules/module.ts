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
import type { ContextDiscloser } from '../pools/context.js';

/**
 * What a module says about handling its own turns.
 *
 * Deliberately small. A module that needs more than an instruction and a couple
 * of limits is a module doing the product's job — and the harness has no
 * opinion about that job, which is the Golden Rule.
 */
export interface ModuleAgent {
  /**
   * Appended to the product's persona when this module is the one answering.
   *
   * Appended rather than substituted: a product's voice, safety rules and
   * language should survive whichever module handles a turn. A module that
   * could replace the whole system prompt could quietly undo them.
   */
  readonly instructions?: string;
  /**
   * The kind of work this module's turns are, when it differs.
   *
   * A module that only files notes can say `simple` and route to a cheap model;
   * one that reads contracts can say `sensitive` and never reach one. Absent,
   * the persona's own kind applies.
   */
  readonly task?: 'simple' | 'reasoning' | 'sensitive';
  /** Tool round-trips this module's turns may take. Absent, the persona's. */
  readonly maxToolIterations?: number;
}

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
  /**
   * How this module answers another module asking for its context.
   *
   * Optional, and its absence is a decision: a module that does not declare one
   * shares nothing. Sharing is opt-in per module and decided per request — the
   * owner sees the purpose and may reveal a summary instead of the rows, or
   * refuse with a reason. See `src/pools/context.ts`.
   */
  readonly disclose?: ContextDiscloser;
  /**
   * How this module works when the router hands it a turn.
   *
   * A module is a **semi-autonomous agent**, not a bag of tools: the central
   * agent delegates to it rather than micromanaging it (doc 13, decision 3). So
   * a module may say how it should behave, and what it says is layered on the
   * product's persona rather than replacing it — the product decides the voice,
   * the module decides the job.
   *
   * Every field is optional, and a module that declares none behaves exactly as
   * modules did before this existed: the product's persona, unchanged.
   */
  readonly agent?: ModuleAgent;
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
