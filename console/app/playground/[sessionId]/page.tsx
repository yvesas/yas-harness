// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One conversation, with the trace of the last turn beside it.
 *
 * Side by side is the point. A chat on its own tells you the agent answered; the
 * trace tells you which module was chosen and why, what it cost, which tools
 * ran, and where a turn stopped. Reading them apart means holding one in your
 * head while you look at the other.
 */

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';
import { send } from '../actions';

export const dynamic = 'force-dynamic';

export default async function Conversation({ params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const tenant = await currentTenant();
    const api = await harness();

    const session = await api.sessions.find(tenant.id, sessionId);
    if (!session) {
      return (
        <>
          <h1>Conversation not found</h1>
          <p className="muted">
            No session with that id for this tenant — which is also what another tenant&rsquo;s
            conversation looks like from here.
          </p>
          <p>
            <a href="/playground">Back</a>
          </p>
        </>
      );
    }

    const [messages, turns] = await Promise.all([
      api.sessions.messages(tenant.id, sessionId),
      api.traceReader.recent(tenant.id, { sessionId, limit: 1 }),
    ]);
    const steps = turns[0] ? await api.traceReader.trace(tenant.id, turns[0].traceId) : [];

    return (
      <>
        <h1>Conversation</h1>
        <p className="muted">
          <code>{sessionId}</code> · persona <code>{session.personaId}</code>
        </p>

        <div className="split">
          <section>
            <h2>Messages</h2>
            {messages.length === 0 ? (
              <p className="muted">Nothing said yet. The demo modules keep notes and links.</p>
            ) : (
              messages.map((message) => (
                <div key={message.id} className="turn">
                  <div className="muted">{message.role}</div>
                  {message.content.map((part, index) => (
                    <div key={index}>
                      {part.type === 'text' ? (
                        part.text
                      ) : part.type === 'tool_call' ? (
                        <code className="muted">
                          → {part.name} {JSON.stringify(part.input)}
                        </code>
                      ) : (
                        <code className={part.isError ? 'failed' : 'muted'}>← {part.content}</code>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}

            <form action={send}>
              <input type="hidden" name="sessionId" value={sessionId} />
              <input
                type="text"
                name="input"
                size={40}
                placeholder="Say something"
                autoFocus
              />{' '}
              <button type="submit">Send</button>
            </form>
            <p className="muted">
              A turn with no model key configured fails here and says so — the harness builds a
              provider on first use, so everything else on this console works without one.
            </p>
          </section>

          <section>
            <h2>Last turn</h2>
            {steps.length === 0 ? (
              <p className="muted">No turn recorded yet.</p>
            ) : (
              <table>
                <tbody>
                  {steps.map((step) => (
                    <tr key={step.sequence}>
                      <td className={step.succeeded ? undefined : 'failed'}>{step.kind}</td>
                      <td>
                        <code>{step.label ?? '—'}</code>
                        {step.errorMessage ? (
                          <div className="failed">{step.errorMessage}</div>
                        ) : null}
                        {step.kind === 'route' && step.detail ? (
                          <div className="muted">{String(step.detail['reason'] ?? '')}</div>
                        ) : null}
                      </td>
                      <td className="muted">
                        {step.durationMs === undefined ? '' : `${step.durationMs}ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {turns[0] ? (
              <p>
                <a href={`/traces/${turns[0].traceId}`}>Open the full trace</a>
              </p>
            ) : null}
          </section>
        </div>

        <p>
          <a href="/playground">All conversations</a>
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
