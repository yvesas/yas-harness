// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What a page shows when the harness could not answer.
 *
 * A console whose job is to make a system legible must not itself fail
 * illegibly. The two failures worth naming are the ones every new install hits:
 * no database, and no tenant.
 */

export function Failure({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const noDatabase = /ECONNREFUSED|does not exist|relation .* does not exist/i.test(message);

  return (
    <>
      <h1>The harness could not answer</h1>
      <pre>{message}</pre>
      {noDatabase ? (
        <p className="muted">
          This usually means Postgres is not up, or the migrations have not been applied. Start the
          database and run <code>npm run migrate up</code> from the harness.
        </p>
      ) : (
        <p className="muted">
          The console reads through the harness&rsquo;s ports and never around them, so this is the
          harness&rsquo;s answer rather than a display problem.
        </p>
      )}
    </>
  );
}
