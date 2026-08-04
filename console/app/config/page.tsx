// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Editing the harness's configuration — the files, not a table.
 *
 * `docs/13` chose the fork model and doc 14 §7.9 put configuration in Git.
 * Moving it into a database would cost the history, the code review of a price
 * change, and a reproducible deploy, and would buy a form. So this is an editor
 * over `config/*.json` that validates with the harness's own parsers before
 * writing, and never becomes the only way in.
 */

import { editable, read } from '../../lib/config-files';
import { Failure } from '../failure';
import { Editor } from './editor';

export const dynamic = 'force-dynamic';

export default async function Config({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const requested = (await searchParams)['file'];
    const wanted = Array.isArray(requested) ? requested[0] : requested;
    const files = editable();
    const file = files.find((one) => one === wanted) ?? files[0]!;
    const document = await read(file);

    return (
      <>
        <h1>Configuration</h1>
        <p className="muted">
          These are the files in <code>config/</code>, versioned in Git. The console edits them; it
          does not replace them with a database — that would cost the history, the review of a price
          change and a reproducible deploy, and buy a form. Editing them with <code>vim</code> keeps
          working.
        </p>

        <nav>
          {files.map((one) => (
            <a key={one} href={`/config?file=${encodeURIComponent(one)}`}>
              <code>{one === file ? `[${one}]` : one}</code>
            </a>
          ))}
        </nav>

        {document.exists ? null : (
          <p className="muted">
            <code>{file}</code> does not exist yet. Saving creates it.
          </p>
        )}

        <Editor file={file} text={document.text} />

        <p className="muted">
          A draft is checked with the harness&rsquo;s own parsers before it is written — the same{' '}
          <code>parseModelConfig</code> it boots with, not a second schema that agrees today and
          drifts by Christmas. Nothing that would stop the harness starting reaches the disk.
        </p>
        <p className="muted">
          Secrets are never resolved here. <code>connectors.json</code> keeps its{' '}
          <code>
            ${'{'}CLIENT_SECRET{'}'}
          </code>{' '}
          placeholders exactly as written: resolving one to display it would put a client secret on
          a web page, and resolving one to save it would write the secret into a file that goes to
          Git.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
