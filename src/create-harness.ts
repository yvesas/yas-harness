// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition root: where adapters are wired into the core.
 *
 * This is the only file allowed to know both sides. The core imports ports;
 * nothing in `core/` imports an adapter. `harness.ts` holds the two shapes this
 * produces, and `index.ts` is the barrel — so what changes here is the wiring,
 * and only the wiring.
 */

import { join } from 'node:path';

import pg from 'pg';

import { PostgresApprovalStore } from './approval/postgres-approval-store.js';
import { RedactingApprovalStore } from './approval/redacting-approval-store.js';
import { CachedConnections } from './connections/cached-connections.js';
import { ConnectionManager } from './connections/connection-manager.js';
import { ConnectionOnboarding } from './connections/connection-onboarding.js';
import { declaredAgent } from './agents/declared-agent.js';
import { loadAgents } from './agents/load-agents.js';
import { loadWorkflows } from './workflows/load-workflows.js';
import { PostgresWorkflowRunStore } from './workflows/postgres-workflow-run-store.js';
import { WorkflowRunner } from './workflows/workflow-runner.js';
import type { WorkflowConfig } from './workflows/workflow-config.js';
import { LazyProvider } from './models/lazy-provider.js';
import type { MemoryStore } from './memory/memory-store.js';
import { PostgresMemoryStore } from './memory/postgres-memory-store.js';
import { KeyedEmbedderFactory } from './memory/keyed-embedder-factory.js';
import { ConnectorRegistry } from './connections/connector-registry.js';
import type { CredentialResolver } from './connections/credential-resolver.js';
import { VaultCredentialResolver } from './connections/credential-resolver.js';
import { CredentialVault } from './connections/credential-vault.js';
import { EnvelopeCipher } from './connections/envelope-cipher.js';
import { loadConnectorsConfig } from './connections/oauth-config.js';
import { PostgresResourceCacheStore } from './connections/postgres-resource-cache-store.js';
import { OAuthClient } from './connections/oauth.js';
import { OAuthTokenRefresher } from './connections/oauth-token-refresher.js';
import {
  PostgresConnectionStore,
  PostgresCredentialStore,
  PostgresTenantKeyStore,
} from './connections/postgres-connection-store.js';
import { compressorFor } from './compression/profiles.js';
import { Agent } from './core/agent.js';
import { loadPersona } from './core/persona.js';
import { ToolRegistry } from './core/tool.js';
import { McpServer } from './mcp/mcp-server.js';
import { PostgresSessionStore } from './memory/postgres-session-store.js';
import { RedactingSessionStore } from './memory/redacting-session-store.js';
import { AnthropicProvider } from './models/anthropic-provider.js';
import { OpenAiCompatibleProvider } from './models/openai-compatible-provider.js';
import { RoutedGateway } from './models/routed-gateway.js';
import { loadModelConfig } from './models/routing.js';
import { ModuleRegistry } from './modules/module.js';
import { PostgresPoolStore } from './pools/postgres-pool-store.js';
import { RedactingPoolStore } from './pools/redacting-pool-store.js';
import { ContextBroker } from './pools/context-broker.js';
import { RegexSecretRedactor } from './redaction/regex-secret-redactor.js';
import { PostgresTenantStore } from './tenants/postgres-tenant-store.js';
import { Router } from './router/router.js';
import { PostgresTraceRecorder } from './telemetry/postgres-trace-recorder.js';
import { PostgresUsageRecorder } from './telemetry/postgres-usage-recorder.js';
import { databaseProbe } from './lifecycle/health.js';
import { ModelKeyVault, type ModelKeys } from './models/model-keys.js';
import { PostgresModelKeyStore } from './models/postgres-model-keys.js';
import { Lifecycle } from './lifecycle/shutdown.js';
import { OtlpTraceRecorder, type OtlpExportOptions } from './telemetry/otlp-trace-recorder.js';
import { RedactingTraceRecorder } from './telemetry/redacting-trace-recorder.js';
import { RedactingUsageRecorder } from './telemetry/redacting-usage-recorder.js';
import type { TraceRecorder } from './telemetry/trace.js';
import type { Harness, HarnessOptions } from './harness.js';

export const HARNESS_NAME = 'yas-harness';

/**
 * The providers this configuration routes to, each built on first use.
 *
 * Lazily, because a provider reads its key in its constructor: building them
 * here meant a key was required to do things that never touch a model — create
 * a tenant, read a trace, show a cost table. The wiring check is unaffected,
 * since a `LazyProvider` knows its name from the start; only the credential
 * requirement moves, to the moment the model is actually called.
 */
function routedProvidersFor(modelConfig: Awaited<ReturnType<typeof loadModelConfig>>) {
  const routed = new Set(Object.values(modelConfig.models).map((entry) => entry.provider));

  return [...routed].map((name) => {
    const entry = modelConfig.providers[name]!;
    return new LazyProvider(name, () =>
      entry.kind === 'anthropic'
        ? new AnthropicProvider({ apiKeyEnv: entry.apiKeyEnv })
        : new OpenAiCompatibleProvider({
            name,
            baseUrl: entry.baseUrl!,
            apiKeyEnv: entry.apiKeyEnv,
          }),
    );
  });
}

/**
 * The knowledge store, if this deployment can embed.
 *
 * The embedding provider is declared in `config/models.json` beside the
 * completion ones, under `embedding` -- same shape, same reason: a vendor is
 * configuration, and the harness names none.
 */
function memoryStoreFor(
  pool: pg.Pool,
  modelConfig: Awaited<ReturnType<typeof loadModelConfig>>,
  modelKeys: ModelKeys | undefined,
): MemoryStore | null {
  const entry = modelConfig.embedding;
  if (!entry) {
    return null;
  }
  // The factory is what makes the key the tenant's rather than the
  // deployment's: a tenant who pasted one on the Keys page has their documents
  // embedded on their own account, and a deployment that configured no key at
  // all is a valid deployment rather than a broken one.
  //
  // Nothing here reads a key. That is the reason `LazyProvider` exists, applied
  // once more: a harness with no embedding key anywhere still starts, and still
  // lists what it already knows -- only embedding needs the key, and that is
  // where the error appears.
  return new PostgresMemoryStore(
    pool,
    new KeyedEmbedderFactory({ entry, ...(modelKeys ? { modelKeys } : {}) }),
  );
}

/**
 * The trace exporter, if this deployment wants one.
 *
 * The endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` when the caller does
 * not pass one — the variable the rest of an instrumented fleet already reads,
 * so wiring the harness into an existing collector is a deployment concern
 * rather than a code change. No endpoint means no exporter at all: an empty
 * decorator would still allocate a queue and a timer to send nothing.
 */
function otlpExporter(
  inner: TraceRecorder,
  options: Partial<OtlpExportOptions> = {},
): OtlpTraceRecorder | null {
  const endpoint = options.endpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) {
    return null;
  }
  const serviceName = options.serviceName ?? process.env['OTEL_SERVICE_NAME'];
  return new OtlpTraceRecorder(inner, {
    ...options,
    endpoint,
    ...(serviceName === undefined ? {} : { serviceName }),
  });
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

  // The master key gates every sealed path: the credential vault below and a
  // tenant's own model keys here. Read before the gateway, since BYOM changes
  // which models a tenant is routed to at all.
  const masterKey = options.masterEncryptionKey ?? process.env['MASTER_ENCRYPTION_KEY'];
  const cipher = masterKey ? EnvelopeCipher.fromBase64(masterKey) : null;
  const tenantKeys = new PostgresTenantKeyStore(pool);
  const modelKeys = cipher
    ? new ModelKeyVault(cipher, tenantKeys, new PostgresModelKeyStore(pool))
    : null;

  // Shared knowledge, when an embedding provider was configured. Absent, the
  // memory tool is simply never generated -- an agent granted a source it
  // cannot search would be worse than one that was never granted it.
  const memory = memoryStoreFor(pool, modelConfig, modelKeys ?? undefined);

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
      // Absent with no master key: there is nowhere to have stored a tenant
      // key, so everyone is on the platform's — which is the posture before
      // BYOM and the right default.
      ...(modelKeys ? { modelKeys } : {}),
      ...(compressionProfile === 'none' ? {} : { compressor: compressorFor(compressionProfile) }),
    });
  const tools = options.tools ?? new ToolRegistry();
  const modules = options.modules ?? new ModuleRegistry();
  const pools = new RedactingPoolStore(new PostgresPoolStore(pool), redactor);
  const approvals = new RedactingApprovalStore(new PostgresApprovalStore(pool), redactor);
  const connections = new PostgresConnectionStore(pool);

  // The vault only exists if a master key is configured. Building it without
  // one would fail; skipping it lets a deployment that connects nothing run.
  // It shares the cipher and the tenant key store with `modelKeys` above: one
  // tenant, one data key, so revoking it covers everything that tenant owns.
  const vault = cipher
    ? new CredentialVault(cipher, tenantKeys, new PostgresCredentialStore(pool))
    : null;

  const connectors = options.connectors ?? new ConnectorRegistry();
  // Declared agents, from config/agents/. Loaded before the connection layer
  // is built because the failure worth having early is a malformed file, not a
  // missing connection — an agent whose source is not connected yet is normal.
  const declared = await loadAgents(join(configDir, 'agents'));
  const resourceCache = new PostgresResourceCacheStore(pool);

  // The manager needs a resolver, which needs the vault; without a vault there
  // is nothing to run a connector with. When connectors declare OAuth
  // providers, the resolver refreshes stale tokens transparently. The cache
  // wraps the manager once it exists, so products get read-through for free.
  let connectionManager: ConnectionManager | null = null;
  let onboarding: ConnectionOnboarding | null = null;
  let cachedConnections: CachedConnections | null = null;
  let mcpServer: McpServer | null = null;
  if (vault) {
    const providers = await loadConnectorsConfig(join(configDir, 'connectors.json'));
    const resolver: CredentialResolver =
      providers.size > 0
        ? new OAuthTokenRefresher(vault, new OAuthClient(), providers)
        : new VaultCredentialResolver(vault);
    connectionManager = new ConnectionManager(connectors, connections, resolver);
    // Only when providers are configured: a deployment with none has nothing to
    // onboard, and an onboarding that can connect nothing is a button that
    // always fails.
    if (providers.size > 0) {
      onboarding = new ConnectionOnboarding(providers, new OAuthClient(), connections, vault);
    }
    cachedConnections = new CachedConnections(connectionManager, resourceCache);
    // Read-only by default; the cache serves reads, sparing the sources.
    mcpServer = new McpServer(cachedConnections, { name: HARNESS_NAME });
  }

  // Traces carry the user's own words and a tool's input, so they go through
  // the redactor like every other durable path.
  // One adapter, two ports: the agent writes through the redacting decorator,
  // an operator surface reads through the reader. Reading needs no redaction —
  // what was written was already scrubbed.
  // The exporter sits *inside* the redactor: what leaves for a collector is
  // scrubbed by the same pass as what is stored. The other way round would send
  // a third party exactly what the redactor exists to withhold.
  // A declared agent's tools reach sources through the cache, like everything
  // else does. Without a connection layer there is nothing for them to reach,
  // so they are registered only when there is one — a declared agent with no
  // tools would still be routed to and would answer with nothing.
  if (cachedConnections) {
    for (const config of declared) {
      modules.register(
        declaredAgent(config, {
          operations: cachedConnections,
          connections,
          ...(memory ? { memory } : {}),
        }),
      );
    }
  }

  // Declared workflows, from config/workflows/. Loaded here rather than beside
  // the agents because a workflow names agents, and the ones a product
  // registers in code arrive after this function returns — so the reference is
  // checked when a run starts, not now.
  const workflows = new Map<string, WorkflowConfig>(
    (await loadWorkflows(join(configDir, 'workflows'))).map((config) => [config.id, config]),
  );

  const traceStore = new PostgresTraceRecorder(pool);
  const exporter = otlpExporter(traceStore, options.otlp);
  const traces = new RedactingTraceRecorder(exporter ?? traceStore, redactor);

  // `modules` is what makes a routed turn run as its module rather than with
  // every module's tools flattened together.
  const agent = new Agent({ gateway, sessions, tools, persona, approvals, traces, modules });
  const workflowRuns = new PostgresWorkflowRunStore(pool);

  return {
    agent,
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
    onboarding,
    resourceCache,
    cachedConnections,
    mcpServer,
    modelKeys,
    memory,
    workflows,
    workflowRuns,
    workflowRunner: new WorkflowRunner({
      agent,
      sessions,
      runs: workflowRuns,
      workflows,
      // A function rather than a snapshot: a product registers its modules
      // after this returns, and a workflow naming one of them must not be
      // rejected because the set was read too early.
      agents: () => new Set(modules.list().map((module) => module.id)),
      approvals,
      personaId: persona.id,
    }),
    lifecycle: options.lifecycle ?? new Lifecycle(),
    probes: [databaseProbe(pool)],
    models: modelConfig,
    close: async () => {
      // Spans first: the last steps of a turn are usually the ones explaining
      // why the process is going down, and they are lost once the queue is.
      await exporter?.close();
      await pool.end();
    },
  };
}
