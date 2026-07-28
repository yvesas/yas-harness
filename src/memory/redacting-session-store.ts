// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `SessionStore` decorator that redacts secrets from message content before
 * it is stored. Conversation history is the highest-value leak path — a user
 * pastes a key, a tool result carries a token — and it is persisted verbatim.
 * So every message appended is scrubbed first: text and tool-result content
 * directly, a tool-call's structured input walked leaf by leaf. Reads are
 * untouched; only what goes to the database is changed.
 */

import type { ContentPart, ModelMessage } from '../models/model-gateway.js';
import { redactDeep, type SecretRedactor } from '../redaction/secret-redactor.js';

import type { CreateSessionInput, Session, SessionStore, StoredMessage } from './session-store.js';

export class RedactingSessionStore implements SessionStore {
  readonly #inner: SessionStore;
  readonly #redactor: SecretRedactor;

  constructor(inner: SessionStore, redactor: SecretRedactor) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  create(input: CreateSessionInput): Promise<Session> {
    return this.#inner.create(input);
  }

  find(tenantId: string, sessionId: string): Promise<Session | null> {
    return this.#inner.find(tenantId, sessionId);
  }

  messages(tenantId: string, sessionId: string): Promise<StoredMessage[]> {
    return this.#inner.messages(tenantId, sessionId);
  }

  append(tenantId: string, sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
    return this.#inner.append(
      tenantId,
      sessionId,
      messages.map((message) => this.#redactMessage(message)),
    );
  }

  #redactMessage(message: ModelMessage): ModelMessage {
    return { ...message, content: message.content.map((part) => this.#redactPart(part)) };
  }

  #redactPart(part: ContentPart): ContentPart {
    if (part.type === 'text') {
      return { ...part, text: this.#redactor.redact(part.text) };
    }
    if (part.type === 'tool_result') {
      return { ...part, content: this.#redactor.redact(part.content) };
    }
    return { ...part, input: redactDeep(this.#redactor, part.input) };
  }
}
