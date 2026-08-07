// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Two demonstration modules — and why there have to be two.
 *
 * They are not decoration. Without a module the router has nothing to route
 * between, the Modules page is empty, and the context broker has nothing to
 * demonstrate. And **one** module is not enough: the router short-circuits when
 * there is only one candidate (a decision with one option is not a decision),
 * and a context request needs somebody to ask somebody else.
 *
 * They are also the only place this console touches the Golden Rule. `notes`
 * and `links` are as close to no business domain as a module can get while
 * still being a module — which is the honest limit of what a console can test
 * about a boundary that a real product would press much harder.
 *
 * The pair is chosen to show the two answers a context request can get:
 *
 * - **`notes` declares `disclose`** and answers with the *titles* of its notes,
 *   never their bodies. An owner deciding what to reveal is the whole point of
 *   the broker; a module that hands over everything it has is not exercising it.
 * - **`links` declares nothing**, so it shares nothing. That is the harness
 *   failing closed, and it is worth seeing on a page: silence is a decision.
 */

import { z } from 'zod';
import {
  ModuleRegistry,
  ToolRegistry,
  type ToolDefinition,
  denied,
  granted,
  type ContextRequest,
  type ContextGrant,
  type PoolStore,
} from 'yas-harness';

interface Note {
  readonly title: string;
  readonly body: string;
  readonly at: string;
}

interface Link {
  readonly url: string;
  readonly why: string;
  readonly at: string;
}

const NOTES = 'notes';
const LINKS = 'links';

/** How many entries a listing tool will put in front of a model. */
const LISTING_LIMIT = 20;

/**
 * The modules, and the tools the agent may run.
 *
 * Two registries, filled together on purpose. A module's `tools` is what that
 * module declares — the Modules page reads it, and the router reasons about it.
 * The agent's `ToolRegistry` is what it is actually allowed to call. The harness
 * keeps them apart because a product may want the agent to run less than a
 * module advertises; this product wants them identical, so a page cannot show
 * one thing while the agent runs another.
 */
export function buildModules(pools: () => Promise<PoolStore>): {
  modules: ModuleRegistry;
  tools: ToolRegistry;
} {
  const tools = new ToolRegistry();
  const modules = new ModuleRegistry()
    .register(notesModule(pools, tools))
    .register(linksModule(pools, tools));
  return { modules, tools };
}

/**
 * Register one tool into both registries.
 *
 * A function rather than a loop over an array: `ToolDefinition<Input>` is
 * contravariant in its input, so a list of tools with different schemas has no
 * useful common type, and the cast that would paper over it is hiding the very
 * thing the registry exists to check.
 */
function into<Input>(tool: ToolDefinition<Input>, ...registries: readonly ToolRegistry[]): void {
  for (const registry of registries) {
    registry.register(tool);
  }
}

function notesModule(pools: () => Promise<PoolStore>, agent: ToolRegistry) {
  const tools = new ToolRegistry();
  into(
    {
      name: 'note_add',
      description: 'Write down a short note under a title, so it can be recalled later.',
      input: z.object({
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(4000),
      }),
      execute: async ({ title, body }, context) => {
        const store = await pools();
        const note: Note = { title, body, at: new Date().toISOString() };
        await store.set({ tenantId: context.tenantId, moduleId: NOTES }, keyFor(title), note);
        return { content: `Noted "${title}".`, isError: false };
      },
    },
    tools,
    agent,
  );
  into(
    {
      name: 'note_list',
      description: 'List the titles of the notes written down so far.',
      input: z.object({}),
      execute: async (_input, context) => {
        const store = await pools();
        const entries = await store.list({ tenantId: context.tenantId, moduleId: NOTES });
        if (entries.length === 0) {
          return { content: 'There are no notes yet.', isError: false };
        }
        const titles = entries
          .slice(0, LISTING_LIMIT)
          .map((entry) => `- ${(entry.value as Note).title}`)
          .join('\n');
        return { content: titles, isError: false };
      },
    },
    tools,
    agent,
  );

  return {
    id: NOTES,
    description: 'Short written notes, kept under titles and recalled by title.',
    tools,
    agent: {
      instructions:
        'You are handling notes. Keep replies to a sentence, and confirm what was written down.',
      // Filing a note needs no reasoning, and routing it to a premium model
      // would spend the difference on nothing.
      task: 'simple' as const,
    },
    /**
     * Titles, never bodies — and only when a purpose was stated.
     *
     * The owner deciding *what* to reveal is the point of the broker. Handing
     * over whole notes because somebody asked politely would make the request
     * a formality.
     */
    disclose: (request: ContextRequest): Promise<ContextGrant> =>
      discloseTitles(request, pools).catch((error: unknown) =>
        denied(`the notes module could not answer: ${String(error)}`),
      ),
  };
}

async function discloseTitles(
  request: ContextRequest,
  pools: () => Promise<PoolStore>,
): Promise<ContextGrant> {
  const store = await pools();
  const entries = await store.list({ tenantId: request.tenantId, moduleId: NOTES });
  if (entries.length === 0) {
    return denied('there are no notes to share');
  }
  return granted(
    entries.slice(0, LISTING_LIMIT).map((entry) => ({
      key: entry.key,
      value: (entry.value as Note).title,
    })),
  );
}

function linksModule(pools: () => Promise<PoolStore>, agent: ToolRegistry) {
  const tools = new ToolRegistry();
  into(
    {
      name: 'link_save',
      description: 'Save a link with a one-line reason for keeping it.',
      input: z.object({
        url: z.string().url(),
        why: z.string().min(1).max(280),
      }),
      execute: async ({ url, why }, context) => {
        const store = await pools();
        const link: Link = { url, why, at: new Date().toISOString() };
        await store.set({ tenantId: context.tenantId, moduleId: LINKS }, keyFor(url), link);
        return { content: `Saved ${url}.`, isError: false };
      },
    },
    tools,
    agent,
  );
  into(
    {
      name: 'link_list',
      description: 'List the links saved so far, with the reason each was kept.',
      input: z.object({}),
      execute: async (_input, context) => {
        const store = await pools();
        const entries = await store.list({ tenantId: context.tenantId, moduleId: LINKS });
        if (entries.length === 0) {
          return { content: 'No links saved yet.', isError: false };
        }
        const lines = entries
          .slice(0, LISTING_LIMIT)
          .map((entry) => {
            const link = entry.value as Link;
            return `- ${link.url} — ${link.why}`;
          })
          .join('\n');
        return { content: lines, isError: false };
      },
    },
    tools,
    agent,
  );

  return {
    id: LINKS,
    description: 'Saved links, each with the reason it was worth keeping.',
    tools,
    agent: {
      instructions:
        'You are handling saved links. When saving one, repeat back the reason it was kept.',
      task: 'simple' as const,
    },
    // No `disclose`, on purpose: a module that declares nothing shares nothing.
    // The Modules page shows that as a fact rather than an omission.
  };
}

/** A pool key that is stable for the same title and safe as a key. */
function keyFor(subject: string): string {
  return subject
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .slice(0, 80);
}
