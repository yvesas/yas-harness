// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-table engine. Proves it compacts a homogeneous JSON array into a
 * columns/rows table (keeping every value), leaves anything that is not such an
 * array alone, and — via the pipeline — that when re-serialising would reformat
 * a number the sensitivity gate discards its output.
 */

import { describe, expect, it } from 'vitest';

import { CompressionPipeline } from '../../src/compression/compression-pipeline.js';
import { JsonTableEngine } from '../../src/compression/engines/json-table-engine.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';

function toolResult(content: string): ModelRequest {
  return {
    task: 'reasoning',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 't', content, isError: false }],
      },
    ],
  };
}

function firstResultContent(request: ModelRequest): string {
  const part = request.messages[0]!.content[0]!;
  return part.type === 'tool_result' ? part.content : '';
}

describe('JsonTableEngine', () => {
  it('compacts a homogeneous array of objects into columns and rows', () => {
    const request = toolResult('[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":3,"name":"c"}]');

    const out = new JsonTableEngine().compress(request);

    expect(JSON.parse(firstResultContent(out))).toEqual({
      columns: ['id', 'name'],
      rows: [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ],
    });
  });

  it('keeps every value, so the compacted form is smaller than the original', () => {
    const original = '[{"id":1,"status":"open"},{"id":2,"status":"open"},{"id":3,"status":"shut"}]';
    const out = new JsonTableEngine().compress(toolResult(original));
    expect(firstResultContent(out).length).toBeLessThan(original.length);
  });

  it('leaves a non-array body unchanged', () => {
    const request = toolResult('{"id":1}');
    expect(firstResultContent(new JsonTableEngine().compress(request))).toBe('{"id":1}');
  });

  it('leaves a heterogeneous array unchanged', () => {
    const body = '[{"id":1},{"name":"b"}]';
    expect(firstResultContent(new JsonTableEngine().compress(toolResult(body)))).toBe(body);
  });

  it('leaves JSON embedded in prose unchanged', () => {
    const body = 'here you go: [{"id":1},{"id":2}] done';
    expect(firstResultContent(new JsonTableEngine().compress(toolResult(body)))).toBe(body);
  });

  it('respects minRows (a single-element array is left alone)', () => {
    const body = '[{"id":1,"name":"only"}]';
    expect(firstResultContent(new JsonTableEngine().compress(toolResult(body)))).toBe(body);
  });

  it('the pipeline discards the rewrite when it would reformat a number', () => {
    // 1.10 parses to 1.1 and re-serialises without the trailing zero — a changed
    // value the gate must catch. Enough rows that the table is genuinely smaller,
    // so the reduction check passes and the gate is what rejects it.
    const original =
      '[{"amount":1.10,"code":"aaa"},{"amount":2.20,"code":"bbb"},' +
      '{"amount":3.30,"code":"ccc"},{"amount":4.40,"code":"ddd"},{"amount":5.50,"code":"eee"}]';
    const { request, report } = new CompressionPipeline([new JsonTableEngine()]).compress(
      toolResult(original),
    );

    expect(firstResultContent(request)).toBe(original); // untouched
    expect(report.engines[0]).toMatchObject({ engine: 'json-table', applied: false });
    expect(report.engines[0]?.reason).toMatch(/sensitivity gate/);
  });

  it('the pipeline applies the rewrite when values round-trip faithfully', () => {
    const original =
      '[{"identifier":1,"category":"x"},{"identifier":2,"category":"y"},' +
      '{"identifier":3,"category":"z"},{"identifier":4,"category":"w"},{"identifier":5,"category":"v"}]';
    const { request, report } = new CompressionPipeline([new JsonTableEngine()]).compress(
      toolResult(original),
    );

    expect(JSON.parse(firstResultContent(request))).toMatchObject({
      columns: ['identifier', 'category'],
    });
    expect(report.engines[0]).toMatchObject({ engine: 'json-table', applied: true });
  });
});
