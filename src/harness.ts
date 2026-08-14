// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What a built harness is, and what building one takes.
 *
 * Only the two shapes: `create-harness.ts` does the wiring, and this stays a
 * file of types so a product can name what it depends on without importing the
 * factory — and everything that comes with it, down to the Postgres driver.
 *
 * A note on the nullable members below. Six of them are `| null`, and they are
 * not independent: `vault`, `connectionManager`, `onboarding`,
 * `cachedConnections`, `mcpServer` and `modelKeys` all exist exactly when
 * `MASTER_ENCRYPTION_KEY` is configured, because each one needs somewhere to
 * seal a secret. A deployment that connects nothing is a valid deployment, and
 * starting one with a missing key would be worse than starting without them —
 * so they are absent together, and a caller that checks one has checked them
 * all.
 */

import type { ApprovalStore } from './approval/approval-store.js';
import type { CachedConnections } from './connections/cached-connections.js';
import type { ConnectionManager } from './connections/connection-manager.js';
import type { ConnectionOnboarding } from './connections/connection-onboarding.js';
import type { ConnectionStore } from './connections/connection-store.js';
import type { ConnectorRegistry } from './connections/connector-registry.js';
import type { CredentialVault } from './connections/credential-vault.js';
import type { ResourceCacheStore } from './connections/resource-cache-store.js';
import type { CompressionProfile } from './compression/profiles.js';
import type { Agent } from './core/agent.js';
import type { ToolRegistry } from './core/tool.js';
import type { HealthProbe } from './lifecycle/health.js';
import type { Lifecycle } from './lifecycle/shutdown.js';
import type { McpServer } from './mcp/mcp-server.js';
import type { MemoryStore } from './memory/memory-store.js';
import type { SessionStore } from './memory/session-store.js';
import type { ModelGateway } from './models/model-gateway.js';
import type { ModelKeyVault } from './models/model-keys.js';
import type { ModelConfig } from './models/routing.js';
import type { ModuleRegistry } from './modules/module.js';
import type { ContextBroker } from './pools/context-broker.js';
import type { PoolStore } from './pools/pool-store.js';
import type { Router } from './router/router.js';
import type { UsageReader } from './telemetry/model-usage.js';
import type { OtlpExportOptions } from './telemetry/otlp-trace-recorder.js';
import type { TraceReader, TraceRecorder } from './telemetry/trace.js';
import type { TenantStore } from './tenants/tenant-store.js';
import type { WorkflowConfig } from './workflows/workflow-config.js';
import type { WorkflowRunStore } from './workflows/workflow-run-store.js';
import type { WorkflowRunner } from './workflows/workflow-runner.js';

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
  /**
   * Running an OAuth flow to its end: authorization URL in, stored connection
   * out. Present only when the vault is, since there is nowhere to seal a
   * credential without one. The client secret never leaves it.
   */
  readonly onboarding: ConnectionOnboarding | null;
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
  /**
   * A tenant's own provider keys (E3), or null with no master key configured —
   * the same condition as `vault`, since they share the envelope. Bringing a
   * key opts a tenant out of the platform's; see `src/models/model-keys.ts`.
   */
  readonly modelKeys: ModelKeyVault | null;
  /**
   * Shared knowledge, or null when no embedding provider is configured.
   *
   * Null rather than an empty store: a deployment that cannot embed cannot
   * search, and a store that accepted documents it could never find again would
   * be a place things go to be lost.
   */
  readonly memory: MemoryStore | null;
  /**
   * The declared workflows, by id — what a console lists and a caller starts.
   * Empty when `config/workflows/` holds nothing, which is every deployment
   * until somebody writes the first one.
   */
  readonly workflows: ReadonlyMap<string, WorkflowConfig>;
  /**
   * Runs them, and picks them back up after a person decides. Its store is
   * durable, so a run waiting on somebody survives a deploy.
   */
  readonly workflowRunner: WorkflowRunner;
  readonly workflowRuns: WorkflowRunStore;
  /**
   * What is running, and whether more may start. Wrap each turn in
   * `lifecycle.run` and a deploy stops dropping the turn in flight; pass it to
   * `readiness` and the pod goes out of the load balancer before anything
   * closes. See `src/lifecycle/`.
   */
  readonly lifecycle: Lifecycle;
  /**
   * What `readiness` should check for this harness — the database, today.
   * Built here because the pool is not otherwise handed out. A product appends
   * its own probes; **liveness takes none of them**, on purpose.
   */
  readonly probes: readonly HealthProbe[];
  /**
   * What this deployment was configured to route to — providers, models,
   * routes, and which environment variable holds each key.
   *
   * Read-only, and exposed because "am I configured?" is a question a product
   * has to answer before anybody types anything, and it could not: the config
   * was loaded, used to build a gateway, and dropped. A surface that wants to
   * say *which* key is missing needs the name the deployment chose, which lives
   * only here. It carries no secret — `apiKeyEnv` is a variable's name, not its
   * value.
   */
  readonly models: ModelConfig;
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
  /**
   * Where to export traces as OpenTelemetry spans, on top of storing them.
   *
   * Defaults to the standard environment variables — `OTEL_EXPORTER_OTLP_ENDPOINT`
   * and `OTEL_SERVICE_NAME` — so a deployment that already sets what every
   * other service in the fleet reads gets export without touching code. Pass
   * `{ endpoint: '' }` to keep it off regardless of the environment.
   */
  readonly otlp?: Partial<OtlpExportOptions>;
  /**
   * Share one lifecycle with the rest of a product, so a single drain covers
   * the harness's turns and whatever else is in flight. Defaults to its own.
   */
  readonly lifecycle?: Lifecycle;
}
