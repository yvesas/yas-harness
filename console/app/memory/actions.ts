// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Creating knowledge sources and filling them.
 *
 * Ingestion costs money — every document is embedded — so these actions report
 * what they did rather than succeeding silently. "Added 12, skipped 40
 * unchanged" is the difference between trusting a re-ingest and fearing it.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { INGEST_LIMIT } from '../../lib/memory-limits';

export async function createSource(form: FormData): Promise<never> {
  const slug = String(form.get('slug') ?? '').trim();
  try {
    const tenant = await currentTenant();
    const api = await harness();
    if (!api.memory) {
      throw new Error('no embedding provider is configured, so nothing can be remembered');
    }

    const description = String(form.get('description') ?? '').trim();
    await api.memory.createSource({
      tenantId: tenant.id,
      slug,
      name: String(form.get('name') ?? '').trim() || slug,
      ...(description === '' ? {} : { description }),
    });

    revalidatePath('/memory');
    redirect(`/memory/${slug}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) throw error;
    redirect(`/memory?error=${encodeURIComponent(message(error))}`);
  }
}

export async function addDocument(form: FormData): Promise<never> {
  const slug = String(form.get('slug') ?? '');
  try {
    const tenant = await currentTenant();
    const api = await harness();
    const source = await api.memory?.findSourceBySlug(tenant.id, slug);
    if (!api.memory || !source) {
      throw new Error(`no source named "${slug}"`);
    }

    const outcome = await api.memory.ingest({
      tenantId: tenant.id,
      sourceId: source.id,
      title: String(form.get('title') ?? '').trim(),
      body: String(form.get('body') ?? ''),
      ...(String(form.get('url') ?? '').trim() === ''
        ? {}
        : { url: String(form.get('url')).trim() }),
    });

    revalidatePath(`/memory/${slug}`);
    redirect(`/memory/${slug}?added=${encodeURIComponent(outcome.document.title)}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) throw error;
    redirect(`/memory/${slug}?error=${encodeURIComponent(message(error))}`);
  }
}

/**
 * Fill a source from a connected service.
 *
 * Reads each resource in turn rather than in parallel: the point of the cap is
 * to be gentle on a source somebody else owns, and fifty concurrent reads is
 * not gentle. A resource that fails is counted and skipped — one unreadable
 * file should not abandon the other forty-nine.
 */
export async function ingestFromConnection(form: FormData): Promise<never> {
  const slug = String(form.get('slug') ?? '');
  const connectionId = String(form.get('connectionId') ?? '');

  try {
    const tenant = await currentTenant();
    const api = await harness();
    const source = await api.memory?.findSourceBySlug(tenant.id, slug);
    if (!api.memory || !source || !api.cachedConnections) {
      throw new Error('this deployment cannot ingest from a connection');
    }

    const page = await api.cachedConnections.list(tenant.id, connectionId, {
      limit: INGEST_LIMIT,
    });

    let added = 0;
    let unchanged = 0;
    let failed = 0;

    for (const summary of page.resources) {
      try {
        const resource = await api.cachedConnections.read(tenant.id, connectionId, summary.id);
        if (!resource.content || resource.content.trim() === '') {
          continue;
        }
        const outcome = await api.memory.ingest({
          tenantId: tenant.id,
          sourceId: source.id,
          // The id it has at the source, so a second run updates in place.
          externalId: `${connectionId}:${resource.id}`,
          title: resource.title,
          body: resource.content,
          ...(resource.url === null ? {} : { url: resource.url }),
          metadata: { connectionId, connectorId: resource.type },
        });
        if (outcome.embedded) added += 1;
        else unchanged += 1;
      } catch {
        failed += 1;
      }
    }

    revalidatePath(`/memory/${slug}`);
    redirect(
      `/memory/${slug}?ingested=${String(added)}&unchanged=${String(unchanged)}&failed=${String(
        failed,
      )}&seen=${String(page.resources.length)}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) throw error;
    redirect(`/memory/${slug}?error=${encodeURIComponent(message(error))}`);
  }
}

export async function deleteDocument(form: FormData): Promise<never> {
  const slug = String(form.get('slug') ?? '');
  const tenant = await currentTenant();
  const api = await harness();
  await api.memory?.deleteDocument(tenant.id, String(form.get('documentId') ?? ''));
  revalidatePath(`/memory/${slug}`);
  redirect(`/memory/${slug}`);
}

export async function deleteSource(form: FormData): Promise<never> {
  const tenant = await currentTenant();
  const api = await harness();
  await api.memory?.deleteSource(tenant.id, String(form.get('sourceId') ?? ''));
  revalidatePath('/memory');
  redirect('/memory');
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
