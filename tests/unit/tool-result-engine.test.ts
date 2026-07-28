// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-result engine. Proves it strips ANSI, collapses repeated consecutive
 * lines, truncates a long result to head+tail while keeping error lines, never
 * truncates an error result, and leaves text and tool-call parts alone.
 */

import { describe, expect, it } from 'vitest';

import { ToolResultEngine } from '../../src/compression/engines/tool-result-engine.js';
import type { ContentPart, ModelRequest } from '../../src/models/model-gateway.js';

function toolResult(content: string, isError = false): ModelRequest {
  return {
    task: 'reasoning',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content, isError }] },
    ],
  };
}

function firstPart(request: ModelRequest): ContentPart {
  return request.messages[0]!.content[0]!;
}

function resultContent(request: ModelRequest): string {
  const part = firstPart(request);
  return part.type === 'tool_result' ? part.content : '';
}

describe('ToolResultEngine', () => {
  it('is declared lossy', () => {
    expect(new ToolResultEngine().lossy).toBe(true);
  });

  it('strips ANSI colour codes', () => {
    const request = toolResult('\x1b[31mred\x1b[0m and \x1b[1;32mgreen\x1b[0m');
    expect(resultContent(new ToolResultEngine().compress(request))).toBe('red and green');
  });

  it('collapses runs of identical consecutive lines', () => {
    const request = toolResult('retrying\nretrying\nretrying\ndone');
    expect(resultContent(new ToolResultEngine().compress(request))).toBe('retrying\ndone');
  });

  it('truncates a long result to head and tail with an elision marker', () => {
    const engine = new ToolResultEngine({ headLines: 1, tailLines: 1 });
    const request = toolResult('l0\nl1\nl2\nl3\nl4');
    expect(resultContent(engine.compress(request))).toBe('l0\n[… elided …]\nl4');
  });

  it('keeps error-looking lines through truncation', () => {
    const engine = new ToolResultEngine({ headLines: 1, tailLines: 1 });
    const request = toolResult('start\nok\nERROR boom\nok\nend');
    expect(resultContent(engine.compress(request))).toBe(
      'start\n[… elided …]\nERROR boom\n[… elided …]\nend',
    );
  });

  it('never truncates a result flagged as an error', () => {
    const engine = new ToolResultEngine({ headLines: 1, tailLines: 1 });
    const request = toolResult('l0\nl1\nl2\nl3\nl4', true);
    expect(resultContent(engine.compress(request))).toBe('l0\nl1\nl2\nl3\nl4');
  });

  it('leaves a short result unchanged', () => {
    const engine = new ToolResultEngine({ headLines: 20, tailLines: 20 });
    const request = toolResult('one\ntwo\nthree');
    expect(resultContent(engine.compress(request))).toBe('one\ntwo\nthree');
  });

  it('leaves text and tool-call parts untouched', () => {
    const request: ModelRequest = {
      task: 'reasoning',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '\x1b[31mkeep me\x1b[0m' },
            { type: 'tool_call', id: 'c', name: 'run', input: { a: 1, a2: 1, a3: 1 } },
          ],
        },
      ],
    };

    const out = new ToolResultEngine().compress(request);
    const parts = out.messages[0]!.content;
    expect(parts[0]).toEqual({ type: 'text', text: '\x1b[31mkeep me\x1b[0m' });
    expect(parts[1]).toEqual({
      type: 'tool_call',
      id: 'c',
      name: 'run',
      input: { a: 1, a2: 1, a3: 1 },
    });
  });
});
