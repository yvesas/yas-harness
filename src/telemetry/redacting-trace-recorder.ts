// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `TraceRecorder` decorator that scrubs secrets before a step is stored.
 *
 * A trace is the most exposed of the durable paths: it carries the user's own
 * message, a tool's input, and a provider's error text — any of which can hold a
 * token, a connection string or a key someone pasted. `label` is left alone; it
 * is a module id, a tool name or a model, all of them names the harness chose.
 */

import { redactDeep, type SecretRedactor } from '../redaction/secret-redactor.js';

import type { RecordedStep, TraceRecorder } from './trace.js';

export class RedactingTraceRecorder implements TraceRecorder {
  readonly #inner: TraceRecorder;
  readonly #redactor: SecretRedactor;

  constructor(inner: TraceRecorder, redactor: SecretRedactor) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  record(step: RecordedStep): Promise<number> {
    return this.#inner.record({
      ...step,
      ...(step.detail === undefined
        ? {}
        : { detail: redactDeep(this.#redactor, step.detail) as Record<string, unknown> }),
      ...(step.errorMessage === undefined
        ? {}
        : { errorMessage: this.#redactor.redact(step.errorMessage) }),
    });
  }
}
