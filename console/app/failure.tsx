// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What a page shows when the harness could not answer.
 *
 * A console whose job is to make a system legible must not itself fail
 * illegibly. The two failures worth naming are the ones every new install hits:
 * no database, and no tenant.
 */

import { WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function Failure({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const noDatabase = /ECONNREFUSED|does not exist|relation .* does not exist/i.test(message);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WarningIcon className="text-destructive size-5" weight="fill" />
          The harness could not answer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">{message}</pre>
        {noDatabase ? (
          <p className="text-muted-foreground text-sm">
            This usually means Postgres is not up, or the migrations have not been applied. Run{' '}
            <code className="text-foreground">./start.sh</code>, which checks both.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            The console reads through the harness&rsquo;s ports and never around them, so this is
            the harness&rsquo;s answer rather than a display problem.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
