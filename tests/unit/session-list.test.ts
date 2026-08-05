// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Listing a tenant's conversations.
 *
 * Asked for by the console's playground — the fourth port a page has revealed.
 * `find` answers about a session whose id you already hold, which is only true
 * of the one you just created; coming back to a conversation starts from
 * "which ones are there".
 */

import { describe, expect, it } from 'vitest';

import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import { userMessage } from '../../src/models/model-gateway.js';

const TENANT = 'tenant-1';

describe('a tenant’s conversations', () => {
  it('lists them with how much was said', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ tenantId: TENANT, personaId: 'default' });
    await store.append(TENANT, session.id, [userMessage('hello'), userMessage('again')]);

    const [summary] = await store.list(TENANT);

    expect(summary).toMatchObject({ id: session.id, personaId: 'default', messages: 2 });
  });

  it('puts the most recently active first, not the most recently created', async () => {
    const store = new InMemorySessionStore();
    const older = await store.create({ tenantId: TENANT, personaId: 'default' });
    const newer = await store.create({ tenantId: TENANT, personaId: 'default' });
    // The older conversation is the one that was just replied to.
    await store.append(TENANT, older.id, [userMessage('still going')]);

    const listed = await store.list(TENANT);

    // A conversation replied to this morning matters more than one opened last
    // week and abandoned.
    expect(listed.map((session) => session.id)).toEqual([older.id, newer.id]);
  });

  it('treats an empty conversation’s creation as its activity', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ tenantId: TENANT, personaId: 'default' });

    const [summary] = await store.list(TENANT);

    // Nothing was ever said in it, so there is no later moment to report — and
    // a null would push it to an arbitrary end of the list.
    expect(summary?.lastActivityAt).toEqual(session.createdAt);
    expect(summary?.messages).toBe(0);
  });

  it('shows one tenant nothing of another’s', async () => {
    const store = new InMemorySessionStore();
    await store.create({ tenantId: TENANT, personaId: 'default' });
    await store.create({ tenantId: 'tenant-2', personaId: 'default' });

    expect(await store.list('tenant-2')).toHaveLength(1);
  });

  it('caps how many it returns', async () => {
    const store = new InMemorySessionStore();
    for (let i = 0; i < 5; i += 1) {
      await store.create({ tenantId: TENANT, personaId: 'default' });
    }

    expect(await store.list(TENANT, { limit: 2 })).toHaveLength(2);
  });

  it('says there are none rather than failing', async () => {
    expect(await new InMemorySessionStore().list(TENANT)).toEqual([]);
  });
});
