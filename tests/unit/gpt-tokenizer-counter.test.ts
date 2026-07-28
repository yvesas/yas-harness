// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The default token counter. Proves it counts zero for empty text, a positive
 * count for real text that grows with length, and that it is genuine BPE
 * tokenization — a single long word is several tokens, not one — so the numbers
 * the compression report carries are measured, not a word count.
 */

import { describe, expect, it } from 'vitest';

import { GptTokenizerCounter } from '../../src/models/gpt-tokenizer-counter.js';

describe('GptTokenizerCounter', () => {
  const counter = new GptTokenizerCounter();

  it('counts zero tokens for empty text', () => {
    expect(counter.count('')).toBe(0);
  });

  it('counts a positive number of tokens for real text', () => {
    expect(counter.count('Hello, world!')).toBeGreaterThan(0);
  });

  it('counts more tokens as the text grows', () => {
    expect(counter.count('one two three four five')).toBeGreaterThan(counter.count('one'));
  });

  it('is real BPE, not one token per word', () => {
    // A word-splitter would call this one token; BPE breaks it into several.
    expect(counter.count('unbelievable')).toBeGreaterThan(1);
  });
});
