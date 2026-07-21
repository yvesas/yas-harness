// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition root: where adapters are wired into the core.
 *
 * This is the only file allowed to know both sides. The core imports ports;
 * nothing in `core/` imports an adapter.
 */

import { join } from 'node:path';

import pg from 'pg';

import { Agent } from './core/agent.js';
import { loadPersona } from './core/persona.js';
import { ToolRegistry } from './core/tool.js';
import { PostgresSessionStore } from './memory/postgres-session-store.js';
import type { SessionStore } from './memory/session-store.js';
import { AnthropicProvider } from './models/anthropic-provider.js';
import { GroqProvider } from './models/groq-provider.js';
import type { ModelGateway } from './models/model-gateway.js';
import type { ModelProvider } from './models/model-provider.js';
import { RoutedGateway } from './models/routed-gateway.js';
import { loadModelConfig } from './models/routing.js';
import { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';

export const HARNESS_NAME = 'yas-harness';

export interface Harness {
  readonly agent: Agent;
  readonly sessions: SessionStore;
  readonly gateway: ModelGateway;
  readonly tools: ToolRegistry;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly databaseUrl?: string;
  readonly personaId?: string;
  /** Root of the configuration tree; defaults to ./config. */
  readonly configDir?: string;
  /** Products register their module tools here before the first turn. */
  readonly tools?: ToolRegistry;
}

/**
 * Build a harness from configuration and environment.
 *
 * Products that need a different provider or store construct `Agent`
 * themselves — this is the convenient default, not the only way in.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set; copy .env.example to .env');
  }

  const configDir = options.configDir ?? join(process.cwd(), 'config');
  const persona = await loadPersona(options.personaId ?? 'default', join(configDir, 'personas'));
  const modelConfig = await loadModelConfig(join(configDir, 'models.json'));

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const sessions = new PostgresSessionStore(pool);

  // Only providers the configuration actually routes to are constructed, so a
  // deployment that uses one provider does not need the other's credentials.
  const routedProviders = new Set(Object.values(modelConfig.models).map((entry) => entry.provider));
  const providers: ModelProvider[] = [];
  if (routedProviders.has('anthropic')) providers.push(new AnthropicProvider());
  if (routedProviders.has('groq')) providers.push(new GroqProvider());

  const gateway = new RoutedGateway({
    config: modelConfig,
    providers,
    recorder: new PostgresUsageRecorder(pool),
  });
  const tools = options.tools ?? new ToolRegistry();

  return {
    agent: new Agent({ gateway, sessions, tools, persona }),
    sessions,
    gateway,
    tools,
    close: () => pool.end(),
  };
}

export { Agent } from './core/agent.js';
export type { AgentReply, AgentTurn, ToolInvocation } from './core/agent.js';
export { loadPersona, parsePersona } from './core/persona.js';
export type { Persona } from './core/persona.js';
export { ToolRegistry, failed, ok } from './core/tool.js';
export type { ToolContext, ToolDefinition, ToolResult } from './core/tool.js';
export { InMemorySessionStore } from './memory/in-memory-session-store.js';
export { PostgresSessionStore } from './memory/postgres-session-store.js';
export type { Session, SessionStore, StoredMessage } from './memory/session-store.js';
export { AnthropicProvider } from './models/anthropic-provider.js';
export { GroqProvider } from './models/groq-provider.js';
export { ModelGatewayError } from './models/model-gateway.js';
export type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  RequestAttribution,
  TaskKind,
  TokenUsage,
} from './models/model-gateway.js';
export type { ModelProvider, ProviderCall } from './models/model-provider.js';
export { RoutedGateway } from './models/routed-gateway.js';
export { ScriptedGateway, callsTool, says } from './models/scripted-gateway.js';
export { loadModelConfig, parseModelConfig } from './models/routing.js';
export type { ModelConfig, ModelEntry, ModelTier } from './models/routing.js';
export { InMemoryUsageRecorder, computeCostUsd } from './telemetry/model-usage.js';
export type { ModelUsageRecord, UsageRecorder } from './telemetry/model-usage.js';
export { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';
