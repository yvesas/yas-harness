// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Central router: given an input, decide which module handles it.
 *
 * It runs on the cheap tier (TaskKind: routing) — deciding "is this about the
 * calendar or about money?" is not work worth a premium model. The decision
 * carries a confidence and a reason so it can be traced and, later, evaluated.
 */

import { z } from 'zod';

import type { ModelGateway, RequestAttribution } from '../models/model-gateway.js';
import { responseText, userMessage } from '../models/model-gateway.js';
import type { ModuleRegistry } from '../modules/module.js';

export interface RouteDecision {
  readonly moduleId: string;
  /** 0..1 — how sure the router is. A short-circuited single module is 1. */
  readonly confidence: number;
  /** Why this module, in the router's words. For traces and evals. */
  readonly reason: string;
}

export interface RouteInput {
  readonly text: string;
  readonly attribution?: RequestAttribution;
}

export class RouterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RouterError';
  }
}

/** What the routing model is asked to return. */
const decisionSchema = z.object({
  moduleId: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const ROUTING_SYSTEM = [
  'You are a router. Given a user message and a list of modules, choose the one',
  'module best suited to handle the message. Reply with a single JSON object and',
  'nothing else: {"moduleId": "<id>", "confidence": <0..1>, "reason": "<short>"}.',
  'The moduleId must be exactly one of the listed ids. confidence is your',
  'certainty from 0 to 1. Keep reason to one sentence.',
].join(' ');

export class Router {
  readonly #gateway: ModelGateway;
  readonly #modules: ModuleRegistry;

  constructor(gateway: ModelGateway, modules: ModuleRegistry) {
    this.#gateway = gateway;
    this.#modules = modules;
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    const modules = this.#modules.list();
    if (modules.length === 0) {
      throw new RouterError('no modules registered to route to');
    }

    // One module needs no model call — a routing decision with a single
    // option is not a decision, and it is the common early case.
    if (modules.length === 1) {
      return { moduleId: modules[0]!.id, confidence: 1, reason: 'only module registered' };
    }

    const catalogue = modules.map((module) => `- ${module.id}: ${module.description}`).join('\n');

    const response = await this.#gateway.complete({
      task: 'routing',
      system: ROUTING_SYSTEM,
      messages: [userMessage(`Modules:\n${catalogue}\n\nUser message:\n${input.text}`)],
      ...(input.attribution ? { attribution: input.attribution } : {}),
    });

    const decision = this.#parse(responseText(response));

    if (!this.#modules.has(decision.moduleId)) {
      // The model named something that is not on the menu. That is a routing
      // failure, not a module to invent — surface it rather than guess.
      throw new RouterError(
        `router chose unknown module "${decision.moduleId}"; valid ids: ${modules
          .map((module) => module.id)
          .join(', ')}`,
      );
    }

    return decision;
  }

  #parse(text: string): RouteDecision {
    const json = extractJsonObject(text);
    if (json === null) {
      throw new RouterError(`router returned no JSON object: ${truncate(text)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new RouterError(`router returned invalid JSON: ${truncate(text)}`, { cause: error });
    }

    const result = decisionSchema.safeParse(parsed);
    if (!result.success) {
      throw new RouterError(
        `router decision did not match the expected shape: ${result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }

    return result.data;
  }
}

/**
 * Pull the first balanced `{...}` object out of the text.
 *
 * A cheap model often wraps its JSON in prose or a code fence despite being
 * told not to; taking the first balanced object is more forgiving than
 * demanding the whole reply parse, without inventing structure that is not
 * there.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}
