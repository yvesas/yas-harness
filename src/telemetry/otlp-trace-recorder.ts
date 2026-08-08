// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `TraceRecorder` decorator that also ships each step to an OTLP collector.
 *
 * Spans are exported **as they are recorded**, not read back from the table
 * later. That is how OpenTelemetry works — a span is exported when it ends —
 * and it means the exporter needs no database, no schema change and no
 * timestamp the read model does not carry. The cost is stated plainly: wiring
 * this on Tuesday does not send Monday. What is already stored stays a
 * database question.
 *
 * Being a decorator rather than a replacement is deliberate. The two
 * destinations answer different questions: the table is what an operator opens
 * to read one turn end to end, the collector is where a turn joins the traces
 * of the service around it. Neither is a substitute for the other, and either
 * one may be absent — pass `undefined` as the inner recorder to export without
 * storing.
 *
 * **Wrap this inside the redactor, never outside it.** A trace carries the
 * user's own words and a tool's input; exporting before scrubbing would send
 * to a third party exactly what the redactor exists to withhold:
 *
 * ```ts
 * new RedactingTraceRecorder(new OtlpTraceRecorder(store, { endpoint }), redactor)
 * ```
 *
 * Failures here are swallowed on purpose. A collector being down is not a
 * reason for a conversation to fail, and unlike the stored trace there is no
 * durability claim to keep: the batch is dropped, the count is reported through
 * `onError`, and the turn carries on.
 */

import { trimTrailingSlashes } from '../http/base-url.js';

import { toOtlpPayload, toSpan, type OtlpSpan, type ResourceOptions } from './otlp.js';
import type { TraceRecorder, TraceStep } from './trace.js';

export interface OtlpExportOptions extends ResourceOptions {
  /**
   * The collector's base URL — `/v1/traces` is appended, as the OTLP/HTTP
   * specification defines it. A URL that already ends in `/v1/traces` is used
   * as it stands, since that is what most collector documentation prints.
   */
  readonly endpoint: string;
  /** Authorization and anything else the collector wants on every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Send once this many spans are waiting. Default 100. */
  readonly maxBatchSize?: number;
  /** Send a partial batch after this long. Default 2s. */
  readonly scheduleMs?: number;
  /** Give up on a request after this long. Default 5s. */
  readonly timeoutMs?: number;
  /**
   * How many spans may wait before the oldest are dropped. Default 2048.
   *
   * A collector that stops answering while the agent keeps working would
   * otherwise grow this buffer until the process dies — telemetry taking down
   * the thing it observes. Dropping is the lesser failure, and it is counted
   * rather than silent.
   */
  readonly maxQueueSize?: number;
  /** Told about export failures and drops. Defaults to doing nothing. */
  readonly onError?: (error: Error, droppedSpans: number) => void;
  /** Injectable for tests; defaults to global `fetch`. */
  readonly send?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
}

const DEFAULTS = {
  maxBatchSize: 100,
  scheduleMs: 2_000,
  timeoutMs: 5_000,
  maxQueueSize: 2_048,
} as const;

const TRACES_PATH = '/v1/traces';

function tracesUrl(endpoint: string): string {
  const trimmed = trimTrailingSlashes(endpoint);
  return trimmed.endsWith(TRACES_PATH) ? trimmed : `${trimmed}${TRACES_PATH}`;
}

export class OtlpTraceRecorder implements TraceRecorder {
  readonly #inner: TraceRecorder | undefined;
  readonly #options: OtlpExportOptions;
  readonly #url: string;
  #queue: OtlpSpan[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(inner: TraceRecorder | undefined, options: OtlpExportOptions) {
    this.#inner = inner;
    this.#options = options;
    this.#url = tracesUrl(options.endpoint);
  }

  async record(step: TraceStep): Promise<void> {
    // Queue before storing: a database that is refusing writes should not also
    // cost the export, and `inner` rejecting is still the caller's to see.
    this.#enqueue(toSpan(step));
    await this.#inner?.record(step);
  }

  /**
   * Send everything queued and wait for it.
   *
   * Worth calling on shutdown — the last spans of a turn are usually the ones
   * explaining why the process is going down.
   */
  async flush(): Promise<void> {
    this.#unschedule();
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#options.maxBatchSize ?? DEFAULTS.maxBatchSize);
      await this.#send(batch);
    }
  }

  /** Flush, then stop exporting. Later steps still reach the inner recorder. */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
  }

  #enqueue(span: OtlpSpan): void {
    if (this.#closed) {
      return;
    }

    this.#queue.push(span);

    const maxQueue = this.#options.maxQueueSize ?? DEFAULTS.maxQueueSize;
    if (this.#queue.length > maxQueue) {
      // Drop the oldest: the newest spans describe what is happening now, which
      // is what someone watching a struggling collector actually wants.
      const dropped = this.#queue.length - maxQueue;
      this.#queue = this.#queue.slice(dropped);
      this.#report(new Error('OTLP export queue is full'), dropped);
    }

    if (this.#queue.length >= (this.#options.maxBatchSize ?? DEFAULTS.maxBatchSize)) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch(() => undefined);
    }, this.#options.scheduleMs ?? DEFAULTS.scheduleMs);
    // A pending flush must not be what keeps a finished process alive.
    this.#timer.unref?.();
  }

  #unschedule(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #send(batch: OtlpSpan[]): Promise<void> {
    const send = this.#options.send ?? defaultSend;
    const timeoutMs = this.#options.timeoutMs ?? DEFAULTS.timeoutMs;
    try {
      const response = await send(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#options.headers },
        body: JSON.stringify(toOtlpPayload(batch, this.#options)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // No retry: the spans are already stale by the time a retry lands, and
        // holding them makes the queue the collector's outage rather than its
        // own. Dropping loudly beats queueing quietly.
        this.#report(new Error(`OTLP collector answered ${String(response.status)}`), batch.length);
      }
    } catch (error) {
      this.#report(error instanceof Error ? error : new Error(String(error)), batch.length);
    }
  }

  #report(error: Error, droppedSpans: number): void {
    try {
      this.#options.onError?.(error, droppedSpans);
    } catch {
      // A reporter that throws must not become the failure it was told about.
    }
  }
}

async function defaultSend(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status };
}
