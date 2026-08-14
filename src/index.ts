// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The package's public surface: everything a product may import by name.
 *
 * Only re-exports live here. The wiring is in `create-harness.ts` and the two
 * shapes it produces are in `harness.ts` — kept apart because they change for
 * different reasons, and all three used to share one file and one set of merge
 * conflicts.
 */

export { createHarness, HARNESS_NAME } from './create-harness.js';
export type { Harness, HarnessOptions } from './harness.js';

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
export { McpUngatedWriteError } from './mcp/mcp-server.js';
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
  ConnectionOnboarding,
  grantedScopes,
  UnknownProviderError,
} from './connections/connection-onboarding.js';
export type { AuthorizationRequest, CompleteRequest } from './connections/connection-onboarding.js';
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
export { OpenAiCompatibleProvider } from './models/openai-compatible-provider.js';
export type { OpenAiCompatibleOptions } from './models/openai-compatible-provider.js';
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
export type {
  BilledTo,
  CompressionSavings,
  CompressionUsage,
  ModelUsageRecord,
  SpendDimension,
  SpendQuery,
  SpendSlice,
  UsageRecorder,
} from './telemetry/model-usage.js';
export { DEFAULT_BREAKDOWN_LIMIT } from './telemetry/model-usage.js';
export { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';
export { RedactingUsageRecorder } from './telemetry/redacting-usage-recorder.js';
export { InMemoryTraceRecorder, TurnTrace } from './telemetry/trace.js';
export { consoleLogger } from './telemetry/logger.js';
export type { Logger } from './telemetry/logger.js';
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
export { OtlpTraceRecorder } from './telemetry/otlp-trace-recorder.js';
export type { OtlpExportOptions } from './telemetry/otlp-trace-recorder.js';
export { toOtlpPayload, toSpan, toSpanId, toTraceId } from './telemetry/otlp.js';
export { McpConnector } from './connections/connectors/mcp-connector.js';
export type { McpConnectorOptions } from './connections/connectors/mcp-connector.js';
export { McpClient, McpClientError } from './mcp/mcp-client.js';
export type {
  McpCallContext,
  McpClientOptions,
  McpResource,
  McpResourceContents,
  McpResourcePage,
  McpSession,
  McpTransport,
  McpTransportResponse,
} from './mcp/mcp-client.js';
export { McpApprovalGate, requestId } from './mcp/mcp-approval.js';
export type { ApprovalOutcome, McpApprovalOptions } from './mcp/mcp-approval.js';
export { HttpMcpTransport } from './mcp/http-mcp-transport.js';
export type { HttpMcpTransportOptions } from './mcp/http-mcp-transport.js';
export { Lifecycle, NotAcceptingError, handleShutdownSignals } from './lifecycle/shutdown.js';
export type {
  DrainOptions,
  DrainResult,
  LifecycleOptions,
  ShutdownSignalOptions,
} from './lifecycle/shutdown.js';
// The three helpers `model-gateway.ts` documents as what a caller usually
// wants. They were reachable from inside `src/` and from nowhere else, which
// made building a request through the published package harder than building
// one in a test.
export { cachePrefixLength, responseText, toolCalls, userMessage } from './models/model-gateway.js';
export { PostgresMemoryStore } from './memory/postgres-memory-store.js';
export { OpenAiCompatibleEmbedder } from './memory/openai-compatible-embedder.js';
export { LazyEmbedder } from './memory/lazy-embedder.js';
export { KeyedEmbedderFactory } from './memory/keyed-embedder-factory.js';
export type { KeyedEmbedderOptions } from './memory/keyed-embedder-factory.js';
export { fixedEmbedder } from './memory/embedder.js';
export type { EmbedderFactory } from './memory/embedder.js';
export { chunk } from './memory/chunking.js';
export {
  assertDimensions,
  DEFAULT_EMBEDDING_DIMENSIONS,
  EmbeddingError,
} from './memory/embedder.js';
export type { Embedder } from './memory/embedder.js';
export { DEFAULT_MAX_DISTANCE, DEFAULT_SEARCH_LIMIT, MemoryError } from './memory/memory-store.js';
export type {
  CreateSourceInput,
  DocumentInput,
  IngestOutcome,
  MemorySource,
  MemoryStore,
  SearchHit,
  SearchQuery,
  StoredDocument,
} from './memory/memory-store.js';
export { declaredAgent } from './agents/declared-agent.js';
export { loadAgents } from './agents/load-agents.js';
export {
  agentConfigSchema,
  AgentConfigError,
  connectionGrantSchema,
  grantsWrites,
  parseAgentConfig,
} from './agents/agent-config.js';
export type { AgentConfig, ConnectionGrant } from './agents/agent-config.js';
export type { DeclaredAgentDependencies } from './agents/declared-agent.js';

export { loadWorkflows } from './workflows/load-workflows.js';
export {
  missingAgents,
  parseWorkflowConfig,
  WorkflowConfigError,
  workflowConfigSchema,
  workflowStepSchema,
} from './workflows/workflow-config.js';
export type { WorkflowConfig, WorkflowStep } from './workflows/workflow-config.js';
export { references, render, TemplateError } from './workflows/template.js';
export { WorkflowRunner, WorkflowError } from './workflows/workflow-runner.js';
export type {
  StartWorkflowInput,
  WorkflowRunDetail,
  WorkflowRunnerDependencies,
} from './workflows/workflow-runner.js';
export { PostgresWorkflowRunStore } from './workflows/postgres-workflow-run-store.js';
export { InMemoryWorkflowRunStore } from './workflows/in-memory-workflow-run-store.js';
export { DEFAULT_RUN_LIMIT, WorkflowRunError } from './workflows/workflow-run-store.js';
export type {
  AwaitingKind,
  RunStatus,
  StepRun,
  StepStatus,
  WorkflowRun,
  WorkflowRunStore,
} from './workflows/workflow-run-store.js';
export { LazyProvider } from './models/lazy-provider.js';
export { InMemoryModelKeys, ModelKeyError, ModelKeyVault } from './models/model-keys.js';
export type { ModelKeys, ModelKeyStore } from './models/model-keys.js';
export { PostgresModelKeyStore } from './models/postgres-model-keys.js';
export { databaseProbe, liveness, readiness } from './lifecycle/health.js';
export type {
  HealthProbe,
  HealthReport,
  ProbeReport,
  Queryable,
  ReadinessOptions,
} from './lifecycle/health.js';
export type {
  OtlpAttribute,
  OtlpSpan,
  OtlpTracePayload,
  OtlpValue,
  ResourceOptions,
  SpanOptions,
} from './telemetry/otlp.js';
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
