// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The frame every page sits in.
 *
 * No UI library, deliberately: doc 21 leaves that choice to the first screen
 * that genuinely needs it, and an operator console that reads well in plain
 * elements has not earned a dependency yet.
 */

import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'yas-console',
  description: 'See the harness, and drive it',
};

const PAGES = [
  { href: '/', label: 'Overview' },
  { href: '/connections', label: 'Connections' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/traces', label: 'Traces' },
  { href: '/cost', label: 'Cost' },
  { href: '/modules', label: 'Modules' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <strong>yas-console</strong>
          <nav>
            {PAGES.map((page) => (
              <a key={page.href} href={page.href}>
                {page.label}
              </a>
            ))}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
