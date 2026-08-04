// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Saving a configuration file.
 *
 * Validation happens inside `save`, with the harness's own parsers, before
 * anything reaches the disk. A draft that would stop the harness starting is
 * rejected while it is still text in a form — which is the only moment it costs
 * nothing.
 */

import { revalidatePath } from 'next/cache';

import { asConfigFile, save } from '../../lib/config-files';

export interface SaveOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export async function saveConfig(
  _previous: SaveOutcome | null,
  form: FormData,
): Promise<SaveOutcome> {
  try {
    const file = asConfigFile(String(form.get('file') ?? ''));
    await save(file, String(form.get('text') ?? ''));
    revalidatePath('/config');
    return { ok: true, message: `${file} saved. The harness reads it on its next start.` };
  } catch (error) {
    // Returned rather than thrown: a rejected draft is the normal state of a
    // form somebody is halfway through, not an error page.
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
