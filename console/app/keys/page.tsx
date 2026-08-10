// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Model keys, kept encrypted.
 *
 * The console will not put a secret in `config/*.json` — that file is in Git,
 * and a page that writes secrets to Git is a page that will one day leak one.
 * This is the supported way instead, and it is better in every respect that
 * matters: the key is sealed with the same envelope encryption the OAuth
 * credentials use, it never reaches a file, and nothing renders it back.
 *
 * The mechanism is E3 — a *tenant's own* key, which the gateway prefers over
 * the platform's. For somebody running this for themselves those are the same
 * person, and this is simply where the key goes: pasted once, encrypted at
 * rest, changeable without editing a file. The multi-tenant meaning is there
 * when a product needs it and costs nothing until then.
 *
 * It exists because E3 built all of this and nothing surfaced it — the same
 * story as `readiness`. A port with no consumer is a port nobody can trust.
 *
 * The page has to be honest about one consequence, because it is surprising and
 * it is deliberate: **bringing a key opts this tenant out of the platform's**.
 * A tenant with any key of their own is routed only to providers they have a
 * key for, and a task with no covered provider fails rather than falling back —
 * because falling back would send their data to a provider they did not choose
 * and bill somebody else for it. So the page shows every provider, says which
 * are covered, and names what stops working while any is missing.
 */

import { CheckCircleIcon, KeyIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { forgetKey, saveKey } from './actions';

export const dynamic = 'force-dynamic';

/** Which tasks each provider is the first choice for, in plain language. */
function usedFor(
  routes: Record<string, readonly string[]>,
  models: Record<string, { provider: string }>,
  provider: string,
): string[] {
  const labels: Record<string, string> = {
    routing: 'deciding which module answers',
    simple: 'simple work',
    reasoning: 'reasoning',
    sensitive: 'anything sensitive',
  };
  return Object.entries(routes)
    .filter(([, references]) =>
      references.some((reference) => models[reference]?.provider === provider),
    )
    .map(([task]) => labels[task] ?? task);
}

export default async function Keys({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const params = await searchParams;
    const one = (key: string): string | undefined => {
      const value = params[key];
      return Array.isArray(value) ? value[0] : value;
    };

    const tenant = await currentTenant();
    const api = await harness();

    if (!api.modelKeys) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Your own model keys</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              There is no credential vault, so a key cannot be sealed and this page has nothing safe
              to do.
            </p>
            <p>
              It needs <code className="text-foreground">MASTER_ENCRYPTION_KEY</code> — the key that
              encrypts every stored secret. <code className="text-foreground">./start.sh</code>{' '}
              generates one.
            </p>
          </CardContent>
        </Card>
      );
    }

    const mine = new Set(await api.modelKeys.providers(tenant.id));
    const providers = Object.keys(api.models.providers).sort();
    const missing = providers.filter((provider) => !mine.has(provider));
    // Only a *completion* key opts this tenant out of the platform's. The
    // embedding key pays for shared knowledge and routes nothing, so holding
    // one alone must not raise the warning below — a tenant who paid only for
    // knowledge has not chosen anything about where their turns go.
    const usingOwn = providers.some((provider) => mine.has(provider));
    const embedding = api.models.embedding ?? null;

    return (
      <div className="space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your own model keys</h1>
          <p className="text-muted-foreground text-sm">
            Where a provider key goes. Paste it once and it is encrypted immediately — it never
            reaches a file, never goes near Git, and is never shown again, including to you.
            Changing it is this form; there is nothing to edit on disk.
          </p>
        </header>

        {one('saved') ? (
          <p className="text-primary text-sm">Saved the key for {one('saved')}.</p>
        ) : null}
        {one('forgot') ? (
          <p className="text-muted-foreground text-sm">
            Forgot the key for {one('forgot')}. It falls back to whatever the environment provides.
          </p>
        ) : null}
        {one('error') ? <p className="text-destructive text-sm">{one('error')}</p> : null}

        {usingOwn && missing.length > 0 ? (
          <Card className="border-destructive/40">
            <CardContent className="flex items-start gap-3 py-4">
              <WarningIcon className="text-destructive mt-0.5 size-5 shrink-0" weight="fill" />
              <div className="space-y-1 text-sm">
                <div className="font-medium">
                  {missing.join(' and ')} {missing.length === 1 ? 'has' : 'have'} no key here yet
                </div>
                <p className="text-muted-foreground">
                  Saving one key here means every provider has to have one: anything routed to{' '}
                  {missing.map((provider) => (
                    <span key={provider}>
                      <strong className="text-foreground">{provider}</strong>{' '}
                    </span>
                  ))}
                  will fail until it does. That is deliberate — the alternative is quietly falling
                  back to a key you did not choose, which is how prompts end up at a provider
                  somebody did not intend and a bill lands on the wrong account.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {embedding ? (
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Shared knowledge</h2>
            <p className="text-muted-foreground max-w-2xl text-sm">
              A separate key, because it buys a different thing: turning your documents into vectors
              so agents can search them. It does <strong>not</strong> opt you out of anything —
              there is one embedding provider and nowhere else this could be routed, so a tenant
              without a key here simply uses whatever the deployment configured, if it configured
              anything.
            </p>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyIcon
                    className={
                      mine.has(embedding.provider)
                        ? 'text-primary size-4'
                        : 'text-muted-foreground size-4'
                    }
                    weight="fill"
                  />
                  {embedding.provider}
                  {mine.has(embedding.provider) ? (
                    <Badge variant="secondary" className="ml-auto">
                      <CheckCircleIcon weight="fill" /> key stored
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="ml-auto">
                      no key here
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  Embeds with <code className="text-foreground">{embedding.model}</code> at{' '}
                  <code className="text-foreground break-all">{embedding.baseUrl}</code>. Your key
                  changes who pays, never which model embeds — vectors from two different models
                  cannot be compared, so the model stays what the deployment declared.
                </p>
                <form action={saveKey} className="flex gap-2">
                  <input type="hidden" name="provider" value={embedding.provider} />
                  <Input
                    type="password"
                    name="apiKey"
                    autoComplete="off"
                    placeholder={
                      mine.has(embedding.provider) ? 'Replace with a new key' : 'Paste your key'
                    }
                  />
                  <Button type="submit" size="sm">
                    {mine.has(embedding.provider) ? 'Replace' : 'Save'}
                  </Button>
                </form>
                {mine.has(embedding.provider) ? (
                  <form action={forgetKey}>
                    <input type="hidden" name="provider" value={embedding.provider} />
                    <Button type="submit" size="sm" variant="ghost">
                      Forget it
                    </Button>
                  </form>
                ) : embedding.apiKeyEnv ? (
                  <p className="text-muted-foreground text-sm">
                    Without one, embedding falls back to{' '}
                    <code className="text-foreground">{embedding.apiKeyEnv}</code> from the
                    environment.
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    This deployment configured no key of its own, so shared knowledge does nothing
                    until you paste one here.
                  </p>
                )}
              </CardContent>
            </Card>
          </section>
        ) : null}

        <h2 className="text-lg font-medium">Turns</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {providers.map((provider) => {
            const entry = api.models.providers[provider]!;
            const held = mine.has(provider);
            const tasks = usedFor(api.models.routes, api.models.models, provider);

            return (
              <Card key={provider}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyIcon
                      className={held ? 'text-primary size-4' : 'text-muted-foreground size-4'}
                      weight="fill"
                    />
                    {provider}
                    {held ? (
                      <Badge variant="secondary" className="ml-auto">
                        <CheckCircleIcon weight="fill" /> key stored
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="ml-auto">
                        no key here
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    {tasks.length > 0
                      ? `Used for ${tasks.join(', ')}.`
                      : 'Configured, not routed to.'}{' '}
                    {entry.baseUrl ? (
                      <span className="break-all">
                        Talks to <code className="text-foreground">{entry.baseUrl}</code>.
                      </span>
                    ) : null}
                  </p>

                  <form action={saveKey} className="flex gap-2">
                    <input type="hidden" name="provider" value={provider} />
                    <Input
                      type="password"
                      name="apiKey"
                      autoComplete="off"
                      placeholder={held ? 'Replace with a new key' : 'Paste your key'}
                    />
                    <Button type="submit" size="sm">
                      {held ? 'Replace' : 'Save'}
                    </Button>
                  </form>

                  {held ? (
                    <form action={forgetKey}>
                      <input type="hidden" name="provider" value={provider} />
                      <Button type="submit" size="sm" variant="ghost">
                        Forget this key
                      </Button>
                    </form>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="text-muted-foreground text-sm">
          The key is sealed the moment you save it. This page can tell you a provider <em>has</em>{' '}
          one and cannot tell you what it is — nothing here reads a key back, which is the same rule
          that keeps the agent from ever seeing one.
        </p>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
