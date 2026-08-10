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
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">
          These are the files in <code>config/</code>. The console edits them; it does not replace
          them with a database — that would cost the history, the review of a price change and a
          reproducible deploy, and buy a form. Editing them with <code>vim</code> keeps working.
        </p>
        <p className="text-muted-foreground max-w-3xl text-sm">
          <code>models.json</code> and <code>connectors.json</code> are <strong>yours</strong> and
          are not in Git — which vendor answers, and which sources you connect, are choices this
          project does not make for you. Each ships as a <code>.example</code> beside it. No secret
          belongs in any of them: a field ending in <code>Env</code> wants the{' '}
          <em>name of an environment variable</em>, and a key pasted there is refused. Keys go on
          the <a href="/keys">Keys page</a>, encrypted.
        </p>

        <nav className="flex flex-wrap items-center gap-2 text-sm">
          {files.map((one) => (
            <a
              key={one}
              href={`/config?file=${encodeURIComponent(one)}`}
              className={
                one === file
                  ? 'bg-secondary text-secondary-foreground rounded-md px-2 py-1'
                  : 'text-muted-foreground hover:text-foreground rounded-md px-2 py-1'
              }
            >
              <code>{one}</code>
            </a>
          ))}
        </nav>

        {document.exists ? null : (
          <p className="text-muted-foreground text-sm">
            <code>{file}</code> does not exist yet. Saving creates it.
          </p>
        )}

        <Editor file={file} text={document.text} />

        <p className="text-muted-foreground text-sm">
          A draft is checked with the harness&rsquo;s own parsers before it is written — the same{' '}
          <code>parseModelConfig</code> it boots with, not a second schema that agrees today and
          drifts by Christmas. Nothing that would stop the harness starting reaches the disk.
        </p>
        <p className="text-muted-foreground text-sm">
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
