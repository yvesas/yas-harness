// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Assembling one agent: a model, a prompt, and what it may reach.
 *
 * The grants are the part worth getting right on screen. A person ticking boxes
 * is deciding what an autonomous thing may do to their data, so the form says
 * what each capability means in words rather than showing six verbs and hoping.
 *
 * Sources are offered from what is actually configured — the connectors with an
 * OAuth entry, plus any already connected. Typing a connector name that does
 * not exist would produce an agent whose tools reach nothing, and the failure
 * would arrive much later, in a conversation.
 */

import { WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { harness } from '../../../lib/harness';
import { currentTenant } from '../../../lib/tenant';
import { readAgent } from '../../../lib/agent-files';
import { Failure } from '../../failure';
import { deleteAgentAction, saveAgentAction } from '../actions';

export const dynamic = 'force-dynamic';

/** What each capability lets an agent do, for somebody who is not reading a schema. */
const CAPABILITIES: readonly {
  id: string;
  label: string;
  hint: string;
  write?: boolean;
}[] = [
  { id: 'list', label: 'Browse', hint: 'see what is there' },
  { id: 'read', label: 'Read', hint: 'open a document and use its contents' },
  { id: 'search', label: 'Search', hint: 'find things by a query' },
  { id: 'create', label: 'Create', hint: 'add something new', write: true },
  { id: 'update', label: 'Change', hint: 'edit something that exists', write: true },
  { id: 'delete', label: 'Delete', hint: 'remove something, permanently', write: true },
];

export default async function EditAgent({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const { agentId } = await params;
    const query = await searchParams;
    const one = (key: string): string | undefined => {
      const value = query[key];
      return Array.isArray(value) ? value[0] : value;
    };

    const isNew = agentId === 'new';
    const agent = isNew ? null : await readAgent(agentId);
    if (!isNew && !agent) {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">No such agent</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Nothing named <code className="text-foreground">{agentId}</code> in{' '}
            <code className="text-foreground">config/agents/</code>.
          </p>
          <p className="mt-4">
            <a href="/agents">Back to agents</a>
          </p>
        </>
      );
    }

    const tenant = await currentTenant();
    const api = await harness();
    const connected = await api.connections.list(tenant.id);
    const sources = [
      ...new Set([
        ...(api.onboarding?.connectable() ?? []),
        ...connected.map((connection) => connection.connectorId),
      ]),
    ].sort();
    const models = Object.keys(api.models.models).sort();

    const granted = (connectorId: string): readonly string[] =>
      agent?.connections.find((grant) => grant.connectorId === connectorId)?.can ?? [];

    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isNew ? 'New agent' : agent!.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isNew
              ? 'It needs no code. Its tools are the generic operations over the sources you grant it.'
              : `config/agents/${agent!.id}.json`}
          </p>
        </header>

        {one('saved') ? <p className="text-primary text-sm">Saved.</p> : null}
        {one('error') ? (
          <Card className="border-destructive/40">
            <CardContent className="flex items-start gap-3 py-4">
              <WarningIcon className="text-destructive mt-0.5 size-5 shrink-0" weight="fill" />
              <div className="text-sm">
                <div className="font-medium">Not saved</div>
                <p className="text-muted-foreground">{one('error')}</p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <form action={saveAgentAction} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What it is</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">Id</span>
                <Input
                  name="id"
                  defaultValue={agent?.id ?? ''}
                  readOnly={!isNew}
                  placeholder="research"
                  required
                />
                <span className="text-muted-foreground block text-sm">
                  Lowercase, digits and dashes. It names the file and cannot change afterwards —
                  renaming would be a different agent.
                </span>
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium">Name</span>
                <Input
                  name="name"
                  defaultValue={agent?.name ?? ''}
                  placeholder="Research"
                  required
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium">When should this agent answer?</span>
                <textarea
                  name="description"
                  defaultValue={agent?.description ?? ''}
                  rows={3}
                  required
                  placeholder="Reads connected documents and answers questions from them. Does not write anything."
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                />
                <span className="text-muted-foreground block text-sm">
                  This is <strong>all the router reads</strong> when deciding. Say what it does and
                  what it does not — a description that does not tell it apart from its neighbours
                  is the commonest cause of a turn going to the wrong agent.
                </span>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">How it works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">Prompt</span>
                <textarea
                  name="instructions"
                  defaultValue={agent?.instructions ?? ''}
                  rows={8}
                  required
                  placeholder="Answer only from what you actually read. Quote the title of what you used. If you did not find it, say so rather than guessing."
                  className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
                />
                <span className="text-muted-foreground block text-sm">
                  Added to the product&rsquo;s own instructions rather than replacing them, so the
                  voice, language and safety rules survive whichever agent answers.
                </span>
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Model</span>
                  <select
                    name="model"
                    defaultValue={agent?.model ?? ''}
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  >
                    <option value="">Decide by task kind</option>
                    {models.map((reference) => (
                      <option key={reference} value={reference}>
                        {reference}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium">Task kind</span>
                  <select
                    name="task"
                    defaultValue={agent?.task ?? ''}
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  >
                    <option value="">Same as the product</option>
                    <option value="simple">Simple — cheap model</option>
                    <option value="reasoning">Reasoning</option>
                    <option value="sensitive">Sensitive — never a cheap model</option>
                  </select>
                </label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What it may reach</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {sources.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No sources are configured yet. An agent with none still works — it answers from
                  the conversation alone. Add one in{' '}
                  <a href="/connections" className="underline">
                    Connections
                  </a>
                  .
                </p>
              ) : (
                sources.map((connectorId) => {
                  const has = granted(connectorId);
                  const accounts = connected.filter(
                    (connection) => connection.connectorId === connectorId,
                  ).length;
                  return (
                    <div key={connectorId} className="space-y-2">
                      <input type="hidden" name="connector" value={connectorId} />
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{connectorId}</span>
                        <Badge variant="outline">
                          {accounts === 0 ? 'not connected' : `${String(accounts)} connected`}
                        </Badge>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {CAPABILITIES.map((capability) => (
                          <label key={capability.id} className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              name={`can:${connectorId}`}
                              value={capability.id}
                              defaultChecked={has.includes(capability.id)}
                              className="mt-1"
                            />
                            <span>
                              <span
                                className={
                                  capability.write ? 'text-destructive font-medium' : 'font-medium'
                                }
                              >
                                {capability.label}
                              </span>
                              <span className="text-muted-foreground block">{capability.hint}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="approveWrites"
                  defaultChecked={agent?.approveWrites ?? true}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">Ask me before it changes anything</span>
                  <span className="text-muted-foreground block">
                    A create, change or delete pauses and waits for you in Approvals. Turning this
                    off lets the agent act on its own — leave it on unless you have a reason.
                  </span>
                </span>
              </label>
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button type="submit">{isNew ? 'Create agent' : 'Save'}</Button>
            <a href="/agents" className="text-muted-foreground text-sm">
              Cancel
            </a>
          </div>
        </form>

        {isNew ? null : (
          <form action={deleteAgentAction}>
            <input type="hidden" name="id" value={agent!.id} />
            <Button type="submit" variant="ghost" size="sm" className="text-destructive">
              Delete this agent
            </Button>
          </form>
        )}
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
