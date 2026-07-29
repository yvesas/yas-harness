// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What the agent did, step by step.
 *
 * `model_usage` answers "what did this cost"; a trace answers "what happened".
 * They are different questions and are kept apart: usage is a billing record
 * that must outlive a deleted conversation, a trace is a diagnostic that
 * carries the user's own words and must not.
 *
 * A trace is a flat, ordered list of steps sharing a `traceId`, rather than a
 * tree. Flat is enough to reconstruct a turn, cheap to append to as it happens
 * (so a crash mid-turn leaves the steps that already ran), and maps directly
 * onto a span list if an OpenTelemetry exporter is added later — the shape here
 * is deliberately span-like: an id, an ordinal, a kind, a duration, an outcome.
 */

import { randomUUID } from 'node:crypto';

/**
 * The stages of a turn worth seeing. Provider- and product-neutral: a routing
 * decision and a tool call are the same events in a language tutor and a CRM.
 */
export type TraceStepKind =
  /** The user's message arrived and the turn began. */
  | 'input'
  /** The router picked a module. */
  | 'route'
  /** One call to a model through the gateway. */
  | 'model_call'
  /** One tool ran and returned. */
  | 'tool_call'
  /** One module asked another for context, and the owner answered. */
  | 'context_request'
  /** The turn stopped and is waiting for a human decision. */
  | 'approval'
  /** The turn ended, however it ended. */
  | 'reply';

/** One step of one turn, as recorded. */
export interface TraceStep {
  readonly tenantId: string;
  /** Null for work outside a conversation, such as a standalone routing call. */
  readonly sessionId: string | null;
  /** Groups every step of one turn. Callers may share it across components. */
  readonly traceId: string;
  /** Position within the turn, from 0. Wall-clock cannot order these: steps
   * appended in the same transaction share a timestamp. */
  readonly sequence: number;
  readonly kind: TraceStepKind;
  /** What the step was about: a module id, a tool name, a model. */
  readonly label?: string;
  readonly durationMs?: number;
  readonly succeeded: boolean;
  /**
   * Anything else worth seeing — the router's confidence and reason, a stop
   * reason, a tool's input. Free-form and therefore redacted before storage.
   */
  readonly detail?: Record<string, unknown>;
  readonly errorMessage?: string;
}

/**
 * Port: where trace steps go.
 *
 * Like usage recording, tracing must never break a conversation: an adapter
 * that cannot write should fail, and the caller above it should carry on.
 */
export interface TraceRecorder {
  record(step: TraceStep): Promise<void>;
}

/** For tests and for running without a database. */
export class InMemoryTraceRecorder implements TraceRecorder {
  readonly steps: TraceStep[] = [];

  record(step: TraceStep): Promise<void> {
    this.steps.push(step);
    return Promise.resolve();
  }

  /** One turn's steps, in order. */
  trace(traceId: string): TraceStep[] {
    return this.steps
      .filter((step) => step.traceId === traceId)
      .sort((a, b) => a.sequence - b.sequence);
  }
}

/** Everything a step carries that is not bookkeeping the trace does itself. */
export type TraceStepInput = Omit<TraceStep, 'tenantId' | 'sessionId' | 'traceId' | 'sequence'>;

export interface TurnTraceContext {
  readonly tenantId: string;
  readonly sessionId: string | null;
  /** Supply one to join steps a caller already started; omit to begin a trace. */
  readonly traceId?: string;
}

/**
 * One turn's trace: numbers the steps and keeps a tracing failure away from the
 * caller.
 *
 * Numbering lives here rather than in each caller because a gap or a repeat in
 * the sequence is what makes a trace unreadable, and the caller has a turn to
 * run. A missing recorder makes every step a no-op, so the callers need no
 * branch of their own — tracing is off until a product wires it.
 */
export class TurnTrace {
  readonly #recorder: TraceRecorder | undefined;
  readonly #context: TurnTraceContext;
  readonly #traceId: string;
  #sequence = 0;

  constructor(recorder: TraceRecorder | undefined, context: TurnTraceContext) {
    this.#recorder = recorder;
    this.#context = context;
    this.#traceId = context.traceId ?? randomUUID();
  }

  get traceId(): string {
    return this.#traceId;
  }

  async step(step: TraceStepInput): Promise<void> {
    if (!this.#recorder) {
      return;
    }

    const sequence = this.#sequence;
    this.#sequence += 1;

    try {
      await this.#recorder.record({
        tenantId: this.#context.tenantId,
        sessionId: this.#context.sessionId,
        traceId: this.#traceId,
        sequence,
        ...step,
      });
    } catch (error) {
      // Losing a step costs visibility; failing the user's turn over it would
      // cost the turn. The same trade the usage recorder makes.
      console.warn('failed to record a trace step', {
        traceId: this.#traceId,
        kind: step.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
