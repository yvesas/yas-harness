// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A provider that is not built until something actually calls it.
 *
 * Providers used to be constructed while the harness was, and each one reads its
 * key in its constructor. That meant a key was required to do things that never
 * touch a model: create a tenant, read a trace, look at last month's spend. A
 * console showing a cost table had to be handed an API key to render it, and a
 * one-command `docker compose up` failed on a provider nobody had asked for.
 *
 * So construction moves to the first `invoke`. What is deliberately **not**
 * deferred is the wiring check: the provider's `name` is known immediately, so
 * the gateway still refuses at construction a route pointing at a provider
 * nobody registered. That was the mistake worth catching early, and it still is.
 *
 * What moves later is only the *credential* requirement, and it moves to the
 * moment it is genuinely needed — where the error says the same thing it always
 * said. A deployment missing a key still finds out; it finds out when it first
 * tries to use the model rather than when it starts.
 */

import type { ModelResponse } from './model-gateway.js';
import type { ModelProvider, ProviderCall } from './model-provider.js';

export class LazyProvider implements ModelProvider {
  readonly name: string;
  readonly #build: () => ModelProvider;
  #provider: ModelProvider | null = null;

  constructor(name: string, build: () => ModelProvider) {
    this.name = name;
    this.#build = build;
  }

  invoke(call: ProviderCall): Promise<ModelResponse> {
    // Built once and kept: a provider holds a client, and rebuilding it per
    // call would throw away whatever connection reuse the SDK manages.
    this.#provider ??= this.#build();
    return this.#provider.invoke(call);
  }

  /** True once something has actually called through. For tests. */
  get built(): boolean {
    return this.#provider !== null;
  }
}
