// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: one AI provider, one call.
 *
 * A provider knows how to talk to its own API and nothing else — it does not
 * choose models, retry, fall back or price. Those belong to the gateway above
 * it, so that adding a provider never means reimplementing them.
 */

import type { ModelRequest, ModelResponse } from './model-gateway.js';

export interface ProviderCall {
  /** The provider's own model id, e.g. `claude-opus-4-8`. */
  readonly model: string;
  readonly request: ModelRequest;
  /**
   * The tenant's own key for this provider, when they brought one (E3).
   *
   * Absent means the platform's, which is the adapter's configured default and
   * the only case before BYOM. An adapter **must** use this when it is present
   * rather than its own: it is the difference between a call the customer pays
   * for on an account they hold and one we pay for on ours.
   */
  readonly apiKey?: string;
  /** Abort the call when the gateway's deadline passes. */
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  /** Matches the `provider` field of a model entry in configuration. */
  readonly name: string;
  invoke(call: ProviderCall): Promise<ModelResponse>;
}
