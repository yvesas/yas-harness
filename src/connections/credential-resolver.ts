// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * How the connection manager gets a usable credential for a connection.
 *
 * The default just reads the vault. The OAuth variant reads it too, but
 * refreshes an expired token first and stores the fresh one back — so the
 * caller always gets a working credential and never knows a refresh happened.
 */

import type { Connection } from './connection-store.js';
import type { CredentialVault } from './credential-vault.js';

export interface CredentialResolver {
  /** The usable credential, or null when the connection has none stored. */
  resolve(connection: Connection): Promise<unknown>;
}

/** Reads the stored credential as-is: the right resolver for static secrets. */
export class VaultCredentialResolver implements CredentialResolver {
  constructor(private readonly vault: CredentialVault) {}

  resolve(connection: Connection): Promise<unknown> {
    return this.vault.resolve(connection.tenantId, connection.id);
  }
}
