// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The frame every page sits in.
 *
 * shadcn/ui with the Claude theme, which doc 21 left to "the first screen that
 * genuinely needs it". That screen arrived when the console stopped being a way
 * to check the harness and became the way to use it.
 */

import type { ReactNode } from 'react';

import { Nav } from '@/components/nav';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';

import './globals.css';

export const metadata = {
  title: 'yas-console',
  description: 'See the harness, and drive it',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning because next-themes writes the class on the html
    // element before React hydrates — which is the whole point of it, and which
    // React would otherwise complain about.
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-svh antialiased">
        <ThemeProvider>
          <header className="border-border/60 sticky top-0 z-10 border-b backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
              <a href="/" className="font-semibold tracking-tight">
                yas-console
              </a>
              <Nav />
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
