// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Starting a conversation, and taking a turn in one.
 *
 * The turn is `route` then `run`, in that order, sharing a trace. That sharing
 * is the whole reason the playground is useful: a routing decision and the turn
 * it chose read as one trace, so the panel beside the chat shows *why* a module
 * was picked and not only what happened afterwards.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';

export async function startConversation(): Promise<never> {
  const tenant = await currentTenant();
  const api = await harness();
  const session = await api.sessions.create({ tenantId: tenant.id, personaId: 'default' });
  redirect(`/playground/${session.id}`);
}

export async function send(form: FormData): Promise<void> {
  const sessionId = String(form.get('sessionId') ?? '');
  const input = String(form.get('input') ?? '').trim();
  if (input === '') {
    return;
  }

  const tenant = await currentTenant();
  const api = await harness();
  const attribution = { tenantId: tenant.id, sessionId };

  let failure: string | null = null;
  try {
    // Routing first, and its trace id is carried into the turn. Two traces
    // would mean opening two pages to answer one question.
    const decision = await api.router.route({ text: input, attribution });
    await api.agent.run({
      tenantId: tenant.id,
      sessionId,
      input,
      // The decision, acted on. Passing only the trace id -- which is what this
      // did -- meant the router chose a module and the turn ignored it.
      moduleId: decision.moduleId,
      traceId: decision.traceId,
    });
  } catch (error) {
    // Caught, because a turn failing is an ordinary answer here — an absent
    // model key, a provider refusing, a tool throwing. Letting it out of the
    // action replaces the whole page with an error boundary, which loses the
    // conversation, the trace that shows how far it got, and the input box.
    failure = error instanceof Error ? error.message : String(error);
  }

  revalidatePath(`/playground/${sessionId}`);
  if (failure !== null) {
    redirect(`/playground/${sessionId}?failed=${encodeURIComponent(failure.slice(0, 300))}`);
  }
}
