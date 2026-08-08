// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The nav, and which page you are on.
 *
 * A client component only because the answer needs the current path. It is the
 * smallest piece that has to be one — the layout around it stays on the server,
 * so the pages keep rendering there.
 *
 * "On this page" is decided by prefix, not equality: `/traces/<id>` should light
 * up Traces. The root is the exception, since every path starts with `/`.
 */

import { usePathname } from 'next/navigation';

const PAGES = [
  { href: '/', label: 'Overview' },
  { href: '/connections', label: 'Connections' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/agents', label: 'Agents' },
  { href: '/playground', label: 'Playground' },
  { href: '/traces', label: 'Traces' },
  { href: '/cost', label: 'Cost' },
  { href: '/modules', label: 'Modules' },
  { href: '/keys', label: 'Keys' },
  { href: '/config', label: 'Config' },
  { href: '/evals', label: 'Evals' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
      {PAGES.map((page) => {
        const active = page.href === '/' ? pathname === '/' : pathname.startsWith(page.href);
        return (
          <a
            key={page.href}
            href={page.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'bg-muted text-foreground rounded-md px-2.5 py-1 font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md px-2.5 py-1 transition-colors'
            }
          >
            {page.label}
          </a>
        );
      })}
    </nav>
  );
}
