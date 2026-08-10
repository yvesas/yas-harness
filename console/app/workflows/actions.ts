// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Starting a workflow, and picking one back up.
 *
 * Both wait for the run to reach its next stopping point — the end, a failure,
 * or a person. That is a real wait: three steps with tool calls is a minute of
 * somebody watching a button. It is done this way because driving the run
 * detached needs its id *before* it is driven, and the harness hands the id
 * back afterwards — so a detached start could not say which run it had
 * started. The page says the wait is coming rather than pretending otherwise.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { operator } from '../../lib/operator';

export async function startRun(form: FormData): Promise<never> {
  const workflowId = String(form.get('workflowId') ?? '');
  let runId: string;
  try {
    const input = String(form.get('input') ?? '').trim();
    if (input === '') {
      throw new Error('say what this run should work on — the first step is asked about it');
    }

    const tenant = await currentTenant();
    const api = await harness();
    const { run } = await api.workflowRunner.start({
      tenantId: tenant.id,
      workflowId,
      input,
      startedBy: await operator(),
    });
    runId = run.id;
  } catch (error) {
    redirect(`/workflows/${workflowId}?error=${encodeURIComponent(message(error))}`);
  }

  // Outside the try: `redirect` works by throwing, and catching our own
  // redirect would turn a started run into an error banner.
  revalidatePath('/workflows');
  redirect(`/workflows/runs/${runId}`);
}

export async function resumeRun(form: FormData): Promise<void> {
  const runId = String(form.get('runId') ?? '');
  try {
    const tenant = await currentTenant();
    const api = await harness();
    await api.workflowRunner.resume(tenant.id, runId);
  } catch (error) {
    redirect(`/workflows/runs/${runId}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath(`/workflows/runs/${runId}`);
  revalidatePath('/workflows');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
