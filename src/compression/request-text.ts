// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Render a request's text content — what compression measures and what the
 * sensitivity gate inspects. Structured tool-call inputs are stringified so
 * their exact values are counted and protected too.
 */

import type { ModelRequest } from '../models/model-gateway.js';

export function renderRequestText(request: ModelRequest): string {
  const parts: string[] = [];
  if (request.system) {
    parts.push(request.system);
  }
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_result') {
        parts.push(part.content);
      } else {
        parts.push(JSON.stringify(part.input));
      }
    }
  }
  return parts.join('\n');
}

/**
 * A request's size in characters — the cheap, exact signal the pipeline uses to
 * decide whether an engine shrank the request. The billed cost is tokens, which
 * the pipeline measures separately through a `TokenCounter`.
 */
export function requestSize(request: ModelRequest): number {
  return renderRequestText(request).length;
}
