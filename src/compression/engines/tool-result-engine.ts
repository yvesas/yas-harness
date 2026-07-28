// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A lossy engine for tool-result content — where the real bulk lives: command
 * output, logs, dumps, retries. Three conservative transforms, in order:
 *
 *  1. strip ANSI escape sequences (colour codes a model reads as noise);
 *  2. collapse runs of identical consecutive lines to one (a retry loop or a
 *     progress bar prints the same line hundreds of times);
 *  3. truncate a long result to its head and tail, keeping every line that
 *     looks like an error or failure — the part you actually needed.
 *
 * It is *lossy*: it drops content. So it runs under the pipeline's lossy gate,
 * which lets it drop a value but never invent or mangle one — a price or id it
 * keeps stays byte-perfect, and a corrupted value is caught and the whole result
 * discarded. A result flagged `isError` is never truncated: an error is exactly
 * what you want in full. It touches only tool-result parts; text and structured
 * tool-call inputs are left alone.
 */

import { z } from 'zod';

import type { ContentPart, ModelMessage, ModelRequest } from '../../models/model-gateway.js';
import type { CompressionEngine } from '../context-compressor.js';

const configSchema = z.object({
  /** Lines kept from the top of a truncated result. */
  headLines: z.number().int().min(0).default(20),
  /** Lines kept from the bottom of a truncated result. */
  tailLines: z.number().int().min(0).default(20),
});

type ToolResultConfig = z.infer<typeof configSchema>;

/** Stands in for a dropped run of lines. Carries no digits, so it can never look
 * like a protected value to the sensitivity gate. */
const ELIDED = '[… elided …]';

// A line worth keeping through truncation. A flat list of literal words, so the
// match is linear — no nested quantifiers, no ReDoS.
const ERROR_LINE =
  /\b(?:error|errors|fail|failed|failure|fatal|panic|exception|traceback|stderr)\b/i;

export class ToolResultEngine implements CompressionEngine {
  readonly name = 'tool-result';
  readonly priority = 30;
  readonly lossy = true;

  readonly #config: ToolResultConfig;

  constructor(config: unknown = {}) {
    this.#config = configSchema.parse(config);
  }

  configSchema(): z.ZodType {
    return configSchema;
  }

  compress(request: ModelRequest): ModelRequest {
    const messages = request.messages.map((message) => this.#compressMessage(message));
    return { ...request, messages };
  }

  #compressMessage(message: ModelMessage): ModelMessage {
    return { ...message, content: message.content.map((part) => this.#compressPart(part)) };
  }

  #compressPart(part: ContentPart): ContentPart {
    if (part.type !== 'tool_result') {
      // Text and tool-call inputs are out of scope for this engine.
      return part;
    }
    return { ...part, content: this.#compressContent(part.content, part.isError) };
  }

  #compressContent(content: string, isError: boolean): string {
    const deduped = dedupeConsecutive(stripAnsi(content));
    // An error result stays whole — never trade away the thing that failed.
    return isError ? deduped : this.#truncate(deduped);
  }

  /** Keep the head, the tail, and every error-looking line; elide the rest. */
  #truncate(text: string): string {
    const lines = text.split('\n');
    const { headLines, tailLines } = this.#config;
    if (lines.length <= headLines + tailLines) {
      return text;
    }

    const keep = new Array<boolean>(lines.length).fill(false);
    for (let i = 0; i < headLines; i += 1) {
      keep[i] = true;
    }
    for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i += 1) {
      keep[i] = true;
    }
    for (let i = 0; i < lines.length; i += 1) {
      if (ERROR_LINE.test(lines[i]!)) {
        keep[i] = true;
      }
    }

    const out: string[] = [];
    let eliding = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (keep[i]) {
        out.push(lines[i]!);
        eliding = false;
      } else if (!eliding) {
        out.push(ELIDED); // one marker stands in for a whole dropped run
        eliding = true;
      }
    }
    return out.join('\n');
  }
}

/** Remove ANSI CSI escape sequences (`ESC [ … final`) with a linear scan. */
function stripAnsi(text: string): string {
  let result = '';
  let segmentStart = 0;
  let i = 0;
  while (i < text.length) {
    // ESC (0x1b) followed by '[' (0x5b) opens a Control Sequence Introducer.
    if (text.charCodeAt(i) === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      result += text.slice(segmentStart, i);
      let j = i + 2;
      // The sequence ends at its first final byte, in the range '@'–'~'.
      while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) {
        j += 1;
      }
      i = j < text.length ? j + 1 : j;
      segmentStart = i;
    } else {
      i += 1;
    }
  }
  return result + text.slice(segmentStart);
}

/** Collapse a run of identical consecutive lines to a single line. */
function dedupeConsecutive(text: string): string {
  const kept: string[] = [];
  let previous: string | undefined;
  for (const line of text.split('\n')) {
    if (line !== previous) {
      kept.push(line);
    }
    previous = line;
  }
  return kept.join('\n');
}
