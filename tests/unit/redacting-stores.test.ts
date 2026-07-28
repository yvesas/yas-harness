// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The redacting store decorators. Each proves that a secret is scrubbed on the
 * way to the wrapped store — message content, a pool value, a held tool input,
 * a usage error message — while reads and secret-free records pass through
 * untouched. Uses the real regex redactor, so the wiring is tested end to end.
 */

import { describe, expect, it } from 'vitest';

import type {
  Approval,
  ApprovalStore,
  RequestApprovalInput,
} from '../../src/approval/approval-store.js';
import { RedactingApprovalStore } from '../../src/approval/redacting-approval-store.js';
import { RedactingSessionStore } from '../../src/memory/redacting-session-store.js';
import type { ModelMessage } from '../../src/models/model-gateway.js';
import type { SessionStore } from '../../src/memory/session-store.js';
import type { PoolEntry, PoolScope, PoolStore } from '../../src/pools/pool-store.js';
import { RedactingPoolStore } from '../../src/pools/redacting-pool-store.js';
import { RegexSecretRedactor } from '../../src/redaction/regex-secret-redactor.js';
import { InMemoryUsageRecorder, type ModelUsageRecord } from '../../src/telemetry/model-usage.js';
import { RedactingUsageRecorder } from '../../src/telemetry/redacting-usage-recorder.js';

const redactor = new RegexSecretRedactor();
const SECRET_KEY = 'sk-abcdefghijklmnopqrstuvwx';

class CapturingSessionStore implements SessionStore {
  readonly appended: ModelMessage[] = [];
  create(): Promise<never> {
    throw new Error('unused');
  }
  find(): Promise<null> {
    return Promise.resolve(null);
  }
  messages(): Promise<[]> {
    return Promise.resolve([]);
  }
  append(_t: string, _s: string, messages: readonly ModelMessage[]): Promise<void> {
    this.appended.push(...messages);
    return Promise.resolve();
  }
}

class CapturingPoolStore implements PoolStore {
  stored: unknown;
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  set(_scope: PoolScope, _key: string, value: unknown): Promise<void> {
    this.stored = value;
    return Promise.resolve();
  }
  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
  list(): Promise<PoolEntry[]> {
    return Promise.resolve([]);
  }
}

class CapturingApprovalStore implements ApprovalStore {
  readonly requested: RequestApprovalInput[] = [];
  request(inputs: readonly RequestApprovalInput[]): Promise<Approval[]> {
    this.requested.push(...inputs);
    return Promise.resolve([]);
  }
  find(): Promise<null> {
    return Promise.resolve(null);
  }
  forToolCalls(): Promise<Approval[]> {
    return Promise.resolve([]);
  }
  approve(): Promise<never> {
    throw new Error('unused');
  }
  reject(): Promise<never> {
    throw new Error('unused');
  }
  list(): Promise<Approval[]> {
    return Promise.resolve([]);
  }
}

describe('RedactingSessionStore', () => {
  it('redacts secrets in text, tool-result and tool-call parts before storing', async () => {
    const inner = new CapturingSessionStore();
    const store = new RedactingSessionStore(inner, redactor);

    await store.append('t', 's', [
      {
        role: 'user',
        content: [
          { type: 'text', text: `my key is ${SECRET_KEY}` },
          { type: 'tool_result', toolCallId: 'c', content: 'password=hunter2xyz9', isError: false },
          { type: 'tool_call', id: 'c2', name: 'send', input: { apiKey: SECRET_KEY, n: 1 } },
        ],
      },
    ]);

    expect(inner.appended[0]!.content).toEqual([
      { type: 'text', text: 'my key is [REDACTED]' },
      { type: 'tool_result', toolCallId: 'c', content: 'password=[REDACTED]', isError: false },
      { type: 'tool_call', id: 'c2', name: 'send', input: { apiKey: '[REDACTED]', n: 1 } },
    ]);
  });
});

describe('RedactingPoolStore', () => {
  it('redacts secrets in a value before storing', async () => {
    const inner = new CapturingPoolStore();
    const store = new RedactingPoolStore(inner, redactor);

    await store.set({ tenantId: 't', moduleId: 'm' }, 'k', { token: SECRET_KEY, keep: 'plain' });

    expect(inner.stored).toEqual({ token: '[REDACTED]', keep: 'plain' });
  });
});

describe('RedactingApprovalStore', () => {
  it('redacts secrets in a held tool input before storing', async () => {
    const inner = new CapturingApprovalStore();
    const store = new RedactingApprovalStore(inner, redactor);

    await store.request([
      {
        tenantId: 't',
        sessionId: 's',
        toolCallId: 'c',
        toolName: 'send',
        input: { authorization: `Bearer abcdefghijklmnopqrst` },
      },
    ]);

    expect(inner.requested[0]!.input).toEqual({ authorization: 'Bearer [REDACTED]' });
  });
});

describe('RedactingUsageRecorder', () => {
  const baseRecord: ModelUsageRecord = {
    tenantId: 't',
    sessionId: null,
    task: 'reasoning',
    modelReference: 'anthropic/opus',
    provider: 'anthropic',
    model: 'claude',
    tier: 'premium',
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    attempts: 1,
    succeeded: false,
  };

  it('redacts secrets in the error message before storing', async () => {
    const inner = new InMemoryUsageRecorder();
    const recorder = new RedactingUsageRecorder(inner, redactor);

    await recorder.record({
      ...baseRecord,
      errorMessage: 'connect postgres://user:s3cr3tpass@db failed',
    });

    expect(inner.records[0]!.errorMessage).toBe('connect postgres://[REDACTED]@db failed');
  });

  it('passes a record with no error message straight through', async () => {
    const inner = new InMemoryUsageRecorder();
    const recorder = new RedactingUsageRecorder(inner, redactor);

    await recorder.record({ ...baseRecord, succeeded: true });

    expect(inner.records[0]!.errorMessage).toBeUndefined();
  });
});
