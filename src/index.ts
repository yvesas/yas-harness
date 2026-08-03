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
import { RedactingApprovalStore } from './approval/redacting-approval-store.js';
import type { ApprovalStore } from './approval/approval-store.js';
import { CachedConnections } from './connections/cached-connections.js';
import { ConnectionManager } from './connections/connection-manager.js';
import type { ConnectionStore } from './connections/connection-store.js';
import { ConnectorRegistry } from './connections/connector-registry.js';
import type { CredentialResolver } from './connections/credential-resolver.js';
import { VaultCredentialResolver } from './connections/credential-resolver.js';
import { CredentialVault } from './connections/credential-vault.js';
import { EnvelopeCipher } from './connections/envelope-cipher.js';
import { loadConnectorsConfig } from './connections/oauth-config.js';
import { PostgresResourceCacheStore } from './connections/postgres-resource-cache-store.js';
import type { ResourceCacheStore } from './connections/resource-cache-store.js';
import { OAuthClient } from './connections/oauth.js';
import { OAuthTokenRefresher } from './connections/oauth-token-refresher.js';
import {
  PostgresConnectionStore,
  PostgresCredentialStore,
  PostgresTenantKeyStore,
} from './connections/postgres-connection-store.js';
import { compressorFor } from './compression/profiles.js';
import type { CompressionProfile } from './compression/profiles.js';
import { Agent } from './core/agent.js';
import { loadPersona } from './core/persona.js';
import { ToolRegistry } from './core/tool.js';
import { McpServer } from './mcp/mcp-server.js';
import { PostgresSessionStore } from './memory/postgres-session-store.js';
import { RedactingSessionStore } from './memory/redacting-session-store.js';
import type { SessionStore } from './memory/session-store.js';
import { AnthropicProvider } from './models/anthropic-provider.js';
import { GroqProvider } from './models/groq-provider.js';
import type { ModelGateway } from './models/model-gateway.js';
import type { ModelProvider } from './models/model-provider.js';
import { RoutedGateway } from './models/routed-gateway.js';
import { loadModelConfig } from './models/routing.js';
import { ModuleRegistry } from './modules/module.js';
import { PostgresPoolStore } from './pools/postgres-pool-store.js';
import { RedactingPoolStore } from './pools/redacting-pool-store.js';
import type { PoolStore } from './pools/pool-store.js';
import { ContextBroker } from './pools/context-broker.js';
import { RegexSecretRedactor } from './redaction/regex-secret-redactor.js';
import { PostgresTenantStore } from './tenants/postgres-tenant-store.js';
import type { TenantStore } from './tenants/tenant-store.js';
import { Router } from './router/router.js';
import { PostgresTraceRecorder } from './telemetry/postgres-trace-recorder.js';
import { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';
import { RedactingTraceRecorder } from './telemetry/redacting-trace-recorder.js';
import { RedactingUsageRecorder } from './telemetry/redacting-usage-recorder.js';
import type { TraceReader, TraceRecorder } from './telemetry/trace.js';
import type { UsageReader } from './telemetry/model-usage.js';

export const HARNESS_NAME = 'yas-harness';

export interface Harness {
  readonly agent: Agent;
  readonly sessions: SessionStore;
  readonly gateway: ModelGateway;
  readonly tools: ToolRegistry;
  readonly modules: ModuleRegistry;
  readonly router: Router;
  /**
   * The isolation boundary: create the tenant every other call needs.
   * Without this a product's very first action has no API.
   */
  readonly tenants: TenantStore;
  readonly pools: PoolStore;
  /**
   * Carries a context request to the module that owns the data. A module that
   * declares no `disclose` shares nothing, so this is safe to hand out.
   */
  readonly context: ContextBroker;
  /** Where each step of a turn is written, redacted on the way. */
  readonly traces: TraceRecorder;
  /** Reading turns back: one turn's steps, or the most recent turns. */
  readonly traceReader: TraceReader;
  /** What a tenant or a conversation has spent. */
  readonly usage: UsageReader;
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
  /** Snapshots of connected resources; browsable and prunable on its own. */
  readonly resourceCache: ResourceCacheStore;
  /**
   * The connection manager behind a read-through/refresh/invalidate cache.
   * Present only when the connection manager is.
   */
  readonly cachedConnections: CachedConnections | null;
  /**
   * A read-only MCP server exposing the connectors as tools, over the cache.
   * Present only when the connection manager is. Products that want to expose
   * writes construct their own `McpServer` with `allow`.
   */
  readonly mcpServer: McpServer | null;
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
  /**
   * How hard to compress context before it reaches a model. Defaults to
   * `none`, and `none` wires no compressor at all rather than an identity one —
   * so a null saving in `model_usage` keeps meaning "compression was never on".
   * Turn this up only once `evaluateCompression` says answers hold (E5.5).
   */
  readonly compressionProfile?: CompressionProfile;
  /**
   * Use this gateway instead of building the routed one from
   * `config/models.json`.
   *
   * Exists so a harness can be built without a provider key — a `ScriptedGateway`
   * makes the whole composition testable, which is otherwise impossible: the
   * providers are constructed eagerly and each one needs its own key. A product
   * that wants to test its own wiring, or run offline, passes one here.
   */
  readonly gateway?: ModelGateway;
}

/**
 * Only the providers the configuration actually routes to are constructed, so a
 * deployment that uses one provider does not need the other's credentials.
 */
function routedProvidersFor(modelConfig: Awaited<ReturnType<typeof loadModelConfig>>) {
  const routed = new Set(Object.values(modelConfig.models).map((entry) => entry.provider));
  const providers: ModelProvider[] = [];
  if (routed.has('anthropic')) providers.push(new AnthropicProvider());
  if (routed.has('groq')) providers.push(new GroqProvider());
  return providers;
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
  // Redaction is always on: every free-text path to the database or a log is
  // wrapped so a secret never lands there in the clear.
  const redactor = new RegexSecretRedactor();
  const sessions = new RedactingSessionStore(new PostgresSessionStore(pool), redactor);
  const usageStore = new PostgresUsageRecorder(pool);

  const compressionProfile = options.compressionProfile ?? 'none';
  // A supplied gateway replaces the routed one outright — including the
  // providers, which is the point: constructing a provider needs its key, so
  // without this there is no way to build a harness without one, and a product
  // could never test its own wiring.
  const gateway =
    options.gateway ??
    new RoutedGateway({
      config: modelConfig,
      providers: routedProvidersFor(modelConfig),
      recorder: new RedactingUsageRecorder(usageStore, redactor),
      redactor,
      ...(compressionProfile === 'none' ? {} : { compressor: compressorFor(compressionProfile) }),
    });
  const tools = options.tools ?? new ToolRegistry();
  const modules = options.modules ?? new ModuleRegistry();
  const pools = new RedactingPoolStore(new PostgresPoolStore(pool), redactor);
  const approvals = new RedactingApprovalStore(new PostgresApprovalStore(pool), redactor);
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
  const resourceCache = new PostgresResourceCacheStore(pool);

  // The manager needs a resolver, which needs the vault; without a vault there
  // is nothing to run a connector with. When connectors declare OAuth
  // providers, the resolver refreshes stale tokens transparently. The cache
  // wraps the manager once it exists, so products get read-through for free.
  let connectionManager: ConnectionManager | null = null;
  let cachedConnections: CachedConnections | null = null;
  let mcpServer: McpServer | null = null;
  if (vault) {
    const providers = await loadConnectorsConfig(join(configDir, 'connectors.json'));
    const resolver: CredentialResolver =
      providers.size > 0
        ? new OAuthTokenRefresher(vault, new OAuthClient(), providers)
        : new VaultCredentialResolver(vault);
    connectionManager = new ConnectionManager(connectors, connections, resolver);
    cachedConnections = new CachedConnections(connectionManager, resourceCache);
    // Read-only by default; the cache serves reads, sparing the sources.
    mcpServer = new McpServer(cachedConnections, { name: HARNESS_NAME });
  }

  // Traces carry the user's own words and a tool's input, so they go through
  // the redactor like every other durable path.
  // One adapter, two ports: the agent writes through the redacting decorator,
  // an operator surface reads through the reader. Reading needs no redaction —
  // what was written was already scrubbed.
  const traceStore = new PostgresTraceRecorder(pool);
  const traces = new RedactingTraceRecorder(traceStore, redactor);

  return {
    agent: new Agent({ gateway, sessions, tools, persona, approvals, traces }),
    sessions,
    gateway,
    tools,
    modules,
    router: new Router(gateway, modules, traces),
    traces,
    traceReader: traceStore,
    usage: usageStore,
    tenants: new PostgresTenantStore(pool),
    pools,
    context: new ContextBroker(modules, { traces }),
    approvals,
    connections,
    connectors,
    vault,
    connectionManager,
    resourceCache,
    cachedConnections,
    mcpServer,
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
  ConnectorTimeoutError,
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
export type { ConnectionManagerOptions } from './connections/connection-manager.js';
export { CachedConnections } from './connections/cached-connections.js';
export type {
  ConnectionOperations,
  CachedConnectionsOptions,
  RefreshSummary,
} from './connections/cached-connections.js';
export { InMemoryResourceCacheStore } from './connections/in-memory-resource-cache-store.js';
export { PostgresResourceCacheStore } from './connections/postgres-resource-cache-store.js';
export { ResourceCacheError } from './connections/resource-cache-store.js';
export type {
  CacheScope,
  CacheListOptions,
  CachedResource,
  ResourceCacheStore,
} from './connections/resource-cache-store.js';
export { MemoryConnector } from './connections/memory-connector.js';
export type { MemoryConnectorOptions } from './connections/memory-connector.js';
export { ConfluenceConnector } from './connections/connectors/confluence-connector.js';
export type { ConfluenceConnectorOptions } from './connections/connectors/confluence-connector.js';
export { JiraConnector } from './connections/connectors/jira-connector.js';
export type { JiraConnectorOptions } from './connections/connectors/jira-connector.js';
export { GitHubConnector } from './connections/connectors/github-connector.js';
export type { GitHubConnectorOptions } from './connections/connectors/github-connector.js';
export { GoogleDriveConnector } from './connections/connectors/google-drive-connector.js';
export type { GoogleDriveConnectorOptions } from './connections/connectors/google-drive-connector.js';
export { SlackConnector } from './connections/connectors/slack-connector.js';
export type { SlackConnectorOptions } from './connections/connectors/slack-connector.js';
export { NotionConnector } from './connections/connectors/notion-connector.js';
export type { NotionConnectorOptions } from './connections/connectors/notion-connector.js';
export { GoogleCalendarConnector } from './connections/connectors/google-calendar-connector.js';
export type { GoogleCalendarConnectorOptions } from './connections/connectors/google-calendar-connector.js';
export { CalcomConnector } from './connections/connectors/calcom-connector.js';
export type { CalcomConnectorOptions } from './connections/connectors/calcom-connector.js';
export { CalendlyConnector } from './connections/connectors/calendly-connector.js';
export type { CalendlyConnectorOptions } from './connections/connectors/calendly-connector.js';
export { TeamsConnector } from './connections/connectors/teams-connector.js';
export type { TeamsConnectorOptions } from './connections/connectors/teams-connector.js';
export { CompressionPipeline } from './compression/compression-pipeline.js';
export { CompressionError } from './compression/context-compressor.js';
export type {
  ContextCompressor,
  CachePrefixReport,
  CompressionEngine,
  CompressionResult,
  CompressionReport,
  EngineReport,
} from './compression/context-compressor.js';
export {
  compressionCaseSchema,
  compressionCaseSetSchema,
  evaluateCompression,
  passesGate,
  regressions,
  toModelRequest,
} from './compression/eval.js';
export type {
  CompressionCase,
  CompressionCaseOutcome,
  CompressionEvalReport,
} from './compression/eval.js';
export { RegexSensitivityGuard } from './compression/sensitivity-gate.js';
export type { SensitivityGuard } from './compression/sensitivity-gate.js';
export { WhitespaceEngine } from './compression/engines/whitespace-engine.js';
export { JsonTableEngine } from './compression/engines/json-table-engine.js';
export { ToolResultEngine } from './compression/engines/tool-result-engine.js';
export { compressorFor } from './compression/profiles.js';
export type { CompressionProfile } from './compression/profiles.js';
export { renderRequestText, requestSize } from './compression/request-text.js';
export { McpServer } from './mcp/mcp-server.js';
export type { McpContext, McpServerOptions } from './mcp/mcp-server.js';
export {
  MCP_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  ErrorCode as McpErrorCode,
} from './mcp/protocol.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  McpToolResult,
} from './mcp/protocol.js';
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
  FailureKind,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  RequestAttribution,
  TaskKind,
  TokenUsage,
} from './models/model-gateway.js';
export type { ModelProvider, ProviderCall } from './models/model-provider.js';
export type { TokenCounter } from './models/token-counter.js';
export { GptTokenizerCounter } from './models/gpt-tokenizer-counter.js';
export { RoutedGateway } from './models/routed-gateway.js';
export { InMemoryAvailability, credentialScope, providerScope } from './models/availability.js';
export type {
  Availability,
  AvailabilityPolicy,
  RecordedFault,
  Unavailable,
} from './models/availability.js';
export { ScriptedGateway, callsTool, says } from './models/scripted-gateway.js';
export { loadModelConfig, parseModelConfig } from './models/routing.js';
export type { ModelConfig, ModelEntry, ModelTier } from './models/routing.js';
export { InMemoryUsageRecorder, computeCostUsd } from './telemetry/model-usage.js';
export type { CompressionUsage, ModelUsageRecord, UsageRecorder } from './telemetry/model-usage.js';
export { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';
export { RedactingUsageRecorder } from './telemetry/redacting-usage-recorder.js';
export { InMemoryTraceRecorder, TurnTrace } from './telemetry/trace.js';
export { InMemoryTenantStore } from './tenants/in-memory-tenant-store.js';
export { PostgresTenantStore } from './tenants/postgres-tenant-store.js';
export { TenantError, assertValidSlug } from './tenants/tenant-store.js';
export type { CreateTenantInput, Tenant, TenantStore } from './tenants/tenant-store.js';
export type {
  RecentTracesQuery,
  TraceReader,
  TraceSummary,
  TraceRecorder,
  TraceStep,
  TraceStepInput,
  TraceStepKind,
  TurnTraceContext,
} from './telemetry/trace.js';
export { PostgresTraceRecorder } from './telemetry/postgres-trace-recorder.js';
export { RedactingTraceRecorder } from './telemetry/redacting-trace-recorder.js';
export { RegexSecretRedactor } from './redaction/regex-secret-redactor.js';
export { redactDeep } from './redaction/secret-redactor.js';
export type { SecretRedactor } from './redaction/secret-redactor.js';
export { RedactingSessionStore } from './memory/redacting-session-store.js';
export { RedactingPoolStore } from './pools/redacting-pool-store.js';
export { RedactingApprovalStore } from './approval/redacting-approval-store.js';
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
export { ContextBroker } from './pools/context-broker.js';
export type { ContextBrokerOptions } from './pools/context-broker.js';
export { ContextError, denied, granted } from './pools/context.js';
export type {
  ContextDiscloser,
  ContextEntry,
  ContextGrant,
  ContextRequest,
} from './pools/context.js';
