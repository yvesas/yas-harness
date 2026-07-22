// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The set of connectors a deployment has plugged in.
 *
 * Adding a source is registering a connector here — nothing else in the
 * harness changes. That is the plug-and-play the connection layer is for: the
 * manager, the vault and the schema do not know Drive from Confluence; they
 * know the contract.
 */

import type { Connector } from './connector.js';
import { ConnectorError, assertConnectorConsistent } from './connector.js';

/** Connector ids the connection layer can name: lowercase, no spaces. */
const CONNECTOR_ID = /^[a-z][a-z0-9_-]{1,63}$/;

export class ConnectorRegistry {
  readonly #connectors = new Map<string, Connector>();

  /** Register a connector. Its capabilities and methods must agree. */
  register(connector: Connector): this {
    if (!CONNECTOR_ID.test(connector.id)) {
      throw new ConnectorError(
        `connector id must match ${CONNECTOR_ID.source}; got "${connector.id}"`,
        connector.id,
      );
    }
    if (connector.description.trim() === '') {
      throw new ConnectorError('connector description must not be empty', connector.id);
    }
    if (this.#connectors.has(connector.id)) {
      throw new ConnectorError(`connector "${connector.id}" is already registered`, connector.id);
    }
    assertConnectorConsistent(connector);

    this.#connectors.set(connector.id, connector);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.#connectors.get(id);
  }

  has(id: string): boolean {
    return this.#connectors.has(id);
  }

  get size(): number {
    return this.#connectors.size;
  }

  list(): Connector[] {
    return [...this.#connectors.values()];
  }
}
