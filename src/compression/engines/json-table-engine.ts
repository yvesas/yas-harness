// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A lossless engine that compacts a homogeneous JSON array of objects into a
 * columns/rows table.
 *
 * Tool results are often a JSON array of records — `[{"id":1,"name":"a"},…]` —
 * where every key is repeated on every row. Rewriting that as
 * `{"columns":["id","name"],"rows":[[1,"a"],…]}` keeps every value byte-for-byte
 * and drops the repeated keys, which is most of the tokens on a long table. It
 * is valid JSON a model reads without help.
 *
 * It only rewrites content whose *whole* trimmed body is such an array (no
 * guessing at JSON embedded in prose), and only when every element shares the
 * same key set. Values are re-serialised through `JSON.stringify`; if that
 * reformats a number (a trailing zero, an exponent), the pipeline's sensitivity
 * gate catches the changed value and discards this engine's output — so the
 * worst case is "not compressed", never "a changed value".
 */

import { z } from 'zod';

import type { ContentPart, ModelMessage, ModelRequest } from '../../models/model-gateway.js';
import type { CompressionEngine } from '../context-compressor.js';

const configSchema = z.object({
  /** Only tabulate arrays with at least this many rows (fewer saves nothing). */
  minRows: z.number().int().min(2).default(2),
});

type JsonTableConfig = z.infer<typeof configSchema>;

export class JsonTableEngine implements CompressionEngine {
  readonly name = 'json-table';
  // After whitespace: work on already-trimmed content.
  readonly priority = 20;

  readonly #config: JsonTableConfig;

  constructor(config: unknown = {}) {
    this.#config = configSchema.parse(config);
  }

  configSchema(): z.ZodType {
    return configSchema;
  }

  compress(request: ModelRequest): ModelRequest {
    return {
      ...request,
      messages: request.messages.map((message) => this.#compressMessage(message)),
    };
  }

  #compressMessage(message: ModelMessage): ModelMessage {
    return { ...message, content: message.content.map((part) => this.#compressPart(part)) };
  }

  #compressPart(part: ContentPart): ContentPart {
    if (part.type === 'text') {
      const table = this.#tabulate(part.text);
      return table === null ? part : { ...part, text: table };
    }
    if (part.type === 'tool_result') {
      const table = this.#tabulate(part.content);
      return table === null ? part : { ...part, content: table };
    }
    return part;
  }

  /** Turn a whole-body JSON array of homogeneous objects into a table, or null. */
  #tabulate(content: string): string | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('[')) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length < this.#config.minRows) {
      return null;
    }

    const columns = objectKeys(parsed[0]);
    if (columns === null) {
      return null;
    }
    const rows: unknown[][] = [];
    for (const element of parsed) {
      if (!sameKeys(element, columns)) {
        return null;
      }
      rows.push(columns.map((key) => (element as Record<string, unknown>)[key]));
    }
    return JSON.stringify({ columns, rows });
  }
}

/** The keys of a plain object (not null, not an array), or null. */
function objectKeys(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value);
}

/** True if `value` is a plain object whose key set is exactly `columns`. */
function sameKeys(value: unknown, columns: readonly string[]): boolean {
  const keys = objectKeys(value);
  if (keys === null || keys.length !== columns.length) {
    return false;
  }
  const want = new Set(columns);
  return keys.every((key) => want.has(key));
}
