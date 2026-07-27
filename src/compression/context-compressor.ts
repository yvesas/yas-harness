// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: compress a request's context before it reaches a model.
 *
 * Sending fewer tokens is direct margin — a subscription product pays for every
 * one. But context is not free to squeeze: an exact value that gets mangled
 * (a price, a date, an id) turns a cheaper call into a wrong answer. So the
 * shape here is a *pipeline of composable engines* guarded by a sensitivity
 * gate: each engine makes the request smaller, and the pipeline verifies it did
 * not change any protected value — an engine that would has its output
 * discarded, so compression can never be destructive by accident.
 *
 * The vocabulary is provider-neutral (it works on a `ModelRequest`, ADR-002's
 * shape), and nothing here is product domain. Measuring the real token saving
 * and wiring this into the gateway's data path are later steps — this port is
 * the mechanism, off the hot path until it is measured and eval-gated.
 */

import type { z } from 'zod';

import type { ModelRequest } from '../models/model-gateway.js';

/** What one engine did, in characters (a token proxy until E5.4 measures tokens). */
export interface EngineReport {
  readonly engine: string;
  /** False when the engine was a no-op or its output was rejected by the gate. */
  readonly applied: boolean;
  /** Why it did not apply, when it did not. */
  readonly reason?: string;
  readonly before: number;
  readonly after: number;
}

/** The record of a whole compression pass, for logging and (later) `model_usage`. */
export interface CompressionReport {
  readonly engines: readonly EngineReport[];
  readonly before: number;
  readonly after: number;
}

export interface CompressionResult {
  readonly request: ModelRequest;
  readonly report: CompressionReport;
}

/** The port the caller sees: a request in, a smaller request plus a report out. */
export interface ContextCompressor {
  compress(request: ModelRequest): CompressionResult;
}

/**
 * One composable, meaning-preserving transform.
 *
 * An engine is a configured instance — its config is validated by
 * `configSchema()` at construction, so a malformed profile fails at startup,
 * not mid-conversation. `compress` returns a new request; it never mutates the
 * one it is given. The pipeline runs engines in ascending `priority` and checks
 * every result against the sensitivity gate, so an engine cannot corrupt a
 * protected value even if it is buggy — the worst it can do is be skipped.
 */
export interface CompressionEngine {
  readonly name: string;
  /** Lower runs first. */
  readonly priority: number;
  /** The Zod schema for this engine's configuration, for validation and docs. */
  configSchema(): z.ZodType;
  compress(request: ModelRequest): ModelRequest;
}

export class CompressionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompressionError';
  }
}
