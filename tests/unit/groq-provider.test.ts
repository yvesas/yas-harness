// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Groq adapter, driven by a stub fetch.
 *
 * What matters here is the translation: the port's shape is not Groq's, and
 * every difference this file gets wrong would surface as a broken tool loop.
 */

import { describe, expect, it, vi } from 'vitest';

import { GroqProvider } from '../../src/models/groq-provider.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';

interface ChatBody {
  model: string;
  messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools?: { function: { name: string } }[];
}

function stubFetch(payload: unknown, init: { status?: number } = {}) {
  const calls: { url: string; body: ChatBody }[] = [];
  const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      body: JSON.parse(options?.body as string) as ChatBody,
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    model: 'llama-3.3-70b-versatile',
    choices: [{ finish_reason: 'stop', message: { content: 'Olá!' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    ...overrides,
  };
}

function provider(fetch: typeof globalThis.fetch) {
  return new GroqProvider({ apiKey: 'test-key', fetch });
}

const request: ModelRequest = { task: 'simple', messages: [userMessage('oi')] };

describe('GroqProvider', () => {
  it('returns the answer and the token usage', async () => {
    const { fetch } = stubFetch(completion());

    const response = await provider(fetch).invoke({ model: 'llama-3.3-70b-versatile', request });

    expect(response.content).toEqual([{ type: 'text', text: 'Olá!' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 });
  });

  it('reports cached tokens apart from fresh input, so they can be priced apart', async () => {
    const { fetch } = stubFetch(
      completion({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      }),
    );

    const response = await provider(fetch).invoke({ model: 'llama', request });

    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 60 });
  });

  it('sends the system prompt as the first message', async () => {
    const { fetch, calls } = stubFetch(completion());

    await provider(fetch).invoke({
      model: 'llama',
      request: { ...request, system: 'You are terse.' },
    });

    expect(calls[0]?.body.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
  });

  it('translates a tool call, whose arguments arrive as a JSON string', async () => {
    const { fetch } = stubFetch(
      completion({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                { id: 'call-1', function: { name: 'get_weather', arguments: '{"city":"Recife"}' } },
              ],
            },
          },
        ],
      }),
    );

    const response = await provider(fetch).invoke({ model: 'llama', request });

    expect(response.stopReason).toBe('tool_call');
    expect(response.content).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'get_weather', input: { city: 'Recife' } },
    ]);
  });

  it('survives malformed tool arguments instead of crashing the turn', async () => {
    const { fetch } = stubFetch(
      completion({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'call-1', function: { name: 'get_weather', arguments: '{oops' } }],
            },
          },
        ],
      }),
    );

    const response = await provider(fetch).invoke({ model: 'llama', request });

    // Reaches the tool as input its schema will reject, which the model can
    // then correct — better than an exception mid-conversation.
    expect(response.content[0]).toMatchObject({ type: 'tool_call', name: 'get_weather' });
  });

  it('splits tool results out of the user turn into their own messages', async () => {
    const { fetch, calls } = stubFetch(completion());

    await provider(fetch).invoke({
      model: 'llama',
      request: {
        task: 'simple',
        messages: [
          userMessage('weather?'),
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'call-1', name: 'get_weather', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolCallId: 'call-1', content: '22C', isError: false },
            ],
          },
        ],
      },
    });

    const messages = calls[0]!.body.messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1]?.tool_calls).toHaveLength(1);
    expect(messages[2]).toMatchObject({ tool_call_id: 'call-1', content: '22C' });
  });

  it('advertises tools in the function-calling shape', async () => {
    const { fetch, calls } = stubFetch(completion());

    await provider(fetch).invoke({
      model: 'llama',
      request: {
        ...request,
        tools: [
          {
            name: 'get_weather',
            description: 'Weather for a city.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });

    expect(calls[0]?.body.tools?.[0]?.function.name).toBe('get_weather');
  });

  it('marks a rate limit as retryable', async () => {
    const { fetch } = stubFetch({ error: 'slow down' }, { status: 429 });

    await expect(provider(fetch).invoke({ model: 'llama', request })).rejects.toMatchObject({
      detail: { retryable: true, provider: 'groq' },
    });
  });

  it('marks a rejected request as not retryable', async () => {
    const { fetch } = stubFetch({ error: 'bad model' }, { status: 400 });

    await expect(provider(fetch).invoke({ model: 'llama', request })).rejects.toMatchObject({
      detail: { retryable: false },
    });
  });

  it('marks a transport failure as retryable', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));

    await expect(
      provider(fetch as unknown as typeof globalThis.fetch).invoke({ model: 'llama', request }),
    ).rejects.toMatchObject({ detail: { retryable: true } });
  });

  it('refuses to start without an API key', () => {
    expect(() => new GroqProvider({ apiKey: '', fetch: globalThis.fetch })).toThrow(
      ModelGatewayError,
    );
  });
});
