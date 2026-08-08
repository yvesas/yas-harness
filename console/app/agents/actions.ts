// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Saving and removing a declared agent.
 *
 * The form is plain HTML, so the grants arrive as repeated fields —
 * `can:github` appears once per capability ticked. Rebuilt here into the shape
 * the harness validates, and validated by the harness rather than here.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { asAgentId, deleteAgent, saveAgent } from '../../lib/agent-files';

const CAPABILITIES = ['list', 'read', 'search', 'create', 'update', 'delete'] as const;

export async function saveAgentAction(form: FormData): Promise<never> {
  const id = String(form.get('id') ?? '');

  try {
    // One grant per connector that had at least one capability ticked. A
    // connector with none is simply not granted — an empty `can` would be a
    // grant that permits nothing, which is a confusing way to write "no".
    const connections = form
      .getAll('connector')
      .map((value) => String(value))
      .map((connectorId) => ({
        connectorId,
        can: form
          .getAll(`can:${connectorId}`)
          .map((value) => String(value))
          .filter((value): value is (typeof CAPABILITIES)[number] =>
            (CAPABILITIES as readonly string[]).includes(value),
          ),
      }))
      .filter((grant) => grant.can.length > 0);

    const model = String(form.get('model') ?? '').trim();
    const task = String(form.get('task') ?? '').trim();

    const saved = await saveAgent({
      id,
      name: String(form.get('name') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
      instructions: String(form.get('instructions') ?? '').trim(),
      ...(model === '' ? {} : { model }),
      ...(task === '' ? {} : { task }),
      connections,
      memory: form.getAll('memory').map((value) => String(value)),
      approveWrites: form.get('approveWrites') !== null,
    });

    revalidatePath('/agents');
    redirect(`/agents/${saved.id}?saved=1`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    redirect(
      `/agents/${encodeURIComponent(id)}?error=${encodeURIComponent(message.slice(0, 400))}`,
    );
  }
}

export async function deleteAgentAction(form: FormData): Promise<never> {
  await deleteAgent(asAgentId(String(form.get('id') ?? '')));
  revalidatePath('/agents');
  redirect('/agents');
}
