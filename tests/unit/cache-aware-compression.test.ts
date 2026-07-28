// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Compression leaves a declared cacheable prefix alone (E5.7).
 *
 * The guarantee being tested is not "the pipeline skipped some messages" but the
 * property a provider cache actually depends on: the prefix a caller declared
 * stable comes out byte-for-byte identical, and stays identical as the
 * conversation grows around it. Without that, compression would trade a small
 * saving on already-discounted tokens for a full-price miss on the whole prefix.
 */

import { describe, expect, it } from 'vitest';

import { CompressionPipeline } from '../../src/compression/compression-pipeline.js';
import { WhitespaceEngine } from '../../src/compression/engines/whitespace-engine.js';
import type { ModelMessage, ModelRequest } from '../../src/models/model-gateway.js';

/** Trailing whitespace and blank runs: exactly what the whitespace engine rewrites. */
function turn(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

const STABLE_SYSTEM = 'You are a careful assistant.   \n\n\n\nAnswer briefly.';
const STABLE_TURN = turn('user', 'Here is the handbook.   \n\n\n\nUse it.');

function conversation(extra: readonly ModelMessage[] = []): ModelRequest {
  return {
    task: 'reasoning',
    system: STABLE_SYSTEM,
    messages: [STABLE_TURN, ...extra],
    cachePrefix: { stableMessages: 1 },
  };
}

function textOf(message: ModelMessage): string {
  const part = message.content[0];
  return part?.type === 'text' ? part.text : '';
}

describe('cache-aware compression', () => {
  const pipeline = new CompressionPipeline([new WhitespaceEngine()]);

  it('leaves the declared prefix byte-identical while compressing the rest', () => {
    const request = conversation([turn('user', 'And now?   \n\n\n\nSummarise.')]);

    const { request: compressed } = pipeline.compress(request);

    expect(compressed.system).toBe(STABLE_SYSTEM);
    expect(textOf(compressed.messages[0]!)).toBe(textOf(STABLE_TURN));
    expect(textOf(compressed.messages[1]!)).toBe('And now?\n\nSummarise.');
  });

  it('keeps the prefix stable as the conversation grows — the cache-hit property', () => {
    const firstTurn = pipeline.compress(conversation([turn('user', 'One.  \n\n\n\n')]));
    const laterTurn = pipeline.compress(
      conversation([turn('user', 'One.  \n\n\n\n'), turn('assistant', 'Two.  \n\n\n\n')]),
    );

    expect(laterTurn.request.system).toBe(firstTurn.request.system);
    expect(laterTurn.request.messages[0]).toEqual(firstTurn.request.messages[0]);
  });

  it('would have rewritten that same prefix without the declaration', () => {
    const { cachePrefix: _dropped, ...undeclared } = conversation();

    const { request: compressed } = pipeline.compress(undeclared);

    // Proof the previous tests are not vacuous: the engine does reach this text.
    expect(compressed.system).not.toBe(STABLE_SYSTEM);
    expect(textOf(compressed.messages[0]!)).not.toBe(textOf(STABLE_TURN));
  });

  it('protects system and tools when no message is stable yet', () => {
    const request: ModelRequest = {
      task: 'reasoning',
      system: STABLE_SYSTEM,
      messages: [turn('user', 'First question.   \n\n\n\nGo.')],
      cachePrefix: { stableMessages: 0 },
    };

    const { request: compressed } = pipeline.compress(request);

    expect(compressed.system).toBe(STABLE_SYSTEM);
    expect(textOf(compressed.messages[0]!)).toBe('First question.\n\nGo.');
  });

  it('reports the untouched prefix apart from the region it compressed', () => {
    const { report } = pipeline.compress(conversation([turn('user', 'Tail.   \n\n\n\nEnd.')]));

    expect(report.cachePrefix?.chars).toBe((STABLE_SYSTEM + '\n' + textOf(STABLE_TURN)).length);
    expect(report.cachePrefix?.tokens).toBeGreaterThan(0);
    // The saving describes the compressible region only, never the prefix.
    expect(report.before).toBe('Tail.   \n\n\n\nEnd.'.length);
    expect(report.after).toBeLessThan(report.before);
  });

  it('omits the prefix report when the request declares none', () => {
    const { cachePrefix: _dropped, ...undeclared } = conversation();

    expect(pipeline.compress(undeclared).report.cachePrefix).toBeUndefined();
  });

  it('clamps a prefix longer than the history instead of failing', () => {
    const request: ModelRequest = {
      ...conversation(),
      cachePrefix: { stableMessages: 99 },
    };

    const { request: compressed, report } = pipeline.compress(request);

    // Everything is prefix, so nothing is left to compress.
    expect(textOf(compressed.messages[0]!)).toBe(textOf(STABLE_TURN));
    expect(report.before).toBe(0);
    expect(report.cachePrefix?.chars).toBeGreaterThan(0);
  });
});
