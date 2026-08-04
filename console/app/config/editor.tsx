// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The one interactive piece in the console.
 *
 * Everything else is a server component and a form post, which is enough — but
 * an editor that only tells you a file is invalid *after* a round trip is an
 * editor people stop using. This validates as you type, in the browser, and
 * shows what a save would change.
 *
 * The client-side check is JSON only. The real validation is the harness's own
 * parsers, on the server, inside `save` — shipping `parseModelConfig` to the
 * browser to say the same thing twice would be a second copy of the rule, and a
 * second copy drifts.
 */

import { useActionState, useState } from 'react';

import { diff, type ConfigFile } from '../../lib/config-shape';
import { saveConfig, type SaveOutcome } from './actions';

export function Editor({ file, text }: { file: ConfigFile; text: string }) {
  const [draft, setDraft] = useState(text);
  const [outcome, action, pending] = useActionState<SaveOutcome | null, FormData>(saveConfig, null);

  const malformed = jsonComplaint(draft);
  const changes = draft === text ? [] : diff(text, draft);

  return (
    <>
      <form action={action}>
        <input type="hidden" name="file" value={file} />
        <textarea
          name="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          rows={20}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}
        />
        <button type="submit" disabled={pending || malformed !== null || draft === text}>
          {pending ? 'Saving…' : 'Save'}
        </button>{' '}
        {malformed === null ? null : <span className="failed">{malformed}</span>}
        {outcome ? (
          <span className={outcome.ok ? undefined : 'failed'}> {outcome.message}</span>
        ) : null}
      </form>

      {changes.length > 0 ? (
        <>
          <h2>What saving would change</h2>
          <pre>
            {changes.map((line, index) => (
              <div
                key={index}
                className={line.sign === ' ' ? 'muted' : line.sign === '-' ? 'failed' : undefined}
              >
                {line.sign}
                {line.text}
              </div>
            ))}
          </pre>
        </>
      ) : null}
    </>
  );
}

/** Only the shape a browser can check on its own. */
function jsonComplaint(text: string): string | null {
  if (text.trim() === '') {
    return null;
  }
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'not valid JSON';
  }
}
