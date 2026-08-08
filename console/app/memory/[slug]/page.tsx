// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One source: what is in it, and the two ways to fill it.
 *
 * Ingestion costs money — every document is embedded — so this page says what a
 * run did rather than reporting success. "Added 12, 40 unchanged" is the
 * difference between trusting a re-ingest and fearing it.
 */

import { FilePlusIcon, PlugsConnectedIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';
import { INGEST_LIMIT } from '../../../lib/memory-limits';
import { addDocument, deleteDocument, deleteSource, ingestFromConnection } from '../actions';

export const dynamic = 'force-dynamic';

export default async function Source({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const { slug } = await params;
    const query = await searchParams;
    const one = (key: string): string | undefined => {
      const value = query[key];
      return Array.isArray(value) ? value[0] : value;
    };

    const tenant = await currentTenant();
    const api = await harness();
    const source = api.memory ? await api.memory.findSourceBySlug(tenant.id, slug) : null;

    if (!api.memory || !source) {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">No such source</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Nothing named <code className="text-foreground">{slug}</code>.
          </p>
          <p className="mt-4">
            <a href="/memory">Back to shared knowledge</a>
          </p>
        </>
      );
    }

    const [documents, connections] = await Promise.all([
      api.memory.listDocuments(tenant.id, source.id),
      api.connections.list(tenant.id),
    ]);

    const ingested = one('ingested');

    return (
      <div className="space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{source.name}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-foreground">{source.slug}</code> — what an agent&rsquo;s grant
            names. {source.description ?? ''}
          </p>
        </header>

        {one('added') ? <p className="text-primary text-sm">Added {one('added')}.</p> : null}
        {ingested ? (
          <Card>
            <CardContent className="space-y-1 py-4 text-sm">
              <div className="font-medium">
                Read {one('seen')} from the connection: {ingested} embedded, {one('unchanged')}{' '}
                already up to date
                {Number(one('failed') ?? '0') > 0 ? `, ${one('failed')} could not be read` : ''}.
              </div>
              <p className="text-muted-foreground">
                Only what changed was embedded — running this again costs nothing for documents that
                have not moved.
                {Number(one('seen') ?? '0') >= INGEST_LIMIT
                  ? ` It stopped at ${String(INGEST_LIMIT)}, which is one run's worth. Run it again for more.`
                  : ''}
              </p>
            </CardContent>
          </Card>
        ) : null}
        {one('error') ? (
          <Card className="border-destructive/40">
            <CardContent className="flex items-start gap-3 py-4 text-sm">
              <WarningIcon className="text-destructive mt-0.5 size-5 shrink-0" weight="fill" />
              <span>{one('error')}</span>
            </CardContent>
          </Card>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Documents <span className="text-muted-foreground text-sm">({documents.length})</span>
          </h2>
          {documents.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing here yet. Add one below, or pull from a connected source.
            </p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Passages</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell>
                        {document.url ? (
                          <a href={document.url} className="underline">
                            {document.title}
                          </a>
                        ) : (
                          document.title
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{document.chunks}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {document.updatedAt.toISOString().slice(0, 10)}
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={deleteDocument}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="documentId" value={document.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Forget
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FilePlusIcon className="size-4" /> Add a document
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form action={addDocument} className="space-y-3">
                <input type="hidden" name="slug" value={slug} />
                <Input name="title" placeholder="Title" required />
                <Input name="url" placeholder="Link back to it (optional)" />
                <textarea
                  name="body"
                  rows={8}
                  required
                  placeholder="Paste the text."
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                />
                <Button type="submit" size="sm">
                  Remember this
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PlugsConnectedIcon className="size-4" /> Pull from a connection
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {connections.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing is connected yet.{' '}
                  <a href="/connections" className="underline">
                    Connect a source
                  </a>{' '}
                  and it can fill this.
                </p>
              ) : (
                <form action={ingestFromConnection} className="space-y-3">
                  <input type="hidden" name="slug" value={slug} />
                  <select
                    name="connectionId"
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  >
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.connectorId}
                        {connection.accountLabel ? ` — ${connection.accountLabel}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-muted-foreground text-sm">
                    Reads up to {INGEST_LIMIT} documents and remembers what it can. Anything already
                    here and unchanged is skipped without being re-embedded, so running it again is
                    cheap.
                  </p>
                  <Button type="submit" size="sm">
                    Pull now
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>

        <form action={deleteSource}>
          <input type="hidden" name="sourceId" value={source.id} />
          <Button type="submit" variant="ghost" size="sm" className="text-destructive">
            Delete this source and everything in it
          </Button>
        </form>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
