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

import { PostgresApprovalStore } from './approval/postgres-approval-store.js';
import type { ApprovalStore } from './approval/approval-store.js';
import { ConnectionManager } from './connections/connection-manager.js';
import type { ConnectionStore } from './connections/connection-store.js';
import { ConnectorRegistry } from './connections/connector-registry.js';
import type { CredentialResolver } from './connections/credential-resolver.js';
import { VaultCredentialResolver } from './connections/credential-resolver.js';
import { CredentialVault } from './connections/credential-vault.js';
import { EnvelopeCipher } from './connections/envelope-cipher.js';
import { loadConnectorsConfig } from './connections/oauth-config.js';
import { OAuthClient } from './connections/oauth.js';
import { OAuthTokenRefresher } from './connections/oauth-token-refresher.js';
import {
  PostgresConnectionStore,
  PostgresCredentialStore,
  PostgresTenantKeyStore,
} from './connections/postgres-connection-store.js';
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
import { ModuleRegistry } from './modules/module.js';
import { PostgresPoolStore } from './pools/postgres-pool-store.js';
import type { PoolStore } from './pools/pool-store.js';
import { Router } from './router/router.js';
import { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';

export const HARNESS_NAME = 'yas-harness';

export interface Harness {
  readonly agent: Agent;
  readonly sessions: SessionStore;
  readonly gateway: ModelGateway;
  readonly tools: ToolRegistry;
  readonly modules: ModuleRegistry;
  readonly router: Router;
  readonly pools: PoolStore;
  readonly approvals: ApprovalStore;
  readonly connections: ConnectionStore;
  readonly connectors: ConnectorRegistry;
  /**
   * The credential vault. Present only when MASTER_ENCRYPTION_KEY is set — a
   * deployment that connects nothing does not need it, and starting one with a
   * missing key would be worse than starting without the vault.
   */
  readonly vault: CredentialVault | null;
  /**
   * Runs connector operations against a connection, resolving the credential
   * at call time. Present only when the vault is — it needs one to resolve.
   */
  readonly connectionManager: ConnectionManager | null;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly databaseUrl?: string;
  readonly personaId?: string;
  /** Root of the configuration tree; defaults to ./config. */
  readonly configDir?: string;
  /** Products register their module tools here before the first turn. */
  readonly tools?: ToolRegistry;
  /** Products register their business modules here; the router uses them. */
  readonly modules?: ModuleRegistry;
  /** Base64 master key for the credential vault; defaults to the env var. */
  readonly masterEncryptionKey?: string;
  /** Products register their connectors here; the connection manager uses them. */
  readonly connectors?: ConnectorRegistry;
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
  const modules = options.modules ?? new ModuleRegistry();
  const pools = new PostgresPoolStore(pool);
  const approvals = new PostgresApprovalStore(pool);
  const connections = new PostgresConnectionStore(pool);

  // The vault only exists if a master key is configured. Building it without
  // one would fail; skipping it lets a deployment that connects nothing run.
  const masterKey = options.masterEncryptionKey ?? process.env['MASTER_ENCRYPTION_KEY'];
  const vault = masterKey
    ? new CredentialVault(
        EnvelopeCipher.fromBase64(masterKey),
        new PostgresTenantKeyStore(pool),
        new PostgresCredentialStore(pool),
      )
    : null;

  const connectors = options.connectors ?? new ConnectorRegistry();

  // The manager needs a resolver, which needs the vault; without a vault there
  // is nothing to run a connector with. When connectors declare OAuth
  // providers, the resolver refreshes stale tokens transparently.
  let connectionManager: ConnectionManager | null = null;
  if (vault) {
    const providers = await loadConnectorsConfig(join(configDir, 'connectors.json'));
    const resolver: CredentialResolver =
      providers.size > 0
        ? new OAuthTokenRefresher(vault, new OAuthClient(), providers)
        : new VaultCredentialResolver(vault);
    connectionManager = new ConnectionManager(connectors, connections, resolver);
  }

  return {
    agent: new Agent({ gateway, sessions, tools, persona, approvals }),
    sessions,
    gateway,
    tools,
    modules,
    router: new Router(gateway, modules),
    pools,
    approvals,
    connections,
    connectors,
    vault,
    connectionManager,
    close: () => pool.end(),
  };
}

export { Agent, AgentError } from './core/agent.js';
export type { AgentReply, AgentTurn, ResumeInput, ToolInvocation } from './core/agent.js';
export { ApprovalError, ApprovalNotPendingError } from './approval/approval-store.js';
export type {
  Approval,
  ApprovalStatus,
  ApprovalStore,
  Decision,
} from './approval/approval-store.js';
export { InMemoryApprovalStore } from './approval/in-memory-approval-store.js';
export { PostgresApprovalStore } from './approval/postgres-approval-store.js';
export { ConnectionError } from './connections/connection-store.js';
export type {
  Connection,
  ConnectionStatus,
  ConnectionStore,
  CreateConnectionInput,
} from './connections/connection-store.js';
export {
  ConnectorError,
  ResourceNotFoundError,
  assertConnectorConsistent,
} from './connections/connector.js';
export type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from './connections/connector.js';
export { ConnectorRegistry } from './connections/connector-registry.js';
export { ConnectionManager, ConnectionManagerError } from './connections/connection-manager.js';
export { MemoryConnector } from './connections/memory-connector.js';
export type { MemoryConnectorOptions } from './connections/memory-connector.js';
export { ConfluenceConnector } from './connections/connectors/confluence-connector.js';
export type { ConfluenceConnectorOptions } from './connections/connectors/confluence-connector.js';
export { OAuthClient, OAuthError, isOAuthToken, isTokenExpired } from './connections/oauth.js';
export type { OAuthProvider, OAuthToken } from './connections/oauth.js';
export {
  OAuthConfigError,
  connectorsConfigSchema,
  loadConnectorsConfig,
  oauthProviderConfigSchema,
  resolveProviders,
} from './connections/oauth-config.js';
export type { ConnectorsConfig, OAuthProviderConfig } from './connections/oauth-config.js';
export { OAuthRefreshError, OAuthTokenRefresher } from './connections/oauth-token-refresher.js';
export { VaultCredentialResolver } from './connections/credential-resolver.js';
export type { CredentialResolver } from './connections/credential-resolver.js';
export { CipherError, EnvelopeCipher } from './connections/envelope-cipher.js';
export type { Sealed } from './connections/envelope-cipher.js';
export { CredentialVault, VaultError } from './connections/credential-vault.js';
export type { CredentialStore, TenantKeyStore } from './connections/credential-vault.js';
export {
  InMemoryConnectionStore,
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from './connections/in-memory-connection-store.js';
export {
  PostgresConnectionStore,
  PostgresCredentialStore,
  PostgresTenantKeyStore,
} from './connections/postgres-connection-store.js';
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
export { ModuleError, ModuleRegistry } from './modules/module.js';
export type { ModuleDefinition } from './modules/module.js';
export { Router, RouterError } from './router/router.js';
export type { RouteDecision, RouteInput } from './router/router.js';
export { evaluateRouter, failures, routerCaseSchema, routerCaseSetSchema } from './router/eval.js';
export type { CaseOutcome, EvalReport, RouterCase } from './router/eval.js';
export { InMemoryPoolStore } from './pools/in-memory-pool-store.js';
export { PostgresPoolStore } from './pools/postgres-pool-store.js';
export { PoolError, assertValidKey } from './pools/pool-store.js';
export type { PoolEntry, PoolScope, PoolStore } from './pools/pool-store.js';
