// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * What a page shows when something got past it.
 *
 * Without this file Next renders its own — a grey "This page couldn't load" and
 * a number — which is the one screen in the console that told you nothing and
 * looked like nothing. A tool whose job is to make a system legible must not
 * hand you an opaque page at the exact moment the system stopped being legible.
 *
 * `Failure` is for a page that *caught* its error and knows what it means. This
 * is the net under everything else, so it says less and offers the two things
 * that actually help: try again, or go somewhere that works.
 */

import { ArrowClockwiseIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // The server already logged it; this is for whoever has the console open
    // with devtools, which is who is most likely to be debugging.
    console.error(error);
  }, [error]);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WarningIcon className="text-destructive size-5" weight="fill" />
          Something went wrong on this page
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
          {error.message || 'No message came with it.'}
        </pre>
        <p className="text-muted-foreground text-sm">
          The rest of the console is unaffected — each page reads the harness on its own. If this
          keeps happening, <code className="text-foreground">docker compose logs console</code> has
          the stack.
        </p>
        <div className="flex gap-2">
          <Button onClick={reset} size="sm">
            <ArrowClockwiseIcon /> Try again
          </Button>
          <Button variant="outline" size="sm" render={<a href="/" />}>
            Back to overview
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
