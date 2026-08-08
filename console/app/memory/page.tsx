// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared knowledge, as a list of sources.
 *
 * A source is the unit of permission — an agent is granted one of these, never
 * a document — so this page is where somebody decides what shapes of knowledge
 * exist before deciding who reads them.
 */

import { BooksIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { createSource } from './actions';

export const dynamic = 'force-dynamic';

export default async function Memory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const params = await searchParams;
    const error = Array.isArray(params['error']) ? params['error'][0] : params['error'];

    const tenant = await currentTenant();
    const api = await harness();

    if (!api.memory) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Shared knowledge</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Nothing can be remembered yet: no embedding provider is configured, and without one a
              document could be stored and never found again.
            </p>
            <p>
              Add an <code className="text-foreground">embedding</code> block to{' '}
              <code className="text-foreground">config/models.json</code> and set the key it names.
              The model must produce 1536 dimensions, which is what the schema stores.
            </p>
          </CardContent>
        </Card>
      );
    }

    const sources = await api.memory.listSources(tenant.id);

    return (
      <div className="space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Shared knowledge</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Documents you add and what your connected sources hold, searchable by the agents you
            grant. This is <strong>not</strong> an agent&rsquo;s own memory — each agent still keeps
            its own state privately, and asks its neighbours when it needs theirs.
          </p>
        </header>

        {error ? (
          <Card className="border-destructive/40">
            <CardContent className="flex items-start gap-3 py-4 text-sm">
              <WarningIcon className="text-destructive mt-0.5 size-5 shrink-0" weight="fill" />
              <span>{error}</span>
            </CardContent>
          </Card>
        ) : null}

        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">No sources yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sources.map((source) => (
              <a key={source.id} href={`/memory/${source.slug}`} className="group">
                <Card className="hover:border-primary/50 h-full transition-colors">
                  <CardContent className="space-y-2 py-5">
                    <div className="flex items-center gap-2">
                      <BooksIcon className="text-primary size-5" weight="fill" />
                      <span className="font-medium">{source.name}</span>
                      <code className="text-muted-foreground text-xs">{source.slug}</code>
                      <Badge variant="secondary" className="ml-auto">
                        {source.documents} {source.documents === 1 ? 'document' : 'documents'}
                      </Badge>
                    </div>
                    {source.description ? (
                      <p className="text-muted-foreground text-sm">{source.description}</p>
                    ) : null}
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">New source</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createSource} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Handle</span>
                  <Input name="slug" placeholder="wiki" required pattern="[a-z][a-z0-9-]{1,63}" />
                  <span className="text-muted-foreground block text-sm">
                    Lowercase, digits and dashes. This is what an agent&rsquo;s grant names, so it
                    survives the source being emptied and refilled.
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Name</span>
                  <Input name="name" placeholder="Team wiki" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-sm font-medium">What is in it</span>
                <Input name="description" placeholder="Everything the team has written down." />
              </label>
              <Button type="submit" size="sm">
                Create source
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
