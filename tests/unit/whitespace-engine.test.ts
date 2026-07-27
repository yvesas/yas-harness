// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The whitespace engine. Proves it trims trailing whitespace and collapses runs
 * of blank lines, but never touches whitespace inside a line (indentation is
 * significant) nor structured tool-call inputs — and that a bad config is
 * rejected at construction.
 */

import { describe, expect, it } from 'vitest';

import { WhitespaceEngine } from '../../src/compression/engines/whitespace-engine.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';

function textRequest(text: string): ModelRequest {
  return { task: 'reasoning', messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}

function firstText(request: ModelRequest): string {
  const part = request.messages[0]!.content[0]!;
  return part.type === 'text' ? part.text : '';
}

describe('WhitespaceEngine', () => {
  it('trims trailing spaces and tabs from each line', () => {
    const out = new WhitespaceEngine().compress(textRequest('alpha   \nbeta\t\t\ngamma'));
    expect(firstText(out)).toBe('alpha\nbeta\ngamma');
  });

  it('collapses runs of blank lines to the configured maximum', () => {
    const out = new WhitespaceEngine({ maxBlankLines: 1 }).compress(textRequest('a\n\n\n\nb'));
    expect(firstText(out)).toBe('a\n\nb');
  });

  it('keeps whitespace inside a line (indentation is significant)', () => {
    const code = '    if (x) {\n        return 1;\n    }';
    const out = new WhitespaceEngine().compress(textRequest(code));
    expect(firstText(out)).toBe(code);
  });

  it('preserves an exact value while trimming around it', () => {
    const out = new WhitespaceEngine().compress(textRequest('price $1,234.56   \n'));
    expect(firstText(out)).toContain('$1,234.56');
  });

  it('trims tool-result content but leaves tool-call inputs alone', () => {
    const request: ModelRequest = {
      task: 'reasoning',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 't1', name: 'run', input: { cmd: 'ls   ' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 't1',
              content: 'line   \n\n\n\nend',
              isError: false,
            },
          ],
        },
      ],
    };

    const out = new WhitespaceEngine().compress(request);

    const call = out.messages[0]!.content[0]!;
    expect(call.type === 'tool_call' && call.input).toEqual({ cmd: 'ls   ' }); // untouched
    const result = out.messages[1]!.content[0]!;
    expect(result.type === 'tool_result' && result.content).toBe('line\n\nend');
  });

  it('rejects an invalid config at construction', () => {
    expect(() => new WhitespaceEngine({ maxBlankLines: -1 })).toThrow();
  });
});
