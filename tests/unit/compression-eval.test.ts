// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The compression eval, driven by a scripted gateway so the gate's arithmetic
 * is checked without a model. Products run the same runner against a real
 * gateway to decide whether a profile may enter their data path.
 */

import { describe, expect, it } from 'vitest';

import {
  compressionCaseSchema,
  compressionCaseSetSchema,
  evaluateCompression,
  passesGate,
  regressions,
  toModelRequest,
  type CompressionCase,
} from '../../src/compression/eval.js';
import { compressorFor } from '../../src/compression/profiles.js';
import type { ModelRequest } from '../../src/models/model-gateway.js';
import { ScriptedGateway, says } from '../../src/models/scripted-gateway.js';

const NOISY_LOG = ['ERROR failed to sync   ', '', '', '', 'order 4471 total $1,234.56   '].join(
  '\n',
);

const cases: CompressionCase[] = [
  {
    input: 'what is the order total?',
    toolResults: [{ content: NOISY_LOG }],
    expect: ['$1,234.56'],
  },
];

/** Answers each case twice: baseline first, then the compressed run. */
function gatewayAnswering(...answers: string[]) {
  return new ScriptedGateway(answers.map((text) => says(text)));
}

describe('compression eval', () => {
  const compressor = compressorFor('medium');

  it('validates a case set and rejects an empty one', () => {
    expect(compressionCaseSetSchema.safeParse(cases).success).toBe(true);
    expect(compressionCaseSetSchema.safeParse([]).success).toBe(false);
    // A case with nothing to assert cannot fail, so it is not a case.
    expect(compressionCaseSchema.safeParse({ input: 'hi', expect: [] }).success).toBe(false);
  });

  it('builds a request that carries the context as a tool result', () => {
    const request: ModelRequest = toModelRequest(cases[0]!);

    expect(request.messages).toHaveLength(3);
    expect(request.messages[1]!.content[0]).toMatchObject({ type: 'tool_call', id: 'eval-0' });
    expect(request.messages[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'eval-0',
      content: NOISY_LOG,
    });
  });

  it('passes the gate when the compressed run keeps the answer', async () => {
    const gateway = gatewayAnswering('the total is $1,234.56', 'the total is $1,234.56');

    const report = await evaluateCompression(gateway, compressor, cases);

    expect(report).toMatchObject({ total: 1, regressions: 0, inconclusive: 0 });
    expect(passesGate(report)).toBe(true);
    // Compression ran and is measured, so the report is not vacuous.
    expect(report.afterTokens).toBeLessThan(report.beforeTokens);
    expect(report.savedRatio).toBeGreaterThan(0);
  });

  it('fails the gate when compression loses a value the baseline had', async () => {
    const gateway = gatewayAnswering('the total is $1,234.56', 'I could not find a total');

    const report = await evaluateCompression(gateway, compressor, cases);

    expect(passesGate(report)).toBe(false);
    expect(report.regressions).toBe(1);
    expect(regressions(report)[0]).toMatchObject({
      baselinePassed: true,
      compressedPassed: false,
      missing: ['$1,234.56'],
    });
  });

  it('counts a case both runs got wrong as inconclusive, not a regression', async () => {
    const gateway = gatewayAnswering('no idea', 'no idea');

    const report = await evaluateCompression(gateway, compressor, cases);

    // The engines did not break this — the case or the prompt did. Charging it
    // to compression would let a bad case set veto a good engine.
    expect(report).toMatchObject({ regressions: 0, inconclusive: 1 });
    expect(passesGate(report)).toBe(true);
  });

  it('treats a compressed call that throws as a regression, with its reason', async () => {
    // One turn only: the baseline consumes it, the compressed call runs dry.
    const gateway = gatewayAnswering('the total is $1,234.56');

    const report = await evaluateCompression(gateway, compressor, cases);

    expect(report.regressions).toBe(1);
    expect(report.outcomes[0]!.error).toContain('ran out of turns');
    expect(report.outcomes[0]!.missing).toEqual(['$1,234.56']);
  });

  it('reports no saving for a profile that compresses nothing', async () => {
    const gateway = gatewayAnswering('the total is $1,234.56', 'the total is $1,234.56');

    const report = await evaluateCompression(gateway, compressorFor('none'), cases);

    expect(report.savedRatio).toBe(0);
    expect(report.afterTokens).toBe(report.beforeTokens);
    expect(passesGate(report)).toBe(true);
  });
});
