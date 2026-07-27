// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A lossless engine that strips trailing whitespace and collapses runs of blank
 * lines. It is deliberately conservative: it never touches whitespace *inside*
 * a line (indentation and alignment can be significant, e.g. in code or logs),
 * only the trailing whitespace no reader sees and the blank lines that pile up
 * in tool results and pasted output. That makes it safe and still worthwhile on
 * the verbose text that dominates a context — the low-risk 15–30% the plan aims
 * for before anything lossy.
 *
 * It transforms text and tool-result content; it leaves structured tool-call
 * inputs alone.
 */

import { z } from 'zod';

import type { ContentPart, ModelMessage, ModelRequest } from '../../models/model-gateway.js';
import type { CompressionEngine } from '../context-compressor.js';

const configSchema = z.object({
  /** How many consecutive blank lines to keep (a run longer than this collapses). */
  maxBlankLines: z.number().int().min(0).default(1),
});

type WhitespaceConfig = z.infer<typeof configSchema>;

export class WhitespaceEngine implements CompressionEngine {
  readonly name = 'whitespace';
  readonly priority = 10;

  readonly #config: WhitespaceConfig;

  constructor(config: unknown = {}) {
    this.#config = configSchema.parse(config);
  }

  configSchema(): z.ZodType {
    return configSchema;
  }

  compress(request: ModelRequest): ModelRequest {
    const messages = request.messages.map((message) => this.#compressMessage(message));
    return {
      ...request,
      ...(request.system !== undefined ? { system: this.#collapse(request.system) } : {}),
      messages,
    };
  }

  #compressMessage(message: ModelMessage): ModelMessage {
    const content = message.content.map((part) => this.#compressPart(part));
    return { ...message, content };
  }

  #compressPart(part: ContentPart): ContentPart {
    if (part.type === 'text') {
      return { ...part, text: this.#collapse(part.text) };
    }
    if (part.type === 'tool_result') {
      return { ...part, content: this.#collapse(part.content) };
    }
    // A tool_call's input is structured data; leave it untouched.
    return part;
  }

  /** Trim trailing whitespace per line (linearly, no regex) and cap blank runs. */
  #collapse(text: string): string {
    const kept: string[] = [];
    let blankRun = 0;
    for (const line of text.split('\n')) {
      const trimmed = trimTrailing(line);
      if (trimmed === '') {
        blankRun += 1;
        if (blankRun <= this.#config.maxBlankLines) {
          kept.push(trimmed);
        }
      } else {
        blankRun = 0;
        kept.push(trimmed);
      }
    }
    return kept.join('\n');
  }
}

/** Remove trailing whitespace without a backtracking regex. */
function trimTrailing(line: string): string {
  let end = line.length;
  while (end > 0 && isWhitespace(line.charCodeAt(end - 1))) {
    end -= 1;
  }
  return line.slice(0, end);
}

function isWhitespace(code: number): boolean {
  // space, tab, carriage return, vertical tab, form feed.
  return code === 32 || code === 9 || code === 13 || code === 11 || code === 12;
}
