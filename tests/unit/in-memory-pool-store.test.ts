// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { InMemoryPoolStore } from '../../src/pools/in-memory-pool-store.js';
import { PoolError } from '../../src/pools/pool-store.js';

const financeA = { tenantId: 'tenant-a', moduleId: 'finance' };
const calendarA = { tenantId: 'tenant-a', moduleId: 'calendar' };
const financeB = { tenantId: 'tenant-b', moduleId: 'finance' };

describe('InMemoryPoolStore', () => {
  it('round-trips a value', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'budget', { limit: 1000 });

    const entry = await store.get(financeA, 'budget');

    expect(entry?.value).toEqual({ limit: 1000 });
    expect(entry?.updatedAt).toBeInstanceOf(Date);
  });

  it('overwrites on a second set', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'budget', 1);
    await store.set(financeA, 'budget', 2);

    expect((await store.get(financeA, 'budget'))?.value).toBe(2);
  });

  it('returns null for a key that was never set', async () => {
    const store = new InMemoryPoolStore();

    expect(await store.get(financeA, 'missing')).toBeNull();
  });

  it('isolates one module from another in the same tenant', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'k', 'finance-value');

    expect(await store.get(calendarA, 'k')).toBeNull();
  });

  it('isolates one tenant from another using the same module', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'k', 'a-value');

    expect(await store.get(financeB, 'k')).toBeNull();
  });

  it('lists only the scope’s own entries', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'a', 1);
    await store.set(financeA, 'b', 2);
    await store.set(calendarA, 'c', 3);
    await store.set(financeB, 'd', 4);

    const entries = await store.list(financeA);

    expect(entries.map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('narrows a list to a key prefix', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'expense:1', 1);
    await store.set(financeA, 'expense:2', 2);
    await store.set(financeA, 'budget', 3);

    const entries = await store.list(financeA, 'expense:');

    expect(entries.map((entry) => entry.key)).toEqual(['expense:1', 'expense:2']);
  });

  it('does not let a prefix leak across the module boundary', async () => {
    // A crafted key must not be able to reach into another scope's namespace.
    const store = new InMemoryPoolStore();
    await store.set({ tenantId: 'a', moduleId: 'x' }, 'k', 'secret');

    const entries = await store.list({ tenantId: 'a', moduleId: 'x/9:k' }, '');

    expect(entries).toEqual([]);
  });

  it('reports whether a delete removed anything', async () => {
    const store = new InMemoryPoolStore();
    await store.set(financeA, 'k', 1);

    expect(await store.delete(financeA, 'k')).toBe(true);
    expect(await store.delete(financeA, 'k')).toBe(false);
    expect(await store.get(financeA, 'k')).toBeNull();
  });

  it('stores a copy, so a later mutation of the caller’s object does not change it', async () => {
    const store = new InMemoryPoolStore();
    const value = { items: [1] };
    await store.set(financeA, 'k', value);

    value.items.push(2);

    expect((await store.get(financeA, 'k'))?.value).toEqual({ items: [1] });
  });

  it('rejects an empty key', async () => {
    const store = new InMemoryPoolStore();

    await expect(store.set(financeA, '', 1)).rejects.toThrow(PoolError);
  });
});
