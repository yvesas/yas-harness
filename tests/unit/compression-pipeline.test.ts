// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline enforces the sensitivity gate around every engine. Proves a
 * lossless engine applies and reports its saving, a no-op engine is recorded as
 * such, and — the point of the gate — a buggy engine that would corrupt a
 * protected value has its output discarded and the request left unchanged.
 * Also checks that profiles select engines.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CompressionPipeline } from '../../src/compression/compression-pipeline.js';
import type { CompressionEngine } from '../../src/compression/context-compressor.js';
import { WhitespaceEngine } from '../../src/compression/engines/whitespace-engine.js';
import { compressorFor } from '../../src/compression/profiles.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';

function textRequest(text: string): ModelRequest {
  return { task: 'reasoning', messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}

function firstText(request: ModelRequest): string {
  const part = request.messages[0]!.content[0]!;
  return part.type === 'text' ? part.text : '';
}

/** A deliberately broken engine: it shrinks the text by mangling a money value. */
class CorruptingEngine implements CompressionEngine {
  readonly name = 'corrupt';
  readonly priority = 5;
  configSchema(): z.ZodType {
    return z.object({});
  }
  compress(request: ModelRequest): ModelRequest {
    return {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: message.content.map((part) =>
          part.type === 'text' ? { ...part, text: part.text.replace('$1,234.56', '$1') } : part,
        ),
      })),
    };
  }
}

describe('CompressionPipeline', () => {
  it('applies a lossless engine and reports the saving', () => {
    const pipeline = new CompressionPipeline([new WhitespaceEngine()]);

    const { request, report } = pipeline.compress(textRequest('a   \n\n\n\nb'));

    expect(firstText(request)).toBe('a\n\nb');
    expect(report.after).toBeLessThan(report.before);
    expect(report.engines[0]).toMatchObject({ engine: 'whitespace', applied: true });
  });

  it('discards a corrupting engine and keeps the request unchanged', () => {
    const original = 'the total is $1,234.56 exactly';
    const pipeline = new CompressionPipeline([new CorruptingEngine()]);

    const { request, report } = pipeline.compress(textRequest(original));

    expect(firstText(request)).toBe(original); // untouched — the gate refused it
    expect(report.engines[0]).toMatchObject({ engine: 'corrupt', applied: false });
    expect(report.engines[0]?.reason).toMatch(/sensitivity gate/);
  });

  it('records a no-op engine rather than applying it', () => {
    // Text with no trailing whitespace and no blank runs: nothing to trim.
    const pipeline = new CompressionPipeline([new WhitespaceEngine()]);

    const { report } = pipeline.compress(textRequest('a\nb\nc'));

    expect(report.engines[0]).toMatchObject({ applied: false, reason: 'no reduction' });
  });

  it('runs engines in priority order', () => {
    const seen: string[] = [];
    const make = (name: string, priority: number): CompressionEngine => ({
      name,
      priority,
      configSchema: () => z.object({}),
      compress: (r) => {
        seen.push(name);
        return r;
      },
    });
    const pipeline = new CompressionPipeline([make('second', 20), make('first', 10)]);

    pipeline.compress(textRequest('x'));

    expect(seen).toEqual(['first', 'second']);
  });
});

describe('compressorFor (profiles)', () => {
  it('the none profile changes nothing', () => {
    const { request, report } = compressorFor('none').compress(textRequest('a   \n\n\n\nb'));
    expect(firstText(request)).toBe('a   \n\n\n\nb');
    expect(report.engines).toHaveLength(0);
  });

  it('the light profile applies whitespace compression', () => {
    const { request } = compressorFor('light').compress(textRequest('a   \n\n\n\nb'));
    expect(firstText(request)).toBe('a\n\nb');
  });
});
