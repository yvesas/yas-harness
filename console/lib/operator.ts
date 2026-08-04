// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Who decided.
 *
 * `decided_by` is an opaque operator identifier — the harness deliberately does
 * not model who a person is. The console has no login yet, so there is no
 * honest way to fill it with a name, and inventing one would put a fiction in
 * an audit trail whose whole value is being true.
 *
 * So it records what it actually knows: that the decision came through this
 * console, and from which environment. `CONSOLE_OPERATOR` lets a deployment say
 * more — an email, a service account — when it has something real to say.
 *
 * This is the same seam as `currentTenant`: when authentication arrives, one
 * function changes.
 */
export function operator(): Promise<string> {
  return Promise.resolve(process.env['CONSOLE_OPERATOR'] ?? 'yas-console');
}
