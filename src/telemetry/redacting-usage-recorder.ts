// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `UsageRecorder` decorator that redacts secrets from a usage record's error
 * message before it is stored. `error_message` is the one free-text column on
 * `model_usage`, and it comes from a provider or database error — which can
 * embed a connection string, a token or a payload fragment. Records without an
 * error pass straight through.
 */

import { type SecretRedactor } from '../redaction/secret-redactor.js';

import type { ModelUsageRecord, UsageRecorder } from './model-usage.js';

export class RedactingUsageRecorder implements UsageRecorder {
  readonly #inner: UsageRecorder;
  readonly #redactor: SecretRedactor;

  constructor(inner: UsageRecorder, redactor: SecretRedactor) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  record(usage: ModelUsageRecord): Promise<void> {
    if (usage.errorMessage === undefined) {
      return this.#inner.record(usage);
    }
    return this.#inner.record({
      ...usage,
      errorMessage: this.#redactor.redact(usage.errorMessage),
    });
  }
}
