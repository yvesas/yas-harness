// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Deciding.
 *
 * A rejection carries a reason and an approval does not have to. That asymmetry
 * is deliberate: "no" is the answer somebody will have to act on — the agent
 * relays it, and a person on the other end needs to know whether to rephrase,
 * wait, or give up. "Yes" explains itself by what happens next.
 *
 * "Do it differently" **requires** the note, and the store enforces that rather
 * than trusting this form: sent back with nothing to change, the model learns
 * only that its arguments were wrong and not which one, which is a loop.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { operator } from '../../lib/operator';

export async function approve(form: FormData): Promise<void> {
  await decide(form, 'approved');
}

export async function reject(form: FormData): Promise<void> {
  await decide(form, 'rejected');
}

export async function requestChanges(form: FormData): Promise<void> {
  await decide(form, 'changes_requested');
}

async function decide(
  form: FormData,
  outcome: 'approved' | 'rejected' | 'changes_requested',
): Promise<void> {
  const id = String(form.get('approvalId') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  const tenant = await currentTenant();
  const api = await harness();

  const decision = {
    decidedBy: await operator(),
    ...(reason === '' ? {} : { reason }),
  };

  // A second decision on the same row throws `ApprovalNotPendingError` — the
  // store settles the race, not this action. Two people in the inbox at once is
  // the normal case, not the exceptional one.
  if (outcome === 'approved') {
    await api.approvals.approve(tenant.id, id, decision);
  } else if (outcome === 'rejected') {
    await api.approvals.reject(tenant.id, id, decision);
  } else {
    if (reason === '') {
      redirect(`/approvals/${id}?error=${encodeURIComponent('Say what to change.')}`);
    }
    await api.approvals.requestChanges(tenant.id, id, { ...decision, reason });
  }

  revalidatePath('/approvals');
  redirect('/approvals');
}
