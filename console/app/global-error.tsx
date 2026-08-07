// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The net under the net: an error thrown by the layout itself.
 *
 * It has to render its own `<html>` and `<body>`, because the layout that
 * normally provides them is the thing that failed. That also means no theme
 * provider and no stylesheet variables to rely on — so this one is deliberately
 * plain, and says so by being plain rather than by pretending.
 */

export default function GlobalError({ error }: { error: Error }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          margin: 0,
          padding: '3rem 1.5rem',
          background: '#1a1915',
          color: '#e8e4dc',
        }}
      >
        <main style={{ maxWidth: '40rem', margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.25rem' }}>The console could not start this page</h1>
          <pre
            style={{
              background: '#26241f',
              padding: '0.75rem',
              borderRadius: '6px',
              overflowX: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {error.message || 'No message came with it.'}
          </pre>
          <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>
            This is the layout itself failing, so the usual styling is not available. The stack is
            in <code>docker compose logs console</code>.
          </p>
          <p>
            <a href="/" style={{ color: '#cb6441' }}>
              Back to overview
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
