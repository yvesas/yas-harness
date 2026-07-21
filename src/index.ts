// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition root of the harness.
 *
 * This is where adapters (model providers, stores, connectors) are wired into
 * the core. It is intentionally empty until the core exists: nothing above this
 * file may import an adapter directly.
 */

/** Name of the harness, used in logs and traces. */
export const HARNESS_NAME = 'yas-harness';

export function describe(): string {
  return `${HARNESS_NAME}: reusable agent chassis for YAS Labs products`;
}
