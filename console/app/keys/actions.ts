// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Storing and forgetting a tenant's own model key.
 *
 * The key goes straight into the vault, sealed under this tenant's data key
 * with the same envelope encryption the OAuth credentials use. It is never
 * written to a file, never rendered back, and never returned by anything this
 * page can reach — `resolve` exists, and no surface here calls it.
 *
 * Nothing about the key travels in a redirect either. The outcome does; the
 * value does not.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';

export async function saveKey(form: FormData): Promise<never> {
  const provider = String(form.get('provider') ?? '');
  const apiKey = String(form.get('apiKey') ?? '').trim();
  const tenant = await currentTenant();
  const api = await harness();

  let outcome: string;
  try {
    if (!api.modelKeys) {
      throw new Error('there is no credential vault, so a key cannot be sealed');
    }
    if (apiKey === '') {
      throw new Error('no key was entered');
    }
    await api.modelKeys.store(tenant.id, provider, apiKey);
    outcome = `saved=${encodeURIComponent(provider)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Logged as well as shown. A failure that exists only in a query string is
    // a failure nobody can help with afterwards: the person reads it, presses
    // back, and the only record of what went wrong is gone. The provider is
    // named; the key never is, and there is nothing here that could print it.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'model_key.store_failed',
        provider,
        tenantId: tenant.id,
        // Says whether the form arrived empty, which is a different problem
        // from the vault refusing — and indistinguishable from the outside.
        keyLength: apiKey.length,
        message,
      }),
    );
    outcome = `error=${encodeURIComponent(message.slice(0, 300))}`;
  }

  revalidatePath('/keys');
  redirect(`/keys?${outcome}`);
}

export async function forgetKey(form: FormData): Promise<never> {
  const provider = String(form.get('provider') ?? '');
  const tenant = await currentTenant();
  const api = await harness();

  await api.modelKeys?.forget(tenant.id, provider);

  revalidatePath('/keys');
  redirect(`/keys?forgot=${encodeURIComponent(provider)}`);
}
