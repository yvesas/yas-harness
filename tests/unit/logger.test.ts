// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The default logger.
 *
 * Two things matter about it: the line is JSON, so a deployment reads it with
 * the tooling it already has; and it cannot throw, because every caller is
 * inside a catch that already decided not to fail the turn.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleLogger } from '../../src/telemetry/logger.js';

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  warn.mockClear();
});

describe('consoleLogger', () => {
  it('writes one JSON object per line, with the fields alongside the message', () => {
    consoleLogger.warn('failed to record model usage', { model: 'groq/fast', attempts: 2 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      level: 'warn',
      message: 'failed to record model usage',
      model: 'groq/fast',
      attempts: 2,
    });
  });

  it('works with no fields at all', () => {
    consoleLogger.warn('something gave way');

    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      level: 'warn',
      message: 'something gave way',
    });
  });

  it('keeps the message when a field cannot be serialised', () => {
    // A circular field must cost the fields, not the turn the caller salvaged.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => {
      consoleLogger.warn('failed to record a trace step', circular);
    }).not.toThrow();
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      level: 'warn',
      message: 'failed to record a trace step',
    });
  });
});
