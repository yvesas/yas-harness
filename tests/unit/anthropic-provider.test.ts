// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Anthropic adapter, driven by a stub client.
 *
 * The focus is where the port's neutral vocabulary meets the wire format, and
 * above all the cache breakpoint: the provider caches everything *before* the
 * marker, so putting it one block too far either leaves the prefix uncached or
 * caches a tail that changes every turn. Neither failure raises an error — both
 * just quietly cost money, which is why they are pinned here.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from '../../src/models/anthropic-provider.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';
import { userMessage } from '../../src/models/model-gateway.js';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

const REPLY: Anthropic.Message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: 'Olá!', citations: null }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  container: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 0,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    inference_geo: null,
    output_tokens_details: null,
  },
};

/** Captures what the adapter would have put on the wire. */
function stubClient() {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      create: (params: CreateParams) => {
        calls.push(params);
        return Promise.resolve(REPLY);
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

async function send(request: ModelRequest): Promise<CreateParams> {
  const { client, calls } = stubClient();
  await new AnthropicProvider({ client }).invoke({ model: 'claude-haiku-4-5', request });
  return calls[0]!;
}

/** The block a breakpoint sits on, if any — `undefined` when nothing is marked. */
function markedBlock(params: CreateParams): unknown {
  const marked: unknown[] = [];
  for (const tool of params.tools ?? []) {
    if ('cache_control' in tool && tool.cache_control) {
      marked.push(tool);
    }
  }
  if (Array.isArray(params.system)) {
    marked.push(...params.system.filter((block) => block.cache_control));
  }
  for (const message of params.messages) {
    if (typeof message.content === 'string') {
      continue;
    }
    marked.push(
      ...message.content.filter((block) => 'cache_control' in block && block.cache_control),
    );
  }
  expect(marked.length).toBeLessThanOrEqual(1);
  return marked[0];
}

const TOOL = {
  name: 'lookup',
  description: 'Look something up.',
  inputSchema: { type: 'object', properties: {} },
};

describe('AnthropicProvider', () => {
  it('sends no cache breakpoint when the request declares no prefix', async () => {
    const params = await send({
      task: 'reasoning',
      system: 'Be brief.',
      messages: [userMessage('Oi')],
    });

    expect(markedBlock(params)).toBeUndefined();
    // A plain string system prompt is left as-is; nothing to mark.
    expect(params.system).toBe('Be brief.');
  });

  it('marks the last block of the last stable message', async () => {
    const params = await send({
      task: 'reasoning',
      system: 'Be brief.',
      messages: [userMessage('Handbook'), userMessage('Volatile question')],
      cachePrefix: { stableMessages: 1 },
    });

    // Everything before the marker is cached: tools, system and that message.
    expect(markedBlock(params)).toMatchObject({ type: 'text', text: 'Handbook' });
    const tail = params.messages[1]!.content;
    expect(tail).toEqual([{ type: 'text', text: 'Volatile question' }]);
  });

  it('marks the system prompt when no message is stable yet', async () => {
    const params = await send({
      task: 'reasoning',
      system: 'Be brief.',
      messages: [userMessage('First question')],
      cachePrefix: { stableMessages: 0 },
    });

    expect(params.system).toEqual([
      { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('falls back to the last tool when there is no system prompt', async () => {
    const params = await send({
      task: 'reasoning',
      messages: [userMessage('First question')],
      tools: [TOOL],
      cachePrefix: { stableMessages: 0 },
    });

    expect(markedBlock(params)).toMatchObject({ name: 'lookup' });
  });

  it('sends no breakpoint when the declared prefix is empty', async () => {
    const params = await send({
      task: 'reasoning',
      messages: [userMessage('First question')],
      cachePrefix: { stableMessages: 0 },
    });

    expect(markedBlock(params)).toBeUndefined();
  });

  it('clamps a prefix longer than the history to the last message', async () => {
    const params = await send({
      task: 'reasoning',
      messages: [userMessage('Only turn')],
      cachePrefix: { stableMessages: 99 },
    });

    expect(markedBlock(params)).toMatchObject({ type: 'text', text: 'Only turn' });
  });

  it('reports the provider’s cached-token count back through the port', async () => {
    const { client } = stubClient();

    const response = await new AnthropicProvider({ client }).invoke({
      model: 'claude-haiku-4-5',
      request: { task: 'reasoning', messages: [userMessage('Oi')] },
    });

    expect(response.usage.cachedInputTokens).toBe(60);
  });
});
