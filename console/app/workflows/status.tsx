// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * How a run's state looks, in one place.
 *
 * Shared between the list and the run page so the same state never reads as two
 * different things — `awaiting_approval` is "waiting on you" on both, and the
 * colour agrees.
 */

import { Badge } from '@/components/ui/badge';

const LABELS: Record<string, { readonly text: string; readonly variant: BadgeVariant }> = {
  running: { text: 'running', variant: 'outline' },
  awaiting_approval: { text: 'waiting on you', variant: 'secondary' },
  completed: { text: 'done', variant: 'default' },
  failed: { text: 'failed', variant: 'destructive' },
  skipped: { text: 'skipped', variant: 'outline' },
};

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export function RunStatusBadge({ status }: { readonly status: string }) {
  const label = LABELS[status] ?? { text: status, variant: 'outline' as const };
  return <Badge variant={label.variant}>{label.text}</Badge>;
}

/** A timestamp somebody can compare at a glance, without a timezone puzzle. */
export function when(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
