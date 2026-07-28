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
import type { TokenCounter } from '../../src/models/token-counter.js';

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

/**
 * A stand-in counter with a distinctive scale (ten tokens per character), so a
 * test can tell the report's token numbers apart from its character counts and
 * prove they come from the injected counter.
 */
class TenXCounter implements TokenCounter {
  count(text: string): number {
    return text.length * 10;
  }
}

describe('CompressionPipeline token measurement (E5.4)', () => {
  it('reports token counts from the injected counter, per engine and overall', () => {
    // 'a   \n\n\n\nb' is 9 chars; whitespace trims it to 'a\n\nb', 4 chars.
    const pipeline = new CompressionPipeline(
      [new WhitespaceEngine()],
      undefined,
      new TenXCounter(),
    );

    const { report } = pipeline.compress(textRequest('a   \n\n\n\nb'));

    expect(report).toMatchObject({ before: 9, after: 4, beforeTokens: 90, afterTokens: 40 });
    expect(report.engines[0]).toMatchObject({
      engine: 'whitespace',
      applied: true,
      beforeTokens: 90,
      afterTokens: 40,
    });
  });

  it('carries the before token count over when an engine does not apply', () => {
    const pipeline = new CompressionPipeline(
      [new WhitespaceEngine()],
      undefined,
      new TenXCounter(),
    );

    const { report } = pipeline.compress(textRequest('a\nb\nc')); // nothing to trim

    expect(report.engines[0]).toMatchObject({
      applied: false,
      beforeTokens: 50,
      afterTokens: 50,
    });
  });

  it('measures real BPE tokens with the default counter', () => {
    const { report } = new CompressionPipeline([new WhitespaceEngine()]).compress(
      textRequest('a   \n\n\n\nb'),
    );

    expect(report.beforeTokens).toBeGreaterThan(0);
    expect(report.afterTokens).toBeLessThanOrEqual(report.beforeTokens);
  });
});

/** A lossy engine: it drops every line of the text after the first. */
class DroppingEngine implements CompressionEngine {
  readonly name = 'drop';
  readonly priority = 5;
  readonly lossy = true;
  configSchema(): z.ZodType {
    return z.object({});
  }
  compress(request: ModelRequest): ModelRequest {
    return {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: message.content.map((part) =>
          part.type === 'text' ? { ...part, text: part.text.split('\n')[0]! } : part,
        ),
      })),
    };
  }
}

/** A lossy engine that also mangles a money value while dropping — must be caught. */
class LossyCorruptingEngine implements CompressionEngine {
  readonly name = 'lossy-corrupt';
  readonly priority = 5;
  readonly lossy = true;
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

describe('CompressionPipeline lossy gate (E5.6)', () => {
  it('lets a lossy engine drop a protected value', () => {
    const pipeline = new CompressionPipeline([new DroppingEngine()]);

    const { request, report } = pipeline.compress(textRequest('keep $10.00\ndrop $20.00'));

    expect(firstText(request)).toBe('keep $10.00'); // the tail (and its $20.00) is gone
    expect(report.engines[0]).toMatchObject({ engine: 'drop', applied: true });
  });

  it('still discards a lossy engine that mangles a value', () => {
    const original = 'the total is $1,234.56 exactly, and more text to shrink';
    const pipeline = new CompressionPipeline([new LossyCorruptingEngine()]);

    const { request, report } = pipeline.compress(textRequest(original));

    expect(firstText(request)).toBe(original); // untouched — the lossy gate refused it
    expect(report.engines[0]).toMatchObject({ engine: 'lossy-corrupt', applied: false });
    expect(report.engines[0]?.reason).toMatch(/sensitivity gate/);
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

  it('only the aggressive profile truncates a long tool result', () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const request: ModelRequest = {
      task: 'reasoning',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 't', content: many, isError: false }],
        },
      ],
    };
    const resultText = (r: ModelRequest): string => {
      const part = r.messages[0]!.content[0]!;
      return part.type === 'tool_result' ? part.content : '';
    };

    expect(resultText(compressorFor('medium').compress(request).request)).toBe(many);

    const aggressive = resultText(compressorFor('aggressive').compress(request).request);
    expect(aggressive).not.toBe(many);
    expect(aggressive).toContain('[… elided …]');
    expect(aggressive.length).toBeLessThan(many.length);
  });
});
